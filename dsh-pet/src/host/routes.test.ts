/**
 * 路由级回归测试：`/dsh-pet-7340/thumb/<petId>/<file>` 的路径安全与素材归属。
 *
 * 为什么单独有这一层：`petId` 是该路由里唯一**直接进文件路径**的用户输入，而 2026-08-28 的 pet pack
 * 重构把它引入时没套用 resolveAsset——Windows 上 `%5C` 解出的反斜杠不会被 `rest.split('/')` 切开，
 * 于是 `..\..\` 能越出用户根读盘；它挂了 2.5 周才被外部贡献者发现（PR #53）。本文件把这条不变式钉在
 * **handler 这一层**（而不是只测纯函数），防的就是"以后又有人新写一段手拼路径"。
 *
 * 直接 import 源码（`./index.ts`）而不是 `lib/` 构建产物：测试不依赖 `npm run build`（lib/ 不入库）。
 * 代价：源码形态下模块内的 PACKAGE_ROOT 解析为 `<pkg>/src`，包内 assets 不可达，故本文件只覆盖 thumb
 * 路由；`/config` 的成品契约由 shared/config.test.ts 的守卫与端到端脚本覆盖。
 *
 * 用 Node 内置 test runner（node:test），不引入任何 npm 依赖。
 */
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Writable } from 'node:stream';

import { apply } from './index.ts';

/** 用户根之外的诱饵内容：任何响应体出现它都说明越根读盘成功 */
const SECRET = 'TOP-SECRET-BYTES';
/** pet pack 自己的素材内容 */
const OWN = 'PETPACK-OWN-ASSET';
/** 主素材池内容 */
const MAIN = 'MAIN-POOL-ASSET';
/** 中文名 pet pack（仓库明确支持中文名，标识符校验不得用 ASCII 白名单） */
const CN_PET = '测试宠';

type Result = { status: number; body: string };

let dir = '';
let call: (url: string, method?: string) => Promise<Result> = () => Promise.reject(new Error('未初始化'));
let savedHome: string | undefined;
let savedElectron: string | undefined;

/** 最小响应桩：writeHead 记状态码，Writable 收集 body（sendFile 经 pipe 写入） */
class FakeRes extends Writable {
  declare status: number;
  declare chunks: Buffer[];
  constructor() {
    super();
    this.status = 0;
    this.chunks = [];
  }
  writeHead(status: number): this {
    this.status = status;
    return this;
  }
  _write(chunk: Buffer, _enc: BufferEncoding, cb: () => void): void {
    this.chunks.push(Buffer.from(chunk));
    cb();
  }
}

before(() => {
  dir = mkdtempSync(join(tmpdir(), 'dsh-pet-routes-'));
  const home = join(dir, 'home');
  const userRoot = join(home, 'dsh-pet');
  // 合法素材：pet pack 自己的目录（中文名）+ 主素材池
  mkdirSync(join(userRoot, 'pet', `${CN_PET}-animation`), { recursive: true });
  writeFileSync(join(userRoot, 'pet', `${CN_PET}-animation`, 'test.webm'), OWN);
  mkdirSync(join(userRoot, 'main-animation', 'webm'), { recursive: true });
  writeFileSync(join(userRoot, 'main-animation', 'webm', 'mainidle.webm'), MAIN);
  // 用户根之外的诱饵：目录名以 -animation 结尾，正是旧漏洞能读到的东西
  mkdirSync(join(dir, 'outside-animation'), { recursive: true });
  writeFileSync(join(dir, 'outside-animation', 'leak.webm'), SECRET);

  savedHome = process.env.DSH_HOME;
  savedElectron = process.env.DSH_PET_ELECTRON_PATH;
  process.env.DSH_HOME = home;
  // 命中一个已存在的文件：桌面 Helper 无论走哪条分支都不会真的下载/拉起
  process.env.DSH_PET_ELECTRON_PATH = process.execPath;

  let handler: ((req: unknown, res: unknown) => Promise<void>) | undefined;
  const noop = (): void => {};
  apply({
    effect: (fn: () => unknown) => {
      try {
        return fn();
      } catch {
        /* 源码形态下内置配置不可达，refreshDesktop 会抛给调用方——这里吞掉，不影响路由注册 */
      }
    },
    on: () => noop,
    webServer: { register: (spec: { handler: typeof handler }) => ((handler = spec.handler), noop) },
    commands: { register: () => noop },
    logger: { warn: () => {}, info: () => {}, debug: () => {}, error: () => {} },
    agentDefaultModel: { currentSelection: () => undefined },
    credentials: { resolve: async () => undefined },
    // 模型清单路由的数据源（与 DSH 模型选择器同源的宿主 llm 服务）：一个正常服务商 +
    // 一个列不出模型的服务商（验证单点失败不拖垮整张清单）
    llm: {
      listProviders: () => [
        { id: 'deepseek', name: 'DeepSeek' },
        { id: 'broken', name: 'Broken' },
      ],
      listModels: async (provider: string) => {
        if (provider === 'broken') throw new Error('adapter does not list models');
        return [{ id: 'deepseek-chat', name: 'DeepSeek Chat' }];
      },
    },
  });
  assert.ok(handler, 'apply() 应注册 /dsh-pet-7340 prefix handler'); // 注册失败则整份测试无意义

  call = (url: string, method = 'GET') =>
    new Promise<Result>((done) => {
      const res = new FakeRes();
      res.on('finish', () => done({ status: res.status, body: Buffer.concat(res.chunks).toString('utf8') }));
      // 请求桩：只服务无 body 的请求——'end' 必须回调，否则 host 对 PUT/POST 的 readBody
      // 永远等不到结束事件，调用方直接挂死（本文件只测无 body 的端点）
      void handler?.(
        {
          method,
          url,
          on: (event: string, cb: () => void) => {
            if (event === 'end') queueMicrotask(cb);
            return undefined;
          },
        },
        res,
      );
    });
});

