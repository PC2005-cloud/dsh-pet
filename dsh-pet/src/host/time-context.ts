/**
 * 时间背景的公开出口：时段、星期与节日的组合结果，以及历史消息的时间前缀。
 *
 * 只做再导出；常量在 ./time-context/constants，节日表在 ./time-context/entries。
 * 必须始终成立：不读时钟（Date 由调用方传入），非法 Date 返回空串。
 * @module dsh-pet/src/host/time-context
 */
export { dayKindOf, timeSlotOf } from './time-context/constants.ts';
export type { TimeSlot } from './time-context/constants.ts';
export { historyStampOf, timeContextOf } from './time-context/context.ts';
