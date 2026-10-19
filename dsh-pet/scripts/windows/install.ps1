[CmdletBinding()]
param([Parameter(Mandatory=$true)][string]$ConfigPath, [switch]$WhatIf)
. (Join-Path $PSScriptRoot 'common.ps1')
$config = Read-Deployment $ConfigPath
$identity = Get-InstallIdentity $config
$command = Get-HelperCommand $config 'launch.ps1'
$startup = [Environment]::GetFolderPath('Startup')
$path = Join-Path $startup $identity.shortcutName
if ($WhatIf) { [pscustomobject]@{action='install-autostart';configPath=$config.configPath;shortcut=$path;target=$command.executable;arguments=$command.arguments} | ConvertTo-Json; return }
Assert-TrustedHelperLocation $config
$shell = New-Object -ComObject WScript.Shell
try {
    $shortcut = $shell.CreateShortcut($path)
    try {
        if (Test-Path -LiteralPath $path) {
            if ($shortcut.Description -cne $identity.owner -or $shortcut.TargetPath -ine $command.executable -or $shortcut.Arguments -cne $command.arguments) {
                throw 'Startup shortcut exists but is not the exact owned target; refusing overwrite.'
            }
            Write-Output 'Owned startup shortcut already installed.'; return
        }
        $shortcut.TargetPath = $command.executable
        $shortcut.Arguments = $command.arguments
        $shortcut.WorkingDirectory = Split-Path -Parent $config.configPath
        $shortcut.Description = $identity.owner
        $shortcut.WindowStyle = 7
        $shortcut.Save()
        Write-Output 'Current-user startup shortcut installed; application not started.'
    } finally { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($shortcut) }
} finally { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($shell) }
