/**
 * 第三方投喂（`POST /dsh-pet-7340/broadcast`，issue #76）的决策层单测。
 *
 * 为什么测这一层而不是只测 HTTP：本功能的契约就是这几条校验规则（文本非空、宠物存在、
 * 配图给名称时必须在包内表情包池内、给 url 时必须是 http/https 完整地址、两种形态不得同时给）。
 * 路由层在源码形态下读不到包内 assets（PACKAGE_ROOT 解析成
 * <pkg>/src），覆盖不到这些分支——所以规则抽到 ./broadcast 里单测，路由只剩搬运。
 *
 * 用 Node 内置 test runner（node:test），不引入任何 npm 依赖。
 */
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  decideBroadcast,
  decideBubbleClear,
  normalizeBroadcastAnim,
  normalizeBroadcastDuration,
  normalizeBroadcastText,
} from './broadcast.ts';

/** 池里真实存在的两张图 */
const IN_POOL = '可爱';
const IN_POOL2 = '大的要来啦';
/** 配置里写了、但磁盘上没有对应 png → readMemePool 会剔除，投喂时算"不在池内" */
const NO_FILE = '缺文件的图';

let tempRoot = '';
let memesDir = '';
let cfg: Record<string, Record<string, unknown>>;

/** 决策的便捷调用：只覆盖本次关心的参数，其余取默认。
 *  memeDirs 默认给「共享表情包目录」这一条链（= 非独占的回落链），与 host 的 memeDirsFor 同序。 */
const decide = (over: Partial<Parameters<typeof decideBroadcast>[0]> = {}) =>
  decideBroadcast({
    cfg,
    requested: 'main',
    text: '主人，该喝水了',
    image: undefined,
    url: undefined,
    duration: 10000,
    anim: true,
    memeDirs: () => [memesDir],
    ...over,
  });

before(() => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-pet-broadcast-'));
  memesDir = join(root, 'memes');
  mkdirSync(memesDir, { recursive: true });
  writeFileSync(join(memesDir, `${IN_POOL}.png`), 'x');
  writeFileSync(join(memesDir, `${IN_POOL2}.png`), 'x');
  tempRoot = root;

  cfg = {
    main: {
      memes: { [IN_POOL]: '卖萌', [IN_POOL2]: '预警', [NO_FILE]: '文件缺失的那张' },
      pets: [
        { id: 'main', name: '蓝毛小女仆' },
        { id: 'test1', name: '测试宠' },
      ],
    },
  };
});

after(() => {
  rmSync(tempRoot, { recursive: true, force: true });
});

describe('normalizeBroadcastText —— 文本规范化（路由与决策层共用同一条规则）', () => {
  test('非字符串一律归零（不是抛错，也不是字符串化）', () => {
    for (const v of [undefined, null, 123, {}, [], true]) {
      assert.equal(normalizeBroadcastText(v), '', `${JSON.stringify(v)} 应归一成空串`);
    }
  });

  test('纯空白与前后空白：trim 后判定', () => {
    assert.equal(normalizeBroadcastText('   '), '');
    assert.equal(normalizeBroadcastText('\n\t '), '');
    assert.equal(normalizeBroadcastText('  说话  '), '说话');
  });
});

describe('decideBroadcast —— 不设长度限制', () => {
  test('超长文本照常通过（内容长度由调用方自己负责）', () => {
    // 投喂不设长度限制、也不限频：宿主只保证"非空就搬运"，不截断、不丢弃。
    const long = 'x'.repeat(100000);
    const d = decide({ text: long });
    assert.equal(d.ok, true);
    assert.equal(d.ok === true && d.text.length, 100000);
  });
});

describe('decideBroadcast —— 文本校验', () => {
  test('空 / 纯空白 / 缺字段 → bad-request', () => {
    for (const text of ['', '   ', undefined, null, 42]) {
      const d = decide({ text });
      assert.equal(d.ok, false);
      assert.equal(d.ok === false && d.reason, 'bad-request');
    }
  });

  test('文本 trim 后写入（前后空白不进气泡）', () => {
    const d = decide({ text: '  该喝水了  ' });
    assert.equal(d.ok, true);
    assert.equal(d.ok === true && d.text, '该喝水了');
  });
});

