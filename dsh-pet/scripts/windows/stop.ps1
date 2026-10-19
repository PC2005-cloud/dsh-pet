[CmdletBinding()]
param([Parameter(Mandatory=$true)][string]$ConfigPath)
. (Join-Path $PSScriptRoot 'common.ps1')
$config = Read-Deployment $ConfigPath
$runtime = Read-Runtime $config
$health = Get-HostHealth $config
Assert-HostIdentity $config $health $runtime
$request = [Net.HttpWebRequest]::Create("http://127.0.0.1:$($config.port)/shutdown")
$request.Proxy = $null; $request.Timeout = 5000; $request.ReadWriteTimeout = 5000
$request.Method = 'POST'; $request.ContentLength = 0
$request.Headers.Add('X-DSH-Pet-Token', [string]$runtime.token)
try {
    $response = $request.GetResponse()
    try { if ([int]$response.StatusCode -ne 200) { throw 'Shutdown was not accepted.' } } finally { $response.Dispose() }
} catch { throw 'Graceful shutdown request failed; no process was forcibly terminated.' }
Write-LauncherLog $config "Graceful shutdown requested for verified PID $($health.pid)."
Write-Output 'Graceful shutdown requested. No other processes were changed.'
