Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function ConvertTo-NativeArgument([AllowEmptyString()][string]$Value) {
    # CommandLineToArgvW/CRT rules: double slashes before quotes and closing quote.
    '"' + [regex]::Replace([regex]::Replace($Value, '(\\*)"', '$1$1\"'), '(\\+)$', '$1$1') + '"'
}

function Get-AbsolutePath([string]$Value, [string]$Label) {
    if ([string]::IsNullOrWhiteSpace($Value) -or $Value -match '[\x00-\x1f"]' -or
        $Value -notmatch '^[a-zA-Z]:[\\/]') { throw "$Label must be an absolute local path." }
    [IO.Path]::GetFullPath($Value)
}

function Read-Deployment([string]$ConfigPath) {
    $path = Get-AbsolutePath $ConfigPath 'ConfigPath'
    $raw = Get-Content -LiteralPath $path -Raw | ConvertFrom-Json
    $paths = @{}
    foreach ($name in @('nodePath', 'entryPath', 'workingDirectory', 'dataHome', 'sourceRoot', 'pluginRoot')) {
        $paths[$name] = Get-AbsolutePath ([string]$raw.$name) $name
    }
    if ([string]$raw.port -notmatch '^\d+$' -or [int]$raw.port -lt 1024 -or [int]$raw.port -gt 65535) { throw 'Invalid port: expected integer 1024..65535.' }
    foreach ($name in @('nodePath', 'entryPath', 'workingDirectory', 'sourceRoot', 'pluginRoot')) {
        if (-not (Test-Path -LiteralPath $paths[$name])) { throw "Missing deployment path: $name" }
    }
    $gitPath = if ($raw.PSObject.Properties['gitPath']) { Get-AbsolutePath ([string]$raw.gitPath) 'gitPath' } else { $null }
    $origin = if ($raw.PSObject.Properties['expectedOrigin']) { [string]$raw.expectedOrigin } else { 'https://github.com/kanoha222/dsh-pet.git' }
    $upstream = if ($raw.PSObject.Properties['expectedUpstream']) { [string]$raw.expectedUpstream } else { 'https://github.com/PC2005-cloud/dsh-pet.git' }
    foreach ($url in @($origin, $upstream)) {
        if ($url -notmatch '^https://github\.com/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+\.git$') { throw 'Expected remotes must be credential-free GitHub HTTPS URLs.' }
    }
    [pscustomobject]@{ configPath=$path; nodePath=$paths.nodePath; entryPath=$paths.entryPath;
        workingDirectory=$paths.workingDirectory; dataHome=$paths.dataHome; sourceRoot=$paths.sourceRoot;
        pluginRoot=$paths.pluginRoot; port=[int]$raw.port; gitPath=$gitPath; expectedOrigin=$origin; expectedUpstream=$upstream }
}

function Get-InstallIdentity($Config) {
    $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    $bytes = [Text.Encoding]::UTF8.GetBytes($sid + '|' + $Config.configPath.ToLowerInvariant())
    $sha = [Security.Cryptography.SHA256]::Create()
    try { $hash = ([BitConverter]::ToString($sha.ComputeHash($bytes))).Replace('-', '').Substring(0, 20) } finally { $sha.Dispose() }
    [pscustomobject]@{ sid=$sid; id=$hash; owner="DSH-Pet:$hash"; taskName="DSH-Pet-Upstream-$hash";
        mutexName="Global\DSH-Pet-$hash"; shortcutName="DSH-Pet-$hash.lnk" }
}

function Get-HelperCommand($Config, [string]$ScriptName) {
    $script = Join-Path $PSScriptRoot $ScriptName
    $arguments = @('-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-File', $script, '-ConfigPath', $Config.configPath)
    [pscustomobject]@{ executable=(Join-Path $PSHOME 'powershell.exe'); arguments=(($arguments | ForEach-Object { ConvertTo-NativeArgument $_ }) -join ' '); script=$script }
}

