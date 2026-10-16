/**
 * 碎碎念共享契约测试 —— 钉住「文本 + 可选配图」的解析语义与两端共用的配图渲染：
 * - image 缺失/空白/非字符串 → 不产出该字段（老行为：纯文本碎碎念）；
 * - 名称含中文时 URL 必须编码（host 侧 decodeURIComponent 后按文件名匹配）；
 * - 配图节点与样式由本模块统一提供，浏览器 React 壳与桌面 DOM 壳各引用同一常量。
 *
 * 跑法：node --experimental-strip-types --test src/shared/whisper.test.ts
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { MEME_BUBBLE_CLASS, MEME_BUBBLE_CSS, MEME_IMG_CLASS, createMemeImage, memeImageUrl } from './whisper.ts';

describe('memeImageUrl —— 表情包图片地址', () => {
  test('中文名被 URL 编码（路由段只认编码后的形态）', () => {
    assert.equal(
      memeImageUrl('鱼片有资源吗'),
      '/dsh-pet-7340/pic/memes/' + encodeURIComponent('鱼片有资源吗') + '.png',
    );
    assert.ok(!memeImageUrl('鱼片有资源吗').includes('鱼片'));
  });

  test('纯 ASCII 名原样保留，便于肉眼排查', () => {
    assert.equal(memeImageUrl('Ciallo'), '/dsh-pet-7340/pic/memes/Ciallo.png');
  });

  test('走到 pic/memes 前缀下（host 路由按该前缀映射 assets/memes）', () => {
    assert.ok(memeImageUrl('可爱').startsWith('/dsh-pet-7340/pic/memes/'));
    assert.ok(memeImageUrl('可爱').endsWith('.png'));
  });

  test('base 语义 = 已含 /dsh-pet-7340 的宿主基址（与视频 assetBase 一致）', () => {
    // 桌面 bridge 模式：传 BASE 本身（它已含 /dsh-pet-7340），不得再拼一次
    assert.equal(
      memeImageUrl('可爱', 'dsh-pet-bridge://dsh-pet/dsh-pet-7340'),
      'dsh-pet-bridge://dsh-pet/dsh-pet-7340/pic/memes/' + encodeURIComponent('可爱') + '.png',
    );
    // 桌面 HTTP 直连模式：同上
    assert.equal(
      memeImageUrl('可爱', 'http://127.0.0.1:8080/dsh-pet-7340'),
      'http://127.0.0.1:8080/dsh-pet-7340/pic/memes/' + encodeURIComponent('可爱') + '.png',
    );
    // 浏览器缺省：相对路径（页面自身就在宿主 origin 上）
    assert.equal(memeImageUrl('可爱'), '/dsh-pet-7340/pic/memes/' + encodeURIComponent('可爱') + '.png');
  });

  test('不得出现重复的 /dsh-pet-7340 段（桌面端图裂的成因）', () => {
    for (const base of ['dsh-pet-bridge://dsh-pet/dsh-pet-7340', 'http://127.0.0.1:8080/dsh-pet-7340']) {
      const url = memeImageUrl('可爱', base);
      assert.equal(url.split('/dsh-pet-7340').length - 1, 1, url);
    }
    assert.equal(memeImageUrl('可爱').split('/dsh-pet-7340').length - 1, 1);
  });

  test('带素材根 → 多一段 <素材根>（配图归属与动画同一套：按素材根取目录链）', () => {
    assert.equal(
      memeImageUrl('可爱', '/dsh-pet-7340', 'test1'),
      '/dsh-pet-7340/pic/memes/test1/' + encodeURIComponent('可爱') + '.png',
    );
    // 中文素材根同样编码
    assert.equal(
      memeImageUrl('可爱', '/dsh-pet-7340', '小不点'),
      '/dsh-pet-7340/pic/memes/' + encodeURIComponent('小不点') + '/' + encodeURIComponent('可爱') + '.png',
    );
    // 桌面端：base 已含前缀，素材根只加一段
    assert.equal(
      memeImageUrl('可爱', 'http://127.0.0.1:8080/dsh-pet-7340', 'pack1'),
      'http://127.0.0.1:8080/dsh-pet-7340/pic/memes/pack1/' + encodeURIComponent('可爱') + '.png',
    );
    assert.equal(memeImageUrl('可爱', '/dsh-pet-7340', 'pack1').split('/dsh-pet-7340').length - 1, 1);
  });

  test('素材根缺省/空白 → 退回旧的两段形式（= 素材根 main 的目录链，不至于图裂）', () => {
    const flat = memeImageUrl('可爱');
    for (const root of ['', '   ', undefined]) {
      assert.equal(memeImageUrl('可爱', '/dsh-pet-7340', root), flat);
    }
    assert.equal(
      memeImageUrl('可爱', undefined, 'main'),
      '/dsh-pet-7340/pic/memes/main/' + encodeURIComponent('可爱') + '.png',
    );
  });
});

describe('createMemeImage —— 两端共用的配图节点', () => {
  /** 最小 DOM 桩：共用函数只用到 document.createElement（Node 里没有 DOM） */
  function stubDocument(): { created: { tag: string; props: Record<string, string> }[]; restore: () => void } {
    const created: { tag: string; props: Record<string, string> }[] = [];
    const g = globalThis as { document?: unknown };
    const prev = g.document;
    g.document = {
      createElement(tag: string) {
        const rec = { tag, props: {} as Record<string, string> };
        created.push(rec);
        return {
          dataset: {} as Record<string, string>,
          textContent: '',
          set className(v: string) {
            rec.props.className = v;
          },
          set src(v: string) {
            rec.props.src = v;
          },
          set alt(v: string) {
            rec.props.alt = v;
          },
        };
      },
      querySelector: () => null, // 视为未注入过样式 → 走注入分支
      head: { appendChild: () => {} },
    };
    return {
      created,
      restore: () => {
        g.document = prev;
      },
    };
  }

  test('名称缺失/空白 → null（调用方据此走纯文本路径）', () => {
    for (const v of [undefined, '', '   ']) {
      assert.equal(createMemeImage(v), null);
    }
  });

  test('有名称 → 产出 img，class/src/alt 齐全', () => {
    const doc = stubDocument();
    try {
      createMemeImage('死掉了');
      assert.equal(doc.created.filter((c) => c.tag === 'img').length, 1);
      const img = doc.created.find((c) => c.tag === 'img');
      assert.equal(img?.props.className, MEME_IMG_CLASS);
      assert.equal(img?.props.src, memeImageUrl('死掉了'));
      assert.equal(img?.props.alt, '死掉了');
    } finally {
      doc.restore();
    }
  });

  test('桌面传 BASE → src 为绝对地址（file:// 页面必须绝对，且与视频同规则）', () => {
    const doc = stubDocument();
    const base = 'http://127.0.0.1:8080/dsh-pet-7340';
    try {
      createMemeImage('可爱', base);
      const img = doc.created.find((c) => c.tag === 'img');
      assert.equal(img?.props.src, memeImageUrl('可爱', base));
      assert.equal(
        img?.props.src,
        'http://127.0.0.1:8080/dsh-pet-7340/pic/memes/' + encodeURIComponent('可爱') + '.png',
      );
    } finally {
      doc.restore();
    }
  });

  test('createMemeImage 透传素材根（桌面端按宠物取自己的表情包目录）', () => {
    const doc = stubDocument();
    try {
      createMemeImage('可爱', 'http://127.0.0.1:8080/dsh-pet-7340', 'pack1');
      const img = doc.created.find((c) => c.tag === 'img');
      assert.equal(img?.props.src, memeImageUrl('可爱', 'http://127.0.0.1:8080/dsh-pet-7340', 'pack1'));
    } finally {
      doc.restore();
    }
  });

  test('两端选择器/变量都写在 shared 里（避免浏览器与桌面各写一份走样）', () => {
    assert.ok(MEME_BUBBLE_CSS.includes('.' + MEME_IMG_CLASS));
    assert.ok(MEME_BUBBLE_CSS.includes('.' + MEME_BUBBLE_CLASS));
    // 尺寸同时兼容两端变量名：浏览器 --dsh-pet-size、桌面 --pet-size
    assert.ok(MEME_BUBBLE_CSS.includes('--dsh-pet-size'));
    assert.ok(MEME_BUBBLE_CSS.includes('--pet-size'));
  });
});
