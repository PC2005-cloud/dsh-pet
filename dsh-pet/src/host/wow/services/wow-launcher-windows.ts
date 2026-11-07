import type { InferOutput } from 'valibot';

import type { LauncherExecutable, LauncherTarget } from '../shared/wow-launcher';
import type { LauncherPlatform } from './wow-launcher-runtime';

import process from 'node:process';

import { Buffer } from 'node:buffer';
import { execFile, spawn } from 'node:child_process';
import { open, readFile, realpath, stat } from 'node:fs/promises';
import { win32 } from 'node:path';
import { promisify } from 'node:util';

import { object, parse, string } from 'valibot';

import { LauncherFailure } from './wow-launcher-runtime';

const execFileAsync = promisify(execFile);
const evidenceSchema = object({
  signature: string(),
  signer: string(),
  companyName: string(),
  originalFilename: string(),
  productName: string(),
  fileVersion: string(),
});

export type ExecutableEvidence = InferOutput<typeof evidenceSchema>;

// Product directories and executable names come from Blizzard's product configs. Sources are recorded in the launcher ADR.
const gameProducts = [
  { product: 'wow', directory: '_retail_', target: 'retail', names: ['wow.exe', 'wow-arm64.exe'], args: [] },
  { product: 'wowf', directory: '_forever_', target: 'forever', names: ['wow.exe', 'wow-arm64.exe'], args: [] },
  {
    product: 'wow_classic',
    directory: '_classic_',
    target: 'classic',
    names: ['wowclassic.exe', 'wowclassic-arm64.exe'],
    args: [],
  },
  {
    product: 'wow_classic_era',
    directory: '_classic_era_',
    target: 'classic',
    names: ['wowclassic.exe', 'wowclassic-arm64.exe'],
    args: [],
  },
  {
    product: 'wow_classic_titan',
    directory: '_classic_titan_',
    target: 'classic',
    names: ['wowclassic.exe', 'wowclassic-arm64.exe'],
    args: ['-initialgamemode=standard'],
  },
  {
    product: 'wow_anniversary',
    directory: '_anniversary_',
    target: 'classic',
    names: ['wowclassic.exe', 'wowclassic-arm64.exe'],
    args: ['-initialgamemode=bccfresh'],
  },
] as const;

