/**
 * 精选插件入口 tab 的客户端半接入：dsh-featured 完整版未装时在插件页提供引导安装位。
 * 完整版已加载（`window.__DSH_FEATURED_FULL__`）即自动让位；与其它接入方共用
 * `window.__DSH_FEATURED_APPLIED__` 判重，保证「精选插件」永远只渲染一个 tab。
 * 文案复用设置页字典的 featured.* 键（8 语言投影），不在本文件另立字典。
 * @module dsh-pet/src/client/featured-entry
 */
import type * as ReactNS from 'react';
import { NS } from './settings/locales/index.ts';

declare global {
  interface Window {
    /** 任一接入方已挂精选入口的判重标记；本入口卸载时复位为 false。 */
    __DSH_FEATURED_APPLIED__?: boolean;
    /** 完整版 dsh-featured 加载后置真：轻量入口检测到即让位，不再注册。 */
    __DSH_FEATURED_FULL__?: boolean;
  }
}

/** 完整版包名（生态约定：一键安装的目标）。 */
const FULL_PKG = 'dsh-featured';

/** install 返回的卸载函数。 */
type Disposer = () => void;

/** react 原语注入：client 半侧 react 由宿主种子提供，全部经 factory 传入。 */
export interface FeaturedEntryDeps {
  createElement: typeof ReactNS.createElement;
  useState: typeof ReactNS.useState;
  useEffect: typeof ReactNS.useEffect;
}

/**
 * 造精选入口安装器：react 原语由 factory 注入，安装器在每次激活时对 ctx 调用。
 * @param deps - createElement / useState / useEffect，全部来自宿主注入的 react。
 * @returns install(ctx) —— 注册 plugins.tab 插槽并返回卸载函数（复位判重标记）。
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- DSH 注入的 ctx（slots/locale）无静态类型
export function makeFeaturedEntry(deps: FeaturedEntryDeps): (ctx: any) => Disposer {
  const { createElement, useState, useEffect } = deps;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- DSH 注入的 ctx（slots/locale）无静态类型
  return function installFeaturedEntry(ctx: any): Disposer {
    if (typeof window === 'undefined') return () => {};
    if (window.__DSH_FEATURED_APPLIED__) return () => {};
    window.__DSH_FEATURED_APPLIED__ = true;
    if (window.__DSH_FEATURED_FULL__) {
      // 完整版 dsh-featured 已加载：让位，保证永远只有一个精选 tab。
      return () => {
        window.__DSH_FEATURED_APPLIED__ = false;
      };
    }
    const t = ctx.locale.bind(NS);
    const slotProps = {
      name: 'plugins.tab',
      id: 'dsh-plugins-plugin',
      label: () => t('featured.tabLabel'),
      priority: 100,
    };

    function FeaturedSection(props: { install?: unknown }) {
      const install = props.install; // 宿主注入：免表单直接安装（等价用户已确认）
      const [st, setSt] = useState<'idle' | 'running' | 'installed'>('idle');
      const openInstall = () => {
        if (st !== 'idle' || typeof install !== 'function') return;
        setSt('running');
        try {
          install({ spec: FULL_PKG, title: t('featured.tabLabel'), version: '' });
          setSt('installed');
        } catch {
          setSt('installed');
        }
      };
      // 挂载即装：入口 tab 的唯一职责就是引导安装完整版，不需要用户再点一次确认。
      useEffect(() => {
        if (st !== 'idle') return;
        if (typeof install !== 'function') {
          setSt('installed');
          return;
        }
        setSt('running');
        try {
          install({ spec: FULL_PKG, title: t('featured.tabLabel'), version: '' });
          setSt('installed');
        } catch {
          setSt('installed');
        }
      }, [st, install]);
      const label =
        st === 'running'
          ? t('featured.installing')
          : st === 'installed'
            ? t('featured.installedShort')
            : t('featured.installFull');
      return createElement(
        'div',
        { style: { padding: '24px 16px', maxWidth: 560, display: 'flex', flexDirection: 'column', gap: 12 } },
        createElement('p', { style: { fontSize: 13, lineHeight: 1.7, margin: 0, opacity: 0.75 } }, t('featured.desc')),
        st === 'idle'
          ? createElement('p', { style: { fontSize: 13, lineHeight: 1.7, margin: 0 } }, t('featured.welcome'))
          : null,
        createElement(
          'button',
          {
            type: 'button',
            style: {
              alignSelf: 'flex-start',
              cursor: st === 'installed' ? 'default' : 'pointer',
              font: 'inherit',
              fontSize: 13,
              fontWeight: 500,
              padding: '7px 16px',
              borderRadius: 8,
              border: '1px solid rgba(127,127,127,.35)',
              background: '#4f6ef7',
              color: '#fff',
              opacity: st === 'installed' ? 0.6 : 1,
            },
            disabled: st === 'installed',
            onClick: openInstall,
          },
          label,
        ),
      );
    }

    ctx.slots.inject('plugins.tab', () => ctx.slots.register(slotProps, FeaturedSection));
    return () => {
      window.__DSH_FEATURED_APPLIED__ = false;
    };
  };
}