describe('decideBroadcast —— 宠物选择', () => {
  test('指定存在的宠物 → 用它', () => {
    const d = decide({ requested: 'test1' });
    assert.equal(d.ok, true);
    assert.equal(d.ok === true && d.petId, 'test1');
  });

  test('不指定 pet → pet-required（缺省链已删除：绝不退到"当前桌宠"/列表第一只）', () => {
    for (const empty of ['', '   ']) {
      const d = decide({ requested: empty });
      assert.equal(d.ok, false);
      assert.equal(d.ok === false && d.reason, 'pet-required');
    }
  });

  test('指定不存在的宠物 → unknown-pet（显式失败，不静默写进一个没人看的叶子）', () => {
    const d = decide({ requested: 'ghost' });
    assert.equal(d.ok, false);
    assert.equal(d.ok === false && d.reason, 'unknown-pet');
    assert.match(d.ok === false ? d.message : '', /ghost/);
  });

  test('宠物 id 含点号照常（不按点号切分 id）', () => {
    const dotted = { main: { ...cfg.main, pets: [{ id: 'a.b', name: '点号宠' }] } };
    const d = decide({ cfg: dotted, requested: 'a.b' });
    assert.equal(d.ok, true);
    assert.equal(d.ok === true && d.petId, 'a.b');
  });
});

describe('decideBroadcast —— 配图只认该桌宠条目的表情包池', () => {
  test('池内命中 → 通过，并采用池里的规范名', () => {
    const d = decide({ image: IN_POOL });
    assert.equal(d.ok, true);
    assert.equal(d.ok === true && d.image, IN_POOL);
  });

  test('名称前后空白 → trim 后仍能命中', () => {
    const d = decide({ image: `  ${IN_POOL2}  ` });
    assert.equal(d.ok, true);
    assert.equal(d.ok === true && d.image, IN_POOL2);
  });

  test('不配图：缺省 / 空串 / null → 通过且不带 image 字段', () => {
    for (const image of [undefined, '', '   ', null]) {
      const d = decide({ image });
      assert.equal(d.ok, true);
      assert.equal(d.ok === true && 'image' in d, false, '不配图时不该出现 image 字段');
    }
  });

  test('池外的名字 → unknown-image（防幻觉名称）', () => {
    const d = decide({ image: '根本没有这张图' });
    assert.equal(d.ok, false);
    assert.equal(d.ok === false && d.reason, 'unknown-image');
  });

  test('配置写了但磁盘缺文件 → 也算不在池内（与碎碎念/对话同一口径）', () => {
    const d = decide({ image: NO_FILE });
    assert.equal(d.ok, false);
    assert.equal(d.ok === false && d.reason, 'unknown-image');
  });

  test('外部 URL 不被接受（杜绝第三方注入站外地址）', () => {
    for (const image of ['https://evil.example/x.png', '//evil.example/x.png', '/etc/passwd', '../../x.png']) {
      const d = decide({ image });
      assert.equal(d.ok, false, `${image} 不得被当作配图`);
      assert.equal(d.ok === false && d.reason, 'unknown-image');
    }
  });

  test('图片池为空（未配置 memes）→ 任何配图都算不在池内', () => {
    const empty = { main: { ...cfg.main, memes: {} } };
    const d = decide({ cfg: empty, image: IN_POOL });
    assert.equal(d.ok, false);
    assert.equal(d.ok === false && d.reason, 'unknown-image');
  });

  test('配图不跨宠物串池：按所属条目的 memes 判定', () => {
    // 文件宠物条目自带 memes（不含 可爱）→ 给 test1 喂 可爱 应当失败
    const two = {
      main: { ...cfg.main, pets: [{ id: 'main', name: 'A' }] },
      pack1: { ...cfg.main, memes: { [IN_POOL2]: '预警' }, pets: [{ id: 'pack1', name: 'B' }] },
    };
    assert.equal(decide({ cfg: two, requested: 'pack1', image: IN_POOL }).ok, false);
    assert.equal(decide({ cfg: two, requested: 'pack1', image: IN_POOL2 }).ok, true);
    assert.equal(decide({ cfg: two, requested: 'main', image: IN_POOL }).ok, true);
  });

  test('目录链按条目取：种类独占目录里的图，喂给该宠物才算命中', () => {
    // pack1 自带表情包目录（独占：链里只有它），main 走共享目录
    const ownDir = join(tempRoot, 'pack1-memes');
    mkdirSync(ownDir, { recursive: true });
    writeFileSync(join(ownDir, '自家图.png'), 'x');
    const own = { 自家图: '这个种类自己带的', [IN_POOL]: '共用目录里那张同名图' };
    const two = {
      main: { ...cfg.main, pets: [{ id: 'main', name: 'A' }] },
      pack1: { ...cfg.main, memes: own, pets: [{ id: 'pack1', name: 'B' }] },
    };
    // 独占链里没有共享目录 → 只有包内目录里才有的 可爱 不算命中；自家图命中
    const dirs = (entry: string) => (entry === 'pack1' ? [ownDir] : [memesDir]);
    assert.equal(decide({ cfg: two, memeDirs: dirs, requested: 'pack1', image: IN_POOL }).ok, false);
    assert.equal(decide({ cfg: two, memeDirs: dirs, requested: 'pack1', image: '自家图' }).ok, true);
    assert.equal(decide({ cfg: two, memeDirs: dirs, requested: 'main', image: IN_POOL }).ok, true);
  });
});

