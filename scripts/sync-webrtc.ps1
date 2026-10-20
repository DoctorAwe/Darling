param([switch]$RunHooks, [string]$Proxy = '', [switch]$DisableHttp2)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path $PSScriptRoot -Parent
$lock = Get-Content -Raw (Join-Path $projectRoot 'native/webrtc-build.lock.json') | ConvertFrom-Json
$toolsPath = Join-Path $projectRoot '.local/depot_tools'
$checkoutPath = Join-Path $projectRoot '.local/webrtc'
$sourcePath = Join-Path $checkoutPath 'src'
foreach ($entry in @(@($toolsPath,$lock.depotTools.revision), @($sourcePath,$lock.webrtc.revision))) {
    $actual = & git -C $entry[0] rev-parse HEAD
    if ($LASTEXITCODE -or $actual -ne $entry[1]) { throw "Pinned checkout missing or mismatched: $($entry[0])" }
}
$volume = Get-PSDrive -Name ([IO.Path]::GetPathRoot($checkoutPath).Substring(0,1))
if ($volume.Free -lt 15GB) { throw 'Less than 15 GiB free. Stop before downloading more dependencies; do not delete user files.' }
# Process-only environment: do not modify user/system PATH or global git settings.
$env:DEPOT_TOOLS_UPDATE = '0'
$env:DEPOT_TOOLS_WIN_TOOLCHAIN = '0'
# This upstream revision searches Program Files for VS 2022, but Build Tools
# can be installed under Program Files (x86). Discover the existing installation.
$vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio/Installer/vswhere.exe'
if (Test-Path -LiteralPath $vswhere) {
    $vsPath = & $vswhere -latest -products '*' -version '[17.0,18.0)' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
    if ($LASTEXITCODE -eq 0 -and $vsPath -and (Test-Path -LiteralPath $vsPath)) {
        $env:vs2022_install = $vsPath
    }
}
$env:PATH = "$toolsPath;$env:PATH"
$env:GIT_TERMINAL_PROMPT = '0'
$env:VPYTHON_VIRTUALENV_ROOT = Join-Path $projectRoot '.local/vpython'
$env:CIPD_CACHE_DIR = Join-Path $projectRoot '.local/cipd-cache'
if ($Proxy) {
    $proxyUri = [Uri]$Proxy
    if (!$proxyUri.IsAbsoluteUri -or $proxyUri.Scheme -notin @('http','https')) { throw 'Proxy must be an absolute HTTP(S) proxy URL.' }
    $env:HTTP_PROXY = $Proxy
    $env:HTTPS_PROXY = $Proxy
}
if ($DisableHttp2) {
    $env:GODEBUG = (@($env:GODEBUG -split ',' | Where-Object { $_ -and $_ -notmatch '^http2client=' }) + 'http2client=0') -join ','
}
Push-Location $checkoutPath
try {
    if ($RunHooks) {
        if ($lock.allowSdkInstall -ne $false -or $lock.windowsSdk -ne '10.0.26100.0') { throw 'Only the existing 26100 SDK is authorized.' }
        $sdkInclude = Join-Path ${env:ProgramFiles(x86)} 'Windows Kits/10/Include/10.0.26100.0'
        if (!(Test-Path -LiteralPath $sdkInclude)) { throw 'Required existing SDK 26100 is missing; installation is forbidden.' }
        foreach ($relative in @('build/vs_toolchain.py','build/toolchain/win/setup_toolchain.py')) {
            $toolchainText = Get-Content -Raw (Join-Path $sourcePath $relative)
            $sdkMatch = [regex]::Match($toolchainText, '(?m)^SDK_VERSION\s*=\s*[''"]([^''"]+)[''"]')
            if (!$sdkMatch.Success -or $sdkMatch.Groups[1].Value -ne $lock.windowsSdk) { throw "Unexpected SDK requirement in $relative; do not install another SDK." }
        }
        & (Join-Path $toolsPath 'gclient.bat') runhooks
    } else {
        & (Join-Path $toolsPath 'gclient.bat') sync --nohooks --no-history --jobs=4 --revision "src@$($lock.webrtc.revision)"
    }
    if ($LASTEXITCODE) { throw 'WebRTC dependency preparation failed; existing checkout retained for diagnosis/resume.' }
} finally { Pop-Location }
