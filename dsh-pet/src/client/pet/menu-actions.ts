/**
 * 右键菜单的动作派发：把菜单叶子（内置动作、第三方项、显示位置、点播动画）翻译成一次副作用。
 * 只做「点了之后发生什么」，不建菜单、不管浮层定位与开关时序——那些归右键入口。
 * 依赖以取值函数注入，避免捕获渲染期的状态快照。
 * @module dsh-pet/src/client/pet/menu-actions
 */
import { isNoMirrorAnimation } from '../../shared/menu.ts';
import type { MenuLeaf } from '../../shared/menu.ts';
import { ROUTE_PATH } from '../../shared/constants.ts';
import type { Animations } from '../../shared/types.ts';
import { postAction } from '../../shared/state.ts';
import { markVoicePending } from '../../shared/voice.ts';
import { setMenuClick } from '../menu-service.ts';

/** 菜单派发的依赖。 */
export interface MenuActionDeps {
  /** 宠物 id：上报、点播与显示位置切换都要带。 */
  petId: string;
  /** 该宠物的动画池（移动池、分类镜像规则都读它）。 */
  animations: () => Animations;
  /** 当前朝向是否为右（文字类动画强制朝左前先看它）。 */
  isFacingRight: () => boolean;
  /** 把朝向改成左，并同步给换源用的事实值。 */
  faceLeft: () => void;
  /** 试发起一次走位；`true` = 占用中，`false` = 无法移动，字符串 = 动作名。 */
  tryMove: (preferredName?: string) => boolean | string;
  /** 停掉走位与位置跟随。 */
  stopMove: () => void;
  /** 停掉抛掷飞行。 */
  stopThrow: () => void;
  /** 提交一次自播切换（once 语义）。 */
  playOnce: (anim: string, playbackId: string | null) => void;
  /** 清掉会话位置，回到配置角落。 */
  resetPosition: () => void;
  /** 打开对话弹窗。 */
  openChat: () => void;
  /** 打开待办面板。 */
  openTodo: () => void;
  /** 上报点播回执。 */
  report: (playbackId: string, status: 'failed', reason: string) => void;
  /** 显示位置切换后，把宿主回的成品聚合交给容器重渲染。 */
  applyMerged: (merged: Record<string, Record<string, unknown>>) => void;
  /** 动作失败时打一行告警（文案自带原因）。 */
  warn: (message: string) => void;
}

/** 菜单动作派发器。 */
export interface MenuActions {
  /**
   * 执行一个菜单叶子。
   *
   * @param leaf - 菜单叶子：内置动作或一个待点播的动画。
   * @param playbackId - 本次点播编号；自播动画不传。
   * @param keepFacing - 跳过「文字类强制朝左」的镜像修正，显式朝向优先。
   */
  run: (leaf: MenuLeaf, playbackId?: string, keepFacing?: boolean) => void;
}

/** 显示位置：写配置后宿主回成品聚合，交给容器重渲染。 */
async function switchDisplay(deps: MenuActionDeps, display: string): Promise<void> {
  try {
    const response = await fetch(ROUTE_PATH + '/pet-display', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: deps.petId, display }),
    });
    if (!response.ok) throw new Error('pet-display HTTP ' + response.status);
    const body = (await response.json()) as Record<string, unknown>;
    // 业务失败是 HTTP 200 + {ok:false, reason}：只看状态码会把失败体当成成品聚合。
    if (body.ok === false) throw new Error('pet-display 被拒：' + String(body.reason ?? ''));
    // 响应体就是改动后的成品聚合，必须交给容器；否则会再拉一次 GET /config，可能拿到旧值。
    deps.applyMerged(body as Record<string, Record<string, unknown>>);
  } catch (error) {
    deps.warn('[dsh-pet] 显示位置切换失败 ' + (error instanceof Error ? error.message : String(error)));
  }
}

/**
 * 造菜单派发器。
 *
 * @param deps - 宠物标识、动画池与各种副作用回调。
 * @returns 单一入口 {@link MenuActions.run}。
 */
