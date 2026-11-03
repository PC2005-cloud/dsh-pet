/**
 * 宠物卡的 DOM 结构：根节点、舞台与两路视频、命中区、气泡槽、悬浮提示。
 * 不持有状态、不做判定：尺寸变量、定位样式与事件回调都由 PetCard 当帧传入，这里只按顺序拼装。
 * 依赖注入的 h、pet/motion/geometry 的命中区样式与 shared/tooltip 的类名。
 * 不变量：命中区在 stage 内，气泡与提示是根节点的直接子节点——三者的定位都相对根节点。
 * @module dsh-pet/src/client/pet/card/view
 */
import { PET_HIT_STYLE } from '../motion/geometry.ts';
import { TOOLTIP_CLASS } from '../../../shared/tooltip.ts';
import type { CSSProperties, ReactNode } from 'react';
import type * as ReactNS from 'react';
import type { jsx } from 'react/jsx-runtime';
import type { Corner } from '../../../shared/types.ts';

/** 宠物卡视图的渲染输入：全部是当帧的值、ref 与事件回调。 */
export interface CardViewProps {
  /** 根节点：定位与尺寸变量的宿主。 */
  rootRef: ReactNS.MutableRefObject<HTMLDivElement | null>;
  /** 舞台：位移恒定，脚底垫高不随拖拽取消。 */
  stageRef: ReactNS.MutableRefObject<HTMLDivElement | null>;
  /** 前台视频（A/B 双缓冲之一）。 */
  videoARef: ReactNS.MutableRefObject<HTMLVideoElement | null>;
  /** 后台视频。 */
  videoBRef: ReactNS.MutableRefObject<HTMLVideoElement | null>;
  /** 悬浮提示：位置由 placeTip 直接写 style。 */
  tipRef: ReactNS.MutableRefObject<HTMLDivElement | null>;
  /** 角落定位，写进 data-corner 由 CSS 取值。 */
  corner: Corner;
  /** 朝向，写进 data-facing 由 CSS 镜像。 */
  facing: 'left' | 'right';
  /** 宠物宽度 px，注入 --dsh-pet-size。 */
  size: number;
  /** 水平边距 px。 */
  marginX: number;
  /** 垂直边距 px。 */
  marginY: number;
  /** 气泡正文字号 px。 */
  fontBubblePx: number;
  /** 悬浮提示字号 px。 */
  fontTipPx: number;
  /** 根节点定位样式；未拖拽时为空对象，位置交给角落与边距的 CSS 变量。 */
  rootStyle: CSSProperties;
  /** 舞台位移样式；拖拽中取消脚垫位移。 */
  stageStyle: CSSProperties;
  /** 当前该挂的气泡；null 表示无气泡。 */
  bubble: ReactNode;
  /** 悬浮提示是否点亮。 */
  tipOn: boolean;
  /** 宠物名：悬浮提示内容，同时作为命中区的无障碍名称。 */
  name: string;
  /** 点击命中区。 */
  onClick(e: ReactNS.MouseEvent<HTMLDivElement>): void;
  /** 按下：开启指针捕获与拖拽。 */
  onPointerDown(e: ReactNS.PointerEvent<HTMLDivElement>): void;
  /** 指针移动：拖拽跟随。 */
  onPointerMove(e: ReactNS.PointerEvent<HTMLDivElement>): void;
  /** 抬起与取消共用一条路径。 */
  onPointerUp(e: ReactNS.PointerEvent<HTMLDivElement>): void;
  /** 指针进入命中区。 */
  onPointerEnter(e: ReactNS.PointerEvent<HTMLDivElement>): void;
  /** 指针离开命中区。 */
  onPointerLeave(): void;
  /** 右键菜单。 */
  onContextMenu(e: ReactNS.MouseEvent<HTMLDivElement>): void;
}

/** 两路视频的共同属性：静音、内联播放并自动播放。 */
const VIDEO_PROPS = { muted: true, playsInline: true, autoPlay: true };

/**
 * 制造宠物卡视图。
 *
 * @param rt - 注入的 react 能力。
 * @returns 只做拼装的纯展示组件。
 */
export function makeCardView(rt: { h: typeof jsx }) {
  const { h } = rt;

  return function CardView(props: CardViewProps) {
    return h('div', {
      ref: props.rootRef,
      className: 'dsh-pet-root',
      'data-corner': props.corner,
      'data-facing': props.facing,
      style: Object.assign(
        {
          '--dsh-pet-size': props.size + 'px',
          '--dsh-pet-mx': props.marginX + 'px',
          '--dsh-pet-my': props.marginY + 'px',
          // 字号注入最终 px；CSS 侧带原值回退，漏注入也不会坏。
          '--dsh-pet-font-bubble': props.fontBubblePx + 'px',
          '--dsh-pet-font-tip': props.fontTipPx + 'px',
        },
        props.rootStyle,
      ),
      children: [
        // 气泡单槽；余额不可用说明也走这里，手动请求与命令气泡不受 whisperEnabled 限制。
        props.bubble,
        h('div', {
          ref: props.stageRef,
          className: 'dsh-pet-stage',
          style: props.stageStyle,
          children: [
            h('video', Object.assign({}, VIDEO_PROPS, { ref: props.videoARef, className: 'dsh-pet-video is-front' })),
            h('video', Object.assign({}, VIDEO_PROPS, { ref: props.videoBRef, className: 'dsh-pet-video' })),
            h('div', {
              className: 'dsh-pet-hit',
              style: PET_HIT_STYLE,
              onClick: props.onClick,
              onPointerDown: props.onPointerDown,
              onPointerMove: props.onPointerMove,
              onPointerUp: props.onPointerUp,
              onPointerCancel: props.onPointerUp,
              onPointerEnter: props.onPointerEnter,
              onPointerLeave: props.onPointerLeave,
              onContextMenu: props.onContextMenu,
              // 原生 title 换成自绘浮层后，无障碍名称仍要保留。
              'aria-label': props.name,
            }),
          ],
        }),
        // 悬浮提示常驻只切 class，挂卸节点吃不到淡入过渡；坐标由 placeTip 直接写 style。
        // pointer-events:none 见 TOOLTIP_CSS，否则会挡住命中区导致 enter/leave 闪烁。
        h('div', {
          ref: props.tipRef,
          className: TOOLTIP_CLASS + (props.tipOn ? ' is-on' : ''),
          'aria-hidden': 'true',
          children: props.name,
        }),
      ],
    });
  };
}
