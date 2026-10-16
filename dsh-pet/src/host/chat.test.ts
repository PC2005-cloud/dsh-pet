/**
 * 对话配图解析单元测试 —— 钉住「模型选图」的取舍规则：
 * - 命中池内 → 采纳并从正文剥离标记（标记不得留在用户可见文本里）；
 * - 池外名称（模型幻觉）→ 不配图且**正文原样保留**（绝不因解析失败丢回复）；
 * - 只回标记不回正文 → 视为没选（否则气泡会空掉）。
 *
 * 解析函数住在 memes.ts（纯函数、无 LLM 依赖），故本测试只 import 它——
 * 避免拉起 chat.ts 的 @deepseek-ai/dsh-llm 依赖链。
 *
 * 跑法：node --experimental-strip-types --test src/host/chat.test.ts
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { extractChatImage, memeCatalog, type MemeEntry } from './memes.ts';

const POOL: MemeEntry[] = [
  { name: '可爱', desc: '卖萌立绘' },
  { name: '死掉了', desc: '累瘫阵亡' },
  { name: '就一碗', desc: '蹭饭大碗' },
];

describe('extractChatImage —— 模型选图的采纳与剥离', () => {
  test('命中池内 → 保留正文、返回图片名、剥离标记', () => {
    const r = extractChatImage('今天好累啊，我先瘫了\n[图:死掉了]', POOL);
    assert.equal(r.text, '今天好累啊，我先瘫了');
    assert.equal(r.image, '死掉了');
  });

  test('标记与正文同行也能剥（模型不总换行）', () => {
    const r = extractChatImage('来我家吃饭吧就一碗 [图:就一碗]', POOL);
    assert.equal(r.text, '来我家吃饭吧就一碗');
    assert.equal(r.image, '就一碗');
  });

  test('无标记 → 原样返回，不配图（对话配图是可选点缀）', () => {
    const r = extractChatImage('嗯嗯，我明白了', POOL);
    assert.equal(r.text, '嗯嗯，我明白了');
    assert.equal(r.image, undefined);
  });

  test('池外名称（模型幻觉）→ 不配图，且正文原样保留（含标记也不吞正文）', () => {
    const raw = '哈哈好的\n[图:不存在的表情包]';
    const r = extractChatImage(raw, POOL);
    assert.equal(r.image, undefined);
    assert.equal(r.text, raw); // 不剥离：既然没采纳，就不动原文
  });

  test('只回标记没有正文 → 视为没选（避免气泡空掉）', () => {
    const r = extractChatImage('[图:可爱]', POOL);
    assert.equal(r.image, undefined);
    assert.equal(r.text, '[图:可爱]');
  });

  test('全角冒号 / 多余空白 / 名称前后空格都能识别', () => {
    assert.equal(extractChatImage('好的\n[图：可爱]', POOL).image, '可爱');
    assert.equal(extractChatImage('好的\n[图:  死掉了  ]', POOL).image, '死掉了');
  });

  test('空池 → 解析不出任何图（开关关闭时的实际路径）', () => {
    const r = extractChatImage('好的\n[图:可爱]', []);
    assert.equal(r.image, undefined);
    assert.equal(r.text, '好的\n[图:可爱]');
  });

  test('标记在中间（非结尾）不认 —— 只认结尾，避免误伤正文里的方括号', () => {
    const raw = '[图:可爱] 然后呢？';
    const r = extractChatImage(raw, POOL);
    assert.equal(r.image, undefined);
    assert.equal(r.text, raw);
  });
});

describe('memeCatalog —— 给模型看的候选清单', () => {
  test('一行一张：名称 + 冒号 + 描述，供模型按语境挑选', () => {
    const cat = memeCatalog(POOL);
    assert.ok(cat.includes('- 可爱：卖萌立绘'));
    assert.ok(cat.includes('- 死掉了：累瘫阵亡'));
    assert.ok(cat.includes('- 就一碗：蹭饭大碗'));
    assert.equal(cat.split('\n').length, POOL.length);
  });
});
