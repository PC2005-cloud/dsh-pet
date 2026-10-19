[CmdletBinding()]
param([Parameter(Mandatory=$true)][string]$ConfigPath)
. (Join-Path $PSScriptRoot 'common.ps1')
$config = Read-Deployment $ConfigPath
$runtime = Read-Runtime $config
$health = Get-HostHealth $config
Assert-HostIdentity $config $health $runtime
# Construct the loopback URL; never trust an arbitrary URL supplied in the manifest.
$url = "http://127.0.0.1:$($config.port)/standalone-ai/#token=$([Uri]::EscapeDataString([string]$runtime.token))"
try { Start-Process -FilePath $url | Out-Null } catch { throw 'Could not open local settings in the default browser.' }
Write-Output 'Local settings opened in the default browser.'
