[CmdletBinding()]
param([Parameter(Mandatory=$true)][string]$ConfigPath, [switch]$WhatIf)
. (Join-Path $PSScriptRoot 'common.ps1')
$config = Read-Deployment $ConfigPath
$identity = Get-InstallIdentity $config
$command = Get-HelperCommand $config 'launch.ps1'
$path = Join-Path ([Environment]::GetFolderPath('Startup')) $identity.shortcutName
if ($WhatIf) { [pscustomobject]@{action='disable-autostart';configPath=$config.configPath;shortcut=$path} | ConvertTo-Json; return }
if (-not (Test-Path -LiteralPath $path)) { Write-Output 'Startup shortcut is absent.'; return }
$shell = New-Object -ComObject WScript.Shell
try {
    $shortcut = $shell.CreateShortcut($path)
    try {
        if ($shortcut.Description -cne $identity.owner -or $shortcut.TargetPath -ine $command.executable -or $shortcut.Arguments -cne $command.arguments) {
            throw 'Startup shortcut is not the exact owned target; refusing removal.'
        }
    } finally { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($shortcut) }
    Remove-Item -LiteralPath $path
    Write-Output 'Owned startup shortcut removed; running application unchanged.'
} finally { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($shell) }
