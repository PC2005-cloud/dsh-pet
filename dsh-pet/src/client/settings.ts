/**
 * 桌宠配置管理设置页（settings.section 插槽，id: pet-config）
 *
 * - 多开：管理多个桌宠，每个宠物独立 id/size/位置（corner + marginX/Y）
 * - 数据流：设置页持有「合并后的完整宠物列表」→ 保存时全量 PUT /pet/config
 *   （用户覆盖层 = 完整列表，加载时全量替换默认，天然支持增删）
 * - 即时生效：保存/恢复默认后调用 petBridge.sync 通知容器重新渲染，无需刷新页面
 *
 * 样式对齐官方设置页：max-width 720px、全走 --dsw-alias-* 语义 token（主题跟随）。
 */
import type { Corner } from './types';

/** 单个宠物配置 */
export interface PetConfigUI {
  id: string;
  size: number;
  corner: Corner;
  marginX: number;
  marginY: number;
}

/** 兜底默认（与 config.jsonc 的 pets[0]（main）一致） */
export const DEFAULT_PETS: PetConfigUI[] = [
  { id: 'main', size: 462, corner: 'top-right', marginX: 24, marginY: 100 },
];

/** 容器与设置页共享的桥（同一 bundle 单例）：
 * current=最新完整宠物列表；sync=容器注册的重渲染回调（保存/恢复默认时调用）；
 * template=config.jsonc 默认宠物模板（pets[0]），「添加宠物」用它作为默认配置 */
export const petBridge: {
  current: PetConfigUI[] | null;
  sync: null | ((pets: PetConfigUI[]) => void);
  template: PetConfigUI | null;
} = { current: null, sync: null, template: null };

/** 字典命名空间 */
export const NS = 'pet.config';

