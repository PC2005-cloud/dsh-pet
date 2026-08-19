// 动作配置的类型模型（唯一事实来源为 config.jsonc 的 animations/animationWeights）。
/** 移动动作：一个动作名 + 可选覆盖参数（未写字段取 moves.default） */
export interface MoveSpec {
  name: string;
  params?: Record<string, number>;
}
/** 移动池配置 */
export interface MovesConfig {
  default: Record<string, number>;
  actions: MoveSpec[];
}
/** 随机动作分类 */
export interface Category {
  id: string;
  weight: number;
  /** 带文字、镜像会颠倒：facing=right 时跳过 */
  noMirror?: boolean;
  actions: string[];
}
/** 动画权重（百分比） */
export interface Weights {
  idle: number;
  turn: number;
  move: number;
}
/** 运行时动作配置（由 config.jsonc 构建） */
export interface AnimConfig {
  idle: string[];
  turn: string[];
  drag: string[];
  clicks: string[];
  moves: MovesConfig;
  categories: Category[];
  weights: Weights;
}
/** 支持的角落 */
export type Corner = 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';
