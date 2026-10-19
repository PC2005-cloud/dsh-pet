function Invoke-BoundedGit($Config, [string]$HooksPath, [string[]]$Arguments, [switch]$AllowMissing, [int]$TimeoutSeconds=120) {
    $safe = @('-c', "core.hooksPath=$HooksPath", '-c', 'core.fsmonitor=false', '-c', 'maintenance.auto=false',
        '-c', 'gc.auto=0', '-c', 'credential.helper=', '-c', 'credential.interactive=never',
        '-c', 'protocol.allow=never', '-c', 'protocol.https.allow=always', '-c', 'http.lowSpeedLimit=1',
        '-c', 'http.lowSpeedTime=30', '-c', 'fetch.writeCommitGraph=false', '-C', $Config.sourceRoot) + $Arguments
    $info = New-Object Diagnostics.ProcessStartInfo
    $info.FileName = $Config.gitPath
    $info.WorkingDirectory = $PSScriptRoot
    $info.Arguments = ($safe | ForEach-Object { ConvertTo-NativeArgument $_ }) -join ' '
    $info.UseShellExecute = $false; $info.CreateNoWindow = $true
    $info.RedirectStandardOutput = $true; $info.RedirectStandardError = $true
    $info.EnvironmentVariables['GIT_TERMINAL_PROMPT'] = '0'
    $info.EnvironmentVariables['GCM_INTERACTIVE'] = 'Never'
    $info.EnvironmentVariables['GIT_CONFIG_COUNT'] = '0'
    foreach ($key in @('GIT_DIR','GIT_WORK_TREE','GIT_COMMON_DIR','GIT_INDEX_FILE','GIT_OBJECT_DIRECTORY','GIT_ALTERNATE_OBJECT_DIRECTORIES','GIT_CONFIG','GIT_CONFIG_PARAMETERS','GIT_SSH','GIT_SSH_COMMAND','GIT_ASKPASS','SSH_ASKPASS')) { $info.EnvironmentVariables.Remove($key) }
    $process = New-Object Diagnostics.Process
    $process.StartInfo = $info
    try {
        [void]$process.Start()
        $stdout = $process.StandardOutput.ReadToEndAsync(); $stderr = $process.StandardError.ReadToEndAsync()
        if (-not $process.WaitForExit($TimeoutSeconds * 1000)) {
            $process.Kill()
            [void]$process.WaitForExit(5000)
            throw "Git operation timed out after $TimeoutSeconds seconds; its exact process was terminated."
        }
        if (-not $stdout.Wait(5000) -or -not $stderr.Wait(5000)) { throw 'Git output collection timed out.' }
        if ($AllowMissing -and ($process.ExitCode -eq 1 -or $process.ExitCode -eq 128)) { return $null }
        if ($process.ExitCode -ne 0) { throw "Git operation failed with exit code $($process.ExitCode): $($stderr.Result.Trim()). No working files were changed." }
        $stdout.Result.Trim()
    } finally { $process.Dispose() }
}
