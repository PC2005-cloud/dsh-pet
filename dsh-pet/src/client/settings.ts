/**
 * 桌宠配置管理设置页（settings.section 插槽，id: pet-config）
 *
 * - 可配置项：大小 size（px）、位置 corner（四角）、边距 marginX/marginY
 * - 保存：PUT /pet/config → 落盘到用户覆盖层（$DSH_HOME/pet-config.json），
 *   并由 petBridge.apply 即时生效（同 bundle 单例，无需刷新页面）
 * - 恢复默认：DELETE /pet/config（删用户层）→ 拉取包内 config.jsonc 默认值即时应用
 *
 * 样式对齐官方设置页：max-width 720px、全走 --dsw-alias-* 语义 token（主题跟随）。
 */
import type { Corner } from './types';

/** 设置页表单值 */
export interface PetConfigUI {
  size: number;
  corner: Corner;
  marginX: number;
  marginY: number;
}

/** 兜底默认值（与 config.jsonc / Pet 初始状态一致） */
export const DEFAULT_UI: PetConfigUI = { size: 462, corner: 'bottom-right', marginX: 24, marginY: 0 };

/** Pet 与设置页共享的桥（同一 bundle 单例）：current=最新值；apply=Pet 注册的即时生效回调 */
export const petBridge: {
  current: PetConfigUI | null;
  apply: null | ((c: PetConfigUI) => void);
} = { current: null, apply: null };

/** 字典命名空间 */
export const NS = 'pet.config';

export const zh = {
  nav: '桌宠配置',
  intro: '调整桌宠的大小与位置（保存后即时生效，无需刷新页面）。',
  sizeLabel: '大小（宽度 px）',
  sizeHint: '高度自动 = 宽度 × 9/16。',
  cornerLabel: '位置',
  'corner.top-left': '左上角',
  'corner.top-right': '右上角',
  'corner.bottom-left': '左下角',
  'corner.bottom-right': '右下角',
  marginLabel: '边距',
  marginX: '水平偏移',
  marginY: '垂直偏移',
  save: '保存',
  reset: '恢复默认',
  saved: '已保存，桌宠即时生效。',
  loadError: '加载配置失败',
  invalid: '请检查输入：大小需为正数，边距可为任意数字。',
  busy: '保存中…',
};

export const en = {
  nav: 'Pet Config',
  intro: 'Adjust the pet\'s size and position (applies instantly after saving, no page refresh needed).',
  sizeLabel: 'Size (width px)',
  sizeHint: 'Height is automatic = width × 9/16.',
  cornerLabel: 'Position',
  'corner.top-left': 'Top-left',
  'corner.top-right': 'Top-right',
  'corner.bottom-left': 'Bottom-left',
  'corner.bottom-right': 'Bottom-right',
  marginLabel: 'Margin',
  marginX: 'Horizontal offset',
  marginY: 'Vertical offset',
  save: 'Save',
  reset: 'Reset to default',
  saved: 'Saved — the pet updated instantly.',
  loadError: 'Failed to load config',
  invalid: 'Check your input: size must be positive; margins can be any number.',
  busy: 'Saving…',
};

