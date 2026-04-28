# Minimal Phase 1 Windows-side capability probe.
# Intended entrypoint:
#   pwsh.exe -NoProfile -File .\win-capability-probe.ps1 -OutputPath <path>

param(
    [string]$OutputPath = "$env:USERPROFILE\Desktop\windows-bridge-capability-probe.json"
)

$result = [ordered]@{
    generatedAtUtc = [DateTime]::UtcNow.ToString("o")
    computerName   = $env:COMPUTERNAME
    userProfile    = $env:USERPROFILE
    pwshVersion    = $PSVersionTable.PSVersion.ToString()
    dotnetOk       = $false
    dotnetVersion  = $null
    browserHint    = "Do not auto-launch here. Use the safe browser note in probes/safe-test-notes.md."
}

try {
    $dotnetVersion = & dotnet --version 2>$null
    if ($LASTEXITCODE -eq 0 -and $dotnetVersion) {
        $result.dotnetOk = $true
        $result.dotnetVersion = $dotnetVersion.Trim()
    }
}
catch {
}

$directory = Split-Path -Parent $OutputPath
if ($directory -and -not (Test-Path -LiteralPath $directory)) {
    New-Item -ItemType Directory -Path $directory -Force | Out-Null
}

$result | ConvertTo-Json -Depth 3 | Set-Content -LiteralPath $OutputPath -Encoding UTF8
Write-Output "Wrote capability probe to: $OutputPath"
