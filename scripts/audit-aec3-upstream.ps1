param([switch]$Offline)
$ErrorActionPreference = 'Stop'
$revision = 'f7126d621eb47305291a912939d064f9cacdc4fa'
$root = Split-Path $PSScriptRoot -Parent
$extractionRevision = '2cec2f52e26646f93bd2d5498bbabf59cba18da9'
$actualRevision = git -C (Join-Path $root '.local/aec3-source') rev-parse HEAD
if ($LASTEXITCODE -ne 0 -or $actualRevision -ne $extractionRevision) {
    throw 'Extraction checkout does not match the audited revision.'
}
$destination = Join-Path $root ".local/upstream-audit/$revision"
$files = @('suppression_gain.cc', 'residual_echo_estimator.cc', 'dominant_nearend_detector.cc', 'erle_estimator.cc', 'subband_erle_estimator.cc', 'signal_dependent_erle_estimator.cc', 'fullband_erle_estimator.cc', 'echo_canceller3_config.h')
New-Item -ItemType Directory -Force -Path $destination | Out-Null
$results = foreach ($name in $files) {
    $isConfig = $name -eq 'echo_canceller3_config.h'
    $upstream = if ($isConfig) { "api/audio/$name" } else { "modules/audio_processing/aec3/$name" }
    $localRelative = if ($isConfig) { "src/api/$name" } else { "src/audio_processing/aec3/$name" }
    $local = Join-Path $root ".local/aec3-source/$localRelative"
    $cached = Join-Path $destination $name
    if (-not $Offline) {
        $response = Invoke-WebRequest -Uri "https://webrtc.googlesource.com/src/+/$revision/$upstream`?format=TEXT" -TimeoutSec 60
        [IO.File]::WriteAllBytes($cached, [Convert]::FromBase64String([string]$response.Content))
    }
    # Screening only: remove include lines and whitespace, retaining all other text.
    # A match is not a proof of whole-library or runtime equivalence.
    $original = [IO.File]::ReadAllText($local)
    $official = [IO.File]::ReadAllText($cached)
    $normalize = { param($value) (($value -replace '(?m)^\s*#include[^\r\n]*', '') -replace '\s+', '') }
    [pscustomobject]@{
        file = $name
        upstreamPath = $upstream
        localSha256 = (Get-FileHash $local -Algorithm SHA256).Hash
        upstreamSha256 = (Get-FileHash $cached -Algorithm SHA256).Hash
        exactMatch = $original -ceq $official
        includeWhitespaceNormalizedMatch = (& $normalize $original) -ceq (& $normalize $official)
    }
}
$report = [pscustomobject]@{ revision = $revision; extractionRevision = $extractionRevision; method = 'Include-line and whitespace screening; not semantic equivalence'; files = @($results) }
$report | ConvertTo-Json -Depth 5 | Set-Content -Encoding utf8 (Join-Path $destination 'report.json')
$results | Format-Table file, exactMatch, includeWhitespaceNormalizedMatch
