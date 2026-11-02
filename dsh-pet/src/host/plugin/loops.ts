/**
 * 轮询循环：余额定时刷新与碎碎念定时触发，随插件卸载一并停止。
 *
 * 不实现取数与文案（归 balance-poll / chat-memory），只负责节奏与生命周期。
 * @module dsh-pet/src/host/plugin/loops
 */
import { findPetInstance, flattenPetList, readAllConfig } from '../config.ts';
import { isDisplayed } from '../surface.ts';
import { automaticWhisperSchedule } from '../whisper-policy.ts';
import type { BalancePoll } from './balance-poll.ts';
import type { ChatMemory } from './chat-memory.ts';
import type { PetLookup } from './pet-lookup.ts';
import type { HostSetup } from './setup.ts';
import type { HostContext } from './context.ts';

/** 梦话周期的兜底值（秒）：配置里 eventsRefreshSec.sleepTalk 缺失/非法时用它。 */
const SLEEP_TALK_DEFAULT_SEC = 60;

/** 错峰队列里相邻两只之间的间隔（ms）：同拍到点的宠物依次开口，才会错开冒泡与语音。 */
const WHISPER_STAGGER_MS = 10_000;

/** 错峰队列上限：6 只 × 10s = 60s，正好覆盖最短周期，队列不会追着拍跑。 */
const WHISPER_QUEUE_MAX = 6;

/** 轮询循环的输入。 */
export type LoopsInput = {
  /** 宿主上下文（apply 收到的那一个）。 */
  ctx: HostContext;
} & Pick<BalancePoll, 'balancePeriodSec'> &
  Pick<HostSetup, 'configPaths'> &
  Pick<ChatMemory, 'lastWhisperAt'> &
  Pick<PetLookup, 'lock'> &
  Pick<PetLookup, 'sleep'> &
  Pick<HostSetup, 'log'> &
  Pick<ChatMemory, 'publishWhisper'> &
  Pick<ChatMemory, 'publishSleepTalk'> &
  Pick<BalancePoll, 'refreshBalance'> &
  Pick<HostSetup, 'standaloneAiPolicy'> &
  Pick<BalancePoll, 'whisperPeriodSec'>;

