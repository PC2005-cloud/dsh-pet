/**
 * 多开容器：拉一次成品配置、长轮询 /state 叶子，再把指令分发给对应的宠物卡。
 * 只做「配置 → 渲染列表」与「叶子 → 每只宠物」的分发，不解释叶子语义、不画 DOM。
 * 必须始终成立：首拉只记基线，之后 counter 变化才分发；配置形状异常时显式报错，绝不用空列表清空。
 * @module dsh-pet/src/client/pet/multi
 */
import type { FunctionComponent, ReactNode } from 'react';
import { petBridge } from '../settings/bridge.ts';
import { flattenConfigPets, isWebVisible } from '../../shared/config.ts';
import { decideBalanceNotice } from '../../shared/balance/index.ts';
import { ROUTE_PATH } from '../../shared/constants.ts';
import { readMenuItems } from '../../shared/menu.ts';
import {
  fetchState,
  flattenCounters,
  readAnim,
  readBalance,
  readLock,
  readPosition,
  readSay,
  readThrow,
  readWorkStatus,
  resolveLeafPath,
  takeChanged,
} from '../../shared/state.ts';
import { fontStackOf } from '../../shared/fonts.ts';
import type { Pet } from '../../shared/types.ts';
import type { BalanceState } from '../../shared/balance/index.ts';
import type {
  LockState,
  PetFacing,
  PetLeafName,
  PollState,
  PositionMode,
  SayCue,
  SectionLeafName,
  StateLeaf,
} from '../../shared/state.ts';
import type { MenuMoreItem } from '../../shared/menu.ts';
import type { PetCollisionSlot } from '../../shared/physics.ts';
import type { WorkStatusSnapshot } from '../../shared/work-status.ts';
import type { PetCardProps } from './card/props.ts';
import type { PetRuntime, RuntimePet } from './types.ts';
import { setClickSoundEnabled } from './click-sound.ts';
import { setSurface, setVoiceConfig } from '../../shared/voice.ts';
import { runStatePoll } from './state-poll.ts';
import { setMenuItems } from '../menu-service.ts';
import { setStateSnapshot } from '../state-service.ts';
import { notifyFromFrame } from '../notify.ts';
import { STATE_FALLBACK_MS, STATE_WAIT_MS } from './timings.ts';

/**
 * 造多开容器。
 *
 * @param rt - 注入的 react 能力。
 * @param Card - 单只宠物的卡片组件。
 * @returns 容器组件。
 */
