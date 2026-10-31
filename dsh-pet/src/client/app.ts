/**
 * 浏览器半侧装配层：注入 react，组装宠物 overlay 与设置页，注册进 DSH 插槽。
 * 不负责页面业务：宠物页面在 pet.ts，设置页在 settings.ts。
 * 依赖 DSH 注入的 slots / locale / remote / commandUi 等 Cordis 服务。
 * 任何可选能力缺失都只降级功能，绝不让整个插件加载失败。
 * @module dsh-pet/src/client/app
 */
import { makePetUI } from './pet.ts';
import { readPose } from './pose.ts';
import { readProgress } from './progress.ts';
import { takeMenuEvents } from './menu-service.ts';
import { getStateSnapshot } from './state-service.ts';
import { dicts, makePetConfigSection, NS, petBridge } from './settings.ts';
import { initNotify } from './notify.ts';
import { installCommandFaces, type CommandFace, type CommandUiLike } from './command-faces.ts';
import { installSectionNavIcon } from './nav-icon.ts';
import { registerPetChatTab, openPetChatTab } from './chat/register.ts';
import { PET_CHAT_COMMAND_ID, registerPetChatShortcut } from './chat/shortcut.ts';
import { registerPetCardShortcuts } from './pet/card/shortcut.ts';
import type * as ReactNS from 'react';
import type * as PrimitivesNS from '@deepseek-ai/dsh-client-ui-primitives';

