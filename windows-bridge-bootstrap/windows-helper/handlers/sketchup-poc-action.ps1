param(
    [Parameter(Mandatory = $true)]
    [string]$RequestPath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$workspaceRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..\..'))
$handlerPath = Join-Path $workspaceRoot 'sketchup-poc\windows\bridge\handle-sketchup-bridge-request.ps1'

if (-not (Test-Path -LiteralPath $handlerPath)) {
    throw "SketchUp bridge handler not found: $handlerPath"
}

return & $handlerPath -RequestPath $RequestPath