export function createPetMulti(
  rt: Pick<PetRuntime, 'h' | 'useState' | 'useEffect' | 'useRef'>,
  Card: FunctionComponent<PetCardProps>,
): () => ReactNode {
  const { h, useState, useEffect, useRef } = rt;

  return function PetMulti() {
    const [pets, setPets] = useState<Pet[]>([]);
    const [ready, setReady] = useState(false);
    // 碰撞站场：每只 PetCard 注册槽位，纯 ref 同步，不触发重渲染。
    const arenaRef = useRef<{ slots: Record<string, PetCollisionSlot> }>({ slots: {} });
    // 余额状态：容器统一拉取，PetCard 共享；两个 tick 分别驱动动画与文字说明。
    const [balance, setBalance] = useState<BalanceState | null>(null);
    const [balanceTick, setBalanceTick] = useState(0);
    const [balanceNoticeTick, setBalanceNoticeTick] = useState(0);
    // 本次余额是否由用户手动请求；手动请求无条件弹，开关只关自动。
    const [balanceManual, setBalanceManual] = useState(false);
    // 上次已提示的不可用原因，自动轮询只在原因变化时再弹。
    const noticeKeyRef = useRef<string | null>(null);
    // 余额结果统一入口；存 ref 是为了让 /state effect 的依赖保持 [ready]。
    // explicit 表示本次是否手动触发。
    const applyBalanceRef = useRef<(state: BalanceState, explicit: boolean) => void>(() => {});
    applyBalanceRef.current = (state, explicit) => {
      setBalance(state);
      setBalanceManual(explicit); // 手动标记随本次数据一起下发，每次到达都覆盖。
      if (state.ok) {
        setBalanceTick((t) => t + 1); // 成功：播档位动画并弹余额气泡。
        return;
      }
      const { show, key } = decideBalanceNotice(state, noticeKeyRef.current, explicit);
      noticeKeyRef.current = key;
      if (show) setBalanceNoticeTick((t) => t + 1); // 弹文字说明气泡（不播动画）
      // 未登记服务商是配置事实，已由气泡说明；其余原因照旧显式报错。
      if (state.reason !== 'unsupported') {
        console.error('[dsh-pet] 余额查询失败 reason=' + state.reason + (state.message ? ' ' + state.message : ''));
      }
    };
    // 工作状态：容器统一轮询 sections.workStatus，快照与 tick 驱动各宠物播档位动画。
    const [workStatus, setWorkStatus] = useState<WorkStatusSnapshot | null>(null);
    const [workStatusTick, setWorkStatusTick] = useState(0);
    // 说话：容器把 pets.<id>.say 按宠物分发给对应 PetCard。

    // 字体族写到 documentElement：对话窗与得分弹窗挂在 body 下，继承不到宠物根容器。
    useEffect(() => {
      const family = pets[0]?.font?.family;
      if (family === undefined) return;
      document.documentElement.style.setProperty('--dsh-pet-font-family', fontStackOf(family));
    }, [pets]);

    useEffect(() => {
      let alive = true;
      /** 唯一填充点：成品聚合 → 渲染列表；条目级字段只由 flattenConfigPets 吹入。 */
      const applyMerged = (merged: Record<string, Record<string, unknown>>): void => {
        const main = (merged as { main?: Record<string, unknown> } | null)?.main;
        // 形状校验：响应异常时显式抛错，绝不用空列表清空已有宠物。
        if (typeof main !== 'object' || main === null) {
          throw new Error('配置响应不是成品聚合（host 版本不匹配？）');
        }
        // 点击音效开关只读 main 条目，非 true 一律静音。
        setClickSoundEnabled(main.clickSoundEnabled === true);
        // 本页就是网页端：按叶子播放时只认 voiceTo='web' 的那一句。
        setSurface('web');
        // 音色与总开关同源：缺字段即「不播」，不在端上兜默认值。
        setVoiceConfig(main.voiceName, main.voiceEnabled);
        const flattened = flattenConfigPets(merged);
        petBridge.current = flattened;
        // 「添加宠物」模板取 main 条目的 pets[0]。
        petBridge.template = Array.isArray(main.pets) ? ((main.pets as Pet[])[0] ?? undefined) : undefined;
        setPets(flattened);
      };
      /** 拉取成品聚合：host readAllConfig 的输出，客户端零校验零兜底。 */
      const loadMerged = async (): Promise<Record<string, Record<string, unknown>>> => {
        // cache:'no-store' 与 fetchState 同口径，避免「版本变化后重拉」拿到旧值。
        const r = await fetch(ROUTE_PATH + '/config', { cache: 'no-store' });
        if (!r.ok) throw new Error('config HTTP ' + r.status);
        const body = (await r.json()) as Record<string, unknown>;
        // 业务失败也是 200：ok:false 的体不是成品配置，别拿它去拍平（会静默退化成默认配置）
        if (body.ok === false) throw new Error('config: ' + String(body.reason ?? 'failed'));
        return body as Record<string, Record<string, unknown>>;
      };
      (async () => {
        try {
          const merged = await loadMerged();
          if (!alive) return;
          applyMerged(merged);
          setReady(true);
        } catch (e) {
          console.error('[dsh-pet] 配置加载失败', e); // 成品拉取失败要显式报错，不静默隐藏。
        }
      })();
      // 设置页保存或同步后，用权威成品重新拍平；传入 merged 时直接用写接口的响应体。
      petBridge.reload = (merged) => {
        void (async () => {
          try {
            const next = merged ?? (await loadMerged());
            if (!alive) return;
            applyMerged(next);
          } catch (e) {
            console.error('[dsh-pet] 配置重载失败，保留当前渲染列表', e); // 显式报错，不清空已有宠物。
          }
        })();
      };
      return () => {
        alive = false;
        petBridge.reload = () => {};
      };
    }, []);

    // overlay 只渲染 display 为 web 或 both 的宠物。
    const visiblePets = pets.filter((p) => isWebVisible(p.display));

    // 统一轮询 /state：每个叶子 = { counter, data }，首拉只记基线，之后 counter 变化才分发。
    // 说话等命令与宠物开关无关，所以不为功能开关裁剪轮询。
    const [sayTick, setSayTick] = useState(0);
    const sayRef = useRef<Record<string, SayCue & { seq: number }>>({});
    const [animCueTick, setAnimCueTick] = useState(0);
    const animCueRef = useRef<
      Record<string, { name?: string; url?: string; seq: number; playbackId?: string; facing?: PetFacing }>
    >({});
    const [posCueTick, setPosCueTick] = useState(0);
    const posCueRef = useRef<
      Record<string, { x: number; y: number; mode: PositionMode; duration: number; seq: number }>
    >({});
    const [throwCueTick, setThrowCueTick] = useState(0);
    const throwCueRef = useRef<Record<string, { angle: number; power: number; seq: number }>>({});
    // 占用锁是状态而不是指令：PetCard 读它决定冻结，并按 expiresAt 自行解除。
    const [lockTick, setLockTick] = useState(0);
    const lockRef = useRef<Record<string, LockState>>({});
    // 第三方菜单项只在打开右键菜单时读一次，不参与渲染。
    const menuItemsRef = useRef<MenuMoreItem[]>([]);
    useEffect(() => {
      if (!ready) return;
      let alive = true;
      let baseline: Record<string, number> | null = null;
      /** 分段叶子 → 消费端副作用；不认识的名字已被 resolveLeafPath 挡在外面。 */
      const applySection = (name: SectionLeafName, leaf: StateLeaf): void => {
        switch (name) {
          case 'config':
            // 配置被别处改过（唯一写方是 POST /pet-display），重新拉取并拍平。
            // 叶子 data 只是信号，配置本体太大，不能塞进 /state。
            petBridge.reload();
            return;
          case 'balance': {
            const hit = readBalance(leaf);
            if (hit) applyBalanceRef.current(hit.state, hit.manual);
            return;
          }
          case 'workStatus': {
            const snap = readWorkStatus(leaf);
            if (snap) {
              setWorkStatus(snap);
              setWorkStatusTick((t) => t + 1); // 任何变化都触发，含回到空闲。
            }
            return;
          }
          case 'notify':
            // 系统通知：单槽，由 host 决定保留哪一条，内部有开关与权限门。
            notifyFromFrame(leaf.data);
            return;
          case 'menu':
            // 第三方菜单快照只更新 ref，不触发渲染；同一份交给页面内菜单镜像，供 petApi7340.menuEvents 读取。
            menuItemsRef.current = readMenuItems(leaf.data, 'web');
            setMenuItems(menuItemsRef.current);
            return;
        }
      };

      /** 宠物叶子 → 该宠物的指令槽；序号自增，卡片据此知道「又写了一次」。 */
      const applyPetLeaf = (name: PetLeafName, petId: string, leaf: StateLeaf): void => {
        switch (name) {
          case 'say': {
            const said = readSay(leaf);
            if (!said) return;
            sayRef.current[petId] = { ...said, seq: (sayRef.current[petId]?.seq ?? 0) + 1 };
            setSayTick((t) => t + 1);
            return;
          }
          case 'anim': {
            // 每次写入都会递增 counter，连点两次也会分发两次。
            const hit = readAnim(leaf);
            if (!hit) return;
            animCueRef.current[petId] = {
              name: hit.name,
              url: hit.url,
              playbackId: hit.playbackId,
              facing: hit.facing,
              seq: (animCueRef.current[petId]?.seq ?? 0) + 1,
            };
            setAnimCueTick((t) => t + 1);
            return;
          }
          case 'position': {
            const hit = readPosition(leaf);
            if (!hit) return;
            posCueRef.current[petId] = { ...hit, seq: (posCueRef.current[petId]?.seq ?? 0) + 1 };
            setPosCueTick((t) => t + 1);
            return;
          }
          case 'throw': {
            const hit = readThrow(leaf);
            if (!hit) return;
            throwCueRef.current[petId] = { ...hit, seq: (throwCueRef.current[petId]?.seq ?? 0) + 1 };
            setThrowCueTick((t) => t + 1);
            return;
          }
          case 'lock': {
            // 占用锁是状态而不是指令：卡片按 expiresAt 自行解除。
            const hit = readLock(leaf);
            if (!hit) return;
            lockRef.current[petId] = hit;
            setLockTick((t) => t + 1);
            return;
          }
        }
      };

      /** 应用一份轮询状态：首拉只记基线，之后按 counter 变化逐个分发。 */
      const applyState = (s: PollState) => {
        // 最近一拍先留给同页消费者（petApi7340.getState）：它读的是同一个对象，不占连接。
        setStateSnapshot(s);
        if (baseline === null) {
          baseline = flattenCounters(s); // 首拉只记基线，不渲染。
          // 菜单项是当前状态而不是事件，首拉也必须装上，否则刷新后第三方菜单会一直为空。
          menuItemsRef.current = readMenuItems(s.sections.menu?.data, 'web');
          setMenuItems(menuItemsRef.current);
          return;
        }
        for (const { path, leaf } of takeChanged(s, baseline)) {
          if (leaf.data === null) continue;
          const target = resolveLeafPath(path);
          // 不认识的路径（新增的叶子、别处写坏的键）静默跳过。
          if (target === null) continue;
          if (target.where === 'section') applySection(target.name, leaf);
          else applyPetLeaf(target.name, target.petId, leaf);
        }
      };
      // 自调度轮询在 pet/state-poll.ts：这里只提供拉取与分发。
      void runStatePoll({
        fetch: (options) =>
          fetchState(
            undefined,
            options === undefined ? undefined : { since: options.since, timeoutMs: options.timeoutMs },
          ),
        onState: applyState,
        waitMs: STATE_WAIT_MS,
        fallbackMs: STATE_FALLBACK_MS,
        isAlive: () => alive,
      });
      return () => {
        alive = false;
      };
    }, [ready]);

    return ready
      ? visiblePets.map((p) =>
          h(Card, {
            key: p.id,
            cfg: p as RuntimePet,
            balance,
            balanceTick,
            balanceNoticeTick,
            balanceManual,
            workStatus,
            workStatusTick,
            say: sayRef.current[p.id],
            sayTick,
            animCue: animCueRef.current[p.id],
            animCueTick,
            posCue: posCueRef.current[p.id],
            posCueTick,
            throwCue: throwCueRef.current[p.id],
            throwCueTick,
            lock: lockRef.current[p.id],
            lockTick,
            menuItemsRef,
            arena: arenaRef,
          }),
        )
      : null;
  };
}
