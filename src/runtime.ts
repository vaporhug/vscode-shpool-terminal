import {createHash, randomUUID} from 'node:crypto';
import {chmod, link, mkdir, open, readFile, unlink} from 'node:fs/promises';
import {join} from 'node:path';
import {Backend, run} from './backend';

interface RuntimeLock {
  version: string;
  targets: Record<string, {binarySha256: string}>;
}
export async function runtimeLock(extensionPath: string): Promise<RuntimeLock> {
  const manifest: RuntimeLock = JSON.parse(await readFile(join(extensionPath, 'runtime.lock.json'), 'utf8'));
  if (!/^\d+\.\d+\.\d+$/.test(manifest.version)) throw new Error('Invalid bundled runtime version');
  return manifest;
}
const sha = (buffer: Buffer) => createHash('sha256').update(buffer).digest('hex');

/** Immutable runtime cache survives removal of an older VSIX installation directory.
 * Old binaries/sockets are deliberately retained; an upgrade never terminates a daemon.
 */
export async function bundledBackend(extensionPath: string, stateRoot: string, socketRoot: string, socketOverride = '', target = `${process.platform}-${process.arch}`): Promise<Backend> {
  const manifest = await runtimeLock(extensionPath);
  const asset = manifest.targets[target];
  if (!asset || !/^[a-f0-9]{64}$/.test(asset.binarySha256)) throw new Error(`Bundled shpool is unavailable for ${target}. / 暂不支持此平台的内置 shpool。`);
  const directory = join(stateRoot, 'runtimes', manifest.version, `${target}-${asset.binarySha256.slice(0, 12)}`);
  const executable = join(directory, 'shpool');
  const source = join(extensionPath, 'vendor', target, 'shpool');
  let cached: Buffer | undefined;
  try { cached = await readFile(executable); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  if (cached && sha(cached) !== asset.binarySha256) throw new Error('Cached shpool checksum mismatch; refusing to overwrite a potentially active runtime. / 缓存 shpool 校验失败，已停止使用。');
  if (!cached) {
    const binary = await readFile(source);
    if (sha(binary) !== asset.binarySha256) throw new Error('Bundled shpool checksum mismatch / 内置 shpool 校验失败');
    await mkdir(directory, {recursive: true, mode: 0o700});
    const temporary = join(directory, `${randomUUID()}.tmp`);
    const file = await open(temporary, 'wx', 0o700);
    try { await file.writeFile(binary); await file.sync(); } finally { await file.close(); }
    try {
      try { await link(temporary, executable); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
      if (sha(await readFile(executable)) !== asset.binarySha256) throw new Error('Runtime cache changed during installation');
      const dir = await open(directory, 'r');
      try { await dir.sync(); } finally { await dir.close(); }
    } finally { await unlink(temporary).catch(() => {}); }
  }
  await chmod(executable, 0o700);
  if ((await run(executable, ['version'])).trim() !== `shpool ${manifest.version}`) throw new Error('Bundled shpool version mismatch');
  // Keep Unix socket paths short even when the workspace/state path is very long.
  const socketDirectory = join(socketRoot, 'vscode-shpool', `${manifest.version}-${asset.binarySha256.slice(0, 8)}`);
  await mkdir(socketDirectory, {recursive: true, mode: 0o700});
  const socket = socketOverride || join(socketDirectory, 'shpool.sock');
  if (!socket.startsWith('/') || Buffer.byteLength(socket) > 100) throw new Error('shpool socket must be an absolute path of at most 100 bytes / socket 必须是最多 100 字节的绝对路径');
  return {executable, socket};
}