export function createMenuActions(deps: MenuActionDeps): MenuActions {
  const { petId } = deps;

  /** 动作端点：POST 一次，失败只留一行 warn——结果由 /state 送回，这里没有返回值可用。 */
  const fireAction = (route: string, label: string): void => {
    postAction(route)
      .then((ok: boolean) => {
        if (!ok) deps.warn('[dsh-pet] ' + label + '失败 pet=' + petId);
      })
      .catch((error: unknown) => deps.warn('[dsh-pet] ' + label + '异常 pet=' + petId + ' ' + String(error)));
  };

  const run = (leaf: MenuLeaf, playbackId?: string, keepFacing = false): void => {
    if (leaf.action === 'third-party') {
      // 第三方菜单项只上报 owner、label 与当前宠物 id，具体动作由注册方查询。
      const owner = leaf.owner ?? '';
      if (owner !== '') {
        // 同页消费者（petApi7340.menuEvents）当场就能取到；HTTP 照旧上报，桌面端与老扩展仍读宿主那份。
        setMenuClick(owner, leaf.label, petId);
        postAction(ROUTE_PATH + '/menu/click', { owner, label: leaf.label, pet: petId }).catch((error: unknown) =>
          deps.warn('[dsh-pet] 第三方菜单点击上报失败 ' + String(error)),
        );
      }
      return;
    }
    if (leaf.action === 'show-balance') {
      // 动作端点让宿主刷新并写入 /state，页面什么都不用做。
      console.info('[dsh-pet] 菜单查看余额 pet=' + petId);
      fireAction(ROUTE_PATH + '/balance', '余额刷新动作');
      return;
    }
    if (leaf.action === 'whisper') {
      // 手动碎碎念：文本随长轮询送达，不受 whisperEnabled 限制；surface 必填，本页面就是网页端。
      console.info('[dsh-pet] 菜单触发碎碎念 pet=' + petId);
      // 手动入口才播语音：标记归本端，周期触发的碎碎念没有标记，因此静音。
      markVoicePending();
      fireAction(ROUTE_PATH + '/whisper?pet=' + encodeURIComponent(petId) + '&surface=web', '碎碎念手动触发');
      return;
    }
    if (leaf.action === 'chat') {
      deps.openChat();
      return;
    }
    if (leaf.action === 'todo') {
      deps.openTodo();
      return;
    }
    if (leaf.action === 'set-display') {
      const display = leaf.display;
      if (!display) return;
      console.info('[dsh-pet] 菜单切换显示位置 pet=' + petId + ' display=' + display);
      void switchDisplay(deps, display);
      return;
    }
    if (leaf.action === 'home') {
      // 回到初始位置：停漫游与抛掷，清掉会话位置，回配置角落。
      deps.stopThrow();
      deps.stopMove();
      deps.resetPosition();
      return;
    }
    if (!leaf.anim) return;
    const cuePlaybackId = playbackId ?? null;
    // 文字类朝右站姿是镜像的，点播前强制朝左；keepFacing 时跳过，显式朝向优先。
    if (!keepFacing && isNoMirrorAnimation(deps.animations().categories, leaf.anim) && deps.isFacingRight()) {
      deps.faceLeft();
    }
    // 点播移动动画：走真实位移，仅「选哪个动画」由菜单决定；边界内挪不动时退化为纯播放。
    const movies = deps.animations().moves.actions;
    if (movies.some((action) => action.name === leaf.anim)) {
      if (deps.tryMove(leaf.anim) === false) {
        deps.stopMove();
        deps.playOnce(leaf.anim, cuePlaybackId);
      } else if (cuePlaybackId !== null) {
        // 移动系统接管，不换视频源，本段点播不会真的播起来，如实回 failed。
        deps.report(cuePlaybackId, 'failed', 'busy');
      }
      return;
    }
    deps.stopMove();
    deps.playOnce(leaf.anim, cuePlaybackId);
  };

  return { run };
}
