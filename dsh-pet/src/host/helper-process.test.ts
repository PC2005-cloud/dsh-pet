/**
 * helper-process 单元测试 —— 聚焦 Electron 解压的平台适配。
 *
 * 为什么测这三件事：
 *   1. 解压命令必须按平台选（GNU tar 读不了 zip，这是线上故障的直接原因）；
 *   2. zip 内的符号链接必须被还原（darwin 的 Electron.app 框架结构依赖它）；
 *   3. 纯 Node 兜底解压必须可用（最小化环境可能没有 unzip/tar）。
 *
 * 用 Node 内置 test runner（node:test），不引入任何 npm 依赖：
 *   node --experimental-strip-types --test src/host/helper-process.test.ts
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { deflateRawSync } from 'node:zlib';

import { extractAttempts, extractZipWithNode } from './helper-process.ts';

interface ZipEntry {
  name: string;
  data: Buffer;
  /** unix mode 高 16 位（默认普通文件 0o100644；符号链接 0o120777；目录 0o040755） */
  mode?: number;
  /** zip 压缩方式：0=stored，8=deflate（默认 0） */
  method?: 0 | 8;
}

/** 构造一个最小合法 zip（不依赖第三方库，便于断言实现细节） */
function buildZip(entries: ZipEntry[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  // 通用位标记第 11 位置 1：条目名按 UTF-8 编码
  const flags = 0x0800;

  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, 'utf8');
    const method = entry.method ?? 0;
    const raw = method === 8 ? deflateRawSync(entry.data) : entry.data;
    const crc = crc32(entry.data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(0, 10); // mtime/mdate
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(raw.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28); // extra len
    locals.push(local, nameBuf, raw);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4); // version made by
    central.writeUInt16LE(20, 6); // version needed
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(0, 12); // mtime/mdate
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(raw.length, 20);
    central.writeUInt32LE(entry.data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30); // extra len
    central.writeUInt16LE(0, 32); // comment len
    central.writeUInt16LE(0, 34); // disk number start
    central.writeUInt16LE(0, 36); // internal attrs
    // 移位结果可能为负（符号位），必须转无符号 32 位再写入
    central.writeUInt32LE(((entry.mode ?? 0o100644) << 16) >>> 0, 38); // external attrs = unix mode
    central.writeUInt32LE(offset, 42); // local header offset
    centrals.push(central, nameBuf);

    offset += local.length + nameBuf.length + raw.length;
  }

  const localBuf = Buffer.concat(locals);
  const centralBuf = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(localBuf.length, 16);
  return Buffer.concat([localBuf, centralBuf, eocd]);
}

