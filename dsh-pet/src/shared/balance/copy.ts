/**
 * 余额气泡文案：走固定文案目录，随 getHostLocale() 切换。
 * @module dsh-pet/src/shared/balance/copy
 */
import { getHostLocale } from '../../locale/current.ts';
import { chromeText, fillChrome, type ChromeKey } from '../../locale/chrome.ts';

/** 当前宿主语言下的余额气泡固定文案。 */
export function balanceText(key: ChromeKey): string {
  return chromeText(getHostLocale(), key);
}

/** 带占位符的余额气泡文案。 */
export function balanceFill(key: ChromeKey, vars: Readonly<Record<string, string | number>>): string {
  return fillChrome(getHostLocale(), key, vars);
}
