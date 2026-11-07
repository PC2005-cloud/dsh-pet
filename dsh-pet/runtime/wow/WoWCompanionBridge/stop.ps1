param([ValidateSet('retail', 'forever')][string]$Game = 'retail')
$ErrorActionPreference = 'Stop'
$suffix = if ($Game -eq 'forever') { '-forever' } else { '' }
$bridgePidFile = Join-Path $PSScriptRoot "bridge$suffix.pid"
$bridgeScript = Join-Path $PSScriptRoot 'server.py'
if (-not (Test-Path -LiteralPath $bridgePidFile)) { Write-Output 'No bridge PID file.'; exit 0 }
$bridgeProcessId = [int](Get-Content -LiteralPath $bridgePidFile -Raw)
$bridgeProcess = Get-CimInstance Win32_Process -Filter "ProcessId=$bridgeProcessId" -ErrorAction SilentlyContinue
if ($bridgeProcess) {
    if (-not $bridgeProcess.CommandLine -or -not $bridgeProcess.CommandLine.Contains($bridgeScript)) { throw 'PID no longer belongs to this bridge. Refusing to stop another process.' }
    $isForever = $bridgeProcess.CommandLine -match '--game\s+forever\b'
    if (($Game -eq 'forever') -ne $isForever) { throw 'PID belongs to a different game version.' }
    Stop-Process -Id $bridgeProcessId
}
Remove-Item -LiteralPath $bridgePidFile
Write-Output 'Bridge stopped.'
