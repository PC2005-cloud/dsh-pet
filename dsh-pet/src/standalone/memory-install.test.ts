import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { runMemoryCommand } from './memory-install.ts';

test(
  'cancelling an installation stops descendants even when they ignore SIGTERM',
  { skip: process.platform === 'win32' },
  async (t) => {
    const directory = mkdtempSync(join(tmpdir(), 'pet-install-cancel-'));
    const heartbeat = join(directory, 'heartbeat');
    const pidFile = join(directory, 'pid');
    const childScript = `const fs = require('node:fs'); process.on('SIGTERM', () => {}); fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => fs.writeFileSync(${JSON.stringify(heartbeat)}, String(Date.now())), 20);`;
    const script = `require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(childScript)}], {stdio: 'ignore'}); setInterval(() => {}, 1000);`;
    t.after(() => {
      if (existsSync(pidFile)) {
        try {
          process.kill(Number(readFileSync(pidFile, 'utf8')), 'SIGKILL');
        } catch {
          /* Gone. */
        }
      }
      rmSync(directory, { recursive: true, force: true });
    });
    const controller = new AbortController();
    const job = runMemoryCommand(process.execPath, ['-e', script], process.env, controller.signal);
    const rejected = assert.rejects(job, { name: 'AbortError' });
    for (let i = 0; i < 100 && !existsSync(heartbeat); i++) await delay(20);
    assert.equal(existsSync(heartbeat), true);
    controller.abort();
    await rejected;
    await delay(50);
    const stopped = readFileSync(heartbeat, 'utf8');
    await delay(150);
    assert.equal(readFileSync(heartbeat, 'utf8'), stopped);
  },
);
