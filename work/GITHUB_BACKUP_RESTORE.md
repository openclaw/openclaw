# GitHub Backup Restore

The canonical backup repository is `openclaw-systems/openclaw-backup`.

## Check Current Backup

```bash
git -C /Users/openclaw/.openclaw-backup-workspace log -1 --format='%H %ad %s' --date=iso-local
cat /Users/openclaw/.openclaw-backup-logs/last-success.json
```

Successful backup evidence is valid when `status` is `success` and
`backup_workspace_head` matches the backup workspace or remote `main` commit.

## Restore Latest Snapshot

```bash
git clone git@github.com-openclaw-backup:openclaw-systems/openclaw-backup.git /tmp/openclaw-restore
cd /tmp/openclaw-restore
pnpm install --frozen-lockfile
```

Inspect the restored tree first. Do not overwrite a live OpenClaw workspace until
the desired snapshot has been verified.

## Restore A Specific Snapshot

Use one of the backup snapshot SHAs or monthly tags:

```bash
git clone git@github.com-openclaw-backup:openclaw-systems/openclaw-backup.git /tmp/openclaw-restore
cd /tmp/openclaw-restore
git checkout <backup-sha-or-tag>
pnpm install --frozen-lockfile
```

Monthly retention anchors use tags like `backup-2026-05`.

## Verify Restore Drill

```bash
/Users/openclaw/OpenClaw/work/scripts/backup-restore-drill.sh
```

The drill clones remote `main`, checks that restore-critical files are present,
checks that `.github/workflows` is absent from the backup repo, installs
dependencies, and prints `RESTORE_DRILL_OK <timestamp> <sha>` on success.
