[CmdletBinding()]
param([Parameter(Mandatory=$true)][string]$ConfigPath, [switch]$WhatIf)
. (Join-Path $PSScriptRoot 'common.ps1')
$config = Read-Deployment $ConfigPath
$identity = Get-InstallIdentity $config
if ($WhatIf) { [pscustomobject]@{action='launch';configPath=$config.configPath;mutex=$identity.mutexName;nodePath=$config.nodePath;entryPath=$config.entryPath} | ConvertTo-Json; return }
$mutex = New-Object Threading.Mutex($false, $identity.mutexName)
$held = $false
try {
    try { $held = $mutex.WaitOne(0) } catch [Threading.AbandonedMutexException] { $held = $true }
    if (-not $held) { Write-LauncherLog $config 'Supervisor already active; no duplicate launch.'; return }
    $health = $null
    try { $health = Get-HostHealth $config } catch [Net.WebException] {
        if ($_.Exception.Status -ne [Net.WebExceptionStatus]::ConnectFailure) { throw 'Port health probe failed; refusing a duplicate launch.' }
    }
    if ($null -ne $health) {
        Assert-HostIdentity $config $health
        Write-LauncherLog $config "Existing standalone host PID $($health.pid); left unchanged."
        return
    }
    # Reserve/probe the configured port, never let an unrelated listener be mistaken for absence.
    $listener = New-Object Net.Sockets.TcpListener([Net.IPAddress]::Loopback, $config.port)
    try { $listener.Start() } finally { $listener.Stop() }
    $logs = Join-Path $config.dataHome 'launcher-logs'
    [void][IO.Directory]::CreateDirectory($logs)
    $stdout = Join-Path $logs 'host.stdout.log'; $stderr = Join-Path $logs 'host.stderr.log'
    # Start-Process truncates redirect targets, so retain each previous session as well.
    foreach ($path in @($stdout, $stderr)) { Rotate-Log $path 0 }
    $arguments = @($config.entryPath, '--port', [string]$config.port) | ForEach-Object { ConvertTo-NativeArgument $_ }
    $previousHome = [Environment]::GetEnvironmentVariable('DSH_HOME', 'Process')
    try {
        [Environment]::SetEnvironmentVariable('DSH_HOME', $config.dataHome, 'Process')
        $child = Start-Process -FilePath $config.nodePath -ArgumentList ($arguments -join ' ') -WorkingDirectory $config.workingDirectory -WindowStyle Hidden -RedirectStandardOutput $stdout -RedirectStandardError $stderr -PassThru
    } finally { [Environment]::SetEnvironmentVariable('DSH_HOME', $previousHome, 'Process') }
    try {
        Write-LauncherLog $config "Started standalone host PID $($child.Id)."
        $child.WaitForExit()
        $child.Refresh()
        $exitCode = if ($null -ne $child.ExitCode) { $child.ExitCode } else { 0 }
        Write-LauncherLog $config "Standalone host exited with code $exitCode."
        foreach ($path in @($stdout, $stderr)) { Rotate-Log $path }
        if ($exitCode -ne 0) { throw "Standalone host exited with code $exitCode; inspect launcher-logs." }
    } finally { $child.Dispose() }
} catch {
    Write-LauncherLog $config "Launch failed: $($_.Exception.Message)"
    throw
} finally {
    if ($held) { $mutex.ReleaseMutex() }
    $mutex.Dispose()
}
