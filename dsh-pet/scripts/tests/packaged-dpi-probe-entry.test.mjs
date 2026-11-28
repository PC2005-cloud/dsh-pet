/**
 * 打包入口的 DPI 探测分叉：探测子进程必须进 helper，正式启动才进应用。
 *
 * lib/ 是构建产物，新鲜克隆里没有。应用臂用 module.register 把 `../lib/app.js`
 * 短路成空模块；helper 是 CommonJS，探测臂经 createRequire 加载，再用 Module._load 短路。
 * 只记录解析到的说明符。不执行 Electron，也不要求已经构建出 lib/app.js。
 * 跑法：node --test scripts/tests/packaged-dpi-probe-entry.test.mjs
 */
import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import Module, { register } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const APP_SPECIFIER = '../lib/app.js';
const HELPER_SPECIFIER = './electron-helper/main.js';
/** 本次 import 解析到的短路说明符，按解析顺序。 */
const resolved = [];
// register 的钩子在另一线程，空模块在主线程求值，只能经 globalThis 把说明符送回来。
globalThis.__dshPetResolved = resolved;

const bootstrapPath = fileURLToPath(new URL('../../runtime/bootstrap.mjs', import.meta.url));
const bootstrapHref = pathToFileURL(bootstrapPath).href;
const savedProbe = Object.hasOwn(process.env, 'DSH_PET_DPI_PROBE') ? process.env.DSH_PET_DPI_PROBE : undefined;
let caseSeq = 0;

const hookSource = `
export async function resolve(specifier, context, nextResolve) {
  const parentURL = String(context.parentURL ?? '');
  if (specifier === ${JSON.stringify(APP_SPECIFIER)} && parentURL.includes('bootstrap.mjs')) {
    const code =
      'globalThis.__dshPetResolved.push(' + JSON.stringify(specifier) + '); export {}; // ' + Math.random();
    return { shortCircuit: true, url: 'data:text/javascript,' + encodeURIComponent(code) };
  }
  return nextResolve(specifier, context);
}
`;
register(`data:text/javascript,${encodeURIComponent(hookSource)}`, import.meta.url);

const originalLoad = Module._load;
Module._load = function (request, parent, ...rest) {
  if (request === HELPER_SPECIFIER && String(parent?.filename ?? '').endsWith('bootstrap.mjs')) {
    resolved.push(request);
    return {};
  }
  return originalLoad.call(this, request, parent, ...rest);
};

after(() => {
  Module._load = originalLoad;
  delete globalThis.__dshPetResolved;
  if (savedProbe === undefined) delete process.env.DSH_PET_DPI_PROBE;
  else process.env.DSH_PET_DPI_PROBE = savedProbe;
});

/** 用独立查询串再求值一次入口，返回这次解析到的说明符。 */
async function loadEntry(probe) {
  if (probe === undefined) delete process.env.DSH_PET_DPI_PROBE;
  else process.env.DSH_PET_DPI_PROBE = probe;
  resolved.length = 0;
  caseSeq += 1;
  await import(`${bootstrapHref}?case=${caseSeq}`);
  return resolved.slice();
}

function packagedMain() {
  const yaml = readFileSync(new URL('../../electron-builder.yml', import.meta.url), 'utf8');
  const lines = yaml.split(/\r?\n/);
  const index = lines.indexOf('extraMetadata:');
  const match = /^  main: (\S+)$/.exec(lines[index + 1] ?? '');
  return match?.[1];
}

describe('打包入口在 DPI 探测重新进入前分叉', { concurrency: false }, () => {
  test('DSH_PET_DPI_PROBE=1：解析 helper，且打包 main 指向 bootstrap', async () => {
    assert.deepEqual(await loadEntry('1'), ['./electron-helper/main.js']);
    assert.equal(packagedMain(), 'runtime/bootstrap.mjs');
  });

  test('未设置 DSH_PET_DPI_PROBE：解析应用入口', async () => {
    assert.deepEqual(await loadEntry(undefined), ['../lib/app.js']);
  });

  test('空串与 0 走应用臂；插件 main 仍是 lib/index.js', async () => {
    assert.deepEqual(await loadEntry(''), ['../lib/app.js']);
    assert.deepEqual(await loadEntry('0'), ['../lib/app.js']);
    const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
    assert.equal(pkg.main, 'lib/index.js');
  });
});
