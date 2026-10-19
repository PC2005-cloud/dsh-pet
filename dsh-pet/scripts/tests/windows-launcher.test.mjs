import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync, rmSync, existsSync, realpathSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync, spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../windows/', import.meta.url));
const ps = process.env.SystemRoot
  ? join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe')
  : 'powershell.exe';
const onWindows = process.platform === 'win32';
function run(code) {
  const result = spawnSync(
    ps,
    ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(code, 'utf16le').toString('base64')],
    { encoding: 'utf8', timeout: 20000 },
  );
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  return result.stdout.trim();
}
const literal = (value) => `'${value.replaceAll("'", "''")}'`;
const common = `. ${literal(join(root, 'common.ps1'))}; `;
const files = [
  'common',
  'task-common',
  'git-common',
  'launch',
  'install',
  'disable-autostart',
  'stop',
  'open-settings',
  'register',
  'remove-weekly-sync',
  'sync-upstream',
];
test('all Windows helpers exist and parse under Windows PowerShell 5.1', { skip: !onWindows }, () => {
  for (const name of files) {
    assert.ok(existsSync(join(root, `${name}.ps1`)), name);
    run(
      `$tokens=$null; $errors=$null; [void][System.Management.Automation.Language.Parser]::ParseFile(${literal(join(root, `${name}.ps1`))},[ref]$tokens,[ref]$errors); if($errors.Count){throw ($errors | Out-String)}`,
    );
  }
});
test('Windows argument quoting round trips through native node', { skip: !onWindows }, () => {
  const args = ['space here', 'a"b', 'C:\\space here\\', '', 'plain', '&$(no);'];
  const output = run(
    common +
      `$a=@(${args.map(literal).join(',')}); $q=(@('-e','console.log(JSON.stringify(process.argv.slice(1)))')+$a | ForEach-Object { ConvertTo-NativeArgument $_ }) -join ' '; $p=New-Object Diagnostics.Process; $p.StartInfo.FileName=${literal(process.execPath)}; $p.StartInfo.Arguments=$q; $p.StartInfo.UseShellExecute=$false; $p.StartInfo.RedirectStandardOutput=$true; [void]$p.Start(); $s=$p.StandardOutput.ReadToEnd(); $p.WaitForExit(); $s`,
  );
  assert.deepEqual(JSON.parse(output), args);
});
test('dry runs validate config, preserve paths, never create OS registrations', { skip: !onWindows }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'pet windows '));
  try {
    const config = {
      nodePath: process.execPath,
      entryPath: join(dir, 'entry with spaces.mjs'),
      workingDirectory: dir,
      dataHome: join(dir, 'data'),
      sourceRoot: dir,
      pluginRoot: dir,
      port: 31380,
      gitPath: 'C:\\Program Files\\Git\\cmd\\git.exe',
    };
    writeFileSync(config.entryPath, '');
    const path = join(dir, 'deployment.json');
    writeFileSync(path, JSON.stringify(config));
    for (const script of [
      'install',
      'disable-autostart',
      'register',
      'remove-weekly-sync',
      'sync-upstream',
      'launch',
    ]) {
      const value = JSON.parse(run(`& ${literal(join(root, `${script}.ps1`))} -ConfigPath ${literal(path)} -WhatIf`));
      assert.ok(value.action, script);
      assert.equal(realpathSync.native(value.configPath), realpathSync.native(resolve(path)));
      if (script === 'register') {
        assert.equal(value.day, 'Monday');
        assert.equal(value.time, '09:17');
        assert.equal(value.startWhenAvailable, true);
        assert.equal(value.runLevel, 'Limited');
      }
    }
    assert.equal(existsSync(config.dataHome), false, 'dry run must not create data directories');
    writeFileSync(path, JSON.stringify({ ...config, port: '31380;bad' }));
    assert.match(
      run(
        `try { Read-Deployment ${literal(path)}; throw 'accepted invalid config' } catch { $_.Exception.Message }`.replace(
          'try {',
          common + 'try {',
        ),
      ),
      /port/i,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test('source synchronization cannot merge, build, execute downloaded scripts or kill hosts', () => {
  const sync = readFileSync(join(root, 'sync-upstream.ps1'), 'utf8');
  assert.match(sync, /fetch/);
  assert.match(sync, /--no-tags/);
  assert.match(readFileSync(join(root, 'git-common.ps1'), 'utf8'), /core\.hooksPath/);
  assert.doesNotMatch(sync, /\b(?:checkout|read-tree|reset|clean|merge|pull|npm|pnpm|node)\b/i);
  assert.match(sync, /oldSha/);
  assert.match(sync, /newSha/);
  assert.match(sync, /checkedAt/);
  const launch = readFileSync(join(root, 'launch.ps1'), 'utf8');
  assert.match(launch, /WaitForExit/);
  assert.match(launch, /ReleaseMutex/);
  assert.match(launch, /DSH_HOME/);
  assert.match(launch, /WindowStyle Hidden/);
  for (const name of files)
    assert.doesNotMatch(
      readFileSync(join(root, `${name}.ps1`), 'utf8'),
      /Stop-Process\s+-Name|taskkill|ExecutionPolicy\s+Bypass|RunLevel\s+Highest/i,
    );
});

test('runtime identity validation rejects stale PID and foreign roots', { skip: !onWindows }, () => {
  const output = run(
    common +
      String.raw`$c=[pscustomobject]@{pluginRoot='C:\safe root';port=31380}; $h=[pscustomobject]@{name='dsh-pet-standalone';pid=42;pluginRoot='C:\safe root'}; Assert-HostIdentity $c $h ([pscustomobject]@{pid=42}); foreach($bad in @([pscustomobject]@{name='foreign';pid=42;pluginRoot='C:\safe root'},[pscustomobject]@{name='dsh-pet-standalone';pid=43;pluginRoot='C:\safe root'},[pscustomobject]@{name='dsh-pet-standalone';pid=42;pluginRoot='C:\other'})){try{Assert-HostIdentity $c $bad ([pscustomobject]@{pid=42});throw 'unsafe acceptance'}catch{if($_.Exception.Message -eq 'unsafe acceptance'){throw}; 'rejected'}}`,
  );
  assert.equal(output.split(/\r?\n/).filter((x) => x === 'rejected').length, 3);
});

test(
  'graceful shutdown authenticates only a verified loopback host and settings never print token',
  { skip: !onWindows },
  async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'pet runtime ')));
    const token = 'a'.repeat(48);
    let healthPid = 9876;
    let shutdowns = 0;
    const server = createServer((req, res) => {
      if (req.url === '/health') {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ name: 'dsh-pet-standalone', pid: healthPid, pluginRoot: dir }));
        return;
      }
      if (req.url === '/shutdown' && req.method === 'POST' && req.headers['x-dsh-pet-token'] === token) {
        shutdowns++;
        res.end('{}');
        return;
      }
      res.writeHead(403).end();
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const port = server.address().port;
    const configPath = join(dir, 'deployment.json');
    const invoke = async (script, prefix = '') => {
      const code = `${prefix}; & ${literal(join(root, `${script}.ps1`))} -ConfigPath ${literal(configPath)}`;
      const child = spawn(
        ps,
        ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(code, 'utf16le').toString('base64')],
        { timeout: 15000 },
      );
      let stdout = '',
        stderr = '';
      child.stdout.on('data', (x) => (stdout += x));
      child.stderr.on('data', (x) => (stderr += x));
      const [status] = await once(child, 'close');
      return { status, stdout, stderr };
    };
    try {
      const config = {
        nodePath: process.execPath,
        entryPath: join(dir, 'entry.mjs'),
        workingDirectory: dir,
        dataHome: dir,
        sourceRoot: dir,
        pluginRoot: dir,
        port,
      };
      writeFileSync(config.entryPath, '');
      writeFileSync(configPath, JSON.stringify(config));
      mkdirSync(join(dir, 'dsh-pet'));
      writeFileSync(
        join(dir, 'dsh-pet', 'standalone-runtime.json'),
        JSON.stringify({
          name: 'dsh-pet-standalone',
          pid: 9876,
          port,
          token,
          pluginRoot: dir,
          settingsUrl: 'https://evil.invalid',
        }),
      );
      const stopped = await invoke('stop');
      assert.equal(stopped.status, 0, stopped.stderr);
      assert.equal(shutdowns, 1);
      assert.ok(!stopped.stdout.includes(token));
      assert.ok(!stopped.stderr.includes(token));
      const opened = await invoke(
        'open-settings',
        `function Start-Process { param([string]$FilePath) if($FilePath -cne 'http://127.0.0.1:${port}/standalone-ai/#token=${token}'){throw 'unsafe URL'} }`,
      );
      assert.equal(opened.status, 0, opened.stderr);
      assert.ok(!opened.stdout.includes(token));
      healthPid = 9877;
      const stale = await invoke('stop');
      assert.notEqual(stale.status, 0);
      assert.equal(shutdowns, 1);
      assert.ok(!stale.stderr.includes(token));
    } finally {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

test('task ownership and weekly safety validation run without registering OS items', { skip: !onWindows }, () => {
  const taskCommon = literal(join(root, 'task-common.ps1'));
  const output = run(
    common +
      `. ${taskCommon}; $i=[pscustomobject]@{taskName='test';owner='owner';sid='S-1-5-21-test'}; $c=[pscustomobject]@{executable='C:\ps.exe';arguments='trusted'}; $global:fixture=[pscustomobject]@{TaskName='test';Description='owner';Actions=@([pscustomobject]@{Execute='C:\ps.exe';Arguments='trusted'});Principal=[pscustomobject]@{UserId=$i.sid;RunLevel='Limited';LogonType='Interactive'};Triggers=@([pscustomobject]@{CimClass=[pscustomobject]@{CimClassName='MSFT_TaskWeeklyTrigger'};DaysOfWeek=2;WeeksInterval=1;StartBoundary='2026-10-19T09:17:00';Enabled=$true});Settings=[pscustomobject]@{StartWhenAvailable=$true;MultipleInstances='IgnoreNew';ExecutionTimeLimit='PT10M'}}; function Get-ScheduledTask { param($TaskPath) $global:fixture }; $t=Find-OwnedSyncTask $i $c; Assert-SyncSchedule $t; 'accepted'; try { Find-OwnedSyncTask ([pscustomobject]@{taskName='test';owner='foreign';sid=$i.sid}) $c; throw 'unsafe acceptance' } catch { if($_.Exception.Message -eq 'unsafe acceptance'){throw}; 'rejected' }`,
  );
  assert.match(output, /accepted/);
  assert.match(output, /rejected/);
});

test(
  'supervisor holds mutex for child lifetime and preserves process-local data home',
  { skip: !onWindows },
  async () => {
    const dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'pet supervisor ')));
    const probe = createServer();
    probe.listen(0, '127.0.0.1');
    await once(probe, 'listening');
    const port = probe.address().port;
    await new Promise((resolve) => probe.close(resolve));
    const configPath = join(dir, 'deployment.json');
    const entryPath = join(dir, 'fixture host.mjs');
    const token = 'b'.repeat(48);
    writeFileSync(
      entryPath,
      `import {createServer} from 'node:http'; import {writeFileSync,mkdirSync} from 'node:fs'; import {join} from 'node:path'; const home=process.env.DSH_HOME; console.log('fixture-data-home='+home); mkdirSync(join(home,'dsh-pet'),{recursive:true}); writeFileSync(join(home,'dsh-pet','standalone-runtime.json'),JSON.stringify({name:'dsh-pet-standalone',pid:process.pid,pluginRoot:${JSON.stringify(dir)},port:${port},token:${JSON.stringify(token)}})); const s=createServer((q,r)=>{if(q.url==='/health'){r.setHeader('Content-Type','application/json');r.end(JSON.stringify({name:'dsh-pet-standalone',pid:process.pid,pluginRoot:${JSON.stringify(dir)}}));}else if(q.url==='/shutdown'&&q.headers['x-dsh-pet-token']===${JSON.stringify(token)}){r.end('{}');s.close(()=>process.exit(0));}else{r.writeHead(403).end();}});s.listen(${port},'127.0.0.1');`,
    );
    const dataHome = join(dir, 'isolated data');
    writeFileSync(
      configPath,
      JSON.stringify({
        nodePath: process.execPath,
        entryPath,
        workingDirectory: dir,
        dataHome,
        sourceRoot: dir,
        pluginRoot: dir,
        port,
      }),
    );
    const execute = (script) => {
      const child = spawn(
        ps,
        ['-NoProfile', '-NonInteractive', '-File', join(root, `${script}.ps1`), '-ConfigPath', configPath],
        { windowsHide: true, timeout: 25000 },
      );
      let stderr = '';
      child.stderr.on('data', (data) => (stderr += data));
      child.stdout.resume();
      return { child, done: once(child, 'close').then(([status]) => ({ status, stderr })) };
    };
    const supervisor = execute('launch');
    try {
      let ready = false;
      for (let i = 0; i < 80; i++) {
        try {
          const response = await fetch(`http://127.0.0.1:${port}/health`);
          ready = response.ok;
        } catch {
          /* fixture has not bound yet */
        }
        if (ready) break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      assert.ok(ready, 'synthetic fixture should start');
      assert.equal(supervisor.child.exitCode, null, 'supervisor must remain alive');
      const duplicate = await execute('launch').done;
      assert.equal(duplicate.status, 0, duplicate.stderr);
      assert.equal(supervisor.child.exitCode, null, 'duplicate must not release first supervisor');
      const stopped = await execute('stop').done;
      assert.equal(stopped.status, 0, stopped.stderr);
      const result = await supervisor.done;
      assert.equal(result.status, 0, result.stderr);
      const output = readFileSync(join(dataHome, 'launcher-logs', 'host.stdout.log'), 'utf8');
      assert.ok(output.includes(`fixture-data-home=${dataHome}`));
      assert.ok(
        readFileSync(join(dataHome, 'launcher-logs', 'launcher.log'), 'utf8').includes('Supervisor already active'),
      );
    } finally {
      try {
        await fetch(`http://127.0.0.1:${port}/shutdown`, { method: 'POST', headers: { 'X-DSH-Pet-Token': token } });
      } catch {
        /* fixture already exited */
      }
      if (supervisor.child.exitCode === null) supervisor.child.kill();
      await supervisor.done;
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