function crc32(buf: Buffer): number {
  let crc = -1; // 0xffffffff
  for (const byte of buf) {
    crc ^= byte;
    for (let i = 0; i < 8; i += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  // 取反后必须转无符号 32 位，否则 writeUInt32LE 会因负值抛 ERR_OUT_OF_RANGE
  return (~crc >>> 0) >>> 0;
}

function tmpDir(tag: string): string {
  const dir = join(tmpdir(), `dsh-pet-test-${tag}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe('extractAttempts —— 解压命令按平台选择', () => {
  test('win32：tar 优先（系统 tar 实为 bsdtar，可透明读 zip），失败退回 powershell', () => {
    assert.deepEqual(
      extractAttempts('win32').map((a) => a.command),
      ['tar', 'powershell'],
    );
  });

  test('linux：unzip 优先（GNU tar 读不了 zip），tar 仅作兜底', () => {
    assert.deepEqual(
      extractAttempts('linux').map((a) => a.command),
      ['unzip', 'tar'],
    );
  });

  test('darwin：同样 unzip 优先（bsdtar 对 symlink 处理与 unzip 不一致）', () => {
    assert.deepEqual(
      extractAttempts('darwin').map((a) => a.command),
      ['unzip', 'tar'],
    );
  });

  test('linux 的 unzip 参数能解压到指定目录', () => {
    const [first] = extractAttempts('linux');
    assert.deepEqual(first.args('/tmp/a.zip', '/tmp/out'), ['-q', '-o', '/tmp/a.zip', '-d', '/tmp/out']);
  });

  test('win32 的 powershell 参数带 Expand-Archive', () => {
    const args = extractAttempts('win32')[1].args('/tmp/a.zip', '/tmp/out');
    assert.equal(args[0], '-NoProfile');
    assert.match(args[2], /Expand-Archive/);
  });
});

describe('extractZipWithNode —— 纯 Node 兜底解压', () => {
  test('解压普通文件（stored 与 deflate 两种方式）', async () => {
    const dir = tmpDir('plain');
    try {
      const zipPath = join(dir, 'a.zip');
      writeFileSync(
        zipPath,
        buildZip([
          { name: 'electron', data: Buffer.from('ELF-BINARY') },
          { name: 'sub/dir/note.txt', data: Buffer.from('hello'), method: 8 },
        ]),
      );
      const out = join(dir, 'out');
      mkdirSync(out, { recursive: true });
      const error = await extractZipWithNode(zipPath, out);
      assert.equal(error, undefined, `不应报错，实际：${error}`);
      assert.equal(readFileSync(join(out, 'electron'), 'utf8'), 'ELF-BINARY');
      assert.equal(readFileSync(join(out, 'sub', 'dir', 'note.txt'), 'utf8'), 'hello');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('还原符号链接（darwin Electron.app 框架结构依赖此项）', async () => {
    const dir = tmpDir('symlink');
    try {
      const zipPath = join(dir, 'a.zip');
      writeFileSync(
        zipPath,
        buildZip([
          {
            name: 'Electron.app/Contents/Frameworks/Electron Framework.framework/Versions/A/Electron Framework',
            data: Buffer.from('REAL-BINARY'),
          },
          {
            name: 'Electron.app/Contents/Frameworks/Electron Framework.framework/Versions/Current',
            data: Buffer.from('A'),
            mode: 0o120777, // S_IFLNK
          },
        ]),
      );
      const out = join(dir, 'out');
      mkdirSync(out, { recursive: true });
      const error = await extractZipWithNode(zipPath, out);
      assert.equal(error, undefined, `不应报错，实际：${error}`);

      const link = join(out, 'Electron.app/Contents/Frameworks/Electron Framework.framework/Versions/Current');
      assert.ok(lstatSync(link).isSymbolicLink(), 'Current 必须是符号链接，而非普通文件/目录');
      assert.equal(readlinkSync(link), 'A');
      // 经 symlink 能读到真实内容 —— 证明链接可用，而不是孤立文件
      assert.equal(readFileSync(join(link, 'Electron Framework'), 'utf8'), 'REAL-BINARY');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('解压目录条目', async () => {
    const dir = tmpDir('dirent');
    try {
      const zipPath = join(dir, 'a.zip');
      writeFileSync(
        zipPath,
        buildZip([
          { name: 'Electron.app/Contents/MacOS/', data: Buffer.alloc(0), mode: 0o040755 },
          { name: 'Electron.app/Contents/MacOS/Electron', data: Buffer.from('EXEC') },
        ]),
      );
      const out = join(dir, 'out');
      mkdirSync(out, { recursive: true });
      const error = await extractZipWithNode(zipPath, out);
      assert.equal(error, undefined, `不应报错，实际：${error}`);
      assert.ok(existsSync(join(out, 'Electron.app/Contents/MacOS')));
      assert.equal(readFileSync(join(out, 'Electron.app/Contents/MacOS/Electron'), 'utf8'), 'EXEC');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('拒绝路径穿越条目', async () => {
    const dir = tmpDir('traversal');
    try {
      const zipPath = join(dir, 'a.zip');
      writeFileSync(zipPath, buildZip([{ name: '../escape.txt', data: Buffer.from('PWNED') }]));
      const out = join(dir, 'out');
      mkdirSync(out, { recursive: true });
      const error = await extractZipWithNode(zipPath, out);
      assert.match(error ?? '', /unsafe entry path/, '必须拒绝穿越路径');
      assert.ok(!existsSync(join(dir, 'escape.txt')), '不应写到目标目录之外');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('非 zip 文件返回错误描述而不是抛异常', async () => {
    const dir = tmpDir('notzip');
    try {
      const zipPath = join(dir, 'a.zip');
      writeFileSync(zipPath, Buffer.from('this is definitely not a zip file'));
      const out = join(dir, 'out');
      mkdirSync(out, { recursive: true });
      const error = await extractZipWithNode(zipPath, out);
      assert.match(error ?? '', /not a zip|EOCD/, '应返回可读的错误描述');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
