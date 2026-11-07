param([ValidateSet('retail', 'forever')][string]$Game = 'retail', [int]$Port = 0, [switch]$Demo)
$ErrorActionPreference = 'Stop'
$bridgeRoot = $PSScriptRoot
$bridgeScript = Join-Path $bridgeRoot 'server.py'
$suffix = if ($Game -eq 'forever') { '-forever' } else { '' }
$protocol = if ($Game -eq 'forever') { 'WCF1' } else { 'WCP1' }
if ($Port -eq 0) { $Port = if ($Game -eq 'forever') { 18766 } else { 18765 } }
if ($Port -lt 1 -or $Port -gt 65535) { throw 'Port must be between 1 and 65535.' }
$bridgePidFile = Join-Path $bridgeRoot "bridge$suffix.pid"
if (Test-Path -LiteralPath $bridgePidFile) {
    $existingPid = [int](Get-Content -LiteralPath $bridgePidFile -Raw)
    $existing = Get-CimInstance Win32_Process -Filter "ProcessId=$existingPid" -ErrorAction SilentlyContinue
    if ($existing -and $existing.CommandLine -and $existing.CommandLine.Contains($bridgeScript)) {
        $health = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/health" -TimeoutSec 3
        if ($health.service -ne 'wow-companion-bridge' -or $health.protocol -ne $protocol) { throw 'Port is not serving this game version.' }
        Write-Output "Bridge already running (PID $existingPid). http://127.0.0.1:$Port/"
        exit 0
    }
}
$python = (Get-Command python -ErrorAction Stop).Source
$bridgeArguments = @('"' + $bridgeScript + '"', '--game', $Game, '--port', "$Port")
if ($Demo) { $bridgeArguments += '--demo' }
$bridgeProcess = Start-Process -FilePath $python -ArgumentList $bridgeArguments -WorkingDirectory $bridgeRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $bridgeRoot "bridge$suffix.stdout.log") -RedirectStandardError (Join-Path $bridgeRoot "bridge$suffix.stderr.log")
Set-Content -LiteralPath $bridgePidFile -Value $bridgeProcess.Id -Encoding ascii
Start-Sleep -Milliseconds 700
$bridgeProcess.Refresh()
if ($bridgeProcess.HasExited) { throw "Bridge exited during startup. Inspect bridge$suffix.stderr.log." }
$health = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/health" -TimeoutSec 3
if ($health.service -ne 'wow-companion-bridge' -or $health.protocol -ne $protocol) { throw 'Health check did not identify this game version.' }
Write-Output "Bridge started (PID $($bridgeProcess.Id)). http://127.0.0.1:$Port/"
