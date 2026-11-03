/**
 * 包内路径常量：包根与素材根的唯一来源，宿主装配与路由层共用。
 *
 * 只做路径计算，不读盘、不判断存在性；解析出的目录是否可用由调用方决定。
 * 必须始终成立：所有素材路径都从 PACKAGE_ROOT 派生，不得在别处另算一份 `new URL('..', import.meta.url)`。
 * @module dsh-pet/src/host/paths
 */
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 本包目录：宿主构建产物位于 lib/，其上一级即包根。 */
export const PACKAGE_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));

/** 包内 assets 根 */
export const PACKAGE_ROOT_ASSETS = join(PACKAGE_ROOT, 'assets');

/** 台词内容文件：包根目录 learningTxt.json，`{ 名称: [台词行...] }`，GET /learningTxt 读它。 */
export const LEARNING_TXT_PATH = join(PACKAGE_ROOT, 'learningTxt.json');

/** 包内表情包目录（表情包池的最后一环：assets/memes/<名称>.png） */
export const PACKAGE_MEMES_DIR = join(PACKAGE_ROOT_ASSETS, 'memes');