after(() => {
  if (savedHome === undefined) delete process.env.DSH_HOME;
  else process.env.DSH_HOME = savedHome;
  if (savedElectron === undefined) delete process.env.DSH_PET_ELECTRON_PATH;
  else process.env.DSH_PET_ELECTRON_PATH = savedElectron;
  rmSync(dir, { recursive: true, force: true });
});

describe('/models 路由 —— 设置页「AI 模型」下拉框的数据源', () => {
  test('每个服务商连同它名下的模型一起返回（与 DSH 模型选择器同源）', async () => {
    const r = await call('/dsh-pet-7340/models');
    assert.equal(r.status, 200);
    const body = JSON.parse(r.body) as {
      providers: Array<{ id: string; name: string; models: Array<{ id: string; name: string }> }>;
    };
    assert.deepEqual(body.providers[0], {
      id: 'deepseek',
      name: 'DeepSeek',
      models: [{ id: 'deepseek-chat', name: 'DeepSeek Chat' }],
    });
  });

  test('单个服务商列不出模型 → 只让它空着，不拖垮整张清单', async () => {
    const r = await call('/dsh-pet-7340/models');
    const body = JSON.parse(r.body) as { providers: Array<{ id: string; models: unknown[] }> };
    assert.equal(body.providers.length, 2, '一个服务商列不出模型不得让整个清单变空');
    assert.deepEqual(body.providers[1].models, []);
  });

  test('非 GET → 405（只读端点）', async () => {
    const r = await call('/dsh-pet-7340/models', 'POST');
    assert.equal(r.status, 405);
  });
});

describe('thumb 路由 —— 合法路径照常（修复不得误杀）', () => {
  test('pet pack 自己的素材：中文名 petId 正常返回', async () => {
    const r = await call(`/dsh-pet-7340/thumb/${encodeURIComponent(CN_PET)}/test.webm`);
    assert.equal(r.status, 200);
    assert.equal(r.body, OWN);
  });

  test('主素材链：main 素材根仍可读', async () => {
    const r = await call('/dsh-pet-7340/thumb/main/mainidle.webm');
    assert.equal(r.status, 200);
    assert.equal(r.body, MAIN);
  });

  test('不存在的素材根 → 404（行为与"没有独立素材目录"一致）', async () => {
    const r = await call('/dsh-pet-7340/thumb/nosuchpet/x.webm');
    assert.equal(r.status, 404);
  });
});

describe('thumb 路由 —— petId 不得当路径片段（PR #53 的不变式）', () => {
  test('%5C 反斜杠穿越（Windows）→ 400，且绝不读到用户根之外', async () => {
    const r = await call('/dsh-pet-7340/thumb/..%5C..%5C..%5Coutside/leak.webm');
    assert.equal(r.status, 400);
    assert.equal(r.body.includes(SECRET), false, '越根内容不得出现在响应体里');
  });

  test('%2F 正斜杠被切成多段：穿越落在 fileName 段，由 resolveAsset 拦下 → 404', async () => {
    // 注意与 %5C 的区别：正斜杠参与 split('/')，petId 只剩 '..'（点号属合法标识符字符，不进 400 分支），
    // 穿越意图体现在 fileName = '../../outside/leak.webm' 上——那道防线是 resolveExisting 的根内校验。
    const r = await call('/dsh-pet-7340/thumb/..%2F..%2F..%2Foutside/leak.webm');
    assert.equal(r.status, 404);
    assert.equal(r.body.includes(SECRET), false);
  });

  test('冒号 / 控制字符同样按非法标识符拒绝', async () => {
    for (const bad of ['C%3A%5CWindows', '%00null']) {
      const r = await call(`/dsh-pet-7340/thumb/${bad}/leak.webm`);
      assert.equal(r.status, 400, `petId=${bad} 应 400`);
    }
  });

  test('双重编码不会被二次解码（只 decode 一次）→ 404 且不越根', async () => {
    // %255C 解一次为字面量 "%5C"（含 % 属合法标识符字符），join 后不构成分隔符 → 走兜底链
    const r = await call('/dsh-pet-7340/thumb/..%255C..%255C..%255Coutside/leak.webm');
    assert.equal(r.status, 404);
    assert.equal(r.body.includes(SECRET), false);
  });

  test('fileName 段同样不可穿越（防线不是只守住 petId）', async () => {
    const r = await call('/dsh-pet-7340/thumb/main/..%2F..%2F..%2Foutside%2Fleak.webm');
    assert.equal(r.status, 404);
    assert.equal(r.body.includes(SECRET), false);
  });
});