describe('normalizeBroadcastDuration —— 气泡时长（issue #122 第 5 条）', () => {
  test('缺省 / null → 10s（老调用方的行为一个字不变）', () => {
    assert.equal(normalizeBroadcastDuration(undefined), 10000);
    assert.equal(normalizeBroadcastDuration(null), 10000);
  });

  test('合法值原样透出；`0` 是合法值（字面意思：不显示）；不设上限', () => {
    assert.equal(normalizeBroadcastDuration(0), 0);
    assert.equal(normalizeBroadcastDuration(1), 1);
    assert.equal(normalizeBroadcastDuration(3000), 3000);
    assert.equal(normalizeBroadcastDuration(999999999), 999999999);
  });

  test('负数 / 非有限数 / 非数字 → null（路由据此回 bad-request）', () => {
    for (const v of [-1, -0.5, NaN, Infinity, -Infinity, '3000', {}, [], true]) {
      assert.equal(normalizeBroadcastDuration(v), null, `${JSON.stringify(v)} 应判非法`);
    }
  });
});

describe('normalizeBroadcastAnim —— 动画联动开关（只有严格 false 才关闭）', () => {
  test('只有严格 false 才关闭', () => {
    assert.equal(normalizeBroadcastAnim(false), false);
  });

  test('其余一律按"要联动"：缺省、true、字符串 "false"、0、null 都算开', () => {
    for (const v of [undefined, null, true, 'false', 0, 1, {}]) {
      assert.equal(normalizeBroadcastAnim(v), true, `${JSON.stringify(v)} 应按联动处理`);
    }
  });
});

describe('decideBroadcast —— 新参数原样进入结论（写进叶子的是解析后的生效值）', () => {
  test('缺省解析成显式值：10s + 联动', () => {
    const d = decide();
    assert.equal(d.ok, true);
    assert.equal(d.ok === true && d.duration, 10000);
    assert.equal(d.ok === true && d.anim, true);
  });

  test('调用方给的值原样带出（含 duration=0 与 anim=false）', () => {
    const d = decide({ duration: 0, anim: false });
    assert.equal(d.ok, true);
    assert.equal(d.ok === true && d.duration, 0);
    assert.equal(d.ok === true && d.anim, false);
  });

  test('失败分支不带这两个字段（调用方不会误以为生效了）', () => {
    const d = decide({ text: '', duration: 0, anim: false });
    assert.equal(d.ok, false);
    assert.equal(d.ok === false && 'duration' in d, false);
  });
});

