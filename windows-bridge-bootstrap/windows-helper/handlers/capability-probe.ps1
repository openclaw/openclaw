param(
    [Parameter(Mandatory = $true)]
    [string]$RequestPath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$request = Get-Content -LiteralPath $RequestPath -Raw | ConvertFrom-Json
if (-not $request.outputPath) {
    throw 'capability-probe request must include outputPath'
}

$bootstrapRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$scriptPath = Join-Path $bootstrapRoot 'scripts/win-capability-probe.ps1'

& $scriptPath -OutputPath ([string]$request.outputPath)

return [ordered]@{
    outputPath = [string]$request.outputPath
    scriptPath = $scriptPath
}
