[CmdletBinding()]
param([Parameter(Mandatory=$true)][string]$ConfigPath, [switch]$WhatIf)
. (Join-Path $PSScriptRoot 'common.ps1')
. (Join-Path $PSScriptRoot 'task-common.ps1')
$config = Read-Deployment $ConfigPath
$identity = Get-InstallIdentity $config
$command = Get-HelperCommand $config 'sync-upstream.ps1'
if ($WhatIf) { [pscustomobject]@{action='remove-weekly-sync';configPath=$config.configPath;taskName=$identity.taskName} | ConvertTo-Json; return }
Import-Module ScheduledTasks -ErrorAction Stop
$existing = Find-OwnedSyncTask $identity $command
if ($null -eq $existing) { Write-Output 'Weekly synchronization task is absent.'; return }
Unregister-ScheduledTask -TaskName $identity.taskName -TaskPath '\' -Confirm:$false
Write-Output 'Owned weekly synchronization task removed.'