export const zh = {
  nav: '桌宠配置',
  intro: '管理多个桌宠：每个宠物可独立设置大小与位置（保存后即时生效）。',
  petsLabel: '宠物列表',
  add: '添加宠物',
  remove: '删除',
  atLeastOne: '至少保留一个宠物。',
  emptyPets: '暂无宠物，点击「添加宠物」创建。',
  sizeLabel: '大小（宽度 px）',
  sizeHint: '高度自动 = 宽度 × 9/16。',
  cornerLabel: '位置',
  'corner.top-left': '左上角',
  'corner.top-right': '右上角',
  'corner.bottom-left': '左下角',
  'corner.bottom-right': '右下角',
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
  intro: 'Manage multiple pets: each pet has its own size and position (applies instantly after saving).',
  petsLabel: 'Pets',
  add: 'Add pet',
  remove: 'Remove',
  atLeastOne: 'Keep at least one pet.',
  emptyPets: 'No pets yet — click "Add pet" to create one.',
  sizeLabel: 'Size (width px)',
  sizeHint: 'Height is automatic = width × 9/16.',
  cornerLabel: 'Position',
  'corner.top-left': 'Top-left',
  'corner.top-right': 'Top-right',
  'corner.bottom-left': 'Bottom-left',
  'corner.bottom-right': 'Bottom-right',
  marginX: 'Horizontal offset',
  marginY: 'Vertical offset',
  save: 'Save',
  reset: 'Reset to default',
  saved: 'Saved — the pets updated instantly.',
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

  const stripJsonc = (src: string): string =>
    src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^\\:])\/\/.*$/gm, '$1').trim();

  /** 生成一个未占用的宠物 id（pet-2、pet-3…） */
  const nextId = (list: PetConfigUI[]): string => {
    let n = 2;
    for (;; n++) {
      const id = 'pet-' + n;
      if (!list.some((p) => p.id === id)) return id;
    }
  };

  const normalizePet = (p: any): PetConfigUI => {
    const pos = p && p.position && typeof p.position === 'object' ? p.position : {};
    return {
      id: String(p && p.id ? p.id : 'main'),
      size: Number(p && p.size) > 0 ? Number(p.size) : DEFAULT_PETS[0].size,
      corner: (CORNERS as string[]).includes(pos.corner) ? (pos.corner as Corner) : DEFAULT_PETS[0].corner,
      marginX: Number.isFinite(Number(pos.marginX)) ? Number(pos.marginX) : DEFAULT_PETS[0].marginX,
      marginY: Number.isFinite(Number(pos.marginY)) ? Number(pos.marginY) : DEFAULT_PETS[0].marginY,
    };
  };

  /** 从 config.jsonc 对象提取默认宠物列表：必须为 pets 数组；缺失/为空回落代码兜底 DEFAULT_PETS */
  const defaultsFrom = (obj: any): PetConfigUI[] => {
    const arr = obj && Array.isArray(obj.pets) ? obj.pets.filter((p: any) => p && p.id).map(normalizePet) : [];
    return arr.length ? arr : DEFAULT_PETS.map((p) => ({ ...p }));
  };

  return function PetConfigSection() {
    const initPets = petBridge.current ?? DEFAULT_PETS;
    const [pets, setPets] = useState<PetConfigUI[]>(initPets.map((p) => ({ ...p })));
    const [selId, setSelId] = useState<string>(initPets[0]?.id ?? '');
    const [busy, setBusy] = useState(false);
    const [msg, setMsg] = useState<{ kind: 'ok' | 'err' | ''; text: string }>({ kind: '', text: '' });

    const sel = pets.find((p) => p.id === selId) ?? pets[0] ?? null;

    const updateSel = (patch: Partial<PetConfigUI>) =>
      setPets((list) => list.map((p) => (p.id === (sel?.id ?? '') ? { ...p, ...patch } : p)));

    const validated = (): PetConfigUI[] | null => {
      for (const p of pets) {
        if (!Number.isFinite(p.size) || p.size <= 0 || !Number.isFinite(p.marginX) || !Number.isFinite(p.marginY)) {
          setMsg({ kind: 'err', text: t('invalid') });
          return null;
        }
      }
      return pets;
    };

    const save = async () => {
      const list = validated();
      if (!list) return;
      setBusy(true);
      setMsg({ kind: '', text: '' });
      try {
        const res = await fetch('/pet/config', {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            pets: list.map((p) => ({ id: p.id, size: p.size, position: { corner: p.corner, marginX: p.marginX, marginY: p.marginY } })),
          }),
        });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        petBridge.current = list;
        petBridge.sync?.(list);
        setMsg({ kind: 'ok', text: t('saved') });
      } catch {
        setMsg({ kind: 'err', text: t('loadError') });
      } finally {
        setBusy(false);
      }
    };

    const reset = async () => {
      setBusy(true);
      setMsg({ kind: '', text: '' });
      try {
        await fetch('/pet/config', { method: 'DELETE' });
        const defRes = await fetch('/pet/config.jsonc');
        const obj = JSON.parse(stripJsonc(await defRes.text()));
        const defs = defaultsFrom(obj);
        setPets(defs.map((p) => ({ ...p })));
        setSelId(defs[0]?.id ?? '');
        petBridge.current = defs;
        petBridge.sync?.(defs);
        setMsg({ kind: 'ok', text: t('saved') });
      } catch {
        setMsg({ kind: 'err', text: t('loadError') });
      } finally {
        setBusy(false);
      }
    };

    const addPet = () => {
      const id = nextId(pets);
      // 默认模板 = config.jsonc 的 pets[0]（main）→ 兜底 DEFAULT_PETS[0]
      const tpl = petBridge.template ?? DEFAULT_PETS[0];
      const np: PetConfigUI = { id, size: tpl.size, corner: tpl.corner, marginX: tpl.marginX, marginY: tpl.marginY };
      setPets((list) => [...list, np]);
      setSelId(id);
    };

    const removeSel = () => {
      if (pets.length <= 1) {
        setMsg({ kind: 'err', text: t('atLeastOne') });
        return;
      }
      const list = pets.filter((p) => p.id !== (sel?.id ?? ''));
      setPets(list);
      setSelId(list[0].id);
    };

    const field = (key: 'size' | 'marginX' | 'marginY', value: number, setter: (v: number) => void, width: string) =>
      h('input', {
        type: 'number',
        step: key === 'size' ? '10' : '1',
        min: key === 'size' ? '120' : '',
        value: String(value),
        disabled: busy || !sel,
        onChange: (e: any) => setter(Number(e.target.value)),
        style: { width, ...inputStyle },
      });

    return h(
      'section',
      {
        style: { maxWidth: '720px', color: 'var(--dsw-alias-label-primary)', display: 'flex', flexDirection: 'column', gap: '6px' },
        children: [
          h('h2', { style: { margin: 0, fontSize: '16px', fontWeight: 500, lineHeight: '24px' }, children: t('nav') }),
          h('p', { style: { margin: 0, fontSize: '14px', color: 'var(--dsw-alias-label-tertiary)', lineHeight: '22px' }, children: t('intro') }),

          // 宠物列表 + 添加
          h('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center', marginTop: '4px' }, children: [
            h('span', { style: { fontSize: '12px', color: 'var(--dsw-alias-label-secondary)' }, children: t('petsLabel') }),
            ...pets.map((p) =>
              h('button', {
                key: p.id,
                type: 'button',
                onClick: () => setSelId(p.id),
                style: {
                  border: '1px solid ' + (p.id === (sel?.id ?? '') ? 'var(--dsw-alias-state-business-primary)' : 'var(--dsw-alias-border-l2)'),
                  background: p.id === (sel?.id ?? '') ? 'var(--dsw-alias-interactive-bg-active)' : 'transparent',
                  color: 'var(--dsw-alias-label-primary)',
                  borderRadius: '8px',
                  padding: '4px 12px',
                  fontSize: '13px',
                  cursor: 'pointer',
                },
                children: p.id + ' (' + p.size + 'px)',
              }),
            ),
            h('button', {
              type: 'button', onClick: addPet, disabled: busy,
              style: { border: '1px dashed var(--dsw-alias-border-l2)', background: 'transparent', color: 'var(--dsw-alias-label-secondary)', borderRadius: '8px', padding: '4px 12px', fontSize: '13px', cursor: 'pointer' },
              children: '+ ' + t('add'),
            }),
          ] }),

          // 选中宠物表单
          sel
            ? h('div', { style: { display: 'flex', gap: '16px', flexWrap: 'wrap', marginTop: '8px', padding: '12px 14px', border: '1px solid var(--dsw-alias-border-l2)', borderRadius: '12px' }, children: [
                h('label', { style: { display: 'flex', flexDirection: 'column', gap: '4px', fontSize: '12px', color: 'var(--dsw-alias-label-secondary)' }, children: [
                  t('sizeLabel'),
                  field('size', sel.size, (v) => updateSel({ size: v }), '150px'),
                  h('span', { style: { fontSize: '11px', color: 'var(--dsw-alias-label-tertiary)' }, children: t('sizeHint') }),
                ] }),
                h('label', { style: { display: 'flex', flexDirection: 'column', gap: '4px', fontSize: '12px', color: 'var(--dsw-alias-label-secondary)' }, children: [
                  t('cornerLabel'),
                  h('select', {
                    value: sel.corner,
                    disabled: busy,
                    onChange: (e: any) => updateSel({ corner: e.target.value as Corner }),
                    style: { width: '160px', ...inputStyle },
                    children: CORNERS.map((c) => h('option', { key: c, value: c, children: cornerLabel(c) })),
                  }),
                ] }),
                h('label', { style: { display: 'flex', flexDirection: 'column', gap: '4px', fontSize: '12px', color: 'var(--dsw-alias-label-secondary)' }, children: [
                  t('marginX'),
                  field('marginX', sel.marginX, (v) => updateSel({ marginX: v }), '120px'),
                ] }),
                h('label', { style: { display: 'flex', flexDirection: 'column', gap: '4px', fontSize: '12px', color: 'var(--dsw-alias-label-secondary)' }, children: [
                  t('marginY'),
                  field('marginY', sel.marginY, (v) => updateSel({ marginY: v }), '120px'),
                ] }),
                h('button', {
                  type: 'button', onClick: removeSel, disabled: busy,
                  title: t('remove'),
                  style: { alignSelf: 'flex-end', border: '1px solid var(--dsw-alias-state-error-secondary)', background: 'transparent', color: 'var(--dsw-alias-state-error-primary)', borderRadius: '8px', padding: '4px 12px', fontSize: '12px', cursor: 'pointer' },
                  children: t('remove'),
                }),
              ] })
            : h('p', { style: { margin: 0, fontSize: '13px', color: 'var(--dsw-alias-label-tertiary)' }, children: t('emptyPets') }),

          // 操作区
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
        ],
      },
    );
  };
}