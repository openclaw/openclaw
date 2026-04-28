param(
    [Parameter(Mandatory = $true)]
    [string]$RequestPath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$request = Get-Content -LiteralPath $RequestPath -Raw | ConvertFrom-Json
$scopes = @('Mail.Read','offline_access','User.Read')
if ($request.PSObject.Properties.Name -contains 'scopes' -and $request.scopes) {
    $scopes = @($request.scopes | ForEach-Object { [string]$_ })
}

Import-Module Microsoft.Graph.Authentication -ErrorAction Stop
Connect-MgGraph -Scopes $scopes -UseDeviceCode -ContextScope CurrentUser -NoWelcome
$ctx = Get-MgContext

$bridgeRoot = Join-Path $env:LOCALAPPDATA 'OpenClaw\WindowsBridge\graph'
if (-not (Test-Path -LiteralPath $bridgeRoot)) {
    New-Item -ItemType Directory -Path $bridgeRoot -Force | Out-Null
}
$statusPath = Join-Path $bridgeRoot 'auth-status.json'
$status = [ordered]@{
    generatedAtUtc = [DateTime]::UtcNow.ToString('o')
    scopes = @($ctx.Scopes)
    account = $ctx.Account
    tenantId = $ctx.TenantId
    authType = $ctx.AuthType
    environment = $ctx.Environment
}
$status | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $statusPath -Encoding UTF8

if ($request.PSObject.Properties.Name -contains 'outputPath' -and $request.outputPath) {
    $outputPath = [string]$request.outputPath
    $dir = Split-Path -Parent $outputPath
    if ($dir -and -not (Test-Path -LiteralPath $dir)) {
        New-Item -ItemType Directory -Path $dir -Force | Out-Null
    }
    $status | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $outputPath -Encoding UTF8
}

return $status