function Assert-TrustedHelperLocation($Config) {
    $helper = [IO.Path]::GetFullPath($PSScriptRoot).TrimEnd('\') + '\'
    $source = $Config.sourceRoot.TrimEnd('\') + '\'
    if ($helper.StartsWith($source, [StringComparison]::OrdinalIgnoreCase)) { throw 'Copy helpers outside the source repository before installing automatic actions.' }
}

function Read-Runtime($Config) {
    $path = Join-Path $Config.dataHome 'dsh-pet\standalone-runtime.json'
    $runtime = Get-Content -LiteralPath $path -Raw | ConvertFrom-Json
    if ($runtime.name -cne 'dsh-pet-standalone' -or [string]$runtime.pid -notmatch '^\d+$' -or [long]$runtime.pid -le 0 -or
        [string]$runtime.port -ne [string]$Config.port -or [string]$runtime.token -notmatch '^[A-Za-z0-9_-]{24,256}$') { throw 'Invalid standalone runtime identity.' }
    $root = Get-AbsolutePath ([string]$runtime.pluginRoot) 'runtime pluginRoot'
    if ($root.TrimEnd('\') -ine $Config.pluginRoot.TrimEnd('\')) { throw 'Runtime plugin root does not match deployment.' }
    $runtime
}

function Get-HostHealth($Config) {
    # Ignore environment proxy configuration for loopback identity probes.
    $uri = "http://127.0.0.1:$($Config.port)/health"
    $request = [Net.HttpWebRequest]::Create($uri)
    $request.Proxy = $null; $request.Timeout = 3000; $request.ReadWriteTimeout = 3000
    $response = $request.GetResponse()
    try {
        $reader = New-Object IO.StreamReader($response.GetResponseStream())
        try { $reader.ReadToEnd() | ConvertFrom-Json } finally { $reader.Dispose() }
    } finally { $response.Dispose() }
}

function Assert-HostIdentity($Config, $Health, $Runtime=$null) {
    if ($Health.name -cne 'dsh-pet-standalone' -or [string]$Health.pid -notmatch '^\d+$' -or [long]$Health.pid -le 0) { throw 'Unexpected host identity; refusing to control this port.' }
    $root = Get-AbsolutePath ([string]$Health.pluginRoot) 'health pluginRoot'
    if ($root.TrimEnd('\') -ine $Config.pluginRoot.TrimEnd('\')) { throw 'Health plugin root does not match deployment.' }
    if ($null -ne $Runtime -and [long]$Health.pid -ne [long]$Runtime.pid) { throw 'Health PID does not match runtime manifest.' }
}

function Rotate-Log([string]$Path, [long]$Limit=5242880) {
    if ((Test-Path -LiteralPath $Path) -and (Get-Item -LiteralPath $Path).Length -ge $Limit) {
        for ($i=3; $i -ge 1; $i--) {
            $old = if ($i -eq 1) { $Path } else { "$Path.$($i-1)" }
            if (Test-Path -LiteralPath $old) { Move-Item -LiteralPath $old -Destination "$Path.$i" -Force }
        }
    }
}

function Write-LauncherLog($Config, [string]$Message) {
    $directory = Join-Path $Config.dataHome 'launcher-logs'
    [void][IO.Directory]::CreateDirectory($directory)
    $path = Join-Path $directory 'launcher.log'
    Rotate-Log $path
    Add-Content -LiteralPath $path -Value ("{0} {1}" -f [DateTime]::UtcNow.ToString('o'), $Message) -Encoding UTF8
}

function Write-JsonAtomic([string]$Path, $Value) {
    $temporary = "$Path.$([Guid]::NewGuid().ToString('N')).tmp"
    try {
        [IO.File]::WriteAllText($temporary, ($Value | ConvertTo-Json -Depth 8), (New-Object Text.UTF8Encoding($false)))
        Move-Item -LiteralPath $temporary -Destination $Path -Force
    } finally { if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Force } }
}
