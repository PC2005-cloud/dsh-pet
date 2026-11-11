/**
 * 统一日志落盘的行为测试（src/host/log-file.ts）。
 *
 * 钉住五件容易写错的事：
 *   ① 缓冲语义：没到阈值/间隔就不碰盘（否则「每秒一次写」的承诺就是假的）；
 *   ② 批量落盘：达到阈值后一次写完，行里有时间戳与级别；
 *   ③ 单文件截断：超过 maxBytes 只保留尾部 keepBytes，且保留的是最新内容；
 *   ④ 脱敏：令牌形态不得原样进文件；
 *   ⑤ 进程退出：批次已出缓冲、尚未提交时退出，日志既不丢也不重复（子进程验证）。
 *
 * 全部用真实临时目录 + 真实 fs（不 mock）：本模块的价值就在文件行为，mock 掉就没意义了。
 */
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { createFileLogger, formatLogLine, redactSensitive, tailForTrim } from './log-file.ts';

const LOGGER_URL = new URL('./log-file.ts', import.meta.url).href;

let dir = '';

before(() => {
  dir = mkdtempSync(join(tmpdir(), 'dsh-pet-log-'));
});

after(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('纯函数', () => {
  test('formatLogLine：本地时间+偏移 + 级别 + 正文 + 换行', () => {
    const now = new Date('2026-10-23T11:52:25.123Z');
    const line = formatLogLine('warn', '出事了', now);
    assert.match(line, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}[+-]\d{2}:\d{2} \[warn\] 出事了\n$/);
    // 同一时刻往返：偏移方向写错会在这里露馅（按本地时间+偏移解析回来必须与 now 逐毫秒相等）
    assert.equal(new Date(line.slice(0, 29)).getTime(), now.getTime());
  });

  test('redactSensitive：令牌、站点 URL 片段一律打码', () => {
    assert.equal(redactSensitive('x-dsh-pet-token: abcdefghijklmnopqrstuvwx'), 'x-dsh-pet-token: ***');
    assert.equal(redactSensitive('打开 http://x/#token=abcdefghijklmnopqrstuvwx'), '打开 http://x/#token=***');
    assert.equal(redactSensitive('DSH_PET_SITE_URL=http://127.0.0.1:1/?t=2'), 'DSH_PET_SITE_URL=***');
    // 普通文本不动
    assert.equal(redactSensitive('helper exited with code 3'), 'helper exited with code 3');
  });

  test('tailForTrim：未超限原样返回，超限只留尾部', () => {
    const small = Buffer.from('abc');
    assert.equal(tailForTrim(small, 10).toString(), 'abc');
    const big = Buffer.from('0123456789');
    assert.equal(tailForTrim(big, 3).toString(), '789');
  });
});

describe('createFileLogger', () => {
  test('未达阈值且未到间隔时不落盘', async () => {
    const file = join(dir, 'lazy.log');
    const logger = createFileLogger({ file, flushThreshold: 10, flushIntervalMs: 60_000 });
    try {
      logger.info('one');
      logger.info('two');
      await new Promise((resolve) => setTimeout(resolve, 30));
      assert.equal(existsSync(file), false, '没到阈值就不许碰盘');
    } finally {
      logger.dispose();
    }
  });

  test('达到阈值后批量落盘，行内带级别', async () => {
    const file = join(dir, 'batch.log');
    const logger = createFileLogger({ file, flushThreshold: 2, flushIntervalMs: 60_000 });
    try {
      logger.info('first');
      logger.error('second');
      await logger.flush();
      const text = readFileSync(file, 'utf8');
      assert.match(text, /\[info\] first/);
      assert.match(text, /\[error\] second/);
      assert.equal(text.trim().split('\n').length, 2);
    } finally {
      logger.dispose();
    }
  });

  test('超过大小上限只保留尾部（最新的部分）', async () => {
    const file = join(dir, 'trim.log');
    const logger = createFileLogger({
      file,
      flushThreshold: 1,
      flushIntervalMs: 60_000,
      maxBytes: 400,
      keepBytes: 150,
    });
    try {
      for (let i = 0; i < 40; i += 1) logger.info(`line-${String(i).padStart(3, '0')}-padding-padding`);
      await logger.flush();
      const text = readFileSync(file, 'utf8');
      assert.ok(text.length <= 400, `文件应被截断到上限内，实际 ${text.length}`);
      assert.ok(text.includes('line-039'), '截断必须保留最新内容');
    } finally {
      logger.dispose();
    }
  });

  test('debug 默认不落盘，打开后才写', async () => {
    const off = join(dir, 'debug-off.log');
    const offLogger = createFileLogger({ file: off, flushThreshold: 1, flushIntervalMs: 60_000 });
    offLogger.debug('hidden');
    await offLogger.flush();
    offLogger.dispose();
    assert.equal(existsSync(off), false, 'debug 默认不该产生文件');

    const on = join(dir, 'debug-on.log');
    const onLogger = createFileLogger({
      file: on,
      flushThreshold: 1,
      flushIntervalMs: 60_000,
      debugEnabled: true,
    });
    onLogger.debug('shown');
    await onLogger.flush();
    onLogger.dispose();
    assert.match(readFileSync(on, 'utf8'), /\[debug\] shown/);
  });

  test('转发原 logger（node 版终端里照旧可见）', async () => {
    const file = join(dir, 'tee.log');
    const seen: string[] = [];
    const logger = createFileLogger({
      file,
      flushThreshold: 1,
      flushIntervalMs: 60_000,
      base: { warn: (message) => seen.push(message) },
    });
    logger.warn('both places');
    await logger.flush();
    logger.dispose();
    assert.deepEqual(seen, ['both places']);
    assert.match(readFileSync(file, 'utf8'), /\[warn\] both places/);
  });

  test('原 logger 抛错不影响落盘（日志系统不许成为故障源）', async () => {
    const file = join(dir, 'broken-base.log');
    const logger = createFileLogger({
      file,
      flushThreshold: 1,
      flushIntervalMs: 60_000,
      base: {
        error: () => {
          throw new Error('host logger exploded');
        },
      },
    });
    logger.error('still written');
    await logger.flush();
    logger.dispose();
    assert.match(readFileSync(file, 'utf8'), /\[error\] still written/);
  });

  test('落盘前脱敏：令牌不进文件', async () => {
    const file = join(dir, 'redact.log');
    const logger = createFileLogger({ file, flushThreshold: 1, flushIntervalMs: 60_000 });
    logger.info('请求头 x-dsh-pet-token: abcdefghijklmnopqrstuvwx');
    await logger.flush();
    logger.dispose();
    const text = readFileSync(file, 'utf8');
    assert.match(text, /x-dsh-pet-token: \*\*\*/);
    assert.ok(!text.includes('abcdefghijklmnopqrstuvwx'));
  });
});

