/** Install an isolated, pinned PowerContext runtime without changing the user's Python or PATH. */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const UV_VERSION = '0.9.26';
const ARCHIVES: Record<string, [string, string]> = {
  'linux-x64': [
    'uv-x86_64-unknown-linux-gnu.tar.gz',
    '30ccbf0a66dc8727a02b0e245c583ee970bdafecf3a443c1686e1b30ec4939e8',
  ],
  'linux-arm64': [
    'uv-aarch64-unknown-linux-gnu.tar.gz',
    'f71040c59798f79c44c08a7a1c1af7de95a8d334ea924b47b67ad6b9632be270',
  ],
  'darwin-x64': ['uv-x86_64-apple-darwin.tar.gz', '171eb8c518313e157c5b4cec7b4f743bc6bab1bd23e09b646679a02d096a047f'],
  'darwin-arm64': [
    'uv-aarch64-apple-darwin.tar.gz',
    'fcf0a9ea6599c6ae28a4c854ac6da76f2c889354d7c36ce136ef071f7ab9721f',
  ],
  'win32-x64': ['uv-x86_64-pc-windows-msvc.zip', 'eb02fd95d8e0eed462b4a67ecdd320d865b38c560bffcda9a0b87ec944bdf036'],
  'win32-arm64': ['uv-aarch64-pc-windows-msvc.zip', '79e1398ec98681b1b0494ed3485b0f4565e98a7db109a3f205d0fcdc6a1992f7'],
};

/** Only OS/network necessities cross into the managed runtime; unrelated model and Server settings do not. */
export function memoryProcessEnv(directory: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of [
    'PATH',
    'HOME',
    'USERPROFILE',
    'SYSTEMROOT',
    'SystemRoot',
    'WINDIR',
    'TEMP',
    'TMP',
    'TMPDIR',
    'LANG',
    'LC_ALL',
    'HTTPS_PROXY',
    'HTTP_PROXY',
    'NO_PROXY',
    'https_proxy',
    'http_proxy',
    'no_proxy',
    'SSL_CERT_FILE',
    'SSL_CERT_DIR',
  ]) {
    if (process.env[key]) env[key] = process.env[key];
  }
  return {
    ...env,
    UV_NO_CONFIG: '1',
    UV_CACHE_DIR: join(directory, 'cache'),
    UV_PYTHON_INSTALL_DIR: join(directory, 'python'),
    UV_PYTHON_PREFERENCE: 'only-managed',
    PYTHONNOUSERSITE: '1',
    PYTHONUNBUFFERED: '1',
  };
}

/** Fixed executables/arguments only. Output can include credentials and is deliberately discarded. */
export function runMemoryCommand(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  signal: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, signal, stdio: 'ignore', windowsHide: true });
    const timer = setTimeout(() => child.kill('SIGKILL'), 600_000);
    let failed = false;
    child.once('error', () => {
      failed = true;
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      if (code === 0 && !failed && !signal.aborted) resolve();
      else reject(new Error('runtime_command_failed'));
    });
  });
}

/** Download official uv with a release-pinned SHA-256, then let it install Python and PowerContext privately. */
export async function installMemoryRuntime(directory: string, signal: AbortSignal): Promise<string> {
  const python = join(directory, 'venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  const env = memoryProcessEnv(directory);
  if (existsSync(python)) {
    try {
      await runMemoryCommand(
        python,
        ['-c', 'from importlib.metadata import version; assert version("powercontext") == "1.5.0"; import uvicorn'],
        env,
        signal,
      );
      return python;
    } catch {
      signal.throwIfAborted();
    }
  }
  const artifact = ARCHIVES[`${process.platform}-${process.arch}`];
  if (!artifact) throw new Error('unsupported_platform');
  const bin = join(directory, 'uv');
  mkdirSync(bin, { recursive: true, mode: 0o700 });
  const uv = join(bin, process.platform === 'win32' ? 'uv.exe' : 'uv');
  if (existsSync(uv)) {
    try {
      await runMemoryCommand(uv, ['--version'], env, signal);
    } catch {
      signal.throwIfAborted();
      rmSync(uv, { force: true });
    }
  }
  if (!existsSync(uv)) {
    const [name, digest] = artifact;
    const archive = join(directory, name);
    try {
      // System curl honors proxy settings on all supported platforms. -q disables user curlrc commands.
      await runMemoryCommand(
        'curl',
        [
          '-q',
          '--fail',
          '--location',
          '--proto',
          '=https',
          '--proto-redir',
          '=https',
          '--max-time',
          '120',
          '--max-filesize',
          '50000000',
          '--silent',
          '--output',
          archive,
          `https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/${name}`,
        ],
        env,
        signal,
      );
      if (createHash('sha256').update(readFileSync(archive)).digest('hex') !== digest)
        throw new Error('download_checksum_failed');
      // Windows tar (bsdtar) supports zip. Unix archives contain one enclosing directory.
      const args =
        process.platform === 'win32'
          ? ['-xf', archive, '-C', bin]
          : ['-xzf', archive, '--strip-components=1', '-C', bin];
      await runMemoryCommand('tar', args, env, signal);
      chmodSync(uv, 0o700);
    } finally {
      rmSync(archive, { force: true });
    }
  }
  if (!existsSync(python))
    await runMemoryCommand(uv, ['venv', '--clear', '--python', '3.12', join(directory, 'venv')], env, signal);
  await runMemoryCommand(uv, ['pip', 'install', '--python', python, 'powercontext[cli,server]==1.5.0'], env, signal);
  // Do not treat a partial download/installation as a usable runtime.
  await runMemoryCommand(
    python,
    ['-c', 'from importlib.metadata import version; assert version("powercontext") == "1.5.0"; import uvicorn'],
    env,
    signal,
  );
  return python;
}
