import {Backend, Session, safeName} from './backend';

export interface RecordData {
  id: string;
  workspace: string;
  persistent: true;
  sessionName: string;
  backend: Backend;
  cwd: string;
  /** A shell generation, not the terminal client PID. */
  startedAt?: number;
  bootId?: string;
}
export const stateKey = 'persistentTerminals.v1';
export const identityKey = 'VSCODE_SHPOOL_TERMINAL_ID';
export function records(value: unknown, workspace: string): RecordData[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  return value.filter((r): r is RecordData => {
    if (!r || typeof r !== 'object' || typeof r.id !== 'string' || r.workspace !== workspace ||
        r.persistent !== true || typeof r.sessionName !== 'string' || !safeName(r.sessionName) ||
        typeof r.cwd !== 'string' || !r.cwd.startsWith('/') ||
        typeof r.backend?.executable !== 'string' || !r.backend.executable.startsWith('/') ||
        typeof r.backend?.socket !== 'string' || !r.backend.socket.startsWith('/') ||
        (r.startedAt !== undefined && !Number.isSafeInteger(r.startedAt)) || seen.has(r.id)) return false;
    seen.add(r.id); return true;
  });
}
export type CloseAction = 'keep' | 'remove' | 'kill';
// Numeric values are VS Code's stable TerminalExitReason enum.
export function closeAction(reason: number | undefined, record: RecordData, session: Session | undefined, pid: number | undefined): CloseAction {
  if (reason !== 2 && reason !== 3) return 'keep';
  if (!session) return 'remove';
  if (reason === 2) return 'keep'; // attach error, detach, killed client != exited inner shell
  if (record.startedAt === undefined || record.startedAt !== session.startedAt) return 'remove';
  if (session.attachments.some(p => p !== pid)) return 'remove';
  return 'kill';
}
export function matches(record: RecordData, options: {shellPath?: string; shellArgs?: string | readonly string[]; env?: {[key: string]: string | null | undefined}}): boolean {
  return options.env?.[identityKey] === record.id && options.shellPath === record.backend.executable &&
    Array.isArray(options.shellArgs) && options.shellArgs.at(-1) === record.sessionName &&
    options.shellArgs[0] === '--socket' && options.shellArgs[1] === record.backend.socket && options.shellArgs[2] === 'attach';
}
