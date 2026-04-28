param(
    [Parameter(Mandatory = $true)]
    [string]$RequestPath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$request = Get-Content -LiteralPath $RequestPath -Raw | ConvertFrom-Json
$dotnetVersion = (& dotnet --version).Trim()

$outputPath = $null
if ($request.PSObject.Properties.Name -contains 'outputPath' -and $request.outputPath) {
    $outputPath = [string]$request.outputPath
    $payload = [ordered]@{
        generatedAtUtc = [DateTime]::UtcNow.ToString('o')
        host = $env:COMPUTERNAME
        dotnetVersion = $dotnetVersion
    }
    $json = $payload | ConvertTo-Json -Depth 5
    $dir = Split-Path -Parent $outputPath
    if ($dir -and -not (Test-Path -LiteralPath $dir)) {
        New-Item -ItemType Directory -Path $dir -Force | Out-Null
    }
    Set-Content -LiteralPath $outputPath -Value $json -Encoding UTF8
}

return [ordered]@{
    dotnetVersion = $dotnetVersion
    outputPath = $outputPath
}
