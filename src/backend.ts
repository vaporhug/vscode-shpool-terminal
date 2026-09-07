import {execFile, spawn, ChildProcess} from 'node:child_process';
import {constants} from 'node:fs';
import {access, mkdir, open, readFile, rename, unlink} from 'node:fs/promises';
import {homedir} from 'node:os';
import {isAbsolute, join, resolve} from 'node:path';
import {createHash, randomUUID} from 'node:crypto';

export interface Backend { executable: string; socket: string }
export interface Session {
  name: string;
  startedAt: number;
  status: 'Attached' | 'Disconnected';
  attachments: number[];
}
export const safeName = (name: string): boolean => /^[A-Za-z0-9][A-Za-z0-9_.-]{0,95}$/.test(name);
export function prefix(name?: string): string {
  return (name?.normalize('NFKD').replace(/[^A-Za-z0-9_.-]+/g, '-').replace(/^[^A-Za-z0-9]+|[-.]+$/g, '').slice(0,70)) || 'persistent';
}
export const hash = (value: string): string => createHash('sha256').update(value).digest('hex');
export async function loadState(root: string, workspace: string): Promise<unknown | undefined> {
  try { return JSON.parse(await readFile(join(root, `${hash(workspace)}.json`), 'utf8')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
}
/** workspaceState is a convenient mirror, but its update promise is not a disk flush.
 * Persist identity/removal intent before any client launch or destructive operation.
 * Caller must hold the workspace's OS lock.
 */
export async function writeState(root: string, workspace: string, value: unknown): Promise<void> {
  const target = join(root, `${hash(workspace)}.json`);
  const temporary = `${target}.${randomUUID()}.tmp`;
  const file = await open(temporary, 'wx', 0o600);
  try { await file.writeFile(JSON.stringify(value)); await file.sync(); }
  finally { await file.close(); }
  try {
    await rename(temporary, target);
    const directory = await open(root, 'r');
    try { await directory.sync(); } finally { await directory.close(); }
  } finally { await unlink(temporary).catch(() => {}); }
}
export function run(executable: string, args: string[], cwd?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(executable, args, {cwd, timeout: 8000, maxBuffer: 4 * 1024 * 1024, env: {...process.env, LC_ALL: 'C'}}, (error, stdout, stderr) => {
      if (error) reject(new Error(`${executable}: ${stderr.trim() || error.message}`));
      else resolve(stdout);
    });
  });
}
export async function discover(configured: string, socket: string, version = '0.11.4'): Promise<Backend> {
  const expand = (s: string) => s.startsWith('~/') ? join(homedir(), s.slice(2)) : s;
  const candidates = configured
    ? (expand(configured).includes('/') ? [expand(configured)] : (process.env.PATH || '').split(':').filter(Boolean).map(p => join(p, configured)))
    : [...(process.env.PATH || '').split(':').filter(Boolean).map(p => join(p, 'shpool')), join(homedir(), '.cargo/bin/shpool')];
  for (const candidate of candidates) {
    if (!isAbsolute(candidate)) continue;
    try { await access(candidate, constants.X_OK); } catch { continue; }
    const endpoint = socket ? expand(socket) : join(process.env.XDG_RUNTIME_DIR || join(homedir(), '.local/run'), 'shpool/shpool.socket');
    if (!isAbsolute(endpoint)) throw new Error('shpool.socketPath must be absolute / shpool.socketPath 必须是绝对路径');
    if ((await run(candidate, ['version'])).trim() !== `shpool ${version}`) throw new Error(`This release supports shpool ${version}. / 当前版本需使用 shpool ${version}。`);
    return {executable: resolve(candidate), socket: endpoint};
  }
  throw new Error('shpool was not found on the Linux extension host. Install shpool or set shpool.path. / 远程 Linux 未找到 shpool，请安装或设置 shpool.path。');
}
export function parseSessions(stdout: string): Session[] {
  const data: unknown = JSON.parse(stdout);
  if (!data || typeof data !== 'object' || !('sessions' in data) || !Array.isArray(data.sessions)) throw new Error('Unsupported shpool list JSON / 不支持的 shpool list JSON');
  return data.sessions.map((s: unknown) => {
    if (!s || typeof s !== 'object') throw new Error('Invalid shpool session');
    const r = s as Record<string, unknown>;
    if (typeof r.name !== 'string' || !Number.isSafeInteger(r.started_at_unix_ms) ||
        (r.status !== 'Attached' && r.status !== 'Disconnected') || !Array.isArray(r.attachments) ||
        !r.attachments.every(a => a && Number.isSafeInteger(a.pid) && a.pid > 0)) {
      throw new Error('Expected shpool JSON attachment PIDs / 缺少预期的 shpool JSON attachment PID');
    }
    return {name: r.name, startedAt: r.started_at_unix_ms as number, status: r.status, attachments: r.attachments.map(a => a.pid)};
  });
}
export class Shpool {
  constructor(readonly backend: Backend) {}
  async list(startDaemon = true): Promise<Session[]> { return parseSessions(await run(this.backend.executable, [...(startDaemon ? [] : ['--no-daemonize']), '--socket', this.backend.socket, 'list', '--json'])); }
  async create(name: string, cwd: string): Promise<Session> {
    if (!safeName(name)) throw new Error('Invalid session identity');
    await run(this.backend.executable, ['--socket', this.backend.socket, 'attach', '--background', '--dir', '.', name], cwd);
    // --background returns before the daemon finishes detaching its temporary
    // client. Wait for that transition; never force an occupied attachment.
    for (let attempt = 0; attempt < 20; attempt++) {
      const session = (await this.list(false)).find(s => s.name === name);
      if (session && session.status === 'Disconnected' && !session.attachments.length) return session;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error('Could not prepare an unoccupied persistent shell / 无法准备空闲的持久化 shell');
  }
  async kill(name: string): Promise<void> {
    if (!safeName(name)) throw new Error('Invalid session identity');
    await run(this.backend.executable, ['--socket', this.backend.socket, 'kill', name]);
  }
  args(name: string, force = false): string[] {
    if (!safeName(name)) throw new Error('Invalid session identity');
    // --dir . uses the terminal cwd without passing it through shpool templates.
    return ['--socket', this.backend.socket, 'attach', ...(force ? ['--force'] : []), '--dir', '.', name];
  }
}

/** Atomic permanent reservations cover simultaneous windows, profiles and same-basename workspaces.
 * Never reuse a reserved name: delayed kill callbacks cannot target a newly allocated terminal.
 */
export async function reserveName(root: string, base: string, workspace: string, existing: Iterable<string>): Promise<string> {
  const directory = join(root, 'names');
  await mkdir(directory, {recursive: true, mode: 0o700});
  const busy = new Set(existing);
  for (let n = 1; n <= 1000000; n++) {
    const name = `${prefix(base)}-${n}`;
    if (busy.has(name)) continue;
    let file;
    try { file = await open(join(directory, name), 'wx', 0o600); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue; throw error; }
    try { await file.writeFile(workspace); await file.sync(); } finally { await file.close(); }
    return name;
  }
  throw new Error('Session number space exhausted');
}

/** OS advisory lock, released by the kernel when the pipe closes after host exit/crash.
 * No timeout-based lease stealing: a paused but live host must retain ownership.
 */
export async function lockWorkspace(root: string, workspace: string, onLost: () => void = () => {}): Promise<() => void> {
  await mkdir(root, {recursive: true, mode: 0o700});
  const child: ChildProcess = spawn('/usr/bin/flock', ['--exclusive', '--nonblock', join(root, `${hash(workspace)}.lock`), '/bin/cat'], {stdio: ['pipe', 'pipe', 'pipe']});
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error('Workspace lock timed out')); }, 5000);
    const fail = () => { clearTimeout(timer); reject(new Error('This workspace already has an active Shpool Persistent owner, or util-linux flock is unavailable. / 此工作区已由另一窗口管理，或缺少 util-linux flock。')); };
    child.once('error', fail);
    child.once('exit', fail);
    child.stdin!.on('error', () => {});
    child.stdout!.once('data', () => { clearTimeout(timer); resolve(); });
    child.stdin!.write('ready\n');
  });
  let released = false;
  child.once('exit', () => { if (!released) onLost(); });
  return () => { released = true; child.stdin?.end(); };
}
