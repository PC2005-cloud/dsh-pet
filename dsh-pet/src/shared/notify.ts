/**
 * 系统通知：DSH 事件帧 → toast 文案的映射，只随浏览器半侧走。
 * 帧由宿主半侧监听 DSH 宿主事件生成（见 host/notify-events.ts），浏览器轮询 /notify 的增量队列消费本映射。
 * 桌面模式是宠物本体，不重复实现通知（宠物不等于通知，「两端一致」只约束宠物行为）。
 * 纯函数无副作用：帧形状不匹配或不认识的类型一律返回 null，不弹也不报错。
 * @module dsh-pet/src/shared/notify
 */
/** 通知图标文件名（不含扩展名）；浏览器半侧拼完整 URL：/dsh-pet-7340/pic/<name>.png。 */
export const NOTIFY_ICONS = {
  done: 'notify-done',
  error: 'notify-error',
  truncated: 'notify-truncated',
  approval: 'notify-approval',
  question: 'notify-question',
  test: 'notify-test',
} as const;

/** 文案截断长度上限（字符）。 */
export const MAX_BODY = 80;

/** 文案截断（与弹窗一致：超长只留前 80 字符）。 */
export function truncate(text: string): string {
  return text.length > MAX_BODY ? text.slice(0, MAX_BODY) + '…' : text;
}

/** 通知帧：宿主半侧转发过来的一条 DSH 事件。 */
export interface NotifyFrame {
  type: string;
  /** 发出这条通知的会话 id；点击通知时据此跳到那条会话。
   *  没有会话位置的事件（host/agent-error）不带这个字段，消费端把缺失当成「只叫窗口」。 */
  sessionId?: string;
  [key: string]: unknown;
}

/** turn/end 事件在帧里的形状。 */
interface TurnEndEvent {
  type?: string;
  data?: {
    reason?: { kind?: string; error?: { message?: string } };
    /** 宿主带过来的最后一条回复开头；没有就回落空正文。 */
    text?: string;
  };
}

/** 帧 → toast 文案；不认识的类型或 turn/end 的非弹分支（aborted 等）返回 null。 */
export function frameToToast(frame: NotifyFrame): { title: string; body: string; icon: string } | null {
  switch (frame.type) {
    case 'session/event': {
      const ev = (frame.event ?? {}) as TurnEndEvent;
      if (ev.type !== 'turn/end') return null;
      const kind = ev.data?.reason?.kind;
      if (kind === 'completed') {
        const text = typeof ev.data?.text === 'string' ? ev.data.text.trim() : '';
        return { title: '对话完成', body: text ? truncate(text) : '', icon: NOTIFY_ICONS.done };
      }
      if (kind === 'error')
        return { title: '生成失败', body: ev.data?.reason?.error?.message ?? '', icon: NOTIFY_ICONS.error };
      if (kind === 'max-tokens')
        return { title: '输出被截断', body: '已达到输出 token 上限', icon: NOTIFY_ICONS.truncated };
      // aborted（用户/父代理取消）、interrupted（崩溃恢复）等：不弹
      return null;
    }
    case 'approval/requested': {
      const toolName = typeof frame.toolName === 'string' ? frame.toolName : '';
      const reason = typeof frame.reason === 'string' && frame.reason ? frame.reason : '';
      return {
        title: '正在申请权限',
        body: (toolName ? '工具「' + toolName + '」' : '') + (reason ? '：' + reason : ''),
        icon: NOTIFY_ICONS.approval,
      };
    }
    case 'question/requested': {
      const q =
        (Array.isArray(frame.questions) && (frame.questions as Array<{ question?: string }>)[0]?.question) || '';
      return { title: '模型在等你回答', body: q, icon: NOTIFY_ICONS.question };
    }
    case 'host/agent-error': {
      return {
        title: '生成失败',
        body: typeof frame.message === 'string' ? (frame.message as string) : '',
        icon: NOTIFY_ICONS.error,
      };
    }
    default:
      return null;
  }
}
