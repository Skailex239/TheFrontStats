---
description: Reset complet de la sync OpenRuns avec backup
---

1. Créer une backup des fichiers actuels
```bash
Copy-Item "runs.json" "runs_backup_before_reset.json"
Copy-Item "runs_backup.json" "runs_backup_full_before_reset.json"
Copy-Item "seen.json" "seen_backup_before_reset.json"
Copy-Item "checkpoint.json" "checkpoint_backup_before_reset.json"
```

2. Reset complet des fichiers de sync
```bash
Remove-Item "runs.json" -Force
Remove-Item "runs_backup.json" -Force
Remove-Item "seen.json" -Force
Remove-Item "checkpoint.json" -Force
echo '{"runs": [], "totalCount": 0, "lastUpdate": null}' > runs.json
echo '[]' > seen.json
echo '{}' > checkpoint.json
```

3. Lancer la sync historique avec 500 fenêtres et exemption
```bash
node sync.js history 500
```
