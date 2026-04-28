param(
    [Parameter(Mandatory = $true)]
    [string]$RequestPath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$request = Get-Content -LiteralPath $RequestPath -Raw | ConvertFrom-Json

Import-Module Microsoft.Graph.Authentication -ErrorAction Stop
$ctx = Get-MgContext
if (-not $ctx) {
    throw 'No Microsoft Graph context found. Run graph-auth-login first.'
}

$daysBack = 180
if ($request.PSObject.Properties.Name -contains 'daysBack' -and $request.daysBack) {
    $daysBack = [int]$request.daysBack
}
$maxResults = 100
if ($request.PSObject.Properties.Name -contains 'maxResults' -and $request.maxResults) {
    $maxResults = [int]$request.maxResults
}
$keywords = @(
    'offer', 'job offer', 'opportunity', 'position', 'role', 'interview', 'recruiter', 'compensation', 'salary', 'contract',
    'iş teklifi', 'pozisyon', 'maaş', 'görüşme', 'ik'
)
if ($request.PSObject.Properties.Name -contains 'keywords' -and $request.keywords) {
    $keywords = @($request.keywords | ForEach-Object { [string]$_ })
}

$cutoff = (Get-Date).ToUniversalTime().AddDays(-$daysBack).ToString('o')
$encodedFilter = [uri]::EscapeDataString("receivedDateTime ge $cutoff")
$encodedSelect = [uri]::EscapeDataString('id,subject,from,toRecipients,receivedDateTime,sentDateTime,bodyPreview,webLink,parentFolderId')
$base = "https://graph.microsoft.com/v1.0/me/messages?`$top=200&`$select=$encodedSelect&`$filter=$encodedFilter&`$orderby=receivedDateTime desc"

$response = Invoke-MgGraphRequest -Method GET -Uri $base
$items = @()
if ($response.value) {
    $items = @($response.value)
}

$matches = New-Object System.Collections.Generic.List[object]
$totalScanned = 0
foreach ($item in $items) {
    if ($matches.Count -ge $maxResults) { break }
    $totalScanned++
    $subject = '' + $item.subject
    $from = ''
    if ($item.from -and $item.from.emailAddress) {
        $from = ('' + $item.from.emailAddress.name + ' <' + $item.from.emailAddress.address + '>').Trim()
    }
    $preview = '' + $item.bodyPreview
    $haystack = (($subject + "`n" + $from + "`n" + $preview).ToLowerInvariant())
    $matchedKeywords = @()
    foreach ($keyword in $keywords) {
        if ($haystack.Contains($keyword.ToLowerInvariant())) {
            $matchedKeywords += $keyword
        }
    }
    if ($matchedKeywords.Count -gt 0) {
        $matches.Add([ordered]@{
            id = $item.id
            subject = $subject
            from = $from
            receivedAt = $item.receivedDateTime
            sentAt = $item.sentDateTime
            preview = $preview
            webLink = $item.webLink
            matchReasons = $matchedKeywords
        }) | Out-Null
    }
}

$result = [ordered]@{
    generatedAtUtc = [DateTime]::UtcNow.ToString('o')
    daysBack = $daysBack
    maxResults = $maxResults
    totalScanned = $totalScanned
    matchedCount = $matches.Count
    matches = @($matches)
}

if ($request.PSObject.Properties.Name -contains 'outputPath' -and $request.outputPath) {
    $outputPath = [string]$request.outputPath
    $dir = Split-Path -Parent $outputPath
    if ($dir -and -not (Test-Path -LiteralPath $dir)) {
        New-Item -ItemType Directory -Path $dir -Force | Out-Null
    }
    $result | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $outputPath -Encoding UTF8
}

return $result
