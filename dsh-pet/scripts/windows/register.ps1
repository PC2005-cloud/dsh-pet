[CmdletBinding()]
param([Parameter(Mandatory=$true)][string]$ConfigPath, [switch]$WhatIf)
. (Join-Path $PSScriptRoot 'common.ps1')
. (Join-Path $PSScriptRoot 'task-common.ps1')
$config = Read-Deployment $ConfigPath
$identity = Get-InstallIdentity $config
$command = Get-HelperCommand $config 'sync-upstream.ps1'
if ($WhatIf) {
    [pscustomobject]@{action='register-weekly-sync';configPath=$config.configPath;taskName=$identity.taskName;userSid=$identity.sid;
        day='Monday';time='09:17';startWhenAvailable=$true;runLevel='Limited';logonType='InteractiveToken';execute=$command.executable;arguments=$command.arguments} | ConvertTo-Json
    return
}
Assert-TrustedHelperLocation $config
Import-Module ScheduledTasks -ErrorAction Stop
$existing = Find-OwnedSyncTask $identity $command
if ($null -ne $existing) { Assert-SyncSchedule $existing; Write-Output 'Owned weekly source synchronization already registered.'; return }
$action = New-ScheduledTaskAction -Execute $command.executable -Argument $command.arguments -WorkingDirectory (Split-Path -Parent $config.configPath)
$trigger = New-ScheduledTaskTrigger -Weekly -WeeksInterval 1 -DaysOfWeek Monday -At '09:17'
$principal = New-ScheduledTaskPrincipal -UserId $identity.sid -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 10) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName $identity.taskName -TaskPath '\' -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description $identity.owner | Out-Null
$installed = Find-OwnedSyncTask $identity $command
if ($null -eq $installed) { throw 'Registered task could not be verified.' }
Assert-SyncSchedule $installed
Write-Output 'Weekly source synchronization registered for Monday 09:17, catch-up enabled. It was not run.'
