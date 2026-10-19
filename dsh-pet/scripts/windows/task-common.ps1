function Find-OwnedSyncTask($Identity, $Command) {
    $tasks = @(Get-ScheduledTask -TaskPath '\' | Where-Object { $_.TaskName -ceq $Identity.taskName })
    if ($tasks.Count -eq 0) { return $null }
    if ($tasks.Count -ne 1) { throw 'Ambiguous scheduled task identity.' }
    $task = $tasks[0]
    $userName = [Environment]::UserName
    $userMatches = ($task.Principal.UserId -ieq $Identity.sid -or $task.Principal.UserId -ieq $userName -or $task.Principal.UserId -ieq "$env:USERDOMAIN\$userName")
    if ($task.Description -cne $Identity.owner -or @($task.Actions).Count -ne 1 -or
        $task.Actions[0].Execute -ine $Command.executable -or $task.Actions[0].Arguments -cne $Command.arguments -or
        (-not $userMatches) -or [string]$task.Principal.RunLevel -ne 'Limited' -or
        [string]$task.Principal.LogonType -notin @('Interactive', 'InteractiveToken')) {
        throw 'Scheduled task exists but is not the exact owned target; refusing modification.'
    }
    $task
}

function Assert-SyncSchedule($Task) {
    $triggers = @($Task.Triggers)
    if ($triggers.Count -ne 1 -or $triggers[0].CimClass.CimClassName -ne 'MSFT_TaskWeeklyTrigger' -or
        [int]$triggers[0].DaysOfWeek -ne 2 -or [int]$triggers[0].WeeksInterval -ne 1 -or
        ([datetime]$triggers[0].StartBoundary).ToString('HH:mm') -ne '09:17' -or
        -not $triggers[0].Enabled -or -not $Task.Settings.StartWhenAvailable -or
        [string]$Task.Settings.MultipleInstances -ne 'IgnoreNew' -or
        [Xml.XmlConvert]::ToTimeSpan($Task.Settings.ExecutionTimeLimit).TotalMinutes -gt 10) {
        throw 'Owned scheduled task has an unexpected schedule or safety settings; inspect it manually.'
    }
}
