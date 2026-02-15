# OpenClaw Update Script
# Fetches latest from main, rebases custom branch on top, rebuilds

Write-Host "⚡ Fetching latest..." -ForegroundColor Cyan
git fetch upstream

Write-Host "⚡ Rebasing on upstream/main..." -ForegroundColor Cyan
git rebase upstream/main

if ($LASTEXITCODE -ne 0) {
    Write-Host "❌ Rebase conflict! Resolve manually, then run:" -ForegroundColor Red
    Write-Host "   git rebase --continue" -ForegroundColor Yellow
    Write-Host "   pnpm install; pnpm build" -ForegroundColor Yellow
    exit 1
}

Write-Host "⚡ Installing dependencies..." -ForegroundColor Cyan
pnpm install

Write-Host "⚡ Building..." -ForegroundColor Cyan
pnpm build

Write-Host "✅ Updated! Restart gateway to apply." -ForegroundColor Green
Write-Host "   openclaw gateway restart" -ForegroundColor Yellow
