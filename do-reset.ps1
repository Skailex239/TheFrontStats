Set-Location "c:\Users\rapto\Desktop\openfront-speedrun_1\openfront-speedrun"
Write-Host "Step 1: Abort rebase..."
git rebase --abort 2>$null
Write-Host "Step 2: Reset checkpoint..."
'{"reset":true}' | Out-File checkpoint.json -Encoding utf8
Write-Host "Step 3: Reset seen..."
'[]' | Out-File seen.json -Encoding utf8
Write-Host "Step 4: Git add..."
git add checkpoint.json seen.json
Write-Host "Step 5: Commit..."
git commit -m "RESET: Clear checkpoint and seen" 2>&1
Write-Host "Step 6: Push..."
git push origin main --force 2>&1
Write-Host "Done!"
