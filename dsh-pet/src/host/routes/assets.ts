/**
 * 静态素材：/font、/pic（含表情包链）、/sound、/thumb 的取文件与路径守卫。
 *
 * 不决定素材归属，只按给定目录链查找。
 * 依赖（PetRouteDeps）显式传入，模块内不读全局、不建状态。
 * @module dsh-pet/src/host/routes/assets
 */
import { join } from 'node:path';
import { PACKAGE_ROOT } from '../paths.ts';
import { MIME, resolveAsset, resolveExisting } from '../http.ts';
import { isValidPetId } from '../config.ts';
import { petAvatarFile } from '../pet-avatar.ts';
import { existsSync } from 'node:fs';
import type { PetRouteDeps, RouteInput } from './types.ts';
import type { RouteResult } from '../http.ts';

/** 静态素材领域：未命中返回 undefined，命中返回应答。 */
export async function handleAssetsRoutes(deps: PetRouteDeps, input: RouteInput): Promise<RouteResult | undefined> {
  const { assetRootFor, memeDirsFor, petConfigDir, userRootFor } = deps;
  const { rest, url } = input;

  // 动画素材：/thumb/<素材根>/<file>，扩展名 webm（默认）/ mov（macOS 定制）。
  // 存在 `pet/<素材根>-animation/` 的宠物只查自己的目录，查不到即 404，绝不混用；
  // 否则走主素材链：用户 main-animation/<ext> 优先 → 包内 assets/<ext>（所有主配置宠物共用）。
  // mov（HEVC-with-Alpha）不随包发布，用户从 GitHub Release 下载后放 main-animation/mov/，
  // 并把客户端播放常量 ANIMATION_EXT 改为 .mov。
  // font / pic 是扁平的 /<scope>/<file>，只有 thumb 是 /<scope>/<petId>/<file>：先拆 scope 再各自拆剩余段。
  const [scope, ...restParts] = rest.split('/');

  // 插件 logo / 宠物头像：/logo → 包内 assets/logo.png。只放行这一个文件——不把 assets 根开放成静态目录
  // （同目录还有 config.jsonc）。对话面板拿它当宠物头像。
  // 带 ?root=<素材根> 时先找该宠物的自定义头像（pet/<素材根>-avatar.<ext>），没有就回退包内 logo：
  // 「没上传过」与「上传后又删掉」都由这一处兜底，前端不必区分。
  // main 不查自定义文件：pet/ 只归 pet pack，内置条目永远用包内 logo。
  // 参数叫 root 而不是 pet：这里要的是素材根（目录前缀），不是 pets[].id。
  if (scope === 'logo') {
    if (restParts.length > 0) return { kind: 'text', status: 400, body: 'dsh-pet: expected /dsh-pet-7340/logo' };
    const assetRoot = (url.searchParams.get('root') ?? '').trim();
    if (assetRoot !== '' && assetRoot !== 'main') {
      // 素材根是标识符不是路径片段：含分隔符/保留字符即显式 400，早于任何路径拼接。
      if (!isValidPetId(assetRoot)) return { kind: 'text', status: 400, body: 'dsh-pet: invalid asset root' };
      const own = petAvatarFile(petConfigDir, assetRoot);
      if (own !== undefined) return { kind: 'file', file: own.file, contentType: own.contentType };
    }
    const logo = resolveExisting(join(PACKAGE_ROOT, 'assets'), 'logo.png');
    if (logo === undefined) return { kind: 'text', status: 404, body: 'dsh-pet: logo not found' };
    return { kind: 'file', file: logo, contentType: MIME['.png'] ?? 'image/png' };
  }

  if (scope === 'font') {
    const fontRoot = join(PACKAGE_ROOT, 'assets', 'fonts');
    const fontFile = resolveExisting(fontRoot, restParts.join('/'));
    if (fontFile === undefined) return { kind: 'text', status: 404, body: 'dsh-pet: font not found' };
    const ext = fontFile.slice(fontFile.lastIndexOf('.')).toLowerCase();
    return { kind: 'file', file: fontFile, contentType: MIME[ext] ?? 'application/octet-stream' };
  }

  // 通知图标：/pic/<file> → 包内 assets/pic（方形 png，系统通知 icon 用）。
  // 表情包：/pic/memes/<素材根>/<名称>.png → 按素材根走 memeDirsFor 的目录链，与 /thumb 同一套
  // 归属语义；名称含中文，URL 段已在上方解码。旧的两段形式 /pic/memes/<名称>.png 保留，
  // 等价于素材根 main 的目录链。
  if (scope === 'pic') {
    if (restParts[0] === 'memes') {
      const segs = restParts.slice(1);
      // 段数 ≥ 2 = <素材根>/<名称…>；恰好 1 段 = 旧扁平形式。表情包名称即文件名（不含子目录），
      // 所以两种形式不歧义；素材根与 /thumb 的 petId 同规矩：含分隔符 / 保留字符即显式 400。
      const scoped = segs.length >= 2;
      const assetRoot = scoped ? segs[0] : 'main';
      if (scoped && !isValidPetId(assetRoot)) {
        return { kind: 'text', status: 400, body: 'dsh-pet: invalid asset root' };
      }
      const rel = (scoped ? segs.slice(1) : segs).join('/');
      let picFile: string | undefined;
      for (const dir of memeDirsFor(assetRoot)) {
        picFile = resolveExisting(dir, rel);
        if (picFile !== undefined) break;
      }
      if (picFile === undefined) return { kind: 'text', status: 404, body: 'dsh-pet: pic not found' };
      const ext = picFile.slice(picFile.lastIndexOf('.')).toLowerCase();
      return { kind: 'file', file: picFile, contentType: MIME[ext] ?? 'application/octet-stream' };
    }
    const picRoot = join(PACKAGE_ROOT, 'assets', 'pic');
    const picFile = resolveExisting(picRoot, restParts.join('/'));
    if (picFile === undefined) return { kind: 'text', status: 404, body: 'dsh-pet: pic not found' };
    const ext = picFile.slice(picFile.lastIndexOf('.')).toLowerCase();
    return { kind: 'file', file: picFile, contentType: MIME[ext] ?? 'application/octet-stream' };
  }

  // 点击音效：/dsh-pet-7340/sound/<file> → 包内 assets/sound（当前只有 click-duck.wav）。
  // 与 font 同一种扁平形式（<scope>/<file>）：只有包内一份，不做用户目录覆盖。
  if (scope === 'sound') {
    const soundRoot = join(PACKAGE_ROOT, 'assets', 'sound');
    const soundFile = resolveExisting(soundRoot, restParts.join('/'));
    if (soundFile === undefined) return { kind: 'text', status: 404, body: 'dsh-pet: sound not found' };
    const ext = soundFile.slice(soundFile.lastIndexOf('.')).toLowerCase();
    return { kind: 'file', file: soundFile, contentType: MIME[ext] ?? 'application/octet-stream' };
  }

  if (scope !== 'thumb') {
    return { kind: 'text', status: 400, body: 'dsh-pet: expected /dsh-pet-7340/thumb/<petId>/<file>' };
  }

  // thumb 是三段式：/<scope>/<petId>/<file>——从这里再拆宠物 id 与文件名
  const [petId, ...nameParts] = restParts;

  if (!petId || nameParts.length === 0) {
    return { kind: 'text', status: 400, body: 'dsh-pet: expected /dsh-pet-7340/thumb/<petId>/<file>' };
  }

  // petId 是标识符（= pet/<名>-animation/ 的 <名>，来源是 pet/ 下的文件名前缀），不是路径片段：
  // 含分隔符/保留字符即显式 400，早于任何路径拼接判定。合法名（含中文）照常——
  // 用非法字符类而不是 ASCII 白名单。非法输入不再静默回落到主素材池（攻击尝试与「没有独立素材」可区分），
  // 也给下面的 resolveAsset 之外再留一道结构性防线。
  if (!isValidPetId(petId)) {
    return { kind: 'text', status: 400, body: 'dsh-pet: invalid pet id' };
  }

  const fileName = nameParts.join('/');

  const ext = fileName.slice(fileName.lastIndexOf('.')).toLowerCase();

  if (ext !== '.webm' && ext !== '.mov') {
    return { kind: 'text', status: 400, body: 'dsh-pet: unsupported animation format (expected .webm or .mov)' };
  }

  // 素材归属：存在 `pet/<素材根>-animation/` 只查自己目录（唯一例外：mov 缺失时退回同名 webm），
  // 否则走主素材链。extraAnimDir 必须先过 resolveAsset：petId 是解码后的 URL 段，Windows 上 %5C
  // 解出的反斜杠不会被 split('/') 切开，直接 join 会让 `..\..\x` 逃出用户根读盘。
  const extraAnimDir = resolveAsset(petConfigDir, petId + '-animation');

  /** 按扩展名查同名素材（专属目录优先；否则用户根 → 包内根） */
  const findAnim = (e: string): string | undefined => {
    const name = fileName.replace(/\.(webm|mov)$/i, '') + e;
    return extraAnimDir !== undefined && existsSync(extraAnimDir)
      ? resolveExisting(extraAnimDir, name)
      : (resolveExisting(userRootFor(e), name) ?? resolveExisting(assetRootFor(e), name));
  };

  let file = findAnim(ext);

  let servedExt = ext;

  // mov（HEVC-with-Alpha，macOS 定制）不随包发布：缺失时退回同名 webm。
  // 宿主是唯一知道素材在不在的一方——宁可让 Safari 播黑底（webm 的 alpha 被丢弃），
  // 也不能让整段动画 404（表现就是宠物完全不显示）。
  if (file === undefined && ext === '.mov') {
    const fb = findAnim('.webm');
    if (fb !== undefined) {
      file = fb;
      servedExt = '.webm';
    }
  }

  if (file === undefined) return { kind: 'text', status: 404, body: 'dsh-pet: asset not found' };

  return { kind: 'file', file, contentType: MIME[servedExt] ?? 'application/octet-stream' };
}
