/**
 * 斜杠命令 /chat：把一句话转给宠物并回帖。
 * @module dsh-pet/src/host/plugin/command-chat
 */
import { CHAT_MESSAGE_LIMIT } from '../../shared/chat/length.ts';
import type { ChatMemory } from './chat-memory.ts';
import type { BalancePoll } from './balance-poll.ts';
import type { PetLookup } from './pet-lookup.ts';
import type { HostSetup } from './setup.ts';
import type { HostContext } from './context.ts';

/** 对话命令的输入。 */
export type CommandChatInput = {
  /** 宿主上下文（apply 收到的那一个）。 */
  ctx: HostContext;
} & Pick<ChatMemory, 'chatWithPet'> &
  Pick<HostSetup, 'log'> &
  Pick<ChatMemory, 'publishWhisper'> &
  Pick<PetLookup, 'sleep'> &
  Pick<PetLookup, 'sleepRefusalText'> &
  Pick<BalancePoll, 'resolveActivePetId'>;

/** 注册对话命令；返回的清理函数由 ctx.effect 收集。 */
export function registerChatCommand(deps: CommandChatInput): void {
  const { ctx, chatWithPet, log, publishWhisper, resolveActivePetId, sleep, sleepRefusalText } = deps;
  // /chat 斜杠命令：无参数 = 碎碎念一句（手动语义：不受 whisperEnabled 门控，那个字段只关自动
  // 周期）；有参数 = 正常对话（走 chatWithPet 同一条路径：记忆 + 人设 + 写盘）。
  // 两个分支都是 fire-and-forget：回执不等模型，文本一律写进 S 的 pets.<id>.say，前端轮询后弹气泡。
  ctx.effect(
    () =>
      ctx.commands.register({
        name: 'chat',
        description: '与桌宠对话：留空 = 碎碎念一句；输入消息 = 正常对话',
        input: { hint: '[消息]（留空 = 碎碎念）' },
        handler: ({ rawInput }: { rawInput: string }) => {
          const petId = resolveActivePetId();
          if (!petId) return { kind: 'error', text: '没有可交互的桌宠' };
          // 睡觉：命令也是「手动打扰」，回拒绝台词而不是叫模型（省一次调用，也符合睡着不说话的设定）
          if (sleep.sleeping(petId)) return { kind: 'error', text: sleepRefusalText(petId) };
          const text = rawInput.trim();
          if (!text) {
            void publishWhisper(petId).catch((e: unknown) =>
              log.warn('[dsh-pet] 碎碎念异常：' + (e instanceof Error ? e.message : String(e))),
            );
            return { kind: 'success', text: '已让桌宠碎碎念一句' };
          }
          if (text.length > CHAT_MESSAGE_LIMIT)
            return { kind: 'error', text: `消息过长（限 ${CHAT_MESSAGE_LIMIT} 字）` };
          void chatWithPet(petId, text)
            .then((r) => {
              if (!r.ok) {
                log.warn('[dsh-pet] 对话失败 reason=' + r.reason + (r.message ? ' ' + r.message : ''));
              }
            })
            // 生成链自己会把业务失败变成 ok:false，走到这里的是真异常（写盘/读配置抛）：
            // 不接住就是 unhandled rejection，Node 默认终止宿主进程。
            .catch((e: unknown) => log.warn('[dsh-pet] 对话异常：' + (e instanceof Error ? e.message : String(e))));
          return { kind: 'success', text: '已发送，桌宠马上回应' };
        },
      }),
    'dsh-pet: /chat command',
  );
}
