// client 半侧「装配层」：注入 react → 组装两个页面组件 → 注册进 DSH 插槽。
// 页面代码不在本文件：宠物页面在 pet.ts，设置页在 settings.ts——
// 类似 Vue 的 App.vue 只挂根组件、SpringBoot 启动类只做装配，不写页面业务。
import { makePetUI } from './pet';
import { makePetConfigSection, NS, zh, en, petBridge } from './settings';
import { startNotify } from './notify';
import type * as ReactNS from 'react';

/**
 * 返回 DSH 插件 factory：`(require) => module`。
 * 插件三件套（name / inject / apply）都在其返回的 module 上。
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- DSH __ModuleLoader__ 契约（f(require) => module），外部无静态类型
export function makeFactory(): (require: (mod: string) => any) => any {
  return (require) => {
    const module = { exports: {} };

    const react: typeof ReactNS = require('react');
    const { useEffect, useRef, useState } = react;
    const { jsx: h } = require('react/jsx-runtime');

    // 宠物页面（overlay）与配置设置页：组件各自独立文件，这里只组装 + 注册
    const PetMulti = makePetUI({ h, useState, useEffect, useRef });

    const name = 'pet';
    // commandUi 写成服务依赖（与官方 client-ui-permission-presets 的写法一致）：
    // 让 cordis 等「/」命令入口服务就绪后才 apply 本插件，保证 /pet 装饰必然注册成功。
    const inject = ['slots', 'locale', 'connection', 'remote', 'remote.commands', 'commandUi'];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- DSH 注入的 ctx（locale/slots/webServer 等 service 无静态类型）
    function apply(ctx: any) {
      // 本地化字典（设置页文案）
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-pet: dictionaries');
      const t = ctx.locale.bind(NS);

      // 系统通知：订阅 DSH 事件流（对话完成/生成失败/权限申请/用户选择），窗口失焦时弹出
      ctx.effect(() => {
        const api = ctx.connection?.api;
        if (api && typeof api?.events?.mux === 'function' && typeof api?.events?.host === 'function') {
          const ac = new AbortController();
          void startNotify(api, ac.signal);
          return () => ac.abort();
        }
        console.warn('[dsh-pet] 系统通知未启动：connection 服务不可用');
        return () => {};
      }, 'dsh-pet: notifications');

      // /pet 选择框：裸输 /pet 回车或菜单点选时弹出桌宠列表，选中后提交 /pet <id> 由 host 命令落地。
      // commandUi 已声明为服务依赖（上方 inject）：插件只在「/」命令服务就绪后 apply，
      // 装饰注册有保障；仍保留缺失时的降级提示，防止异常装配下静默失效。
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
            // 选项 = 当前生效宠物列表（petBridge.current：主宠物 + 文件宠物，name 已兜底）
            options: async () =>
              petBridge.current.map((p) => ({
                id: p.id,
                label: p.name || p.id,
                detail: (p.assetRoot && p.assetRoot !== p.id ? p.assetRoot + ' / ' : '') + p.id,
              })),
            // 选中 → 提交 /pet <id>（host handler 校验并设置当前桌宠，命令节点回显名字）
            onSelect: async (option: { id: string }, session: { sessionId: string }) => {
              // eslint-disable-next-line @typescript-eslint/no-explicit-any -- remote 无静态类型
              await (ctx as any).remote?.commands?.execute(session.sessionId, '/pet ' + option.id, []);
            },
          },
        });
      }, 'dsh-pet: /pet picker');

      // 宠物 overlay（多开：容器渲染多个 PetCard）
      ctx.slots.inject('shell.overlay', function* () {
        yield ctx.slots.register({ name: 'shell.overlay', id: 'pet', order: 1000 }, () => h(PetMulti, {}));
      });

      // 设置页：「桌宠配置」（大小/位置，保存即时生效）
      const PetConfigSection = makePetConfigSection({ h, useState, useEffect, t });
      ctx.slots.inject('settings.section', function* () {
        yield ctx.slots.register(
          { name: 'settings.section', id: 'pet-config', order: 30, label: () => t('nav'), inject: () => ({ t }) },
          PetConfigSection,
        );
      });
    }

    module.exports = { apply, inject, name };
    return module.exports;
  };
}
