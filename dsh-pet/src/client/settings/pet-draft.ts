/**
 * 「添加宠物」的草稿构造：新 id 的分配与从模板拷贝哪些字段。
 * 只拷贝条目级之外的实例字段——条目级字段（人设之外的全局值）由成品配置回落，不在这里抄一份。
 * @module dsh-pet/src/client/settings/pet-draft
 */
import type { Pet } from '../../shared/types.ts';
import { SIZE_PERCENT_DEFAULT } from '../../shared/pet-size.ts';

/**
 * 生成一个未占用的宠物 id。
 *
 * 前缀按种类区分：main 沿用 `pet-N`（既有行为），文件宠物用 `<种类>-N`，编号在种类内递增。
 * 查重始终扫全量列表——合并后 id 跨条目全局唯一，各数各的必然撞。
 * 从 2 起：`-1` 通常已被该种类的首只占用（`daily1` 这类手工 id 不占号）。
 *
 * @param list - 全条目的实例列表，只读。
 * @param kind - 条目名（`main` 或 pet/<前缀>-config.json 的前缀）；缺省按 main。
 * @returns 形如 `pet-2` / `daily-2` 的空闲 id。
 */
export function nextPetId(list: readonly Pet[], kind = 'main'): string {
  const prefix = kind === 'main' ? 'pet' : kind;
  for (let n = 2; ; n += 1) {
    const id = prefix + '-' + n;
    if (!list.some((pet) => pet.id === id)) return id;
  }
}

/**
 * 按模板造一只新宠物的草稿。
 * 名字固定用新 id：模板名字是另一只宠物的身份，继承了就会两只同名，而空名字在宿主侧本来也按 id 处理。
 *
 * @param template - 模板宠物（main 条目的首只）。
 * @param id - 新宠物的 id，通常来自 {@link nextPetId}。
 * @returns 可直接进编辑列表的宠物对象；位置深拷贝，改新宠物不会动到模板。
 */
export function draftPet(template: Pet, id: string): Pet {
  return {
    id,
    name: id,
    size: template.size,
    sizePercent: template.sizePercent ?? SIZE_PERCENT_DEFAULT,
    balanceEnabled: template.balanceEnabled,
    whisperEnabled: template.whisperEnabled,
    workStatusEnabled: template.workStatusEnabled,
    fixedEnabled: template.fixedEnabled,
    display: template.display,
    position: { ...template.position },
  } as Pet;
}
