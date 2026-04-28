param(
    [Parameter(Mandatory = $true)]
    [string]$RequestPath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$request = Get-Content -LiteralPath $RequestPath -Raw | ConvertFrom-Json

$bridgeRoot = Join-Path $env:LOCALAPPDATA 'OpenClaw\WindowsBridge\graph'
$cacheDir = Join-Path $bridgeRoot 'cache'
$statusPath = Join-Path $bridgeRoot 'auth-status.json'

$module = Get-Module -ListAvailable Microsoft.Graph.Authentication | Sort-Object Version -Descending | Select-Object -First 1
$mgc = Get-Command Get-MgContext -ErrorAction SilentlyContinue

$contextSummary = $null
if ($mgc) {
    try {
        $ctx = Get-MgContext
        if ($ctx) {
            $contextSummary = [ordered]@{
                clientId = $ctx.ClientId
                tenantId = $ctx.TenantId
                account = $ctx.Account
                scopes = @($ctx.Scopes)
                authType = $ctx.AuthType
                environment = $ctx.Environment
            }
        }
    }
    catch {
    }
}

$status = [ordered]@{
    generatedAtUtc = [DateTime]::UtcNow.ToString('o')
    bridgeRoot = $bridgeRoot
    cacheDirExists = (Test-Path -LiteralPath $cacheDir)
    statusFileExists = (Test-Path -LiteralPath $statusPath)
    graphModuleInstalled = [bool]$module
    graphModuleVersion = if ($module) { [string]$module.Version } else { $null }
    getMgContextAvailable = [bool]$mgc
    currentContext = $contextSummary
    recommendedScopes = @('Mail.Read', 'offline_access', 'User.Read')
}

if ($request.PSObject.Properties.Name -contains 'outputPath' -and $request.outputPath) {
    $outputPath = [string]$request.outputPath
    $dir = Split-Path -Parent $outputPath
    if ($dir -and -not (Test-Path -LiteralPath $dir)) {
        New-Item -ItemType Directory -Path $dir -Force | Out-Null
    }
    $status | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $outputPath -Encoding UTF8
}

return $status
