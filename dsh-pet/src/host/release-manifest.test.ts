/**
 * 发布清单契约：`runtime/electron-helper/main.js` 顶层 require 的相对模块，
 * 必须逐项出现在 `scripts/prepack-check.js` 的必需文件清单里。
 *
 * 背景：桌面壳是裸脚本，不经过构建打包；漏发一个被顶层 require 的兄弟模块，
 * 安装后就会在启动瞬间 MODULE_NOT_FOUND（ticket 03 的 probe-command.js、
 * ticket 05 的 control-request.js 都踩过）。这里直接按源码的 require 列表核对，
 * 以后新增 helper 模块却忘记补清单，测试会先红，而不是等用户装完再崩。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';

/** 读包根下的文件（本测试位于 src/host/，包根是两级之上） */
function readPackageFile(relative: string): string {
  return readFileSync(new URL(`../../${relative}`, import.meta.url), 'utf8');
}

const HELPER_DIR = 'runtime/electron-helper';

describe('prepack-check 必需文件清单 —— 覆盖桌面壳顶层 require', () => {
  const mainSource = readPackageFile(`${HELPER_DIR}/main.js`);
  const prepackSource = readPackageFile('scripts/prepack-check.js');

  test('main.js 每个相对 require 都在清单里', () => {
    const requiredBlock = /const required = \[([\s\S]*?)\n\];/.exec(prepackSource);
    assert.ok(requiredBlock, '找不到 prepack-check.js 的 required 数组');
    const listed = new Set(
      [...requiredBlock[1].matchAll(/'([^']+)'/g)]
        .map((match) => match[1])
        .filter((f) => f.startsWith(`${HELPER_DIR}/`)),
    );

    const requiredModules = [...mainSource.matchAll(/require\('\.\/([^']+\.js)'\)/g)].map((match) => match[1]);
    assert.ok(requiredModules.length > 0, 'main.js 里没找到相对 require，匹配规则需要更新');
    for (const module of requiredModules) {
      const path = `${HELPER_DIR}/${module}`;
      assert.ok(listed.has(path), `${path} 被 main.js 顶层 require，但不在 prepack-check 的必需文件清单里`);
      assert.ok(existsSync(new URL(`../../${path}`, import.meta.url)), `${path} 在仓库里不存在`);
    }
  });

  test('最近两轮 review 补录的模块仍在清单里（防止回退）', () => {
    assert.match(prepackSource, /'runtime\/electron-helper\/probe-command\.js'/);
    assert.match(prepackSource, /'runtime\/electron-helper\/control-request\.js'/);
    assert.match(prepackSource, /'runtime\/electron-helper\/tray-menu\.js'/);
  });
});
