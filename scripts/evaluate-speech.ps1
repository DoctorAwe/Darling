param(
    [Parameter(Mandatory)][string]$FarWav,
    [Parameter(Mandatory)][string]$NearWav,
    [Parameter(Mandatory)][string]$SourceNote,
    [switch]$ComparePaths,
    [ValidateSet(0,12,24)][int]$DiagnosticGainDb = 0,
    [switch]$LowExcitation,
    [switch]$NegativeControls,
    [switch]$NegativeNearendMask
)
$ErrorActionPreference = 'Stop'
if ($NegativeNearendMask) { $NegativeControls = $true }
if ($LowExcitation -and $DiagnosticGainDb -ne 0) { throw 'Keep threshold and gain diagnostics separate.' }
if ($NegativeControls -and ($LowExcitation -or $ComparePaths -or $DiagnosticGainDb -ne 0)) { throw 'NegativeControls already compares both profiles; do not combine switches.' }
$root = Split-Path $PSScriptRoot -Parent
$executable = Join-Path $root 'native/media-engine/build/aec3-evaluation/Release/aec3-evaluation.exe'
$far = (Resolve-Path -LiteralPath $FarWav).Path
$near = (Resolve-Path -LiteralPath $NearWav).Path
if ([string]::IsNullOrWhiteSpace($SourceNote)) { throw 'SourceNote must describe source, speaker separation and permission/license.' }
if (-not (Test-Path -LiteralPath $executable)) { throw 'Build the aec3-evaluation target first.' }
$directory = Join-Path $root ('.local/aec3-speech/' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $directory -Force | Out-Null
$inputs = @($far,$near) | ForEach-Object {
    [pscustomobject]@{ path = $_; sha256 = (Get-FileHash -LiteralPath $_ -Algorithm SHA256).Hash }
}
$binaryHash = (Get-FileHash -LiteralPath $executable -Algorithm SHA256).Hash
$started = [DateTime]::UtcNow.ToString('o')
# Windows PowerShell may wrap native stderr in ErrorRecord objects. Preserve
# failed-run diagnostics in the report instead of terminating on stderr alone.
$ErrorActionPreference = 'Continue'
$mode = if ($ComparePaths) { '--speech-paths' } else { '--speech-wav' }
if ($DiagnosticGainDb -ne 0) { $ComparePaths = $true; $mode = "--speech-gain-$DiagnosticGainDb" }
if ($LowExcitation) { $ComparePaths = $true; $mode = '--speech-low-excitation' }
if ($NegativeControls) { $mode = '--speech-negative' }
if ($NegativeNearendMask) { $mode = '--speech-negative-mask' }
$output = & $executable $mode $far $near 2>&1
$resultCode = $LASTEXITCODE
$ErrorActionPreference = 'Stop'
$changed = ($inputs | Where-Object { (Get-FileHash -LiteralPath $_.path -Algorithm SHA256).Hash -ne $_.sha256 }).Count -gt 0
if ($changed) { $resultCode = 65 }
[pscustomobject]@{
    schemaVersion = 1
    startedUtc = $started
    sourceNote = $SourceNote
    contentVerifiedAsSpeech = $false
    inputs = @($inputs)
    executableSha256 = $binaryHash
    inputChangedDuringRun = $changed
    profile = if ($NegativeNearendMask) { 'default-and-diagnostic-nearend-mask' } elseif ($NegativeControls) { 'default-and-diagnostic-low-excitation' } elseif ($LowExcitation) { 'diagnostic-low-excitation' } else { 'default' }
    diagnosticGainDb = $DiagnosticGainDb
    gainScope = 'both inputs; in memory only; reject clipping'
    scenario = if ($NegativeControls) { '40s each; near-only, headphone-no-echo, low-noise-reference, silent-mic; both profiles' } elseif ($ComparePaths) { '40s each; changing, fixed-40ms, fixed-160ms; fresh processors per case' } else { '40s; near 10-20s; echo delay 40ms->160ms at 25s' }
    exitCode = $resultCode
    passed = $resultCode -eq 0
    output = @($output | ForEach-Object { $_.ToString() })
} | ConvertTo-Json -Depth 5 | Set-Content -Encoding utf8 (Join-Path $directory 'report.json')
$output | ForEach-Object { Write-Host $_ }
Write-Host "Report: $directory/report.json"
exit $resultCode
