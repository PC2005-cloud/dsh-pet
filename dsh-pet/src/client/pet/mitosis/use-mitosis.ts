/**
 * 有丝分裂的容器侧状态：连点窗口、分身名单、模式持久化，四件事都在这一份 hook 里。
 *
 * 只做「事件 → 名单」的读写与落盘，不建卡片、不碰物理、不发请求：判定全在 rules.ts，
 * 菜单文案在 menu.ts，怎么把分身挂进渲染列表由 multi.ts 决定。
 * 依赖注入的 react（useState、useRef）与 sessionStorage。
 * 必须始终成立：分身只在渲染期存在，刷新即回到一只；名单按本体 petId 分组，序号只增不减（键不复用）。
 * @module dsh-pet/src/client/pet/mitosis/use-mitosis
 */
import {
  MITOSIS_CAP,
  instanceKeyOf,
  nextTap,
  planSplit,
  readMode,
  spawnSpot,
  trimClones,
  type MitosisMode,
  type TapWindow,
} from './rules.ts';
import type { Center } from '../motion/geometry.ts';
import type { PetRuntime } from '../types.ts';

/** 分裂模式在本标签页的存储键：分身本就活不过刷新，模式跟着会话走。 */
const MODE_KEY = 'dsh-pet/mitosisMode';

/** 一个分身实例。 */
export interface MitosisClone {
  /** 分身身份键：React key 与碰撞站场槽键；宿主侧不认它。 */
  instanceKey: string;
  /** 本体宠物 id：分身与本体共用同一个宿主身份。 */
  petId: string;
  /** 该本体的分身序号（从 1 起，只增不减）。 */
  seq: number;
  /** 出生点（归一化中心）。 */
  spot: Center;
}

/** 容器交给卡片与菜单的那一面。 */
export interface Mitosis {
  /** 当前模式。 */
  mode: MitosisMode;
  /** 全部分身（渲染期平铺用）。 */
  clones: MitosisClone[];
  /** 某只本体的分身，按序号升序。 */
  clonesOf(petId: string): MitosisClone[];
  /** 记一次点击：够数就当场分裂。 */
  tap(petId: string, now: number): void;
  /** 删掉一个分身（分身的「删除我」）。 */
  remove(petId: string, instanceKey: string): void;
  /** 清掉某只本体的全部分身。 */
  clear(petId: string): void;
  /** 切模式：顺手把超出新上限的分身收掉。 */
  setMode(mode: MitosisMode): void;
}

/** 读本标签页存过的模式；隐私模式与禁用存储都回普通。 */
function readStoredMode(): string | null {
  try {
    return sessionStorage.getItem(MODE_KEY);
  } catch {
    return null;
  }
}

/** 写入模式；存不下只丢「刷新后还记得」这一层便利。 */
function writeStoredMode(mode: MitosisMode): void {
  try {
    sessionStorage.setItem(MODE_KEY, mode);
  } catch {
    // 忽略：模式照常在本次会话里生效
  }
}

/**
 * 造有丝分裂 hook。
 *
 * @param rt - 注入的 react 能力。
 * @returns 容器每渲染调一次的 hook。
 */
export function createUseMitosis(rt: Pick<PetRuntime, 'useState' | 'useRef'>): () => Mitosis {
  const { useState, useRef } = rt;

  return function useMitosis(): Mitosis {
    const [mode, setModeState] = useState<MitosisMode>(readMode(readStoredMode()));
    const [groups, setGroups] = useState<Record<string, MitosisClone[]>>({});
    // 名单的最新镜像：分裂要在 setGroups 之前算出加几只，不能靠 updater 里的副作用。
    const groupsRef = useRef(groups);
    groupsRef.current = groups;
    const modeRef = useRef(mode);
    modeRef.current = mode;
    /** 每只本体各自一条连点窗口。 */
    const tapRef = useRef<Record<string, TapWindow | null>>({});
    /** 每只本体各自的分身序号计数器（只增不减，键不会被复用）。 */
    const seqRef = useRef<Record<string, number>>({});

    /** 一次分裂：现有总数翻倍，封顶在新模式的上限。 */
    const split = (petId: string): void => {
      const list = groupsRef.current[petId] ?? [];
      const cap = MITOSIS_CAP[modeRef.current];
      const want = planSplit(1 + list.length, cap);
      if (want <= 0) {
        console.info('[dsh-pet] 有丝分裂已到上限（' + cap + ' 只）pet=' + petId);
        return;
      }
      const added: MitosisClone[] = [];
      for (let i = 0; i < want; i++) {
        const seq = (seqRef.current[petId] ?? 0) + 1 + i;
        added.push({ instanceKey: instanceKeyOf(petId, seq), petId, seq, spot: spawnSpot(Math.random) });
      }
      seqRef.current[petId] = (seqRef.current[petId] ?? 0) + want;
      setGroups({ ...groupsRef.current, [petId]: [...list, ...added] });
      console.info('[dsh-pet] 有丝分裂 pet=' + petId + ' +' + want + ' 只 → ' + (1 + list.length + want) + ' 只');
    };

    const tap = (petId: string, now: number): void => {
      const next = nextTap(tapRef.current[petId] ?? null, now);
      tapRef.current[petId] = next.tap;
      if (next.split) split(petId);
    };

    const remove = (petId: string, instanceKey: string): void => {
      const list = groupsRef.current[petId];
      if (list === undefined) return;
      const rest = list.filter((c) => c.instanceKey !== instanceKey);
      console.info('[dsh-pet] 分裂体删除 ' + instanceKey + ' → 剩 ' + (rest.length + 1) + ' 只');
      setGroups({ ...groupsRef.current, [petId]: rest });
    };

    const clear = (petId: string): void => {
      const n = (groupsRef.current[petId] ?? []).length;
      if (n === 0) return;
      console.info('[dsh-pet] 清除全部分身 pet=' + petId + ' -' + n + ' 只');
      setGroups({ ...groupsRef.current, [petId]: [] });
    };

    const setMode = (next: MitosisMode): void => {
      setModeState(next);
      writeStoredMode(next);
      const cap = MITOSIS_CAP[next];
      const trimmed: Record<string, MitosisClone[]> = {};
      for (const [petId, list] of Object.entries(groupsRef.current)) trimmed[petId] = trimClones(list, cap);
      setGroups(trimmed);
    };

    return {
      clear,
      clones: Object.values(groups).flat(),
      clonesOf: (petId) => groups[petId] ?? [],
      mode,
      remove,
      setMode,
      tap,
    };
  };
}
