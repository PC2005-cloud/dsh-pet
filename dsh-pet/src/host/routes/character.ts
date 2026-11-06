/**
 * 角色参考图：`GET /character?root=<素材根>`，按素材根回一张图片字节。
 *
 * 单独成端点而不并进 `/pic`：pic 的定义是通知图标与表情包，角色图混进去后文档与目录都会失真。
 * 归属沿用头像那套命名（`<素材根>-character.<ext>`），用户目录优先、包内兜底。
 * 不生成图片：只交付「什么叫像这只角色」，出图与计费都在调用方。
 * @module dsh-pet/src/host/routes/character
 */
import { join } from 'node:path';
import { isValidPetId } from '../config.ts';
import { MIME, resolveExisting } from '../http.ts';
import { PACKAGE_ROOT } from '../paths.ts';
import type { PetRouteDeps, RouteInput } from './types.ts';
import type { RouteResult } from '../http.ts';

/** 包内 assets 根：角色图按 `<素材根>-character.<ext>` 平铺在这里，与 `logo.png` 同层。 */
const PACKAGE_ASSETS_DIR = join(PACKAGE_ROOT, 'assets');

/** 探测顺序：正常只有一份，顺序只影响多份并存时取哪一份。 */
const CHARACTER_EXTS: readonly string[] = ['.png', '.jpg', '.jpeg', '.webp', '.gif'];

/** 命中的角色图：绝对路径与按扩展名推出的 Content-Type。 */
interface CharacterFile {
  readonly file: string;
  readonly contentType: string;
}

/**
 * 角色图领域：未命中返回 undefined，命中返回应答。
 *
 * 不校验方法，与 `/logo`、`/thumb`、`/pic` 一族保持一致：素材端点只看路径。要做方法校验就整族一起加。
 * 写成 `rest === 'character'` 的正向分支而不是反向守卫：scripts/check-openapi.mjs 按这个
 * 字面量收集宿主实现的路由，反向写法会让文档里的路径被误报成「实现里不存在」。
 */
export async function handleCharacterRoutes(deps: PetRouteDeps, input: RouteInput): Promise<RouteResult | undefined> {
  if (input.rest !== 'character') return undefined;

  // 参数叫 root 而不是 pet：这里要的是素材根（目录前缀），不是 pets[].id（同 /logo 与 /pet-avatar）。
  const assetRoot = (input.url.searchParams.get('root') ?? '').trim();
  if (assetRoot === '') {
    return { kind: 'text', status: 400, body: 'dsh-pet: expected /dsh-pet-7340/character?root=<素材根>' };
  }
  // 素材根是标识符不是路径片段：含分隔符/保留字符即拒，早于任何路径拼接。
  if (!isValidPetId(assetRoot)) return { kind: 'text', status: 400, body: 'dsh-pet: invalid asset root' };

  const found = findCharacter(deps.petConfigDir, assetRoot);
  if (found === undefined) return { kind: 'text', status: 404, body: 'dsh-pet: character not found' };
  return { kind: 'file', file: found.file, contentType: found.contentType };
}

/**
 * 按素材根找角色图：`pet/` 优先，包内兜底。
 *
 * 扩展名只走白名单，不按目录扫描：用户目录里可能有别的文件，扫描会把无关文件当成角色图。
 * @param petDir - `pet/` 目录（pet pack 素材根所在处）。
 * @param assetRoot - 已校验的素材根。
 * @returns 命中的文件；都没有时 undefined。
 */
function findCharacter(petDir: string, assetRoot: string): CharacterFile | undefined {
  const name = assetRoot + '-character';
  // 目录在外层、扩展名在内层：用户目录里的任意一份都先于包内，避免用户的 webp 被包内 png 顶掉。
  for (const dir of [petDir, PACKAGE_ASSETS_DIR]) {
    for (const ext of CHARACTER_EXTS) {
      const hit = resolveExisting(dir, name + ext);
      if (hit !== undefined) return { file: hit, contentType: MIME[ext] ?? 'application/octet-stream' };
    }
  }
  return undefined;
}