/** 设置页组件工厂：h / hooks / t 由 factory 的 require 与 locale 注入（不顶层 import react） */
export function makePetConfigSection(rt: {
  h: any;
  useState: <T>(init: T) => [T, (v: T) => void];
  t: (key: string) => string;
}): (props: { close?: () => void }) => any {
  const { h, useState, t } = rt;

  const CORNERS: Corner[] = ['top-left', 'top-right', 'bottom-left', 'bottom-right'];
  const cornerLabel = (c: Corner): string => t('corner.' + c);

  return function PetConfigSection() {
    const init = petBridge.current ?? DEFAULT_UI;
    const [size, setSize] = useState(String(init.size));
    const [corner, setCorner] = useState(init.corner);
    const [marginX, setMarginX] = useState(String(init.marginX));
    const [marginY, setMarginY] = useState(String(init.marginY));
    const [busy, setBusy] = useState(false);
    const [msg, setMsg] = useState<{ kind: 'ok' | 'err' | ''; text: string }>({ kind: '', text: '' });

    const inputStyle = {
      boxSizing: 'border-box',
      border: '1px solid var(--dsw-alias-border-l2)',
      borderRadius: '8px',
      background: 'var(--dsw-alias-bg-layer-1)',
      color: 'var(--dsw-alias-label-primary)',
      padding: '5px 10px',
      fontSize: '13px',
      minHeight: '28px',
      outline: 'none',
    } as any;

    const collect = (): PetConfigUI | null => {
      const sz = Number(size);
      const mx = Number(marginX);
      const my = Number(marginY);
      if (!Number.isFinite(sz) || sz <= 0 || !Number.isFinite(mx) || !Number.isFinite(my)) {
        setMsg({ kind: 'err', text: t('invalid') });
        return null;
      }
      return { size: sz, corner, marginX: mx, marginY: my };
    };

    const save = async () => {
      const c = collect();
      if (!c) return;
      setBusy(true);
      setMsg({ kind: '', text: '' });
      try {
        const res = await fetch('/pet/config', {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ size: c.size, position: { corner: c.corner, marginX: c.marginX, marginY: c.marginY } }),
        });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        petBridge.current = c;
        petBridge.apply?.(c);
        setMsg({ kind: 'ok', text: t('saved') });
      } catch {
        setMsg({ kind: 'err', text: t('loadError') });
      } finally {
        setBusy(false);
      }
    };

    const stripJsonc = (src: string): string =>
      src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^\\:])\/\/.*$/gm, '$1').trim();

    const reset = async () => {
      setBusy(true);
      setMsg({ kind: '', text: '' });
      try {
        await fetch('/pet/config', { method: 'DELETE' });
        const defRes = await fetch('/pet/config.jsonc');
        const obj = JSON.parse(stripJsonc(await defRes.text()));
        const d: PetConfigUI = {
          size: Number(obj.size) > 0 ? Number(obj.size) : DEFAULT_UI.size,
          corner: (CORNERS as string[]).includes(obj?.position?.corner) ? (obj.position.corner as Corner) : DEFAULT_UI.corner,
          marginX: Number.isFinite(Number(obj?.position?.marginX)) ? Number(obj.position.marginX) : DEFAULT_UI.marginX,
          marginY: Number.isFinite(Number(obj?.position?.marginY)) ? Number(obj.position.marginY) : DEFAULT_UI.marginY,
        };
        setSize(String(d.size));
        setCorner(d.corner);
        setMarginX(String(d.marginX));
        setMarginY(String(d.marginY));
        petBridge.current = d;
        petBridge.apply?.(d);
        setMsg({ kind: 'ok', text: t('saved') });
      } catch {
        setMsg({ kind: 'err', text: t('loadError') });
      } finally {
        setBusy(false);
      }
    };

    return h(
      'section',
      {
        style: { maxWidth: '720px', color: 'var(--dsw-alias-label-primary)', display: 'flex', flexDirection: 'column', gap: '6px' },
        children: [
          h('h2', { style: { margin: 0, fontSize: '16px', fontWeight: 500, lineHeight: '24px' }, children: t('nav') }),
          h('p', { style: { margin: 0, fontSize: '14px', color: 'var(--dsw-alias-label-tertiary)', lineHeight: '22px' }, children: t('intro') }),
          h('div', { style: { display: 'flex', gap: '16px', flexWrap: 'wrap', marginTop: '8px' }, children: [
        h('label', { style: { display: 'flex', flexDirection: 'column', gap: '4px', fontSize: '12px', color: 'var(--dsw-alias-label-secondary)' }, children: [
          t('sizeLabel'),
          h('input', {
            type: 'number', min: '120', max: '1200', step: '10',
            value: size,
            disabled: busy,
            onChange: (e: any) => setSize(e.target.value),
            style: { width: '150px', ...inputStyle },
          }),
          h('span', { style: { fontSize: '11px', color: 'var(--dsw-alias-label-tertiary)' }, children: t('sizeHint') }),
        ] }),
        h('label', { style: { display: 'flex', flexDirection: 'column', gap: '4px', fontSize: '12px', color: 'var(--dsw-alias-label-secondary)' }, children: [
          t('cornerLabel'),
          h('select', {
            value: corner,
            disabled: busy,
            onChange: (e: any) => setCorner(e.target.value as Corner),
            style: { width: '160px', ...inputStyle },
            children: CORNERS.map((c) => h('option', { key: c, value: c, children: cornerLabel(c) })),
          }),
        ] }),
        h('label', { style: { display: 'flex', flexDirection: 'column', gap: '4px', fontSize: '12px', color: 'var(--dsw-alias-label-secondary)' }, children: [
          t('marginX'),
          h('input', {
            type: 'number', step: '1',
            value: marginX,
            disabled: busy,
            onChange: (e: any) => setMarginX(e.target.value),
            style: { width: '120px', ...inputStyle },
          }),
        ] }),
        h('label', { style: { display: 'flex', flexDirection: 'column', gap: '4px', fontSize: '12px', color: 'var(--dsw-alias-label-secondary)' }, children: [
          t('marginY'),
          h('input', {
            type: 'number', step: '1',
            value: marginY,
            disabled: busy,
            onChange: (e: any) => setMarginY(e.target.value),
            style: { width: '120px', ...inputStyle },
          }),
        ] }),
      ] }),
      h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center', marginTop: '4px' }, children: [
        h('button', {
          type: 'button', disabled: busy, onClick: save,
          style: { border: '1px solid var(--dsw-alias-button-info-fill)', background: 'var(--dsw-alias-button-info-fill)', color: '#fff', borderRadius: '8px', padding: '4px 14px', fontSize: '12px', cursor: 'pointer', opacity: busy ? 0.5 : 1 },
          children: t('save'),
        }),
        h('button', {
          type: 'button', disabled: busy, onClick: reset,
          style: { border: '1px solid var(--dsw-alias-border-l2)', background: 'transparent', color: 'var(--dsw-alias-label-primary)', borderRadius: '8px', padding: '4px 14px', fontSize: '12px', cursor: 'pointer', opacity: busy ? 0.5 : 1 },
          children: t('reset'),
        }),
        msg.text ? h('span', { style: { fontSize: '12px', color: msg.kind === 'err' ? 'var(--dsw-alias-state-error-primary)' : 'var(--dsw-alias-state-ok-primary)', marginLeft: '4px' }, children: msg.text }) : null,
      ] }),
    ] });
  };
}