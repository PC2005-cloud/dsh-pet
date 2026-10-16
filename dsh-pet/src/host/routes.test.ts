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
/** 用户表情包目录（共享链）里的图 */
const SHARED_PIC = 'SHARED-MEME-BYTES';
/** pet pack 独占表情包目录里的图 */
const OWN_PIC = 'PETPACK-OWN-MEME';
/** 中文名 pet pack（仓库明确支持中文名，标识符校验不得用 ASCII 白名单） */
const CN_PET = '测试宠';

type Result = { status: number; body: string };

let dir = '';
let call: (url: string, method?: string, body?: string) => Promise<Result> = () =>
  Promise.reject(new Error('未初始化'));
let savedHome: string | undefined;
let savedElectron: string | undefined;
/** apply() 注册的全部 effect 释放函数（after 里调用：否则常驻定时器会让测试进程不退出） */
const disposers: Array<() => void> = [];

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
  // 表情包：用户目录（共享链）+ pet pack 独占目录（与 <名>-animation/ 同一套素材归属）
  mkdirSync(join(userRoot, 'memes'), { recursive: true });
  writeFileSync(join(userRoot, 'memes', '共用图.png'), SHARED_PIC);
  mkdirSync(join(userRoot, 'pet', `${CN_PET}-memes`), { recursive: true });
  writeFileSync(join(userRoot, 'pet', `${CN_PET}-memes`, '自家图.png'), OWN_PIC);
  // 用户根之外的诱饵：目录名以 -animation / -memes 结尾，正是旧漏洞能读到的东西
  mkdirSync(join(dir, 'outside-animation'), { recursive: true });
  writeFileSync(join(dir, 'outside-animation', 'leak.webm'), SECRET);
  mkdirSync(join(dir, 'outside-memes'), { recursive: true });
  writeFileSync(join(dir, 'outside-memes', 'leak.png'), SECRET);

  savedHome = process.env.DSH_HOME;
  savedElectron = process.env.DSH_PET_ELECTRON_PATH;
  process.env.DSH_HOME = home;
  // 命中一个已存在的文件：桌面 Helper 无论走哪条分支都不会真的下载/拉起
  process.env.DSH_PET_ELECTRON_PATH = process.execPath;

  let handler: ((req: unknown, res: unknown) => Promise<void>) | undefined;
  const noop = (): void => {};
  apply({
    // 与 DSH 一致：effect 的返回值是**释放函数**。这里收下来在 after() 里调用——
    // 插件现在有常驻定时器（余额周期刷新），不释放的话测试进程会一直等它（跑完不退出）。
    effect: (fn: () => unknown) => {
      try {
        const dispose = fn();
        if (typeof dispose === 'function') disposers.push(dispose as () => void);
        return dispose;
      } catch {
        /* 源码形态下内置配置不可达，refreshDesktop 会抛给调用方——这里吞掉，不影响路由注册 */
      }
    },
    on: () => noop,
    webServer: { register: (spec: { handler: typeof handler }) => ((handler = spec.handler), noop) },
    commands: { register: () => noop },
    logger: { warn: () => {}, info: () => {}, debug: () => {}, error: () => {} },
    // 固定返回一个"没登记余额接口"的服务商：POST /balance 的路径因此是确定的
    // （matchBalanceProvider 不命中 → S 里写 ok:false/unsupported，而不是靠抛错走到 fetch-error）
    agentDefaultModel: { currentSelection: () => ({ provider: 'no-such-provider', model: 'x' }) },
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

  call = (url: string, method = 'GET', body?: string) =>
    new Promise<Result>((done) => {
      const res = new FakeRes();
      res.on('finish', () => done({ status: res.status, body: Buffer.concat(res.chunks).toString('utf8') }));
      // 请求桩：'end' 必须回调，否则 host 对 PUT/POST 的 readBody 永远等不到结束事件，
      // 调用方直接挂死。带 body 时先发 'data' 再发 'end'（readBody 两个事件都等）。
      void handler?.(
        {
          method,
          url,
          on: (event: string, cb: (chunk?: Buffer) => void) => {
            if (event === 'data' && body !== undefined) queueMicrotask(() => cb(Buffer.from(body, 'utf8')));
            if (event === 'end') queueMicrotask(() => cb());
            return undefined;
          },
        },
        res,
      );
    });
});

