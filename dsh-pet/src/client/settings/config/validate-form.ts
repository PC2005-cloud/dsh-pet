/**
 * 设置页表单校验：保存前把「宿主一定会 400 的组合」先就地拦下并给红字提示。
 * 规则与宿主一一对应（非法组合宿主回 400，等同于把错误推到一次网络往返之后才发现）。
 * 纯函数：只看传入的值，返回第一个不合格项的文案键，顺序即提示优先级。
 * @module dsh-pet/src/client/settings/config/validate-form
 */
import { FONT_PRESETS, FONT_SIZE_MAX, FONT_SIZE_MIN } from '../../../shared/fonts.ts';
import { isValidSizePercent } from '../../../shared/pet-size.ts';
import type { FontConfig, ModelSelection, Pet, PhysicsParams } from '../../../shared/types.ts';

/** 校验失败时返回的文案键。 */
export type InvalidKey =
  'invalid' | 'invalidPhysics' | 'invalidModel' | 'invalidChatMemory' | 'invalidChatImageLimit' | 'invalidFont';

/** 保存前要校验的全部表单值。 */
export interface FormValues {
  pets: readonly Pet[];
  physics: PhysicsParams;
  whisperModel: ModelSelection;
  chatModel: ModelSelection;
  chatMemory: number;
  chatImageLimit: number;
  font: FontConfig;
}

/** 一处「服务商 + 模型」是否合法：要么都留空（跟随当前对话），要么都非空。 */
export const modelPairValid = (model: ModelSelection): boolean =>
  (model.provider.trim() === '') === (model.model.trim() === '');

/** 宠物：宽度必须为正数、百分比缺省或是不小于 1 的数字、两个偏移必须是有限数（负数合法，宠物可以压出屏外）。 */
const petValid = (pet: Pet): boolean =>
  Number.isFinite(pet.size) &&
  pet.size > 0 &&
  (pet.sizePercent === undefined || isValidSizePercent(pet.sizePercent)) &&
  Number.isFinite(pet.position.marginX) &&
  Number.isFinite(pet.position.marginY);

/** 物理参数：与宿主 `physicsValid` 同名规则，客户端只覆盖数值字段（布尔项由宿主兜底）。 */
const physicsValid = (physics: PhysicsParams): boolean => {
  const tiltMax = physics.flightTiltMaxDeg;
  const tiltRef = physics.flightTiltRefSpeed;
  return (
    Number.isFinite(physics.gravity) &&
    physics.gravity >= 0 &&
    Number.isFinite(physics.restitution) &&
    physics.restitution >= 0 &&
    physics.restitution <= 1 &&
    Number.isFinite(physics.groundFriction) &&
    physics.groundFriction >= 0 &&
    Number.isFinite(physics.throwPower) &&
    physics.throwPower > 0 &&
    (tiltMax === undefined || (Number.isFinite(tiltMax) && tiltMax >= 0)) &&
    (tiltRef === undefined || (Number.isFinite(tiltRef) && tiltRef > 0))
  );
};

/** 字体：种类必须在预设白名单内，字号在闭区间内。 */
const fontValid = (font: FontConfig): boolean =>
  FONT_PRESETS.some((preset) => preset.id === font.family) &&
  Number.isFinite(font.size) &&
  font.size >= FONT_SIZE_MIN &&
  font.size <= FONT_SIZE_MAX;

/**
 * 校验整张表单。
 *
 * @param values - 保存前要提交的全部值。
 * @returns 第一个不合格项的文案键；全部合格返回 `null`。
 */
export function validateForm(values: FormValues): InvalidKey | null {
  if (!values.pets.every(petValid)) return 'invalid';
  if (!physicsValid(values.physics)) return 'invalidPhysics';
  // 只填一半（选了服务商没选模型，或反之）非法。
  if (!modelPairValid(values.whisperModel) || !modelPairValid(values.chatModel)) return 'invalidModel';
  if (!Number.isFinite(values.chatMemory) || values.chatMemory < 0) return 'invalidChatMemory';
  // 0 = 不限制，合法。
  if (!Number.isFinite(values.chatImageLimit) || values.chatImageLimit < 0) return 'invalidChatImageLimit';
  if (!fontValid(values.font)) return 'invalidFont';
  return null;
}
