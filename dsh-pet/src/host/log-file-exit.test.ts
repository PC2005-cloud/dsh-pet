import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const loggerUrl = new URL('./log-file.ts', import.meta.url).href;

function childLog(script: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-pet-log-exit-'));
  const file = join(dir, 'nested', 'logs.txt');
  try {
    const child = spawnSync(
      process.execPath,
      ['--experimental-strip-types', '--input-type=module', '-e', script, file, loggerUrl],
      { encoding: 'utf8', timeout: 10_000 },
    );
    assert.equal(child.status, 0, child.stderr || String(child.error));
    return existsSync(file) ? readFileSync(file, 'utf8') : '';
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function assertItems(text: string, count: number): void {
  const actual = [...text.matchAll(/\[info\] item-(\d+)\n/g)].map((m) => Number(m[1]));
  assert.deepEqual(
    actual,
    Array.from({ length: count }, (_, i) => i),
    '日志必须完整、顺序一致且没有重复',
  );
}

for (const count of [1, 63, 64, 65, 128]) {
  test(`写入 ${count} 条后立即退出，包含在途批次且每条只写一次`, () => {
    const text = childLog(`
      const {createFileLogger} = await import(process.argv[2]);
      const log = createFileLogger({file:process.argv[1]});
      for(let i=0;i<${count};i++)log.info('item-'+i);
      process.exit(0);
    `);
    assertItems(text, count);
  });
}

for (const count of [1, 64, 65]) {
  test(`dispose 后立即退出，保存 ${count} 条且重复 dispose 不重复写入`, () => {
    const text = childLog(`
      const {createFileLogger} = await import(process.argv[2]);
      const log = createFileLogger({file:process.argv[1]});
      for(let i=0;i<${count};i++)log.info('item-'+i);
      log.dispose();log.dispose();process.exit(0);
    `);
    assertItems(text, count);
  });
}

test('手动 flush 尚未完成就退出时也保存全部日志', () => {
  const text = childLog(`
    const {createFileLogger} = await import(process.argv[2]);
    const log = createFileLogger({file:process.argv[1]});
    for(let i=0;i<12;i++)log.info('item-'+i);
    void log.flush();process.exit(0);
  `);
  assertItems(text, 12);
});

for (const mode of ['await', 'natural']) {
  test(`${mode} 退出路径不重复写入已经完成的批次`, () => {
    const text = childLog(`
      const {createFileLogger} = await import(process.argv[2]);
      const log = createFileLogger({file:process.argv[1]});
      for(let i=0;i<65;i++)log.info('item-'+i);
      ${mode === 'await' ? 'await log.flush();process.exit(0);' : ''}
    `);
    assertItems(text, 65);
  });
}

test('dispose 后的退出清理日志也能落盘', () => {
  const text = childLog(`
    const {createFileLogger} = await import(process.argv[2]);
    const log = createFileLogger({file:process.argv[1]});
    log.dispose();log.info('item-0');process.exit(0);
  `);
  assertItems(text, 1);
});

test('dispose 后异步截断读取完成，不得覆盖已经补写的日志', () => {
  const text = childLog(`
    const fs = (await import('node:fs/promises')).default;
    const {syncBuiltinESMExports} = await import('node:module');
    const readFile = fs.readFile;
    let entered,release;
    const reading = new Promise(resolve=>entered=resolve);
    const gate = new Promise(resolve=>release=resolve);
    fs.readFile = async (...args)=>{
      const content = await readFile(...args);
      entered();await gate;return content;
    };
    syncBuiltinESMExports();
    const {createFileLogger} = await import(process.argv[2]);
    const log = createFileLogger({file:process.argv[1],maxBytes:100,keepBytes:50});
    for(let i=0;i<64;i++)log.info('item-'+i);
    const completion = log.flush();
    await reading;
    log.info('item-64');log.dispose();release();
    await completion;
    process.exit(0);
  `);
  assertItems(text, 65);
});
