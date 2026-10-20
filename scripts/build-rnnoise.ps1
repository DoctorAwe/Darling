param([switch]$Fetch, [string]$Proxy = '')
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$lock = Get-Content -Raw (Join-Path $root 'native/rnnoise.lock.json') | ConvertFrom-Json
$source = Join-Path $root '.local/rnnoise'
if (!(Test-Path $source)) {
    if (!$Fetch) { throw 'RNNoise source missing; explicitly pass -Fetch to download the pinned source/model.' }
    $gitOptions = if ($Proxy) { @('-c', "http.proxy=$Proxy") } else { @() }
    & git @gitOptions clone --depth 1 --branch $lock.tag $lock.source $source
    if ($LASTEXITCODE) { throw 'RNNoise download failed' }
}
$revision = & git -C $source rev-parse HEAD
if ($LASTEXITCODE -or $revision.Trim() -ne $lock.revision) { throw 'RNNoise source revision mismatch' }
if (& git -C $source status --porcelain --untracked-files=no) { throw 'Tracked RNNoise source modified; refusing unaudited build' }
$archive = Join-Path $source 'rnnoise_data-0b50c45.tar.gz'
if (!(Test-Path $archive)) {
    if (!$Fetch) { throw 'Pinned model missing; pass -Fetch to download' }
    $proxyOptions = if ($Proxy) { @('--proxy',$Proxy) } else { @() }
    & curl.exe --fail --location @proxyOptions $lock.modelUrl --output $archive
    if ($LASTEXITCODE) { throw 'Model download failed' }
}
if ((Get-FileHash $archive -Algorithm SHA256).Hash.ToLowerInvariant() -ne $lock.modelSha256) { throw 'Model SHA256 mismatch' }
& tar.exe -xf $archive -C $source src/rnnoise_data.c src/rnnoise_data.h
if ($LASTEXITCODE) { throw 'Model extraction failed' }
$vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio/Installer/vswhere.exe'
$vs = & $vswhere -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
$cmake = Join-Path $vs 'Common7/IDE/CommonExtensions/Microsoft/CMake/CMake/bin/cmake.exe'
$build = Join-Path $root '.local/rnnoise-build'
& $cmake -S (Join-Path $root 'native/rnnoise') -B $build -G 'Visual Studio 17 2022' -A x64 "-DCMAKE_SYSTEM_VERSION=$($lock.sdk)"
if ($LASTEXITCODE) { throw 'RNNoise configure failed' }
& $cmake --build $build --config Release
if ($LASTEXITCODE) { throw 'RNNoise build failed' }
$rtcOut = Join-Path $root '.local/webrtc/src/out/DarlingRelease'
if (Test-Path $rtcOut) { Copy-Item -LiteralPath (Join-Path $build 'Release/darling_rnnoise.dll') -Destination $rtcOut }
Write-Output 'RNNoise built with existing SDK 26100. Rebuild the RTC targets after applying native/rtc-smoke/target.patch.'