/** 创建 DSH 插件 factory，返回带 name / inject / apply 的模块。 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- DSH __ModuleLoader__ 契约（f(require) => module），外部无静态类型
export function makeFactory(): (require: (mod: string) => any) => any {
  return (require) => {
    const module = { exports: {} };

    const react: typeof ReactNS = require('react');
    const { useEffect, useRef, useState, useCallback } = react;
    const { jsx: h } = require('react/jsx-runtime');

    // primitives 是平台种子模块；取不到只影响命令图标，不影响插件加载。
    let primitives: typeof PrimitivesNS | undefined;
    try {
      primitives = require('@deepseek-ai/dsh-client-ui-primitives');
    } catch (error) {
      console.warn('[dsh-pet] 图标模块不可用：' + (error instanceof Error ? error.message : String(error)));
    }

    // react-dom 也是平台种子模块，仅用于把图标同步渲成 SVG 供 CSS mask 使用。
    // 取不到就退化成齿轮图标，不影响插件加载。
    let renderIconSvg: ((icon: ReactNS.ComponentType<PrimitivesNS.IconProps>) => string) | undefined;
    try {
      const { createRoot } = require('react-dom/client');
      const { flushSync } = require('react-dom');
      renderIconSvg = (icon) => {
        const holder = document.createElement('div');
        const root = createRoot(holder);
        try {
          // flushSync：root.render 是异步调度，不同步刷一次拿不到 DOM。
          flushSync(() => root.render(h(icon, { size: 16 })));
          return holder.innerHTML;
        } finally {
          root.unmount();
        }
      };
    } catch (error) {
      console.warn(
        '[dsh-pet] 图标渲染器不可用（react-dom 缺失）：' + (error instanceof Error ? error.message : String(error)),
      );
    }

    // 宠物 overlay 与设置页各自独立成文件，这里只组装和注册。
    const PetMulti = makePetUI({ h, useState, useEffect, useRef });

    const name = 'pet';
    // commandUi 声明为服务依赖，确保「/」命令服务就绪后才 apply，/pet 装饰必然注册成功。
    const inject = ['slots', 'locale', 'connection', 'remote', 'remote.commands', 'commandUi'];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- DSH 注入的 ctx（locale/slots/webServer 等 service 无静态类型）
    function apply(ctx: any) {
      // 设置页文案字典。
      ctx.effect(() => ctx.locale.register(NS, dicts), 'dsh-pet: dictionaries');
      const t = ctx.locale.bind(NS);

      // 同页第三方插件可通过 Cordis 服务 petApi7340 读取本页宠物的实况、播放进度、最近一拍状态与菜单点击。
      // 只开读，控制仍走 HTTP，避免出现两条控制通道。
      // 服务名带 7340 后缀避免与生态里的同名服务冲突；Cordis 同名 provide 会直接抛错。
      // 消费者用 ctx.get('petApi7340') 探测，拿不到就是老版本；`getState` / `menuEvents` 也要单独探测（老版本没有它们）。
      ctx.provide('petApi7340', {
        getState: getStateSnapshot,
        menuEvents: takeMenuEvents,
        pose: readPose,
        progress: readProgress,
      });

      // 系统通知：host 把通知帧写进 /state 的 sections.notify，统一轮询发现变化后弹 toast。
      ctx.effect(
        () =>
          initNotify({
            // 惰性取服务：它可能晚于本插件注册；缺失时退化为只把窗口叫回前台。
            // eslint-disable-next-line @typescript-eslint/no-explicit-any -- DSH 注入服务无静态类型
            openSession: (sessionId: string) => (ctx as any).get?.('uiWorkspace')?.openSession?.(sessionId),
            // 通知标题用会话名：会话列表里那一行的 title；空白会话 / 未命名会话取到空串就返回 undefined。
            sessionTitle: (sessionId: string) => {
              // eslint-disable-next-line @typescript-eslint/no-explicit-any -- DSH 注入服务无静态类型
              const row = (ctx as any).get?.('sessions')?.list?.getSnapshot?.()?.byId?.[sessionId];
              const name = typeof row?.title === 'string' ? row.title.trim() : '';
              return name || undefined;
            },
          }),
        'dsh-pet: notifications',
      );

      // /pet 选择框：选中后提交 /pet <id>，由 host 命令落地。
      // commandUi 已是服务依赖，但仍保留缺失时的降级提示。
      ctx.effect(() => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- DSH 注入服务无静态类型
        const commandUi = (ctx as any).get?.('commandUi');
        if (!commandUi || typeof commandUi.decorate !== 'function') {
          console.warn('[dsh-pet] 命令选择框不可用：commandUi 服务缺失（/pet 仍可手输 id 或名字）');
          return () => {};
        }
        return commandUi.decorate({
          name: 'pet',
          available: () => true,
          ui: {
            kind: 'popupSelect',
            // 选项来自当前生效宠物列表，name 已兜底。
            options: async () =>
              petBridge.current.map((p) => ({
                id: p.id,
                label: p.name || p.id,
                detail: (p.assetRoot && p.assetRoot !== p.id ? p.assetRoot + ' / ' : '') + p.id,
              })),
            // 选中后提交 /pet <id>，由 host 校验并设置当前桌宠。
            onSelect: async (option: { id: string }, session: { sessionId: string }) => {
              // eslint-disable-next-line @typescript-eslint/no-explicit-any -- remote 无静态类型
              await (ctx as any).remote?.commands?.execute(session.sessionId, '/pet ' + option.id, []);
            },
          },
        });
      }, 'dsh-pet: /pet picker');

      // 给 /chat /pet /balance 补上「/」菜单的行标题与图标。
      // DSH 没有官方入口，这里包装 commandUi.candidates；命令本身的行为不受影响。
      // 依据与降级策略见 command-faces.ts。
      ctx.effect(() => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- DSH 注入服务无静态类型
        const commandUi = (ctx as any).get?.('commandUi') as CommandUiLike | undefined;
        const icons = primitives;
        if (commandUi === undefined || icons === undefined) {
          console.warn('[dsh-pet] 命令图标不可用（命令本身仍可用，只是没有图标）');
          return () => {};
        }
        return installCommandFaces(
          commandUi,
          new Map<string, CommandFace>([
            // 对话气泡：94 个内置图标里唯一的纯对话气泡。
            ['chat', { label: () => t('cmd.chat'), icon: icons.IconQueueOutlineRegular }],
            // 双人形：从多只桌宠里挑一只。
            ['pet', { label: () => t('cmd.pet'), icon: icons.IconUsersOutlineRegular }],
            // 仪表盘：额度与用量。
            ['balance', { label: () => t('cmd.balance'), icon: icons.IconGaugeOutlineRegular }],
          ]),
        );
      }, 'dsh-pet: command faces');

      // 设置页导航「桌宠配置」的图标：DSH 只给白名单分区配图标，只能在 DOM 层补。
      // 依据与降级策略见 nav-icon.ts。
      ctx.effect(() => {
        const renderIcon = renderIconSvg;
        const icon = primitives?.IconSlidersTwoOutlineMedium;
        if (renderIcon === undefined || icon === undefined) {
          console.warn('[dsh-pet] 设置页导航图标不可用（那一行仍是齿轮）');
          return () => {};
        }
        return installSectionNavIcon({ label: () => t('nav'), renderSvg: () => renderIcon(icon) });
      }, 'dsh-pet: settings nav icon');

      // 宠物 overlay：容器渲染多个 PetCard。
      ctx.slots.inject('shell.overlay', function* () {
        yield ctx.slots.register({ name: 'shell.overlay', id: 'pet', order: 1000 }, () => h(PetMulti, {}));
      });

      // 设置页「桌宠配置」：大小、位置、模型，保存即时生效。
      // useRef 供「AI 模型」下拉的浮层定位与外部点击判定使用。
      const PetConfigSection = makePetConfigSection({ h, useState, useEffect, useRef, useCallback, t });
      ctx.slots.inject('settings.section', function* () {
        yield ctx.slots.register(
          { name: 'settings.section', id: 'pet-config', order: 30, label: () => t('nav'), inject: () => ({ t }) },
          PetConfigSection,
        );
      });

      // 快捷键独立注册：不挂在侧栏注册里——侧栏服务缺失时侧栏没了，快捷键不该跟着没。
      // 三条命令共用 app-shortcut 的注册壳，任何一条失败都只丢它自己。
      let sidebarChatReady = false;
      ctx.effect(() => {
        const sidebarChat = registerPetChatShortcut(
          ctx,
          () => t('shortcut.open'),
          () => openPetChatTab(ctx),
        );
        sidebarChatReady = sidebarChat.registered;
        const card = registerPetCardShortcuts(ctx, (key) => t(key));
        return () => {
          sidebarChatReady = false;
          sidebarChat.dispose();
          card.dispose();
        };
      }, 'dsh-pet: shortcuts');

      // 右侧栏「桌宠对话」：可选能力，服务缺失时只告警，不影响其它部位。
      // 确认弹窗用平台原语（primitives 缺失时面板内部退化为内联确认条）。
      // 整体再兜一层：任何注册异常都不许拖垮插件激活（否则整个 Web 端进不去）。
      ctx.effect(() => {
        try {
          return registerPetChatTab(
            ctx,
            {
              h,
              useEffect,
              useRef,
              useState,
              ...(primitives === undefined
                ? {}
                : {
                    ui: {
                      Modal: primitives.Modal,
                      Button: primitives.Button,
                      ImageLightbox: primitives.ImageLightbox,
                    },
                  }),
            },
            // 命令没登记成功就不带 commandId：指向不存在的命令会让侧栏注册抛错
            sidebarChatReady ? { commandId: PET_CHAT_COMMAND_ID } : {},
          );
        } catch (error) {
          console.error('[dsh-pet] 右侧栏对话面板注册失败（已忽略，不影响启动）：', error);
          return () => {};
        }
      }, 'dsh-pet: sidebar chat tab');
    }

    module.exports = { apply, inject, name };
    return module.exports;
  };
}
