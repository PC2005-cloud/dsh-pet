/** 桌面飞行状态广播的合并、尾帧与生命周期。 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const require = createRequire(import.meta.url);
const { createWindows } = require('../../runtime/electron-helper/main/windows.js');
function setup(t, count = 2) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const manager = createWindows({});
  const messages = [];
  for (let i = 0; i < count; i++)
    manager.state.windows.set('p' + i, {
      isDestroyed: () => false,
      webContents: { send: (channel, state) => messages.push({ id: i, channel, state }) },
      destroy: () => {},
    });
  return { manager, messages };
}
test('密集更新即时记入站场，广播合并并采用最后一份状态', (t) => {
  const { manager, messages } = setup(t);
  for (let i = 0; i < 100; i++) manager.updatePetState('p0', { x: i, vx: i });
  assert.equal(manager.state.petStates.get('p0').x, 99);
  assert.equal(messages.length, 0);
  t.mock.timers.tick(15);
  assert.equal(messages.length, 0);
  t.mock.timers.tick(1);
  assert.equal(messages.length, 2);
  assert.equal(messages[0].state.p0.x, 99);
  assert.equal(messages[0].state.p0.vx, 99);
});
test('五只宠物同帧更新只广播一次完整站场', (t) => {
  const { manager, messages } = setup(t, 5);
  for (let i = 0; i < 5; i++) manager.updatePetState('p' + i, { x: i, size: 462 });
  t.mock.timers.tick(16);
  assert.equal(messages.length, 5);
  assert.equal(Object.keys(messages[0].state).length, 5);
});
test('单只宠物仍登记状态，省去发回自身的碰撞广播', (t) => {
  const { manager, messages } = setup(t, 1);
  manager.updatePetState('p0', { x: 30, size: 462 });
  t.mock.timers.tick(100);
  assert.equal(manager.state.petStates.get('p0').x, 30);
  assert.equal(messages.length, 0);
});
test('重复状态不再次安排广播', (t) => {
  const { manager, messages } = setup(t);
  manager.updatePetState('p0', { x: 30, size: 462 });
  t.mock.timers.tick(16);
  manager.updatePetState('p0', { x: 30, size: 462 });
  t.mock.timers.tick(16);
  assert.equal(messages.length, 2);
});
test('静止位置的尺寸或速度变化仍会广播', (t) => {
  const { manager, messages } = setup(t);
  manager.updatePetState('p0', { x: 30, vx: 400, size: 462 });
  t.mock.timers.tick(16);
  manager.updatePetState('p0', { vx: 0, size: 600 });
  t.mock.timers.tick(16);
  assert.equal(messages.length, 4);
  assert.equal(messages[2].state.p0.vx, 0);
  assert.equal(messages[2].state.p0.size, 600);
});
test('明确刷新取消旧定时器，后续不会重复发旧状态', (t) => {
  const { manager, messages } = setup(t);
  manager.updatePetState('p0', { x: 5 });
  manager.broadcastPetStates();
  t.mock.timers.tick(16);
  assert.equal(messages.length, 2);
});
test('窗口已销毁时跳过发送', (t) => {
  const { manager, messages } = setup(t);
  manager.updatePetState('p0', { x: 5 });
  manager.state.windows.get('p1').isDestroyed = () => true;
  t.mock.timers.tick(16);
  assert.equal(messages.length, 1);
});
test('关闭全部窗口清理站场及未发送的定时器', (t) => {
  const { manager, messages } = setup(t);
  manager.updatePetState('p0', { x: 5 });
  manager.closeAll();
  t.mock.timers.tick(16);
  assert.equal(manager.state.petStates.size, 0);
  assert.equal(messages.length, 0);
});
test('一秒五只宠物以60帧更新，最多广播300条且保留落地尾帧', (t) => {
  const { manager, messages } = setup(t, 5);
  for (let frame = 0; frame < 60; frame++) {
    for (let i = 0; i < 5; i++) manager.updatePetState('p' + i, { x: frame, vx: frame === 59 ? 0 : 600 });
    t.mock.timers.tick(1000 / 60);
  }
  assert.equal(messages.length, 300);
  assert.equal(messages.at(-1).state.p0.x, 59);
  assert.equal(messages.at(-1).state.p0.vx, 0);
});
test('飞行逐帧更新窗口并捎带速度', () => {
  let callback,
    now = 0;
  class Sprite {}
  const context = {
    PetSprite: Sprite,
    S: {
      throwSubsteps: () => 1,
      throwStepRegion: (s) => ({ ...s, x: s.x + 10, atRest: false, bounced: false, screen: 0 }),
    },
    performance: { now: () => now },
    requestAnimationFrame: (fn) => ((callback = fn), 1),
    cancelAnimationFrame: () => {},
    window: { petBridge: {}, __dshPetDebug: {} },
  };
  vm.runInNewContext(
    readFileSync(new URL('../../runtime/electron-helper/sprite/motion.js', import.meta.url), 'utf8'),
    context,
  );
  const sprite = new Sprite();
  const positions = [];
  Object.assign(sprite, {
    stopDragFollow: () => {},
    stopMove: () => {},
    throwToken: 0,
    throwSpaceOf: () => ({ bounds: [{ maxY: 1000 }] }),
    physics: { petCollision: false },
    sendBounds(x, y) {
      positions.push({ x, y, vx: this.throwState.vx });
    },
  });
  sprite.startThrow(0, 0, 600, 0);
  for (let i = 0; i < 3; i++) {
    now += 17;
    callback();
  }
  assert.equal(positions.length, 3);
  assert.equal(positions[2].x, 30);
  assert.equal(positions[2].vx, 600);
});
