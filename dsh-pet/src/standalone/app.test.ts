/**
 * 可编程入口 `startStandalone()` 的契约测试（ticket 02）。
 *
 * 打包后的宿主角色跑在 Electron 主进程里，不能 import 那个「一被 import 就执行 main()」的 CLI，
 * 所以独立模式的启动逻辑必须有一个可调用、可收尾的编程接口。这里钉住三件事：
 *   1. 返回值够用：拿到真实监听端口与带 token 的设置页 URL；
 *   2. 运行时状态文件就是启动器读的那一份（pid / port / settingsUrl 对得上）；
 *   3. `shutdown()` 幂等，且会关服务、清理运行时文件（含 POST /shutdown 的默认路径）。
 *
 * 与 integration.test.ts 同样的隔离手法：DSH_HOME 指到临时目录、DSH_PET_ELECTRON_PATH 指到
 * 一个真实存在的可执行文件，避免测试真的去下载 Electron。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { MissingPackageConfigError, startStandalone, type StandaloneHandle } from './app.ts';
import type { StandaloneLogger } from './context.ts';

const packageRoot = fileURLToPath(new URL('../../', import.meta.url));
const silent: StandaloneLogger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

/** 建隔离环境；返回还原函数。 */
function isolatedHome(): { home: string; restore: () => void } {
  const home = mkdtempSync(join(tmpdir(), 'dsh-pet-app-'));
  const saved = {
    home: process.env.DSH_HOME,
    electron: process.env.DSH_PET_ELECTRON_PATH,
    packaged: process.env.DSH_PET_PACKAGED,
  };
  process.env.DSH_HOME = home;
  // 指向真实存在的可执行文件：万一走到拉起分支也不会真的下载 Electron
  process.env.DSH_PET_ELECTRON_PATH = process.execPath;
  delete process.env.DSH_PET_PACKAGED;
  return {
    home,
    restore: () => {
      if (saved.home === undefined) delete process.env.DSH_HOME;
      else process.env.DSH_HOME = saved.home;
      if (saved.electron === undefined) delete process.env.DSH_PET_ELECTRON_PATH;
      else process.env.DSH_PET_ELECTRON_PATH = saved.electron;
      if (saved.packaged === undefined) delete process.env.DSH_PET_PACKAGED;
      else process.env.DSH_PET_PACKAGED = saved.packaged;
      rmSync(home, { recursive: true, force: true });
    },
  };
}

function runtimeFile(home: string): string {
  return join(home, 'dsh-pet', 'standalone-runtime.json');
}

async function portIsClosed(port: number): Promise<boolean> {
  try {
    await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1000) });
    return false;
  } catch {
    return true;
  }
}

async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs = 5000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`等待条件超时（${timeoutMs}ms）`);
}

test('startStandalone 返回端口/设置页 URL，shutdown 幂等且清理运行时文件', { timeout: 30_000 }, async (t) => {
  const { home, restore } = isolatedHome();
  t.after(restore);
  const handle: StandaloneHandle = await startStandalone({ logger: silent, port: 0, packageRoot });
  t.after(async () => {
    await handle.shutdown('test-cleanup').catch(() => {});
  });

  assert.ok(handle.port > 0, '必须拿到真实监听端口（端口 0 = 由系统分配）');
  assert.match(
    handle.settingsUrl,
    new RegExp(`^http://127\\.0\\.0\\.1:${handle.port}/standalone-ai/#token=[A-Za-z0-9_-]{43}$`),
    '设置页 URL 必须带一次性 token，端口与句柄一致',
  );

  // 运行时状态文件：与 CLI 写的是同一份（启动器/托盘将读取它打开设置页）
  const file = runtimeFile(home);
  assert.ok(existsSync(file), '启动后必须写 standalone-runtime.json');
  const runtime = JSON.parse(readFileSync(file, 'utf8')) as {
    pid: number;
    port: number;
    token: string;
    settingsUrl: string;
  };
  assert.equal(runtime.pid, process.pid);
  assert.equal(runtime.port, handle.port);
  assert.equal(runtime.settingsUrl, handle.settingsUrl);

  // 健康检查：200 JSON，且不得泄漏 token
  const health = await fetch(`http://127.0.0.1:${handle.port}/health`);
  assert.equal(health.status, 200);
  const text = await health.text();
  const body = JSON.parse(text) as { name?: string };
  assert.equal(body.name, 'dsh-pet-standalone');
  assert.ok(!text.includes(runtime.token), '/health 不得包含设置页 token');

  await handle.shutdown('test');
  assert.equal(existsSync(file), false, 'shutdown 必须清理运行时状态文件');
  assert.ok(await portIsClosed(handle.port), 'shutdown 必须释放端口');

  // 幂等：重复调用不得抛错、不得再次写文件
  await handle.shutdown('again');
  assert.equal(existsSync(file), false);
});

test('POST /shutdown（默认收尾路径）会关服务并清理运行时文件', { timeout: 30_000 }, async (t) => {
  const { home, restore } = isolatedHome();
  t.after(restore);
  const handle = await startStandalone({ logger: silent, port: 0, packageRoot });
  t.after(async () => {
    await handle.shutdown('test-cleanup').catch(() => {});
  });

  const file = runtimeFile(home);
  const runtime = JSON.parse(readFileSync(file, 'utf8')) as { token: string };
  const response = await fetch(`http://127.0.0.1:${handle.port}/shutdown`, {
    method: 'POST',
    headers: { 'x-dsh-pet-token': runtime.token },
  });
  assert.equal(response.status, 200);

  await waitFor(() => !existsSync(file) && portIsClosed(handle.port));
  // 之后再显式调用一次仍然幂等（嵌入方可能重复收尾）
  await handle.shutdown('after-post');
});

test('包内默认配置缺失时抛 MissingPackageConfigError（CLI 据此保持原有退出码）', async (t) => {
  const { home, restore } = isolatedHome();
  t.after(restore);

  await assert.rejects(
    startStandalone({ logger: silent, port: 0, packageRoot: join(home, 'not-a-package') }),
    (error: unknown) => {
      assert.ok(error instanceof MissingPackageConfigError);
      assert.match(error.message, /包内默认配置缺失/);
      return true;
    },
  );
});
