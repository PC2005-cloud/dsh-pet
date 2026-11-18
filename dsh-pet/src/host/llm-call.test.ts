/**
 * 调用性质常量测试 —— 钉住「声明值必须能安全进请求头」这条约束：代理把 `purpose` 原样放进
 * `x-bili-plugin-purpose`，只收可打印 ASCII、长度 ≤64；而 `conversation` 是它的保留值，
 * 等值声明会被丢弃，分车道问题随即静默复发。
 *
 * 只 import 纯常量模块，不拉起 dsh-llm 依赖链。
 *
 * 跑法：node --experimental-strip-types --test src/host/llm-call.test.ts
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { PET_CHAT_PURPOSE, PET_WHISPER_PURPOSE } from './llm-call.ts';

/** 代理侧请求头校验的等价规则：可打印 ASCII（无空格/控制符）、非空、长度 ≤64。 */
const HEADER_SAFE = /^[\x21-\x7e]{1,64}$/;

describe('调用性质 —— 代理请求头约束', () => {
  for (const [label, value] of [
    ['碎碎念', PET_WHISPER_PURPOSE],
    ['陪聊', PET_CHAT_PURPOSE],
  ] as const) {
    test(`${label}的声明值可直接进请求头`, () => {
      assert.match(value, HEADER_SAFE);
    });
  }

  test('两者互不相同 —— 否则代理的 lane 标签分不出两条调用路径', () => {
    assert.notEqual(PET_WHISPER_PURPOSE, PET_CHAT_PURPOSE);
  });

  test('都不落在代理保留值 conversation 上 —— 等值声明会被丢弃，问题静默复发', () => {
    assert.notEqual(PET_WHISPER_PURPOSE, 'conversation');
    assert.notEqual(PET_CHAT_PURPOSE, 'conversation');
  });
});
