/**
 * 对话中的只读插件推荐卡与逐项显式安装按钮。
 * 报告到期禁用安装；卸载中止请求，历史重读不会自动重查或安装插件。
 * React 运行时来自宿主注入，文件与版本选择始终归宿主推荐服务。
 * @module dsh-pet/src/client/chat/wow-recommendations
 */
import type { AddonRecommendationReport } from '../../host/wow/shared/wow-addon-recommendations.ts';
import type { ChatPanelRuntime } from './runtime.ts';
import { installWowRecommendation, recommendationProjectUrl, recommendationText } from './wow-recommendation-api.ts';

type ReportProps = { report: AddonRecommendationReport };
type ItemState = { phase: 'installing' | 'installed' | 'failed'; message: string };
const components = new WeakMap<ChatPanelRuntime, (props: ReportProps) => unknown>();

/** 在每个聊天运行时复用组件类型，保持逐项安装状态。 */
export function wowRecommendationsNode(rt: ChatPanelRuntime, report: AddonRecommendationReport): unknown {
  let component = components.get(rt);
  if (component === undefined) {
    component = makeWowRecommendations(rt);
    components.set(rt, component);
  }
  return rt.h(component, { key: report.id, report });
}

/** 创建推荐报告组件，离线浏览器测试也复用此入口。 */
export function makeWowRecommendations(rt: ChatPanelRuntime): (props: ReportProps) => unknown {
  return function WowRecommendations({ report }: ReportProps): unknown {
    const t = (zh: string, en: string): string => recommendationText(report, zh, en);
    const [items, setItems] = rt.useState<Record<string, ItemState>>({});
    const [now, setNow] = rt.useState(Date.now());
    const requests = rt.useRef(new Map<number, AbortController>());
    rt.useEffect(() => {
      const active = requests.current;
      const timer = setTimeout(
        () => setNow(Date.now()),
        Math.max(0, Math.min(report.expiresAt - Date.now() + 1, 2147483647)),
      );
      return () => {
        clearTimeout(timer);
        for (const request of active.values()) request.abort();
        active.clear();
      };
    }, [report.id]);
    const install = (modId: number): void => {
      if (requests.current.has(modId) || items[modId]?.phase === 'installed') return;
      const controller = new AbortController();
      requests.current.set(modId, controller);
      setItems((previous) => ({
        ...previous,
        [modId]: { phase: 'installing', message: t('正在安装…', 'Installing…') },
      }));
      void installWowRecommendation(report, modId, controller.signal)
        .then(() => {
          if (!controller.signal.aborted)
            setItems((previous) => ({
              ...previous,
              [modId]: { phase: 'installed', message: t('安装完成', 'Installation completed') },
            }));
        })
        .catch((error: unknown) => {
          if (!controller.signal.aborted)
            setItems((previous) => ({
              ...previous,
              [modId]: {
                phase: 'failed',
                message: error instanceof Error ? error.message : String(error),
              },
            }));
        })
        .finally(() => {
          requests.current.delete(modId);
        });
    };
    const gameNames = {
      retail: t('正式服', 'Retail'),
      forever: t('无限服', 'Forever'),
      classic: t('怀旧服', 'Classic'),
    };
    return rt.h('section', {
      className: 'pet-chat-wow-report',
      'aria-label': t('魔兽插件推荐', 'Warcraft addon recommendations'),
      children: [
        rt.h('strong', {
          children: `${t('插件推荐', 'Addon recommendations')} · ${gameNames[report.game]} · ${report.versionName}`,
        }),
        rt.h('p', { className: 'pet-chat-wow-note', children: report.query }),
        rt.h('p', {
          className: 'pet-chat-wow-note',
          children:
            report.expiresAt <= now
              ? t('推荐已过期，请重新向精灵请求推荐。', 'This report expired. Ask the pet for new recommendations.')
              : t(
                  '请核对兼容版本，点击安装后才会更改本地插件目录。',
                  'Check game compatibility. The addon directory changes only after you click Install.',
                ),
        }),
        ...report.addons.map((addon) => recommendationItem(rt, report, addon, items[addon.id], now, install)),
        report.addons.length
          ? null
          : rt.h('p', { children: t('没有可用的插件推荐。', 'No addon recommendations are available.') }),
      ],
    });
  };
}

/** 项目链接、兼容分支和可安装状态均来自当前报告。 */
function recommendationItem(
  rt: ChatPanelRuntime,
  report: AddonRecommendationReport,
  addon: AddonRecommendationReport['addons'][number],
  state: ItemState | undefined,
  now: number,
  install: (modId: number) => void,
): unknown {
  const { h } = rt;
  const t = (zh: string, en: string): string => recommendationText(report, zh, en);
  const project = recommendationProjectUrl(addon.websiteUrl);
  const disabled =
    !addon.installable || report.expiresAt <= now || state?.phase === 'installing' || state?.phase === 'installed';
  return h('article', {
    key: String(addon.id),
    className: 'pet-chat-wow-item',
    children: [
      h('strong', { children: addon.name }),
      h('p', { children: addon.summary }),
      h('p', {
        className: 'pet-chat-wow-note',
        children: t(
          `文件：${addon.fileVersion} · 兼容版本：${addon.gameVersions.join(', ') || report.versionName}`,
          `File: ${addon.fileVersion} · Compatible versions: ${addon.gameVersions.join(', ') || report.versionName}`,
        ),
      }),
      project
        ? h('a', {
            href: project,
            target: '_blank',
            rel: 'noopener noreferrer',
            children: t('查看 CurseForge 项目', 'View CurseForge project'),
          })
        : null,
      h('p', {
        className: 'pet-chat-wow-note',
        children: addon.installable
          ? t('已有匹配当前分支的可安装文件。', 'An installable file matches this game branch.')
          : unavailableMessage(addon.unavailableReason, t),
      }),
      h('button', {
        type: 'button',
        disabled,
        className: 'pet-chat-wow-install',
        'aria-label': t(`安装推荐：${addon.name}`, `Install recommendation: ${addon.name}`),
        onClick: (event: { stopPropagation: () => void }) => {
          event.stopPropagation();
          install(addon.id);
        },
        children:
          state?.phase === 'installed'
            ? t('已安装', 'Installed')
            : state?.phase === 'installing'
              ? t('正在安装…', 'Installing…')
              : state?.phase === 'failed'
                ? t('重试安装', 'Retry installation')
                : t('安装此推荐', 'Install recommendation'),
      }),
      state
        ? h('p', { className: 'pet-chat-wow-note', role: 'status', 'aria-live': 'polite', children: state.message })
        : null,
    ],
  });
}

function unavailableMessage(
  reason: AddonRecommendationReport['addons'][number]['unavailableReason'],
  t: (zh: string, en: string) => string,
): string {
  const messages = {
    'curseforge-distribution-disabled': t(
      '作者未允许通过第三方工具分发，请前往项目页面。',
      'The author does not allow third-party distribution. Visit the project page.',
    ),
    'curseforge-download-unavailable': t('没有可用的兼容下载文件。', 'No compatible download is available.'),
    'curseforge-download-integrity': t(
      '下载完整性信息不足，暂不可安装。',
      'Download integrity information is insufficient for installation.',
    ),
  };
  return reason ? messages[reason] : t('此推荐暂不可安装。', 'This recommendation is not installable.');
}