describe('decideBubbleClear —— 清空气泡（只有"清哪只宠物"会失败）', () => {
  test('指定存在的宠物 → 通过', () => {
    const d = decideBubbleClear({ cfg, requested: 'test1' });
    assert.equal(d.ok, true);
    assert.equal(d.ok === true && d.petId, 'test1');
  });

  test('pet 缺省 → pet-required（与 /broadcast 同一条口径）', () => {
    const d = decideBubbleClear({ cfg, requested: '' });
    assert.equal(d.ok, false);
    assert.equal(d.ok === false && d.reason, 'pet-required');
  });

  test('不存在的宠物 → unknown-pet（显式失败，不去写一个没人看的叶子）', () => {
    const d = decideBubbleClear({ cfg, requested: 'ghost' });
    assert.equal(d.ok, false);
    assert.equal(d.ok === false && d.reason, 'unknown-pet');
    assert.match(d.ok === false ? d.message : '', /ghost/);
  });

  test('没有"气泡不存在"这种失败：空状态下也是 ok（幂等）', () => {
    // 决策层看不到气泡当前显隐，本来就不该为它造一个失败分支
    assert.equal(decideBubbleClear({ cfg, requested: 'main' }).ok, true);
  });
});

describe('decideBroadcast —— 配图的 url 形态（第三方自带素材，issue #122 第 1 条）', () => {
  const URL_OK = 'https://cdn.example.com/拒绝换壁纸.png';

  test('给 url → 通过，且**不查表情包池**：图在第三方手里，池里当然没有', () => {
    const d = decide({ url: URL_OK });
    assert.equal(d.ok, true);
    assert.equal(d.ok === true && d.url, URL_OK);
    assert.equal(d.ok === true && d.image, undefined, 'url 形态不应同时给出 image');
  });

  test('url 前后空白 → trim 后判定', () => {
    const d = decide({ url: '  ' + URL_OK + '  ' });
    assert.equal(d.ok === true && d.url, URL_OK);
  });

  test('同源相对地址不行——必须是完整 URL', () => {
    const d = decide({ url: '/dsh-pet-wallpaper/asset/x.png' });
    assert.equal(d.ok, false);
    assert.equal(d.ok === false && d.reason, 'bad-request');
  });

  test('只放行 http / https：其余 scheme 一律 bad-request', () => {
    for (const url of ['file:///C:/secret.png', 'ftp://example.com/x.png', 'javascript:alert(1)']) {
      const d = decide({ url });
      assert.equal(d.ok, false, `${url} 不应通过`);
      assert.equal(d.ok === false && d.reason, 'bad-request');
    }
  });

  test('image 与 url 同时给 → bad-request（两种形态二选一，不替调用方猜）', () => {
    const d = decide({ image: IN_POOL, url: URL_OK });
    assert.equal(d.ok, false);
    assert.equal(d.ok === false && d.reason, 'bad-request');
  });

  test('url 形态下不产生 unknown-image（那道校验只属于名称形态）', () => {
    // 地址里带的文件名根本不在池里：名称形态必然 unknown-image，url 形态照旧通过
    const d = decide({ url: 'https://cdn.example.com/池里没有这张.png' });
    assert.equal(d.ok, true);
  });

  test('纯文本路径不受影响：image / url 都不给 → 照旧通过且不带配图字段', () => {
    const d = decide({ image: undefined, url: undefined });
    assert.equal(d.ok, true);
    assert.equal(d.ok === true && 'image' in d, false);
    assert.equal(d.ok === true && 'url' in d, false);
  });

  test('url 形态下文本与宠物校验照旧', () => {
    assert.equal(decide({ text: '', url: URL_OK }).ok, false);
    const d = decide({ url: URL_OK, requested: 'ghost' });
    assert.equal(d.ok === false && d.reason, 'unknown-pet');
  });
});
