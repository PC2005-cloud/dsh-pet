/**
 * 宿主命令的「/」菜单面孔补丁 —— 给第三方**宿主命令**补上标题与图标。
 *
 * ## 为什么需要它
 *
 * DSH 当前没有任何给第三方宿主命令配图标的入口：
 *   · `CommandDefinition` / `CommandDescriptor` 没有 icon 字段，且注册时 descriptor 是
 *     **逐字段重建**的（dsh-commands 只挑 definitionId / name / description / input），
 *     多写的字段会被直接丢掉，连 TS 模块增强都传不到前端；
 *   · `CommandDecoration`（本插件 `/pet` 选择框用的那个）只开放「裸调用行为」，
 *     没有 label / description / icon；
 *   · 前端 `candidates()` 只对 6 个第一方包（BUILTINS 白名单：goal / plan / feedback /
 *     compact / permission / export）调 `builtinRowFace()` 配面孔。
 *   · `inputTriggers` 的 source 契约里也没有「候选行变换」钩子，且同名 `/` source
 *     重复注册会抛错 —— 无法另起一个 source 去改行。
 *
 * ## 为什么包装是可行的
 *
 * dsh-client-ui-commands 注册 source 时用的是**闭包**：
 *
 * ```js
 * candidates: (session, req) => this.candidates(session, req)
 * ```
 *
 * 它在**运行时**于实例上查 `candidates`，因此同名自有属性会遮蔽原型方法；而 cordis 的
 * `Service` 没有 `Object.freeze`，实例可写。本模块就靠这一点补上面孔。
 *
 * ## 降级策略（保证绝不会把「/」菜单弄坏）
 *
 * 1. `candidates` 不存在或不是函数 → 完全不装，只告警；
 * 2. 本模块自己的映射逻辑抛错 → 退回原始行（菜单照常，只是没图标）；
 * 3. 某一行 DSH 已经给了 icon → 原样放行、不覆盖（将来官方支持后本补丁自动让位）。
 *
 * `original` 自身抛出的错误**不吞**：DSH 的 `fetchCandidates` 已经对 source 失败做了
 * `source-failed` 兜底，吞掉只会掩盖真实故障。
 *
 * 将来 DSH 给 `CommandDecoration` 加上 icon 字段后，删掉本模块与调用点即可。
 */
import type { ComponentType } from 'react';
import type { IconProps } from '@deepseek-ai/dsh-client-ui-primitives';

/** DSH `ctx.commandUi` 的最小形状：只声明面孔补丁用到的成员。 */
export interface CommandUiLike {
  /** 该服务实例上的候选行方法（原型方法，可被自有属性遮蔽）。 */
  candidates?: (session: unknown, req: unknown) => Promise<unknown>;
}

/** 一个宿主命令在「/」菜单里的补充面孔。 */
export interface CommandFace {
  /**
   * 行标题。每次候选轮询现取，因此语言切换在下一轮菜单打开时生效
   * （与 DSH 内置命令的 `builtinRowFace(descriptor, this.t)` 同款行为）。
   */
  label: () => string;
  /** 行图标；DSH 的图标格固定 14×14px，渲染时只传 `size`。 */
  icon: ComponentType<IconProps>;
}

/**
 * 给宿主命令的「/」菜单行补上标题与图标。
 *
 * @param commandUi - DSH 的 commandUi 服务实例。
 * @param faces - 命令名（不带前导斜杠）→ 补充面孔。
 * @returns 还原原方法的 disposer。
 */
export function installCommandFaces(commandUi: CommandUiLike, faces: ReadonlyMap<string, CommandFace>): () => void {
  const original = commandUi.candidates;
  if (typeof original !== 'function') {
    console.warn('[dsh-pet] 命令图标不可用：commandUi.candidates 缺失（命令本身仍可用，只是没有图标）');
    return () => {};
  }

  const patched = async (session: unknown, req: unknown): Promise<unknown> => {
    const rows: unknown = await original.call(commandUi, session, req);
    try {
      if (!Array.isArray(rows)) return rows;
      return rows.map((raw: unknown): unknown => {
        if (raw === null || typeof raw !== 'object') return raw;
        const row = raw as { name?: unknown; icon?: unknown };
        const face = faces.get(typeof row.name === 'string' ? row.name : '');
        // DSH 自己已经给了图标（含将来官方支持）→ 原样放行，不覆盖
        if (face === undefined || row.icon !== undefined) return row;
        return { ...row, label: face.label(), icon: face.icon };
      });
    } catch (error) {
      console.warn(
        '[dsh-pet] 命令图标补丁异常，本次退回原始菜单行：' + (error instanceof Error ? error.message : String(error)),
      );
      return rows;
    }
  };

  commandUi.candidates = patched;
  return () => {
    // 只还原自己装的那一份：若后来者又包了一层，别把它的包装抹掉
    if (commandUi.candidates === patched) commandUi.candidates = original;
  };
}
