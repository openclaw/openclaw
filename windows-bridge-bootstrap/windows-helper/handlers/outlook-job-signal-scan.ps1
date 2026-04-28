param(
    [Parameter(Mandatory = $true)]
    [string]$RequestPath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$request = Get-Content -LiteralPath $RequestPath -Raw | ConvertFrom-Json
$daysBack = 180
if ($request.PSObject.Properties.Name -contains 'daysBack' -and $request.daysBack) {
    $daysBack = [int]$request.daysBack
}

$keywords = @(
    'offer', 'job offer', 'opportunity', 'position', 'role', 'interview', 'recruiter', 'compensation', 'salary', 'contract',
    'iş teklifi', 'pozisyon', 'maaş', 'görüşme', 'ik'
)
if ($request.PSObject.Properties.Name -contains 'keywords' -and $request.keywords) {
    $keywords = @($request.keywords | ForEach-Object { [string]$_ })
}

$maxResults = 100
if ($request.PSObject.Properties.Name -contains 'maxResults' -and $request.maxResults) {
    $maxResults = [int]$request.maxResults
}

$cutoff = (Get-Date).AddDays(-$daysBack)
$outlook = New-Object -ComObject Outlook.Application
$namespace = $outlook.GetNamespace('MAPI')

$folderTargets = @(
    @{ Name = 'Inbox'; Folder = $namespace.GetDefaultFolder(6) },
    @{ Name = 'SentItems'; Folder = $namespace.GetDefaultFolder(5) }
)

$matches = New-Object System.Collections.Generic.List[object]
$totalScanned = 0

foreach ($target in $folderTargets) {
    $items = $target.Folder.Items
    $items.Sort('[ReceivedTime]', $true)

    foreach ($item in $items) {
        if ($matches.Count -ge $maxResults) { break }
        if (-not ($item -is [System.__ComObject])) { continue }

        try {
            $subject = '' + $item.Subject
            $body = '' + $item.Body
            $sender = '' + $item.SenderName
            $received = $item.ReceivedTime
        }
        catch {
            continue
        }

        if (-not $received) { continue }
        if ([datetime]$received -lt $cutoff) { break }

        $totalScanned++
        $haystack = (($subject + "`n" + $body + "`n" + $sender).ToLowerInvariant())
        $matchedKeywords = @()
        foreach ($keyword in $keywords) {
            if ($haystack.Contains($keyword.ToLowerInvariant())) {
                $matchedKeywords += $keyword
            }
        }

        if ($matchedKeywords.Count -gt 0) {
            $preview = $body
            if ($preview.Length -gt 400) {
                $preview = $preview.Substring(0, 400)
            }

            $matches.Add([ordered]@{
                folder = $target.Name
                subject = $subject
                sender = $sender
                receivedAt = ([datetime]$received).ToString('o')
                preview = $preview
                matchReasons = $matchedKeywords
            }) | Out-Null
        }
    }

    if ($matches.Count -ge $maxResults) { break }
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