/** 注册轮询循环；返回的清理函数由 ctx.effect 收集。 */
export function registerLoops(deps: LoopsInput): void {
  const {
    ctx,
    balancePeriodSec,
    configPaths,
    lastWhisperAt,
    lock,
    log,
    publishWhisper,
    publishSleepTalk,
    refreshBalance,
    sleep,
    standaloneAiPolicy,
    whisperPeriodSec,
  } = deps;
  // 余额周期刷新：host 侧唯一定时器。周期每次重新读配置 eventsRefreshSec.balance，改了下一拍跟上。
  // 没有任何启用余额的宠物时跳过查询：尊重配置，不白花外部 API 调用。
  ctx.effect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    function arm(sec: number): void {
      if (disposed) return;
      timer = setTimeout(() => void tick(), Math.max(1000, sec * 1000));
    }
    async function tick(): Promise<void> {
      let sec: number;
      try {
        const cfg = readAllConfig(configPaths);
        sec = balancePeriodSec(cfg);
        // 没有任何「醒着且启用余额」的宠物 → 不查（省外部调用）：睡着的宠物不看不听，
        // 拉了也只会白花一次外部 API；配置改了或醒了，下一拍自然跟上。
        const pets = flattenPetList(cfg);
        if (pets.some((p) => p.balanceEnabled === true && !sleep.sleeping(String(p.id ?? '')))) {
          await refreshBalance();
        } else {
          log.info('[dsh-pet] 余额周期跳过：没有醒着且启用余额的宠物');
        }
      } catch (e) {
        // 读配置抛错 = 安装损坏（readAllConfig 只在内置默认缺失/损坏时抛，用户层写坏只会告警回退）：
        // 不再重排——每 30 分钟重试一次没有意义，而且会白占一个常驻定时器。留一行 warn：这条路径
        // 会让余额周期永久停摆，不打日志就与「查了但没变化」无法区分。
        log.warn(
          '[dsh-pet] 余额周期读配置失败，周期刷新已停止（重启 DSH 后恢复）：' +
            (e instanceof Error ? e.message : String(e)),
        );
        return;
      }
      arm(sec);
    }
    void tick(); // 启动即拉一次，不等第一个周期
    return () => {
      disposed = true;
      if (timer !== null) clearTimeout(timer);
    };
  }, 'dsh-pet: balance poll');

  // 碎碎念周期：host 侧调度。一拍 = 读一次配置 + 把「到点」的宠物排进错峰队列；下一拍按最短周期排。
  // 用固定拍 + 逐宠物比对 lastWhisperAt，而不是每宠一个定时器：宠物随配置增删、周期随条目改，
  // 固定拍天然跟上，不用维护一堆定时器的生命周期。
  ctx.effect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    /** 待发布的宠物（FIFO）；一次只发一只，两只之间隔 {@link WHISPER_STAGGER_MS}。 */
    const pending: string[] = [];
    /** 队列内相邻两只之间的等待句柄；与拍定时器分开计，两者都要在卸载时清掉。 */
    let drainTimer: ReturnType<typeof setTimeout> | null = null;

    /** 是否已经有一只正在生成；同一时刻只允许一只，否则两只仍会同时写出气泡。 */
    let pumping = false;

    /**
     * 从队列取下一只发布，等它写完再隔一个间隔发下一只。
     *
     * 间隔从「文字真的写进状态」算起，而不是从发起点算：单次生成耗时在 3–15 秒之间波动，
     * 从发起点算的固定间隔会被慢的那只吃掉，两只又撞到一起。
     */
    async function pump(): Promise<void> {
      if (disposed || pumping || drainTimer !== null) return;
      const petId = pending.shift();
      if (petId === undefined) return;
      pumping = true;
      try {
        // kind=whisper 让生成侧按 voiceWhisperEnabled 决定要不要带 voiceTo。
        await publishWhisper(petId, undefined, undefined, 'whisper');
      } catch {
        // 单只失败不挡住后面的宠物：原因已经由 publishWhisper 记过日志。
      } finally {
        pumping = false;
      }
      if (disposed || pending.length === 0) return;
      drainTimer = setTimeout(() => {
        drainTimer = null;
        void pump();
      }, WHISPER_STAGGER_MS);
    }

    function arm(sec: number): void {
      if (disposed) return;
      timer = setTimeout(() => void tick(), Math.max(1000, sec * 1000));
    }
    function tick(): void {
      let next = 300;
      try {
        const cfg = readAllConfig(configPaths);
        const now = Date.now();
        let min = Infinity;
        // 每一拍的账：检查几只、到点几只、没到点几只、跳过几只（带原因）。只用于日志，调度行为不变。
        let checked = 0;
        let due = 0;
        let notDue = 0;
        const skipped: string[] = [];
        for (const pet of flattenPetList(cfg)) {
          const petId = String(pet.id ?? '');
          if (!petId) continue;
          // petId 就是从同一份 cfg 拍平出来的，所以必然命中（findPetInstance 与 flattenPetList
          // 搜索同一集合）；查不到只可能是两者口径漂移——跳过这一拍，不猜也不兜底 main。
          const found = findPetInstance(cfg, petId);
          if (!found) continue;
          checked += 1;
          const schedule = automaticWhisperSchedule(
            standaloneAiPolicy(),
            pet.whisperEnabled === true,
            whisperPeriodSec(found.conf),
          );
          if (!schedule.enabled) {
            // 两种「没启用」分开记：宠物自己关掉，与独立模式 AI 未就绪，处理方式完全不同
            skipped.push(petId + ': ' + (pet.whisperEnabled === true ? '独立模式 AI 未就绪' : 'whisperEnabled=false'));
            continue;
          }
          // 配置上不显示的宠物不生成：用户选「都不显示」就是不用了，后台继续调模型纯属白烧额度（#237）。
          // 放在 min 之前：不可见的宠物也不该把整拍的周期拖住。不推进 lastWhisperAt——
          // 与占用锁同一口径，重新可见后下一拍立刻补一句。
          const display = String(pet.display ?? '');
          if (!isDisplayed(display)) {
            skipped.push(petId + ': display=none');
            continue;
          }
          const sec = schedule.periodSec;
          min = Math.min(min, sec);
          if (now - (lastWhisperAt.get(petId) ?? 0) < sec * 1000) {
            notDue += 1;
            continue;
          }
          // 占用锁：这只宠物被占用时跳过这一拍——不生成也不补（碎碎念是瞬时事件，过期即弃），
          // 且不推进 lastWhisperAt：锁一放开，下一拍就该照常说。
          // 只挡这一处 per-pet 来源；全局段（balance / workStatus）由渲染端按宠物忽略——
          // 宿主跳过写入会连带静音别的宠物。
          if (lock.locked(petId)) {
            skipped.push(petId + ': 占用锁跳过');
            continue;
          }
          // 睡觉：不生成、也不推进 lastWhisperAt——醒来的下一拍立刻补一句，与占用锁同一口径。
          if (sleep.sleeping(petId)) {
            skipped.push(petId + ': 睡觉中');
            continue;
          }
          // 队列有上限：宠物多、周期短时宁可这一拍少说几句，也不让错峰追着下一拍跑。
          if (pending.length >= WHISPER_QUEUE_MAX) {
            skipped.push(petId + ': 错峰队列已满');
            continue;
          }
          due += 1;
          // 在调度时记：排队不改变周期语义，单只仍然每 sec 秒一句。
          lastWhisperAt.set(petId, now);
          log.info(`[dsh-pet] 碎碎念到点 pet=${petId}（周期 ${sec}s），入队待发`);
          pending.push(petId);
        }
        void pump(); // 本拍到点的宠物开始逐只发布
        if (Number.isFinite(min)) next = min;
        // 每拍一行汇总：调度是否还在跑、下一拍多久、为什么跳过，全在这一行里（300s 一条，量可忽略）
        log.info(
          `[dsh-pet] 碎碎念调度：检查 ${checked} 只 → 到点 ${due}、未到点 ${notDue}、跳过 ${skipped.length}` +
            (due > 1 ? `；${due} 只按 ${WHISPER_STAGGER_MS / 1000}s 间隔依次说` : '') +
            (skipped.length > 0 ? `（${skipped.join('；')}）` : '') +
            `；下一拍 ${next}s`,
        );
      } catch (e) {
        // 读配置抛错 = 安装损坏（同余额定时器）：不再重排，别白占常驻句柄。
        // 但必须留一行 warn：这条路径会让自动碎碎念永久停摆。
        log.warn(
          '[dsh-pet] 碎碎念调度读配置失败，自动碎碎念已停止（重启 DSH 后恢复）：' +
            (e instanceof Error ? e.message : String(e)),
        );
        return;
      }
      arm(next);
    }
    void tick(); // 启动即生成一次，不等第一个周期
    return () => {
      disposed = true;
      if (timer !== null) clearTimeout(timer);
      if (drainTimer !== null) clearTimeout(drainTimer);
    };
  }, 'dsh-pet: whisper poll');

  // 梦话周期：只对正在睡的宠物，按各自条目的 eventsRefreshSec.sleepTalk 排。
  // 与碎碎念同一个形态（固定拍 + 逐宠物比对 lastAt），宠物增删与周期改动天然跟上。
  ctx.effect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    /** petId → 上一次说梦话的时刻；醒来不清，下次睡着时按周期自然接着算。 */
    const lastTalkAt = new Map<string, number>();
    function arm(sec: number): void {
      if (disposed) return;
      timer = setTimeout(() => void tick(), Math.max(1000, sec * 1000));
    }
    function tick(): void {
      let next = SLEEP_TALK_DEFAULT_SEC;
      try {
        const cfg = readAllConfig(configPaths);
        const now = Date.now();
        let min = Infinity;
        for (const petId of sleep.ids()) {
          const found = findPetInstance(cfg, petId);
          if (!found) continue;
          const sec = sleepTalkPeriodSec(found.conf);
          min = Math.min(min, sec);
          if (now - (lastTalkAt.get(petId) ?? 0) < sec * 1000) continue;
          lastTalkAt.set(petId, now);
          // 不 await：生成要几秒，别把调度拍拖住
          void publishSleepTalk(petId).catch(() => {});
        }
        if (Number.isFinite(min)) next = min;
      } catch (e) {
        // 读配置抛错 = 安装损坏：停止本循环并留一行日志（与另外两个循环同一口径）
        log.warn(
          '[dsh-pet] 梦话调度读配置失败，说梦话已停止（重启 DSH 后恢复）：' +
            (e instanceof Error ? e.message : String(e)),
        );
        return;
      }
      arm(next);
    }
    void tick();
    return () => {
      disposed = true;
      if (timer !== null) clearTimeout(timer);
    };
  }, 'dsh-pet: sleep talk poll');
}

/** 梦话周期（秒）：条目级 eventsRefreshSec.sleepTalk，读不到按 60 兜底（与配置注释同一口径）。 */
function sleepTalkPeriodSec(conf: Record<string, unknown>): number {
  const table = conf.eventsRefreshSec as Record<string, unknown> | undefined;
  const sec = Number(table?.sleepTalk);
  return Number.isFinite(sec) && sec > 0 ? sec : SLEEP_TALK_DEFAULT_SEC;
}
