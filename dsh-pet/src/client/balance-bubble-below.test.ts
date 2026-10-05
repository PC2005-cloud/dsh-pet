/**
 * 「余额气泡在角色下方 + 左键点身体顺带触发余额」的契约测试。
 *
 * 为什么值得单独测：这两件事都**不会报错**，只会无声退化——
 *   - 气泡位置写错：气泡跑到角色外面（或被窗口裁掉），看起来像"没弹"；
 *   - 点击触发写错：点身体没反应，或反过来**把原有点击交互（积分弹窗 + 点击动画）改坏**。
 * 所以每条前提都钉住，并特别断言"原有点击交互一字未改"。
 *
 * 覆盖：浏览器半侧（src/client/bubble.ts + pet.ts）与桌面半侧（runtime/electron-helper/
 * index.html + sprite.js）**两端同一套语义**（项目契约：两端行为一致），外加共享常量。
 *
 * 跑法：node --experimental-strip-types --test src/client/balance-bubble-below.test.ts
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { BODY_CLICK_BALANCE_THROTTLE_MS } from '../shared/constants';

const bubbleSrc = readFileSync(new URL('./bubble.ts', import.meta.url), 'utf8');
const petSrc = readFileSync(new URL('./pet.ts', import.meta.url), 'utf8');
const htmlSrc = readFileSync(new URL('../../runtime/electron-helper/index.html', import.meta.url), 'utf8');
const spriteSrc = readFileSync(new URL('../../runtime/electron-helper/sprite.js', import.meta.url), 'utf8');

describe('余额气泡位置 —— 只有余额气泡到角色下方（碎碎念/工作气泡仍在上方）', () => {
  test('浏览器端：余额气泡带 is-below，碎碎念气泡不带', () => {
    assert.ok(
      /className: 'dsh-pet-bubble is-below'/.test(bubbleSrc),
      '余额气泡的 className 必须带 is-below（否则跑回角色上方）',
    );
    assert.ok(
      /className: 'dsh-pet-bubble dsh-pet-whisper'/.test(bubbleSrc),
      '碎碎念气泡不得带 is-below（它与余额共用一套样式，位置由这个类区分）',
    );
  });

  test('浏览器端 CSS：bottom→top 镜像 + 尖角翻成朝上', () => {
    assert.ok(
      /\.dsh-pet-bubble\.is-below\{bottom:auto;top:calc\(100% - var\(--dsh-pet-size\)\*0\.108\)\}/.test(bubbleSrc),
      'is-below 必须把定位镜像到角色下方（bottom:auto + top:100%-0.108×尺寸）',
    );
    assert.ok(
      /\.dsh-pet-bubble\.is-below::after\{[^}]*border-top:none[^}]*border-bottom-color:rgba\(255,255,255,\.92\)/.test(
        bubbleSrc,
      ),
      '尖角必须由朝下改为朝上（border-top:none + border-bottom-color）',
    );
  });

  test('桌面端 CSS：同一条镜像规则（与浏览器逐项对应）', () => {
    const block = /\.pet-bubble\.is-below \{[\s\S]{0,120}?\.pet-bubble\.is-below::after \{[\s\S]{0,260}?\}/.exec(
      htmlSrc,
    )?.[0];
    assert.ok(block !== undefined, 'index.html 里找不到 .pet-bubble.is-below 规则');
    assert.ok(/bottom: auto;/.test(block), '必须 bottom:auto（覆盖基准规则的 bottom）');
    assert.ok(
      /top: calc\(100% - var\(--pet-size, 462px\) \* 0\.108\);/.test(block),
      '必须镜像到 top: 100% − 0.108×尺寸',
    );
    assert.ok(/border-top: none;/.test(block), '尖角必须去掉朝下的边');
    assert.ok(/border-bottom-color: rgba\(255, 255, 255, 0\.92\);/.test(block), '尖角必须改为朝上着色');
  });

  test('桌面端只给余额槽位加这个类（工作/碎碎念槽位不加）', () => {
    assert.ok(
      /this\.bubble\.classList\.toggle\('is-below', slot === 'balance'\)/.test(spriteSrc),
      'is-below 只能按槽位判定（slot === "balance"），不得常驻',
    );
  });
});

describe('左键点身体 —— 额外触发余额，且原有点击交互一字未改', () => {
  test('两端都只在 bodyEnabled 的宠物上触发（与余额动画/气泡同一档门控）', () => {
    assert.ok(
      /const triggerBalanceFromBodyClick = \(\) => \{\n\s+if \(!cfg\.balanceEnabled\) return;/.test(petSrc),
      '浏览器端：触发函数必须先判 balanceEnabled',
    );
    assert.ok(
      /triggerBalanceFromBodyClick\(\) \{\n\s+if \(!this\.pet\.balanceEnabled\) return;/.test(spriteSrc),
      '桌面端：触发函数必须先判 balanceEnabled',
    );
  });

  test('浏览器端走的是与 /balance 命令同一条路径：POST 动作 + 立刻叫醒一拍 /state', () => {
    const block = /const triggerBalanceFromBodyClick = \(\) => \{[\s\S]{0,700}?\n {4}\};/.exec(petSrc)?.[0] ?? '';
    assert.ok(block.length > 0, 'pet.ts 里找不到 triggerBalanceFromBodyClick');
    assert.ok(/postAction\('\/dsh-pet-7340\/balance'\)/.test(block), '必须 POST 余额动作端点（触发方式不变）');
    assert.ok(/statePoller\.now\(\)/.test(block), '必须立刻叫醒一拍 /state，气泡才会 0 延迟出现');
  });

  test('桌面端同样复用菜单那条路径（showBalanceFromMenu → triggerBalanceNow）', () => {
    assert.ok(
      /showBalanceFromMenu\(\) \{\n\s+this\.triggerBalanceNow\(\);\n\s+\}/.test(spriteSrc),
      '菜单必须仍走 triggerBalanceNow（触发方式不变）',
    );
    assert.ok(
      /triggerBalanceNow\(\) \{[\s\S]{0,400}?S\.postAction\(BALANCE_URL\)[\s\S]{0,300}?pollStateNow\(\);/.test(
        spriteSrc,
      ),
      'triggerBalanceNow 必须 POST 余额动作端点并立刻拉一拍 /state',
    );
    assert.ok(
      /onClick\(\) \{[\s\S]{0,600}?this\.triggerBalanceFromBodyClick\(\);/.test(spriteSrc),
      '左键点身体必须调用 triggerBalanceFromBodyClick',
    );
  });

  test('原有点击交互保持不变（积分分支 + 点击动画仍在，且触发在其之前）', () => {
    // 桌面端：onClick 里的原逻辑（pressScoreFired 分支 / 播点击动画）必须还在
    assert.ok(/if \(this\.pressScoreFired\) \{/.test(spriteSrc), '桌面端积分分支被删了');
    assert.ok(/this\.playOnce\(S\.pick\(this\.animations\.clicks\)\)/.test(spriteSrc), '桌面端点击动画被删了');
    // 浏览器端：handleClick 里的原逻辑必须还在
    assert.ok(/if \(pressScoreFiredRef\.current\) \{/.test(petSrc), '浏览器端积分分支被删了');
    assert.ok(/setAnim\(name\)/.test(petSrc), '浏览器端点击动画被删了');
    // 触发位置：必须在拖拽守卫之后、积分分支之前（拖拽结束不算点击；正常点击也要触发）
    const order =
      /if \(d\.active \|\| d\.dragging \|\| justDraggedRef\.current\) return;\s*triggerBalanceFromBodyClick\(\);\s*\/\/[\s\S]{0,120}?if \(pressScoreFiredRef\.current\) \{/.test(
        petSrc,
      );
    assert.ok(order, '触发必须在"拖拽守卫之后、积分分支之前"（拖拽不触发；正常点击照常触发）');
  });

  test('节流：两端共用 shared 常量，且常量是正数', () => {
    assert.ok(
      /now - lastBodyClickBalanceRef\.current < BODY_CLICK_BALANCE_THROTTLE_MS/.test(petSrc),
      '浏览器端必须用共享常量节流',
    );
    assert.ok(
      /now - this\.lastBodyClickBalanceAt < S\.BODY_CLICK_BALANCE_THROTTLE_MS/.test(spriteSrc),
      '桌面端必须用共享常量节流（shared-core 里的同一个值）',
    );
    assert.ok(
      Number.isFinite(BODY_CLICK_BALANCE_THROTTLE_MS) && BODY_CLICK_BALANCE_THROTTLE_MS > 0,
      'BODY_CLICK_BALANCE_THROTTLE_MS 必须是正数',
    );
  });
});
