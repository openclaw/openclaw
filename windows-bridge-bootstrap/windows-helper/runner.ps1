param(
    [string]$QueueRoot = (Join-Path $PSScriptRoot "../queue"),
    [switch]$RunOnce,
    [int]$PollIntervalSeconds = 2
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function New-DirIfMissing {
    param([string]$Path)
    if (-not (Test-Path -LiteralPath $Path)) {
        New-Item -ItemType Directory -Path $Path -Force | Out-Null
    }
}

function Write-JsonFile {
    param(
        [string]$Path,
        [object]$Data
    )

    $json = $Data | ConvertTo-Json -Depth 10
    $dir = Split-Path -Parent $Path
    if ($dir) {
        New-DirIfMissing -Path $dir
    }
    Set-Content -LiteralPath $Path -Value $json -Encoding UTF8
}

function Get-HandlerPath {
    param(
        [string]$HandlersRoot,
        [string]$Kind
    )

    switch ($Kind) {
        'capability-probe' { return (Join-Path $HandlersRoot 'capability-probe.ps1') }
        'dotnet-info' { return (Join-Path $HandlersRoot 'dotnet-info.ps1') }
        'outlook-job-signal-scan' { return (Join-Path $HandlersRoot 'outlook-job-signal-scan.ps1') }
        'graph-auth-status' { return (Join-Path $HandlersRoot 'graph-auth-status.ps1') }
        'graph-auth-login' { return (Join-Path $HandlersRoot 'graph-auth-login.ps1') }
        'graph-mail-job-signal-scan' { return (Join-Path $HandlersRoot 'graph-mail-job-signal-scan.ps1') }
        'sketchup-poc-action' { return (Join-Path $HandlersRoot 'sketchup-poc-action.ps1') }
        default { throw "Unsupported request kind: $Kind" }
    }
}

function Invoke-Request {
    param(
        [string]$RequestPath,
        [string]$HandlersRoot,
        [string]$OutboundDir,
        [string]$ArchiveDir
    )

    $raw = Get-Content -LiteralPath $RequestPath -Raw
    $request = $raw | ConvertFrom-Json

    if (-not $request.requestId) {
        throw "Request file is missing requestId: $RequestPath"
    }
    if (-not $request.kind) {
        throw "Request file is missing kind: $RequestPath"
    }

    $requestId = [string]$request.requestId
    $handlerPath = Get-HandlerPath -HandlersRoot $HandlersRoot -Kind ([string]$request.kind)

    $result = [ordered]@{
        requestId = $requestId
        kind = [string]$request.kind
        status = 'succeeded'
        startedAtUtc = [DateTime]::UtcNow.ToString('o')
        finishedAtUtc = $null
        host = $env:COMPUTERNAME
        output = $null
        error = $null
    }

    try {
        $handlerOutput = & $handlerPath -RequestPath $RequestPath
        $result.output = $handlerOutput
    }
    catch {
        $result.status = 'failed'
        $result.error = [ordered]@{
            message = $_.Exception.Message
            type = $_.Exception.GetType().FullName
        }
    }
    finally {
        $result.finishedAtUtc = [DateTime]::UtcNow.ToString('o')
    }

    $outPath = Join-Path $OutboundDir ($requestId + '.result.json')
    Write-JsonFile -Path $outPath -Data $result

    $archiveName = ('{0}-{1}' -f $requestId, (Split-Path -Leaf $RequestPath))
    $archivePath = Join-Path $ArchiveDir $archiveName
    Move-Item -LiteralPath $RequestPath -Destination $archivePath -Force
}

if ([System.IO.Path]::IsPathRooted($QueueRoot)) {
    $resolvedQueueRoot = [System.IO.Path]::GetFullPath($QueueRoot)
}
else {
    $resolvedQueueRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot $QueueRoot))
}
$inboundDir = Join-Path $resolvedQueueRoot 'inbound'
$outboundDir = Join-Path $resolvedQueueRoot 'outbound'
$archiveDir = Join-Path $resolvedQueueRoot 'archive'
$handlersRoot = Join-Path $PSScriptRoot 'handlers'

New-DirIfMissing -Path $inboundDir
New-DirIfMissing -Path $outboundDir
New-DirIfMissing -Path $archiveDir

function Process-PendingRequests {
    $files = @(Get-ChildItem -LiteralPath $inboundDir -Filter '*.json' -File | Sort-Object Name)
    foreach ($file in $files) {
        Invoke-Request -RequestPath $file.FullName -HandlersRoot $handlersRoot -OutboundDir $outboundDir -ArchiveDir $archiveDir
    }
    return $files.Count
}

if ($RunOnce) {
    Process-PendingRequests | Out-Null
    return
}

while ($true) {
    $count = Process-PendingRequests
    if ($count -eq 0) {
        Start-Sleep -Seconds $PollIntervalSeconds
    }
}
