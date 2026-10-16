/**
 * 表情包池单元测试 —— 钉住「配置 memes ↔ 磁盘图片」的对齐规则与选图/校验语义：
 * 文件缺失的条目必须剔除（用户删图不必同步改配置）、描述为空的条目剔除、
 * 非对象/数组等非法形态 → 空池（不抛错，退化为纯文本碎碎念）；
 * 目录链（种类独占 → 用户目录 → 包内）按顺序查盘：链上任一目录里有该图即命中；
 * limitPool（对话配图张数上限）：0/非法 = 不限制，N>0 = 取前 N 张。
 *
 * 跑法：node --experimental-strip-types --test src/host/memes.test.ts
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { limitPool, matchMeme, pickMeme, readMemePool } from './memes.ts';

/** 造一个临时表情包目录，并按 names 写同名 png（内容无关，只要存在） */
function withMemes(names: string[], run: (memesDir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-pet-memes-test-'));
  try {
    const memesDir = join(dir, 'memes');
    mkdirSync(memesDir, { recursive: true });
    for (const n of names) writeFileSync(join(memesDir, n + '.png'), 'x');
    run(memesDir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('readMemePool —— 配置与磁盘的对齐', () => {
  test('命中的条目进池（描述去空白）', () => {
    withMemes(['可爱', '吃白饭的大肥鱼'], (memesDir) => {
      const pool = readMemePool({ 可爱: ' 卖萌立绘 ', 吃白饭的大肥鱼: '躺平扒饭' }, [memesDir]);
      assert.equal(pool.length, 2);
      assert.equal(pool.find((m) => m.name === '可爱')?.desc, '卖萌立绘');
      assert.ok(pool.some((m) => m.name === '吃白饭的大肥鱼'));
    });
  });

  test('配置里有、磁盘上没有的图 → 剔除（删图不必同步改配置）', () => {
    withMemes(['可爱'], (memesDir) => {
      const pool = readMemePool({ 可爱: '卖萌', 不存在的图: '随便写' }, [memesDir]);
      assert.deepEqual(
        pool.map((m) => m.name),
        ['可爱'],
      );
    });
  });

  test('磁盘上有、配置里没写的图 → 不进池（无从得知描述）', () => {
    withMemes(['可爱', '未登记的图'], (memesDir) => {
      const pool = readMemePool({ 可爱: '卖萌' }, [memesDir]);
      assert.equal(pool.length, 1);
    });
  });

  test('描述为空/仅空白/非字符串 → 剔除', () => {
    withMemes(['a', 'b', 'c'], (memesDir) => {
      const pool = readMemePool({ a: '', b: '   ', c: 42 }, [memesDir]);
      assert.equal(pool.length, 0);
    });
  });

  test('非法 memes 形态 → 空池且不抛错', () => {
    withMemes(['可爱'], (memesDir) => {
      for (const bad of [undefined, null, 42, 'str', ['可爱'] as unknown]) {
        assert.deepEqual(readMemePool(bad, [memesDir]), []);
      }
    });
  });

  test('目录不存在 → 空池（未打包/被删也不崩）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-pet-memes-test-'));
    try {
      assert.deepEqual(readMemePool({ 可爱: '卖萌' }, [join(dir, 'nope')]), []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('readMemePool —— 目录链（种类独占 / 用户 / 包内）', () => {
  /** 名称集合比较：池的顺序语义另有专门用例钉住，这里只关心"谁进了池" */
  const names = (pool: { name: string }[]): string[] => pool.map((m) => m.name).sort();

  test('池的顺序 = 配置里写的顺序（"前 N 张"必须由用户可控，不能是拼音序）', () => {
    withMemes(['次', '阿', '波'], (memesDir) => {
      const pool = readMemePool({ 次: 'C', 阿: 'A', 波: 'B' }, [memesDir]);
      assert.deepEqual(
        pool.map((m) => m.name),
        ['次', '阿', '波'],
        '按书写顺序原样返回；曾经按 zh 拼音排序（会变成 阿/波/次），已改掉',
      );
    });
  });

  test('剔除缺失条目后，剩余项仍保持书写顺序（不因过滤而重排）', () => {
    withMemes(['乙', '甲'], (memesDir) => {
      const pool = readMemePool({ 甲: 'A', 缺图: 'X', 乙: 'B' }, [memesDir]);
      assert.deepEqual(
        pool.map((m) => m.name),
        ['甲', '乙'],
      );
    });
  });

  test('链上任一目录里有该图 → 命中（顺序只决定谁先被查到）', () => {
    withMemes(['独占的图'], (ownDir) => {
      withMemes(['包内的图'], (pkgDir) => {
        assert.deepEqual(names(readMemePool({ 独占的图: '自己带的', 包内的图: '包里的' }, [ownDir, pkgDir])), [
          '包内的图',
          '独占的图',
        ]);
      });
    });
  });

  test('链上哪个目录都没有 → 剔除（与单目录口径一致）', () => {
    withMemes(['a'], (dirA) => {
      withMemes(['b'], (dirB) => {
        assert.deepEqual(names(readMemePool({ a: 'A', b: 'B', c: 'C' }, [dirA, dirB])), ['a', 'b']);
      });
    });
  });

  test('空链 → 空池（不查任何目录）', () => {
    withMemes(['可爱'], () => {
      assert.deepEqual(readMemePool({ 可爱: '卖萌' }, []), []);
    });
  });

  test('独占语义不在本函数里：链只给一个目录时，别的目录里的图一概不参与', () => {
    withMemes(['同名图'], (ownDir) => {
      withMemes(['同名图', '只在包内'], (pkgDir) => {
        const memes = { 同名图: '自己的', 只在包内: '包里的' };
        // 调用方（host/index.ts 的 memeDirsFor）在种类独占命中时只传自己的目录：
        // 只有包内目录里才有的图不进池——链里根本没有那个目录，同名图取的也是自己那份
        assert.deepEqual(names(readMemePool(memes, [ownDir])), ['同名图']);
        // 对照：把包内目录也放进链（非独占的回落链），同一张图立刻进池
        assert.deepEqual(names(readMemePool(memes, [ownDir, pkgDir])), ['只在包内', '同名图']);
      });
    });
  });
});

describe('pickMeme —— 随机抽图', () => {
  const pool = [
    { name: 'a', desc: 'A' },
    { name: 'b', desc: 'B' },
    { name: 'c', desc: 'C' },
  ];

  test('空池 → undefined', () => {
    assert.equal(pickMeme([]), undefined);
  });

  test('按 random 落点取对应项', () => {
    assert.equal(pickMeme(pool, () => 0)?.name, 'a');
    assert.equal(pickMeme(pool, () => 0.5)?.name, 'b');
    assert.equal(pickMeme(pool, () => 0.99)?.name, 'c');
  });

  test('random 返回 1（边界）不越界', () => {
    assert.equal(pickMeme(pool, () => 1)?.name, 'a');
  });
});

describe('limitPool —— 对话配图张数上限（chatImageLimit）', () => {
  const pool = [
    { name: 'a', desc: 'A' },
    { name: 'b', desc: 'B' },
    { name: 'c', desc: 'C' },
  ];

  test('limit > 0 → 取池内前 limit 张', () => {
    assert.deepEqual(
      limitPool(pool, 2).map((m) => m.name),
      ['a', 'b'],
    );
    assert.deepEqual(
      limitPool(pool, 1).map((m) => m.name),
      ['a'],
    );
  });

  test('limit 超过池大小 → 原样返回（不补、不报错）', () => {
    assert.deepEqual(limitPool(pool, 99), pool);
  });

  test('0 = 不限制（原样返回，与旧行为逐字一致）', () => {
    assert.deepEqual(limitPool(pool, 0), pool);
  });

  test('负数 / 非有限数 / 非数字 → 一律按「不限制」处理（绝不返回空池）', () => {
    for (const bad of [-1, -0.5, NaN, Infinity, -Infinity, undefined as unknown as number]) {
      assert.deepEqual(limitPool(pool, bad), pool, `limit=${String(bad)} 必须原样返回`);
    }
  });

  test('小数向下取整（不出现"取 2.5 张"这种含糊值）', () => {
    assert.deepEqual(
      limitPool(pool, 2.9).map((m) => m.name),
      ['a', 'b'],
    );
  });

  test('空池 → 空池（任何 limit 都不变）', () => {
    assert.deepEqual(limitPool([], 3), []);
  });
});

describe('matchMeme —— 模型选图校验', () => {
  const pool = [
    { name: '可爱', desc: '卖萌' },
    { name: '死掉了', desc: '累瘫' },
  ];

  test('池内命中 → 返回该条目', () => {
    assert.equal(matchMeme(pool, '死掉了')?.desc, '累瘫');
  });

  test('池外名称（模型幻觉）→ undefined', () => {
    assert.equal(matchMeme(pool, '不存在的图'), undefined);
  });

  test('空白/非字符串 → undefined', () => {
    assert.equal(matchMeme(pool, ''), undefined);
    assert.equal(matchMeme(pool, '   '), undefined);
    assert.equal(matchMeme(pool, undefined as unknown as string), undefined);
  });

  test('前后空白被容忍（模型多打空格也能命中）', () => {
    assert.equal(matchMeme(pool, ' 可爱 ')?.desc, '卖萌');
  });
});
