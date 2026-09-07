import * as vscode from 'vscode';
import {randomUUID} from 'node:crypto';
import {readFile, realpath} from 'node:fs/promises';
import {homedir} from 'node:os';
import {isAbsolute, join} from 'node:path';
import {discover, loadState, lockWorkspace, reserveName, Session, Shpool, writeState} from './backend';
import {closeAction, identityKey, matches, RecordData, records, stateKey} from './lifecycle';
import {bundledBackend, runtimeLock} from './runtime';

const text = (en: string, zh: string) => vscode.env.language.startsWith('zh') ? zh : en;
let controller: Controller | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  // extensionKind=workspace places us on Remote-SSH's Linux host, never the Mac UI host.
  if (process.platform !== 'linux' || !vscode.workspace.isTrusted) return;
  controller = new Controller(context, await workspaceIdentity(context), (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim());
  await controller.initialize();
  controller.register();
}
export function deactivate(): void { controller?.stop(); }

async function workspaceIdentity(context: vscode.ExtensionContext): Promise<string> {
  const file = vscode.workspace.workspaceFile;
  if (file && file.scheme !== 'untitled') return `workspace:${await realpath(file.fsPath).catch(() => file.fsPath)}`;
  const folders = vscode.workspace.workspaceFolders;
  if (folders?.length) return `folders:${(await Promise.all(folders.map(f => realpath(f.uri.fsPath).catch(() => f.uri.fsPath)))).sort().join('\n')}`;
  let id = context.workspaceState.get<string>('emptyWindowIdentity');
  if (!id) { id = randomUUID(); await context.workspaceState.update('emptyWindowIdentity', id); }
  return `empty:${id}`;
}

