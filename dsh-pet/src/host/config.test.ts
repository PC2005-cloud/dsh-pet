/**
 * host 配置合并单元测试 —— 钉住 animations.events 槽位「string | string[]」校验：
 * 数组槽位（档内随机候选）必须放行；空字符串 / 空数组 / 数字 / 对象等非法槽位
 * 必须整段回退内置默认（否则会导致 events 全丢）。
 *
 * 走完整的 readAllConfig 管线（内置默认 + 用户主配置合并，与生产同一路径），
 * 不单独导出校验函数。用临时目录隔离真实文件。
 *
 * 跑法：node --experimental-strip-types --test src/host/config.test.ts
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  migrateUserConfig,
  readAllConfig,
  readUserConfig,
  saveUserConfig,
  sliceMemoryRounds,
  syncUserConfigFromDefault,
  userConfigUnparsable,
  type ConfigPaths,
} from './config.ts';

/** 内置默认配置的完整最小形态（animations 整段必须合法——合并是整段替换/整段回退） */
const BASE = {
  pets: [
    {
      id: 'main',
      name: '主宠',
      size: 462,
      balanceEnabled: false,
      whisperEnabled: false,
      workStatusEnabled: false,
      fixedEnabled: false,
      display: 'web',
      position: { corner: 'bottom-right', marginX: 40, marginY: 40 },
    },
  ],
  animations: {
    idle: ['待机'],
    turn: ['转向'],
    drag: ['拖拽'],
    clicks: ['点击'],
    moves: {
      default: { minDist: 100, maxDist: 300, margin: 100, leadSec: 0.2, tailSec: 0.2 },
      actions: [{ name: '走动', params: {} }],
    },
    categories: [],
    events: {
      balance: ['余额A'],
      whisper: ['碎碎念A'],
      workStatus: ['工作A', '工作B'],
    },
  },
  animationWeights: { idle: 10, turn: 5, move: 5 },
  physics: {
    gravity: 1400,
    restitution: 0.78,
    groundFriction: 2.5,
    ceilingBounce: true,
    throwPower: 1.0,
    petCollision: false,
  },
  whisperPrompt: '你是桌面宠物',
  chatMemoryRounds: 4,
  notificationsEnabled: true,
  eventsRefreshSec: { balance: 1800, whisper: 300 },
  workStatusTexts: [['在干活']],
};

/** 与 BASE.animations 同构、仅替换 events 的用户层 animations（顶层字段整段替换，故必须完整） */
function animationsWithEvents(events: unknown): Record<string, unknown> {
  return { ...BASE.animations, events };
}

interface Suite {
  overlay: Record<string, unknown>;
  /** 期望合并后 events.workStatus 与哪个对象一致 */
  expectWorkStatus: unknown[];
}

