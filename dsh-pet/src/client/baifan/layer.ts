/**
 * 「吃白饭」覆盖层的插槽载体：把命令式覆盖层挂进 DSH 的 shell.overlay。
 *
 * 覆盖层必须住在 AppFrame 的 [data-shell-overlay] 里，不能自己往 body 上挂：
 * body 直接子级会命中宿主给 macOS 写的 no-drag 规则，把标题栏拖成死区；
 * 而 shell.overlay 是官方指定的全应用浮层座位，自带 z-index:20 的层叠上下文，
 * 覆盖层因此只压在桌宠之上，不会越级盖住宿主模态框。
 * @module dsh-pet/src/client/baifan/layer
 */
import type * as ReactNS from 'react';
import type { jsx } from 'react/jsx-runtime';

/** 注入的 react 能力：只取这个组件用到的三个。 */
export interface LayerRuntime {
  /** 创建元素。 */
  h: typeof jsx;
  /** 引用：容器节点要跨渲染存活，卸载时据此清场。 */
  useRef: <T>(initial: T) => ReactNS.MutableRefObject<T>;
  /** 副作用：挂载与清理成对出现。 */
  useEffect: (effect: ReactNS.EffectCallback, deps?: ReactNS.DependencyList) => void;
}

/**
 * 造插槽组件。
 *
 * @param rt - 注入的 react 能力。
 * @param mount - 把覆盖层挂到给定容器上，返回卸载钩子。
 * @returns 可注册进 `shell.overlay` 的组件。
 */
export function makeBaifanLayer(rt: LayerRuntime, mount: (host: HTMLDivElement) => () => void) {
  return function BaifanLayer(): ReactNS.ReactNode {
    const ref = rt.useRef<HTMLDivElement | null>(null);
    rt.useEffect(() => {
      const host = ref.current;
      if (host === null) return undefined;
      return mount(host);
      // 空依赖是有意的：容器只在挂载时出现一次，覆盖层自己管内部状态，
      // 不跟着父组件重渲染重挂——重挂会重建米饭与分数的整条状态。
    }, []);
    return rt.h('div', { ref });
  };
}
