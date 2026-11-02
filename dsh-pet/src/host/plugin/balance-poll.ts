/**
 * 余额拉取与周期换算：按配置取周期、刷新余额并写进轮询快照。
 *
 * 不实现各服务商的取数协议（归 ./balance/providers）。
 * 依赖由 apply 显式传入（见输入类型），模块内不读全局、不建单例。
 * @module dsh-pet/src/host/plugin/balance-poll
 */
import { flattenPetList, readAllConfig } from '../config.ts';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PACKAGE_ROOT } from '../paths.ts';
import { queryBalance } from '../balance/index.ts';
import { credentialRef } from '@deepseek-ai/dsh-credentials';
import type { ChatMemory } from './chat-memory.ts';
import type { HostSetup } from './setup.ts';
import type { HostContext } from './context.ts';

/** 余额与周期的输入：装配期对象与更早的工厂。 */
export type BalancePollInput = {
  /** 宿主上下文（apply 收到的那一个）。 */
  ctx: HostContext;
} & Pick<HostSetup, 'configPaths'> &
  Pick<ChatMemory, 'getActivePetId'> &
  Pick<HostSetup, 'log'> &
  Pick<HostSetup, 'standaloneAiBalance'> &
  Pick<HostSetup, 'state'>;

/**
 * 创建余额与周期。
 */
export function createBalancePoll(deps: BalancePollInput) {
  const { ctx, configPaths, getActivePetId, log, state, standaloneAiBalance } = deps;
  /** 当前生效宠物列表：成品配置拍平（合并器已保证 id 唯一、字段填满），命令与桌面模式共用。 */
  const effectivePetList = (): Record<string, unknown>[] => flattenPetList(readAllConfig(configPaths));

  /** 余额刷新周期（秒）：成品 main 条目的 eventsRefreshSec.balance（合并器已填默认；非法兜底 1800） */
  const balancePeriodSec = (cfg: Record<string, Record<string, unknown>>): number => {
    const ers = cfg.main?.eventsRefreshSec as Record<string, unknown> | undefined;
    const n = Number(ers?.balance);
    return Number.isFinite(n) && n > 0 ? n : 1800;
  };

  /** 碎碎念周期（秒）：该宠物所属条目的 eventsRefreshSec.whisper（合并器已填默认；非法兜底 300）。
   *  收已解析的条目配置：唯一调用方是周期调度，它的 petId 就是从同一份 cfg 拍平出来的。 */
  const whisperPeriodSec = (conf: Record<string, unknown>): number => {
    const ers = conf.eventsRefreshSec as Record<string, unknown> | undefined;
    const n = Number(ers?.whisper);
    return Number.isFinite(n) && n > 0 ? n : 300;
  };

  /**
   * 账号服务要求的调用方身份（`AccountClientMetadata`）：只影响请求来源标识与服务端本地化文案，
   * 不参与余额数值与币种。version 读自身 package.json（读不到回落 '0.0.0'）；locale 固定 zh-CN。
   */
  const accountClientMetadata = (): { version: string; locale: string; timezoneOffsetSeconds: number } => {
    let version = '0.0.0';
    try {
      const raw = JSON.parse(readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8')) as { version?: unknown };
      if (typeof raw.version === 'string' && raw.version.length > 0) version = raw.version;
    } catch {
      // 读不到不影响查询：version 只是平台侧的来源标识
    }
    return { version, locale: 'zh-CN', timezoneOffsetSeconds: -new Date().getTimezoneOffset() * 60 };
  };

  /**
   * 刷新余额并写入轮询状态：host 侧唯一的余额查询点，两端从 /state 读同一份结果。
   * 失败也写进状态（reason 区分 unsupported / credential-missing / fetch-error）：余额不可用要弹
   * 文字说明，不能静默；意外异常同样落成 fetch-error。
   *
   * @param manual - 这次刷新是否由用户触发（/balance 命令、桌面「查看余额」菜单）；标记随数据写进
   *   叶子，前端据此决定余额不可用时是否必弹文字说明（周期刷新只在原因变化时弹一次）。
   */
  const refreshBalance = async (manual = false): Promise<void> => {
    // 开始 + 结果各一行：否则 logs.txt 里既看不出「有没有查」，也看不出「查了但余额没变」。
    log.info(`[dsh-pet] 余额刷新开始（${manual ? '手动' : '周期'}）`);
    const mark = <T>(v: T): T | (T & { manual: true }) => (manual ? { ...v, manual: true } : v);
    try {
      // 独立模式自己选余额服务商、自己持密钥：它的 provider 不是聊天用的那个，
      // 也不能经 DSH 的 credential store 解析，所以优先走 standaloneAi 交出来的凭证。
      const standalone = standaloneAiBalance();
      const provider = standalone?.provider || ctx.agentDefaultModel.currentSelection().provider;
      const result = await queryBalance(
        provider,
        async (ref) => {
          if (standalone?.apiKey) return standalone.apiKey;
          const rc = await ctx.credentials.resolve(credentialRef(ref));
          return rc?.value;
        },
        // `deepseek-account`（免费额度 / 平台登录）没有 API Key：它的凭证是 DSH 账号服务
        // 持有的授权记录，只能经 getBalance 查询。账号服务是可选服务（软取，不放进 inject）
        // ——没装账号插件时它不在场，此时该路由报 credential-missing 而不是崩。
        async () => {
          const account = ctx.get('deepseekAccount', false);
          if (!account) return undefined;
          return account.getBalance(accountClientMetadata());
        },
      );
      state.writeSection('balance', mark(result));
      // 失败也写 S（前端弹文字说明），日志同样留一条：否则「查了、失败了」与「根本没查」
      // 在文件里长得一模一样。成功用 info，失败用 warn（亮度不同，扫一眼就能分辨）。
      if (result.ok) {
        log.info(`[dsh-pet] 余额刷新成功 provider=${result.provider}（${result.shape}）`);
      } else {
        log.warn(
          `[dsh-pet] 余额刷新失败 provider=${result.provider} reason=${result.reason}` +
            (result.message ? ' ' + result.message : ''),
        );
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      state.writeSection(
        'balance',
        mark({
          ok: false,
          provider: 'unknown',
          reason: 'fetch-error',
          message,
        }),
      );
      log.warn('[dsh-pet] 余额刷新异常：' + message);
    }
  };

  /** 当前交互桌宠 id：/pet 已选且仍存在 → 该宠物；未选/已失效 → 有效宠物列表第一只（进程内，重启回默认） */
  const resolveActivePetId = (): string => {
    try {
      const eff = effectivePetList();
      if (eff.length === 0) return '';
      if (getActivePetId() && eff.some((p) => String(p.id) === getActivePetId())) return getActivePetId();
      return String(eff[0].id);
    } catch {
      return getActivePetId();
    }
  };

  /** 宠物的显示名（name，缺失回落 id）——命令文案用 */
  const petDisplayName = (pet: Record<string, unknown>): string => {
    const n = String(pet.name ?? '').trim();
    return n || String(pet.id ?? '');
  };
  return { effectivePetList, balancePeriodSec, whisperPeriodSec, refreshBalance, resolveActivePetId, petDisplayName };
}
/** 余额与周期的产出（供下游工厂按需 Pick）。 */
export type BalancePoll = ReturnType<typeof createBalancePoll>;