function cases(suite: Suite): void {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-pet-config-test-'));
  try {
    const paths: ConfigPaths = {
      defaultFile: join(dir, 'default.jsonc'),
      userFile: join(dir, 'main-config.jsonc'),
      petDir: join(dir, 'pet'), // 不存在 = 无文件宠物，scanPetFiles 兜底
    };
    writeFileSync(paths.defaultFile, JSON.stringify(BASE));
    writeFileSync(paths.userFile, JSON.stringify(suite.overlay));
    const merged = readAllConfig(paths);
    const workStatus = (merged.main.animations as Record<string, unknown>).events as {
      workStatus: unknown[];
    };
    assert.deepEqual(workStatus.workStatus, suite.expectWorkStatus);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('readAllConfig —— events 槽位 string | string[] 校验', () => {
  test('字符串槽位原样放行（原行为不变）', () => {
    cases({
      overlay: { animations: animationsWithEvents({ workStatus: ['工作A', '工作B'] }) },
      expectWorkStatus: ['工作A', '工作B'],
    });
  });

  test('数组槽位放行（档内随机候选，完整向后兼容字符串）', () => {
    cases({
      overlay: {
        animations: animationsWithEvents({
          balance: BASE.animations.events.balance, // 既有规则：events.balance 必填非空数组（用户改 workStatus 会保留）
          whisper: BASE.animations.events.whisper,
          workStatus: [['工作思考', '开始工作'], '认真工作', '长时间工作看表', '工作被打扰', '工作结束', '摸鱼被抓'],
        }),
      },
      expectWorkStatus: [['工作思考', '开始工作'], '认真工作', '长时间工作看表', '工作被打扰', '工作结束', '摸鱼被抓'],
    });
  });

  test('空字符串槽位非法 → animations 整段回退默认', () => {
    cases({
      overlay: { animations: animationsWithEvents({ workStatus: ['工作A', ''] }) },
      expectWorkStatus: BASE.animations.events.workStatus,
    });
  });

  test('空数组槽位非法 → 整段回退默认', () => {
    cases({
      overlay: { animations: animationsWithEvents({ workStatus: [['工作A'], []] }) },
      expectWorkStatus: BASE.animations.events.workStatus,
    });
  });

  test('数组内空字符串成员非法 → 整段回退默认', () => {
    cases({
      overlay: { animations: animationsWithEvents({ workStatus: [['工作A', ''], '工作B'] }) },
      expectWorkStatus: BASE.animations.events.workStatus,
    });
  });

  test('数字/对象槽位非法 → 整段回退默认', () => {
    for (const bad of [42 as unknown, { name: 'x' } as unknown, null as unknown, true as unknown]) {
      cases({
        overlay: { animations: animationsWithEvents({ workStatus: [bad, '工作B'] }) },
        expectWorkStatus: BASE.animations.events.workStatus,
      });
    }
  });
});

describe('readAllConfig —— events 缺失仍回退默认（既有行为不回退）', () => {
  test('用户层完全没写 animations → 用内置默认', () => {
    cases({
      overlay: { whisperPrompt: '改个提示词' },
      expectWorkStatus: BASE.animations.events.workStatus,
    });
  });
});

/** 跑一趟 readAllConfig：base 为内置默认（可注入表情包开关），overlay 为用户层 */
function withBase(baseExtra: Record<string, unknown>, overlay?: Record<string, unknown>): ConfigPaths {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-pet-config-test-'));
  const paths: ConfigPaths = {
    defaultFile: join(dir, 'default.jsonc'),
    userFile: join(dir, 'main-config.jsonc'),
    petDir: join(dir, 'pet'),
  };
  writeFileSync(paths.defaultFile, JSON.stringify({ ...BASE, ...baseExtra }));
  if (overlay) writeFileSync(paths.userFile, JSON.stringify(overlay));
  return paths;
}

/** 跑一趟 saveUserConfig：返回写入用户层的对象（null = 被 sanitize 拒绝） */
function saveOnce(body: Record<string, unknown>, existing?: Record<string, unknown>): Record<string, unknown> | null {
  return saveUserConfig(body, existing) as Record<string, unknown> | null;
}

/** 建一套路径：默认文件 = BASE；用户层原文由调用方给（可带注释） */
function pathsWithUser(raw: string | null): { paths: ConfigPaths; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-pet-user-config-'));
  const paths: ConfigPaths = {
    defaultFile: join(dir, 'default.jsonc'),
    userFile: join(dir, 'main-config.jsonc'),
    legacyUserFile: join(dir, 'main-config.json'),
    petDir: join(dir, 'pet'),
  };
  writeFileSync(paths.defaultFile, JSON.stringify(BASE));
  if (raw !== null) writeFileSync(paths.userFile, raw);
  return { paths, dir };
}

describe('migrateUserConfig —— 老用户 main-config.json → main-config.jsonc', () => {
  /** 只在旧路径写一份用户层（模拟升级前的老用户） */
  function legacyOnly(raw: string): { paths: ConfigPaths; dir: string } {
    const { paths, dir } = pathsWithUser(null);
    writeFileSync(paths.legacyUserFile as string, raw);
    return { paths, dir };
  }

  test('旧文件存在、新文件不存在 → 重命名（内容一字不动），旧文件消失', () => {
    const raw = '// 老用户的配置\n{\n  "physics": ' + JSON.stringify(BASE.physics) + '\n}\n';
    const { paths, dir } = legacyOnly(raw);
    try {
      const logs: string[] = [];
      assert.equal(
        migrateUserConfig(paths, (m) => logs.push(m)),
        true,
      );
      assert.equal(existsSync(paths.legacyUserFile as string), false, '旧文件应已重命名走');
      assert.equal(readFileSync(paths.userFile, 'utf8'), raw, '新文件内容必须与旧文件逐字节一致');
      assert.equal(logs.length, 1, '迁移应留一条日志');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('新文件已存在 → 什么都不做（绝不用旧文件覆盖新文件）', () => {
    const { paths, dir } = pathsWithUser('{ "physics": ' + JSON.stringify(BASE.physics) + ' }\n');
    try {
      writeFileSync(paths.legacyUserFile as string, '{ "physics": { "gravity": 1 } }');
      assert.equal(migrateUserConfig(paths), false);
      assert.equal(existsSync(paths.legacyUserFile as string), true, '旧文件保持原样');
      assert.equal(readUserConfig(paths)?.physics !== undefined, true, '生效的仍是新文件');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('旧文件不存在 → 什么都不做（首次使用）', () => {
    const { paths, dir } = pathsWithUser(null);
    try {
      assert.equal(migrateUserConfig(paths), false);
      assert.equal(existsSync(paths.userFile), false, '不凭空造文件');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('未迁移（迁移失败/未跑）时读取回落旧路径：配置照样生效', () => {
    const { paths, dir } = legacyOnly('{ "physics": ' + JSON.stringify(BASE.physics) + ' }\n');
    try {
      assert.equal(readUserConfig(paths)?.physics !== undefined, true, '读回落旧 .json');
      assert.equal(userConfigUnparsable(paths), false, '旧路径合法 → 不是损坏');
      assert.deepEqual(readAllConfig(paths).main.physics, BASE.physics);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('userConfigUnparsable —— 保存前的损坏预检（损坏时必须弹窗，不许静默丢配置）', () => {
  test('真损坏（语法错误）→ true：宿主据此回 409，不写盘', () => {
    const { paths, dir } = pathsWithUser('{ "physics": { 这不是 JSON');
    try {
      assert.equal(userConfigUnparsable(paths), true);
      assert.equal(readUserConfig(paths), undefined, '前置：损坏时确实读不出既有字段（白名单重建会丢内容）');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('带注释但合法（同步写入的原文）→ false：不是损坏，正常保存', () => {
    const { paths, dir } = pathsWithUser('// 注释\n{\n  "physics": ' + JSON.stringify(BASE.physics) + '\n}\n');
    try {
      assert.equal(userConfigUnparsable(paths), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('文件不存在 → false：首次保存没有东西可丢，不打扰用户', () => {
    const { paths, dir } = pathsWithUser(null);
    try {
      assert.equal(userConfigUnparsable(paths), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('readUserConfig —— 用户层读取必须容忍 JSONC 注释（保存丢字段的回归）', () => {
  test('「同步」写入的带注释原文：readUserConfig 解析得出（严格 JSON.parse 会 undefined）', () => {
    const { paths, dir } = pathsWithUser(
      '// 顶部注释\n{\n  /* 块注释 */\n  "physics": ' + JSON.stringify(BASE.physics) + '\n}\n',
    );
    try {
      assert.throws(() => JSON.parse(readFileSync(paths.userFile, 'utf8')), '前置：严格 JSON.parse 确实读不了');
      const existing = readUserConfig(paths);
      assert.ok(existing, '带注释的用户层必须能被 readUserConfig 解析');
      assert.deepEqual(existing.physics, BASE.physics);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('带注释的用户层 + 保存：高级字段（animations/physics/memes）全部保留', () => {
    const { paths, dir } = pathsWithUser(
      '// 用户手改的配置\n{\n' +
        '  "animations": ' +
        JSON.stringify(BASE.animations) +
        ',\n  "physics": ' +
        JSON.stringify(BASE.physics) +
        ',\n  "memes": { "可爱": "我改过的描述" }\n}\n',
    );
    try {
      const out = saveUserConfig({ pets: PETS, notificationsEnabled: true }, readUserConfig(paths)) as Record<
        string,
        unknown
      >;
      assert.deepEqual(out.animations, BASE.animations, 'animations 不得在保存时丢失');
      assert.deepEqual(out.physics, BASE.physics, 'physics 不得在保存时丢失');
      assert.deepEqual(out.memes, { 可爱: '我改过的描述' }, '手写的 memes 不得在保存时丢失');
      assert.equal(out.notificationsEnabled, true, '白名单字段仍以请求体为准');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('用户层不存在 / 损坏 → undefined（按无既有字段处理，不阻塞保存）', () => {
    const missing = pathsWithUser(null);
    try {
      assert.equal(readUserConfig(missing.paths), undefined);
    } finally {
      rmSync(missing.dir, { recursive: true, force: true });
    }
    const broken = pathsWithUser('{ 这不是 JSON');
    try {
      assert.equal(readUserConfig(broken.paths), undefined);
    } finally {
      rmSync(broken.dir, { recursive: true, force: true });
    }
  });
});

const PETS = BASE.pets;

describe('saveUserConfig —— 表情包配图开关（白名单 + 透传保留）', () => {
  test('两个配图开关随请求体写入', () => {
    const out = saveOnce({ pets: PETS, whisperImageEnabled: true, chatImageEnabled: true });
    assert.equal(out?.whisperImageEnabled, true);
    assert.equal(out?.chatImageEnabled, true);
  });

  test('未传开关时不写入（不凭空造字段）', () => {
    const out = saveOnce({ pets: PETS });
    assert.equal('whisperImageEnabled' in (out ?? {}), false);
    assert.equal('chatImageEnabled' in (out ?? {}), false);
  });

  test('开关传非布尔 → 整体拒绝（宿主回 400）', () => {
    assert.equal(saveOnce({ pets: PETS, whisperImageEnabled: 'yes' }), null);
    assert.equal(saveOnce({ pets: PETS, chatImageEnabled: 1 }), null);
  });

  test('手写的 memes 映射表被透传保留（设置页保存不抹掉）', () => {
    const memes = { 可爱: '我改过的描述' };
    const out = saveOnce({ pets: PETS, whisperImageEnabled: false }, { pets: PETS, memes });
    assert.deepEqual(out?.memes, memes);
  });

  test('请求体的开关值覆盖磁盘旧值（不被 existing 反向覆盖）', () => {
    const out = saveOnce(
      { pets: PETS, whisperImageEnabled: true },
      { pets: PETS, whisperImageEnabled: false, chatImageEnabled: true },
    );
    assert.equal(out?.whisperImageEnabled, true); // 请求体优先
    assert.equal(out?.chatImageEnabled, true); // 未传的旧值仍透传保留
  });
});

describe('readAllConfig —— 表情包开关合并（缺失取默认 / 非法回退默认）', () => {
  test('内置默认有值 → 用户层没写时读得到', () => {
    const merged = readAllConfig(withBase({ whisperImageEnabled: true, chatImageEnabled: false }));
    assert.equal(merged.main.whisperImageEnabled, true);
    assert.equal(merged.main.chatImageEnabled, false);
  });

  test('用户层写了非法值 → 回退内置默认', () => {
    const merged = readAllConfig(
      withBase({ whisperImageEnabled: true, chatImageEnabled: false }, { whisperImageEnabled: 'yes' }),
    );
    assert.equal(merged.main.whisperImageEnabled, true); // 回退默认 true
  });
});

describe('saveUserConfig —— 抛掷锁定开关（白名单 + 透传保留）', () => {
  test('随请求体写入', () => {
    const out = saveOnce({ pets: PETS, confineToScreen: true });
    assert.equal(out?.confineToScreen, true);
  });

  test('未传时不写入（不凭空造字段）', () => {
    const out = saveOnce({ pets: PETS });
    assert.equal('confineToScreen' in (out ?? {}), false);
  });

  test('传非布尔 → 整体拒绝（宿主回 400）', () => {
    assert.equal(saveOnce({ pets: PETS, confineToScreen: 'yes' }), null);
  });

  test('请求体的值覆盖磁盘旧值；未传时透传磁盘旧值', () => {
    const overwritten = saveOnce({ pets: PETS, confineToScreen: true }, { pets: PETS, confineToScreen: false });
    assert.equal(overwritten?.confineToScreen, true); // 请求体优先
    const kept = saveOnce({ pets: PETS }, { pets: PETS, confineToScreen: true });
    assert.equal(kept?.confineToScreen, true); // 未传的旧值仍透传保留
  });
});

describe('saveUserConfig —— 宠物固定 fixedEnabled（per-pet 白名单）', () => {
  /** 取落盘后的第 n 只宠物 */
  const petAt = (out: Record<string, unknown> | null, n = 0): Record<string, unknown> =>
    (out?.pets as Record<string, unknown>[])[n];

  test('随请求体逐宠物写入（不在白名单就会被保存悄悄丢掉——physics 的老 bug 同款）', () => {
    const out = saveOnce({ pets: [{ ...PETS[0], fixedEnabled: true }] });
    assert.equal(petAt(out).fixedEnabled, true, 'fixedEnabled 必须在 saveUserConfig 的白名单里');
  });

  test('未传时落盘即缺失（读取侧取内置默认，不凭空造值）', () => {
    // 显式构造一只「没写 fixedEnabled」的宠物：落盘对象里该键为 undefined（JSON.stringify 丢弃），
    // 合并读取时再由内置默认补上——设置页不传它时不得凭空写一个 false 进去
    const bare: Record<string, unknown> = { ...PETS[0] };
    delete bare.fixedEnabled;
    assert.equal(petAt(saveOnce({ pets: [bare] })).fixedEnabled, undefined);
  });

  test('传非布尔 → 整体拒绝（宿主回 400）', () => {
    assert.equal(saveOnce({ pets: [{ ...PETS[0], fixedEnabled: 'yes' }] }), null);
  });

  test('逐实例独立：一只 true 一只 false 都按各自的值落盘', () => {
    const out = saveOnce({
      pets: [
        { ...PETS[0], id: 'a', fixedEnabled: true },
        { ...PETS[0], id: 'b', fixedEnabled: false },
      ],
    });
    const pets = out?.pets as Record<string, unknown>[];
    assert.equal(pets.find((p) => p.id === 'a')?.fixedEnabled, true);
    assert.equal(pets.find((p) => p.id === 'b')?.fixedEnabled, false);
  });
});

describe('saveUserConfig —— 物理参数 physics（白名单 + 透传保留）', () => {
  const PHYS: Record<string, unknown> = BASE.physics;

  test('整段随请求体写入（设置页「物理」区）', () => {
    const out = saveOnce({ pets: PETS, physics: PHYS });
    assert.deepEqual(out?.physics, PHYS, 'physics 必须按请求体整段写入');
  });

  test('未传时透传磁盘旧值；磁盘上也没有则不凭空造字段', () => {
    const kept = saveOnce({ pets: PETS }, { pets: PETS, physics: { ...PHYS, gravity: 2000 } });
    assert.deepEqual(kept?.physics, { ...PHYS, gravity: 2000 }, '未传 physics 时必须原样保留磁盘上的手改值');
    assert.equal('physics' in (saveOnce({ pets: PETS }) ?? {}), false, '磁盘上也没有时不得凭空写入');
  });

  test('请求体覆盖磁盘旧值（与四个全局开关同一语义）', () => {
    const out = saveOnce({ pets: PETS, physics: { ...PHYS, throwPower: 2 } }, { pets: PETS, physics: PHYS });
    assert.equal((out?.physics as Record<string, unknown>).throwPower, 2);
  });

  test('非法值 → 整体拒绝（宿主回 400；与读取侧 physicsValid 同一套规则）', () => {
    const bad: Array<[string, unknown]> = [
      ['restitution > 1', { ...PHYS, restitution: 1.5 }],
      ['restitution < 0', { ...PHYS, restitution: -0.1 }],
      ['gravity 负数', { ...PHYS, gravity: -1 }],
      ['groundFriction 负数', { ...PHYS, groundFriction: -1 }],
      ['throwPower = 0', { ...PHYS, throwPower: 0 }],
      ['gravity 非数字', { ...PHYS, gravity: 'fast' }],
      [
        '缺 ceilingBounce',
        { gravity: 1400, restitution: 0.78, groundFriction: 2.5, throwPower: 1, petCollision: false },
      ],
      ['ceilingBounce 非布尔', { ...PHYS, ceilingBounce: 1 }],
      ['physics 非对象', 'yes'],
    ];
    for (const [name, value] of bad) {
      assert.equal(saveOnce({ pets: PETS, physics: value }), null, `${name} 必须被拒绝`);
    }
  });
});

describe('saveUserConfig —— 碎碎念 / 对话模型（白名单 + 透传保留）', () => {
  const WM = { provider: 'deepseek', model: 'deepseek-chat' };
  const CM = { provider: 'opencode', model: 'big-model' };

  test('整段随请求体写入（设置页「AI 模型」两个下拉框）', () => {
    const out = saveOnce({ pets: PETS, whisperModel: WM, chatModel: CM });
    assert.deepEqual(out?.whisperModel, WM, 'whisperModel 必须按请求体写入');
    assert.deepEqual(out?.chatModel, CM, 'chatModel 必须按请求体写入');
  });

  test('留空（跟随当前对话）也是合法值，照常落盘', () => {
    const empty = { provider: '', model: '' };
    const out = saveOnce({ pets: PETS, whisperModel: empty, chatModel: empty });
    assert.deepEqual(out?.whisperModel, empty);
    assert.deepEqual(out?.chatModel, empty);
  });

  test('未传时透传磁盘旧值；磁盘上也没有则不凭空造字段', () => {
    const kept = saveOnce({ pets: PETS }, { pets: PETS, whisperModel: WM, chatModel: CM });
    assert.deepEqual(kept?.whisperModel, WM, '未传时必须原样保留磁盘上的手改值');
    assert.deepEqual(kept?.chatModel, CM);
    const fresh = saveOnce({ pets: PETS }) ?? {};
    assert.equal('whisperModel' in fresh, false, '磁盘上也没有时不得凭空写入');
    assert.equal('chatModel' in fresh, false);
  });

  test('请求体覆盖磁盘旧值（与四个全局开关同一语义）', () => {
    const out = saveOnce({ pets: PETS, whisperModel: WM }, { pets: PETS, whisperModel: CM });
    assert.deepEqual(out?.whisperModel, WM);
  });

  test('落盘时归一化：两侧空白 trim，请求体多带的键不写进用户层', () => {
    const out = saveOnce({
      pets: PETS,
      whisperModel: { provider: ' deepseek ', model: ' deepseek-chat ', reasoningEffort: 'high' },
    });
    assert.deepEqual(out?.whisperModel, WM, '只保留 provider/model 两个 trim 过的字符串');
  });

  test('非法值 → 整体拒绝（宿主回 400；与读取侧 modelSelectionValid 同一套规则）', () => {
    const bad: Array<[string, unknown]> = [
      ['只填服务商', { provider: 'deepseek', model: '' }],
      ['只填模型', { provider: '', model: 'deepseek-chat' }],
      ['缺 model 字段', { provider: 'deepseek' }],
      ['provider 非字符串', { provider: 1, model: 'deepseek-chat' }],
      ['model 非字符串', { provider: 'deepseek', model: null }],
      ['字符串', 'deepseek/deepseek-chat'],
      ['数组', ['deepseek', 'deepseek-chat']],
      ['null', null],
    ];
    for (const [name, value] of bad) {
      assert.equal(saveOnce({ pets: PETS, whisperModel: value }), null, `whisperModel ${name} 必须被拒绝`);
      assert.equal(saveOnce({ pets: PETS, chatModel: value }), null, `chatModel ${name} 必须被拒绝`);
    }
  });
});

describe('saveUserConfig —— 对话历史条数 chatMemoryRounds（白名单 + 透传保留）', () => {
  test('随请求体写入（设置页「AI 模型与对话上下文」的数字输入框）', () => {
    const out = saveOnce({ pets: PETS, chatMemoryRounds: 9 });
    assert.equal(out?.chatMemoryRounds, 9, 'chatMemoryRounds 必须在 saveUserConfig 的白名单里');
  });

  test('0 是合法值（= 不带历史进上下文），照常落盘', () => {
    assert.equal(saveOnce({ pets: PETS, chatMemoryRounds: 0 })?.chatMemoryRounds, 0);
  });

  test('落盘时归一化成数字（"9" → 9，与读取侧 topFieldValid 同一口径）', () => {
    assert.equal(saveOnce({ pets: PETS, chatMemoryRounds: '9' })?.chatMemoryRounds, 9);
  });

  test('未传时透传磁盘旧值；磁盘上也没有则不凭空造字段', () => {
    const kept = saveOnce({ pets: PETS }, { pets: PETS, chatMemoryRounds: 3 });
    assert.equal(kept?.chatMemoryRounds, 3, '未传时必须原样保留磁盘上的手改值');
    assert.equal('chatMemoryRounds' in (saveOnce({ pets: PETS }) ?? {}), false, '磁盘上也没有时不得凭空写入');
  });

  test('请求体覆盖磁盘旧值（与四个全局开关同一语义）', () => {
    const out = saveOnce({ pets: PETS, chatMemoryRounds: 9 }, { pets: PETS, chatMemoryRounds: 3 });
    assert.equal(out?.chatMemoryRounds, 9, '请求体优先，不被 existing 反向覆盖');
  });

  test('非法值 → 整体拒绝（宿主回 400；与读取侧 topFieldValid 同一套规则）', () => {
    const bad: Array<[string, unknown]> = [
      ['负数', -1],
      ['非数字字符串', 'many'],
      ['对象', { rounds: 5 }],
      ['Infinity', Infinity],
      ['NaN', NaN],
    ];
    for (const [name, value] of bad) {
      assert.equal(saveOnce({ pets: PETS, chatMemoryRounds: value }), null, `${name} 必须被拒绝`);
    }
  });
});

describe('saveUserConfig —— 对话配图张数上限 chatImageLimit（白名单 + 透传保留）', () => {
  test('随请求体写入（设置页「AI 模型与对话上下文」的数字输入框）', () => {
    const out = saveOnce({ pets: PETS, chatImageLimit: 8 });
    assert.equal(out?.chatImageLimit, 8, 'chatImageLimit 必须在 saveUserConfig 的白名单里');
  });

  test('0 是合法值（= 不限制，全部发给模型），照常落盘', () => {
    assert.equal(saveOnce({ pets: PETS, chatImageLimit: 0 })?.chatImageLimit, 0);
  });

  test('落盘时归一化成数字（"8" → 8，与读取侧 topFieldValid 同一口径）', () => {
    assert.equal(saveOnce({ pets: PETS, chatImageLimit: '8' })?.chatImageLimit, 8);
  });

  test('未传时透传磁盘旧值；磁盘上也没有则不凭空造字段', () => {
    const kept = saveOnce({ pets: PETS }, { pets: PETS, chatImageLimit: 3 });
    assert.equal(kept?.chatImageLimit, 3, '未传时必须原样保留磁盘上的手改值');
    assert.equal('chatImageLimit' in (saveOnce({ pets: PETS }) ?? {}), false, '磁盘上也没有时不得凭空写入');
  });

  test('请求体覆盖磁盘旧值（与四个全局开关同一语义）', () => {
    const out = saveOnce({ pets: PETS, chatImageLimit: 8 }, { pets: PETS, chatImageLimit: 3 });
    assert.equal(out?.chatImageLimit, 8, '请求体优先，不被 existing 反向覆盖');
  });

  test('非法值 → 整体拒绝（宿主回 400；与读取侧 topFieldValid 同一套规则）', () => {
    const bad: Array<[string, unknown]> = [
      ['负数', -1],
      ['非数字字符串', 'many'],
      ['对象', { n: 3 }],
      ['Infinity', Infinity],
      ['NaN', NaN],
    ];
    for (const [name, value] of bad) {
      assert.equal(saveOnce({ pets: PETS, chatImageLimit: value }), null, `${name} 必须被拒绝`);
    }
  });
});

describe('readAllConfig —— 模型选择合并（缺失取默认 / 非法回退默认）', () => {
  const WM = { provider: 'deepseek', model: 'deepseek-chat' };

  test('内置默认有值 → 用户层没写时读得到（默认 = 都空 = 跟随当前对话）', () => {
    const merged = readAllConfig(withBase({ whisperModel: WM, chatModel: WM }));
    assert.deepEqual(merged.main.whisperModel, WM);
    assert.deepEqual(merged.main.chatModel, WM);
  });

  test('用户层写了 → 覆盖内置默认', () => {
    const merged = readAllConfig(
      withBase({ whisperModel: WM }, { whisperModel: { provider: 'opencode', model: 'big-model' } }),
    );
    assert.deepEqual(merged.main.whisperModel, { provider: 'opencode', model: 'big-model' });
  });

  test('用户层写了非法值 → 回退内置默认（只填一半 / 非字符串 / 非对象）', () => {
    const bad: unknown[] = [
      { provider: 'deepseek', model: '' },
      { provider: '', model: 'deepseek-chat' },
      { provider: 1, model: 'deepseek-chat' },
      'deepseek/deepseek-chat',
      ['deepseek', 'deepseek-chat'],
    ];
    for (const value of bad) {
      const merged = readAllConfig(withBase({ whisperModel: WM }, { whisperModel: value }));
      assert.deepEqual(merged.main.whisperModel, WM, `${JSON.stringify(value)} 应回退内置默认`);
    }
  });
});

describe('readAllConfig —— 抛掷锁定合并（缺失取默认 / 非法回退默认）', () => {
  test('内置默认有值 → 用户层没写时读得到', () => {
    const merged = readAllConfig(withBase({ confineToScreen: false }));
    assert.equal(merged.main.confineToScreen, false);
  });

  test('用户层写了 true → 覆盖内置默认', () => {
    const merged = readAllConfig(withBase({ confineToScreen: false }, { confineToScreen: true }));
    assert.equal(merged.main.confineToScreen, true);
  });

  test('用户层写了非法值 → 回退内置默认', () => {
    const merged = readAllConfig(withBase({ confineToScreen: true }, { confineToScreen: 'yes' }));
    assert.equal(merged.main.confineToScreen, true); // 回退默认 true
  });
});

describe('readAllConfig —— 宠物固定合并（缺失取默认 / 非法回退默认 / 逐实例独立）', () => {
  /** 取合并后第 n 只宠物 */
  const petAt = (merged: Record<string, Record<string, unknown>>, n = 0): Record<string, unknown> =>
    (merged.main.pets as Record<string, unknown>[])[n];

  test('内置默认有值 → 用户层没写时读得到（默认 false = 保持原行为）', () => {
    assert.equal(petAt(readAllConfig(withBase({}))).fixedEnabled, false);
  });

  test('用户层写了 true → 覆盖内置默认', () => {
    const merged = readAllConfig(withBase({}, { pets: [{ ...BASE.pets[0], fixedEnabled: true }] }));
    assert.equal(petAt(merged).fixedEnabled, true);
  });

  test('用户层写了非法值 → 回退内置默认（告警 + 默认，不让脏值进渲染层）', () => {
    const merged = readAllConfig(withBase({}, { pets: [{ ...BASE.pets[0], fixedEnabled: 'yes' }] }));
    assert.equal(petAt(merged).fixedEnabled, false);
  });

  test('逐实例独立：同一列表里两只宠物各取各的值（不是条目级、不共享）', () => {
    const merged = readAllConfig(
      withBase(
        {},
        {
          pets: [
            { ...BASE.pets[0], id: 'a', fixedEnabled: true },
            { ...BASE.pets[0], id: 'b', fixedEnabled: false },
          ],
        },
      ),
    );
    const pets = merged.main.pets as Record<string, unknown>[];
    assert.equal(pets.find((p) => p.id === 'a')?.fixedEnabled, true);
    assert.equal(pets.find((p) => p.id === 'b')?.fixedEnabled, false);
  });
});

describe('syncUserConfigFromDefault —— 同步（内置默认原文写入用户层）', () => {
  /** 默认文件写入给定原文；用户文件故意放在**尚不存在**的子目录里（验证父目录自建） */
  function fixture(raw: string): { paths: ConfigPaths; dir: string } {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-pet-sync-test-'));
    const paths: ConfigPaths = {
      defaultFile: join(dir, 'default.jsonc'),
      userFile: join(dir, 'dsh-pet', 'main-config.jsonc'),
      petDir: join(dir, 'pet'),
    };
    writeFileSync(paths.defaultFile, raw);
    return { paths, dir };
  }

  test('逐字节复制默认文件原文（注释一并保留）', () => {
    const raw = '// 顶部注释\n{\n  "pets": []\n}\n';
    const { paths, dir } = fixture(raw);
    try {
      syncUserConfigFromDefault(paths);
      assert.equal(readFileSync(paths.userFile, 'utf8'), raw, '用户层必须是默认文件的原文（含注释）');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('用户目录不存在 → 自动创建（首次同步即可落盘）', () => {
    const { paths, dir } = fixture(JSON.stringify(BASE, null, 2));
    try {
      assert.equal(existsSync(dirname(paths.userFile)), false, '前置：用户目录本不存在');
      syncUserConfigFromDefault(paths);
      assert.equal(existsSync(paths.userFile), true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('同步后的成品 = 没有用户层（与「删除用户配置」等价）', () => {
    const { paths, dir } = fixture(JSON.stringify(BASE, null, 2));
    try {
      const before = readAllConfig(paths); // 无用户层：纯内置默认
      syncUserConfigFromDefault(paths);
      // deepStrictEqual：值/结构必须完全一致。**不看键顺序**——用户层会走 mergePets 重建实例，
      // 键序被规范化为 id 在前（纯外观差异；已用生产 assets/config.jsonc 实测确认值完全一致）。
      assert.deepStrictEqual(readAllConfig(paths), before);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('默认文件缺失 → 抛错，且不得留下半个用户层文件（宿主回 500）', () => {
    const { paths, dir } = fixture('{}');
    try {
      rmSync(paths.defaultFile, { force: true });
      assert.throws(() => syncUserConfigFromDefault(paths));
      assert.equal(existsSync(paths.userFile), false, '失败时不得写出用户层文件');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/**
 * 文件宠物条目的基座 —— 「全局默认 + 种类可覆盖」。
 *
 * 判据：GLOBAL_DEFAULT_KEYS 那 9 个（physics / confineToScreen / 两个配图开关 / chatImageLimit /
 * chatMemoryRounds / whisperModel / chatModel / eventsRefreshSec）是**用户级「成本 / 偏好 /
 * 环境 / 节奏」参数**，用户层写了就对**所有条目**生效（含 pet pack）；种类文件自己写了就覆盖
 * 自己那份。其余顶层字段（人设 / 表情包 / 动画池 / 文案）的基座仍是**内置默认**——
 * 一个种类一份人设、一份池、一个表情包目录，各写一份才是 pet pack 的意义。
 */
describe('文件宠物条目 —— 全局默认（用户层作基座）+ 种类可覆盖', () => {
  /** 内置默认必须含全部顶层键：mergeEntry 只遍历 base 的键，缺键则用户层的值也流不进来 */
  const BASE_FULL: Record<string, unknown> = {
    ...BASE,
    whisperImageEnabled: true,
    chatImageEnabled: true,
    chatImageLimit: 0,
    confineToScreen: false,
    whisperModel: { provider: '', model: '' },
    chatModel: { provider: '', model: '' },
    memes: { 可爱: '卖萌' },
  };
  /** 一个最小可用的种类文件（不含任何顶层条目级字段，全靠基座） */
  const PACK: Record<string, unknown> = {
    pets: [
      {
        id: 'pig1',
        name: '小猪',
        size: 300,
        balanceEnabled: false,
        display: 'web',
        position: { corner: 'top-left', marginX: 10, marginY: 10 },
      },
    ],
  };

  const rec = (v: unknown): Record<string, unknown> => v as Record<string, unknown>;

  /** 建一套路径：内置默认 = BASE_FULL；可选用户层 + 一个种类文件；跑完 readAllConfig 就清理临时目录 */
  function merged(opts: {
    overlay?: Record<string, unknown>;
    pack?: Record<string, unknown>;
  }): Record<string, Record<string, unknown>> {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-pet-pack-base-'));
    try {
      const petDir = join(dir, 'pet');
      const paths: ConfigPaths = {
        defaultFile: join(dir, 'default.jsonc'),
        userFile: join(dir, 'main-config.jsonc'),
        petDir,
      };
      writeFileSync(paths.defaultFile, JSON.stringify(BASE_FULL));
      if (opts.overlay) writeFileSync(paths.userFile, JSON.stringify(opts.overlay));
      if (opts.pack) {
        mkdirSync(petDir, { recursive: true });
        writeFileSync(join(petDir, 'pig-config.json'), JSON.stringify(opts.pack));
      }
      return readAllConfig(paths);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  test('用户层写了这 9 个字段 → 种类条目逐个继承（不再只吃内置默认）', () => {
    const out = merged({
      overlay: {
        physics: { ...(BASE_FULL.physics as Record<string, unknown>), petCollision: true, gravity: 999 },
        confineToScreen: true,
        whisperImageEnabled: false,
        chatImageEnabled: false,
        chatImageLimit: 4,
        chatMemoryRounds: 9,
        whisperModel: { provider: 'p1', model: 'm1' },
        chatModel: { provider: 'p2', model: 'm2' },
        eventsRefreshSec: { balance: 900, whisper: 60 },
      },
      pack: PACK,
    });
    const pig = out.pig;
    assert.equal(rec(pig.physics).petCollision, true, 'physics 应继承用户层');
    assert.equal(rec(pig.physics).gravity, 999);
    assert.equal(pig.confineToScreen, true);
    assert.equal(pig.whisperImageEnabled, false);
    assert.equal(pig.chatImageEnabled, false);
    assert.equal(pig.chatImageLimit, 4, 'chatImageLimit 应继承用户层');
    assert.equal(pig.chatMemoryRounds, 9);
    assert.deepEqual(pig.whisperModel, { provider: 'p1', model: 'm1' });
    assert.deepEqual(pig.chatModel, { provider: 'p2', model: 'm2' });
    assert.deepEqual(pig.eventsRefreshSec, { balance: 900, whisper: 60 });
    // 对照：main 条目一直就是用户层（行为不变）
    assert.equal(rec(out.main.physics).gravity, 999);
    assert.equal(out.main.chatMemoryRounds, 9);
  });

  test('种类文件自己写了 → 覆盖自己那份；没写的仍继承用户层', () => {
    const out = merged({
      overlay: {
        physics: { ...(BASE_FULL.physics as Record<string, unknown>), gravity: 999 },
        confineToScreen: true,
        chatMemoryRounds: 9,
        whisperImageEnabled: false,
      },
      pack: {
        ...PACK,
        physics: { ...(BASE_FULL.physics as Record<string, unknown>), gravity: 111 },
        chatMemoryRounds: 2,
        chatImageLimit: 6,
        whisperImageEnabled: true,
      },
    });
    const pig = out.pig;
    assert.equal(rec(pig.physics).gravity, 111, '种类自己写了 physics → 用自己那份');
    assert.equal(pig.chatMemoryRounds, 2, '种类自己写了 chatMemoryRounds → 用自己那份');
    assert.equal(pig.chatImageLimit, 6, '种类自己写了 chatImageLimit → 用自己那份');
    assert.equal(pig.whisperImageEnabled, true, '种类自己写了开关 → 用自己那份');
    assert.equal(pig.confineToScreen, true, '种类没写 → 仍继承用户层');
    assert.deepEqual(pig.chatModel, { provider: '', model: '' }, '种类没写 → 继承用户层（这里与默认同值）');
  });

  test('不在白名单的字段：基座仍是内置默认（不继承用户层）', () => {
    const out = merged({
      overlay: {
        whisperPrompt: '用户层的人设',
        chatMemoryRounds: 9,
        memes: { 用户图: '用户层的表情包' },
        workStatusTexts: [['用户层的文案']],
      },
      pack: PACK,
    });
    const pig = out.pig;
    assert.equal(pig.whisperPrompt, BASE.whisperPrompt, '人设：种类用内置默认，不吃用户层');
    assert.deepEqual(pig.memes, BASE_FULL.memes, '表情包：种类用内置默认');
    assert.deepEqual(pig.workStatusTexts, BASE.workStatusTexts, '文案：种类用内置默认');
    // 对照：main 拿到的是用户层那份
    assert.equal(out.main.whisperPrompt, '用户层的人设');
    assert.deepEqual(out.main.memes, { 用户图: '用户层的表情包' });
    // 同一个用户层里，白名单字段照样继承
    assert.equal(pig.chatMemoryRounds, 9);
  });

  test('没有用户层 → 种类就是内置默认（等价于改动前的行为）', () => {
    const out = merged({ pack: PACK });
    const pig = out.pig;
    assert.deepEqual(pig.physics, BASE_FULL.physics);
    assert.equal(pig.confineToScreen, BASE_FULL.confineToScreen);
    assert.equal(pig.whisperImageEnabled, BASE_FULL.whisperImageEnabled);
    assert.deepEqual(pig.chatModel, BASE_FULL.chatModel);
  });

  test('用户层写了非法值 → 跳过该字段，种类仍拿内置默认（不抛错）', () => {
    const out = merged({ overlay: { physics: { gravity: -1 }, confineToScreen: true }, pack: PACK });
    const pig = out.pig;
    assert.deepEqual(pig.physics, BASE_FULL.physics, '非法 physics 不得流进种类基座');
    assert.equal(pig.confineToScreen, true, '同一用户层里的合法字段照常继承');
  });

  test('种类文件写了非法值 → 回退到「用户层那份」而不是内置默认', () => {
    const out = merged({
      overlay: { physics: { ...(BASE_FULL.physics as Record<string, unknown>), petCollision: true } },
      pack: { ...PACK, physics: { gravity: '不是数字' } },
    });
    assert.equal(rec(out.pig.physics).petCollision, true, '非法覆盖 → 回退基座（= 用户层），不是内置默认');
  });

  test('eventsRefreshSec 也进全局默认：用户层写了 → 种类整段继承', () => {
    const out = merged({ overlay: { eventsRefreshSec: { balance: 900, whisper: 60 } }, pack: PACK });
    assert.deepEqual(out.pig.eventsRefreshSec, { balance: 900, whisper: 60 });
    assert.deepEqual(out.main.eventsRefreshSec, { balance: 900, whisper: 60 });
  });

  test('eventsRefreshSec 是整段替换：种类写了自己的，就不再逐键合并基座', () => {
    const out = merged({
      overlay: { eventsRefreshSec: { balance: 900, whisper: 60 } },
      pack: { ...PACK, eventsRefreshSec: { balance: 111 } },
    });
    // 旧的逐键深合并会把基座的 whisper: 60 补回来；整段替换下缺的键就是缺
    assert.deepEqual(out.pig.eventsRefreshSec, { balance: 111 });
  });

  test('eventsRefreshSec 只写一半 → 缺的键不补（消费端各自兜底 1800 / 300）', () => {
    const out = merged({ overlay: { eventsRefreshSec: { whisper: 60 } }, pack: PACK });
    assert.deepEqual(out.pig.eventsRefreshSec, { whisper: 60 });
    assert.equal('balance' in rec(out.pig.eventsRefreshSec), false, '不再自动补 balance');
    assert.deepEqual(out.main.eventsRefreshSec, { whisper: 60 });
  });

  test('eventsRefreshSec 里不认识的键不再被静默丢弃', () => {
    const out = merged({ overlay: { eventsRefreshSec: { balance: 900, foo: 10 } }, pack: PACK });
    assert.deepEqual(out.pig.eventsRefreshSec, { balance: 900, foo: 10 });
  });

  test('eventsRefreshSec 整段非法 → 告警 + 回退基座（种类回到内置默认）', () => {
    for (const bad of [{ whisper: -1 }, { whisper: 'x' }, 'not-an-object', [1, 2]] as unknown[]) {
      const out = merged({ overlay: { eventsRefreshSec: bad }, pack: PACK });
      assert.deepEqual(out.pig.eventsRefreshSec, BASE.eventsRefreshSec, JSON.stringify(bad));
      assert.deepEqual(out.main.eventsRefreshSec, BASE.eventsRefreshSec, JSON.stringify(bad));
    }
  });
});

describe('sliceMemoryRounds —— chatMemoryRounds=0 必须真正不带历史（防 -0 陷阱回归）', () => {
  // 4 条消息 = 2 轮（1 轮 = 1 问 1 答）
  const msgs = ['u1', 'a1', 'u2', 'a2'];

  test('rounds=0 → 空列表（曾因 slice(-0) 返回整个数组而带上全部历史）', () => {
    assert.deepEqual(sliceMemoryRounds(msgs, 0), []);
  });

  test('rounds>0 → 截尾部 rounds 轮', () => {
    assert.deepEqual(sliceMemoryRounds(msgs, 1), ['u2', 'a2']);
    assert.deepEqual(sliceMemoryRounds(msgs, 2), msgs);
  });

  test('rounds 超过消息数 → 全量（不多不少）', () => {
    assert.deepEqual(sliceMemoryRounds(msgs, 99), msgs);
  });

  test('负数 / NaN 兜底按 0 → 空列表（不产出荒谬的 slice 行为）', () => {
    assert.deepEqual(sliceMemoryRounds(msgs, -1), []);
    assert.deepEqual(sliceMemoryRounds(msgs, Number.NaN), []);
  });

  test('rounds 为小数 → 先向下取整再截（与 memoryRounds 的 Math.floor 一致）', () => {
    assert.deepEqual(sliceMemoryRounds(msgs, 1.9), ['u2', 'a2']);
  });

  test('rounds=0 且消息列表原本为空 → 空', () => {
    assert.deepEqual(sliceMemoryRounds([], 0), []);
  });
});
