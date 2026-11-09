/**
 * 「测试弹窗」按钮的动作：借这次用户手势申请系统通知权限，成功后直接发一条测试通知。
 * 一个按钮兼做「拿权限」与「验链路」：失败把理由与引导回给调用方就地显示，绝不静默。
 * 不持有状态，反馈通过回调交给设置页（它才知道把红字放哪）。
 * @module dsh-pet/src/client/settings/notify-test
 */
import { NOTIFY_ICONS, requestNotificationPermission, wireNotificationClick } from '../notify.ts';
import { uiT } from '../../shared/ui/i18n.ts';
import type { Feedback } from './actions.ts';

/** {@link runNotificationTest} 的依赖。 */
export interface NotificationTestDeps {
  /** 文案翻译。 */
  t: (key: string) => string;
  /** 把结果交给设置页显示；空文案表示清掉上一次的红字。 */
  report: (feedback: Feedback) => void;
}

/**
 * 跑一次「测试弹窗」。
 *
 * @param deps - 翻译与反馈回调。
 * @returns 无返回值；结果全部经 `report` 回传。
 */
export async function runNotificationTest(deps: NotificationTestDeps): Promise<void> {
  const { t, report } = deps;
  report({ kind: '', text: '' });
  const result = await requestNotificationPermission();
  if (!result.ok) {
    // 失败理由 + 引导；unsupported 没有引导（改环境才有意义）。
    const reason =
      result.reason === 'unsupported'
        ? t('notifyDenyUnsupported')
        : result.reason === 'denied'
          ? t('notifyDenyBlocked')
          : result.reason === 'rejected'
            ? t('notifyDenyRejected')
            : t('notifyDenyError') + (result.message ? '：' + result.message : '');
    report({ kind: 'err', text: reason + (result.reason === 'unsupported' ? '' : ' ' + t('notifyGuide')) });
    return;
  }
  try {
    // 绕过聚焦门直接发一条测试通知；点击行为与真实事件通知共用 wireNotificationClick。
    wireNotificationClick(
      new Notification(uiT('notifyTest.title'), { body: uiT('notifyTest.body'), icon: NOTIFY_ICONS.test }),
    );
  } catch {
    /* 个别环境构造失败：仍按已授权提示。 */
  }
  report({ kind: 'ok', text: t('notifyTestOk') });
}