/**
 * 在子进程里跑一段日志脚本，等进程退出后返回落盘内容。
 * 退出路径只能在真实进程里验证：同进程的 flush/dispose 看不到 exit 时的行为。
 */
function logFromChild(script: string): string {
  const childDir = mkdtempSync(join(tmpdir(), 'dsh-pet-log-exit-'));
  // 父目录故意不存在：首次退出时也要能自己建出来
  const file = join(childDir, 'nested', 'logs.txt');
  try {
    const child = spawnSync(
      process.execPath,
      ['--experimental-strip-types', '--input-type=module', '-e', script, file, LOGGER_URL],
      { encoding: 'utf8', timeout: 10_000 },
    );
    assert.equal(child.status, 0, child.stderr || String(child.error));
    return existsSync(file) ? readFileSync(file, 'utf8') : '';
  } finally {
    rmSync(childDir, { recursive: true, force: true });
  }
}

/** 断言 `item-0…item-{count-1}` 恰好各出现一次且顺序一致。 */
function assertItemsInOrder(text: string, count: number): void {
  const items = [...text.matchAll(/\[info\] item-(\d+)/g)].map((match) => Number(match[1]));
  assert.deepEqual(items, [...Array(count).keys()], '日志应完整、顺序一致且不重复');
}

describe('进程退出', () => {
  test('写入 64 条后立即退出：批次边界上的日志全部落盘', () => {
    const text = logFromChild(`
      const { createFileLogger } = await import(process.argv[2]);
      const log = createFileLogger({ file: process.argv[1] });
      for (let index = 0; index < 64; index += 1) log.info('item-' + index);
      process.exit(0);
    `);
    assertItemsInOrder(text, 64);
  });

  test('写入 65 条后立即退出：在途批次与缓冲里的行都不丢', () => {
    const text = logFromChild(`
      const { createFileLogger } = await import(process.argv[2]);
      const log = createFileLogger({ file: process.argv[1] });
      for (let index = 0; index < 65; index += 1) log.info('item-' + index);
      process.exit(0);
    `);
    assertItemsInOrder(text, 65);
  });

  test('dispose 后立即退出：补写完整，重复 dispose 不重复写', () => {
    const text = logFromChild(`
      const { createFileLogger } = await import(process.argv[2]);
      const log = createFileLogger({ file: process.argv[1] });
      for (let index = 0; index < 64; index += 1) log.info('item-' + index);
      log.dispose();
      log.dispose();
      process.exit(0);
    `);
    assertItemsInOrder(text, 64);
  });

  test('dispose 之后记录的日志也落盘', () => {
    const text = logFromChild(`
      const { createFileLogger } = await import(process.argv[2]);
      const log = createFileLogger({ file: process.argv[1] });
      log.dispose();
      log.info('item-0');
      process.exit(0);
    `);
    assertItemsInOrder(text, 1);
  });
});
