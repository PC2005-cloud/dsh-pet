import { execFileSync } from 'node:child_process';
import type { SecretStorage } from './services/wow-addons-settings.ts';

// Fixed script; the secret travels over stdin, never in a command line, log, or response.
const SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security
$mode = [Console]::In.ReadLine()
$inputBytes = [Convert]::FromBase64String([Console]::In.ReadToEnd())
$scope = [Security.Cryptography.DataProtectionScope]::CurrentUser
if ($mode -eq 'encrypt') {
  $outputBytes = [Security.Cryptography.ProtectedData]::Protect($inputBytes, $null, $scope)
} elseif ($mode -eq 'decrypt') {
  $outputBytes = [Security.Cryptography.ProtectedData]::Unprotect($inputBytes, $null, $scope)
} else { exit 1 }
[Console]::Out.Write([Convert]::ToBase64String($outputBytes))
`;

/** Windows account protection also works in the CLI/DSH host, where Electron safeStorage is unavailable. */
export function createWowSecretStorage(): SecretStorage {
  function transform(mode: 'encrypt' | 'decrypt', bytes: Buffer): Buffer {
    if (process.platform !== 'win32') throw new Error('wow-addons-key-storage-unavailable');
    try {
      const output = execFileSync(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(SCRIPT, 'utf16le').toString('base64')],
        {
          input: `${mode}\n${bytes.toString('base64')}`,
          windowsHide: true,
          timeout: 10_000,
          maxBuffer: 128 * 1024,
          stdio: ['pipe', 'pipe', 'pipe'],
        },
      );
      const encoded = output.toString('utf8').trim();
      if (!encoded || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) throw new Error('invalid-secret-output');
      return Buffer.from(encoded, 'base64');
    } catch {
      throw new Error('wow-addons-key-storage-unavailable');
    }
  }
  return {
    isEncryptionAvailable: () => process.platform === 'win32',
    encryptString: (value) => transform('encrypt', Buffer.from(value, 'utf8')),
    decryptString: (value) => transform('decrypt', value).toString('utf8'),
  };
}
