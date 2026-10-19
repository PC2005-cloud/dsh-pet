[CmdletBinding()]
param([Parameter(Mandatory=$true)][string]$ConfigPath, [switch]$WhatIf)
. (Join-Path $PSScriptRoot 'common.ps1')
. (Join-Path $PSScriptRoot 'git-common.ps1')
$config = Read-Deployment $ConfigPath
$identity = Get-InstallIdentity $config
if ($WhatIf) {
    [pscustomobject]@{action='fetch-upstream-source';configPath=$config.configPath;sourceRoot=$config.sourceRoot;
        expectedOrigin=$config.expectedOrigin;expectedUpstream=$config.expectedUpstream;ref='refs/remotes/upstream/main';timeoutSeconds=120} | ConvertTo-Json
    return
}
Assert-TrustedHelperLocation $config
if (-not $config.gitPath -or -not (Test-Path -LiteralPath $config.gitPath -PathType Leaf)) { throw 'A trusted absolute gitPath is required.' }
$mutex = New-Object Threading.Mutex($false, ($identity.mutexName + '-sync'))
$held = $false
$oldSha = $null
$newSha = $null
try {
    try { $held = $mutex.WaitOne(0) } catch [Threading.AbandonedMutexException] { $held = $true }
    if (-not $held) { throw 'Source synchronization is already active.' }
    $directory = Join-Path $config.dataHome 'update'
    [void][IO.Directory]::CreateDirectory($directory)
    $hooks = Join-Path $directory 'no-hooks'
    [void][IO.Directory]::CreateDirectory($hooks)
    if (((Get-Item -LiteralPath $hooks).Attributes -band [IO.FileAttributes]::ReparsePoint) -or @(Get-ChildItem -LiteralPath $hooks -Force).Count -ne 0) { throw 'The disabled-hooks directory must be empty and not a link.' }
    foreach ($remote in @(@('origin', $config.expectedOrigin), @('upstream', $config.expectedUpstream))) {
        $actual = Invoke-BoundedGit $config $hooks @('remote', 'get-url', '--all', $remote[0])
        if ($actual -cne $remote[1]) { throw "Unexpected $($remote[0]) remote URL; synchronization refused." }
    }
    $oldSha = Invoke-BoundedGit $config $hooks @('show-ref', '--verify', '--hash', 'refs/remotes/upstream/main') -AllowMissing
    if ($null -ne $oldSha -and $oldSha -notmatch '^[a-f0-9]{40,64}$') { throw 'Invalid previous source object identity.' }
    Invoke-BoundedGit $config $hooks @('fetch', '--no-tags', '--no-recurse-submodules', '--no-auto-maintenance', '--no-write-fetch-head',
        $config.expectedUpstream, 'refs/heads/main:refs/remotes/upstream/main') | Out-Null
    $newSha = Invoke-BoundedGit $config $hooks @('show-ref', '--verify', '--hash', 'refs/remotes/upstream/main')
    if ($newSha -notmatch '^[a-f0-9]{40,64}$') { throw 'Invalid fetched source object identity.' }
    $status = [pscustomobject]@{schemaVersion=1;success=$true;checkedAt=[DateTime]::UtcNow.ToString('o');oldSha=$oldSha;newSha=$newSha;
        sourceRoot=$config.sourceRoot;upstream=$config.expectedUpstream;ref='refs/remotes/upstream/main';mode='fetch-and-record';workingFilesChanged=$false}
    Write-JsonAtomic (Join-Path $directory 'upstream-status.json') $status
    Write-LauncherLog $config "Source fetch succeeded: old=$oldSha new=$newSha. Working files unchanged."
    Write-Output 'Upstream source objects fetched and recorded; working files and deployed application unchanged.'
} catch {
    if ($held) {
        $failed = [pscustomobject]@{schemaVersion=1;success=$false;checkedAt=[DateTime]::UtcNow.ToString('o');oldSha=$oldSha;newSha=$newSha;
            sourceRoot=$config.sourceRoot;mode='fetch-and-record';workingFilesChanged=$false;error=$_.Exception.Message}
        Write-JsonAtomic (Join-Path $config.dataHome 'update\upstream-status.json') $failed
        Write-LauncherLog $config "Source fetch failed: $($_.Exception.Message)"
    }
    throw
} finally {
    if ($held) { $mutex.ReleaseMutex() }
    $mutex.Dispose()
}
