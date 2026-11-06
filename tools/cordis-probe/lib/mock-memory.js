/**
 * Mock 记忆实现：按宠物保留最近 5 轮问答，用户问“记得/之前/上次”时把最近一轮作为证据注入，
 * 并要求模型复读一个标记——回复出现该标记，才能证明 recall 真的改写了内容（原生历史给不出它）。
 *
 * 验证 `petApi7340.memory` 的两条入口：`recall` 在生成前改本轮内容，`capture` 在落盘后收这一轮；
 * `stats().captured` 给开关路由做“capture 真的被调用”的证据。
 * 不联网、不落盘；进程内存态，重启即空。
 * @module dsh-cordis-probe/mock-memory
 */

/** 每只宠物保留的轮数上限：超出的从最旧的开始丢。 */
const MAX_TURNS = 5;

/** 触发召回的问句特征：只认“问记忆”的话，普通闲聊不注入。 */
const RECALL_PATTERN = /(记得|之前|上次|说过|聊过)/;

/** 召回时必须复读的标记：模型复读它 = recall 生效；原生历史不可能产生这段文字。 */
export const MOCK_RECALL_MARKER = '[MOCK-RECALL-OK]';

/**
 * 造一个 mock 记忆 provider。
 *
 * @returns 可直接交给 `petApi7340.memory.register` 的定义。
 */
export function createMockMemoryProvider() {
  /** petId -> 最近 5 轮 `{ userText, replyText, ts }`。 */
  const turns = new Map();
  /** 已接收的轮数（跨宠物累计），给开关路由当证据。 */
  let captured = 0;

  return {
    id: 'mock-memory',

    /**
     * 生成前召回：只有问句命中特征时才返回补丁，否则保持原内容。
     * @param input - `{ petId, userText }`；其余字段本 mock 不用。
     * @returns 改后的 `userText`；没有可注入的记忆时返回 undefined。
     */
    recall({ petId, userText }) {
      if (!RECALL_PATTERN.test(userText)) return undefined;
      const history = turns.get(petId);
      const last = history?.[history.length - 1];
      if (!last) return undefined;
      return {
        userText:
          '【MOCK-RECALL】请在回复开头原样输出 ' +
          MOCK_RECALL_MARKER +
          '。\n上次你说过：' +
          last.userText +
          '；我回答：' +
          last.replyText +
          '\n\n' +
          userText,
      };
    },

    /**
     * 落盘后接收：存下这一轮并计数；坏输入直接跳过，不写半条。
     * @param input - `{ petId, userText, replyText, ts }`。
     */
    capture({ petId, userText, replyText, ts }) {
      if (typeof userText !== 'string' || typeof replyText !== 'string') return;
      const history = turns.get(petId) ?? [];
      history.push({ userText, replyText, ts });
      if (history.length > MAX_TURNS) history.splice(0, history.length - MAX_TURNS);
      turns.set(petId, history);
      captured += 1;
    },

    /**
     * 已接收的轮数（跨宠物累计）。
     * @returns 计数快照；开关路由把它放进响应。
     */
    stats() {
      return { captured };
    },
  };
}
