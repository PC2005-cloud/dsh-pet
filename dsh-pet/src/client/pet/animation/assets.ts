/**
 * 动画素材的地址拼装：点播给了完整 url 就用它，否则按「素材根 + 动画名 + 扩展名」拼宿主路由。
 * 两段都过 `encodeURIComponent`——动画名与素材根都允许中文与空格，不编码会让路由匹配不上。
 * 扩展名由调用方探测后传入（`thumbExt()` 读 UA），本模块不碰浏览器环境。
 * @module dsh-pet/src/client/pet/animation/assets
 */
import { ROUTE_PATH } from '../../../shared/constants.ts';
import { encodeFrameRel, textFrameRel } from '../../../locale/text-frames.ts';
import { getHostLocale } from '../../../locale/current.ts';

/** 素材地址的输入。 */
export interface AssetSource {
  /** 第三方点播给的完整地址（已由宿主限 http/https）；给了就优先用它。 */
  cueUrl?: string | null;
  /** 素材根（= 配置文件前缀）；多实例共享同一素材目录。 */
  assetRoot: string;
  /** 宠物 id，素材根缺失时的兜底。 */
  id: string;
  /** 动画名。 */
  anim: string;
  /** 扩展名（含点，如 `.webm`）。 */
  ext: string;
}

/**
 * 拼一次动画的素材地址。
 *
 * @param source - 地址来源与标识。
 * @returns 可直接 fetch 的地址；`cueUrl` 优先。
 */
export function animationAssetUrl(source: AssetSource): string {
  if (source.cueUrl) return source.cueUrl;
  const root = source.assetRoot === '' ? source.id : source.assetRoot;
  const rel = textFrameRel(getHostLocale(), source.anim);
  return ROUTE_PATH + '/thumb/' + encodeURIComponent(root) + '/' + encodeFrameRel(rel) + source.ext;
}
