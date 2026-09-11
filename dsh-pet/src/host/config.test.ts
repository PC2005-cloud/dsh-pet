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
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { readAllConfig, type ConfigPaths } from './config.ts';

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
      userFile: join(dir, 'main-config.json'),
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
          workStatus: [
            ['工作思考', '开始工作'],
            '认真工作',
            '长时间工作看表',
            '工作被打扰',
            '工作结束',
            '摸鱼被抓',
          ],
        }),
      },
      expectWorkStatus: [
        ['工作思考', '开始工作'],
        '认真工作',
        '长时间工作看表',
        '工作被打扰',
        '工作结束',
        '摸鱼被抓',
      ],
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