const inspectionScript = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$file = Get-Item -LiteralPath $env:AIRI_WOW_LAUNCHER_PATH
$signature = Get-AuthenticodeSignature -LiteralPath $file.FullName
$signer = ''
if ($null -ne $signature.SignerCertificate) {
  $signer = $signature.SignerCertificate.GetNameInfo([Security.Cryptography.X509Certificates.X509NameType]::SimpleName, $false)
}
@{
  signature = [string]$signature.Status
  signer = $signer
  companyName = [string]$file.VersionInfo.CompanyName
  originalFilename = [string]$file.VersionInfo.OriginalFilename
  productName = [string]$file.VersionInfo.ProductName
  fileVersion = [string]$file.VersionInfo.FileVersion
} | ConvertTo-Json -Compress
`;

function versionNumber(value: string) {
  return value.match(/\b\d+\.\d+\.\d+\.\d+\b/)?.[0];
}

/**
 * Cross-checks OS signature evidence against the selected target and installation metadata.
 * Installation files identify the product. They are not a signed inventory of the entire installation.
 */
export function validateLauncherEvidence(
  target: LauncherTarget,
  path: string,
  evidence: ExecutableEvidence,
  installation?: { flavor: string; buildInfo: string },
): LauncherExecutable {
  if (evidence.signature !== 'Valid' || !/^Blizzard Entertainment,? Inc\.?$/i.test(evidence.signer.trim()))
    throw new LauncherFailure('invalid-signature');
  if (!/^Blizzard Entertainment(?:,? Inc\.?)?$/i.test(evidence.companyName.trim()))
    throw new LauncherFailure('wrong-product');
  const name = win32.basename(path).toLowerCase();
  const original = evidence.originalFilename.trim().toLowerCase();
  if (name !== original) throw new LauncherFailure('wrong-product');
  const productName = evidence.productName.trim().toLowerCase();
  const launchers: Record<string, string> = {
    'battle.net.exe': 'battle.net',
    'battle.net launcher.exe': 'battle.net launcher',
    'world of warcraft launcher.exe': 'world of warcraft launcher',
  };
  if (launchers[name]) {
    if (target !== 'battle-net') throw new LauncherFailure('wrong-version');
    if (productName !== launchers[name]) throw new LauncherFailure('wrong-product');
    return { target, path, productName: evidence.productName, fileVersion: evidence.fileVersion };
  }
  if (productName !== 'world of warcraft') throw new LauncherFailure('wrong-product');
  if (target === 'battle-net') throw new LauncherFailure('wrong-version');
  if (!installation) throw new LauncherFailure('unrecognized-version');
  const flavorLines = installation.flavor
    .replace(/^\uFEFF/, '')
    .trim()
    .split(/\r?\n/)
    .map((line) => line.trim());
  const product = flavorLines[0] === 'Product Flavor!STRING:0' ? flavorLines[1]?.toLowerCase() : undefined;
  const descriptor = gameProducts.find((entry) => entry.product === product);
  if (!descriptor) throw new LauncherFailure('unrecognized-version');
  if (descriptor.target !== target) throw new LauncherFailure('wrong-version');
  if (
    win32.basename(win32.dirname(path)).toLowerCase() !== descriptor.directory ||
    !(descriptor.names as readonly string[]).includes(name)
  )
    throw new LauncherFailure('wrong-version');
  const fileVersion = versionNumber(evidence.fileVersion);
  if (!fileVersion) throw new LauncherFailure('unrecognized-version');
  const [major, minor] = fileVersion.split('.').map(Number);
  // The signed file version distinguishes Forever's 1.60 branch from a Retail binary copied into a renamed directory.
  if (
    (target === 'forever' && major !== 1) ||
    (target === 'retail' && major! < 8) ||
    (target === 'classic' && major === 1 && minor! >= 60)
  ) {
    throw new LauncherFailure('wrong-version');
  }
  if (target === 'forever' && minor !== 60) throw new LauncherFailure('unrecognized-version');
  const buildLines = installation.buildInfo
    .replace(/^\uFEFF/, '')
    .trim()
    .split(/\r?\n/);
  const columns = buildLines[0]?.split('|').map((column) => column.split('!')[0]) ?? [];
  const productIndex = columns.indexOf('Product');
  const activeIndex = columns.indexOf('Active');
  const versionIndex = columns.indexOf('Version');
  const matchesBuild =
    productIndex >= 0 &&
    activeIndex >= 0 &&
    versionIndex >= 0 &&
    buildLines.slice(1).some((line) => {
      const row = line.split('|');
      return (
        row[productIndex]?.trim().toLowerCase() === product &&
        row[activeIndex]?.trim() === '1' &&
        versionNumber(row[versionIndex] ?? '') === fileVersion
      );
    });
  if (!matchesBuild) throw new LauncherFailure('unrecognized-version');
  return { target, path, productName: evidence.productName, fileVersion: evidence.fileVersion };
}

async function readInstallationFile(path: string) {
  const info = await stat(path);
  if (!info.isFile() || info.size > 1024 * 1024) throw new LauncherFailure('unrecognized-version');
  return readFile(path, 'utf8');
}

function validateLocalPath(path: string) {
  // Shell commands, URLs, arguments, shortcuts, UNC paths, and alternate data streams are not local programs.
  // eslint-disable-next-line no-control-regex -- Selected Windows paths cannot contain control characters.
  if (!/^[a-z]:[\\/]/i.test(path) || /[\u0000-\u001F"<>|*?]/.test(path) || path.slice(2).includes(':'))
    throw new LauncherFailure('invalid-path');
  if (win32.extname(path).toLowerCase() !== '.exe') throw new LauncherFailure('not-executable');
}

/** Windows performs signature verification in a hidden, fixed PowerShell script. The selected executable is never run during inspection. */
export class WindowsLauncherPlatform implements LauncherPlatform {
  readonly supported = process.platform === 'win32';

  async inspect(target: LauncherTarget, input: string): Promise<LauncherExecutable> {
    if (!this.supported) throw new LauncherFailure('unsupported-platform');
    validateLocalPath(input);
    let path: string;
    try {
      path = await realpath(input);
      validateLocalPath(path);
      if (!(await stat(path)).isFile()) throw new LauncherFailure('not-executable');
    } catch (error) {
      if (error instanceof LauncherFailure) throw error;
      throw new LauncherFailure('file-not-found');
    }
    const before = await stat(path);
    const file = await open(path, 'r');
    try {
      const dos = Buffer.alloc(64);
      const header = await file.read(dos, 0, 64, 0);
      if (header.bytesRead !== 64 || dos.toString('ascii', 0, 2) !== 'MZ') throw new LauncherFailure('not-executable');
      const offset = dos.readUInt32LE(60);
      const pe = Buffer.alloc(4);
      if (
        offset < 64 ||
        offset > 16 * 1024 * 1024 ||
        (await file.read(pe, 0, 4, offset)).bytesRead !== 4 ||
        pe.toString('binary') !== 'PE\0\0'
      )
        throw new LauncherFailure('not-executable');
    } finally {
      await file.close();
    }
    let evidence: ExecutableEvidence;
    try {
      const systemRoot = Object.entries(process.env).find(([name]) => name.toLowerCase() === 'systemroot')?.[1];
      if (!systemRoot) throw new LauncherFailure('inspection-failed');
      const powershell = win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
      // Windows environment names ignore case, but JavaScript objects can retain duplicate names from a worker or parent shell.
      const environment = Object.fromEntries(
        Object.entries(process.env).filter(
          ([name]) => !['psmodulepath', 'airi_wow_launcher_path'].includes(name.toLowerCase()),
        ),
      );
      const result = await execFileAsync(
        powershell,
        ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', inspectionScript],
        {
          // Use this executable's system modules. PowerShell 7 modules cannot supply Windows PowerShell 5.1 security cmdlets.
          env: {
            ...environment,
            PSMODULEPATH: win32.join(win32.dirname(powershell), 'Modules'),
            AIRI_WOW_LAUNCHER_PATH: path,
          },
          windowsHide: true,
          timeout: 20000,
          maxBuffer: 64 * 1024,
          encoding: 'utf8',
        },
      );
      evidence = parse(evidenceSchema, JSON.parse(result.stdout.trim()));
    } catch {
      throw new LauncherFailure('inspection-failed');
    }
    let installation: { flavor: string; buildInfo: string } | undefined;
    if (target !== 'battle-net') {
      try {
        const directory = win32.dirname(path);
        const [flavor, buildInfo] = await Promise.all([
          readInstallationFile(win32.join(directory, '.flavor.info')),
          readInstallationFile(win32.join(win32.dirname(directory), '.build.info')),
        ]);
        installation = { flavor, buildInfo };
      } catch {
        // Signature and product identity still get checked before a missing installation can be reported.
      }
    }
    const executable = validateLauncherEvidence(target, path, evidence, installation);
    const after = await stat(path);
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs
    )
      throw new LauncherFailure('inspection-failed');
    return executable;
  }

  async launch(executable: LauncherExecutable) {
    const descriptor = gameProducts.find(
      (entry) =>
        entry.target === executable.target &&
        entry.directory === win32.basename(win32.dirname(executable.path)).toLowerCase(),
    );
    const args = descriptor ? [...descriptor.args] : [];
    await new Promise<void>((resolve, reject) => {
      const child = spawn(executable.path, args, {
        cwd: win32.dirname(executable.path),
        shell: false,
        detached: true,
        stdio: 'ignore',
        windowsHide: false,
      });
      child.once('error', reject);
      child.once('spawn', () => {
        child.unref();
        resolve();
      });
    });
  }
}
