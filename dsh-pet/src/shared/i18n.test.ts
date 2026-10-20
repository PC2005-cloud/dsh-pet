/**
 * i18n 单元测试 —— 钉住三层转换（整句译文表 / 片段词组 / 单字兜底）与语言判定。
 * 只测纯函数（convertText / detectLang / languageMenuBranch），不依赖 DOM。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { convertText, detectLang, languageMenuBranch } from './i18n';

test('zh-CN 原样返回', () => {
  assert.equal(convertText('zh-CN', '回到初始位置'), '回到初始位置');
  assert.equal(convertText('zh-CN', '余额不足'), '余额不足');
});

test('整句译文表命中：台湾用语而非单纯简繁转换', () => {
  assert.equal(convertText('zh-TW', '保存'), '儲存');
  assert.equal(convertText('zh-TW', '拖拽'), '拖曳');
  assert.equal(convertText('zh-TW', '谷'), '離峰');
  assert.equal(convertText('zh-TW', '周'), '週');
});

test('整句命中保留前后空白', () => {
  assert.equal(convertText('zh-TW', '  保存 '), '  儲存 ');
});

test('片段词组：动态拼接的文字', () => {
  assert.equal(convertText('zh-TW', '余额：128.5 元，请检查网络'), '餘額：128.5 元，請檢查網路');
  assert.equal(convertText('zh-TW', '点击宠物查看余额'), '點擊寵物查看餘額');
});

test('单字兜底：没收录的文字也不留简体', () => {
  assert.equal(convertText('zh-TW', '一条会说话的鲸鱼'), '一條會說話的鯨魚');
});

test('无汉字 / 英文 / 数字不变', () => {
  assert.equal(convertText('zh-TW', 'DeepSeek 128.5'), 'DeepSeek 128.5');
});

test('语言名称不参与转换', () => {
  assert.equal(convertText('zh-TW', '简体中文'), '简体中文');
  assert.equal(convertText('zh-TW', '✓ 繁體中文'), '✓ 繁體中文');
  assert.equal(convertText('zh-TW', '語言 / 语言'), '語言 / 语言');
});

test('detectLang：繁体地区 → zh-TW，其余 → zh-CN', () => {
  assert.equal(detectLang('zh-TW'), 'zh-TW');
  assert.equal(detectLang('zh-HK'), 'zh-TW');
  assert.equal(detectLang('zh-Hant-TW'), 'zh-TW');
  assert.equal(detectLang('zh-CN'), 'zh-CN');
  assert.equal(detectLang('en-US'), 'zh-CN');
  assert.equal(detectLang(undefined), 'zh-CN');
});

test('languageMenuBranch：当前语言带 ✓，叶子携带目标语言', () => {
  const branch = languageMenuBranch('zh-TW');
  assert.equal(branch.children.length, 2);
  const [cn, tw] = branch.children as Array<{ label: string; action: string; lang: string }>;
  assert.deepEqual(cn, { label: '简体中文', action: 'set-lang', lang: 'zh-CN' });
  assert.deepEqual(tw, { label: '✓ 繁體中文', action: 'set-lang', lang: 'zh-TW' });
});
