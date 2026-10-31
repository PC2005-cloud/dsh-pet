'use strict';
/**
 * userData 目录决策：原目录不可写时退回到 $DSH_HOME 下的自有 profile。
 *
 * 只算路径与可写性，不碰 Electron；可写性必须实际写文件验证——
 * Windows 上 fs.access 只反映只读属性、不校验 ACL，受限令牌下会假阳性。
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/** 可写性探测用的临时文件名；写完立即删除。 */
const PROBE_NAME = '.dsh-pet-write-probe';

/**
 * DSH 主目录：DSH_HOME 优先，未设回落到 ~/.dsh（与宿主 dshHomeDir 同口径）。
 *
 * @param {NodeJS.ProcessEnv} [env] - 环境变量，缺省 process.env。
 * @param {string} [home] - 用户主目录，缺省 os.homedir()。
 * @returns {string} 绝对路径。
 */
function dshHomeDir(env = process.env, home = os.homedir()) {
  return env.DSH_HOME || path.join(home, '.dsh');
}

/**
 * 尝试把目录准备成可写状态：建目录、写探测文件、再删除。
 *
 * @param {string} dir - 目标目录。
 * @param {object} fileSystem - fs 兼容对象。
 * @returns {{ ok: boolean, error: Error | null }} 失败时带原始错误。
 */
function tryPrepareDir(dir, fileSystem) {
  try {
    fileSystem.mkdirSync(dir, { recursive: true });
    const probe = path.join(dir, PROBE_NAME);
    fileSystem.writeFileSync(probe, '');
    fileSystem.unlinkSync(probe);
    return { ok: true, error: null };
  } catch (error) {
    return { ok: false, error };
  }
}

/**
 * 目录是否真的可写。
 *
 * @param {string} dir - 目标目录。
 * @param {object} [deps] - `{ fs }`：测试注入的 fs 兼容对象。
 * @returns {boolean} 三步都成功才为 true。
 */
function isWritableDir(dir, deps = {}) {
  return tryPrepareDir(dir, deps.fs || fs).ok;
}

/**
 * 决定 helper 最终使用的 userData 目录：原目录可写就用原目录，否则用 DSH 目录下的 profile。
 *
 * @param {object} input - 决策输入。
 * @param {string} input.currentDir - app.getPath('userData') 的当前值。
 * @param {string} input.dshHome - DSH 主目录（见 {@link dshHomeDir}）。
 * @param {boolean} input.appMode - 是否独立应用模式；与 DSH helper 分开 profile，避免互踢。
 * @param {object} [input.fs] - 测试注入的 fs 兼容对象。
 * @returns {{ dir: string, fallback: boolean, error: Error | null }} 最终目录、是否回退、回退失败原因。
 */
function resolveUserDataDir(input) {
  const fileSystem = input.fs || fs;
  const primary = tryPrepareDir(input.currentDir, fileSystem);
  if (primary.ok) return { dir: input.currentDir, fallback: false, error: null };
  const fallbackDir = path.join(input.dshHome, 'dsh-pet', input.appMode ? 'app-profile' : 'electron-profile');
  const fallback = tryPrepareDir(fallbackDir, fileSystem);
  if (fallback.ok) return { dir: fallbackDir, fallback: true, error: null };
  return { dir: input.currentDir, fallback: false, error: fallback.error };
}

module.exports = { dshHomeDir, isWritableDir, resolveUserDataDir };
