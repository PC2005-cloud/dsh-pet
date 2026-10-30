/**
 * 设置页组件的运行时依赖：react 能力与翻译函数，由宿主在 `__ModuleLoader__` 装配时注入。
 * 浏览器半侧是单文件 bundle 形态，react 只能由宿主提供，因此组件一律经工厂接收、不直接 import。
 * 依赖只有 `h`、四个 hook 与 `t`；组件里不得再取第二个翻译源，也不得读全局 `window` 上的 react。
 * @module dsh-pet/src/client/settings/runtime
 */
import type { Dispatch, SetStateAction } from 'react';
import type * as ReactNS from 'react';
import type { jsx } from 'react/jsx-runtime';

/** 设置页的运行时依赖；各子组件按需只取自己用到的几个。 */
export interface SettingsRuntime {
  h: typeof jsx;
  useState: <T>(init: T) => [T, Dispatch<SetStateAction<T>>];
  // 用 React 命名空间类型而非 typeof：type-only import 的 hook 无法进入声明导出（TS4078）
  useEffect: (effect: ReactNS.EffectCallback, deps?: ReactNS.DependencyList) => void;
  useRef: <T>(initial: T) => ReactNS.MutableRefObject<T>;
  useCallback: typeof ReactNS.useCallback;
  /** 文案翻译；键取自本页字典的 `zh`。 */
  t: (key: string) => string;
}