class Controller {
  private data: RecordData[];
  private readonly terminals = new Map<vscode.Terminal, RecordData>();
  private readonly ordinary = new WeakSet<vscode.Terminal>();
  private readonly pending = new Set<string>();
  private readonly prompts = new Set<string>();
  private readonly attempted = new Set<string>();
  private readonly closing = new Set<string>();
  private readonly output = vscode.window.createOutputChannel('Shpool Persistent');
  private tail: Promise<unknown> = Promise.resolve();
  private release?: () => void;
  private timer?: NodeJS.Timeout;
  private stopped = false;
  private ownershipBlocked = false;
  private observationPending = false;
  private lastError = '';
  private started = Date.now();
  private root: string;
  constructor(private readonly context: vscode.ExtensionContext, private readonly workspace: string, private readonly bootId: string) {
    this.data = records(context.workspaceState.get(stateKey), workspace);
    const stateHome = process.env.XDG_STATE_HOME;
    this.root = join(stateHome && isAbsolute(stateHome) ? stateHome : join(homedir(), '.local/state'), 'vscode-shpool-terminal');
  }
  async initialize(): Promise<void> {
    const saved = await loadState(this.root, this.workspace);
    if (saved === undefined) return;
    const valid = records(saved, this.workspace);
    if (!Array.isArray(saved) || valid.length !== saved.length) throw new Error('Invalid saved shpool identities / 保存的 shpool identity 格式无效');
    this.data = valid;
  }
  register(): void {
    this.context.subscriptions.push(this.output,
      vscode.window.registerTerminalProfileProvider('shpool.persistent', {
        provideTerminalProfile: token => this.queue(async () => {
          try {
            await this.own();
            const config = vscode.workspace.getConfiguration('shpool');
            const configured = config.get<string>('path', '');
            const socket = config.get<string>('socketPath', '').replace(/^~\//, `${homedir()}/`);
            const backend = configured
              ? await discover(configured, socket, (await runtimeLock(this.context.extensionPath)).version)
              : await bundledBackend(this.context.extensionPath, this.root, process.env.XDG_RUNTIME_DIR || join(homedir(), '.local/run'), socket);
            const sessions = await new Shpool(backend).list();
            if (token.isCancellationRequested || this.stopped) return undefined;
            const name = await reserveName(this.root, vscode.workspace.name || 'persistent', this.workspace,
              [...sessions.map(s => s.name), ...this.data.map(r => r.sessionName)]);
            const record: RecordData = {
              id: randomUUID(), workspace: this.workspace, persistent: true, sessionName: name,
              backend, cwd: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || homedir(), bootId: this.bootId,
            };
            if (token.isCancellationRequested || this.stopped) return undefined;
            this.data.push(record);
            await this.save(); // Identity reaches storage BEFORE the client can launch.
            // Record the actual shell generation BEFORE a trash click can race attach.
            // --background only starts the user's shell; the terminal still backs directly onto shpool.
            this.attempted.add(record.id);
            await this.prepare(record);
            if (this.stopped) return undefined;
            this.pending.add(record.id);
            this.attempted.add(record.id);
            return new vscode.TerminalProfile(this.options(record));
          } catch (error) { this.error(error); return undefined; }
        }),
      }),
      vscode.window.onDidOpenTerminal(t => {
        this.adopt(t);
        this.requestObservation();
      }),
      vscode.window.onDidCloseTerminal(t => {
        const r = this.terminals.get(t);
        if (!r) return; // A normal shell or another extension's terminal.
        this.terminals.delete(t);
        if (t.exitStatus?.reason === vscode.TerminalExitReason.User) this.closing.add(r.id);
        void this.queue(() => this.closed(t, r)).catch(e => this.error(e));
      }),
      vscode.commands.registerCommand('shpool.restore', () => this.queue(async () => {
        this.prompts.clear(); this.attempted.clear(); await this.reconcile();
      }).catch(e => this.error(e))),
    );
    for (const t of vscode.window.terminals) this.adopt(t);
    // onStartupFinished is not a public terminal-restoration barrier. The grace period
    // is only a scheduling hint. Attachment PIDs and late-open adoption are authoritative.
    this.timer = setInterval(() => this.requestObservation(), 1500);
    this.context.subscriptions.push({dispose: () => this.stop()});
  }
  private requestObservation(): void {
    // At most one background job may be running OR waiting. A slow daemon cannot
    // accumulate timer jobs ahead of a user close/create action.
    if (this.stopped || this.observationPending || !this.data.length) return;
    this.observationPending = true;
    void this.queue(async () => {
      if (this.stopped) return;
      await this.own();
      await this.observe();
      if (Date.now() - this.started >= 5000) await this.reconcile();
    }).catch(e => this.log(e)).finally(() => { this.observationPending = false; });
  }
  private async prepare(r: RecordData): Promise<void> {
    const session = await new Shpool(r.backend).create(r.sessionName, r.cwd);
    r.startedAt = session.startedAt; r.bootId = this.bootId;
    await this.save();
  }
  private queue<T>(work: () => Promise<T>): Promise<T> {
    const result = this.tail.then(work);
    this.tail = result.catch(() => {});
    return result;
  }
  private async own(): Promise<void> {
    if (this.stopped) throw new Error('Extension is stopping');
    if (this.ownershipBlocked) throw new Error(text('Workspace ownership is unavailable. Reconnect the original window, or reload after it closes.', '工作区已由其他窗口管理。请重连原窗口，或在其关闭后重载当前窗口。'));
    if (!this.release) {
      try {
        this.release = await lockWorkspace(this.root, this.workspace, () => {
          this.stop();
          this.error(new Error(text('Workspace lock was lost. Sessions were kept; reload to resume management.', '工作区锁已失效；会话已保留，请重载以恢复管理。')));
        });
        const saved = await loadState(this.root, this.workspace);
        if (saved !== undefined) {
          const valid = records(saved, this.workspace);
          if (!Array.isArray(saved) || valid.length !== saved.length) throw new Error('Invalid saved shpool identities / 保存的 shpool identity 格式无效');
          this.data = valid; this.terminals.clear();
        }
      } catch (error) { this.release?.(); this.release = undefined; this.ownershipBlocked = true; throw error; }
    }
  }
  private options(r: RecordData, force = false): vscode.TerminalOptions {
    return {
      name: r.sessionName, shellPath: r.backend.executable, shellArgs: new Shpool(r.backend).args(r.sessionName, force),
      cwd: r.cwd, env: {[identityKey]: r.id},
      // Never persist a one-time --force grant into a future automatic native revive.
      // The next fallback for this identity uses plain attach and native persistence again.
      isTransient: force,
    };
  }
  private adopt(t: vscode.Terminal): void {
    const r = this.data.find(r => matches(r, t.creationOptions as vscode.TerminalOptions));
    if (!r || this.closing.has(r.id)) return;
    this.terminals.set(t, r);
    this.pending.delete(r.id);
  }
  private async adoptNative(): Promise<void> {
    for (const t of vscode.window.terminals) {
      this.adopt(t);
      if (this.terminals.has(t) || this.ordinary.has(t) || !this.data.length) continue;
      const pid = await Promise.race([t.processId, new Promise<undefined>(resolve => setTimeout(resolve, 100))]);
      if (!pid || !Number.isSafeInteger(pid) || pid <= 0) continue;
      try {
        // VS Code 1.121 native reconnection loses launch env/args in creationOptions.
        // Read only for identity verification; never store or log the process environment.
        const [environment, command, executable] = await Promise.all([
          readFile(`/proc/${pid}/environ`, 'utf8'), readFile(`/proc/${pid}/cmdline`, 'utf8'), realpath(`/proc/${pid}/exe`),
        ]);
        const id = environment.split('\0').find(e => e.startsWith(`${identityKey}=`))?.slice(identityKey.length + 1);
        const r = this.data.find(r => r.id === id);
        if (!r) { this.ordinary.add(t); continue; }
        const args = command.split('\0').filter(Boolean).slice(1);
        if (await realpath(r.backend.executable) === executable && matches(r, {shellPath: r.backend.executable, shellArgs: args, env: {[identityKey]: id}})) {
          if (vscode.window.terminals.includes(t) && !this.closing.has(r.id)) { this.terminals.set(t, r); this.pending.delete(r.id); }
        }
      } catch { /* A launching/closing process or inaccessible /proc is not proof of identity. */ }
    }
  }
  private async list(r: RecordData, startDaemon = true): Promise<Session | undefined> {
    return (await new Shpool(r.backend).list(startDaemon)).find(s => s.name === r.sessionName);
  }
  private async observe(): Promise<void> {
    if (!this.release || this.stopped) return;
    // Native restoration can arrive after activation; never infer identity from display name.
    await this.adoptNative();
    let changed = false;
    const snapshots = new Map<string, Promise<Session[]>>();
    for (const r of this.data) {
      const mapped = [...this.terminals].filter(([, v]) => v.id === r.id);
      if (!mapped.length || this.closing.has(r.id)) continue;
      const key = JSON.stringify(r.backend);
      if (!snapshots.has(key)) snapshots.set(key, new Shpool(r.backend).list(false));
      const session = (await snapshots.get(key)!).find(s => s.name === r.sessionName);
      if (!session) continue;
      for (const [t] of mapped) {
        // processId can be unresolved for failed/closing terminal launches; do not block the queue.
        const pid = await Promise.race([t.processId, new Promise<undefined>(resolve => setTimeout(resolve, 100))]);
        if (pid && session.attachments.includes(pid)) {
          this.attempted.delete(r.id);
          if (r.startedAt !== session.startedAt || r.bootId !== this.bootId) { r.startedAt = session.startedAt; r.bootId = this.bootId; changed = true; }
          // A late native revive may race fallback. Preserve the client that actually attached.
          for (const [other] of mapped) if (other !== t) {
            this.terminals.delete(other); other.dispose(); // Extension reason, never kill.
          }
        }
      }
    }
    if (changed) await this.save();
  }
  private async closed(t: vscode.Terminal, r: RecordData): Promise<void> {
    const reason = t.exitStatus?.reason;
    this.output.appendLine(`close ${r.sessionName}: reason=${reason}, code=${t.exitStatus?.code}`);
    if (this.stopped) return;
    if (reason !== vscode.TerminalExitReason.User && reason !== vscode.TerminalExitReason.Process) return;
    await this.own();
    const current = this.data.find(v => v.id === r.id);
    if (!current) return;
    r = current;
    if (reason === vscode.TerminalExitReason.User) {
      // Persist intent even if kill/list fails. Never resurrect an explicitly discarded tab.
      await this.remove(r);
      let session: Session | undefined;
      try { session = await this.list(r, false); }
      catch (e) { this.error(e); return; }
      const pid = await Promise.race([t.processId, new Promise<undefined>(resolve => setTimeout(resolve, 100))]);
      let action = closeAction(reason, r, session, pid);
      // A very early trash click can arrive before VS Code publishes processId,
      // while the daemon still lists the dying client. Only wait/recheck here:
      // never force, infer its PID, or retry a destructive command.
      for (let attempt = 0; attempt < 10 && action !== 'kill' && session &&
          session.startedAt === r.startedAt && session.attachments.length; attempt++) {
        await new Promise(resolve => setTimeout(resolve, 100));
        if (this.stopped) return;
        session = await this.list(r, false);
        action = closeAction(reason, r, session, pid);
      }
      if (this.stopped) return;
      if (action === 'kill') await new Shpool(r.backend).kill(r.sessionName);
      else if (session) this.error(new Error(text(
        `Kept ${r.sessionName}: shell generation or attachment ownership could not be verified.`,
        `已保留 ${r.sessionName}：无法核实 shell 代际或 attachment 归属。`)));
      return;
    }
    // A rejected attach or a detached client can exit while its shell remains alive.
    // Only a successful list proving absence removes metadata. A daemon failure retains it.
    if (r.bootId && r.bootId !== this.bootId) return; // A server reboot is not an inner-shell exit.
    const session = await this.list(r, false);
    if (!session) await this.remove(r);
    // Do not loop relaunching a broken executable or detached client during this activation.
  }
  private async reconcile(): Promise<void> {
    if (this.stopped || !this.data.length) return;
    await this.own();
    await this.adoptNative();
    for (const r of [...this.data]) {
      if (this.stopped || this.closing.has(r.id) || this.pending.has(r.id) ||
          [...this.terminals.values()].some(v => v.id === r.id)) continue;
      const session = await this.list(r);
      if (session && (session.status === 'Attached' || session.attachments.length)) {
        this.offerTakeover(r, session); continue;
      }
      if (this.attempted.has(r.id)) continue;
      await this.create(r, session);
    }
  }
  private async create(r: RecordData, session?: Session, force = false): Promise<void> {
    if (this.stopped || this.closing.has(r.id) || !this.data.includes(r)) return;
    this.attempted.add(r.id);
    if (!session) await this.prepare(r);
    else if (r.startedAt !== session.startedAt || r.bootId !== this.bootId) {
      r.startedAt = session.startedAt; r.bootId = this.bootId; await this.save();
    }
    if (this.stopped || this.closing.has(r.id)) return;
    this.attempted.add(r.id);
    this.pending.add(r.id);
    const t = vscode.window.createTerminal(this.options(r, force));
    this.terminals.set(t, r);
    this.pending.delete(r.id);
    // Background restore preserves editor focus. The native panel still owns all rendering.
  }
  private offerTakeover(r: RecordData, session: Session): void {
    if (this.prompts.has(r.id)) return;
    this.prompts.add(r.id);
    const action = text('Take Over', '接管');
    // Never hold the lifecycle queue while the user considers a notification.
    void vscode.window.showWarningMessage(text(
      `${r.sessionName} still has a shpool client. Take over only if that client is stale; it will be disconnected.`,
      `${r.sessionName} 仍有 shpool 客户端。仅当旧客户端已失效时接管；接管会断开该客户端。`), action).then(answer => {
      if (answer !== action) return;
      void this.queue(async () => {
        if (this.stopped || [...this.terminals.values()].some(v => v.id === r.id) || !this.data.includes(r)) return;
        const current = await this.list(r);
        // Consent was for this generation/client, not a different attachment that appeared later.
        if (current && (current.startedAt !== session.startedAt || JSON.stringify(current.attachments) !== JSON.stringify(session.attachments))) {
          this.prompts.delete(r.id); this.offerTakeover(r, current); return;
        }
        await this.create(r, current, !!current && (current.status === 'Attached' || current.attachments.length > 0));
      }).catch(e => this.error(e));
    });
  }
  private async remove(r: RecordData): Promise<void> {
    this.data = this.data.filter(v => v.id !== r.id);
    this.pending.delete(r.id); this.attempted.delete(r.id);
    await this.save();
  }
  private async save(): Promise<void> {
    const snapshot = this.data.map(r => ({...r}));
    try { await writeState(this.root, this.workspace, snapshot); }
    catch (error) { this.stop(); throw error; } // No launch/kill after failed durable persistence.
    try { await this.context.workspaceState.update(stateKey, snapshot); }
    catch (error) { this.log(error); } // The fsynced primary remains authoritative.
  }
  private log(error: unknown): void { const message = String(error); if (message !== this.lastError) this.output.appendLine(message); this.lastError = message; }
  private error(error: unknown): void { this.log(error); void vscode.window.showErrorMessage(String(error)); }
  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    // No dispose(), detach or kill: VS Code owns its clients, shpool owns shells.
    this.release?.(); this.release = undefined;
  }
}
