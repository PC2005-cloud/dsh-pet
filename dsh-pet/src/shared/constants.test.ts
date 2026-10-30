/**
 * 挂载前缀契约：子路径部署要跟随 `document.baseURI`，而根路径、桌面与宿主取值必须逐字节不变。
 * 现象背景见 issue #242——绝对路径 `/dsh-pet-7340/…` 会绕开反代前缀，直达站点根。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { ROUTE_PATH, ROUTE_SEGMENT, mountPrefixOf, routePathOf } from './constants.ts';

describe('mountPrefixOf', () => {
  test('没有文档基准地址：返回空前缀', () => {
    assert.equal(mountPrefixOf(undefined), '');
    assert.equal(mountPrefixOf(''), '');
  });

  test('根路径部署：取到空目录部分', () => {
    assert.equal(mountPrefixOf('http://127.0.0.1:2298/'), '');
  });

  test('带端口的子路径部署：返回挂载目录且去掉尾部斜杠', () => {
    assert.equal(
      mountPrefixOf('http://192.0.2.10:5666/app/DeepSeek-Harness/fngateway/'),
      '/app/DeepSeek-Harness/fngateway',
    );
  });

  test('尾斜杠缺失或重复：归一成同一前缀', () => {
    assert.equal(mountPrefixOf('https://h.example.com/dsh'), '/dsh');
    assert.equal(mountPrefixOf('https://h.example.com/dsh/'), '/dsh');
    assert.equal(mountPrefixOf('https://h.example.com/dsh///'), '/dsh');
  });

  test('地址不带路径部分：空前缀', () => {
    assert.equal(mountPrefixOf('http://127.0.0.1:2298'), '');
  });

  test('查询串与片段不进入前缀', () => {
    assert.equal(mountPrefixOf('https://h.example.com/dsh/?a=1#b'), '/dsh');
  });

  test('非 http(s) 协议：空前缀', () => {
    assert.equal(mountPrefixOf('file:///C:/Users/x/index.html'), '', '桌面本地页没有挂载前缀');
    assert.equal(mountPrefixOf('data:text/html,<p></p>'), '');
    assert.equal(mountPrefixOf('chrome-extension://abc/index.html'), '');
  });

  test('非法地址：空前缀且不抛异常', () => {
    assert.equal(mountPrefixOf('not a url'), '');
  });

  test('前缀含非 ASCII：按 URL 规则百分号编码', () => {
    // 网关须解码后再匹配前缀；浏览器发出的请求本就是编码形式（issue #242 那个 U+2011 连字符即此情形）。
    assert.equal(mountPrefixOf('http://h/app/DeepSeek\u2011Harness/'), '/app/DeepSeek%E2%80%91Harness');
  });
});

describe('routePathOf', () => {
  test('无前缀环境：等于纯路由段', () => {
    assert.equal(routePathOf(undefined), ROUTE_SEGMENT);
    assert.equal(routePathOf('http://127.0.0.1:2298/'), ROUTE_SEGMENT);
    assert.equal(routePathOf('file:///C:/Users/x/index.html'), ROUTE_SEGMENT);
  });

  test('子路径部署：路由段挂在前缀之后', () => {
    assert.equal(
      routePathOf('http://192.0.2.10:5666/app/DeepSeek-Harness/fngateway/'),
      '/app/DeepSeek-Harness/fngateway/dsh-pet-7340',
    );
    assert.equal(routePathOf('https://h.example.com/dsh/'), '/dsh/dsh-pet-7340');
  });
});

describe('ROUTE_PATH', () => {
  test('Node 环境没有 document：模块级取值与路由段一致', () => {
    assert.equal(ROUTE_PATH, ROUTE_SEGMENT, '宿主、桌面 Helper 主进程侧与单测必须与改动前逐字节一致');
  });
});
