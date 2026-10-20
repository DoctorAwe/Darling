param([string]$BuildDirectory = '', [string]$CMakePath = '', [switch]$EvaluateAec3)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path $PSScriptRoot -Parent
if (!$BuildDirectory) {
    $buildSuffix = if ($EvaluateAec3) { 'native/media-engine/build/aec3-evaluation' } else { 'native/media-engine/build' }
    $BuildDirectory = Join-Path $projectRoot $buildSuffix
}
if (!$CMakePath) {
    $command = Get-Command cmake -ErrorAction SilentlyContinue
    if ($command) { $CMakePath = $command.Source }
    else {
        $vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio/Installer/vswhere.exe'
        if (Test-Path $vswhere) {
            $installation = & $vswhere -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
            if ($installation) { $CMakePath = Join-Path $installation 'Common7/IDE/CommonExtensions/Microsoft/CMake/CMake/bin/cmake.exe' }
        }
    }
}
if (!$CMakePath -or !(Test-Path $CMakePath)) { throw 'CMake/MSVC unavailable. Install Visual Studio C++ Build Tools with Windows SDK and CMake.' }
$aecOption = if ($EvaluateAec3) { 'ON' } else { 'OFF' }
& $CMakePath -S (Join-Path $projectRoot 'native/media-engine') -B $BuildDirectory -A x64 "-DDARLING_AEC3_EXPERIMENT=$aecOption"
if ($LASTEXITCODE) { throw 'Native configure failed' }
$ctest = Join-Path (Split-Path $CMakePath -Parent) 'ctest.exe'
if ($EvaluateAec3) {
    & $CMakePath --build $BuildDirectory --config Release --target aec3-evaluation darling-media-aec3
    if ($LASTEXITCODE) { throw 'AEC3 evaluation build failed' }
    & $ctest --test-dir $BuildDirectory -C Release -R '^aec3-evaluation$' --verbose
    if ($LASTEXITCODE) { throw 'AEC3 evaluation failed' }
    exit 0 # Never installs or enables the experimental algorithm in the client.
}
& $CMakePath --build $BuildDirectory --config Release
if ($LASTEXITCODE) { throw 'Native build failed' }
$ctest = Join-Path (Split-Path $CMakePath -Parent) 'ctest.exe'
& $ctest --test-dir $BuildDirectory -C Release --output-on-failure
if ($LASTEXITCODE) { throw 'Native tests failed' }
& $CMakePath --install $BuildDirectory --config Release --prefix (Join-Path $projectRoot 'apps/desktop/dist/native')
if ($LASTEXITCODE) { throw 'Native install failed' }