after(() => {
  // 先释放插件注册的 effect（清掉余额周期定时器），否则测试跑完进程不退出
  for (const dispose of disposers.splice(0)) {
    try {
      dispose();
    } catch {
      /* 释放失败不影响其余清理 */
    }
  }
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

describe('/state + /balance —— 轮询统一状态与余额动作端点', () => {
  test('GET /state 返回 { sections, pets }（初始叶子 counter=0 / data=null）', async () => {
    const r = await call('/dsh-pet-7340/state');
    assert.equal(r.status, 200);
    const body = JSON.parse(r.body) as {
      sections: Record<string, { counter: number; data: unknown }>;
      pets: Record<string, unknown>;
    };
    assert.deepEqual(Object.keys(body.sections).sort(), ['balance', 'notify', 'workStatus']);
    assert.equal(body.sections.balance.counter, 0, '没人写过时 counter=0（前端首拉当基线）');
    assert.equal(body.sections.balance.data, null);
    assert.deepEqual(body.pets, {});
  });

  test('非 GET → 405（只读端点）', async () => {
    assert.equal((await call('/dsh-pet-7340/state', 'POST')).status, 405);
  });

  test('POST /balance 是动作端点：只回 { ok: true }，不返回余额数据', async () => {
    const r = await call('/dsh-pet-7340/balance', 'POST');
    assert.equal(r.status, 200);
    assert.deepEqual(JSON.parse(r.body), { ok: true }, '动作端点不得把余额数据塞进响应');
  });

  test('GET /balance 已删除 → 405（数据只有 /state 一个出口）', async () => {
    assert.equal((await call('/dsh-pet-7340/balance', 'GET')).status, 405);
  });

  test('POST /balance 之后：余额出现在 S 里，且带 manual 标记（前端据此必弹文字说明）', async () => {
    await call('/dsh-pet-7340/balance', 'POST');
    const r = await call('/dsh-pet-7340/state');
    const leaf = (JSON.parse(r.body) as { sections: { balance: { counter: number; data: Record<string, unknown> } } })
      .sections.balance;
    assert.ok(leaf.counter > 0, '动作必须推进 counter（否则前端不会渲染）');
    assert.equal(leaf.data.ok, false, '该服务商没登记余额接口 → 不可用状态也写进 S');
    assert.equal(leaf.data.reason, 'unsupported');
    assert.equal(leaf.data.manual, true, '手动触发的标记必须随数据一起写');
  });

  test('旧的 /balance/trigger 已删除 → 不再是一个端点（落到素材兜底 → 404）', async () => {
    const r = await call('/dsh-pet-7340/balance/trigger');
    assert.notEqual(r.status, 200, '触发计数端点应已删除');
  });
});

describe('轮询统一后删掉的旧端点 —— 不得复活', () => {
  // 这些端点改造前各有独立的客户端轮询循环；全部并入 GET /state 后删除。
  // 保留这条守卫是为了防止"顺手又加回一个 /xxx 轮询端点"（那正是这次要消灭的东西）。
  // 注意 /broadcast 不在此列：它以**新的语义**回来了（POST 写入端点，见下方专门的分组），
  // 这里的守卫只要求它不再是一个 GET 读端点。
  for (const path of ['/dsh-pet-7340/work-status', '/dsh-pet-7340/notify']) {
    test(`${path} 已删除（GET 不再是端点）`, async () => {
      const r = await call(path);
      assert.notEqual(r.status, 200, `${path} 应已并入 /state`);
    });
  }

  test('/broadcast 的 GET 读端点已删除（数据只有 /state 一个出口）', async () => {
    assert.equal((await call('/dsh-pet-7340/broadcast')).status, 405);
  });

  test('/whisper 只接受 POST（读端点已删，GET 不再返回文本）', async () => {
    assert.equal((await call('/dsh-pet-7340/whisper?pet=main', 'GET')).status, 405);
  });

  test('/whisper/trigger 已删除（手动碎碎念并入 POST /whisper）', async () => {
    const r = await call('/dsh-pet-7340/whisper/trigger?pet=main');
    assert.notEqual(r.status, 200);
  });
});

describe('/broadcast —— 第三方投喂（POST 写入端点，issue #76）', () => {
  // 覆盖范围说明：本文件在源码形态下 PACKAGE_ROOT 解析为 <pkg>/src，包内 assets 不可达，
  // 因此 readAllConfig 必然抛错——"成功写进 pets.<id>.say"那条路径在这里测不了。
  // 校验规则（宠物存在/配图在池内）由 broadcast.test.ts 的决策层单测覆盖；
  // 这里只钉路由层的行为契约：方法、JSON 解析、短路顺序、配置不可达时的显式失败。

  test('POST 空文本 → HTTP 200 + ok:false/bad-request（不读配置就能判定的失败先短路）', async () => {
    const r = await call('/dsh-pet-7340/broadcast?pet=main', 'POST', JSON.stringify({ text: '   ' }));
    assert.equal(r.status, 200, '业务失败走 200 + ok:false，与 /chat 同一口径');
    const body = JSON.parse(r.body) as { ok: boolean; reason: string };
    assert.equal(body.ok, false);
    assert.equal(body.reason, 'bad-request', '空文本必须在读配置之前就被拦下');
  });

  test('text 非字符串（数字/对象/缺字段）→ 同样 bad-request', async () => {
    for (const payload of [{ text: 123 }, { text: {} }, { text: null }, {}]) {
      const r = await call('/dsh-pet-7340/broadcast?pet=main', 'POST', JSON.stringify(payload));
      assert.equal(r.status, 200);
      assert.equal((JSON.parse(r.body) as { reason: string }).reason, 'bad-request', JSON.stringify(payload));
    }
  });

  test('请求体不是合法 JSON → 400（与 /config 的解析失败同一处理）', async () => {
    const r = await call('/dsh-pet-7340/broadcast?pet=main', 'POST', '{ 不是 json');
    assert.equal(r.status, 400);
    assert.match(r.body, /invalid JSON body/);
  });

  test('配置不可达时不静默：显式 ok:false/generate-error（不假装投喂成功）', async () => {
    const r = await call('/dsh-pet-7340/broadcast?pet=main', 'POST', JSON.stringify({ text: '该喝水了' }));
    assert.equal(r.status, 200);
    const body = JSON.parse(r.body) as { ok: boolean; reason: string };
    assert.equal(body.ok, false, '读不到配置绝不能回 ok:true——否则调用方以为气泡已投喂');
    assert.equal(body.reason, 'generate-error');
  });
});

describe('/anim —— 点播动画（POST 写入端点）', () => {
  // 覆盖范围同 /broadcast：源码形态下 PACKAGE_ROOT 解析为 <pkg>/src，readAllConfig 必然抛错，
  // 因此"成功写进 pets.<id>.anim"那条路径在这里测不了（名字校验与宠物选择由 anim.test.ts
  // 的决策层单测覆盖）。这里只钉路由层契约：方法、JSON 解析、失败口径。

  test('GET → 405（点播是动作端点，不是读端点）', async () => {
    assert.equal((await call('/dsh-pet-7340/anim?pet=main')).status, 405);
  });

  test('请求体不是合法 JSON → 400', async () => {
    const r = await call('/dsh-pet-7340/anim?pet=main', 'POST', '{ 不是 json');
    assert.equal(r.status, 400);
    assert.match(r.body, /invalid JSON body/);
  });

  test('配置不可达时不静默：显式 ok:false/generate-error（不假装已点播）', async () => {
    const r = await call('/dsh-pet-7340/anim?pet=main', 'POST', JSON.stringify({ name: '东张西望' }));
    assert.equal(r.status, 200);
    const body = JSON.parse(r.body) as { ok: boolean; reason: string };
    assert.equal(body.ok, false, '读不到配置绝不能回 ok:true——否则调用方以为动画已点播');
    assert.equal(body.reason, 'generate-error');
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

describe('pic/memes 路由 —— 表情包素材归属（与 thumb 同一套语义）', () => {
  test('种类独占：pet/<素材根>-memes/ 里的图按 <素材根>/<名> 取到（中文素材根照常）', async () => {
    const r = await call(`/dsh-pet-7340/pic/memes/${encodeURIComponent(CN_PET)}/${encodeURIComponent('自家图')}.png`);
    assert.equal(r.status, 200);
    assert.equal(r.body, OWN_PIC);
  });

  test('非独占：走用户目录 → 包内目录的回落链（main 与未知素材根同一口径）', async () => {
    for (const root of ['main', 'nosuchpet']) {
      const r = await call(`/dsh-pet-7340/pic/memes/${root}/${encodeURIComponent('共用图')}.png`);
      assert.equal(r.status, 200, `素材根 ${root} 应走回落链`);
      assert.equal(r.body, SHARED_PIC);
    }
  });

  test('旧的两段形式 /pic/memes/<名>.png 保留（= 素材根 main 的回落链）', async () => {
    const r = await call(`/dsh-pet-7340/pic/memes/${encodeURIComponent('共用图')}.png`);
    assert.equal(r.status, 200);
    assert.equal(r.body, SHARED_PIC);
  });

  test('独占就是独占：种类自己的目录里没有 → 404，绝不回落到用户/包内目录', async () => {
    // 共用图 只存在于用户目录；该种类有独立的 -memes 目录 → 只查它，不混用
    const r = await call(`/dsh-pet-7340/pic/memes/${encodeURIComponent(CN_PET)}/${encodeURIComponent('共用图')}.png`);
    assert.equal(r.status, 404);
    assert.equal(r.body.includes(SHARED_PIC), false, '独占目录命中时不得回落到共享目录');
  });

  test('不存在的图 → 404', async () => {
    assert.equal((await call('/dsh-pet-7340/pic/memes/main/nope.png')).status, 404);
  });

  test('通知图标（/pic/<名>.png）不受影响：仍只从包内 assets/pic 取', async () => {
    // 源码形态下包内 assets 不可达 → 404（关键是不被 memes 分支吞掉）
    assert.equal((await call('/dsh-pet-7340/pic/logo.png')).status, 404);
  });
});

describe('pic/memes 路由 —— 素材根不得当路径片段（与 thumb 同一条不变式）', () => {
  test('%5C 反斜杠穿越（Windows）→ 400，且绝不读到用户根之外', async () => {
    const r = await call('/dsh-pet-7340/pic/memes/..%5C..%5C..%5Coutside-memes/leak.png');
    assert.equal(r.status, 400);
    assert.equal(r.body.includes(SECRET), false, '越根内容不得出现在响应体里');
  });

  test('冒号 / 控制字符同样按非法素材根拒绝', async () => {
    for (const bad of ['C%3A%5CWindows', '%00null']) {
      const r = await call(`/dsh-pet-7340/pic/memes/${bad}/leak.png`);
      assert.equal(r.status, 400, `素材根=${bad} 应 400`);
    }
  });

  test('%2F 正斜杠被切成多段：穿越落在名称段，由 resolveAsset 拦下 → 404', async () => {
    const r = await call('/dsh-pet-7340/pic/memes/..%2F..%2F..%2Foutside-memes/leak.png');
    assert.equal(r.status, 404);
    assert.equal(r.body.includes(SECRET), false);
  });

  test('名称段同样不可穿越（防线不是只守住素材根）', async () => {
    const r = await call('/dsh-pet-7340/pic/memes/main/..%2F..%2F..%2Foutside-memes%2Fleak.png');
    assert.equal(r.status, 404);
    assert.equal(r.body.includes(SECRET), false);
  });

  test('双重编码不会被二次解码（只 decode 一次）→ 404 且不越根', async () => {
    const r = await call('/dsh-pet-7340/pic/memes/..%255C..%255C..%255Coutside-memes/leak.png');
    assert.equal(r.status, 404);
    assert.equal(r.body.includes(SECRET), false);
  });
});
