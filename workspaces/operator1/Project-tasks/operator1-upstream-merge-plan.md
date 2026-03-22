# Operator1 Upstream Merge Plan

**Date:** 2026-03-15
**Status:** Planning
**Branch:** main

---

## Current State

| Metric                         | Value |
| ------------------------------ | ----- |
| Commits behind upstream        | 1,283 |
| Local commits ahead            | 150   |
| Uncommitted files              | 5     |
| Files with potential conflicts | 3,703 |

---

## Uncommitted Changes (Commit First!)

```
Project-tasks/agent-personas-marketplace.md  |  73 +++++++--
Project-tasks/operator1hub.md                | 236 +++++++++++++++++++--------
src/agents/system-prompt.ts                  |   2 +
ui-next/src/components/chat/chat-header.tsx  |  42 ++++-
ui-next/src/components/chat/plan-card.tsx    |  21 ++-
```

**Action:** Commit these before merge.

---

## High-Risk Conflict Areas

| Category           | Files     | Risk Level  |
| ------------------ | --------- | ----------- |
| `src/infra/`       | 252 files | 🔴 Critical |
| `src/agents/`      | 170 files | 🔴 Critical |
| `src/gateway/`     | 108 files | 🔴 Critical |
| `src/commands/`    | 96 files  | 🟡 High     |
| `src/config/`      | 80 files  | 🟡 High     |
| `ui/src/ui/views/` | 33 files  | 🟡 High     |
| `extensions/acpx/` | 18 files  | 🟢 Medium   |

---

## Local-Only Customizations (Must Preserve)

### Extensions (Custom)

- `extensions/acpx/` - ACP harness (full custom)
- `extensions/bluebubbles/` - iMessage via BlueBubbles
- `extensions/copilot-proxy/` - Copilot proxy
- `extensions/diagnostics-otel/` - OpenTelemetry diagnostics
- `extensions/diffs/` - Diff tools

### Skills (Local)

- All `skills/` folder - local skill customizations

### Config

- `openclaw.json` - local configuration
- Root `package.json` - local dependencies

### `.agent/` Directory

- Full multi-agent system (UI/UX, architects, specialists)
- 50+ agent definition files

---

## Merge Strategies

### Option A: Rebase onto Upstream (Clean History)

```bash
# 1. Commit current work
git add -A && git commit -m "WIP: local changes before upstream merge"

# 2. Fetch latest
git fetch upstream

# 3. Rebase (expect many conflicts)
git rebase upstream/main

# 4. Resolve conflicts iteratively
# git status → resolve → git add → git rebase --continue
```

**Pros:** Clean linear history
**Cons:** 150 rebased commits, each may conflict

### Option B: Merge Upstream (Preserves History)

```bash
# 1. Commit current work
git add -A && git commit -m "WIP: local changes before upstream merge"

# 2. Fetch and merge
git fetch upstream
git merge upstream/main

# 3. Resolve all conflicts in one pass
# Then commit merge
```

**Pros:** Single conflict resolution session, preserves branch history
**Cons:** Merge commit in history

### Option C: Branch Swap (Nuclear - Recommended for Major Divergence)

```bash
# 1. Save current state
git branch save-operator1-$(date +%Y%m%d)
git stash push -m "uncommitted-changes-$(date +%Y%m%d)"

# 2. Reset to upstream
git fetch upstream
git reset --hard upstream/main

# 3. Cherry-pick essential local commits
# Identify key commits:
git log save-operator1-$(date +%Y%m%d) --oneline | head -50

# 4. Selectively restore:
# - Custom extensions (extensions/acpx, bluebubbles, etc.)
# - Skills folder
# - Config changes
# - .agent/ directory
```

**Pros:** Cleanest result, no inherited conflicts
**Cons:** Loses git history, must manually restore changes

---

## Recommended Approach: Option C (Branch Swap)

Given:

- 1,283 upstream commits
- 3,703 potentially conflicting files
- Heavy customization in extensions, skills, .agent/

**The nuclear option is safest.** Rebase/merge would create thousands of conflicts.

---

## Execution Checklist

### Phase 1: Preparation

- [ ] Commit all uncommitted changes
- [ ] Push current branch to backup remote (if available)
- [ ] Create backup branch: `git branch backup-operator1-20260315`
- [ ] Document current custom extensions list
- [ ] Document current skill files

### Phase 2: Reset

- [ ] `git fetch upstream`
- [ ] `git reset --hard upstream/main`
- [ ] Verify clean state: `git status`

### Phase 3: Restore Customizations

- [ ] Cherry-pick or copy `extensions/acpx/`
- [ ] Cherry-pick or copy `extensions/bluebubbles/`
- [ ] Cherry-pick or copy `extensions/copilot-proxy/`
- [ ] Cherry-pick or copy `extensions/diagnostics-otel/`
- [ ] Cherry-pick or copy `extensions/diffs/`
- [ ] Restore `skills/` folder from backup
- [ ] Restore `.agent/` folder from backup
- [ ] Restore/merge `openclaw.json` config
- [ ] Restore/merge root `package.json`

### Phase 4: Verification

- [ ] `pnpm install` succeeds
- [ ] `pnpm build` succeeds
- [ ] `pnpm test` passes (or acceptable failures)
- [ ] OpenClaw starts: `openclaw gateway start`
- [ ] Basic smoke test (send message, verify response)

### Phase 5: Cleanup

- [ ] Delete backup branch after verification
- [ ] Update this document with completion notes

---

## Key Commits to Identify

Run after reset to find specific features to restore:

```bash
git log backup-operator1-20260315 --oneline -- extensions/acpx/
git log backup-operator1-20260315 --oneline -- skills/
```

---

## Rollback Plan

If merge goes wrong:

```bash
git reset --hard backup-operator1-20260315
```

---

## Notes

- Upstream has significant new features: Android dark theme, configurable compaction timeout, health monitor improvements
- Many bug fixes: WhatsApp recency filter, OpenRouter image handling, context warmup
- `.agent/` folder is entirely custom - safe to restore wholesale
- `extensions/` has many custom additions - selective restore needed

---

_Generated: 2026-03-15_
_Last updated: 2026-03-15_
