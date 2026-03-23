# Task: Organization Setup Wiring Completion

**Created:** 2026-03-23
**Status:** Open
**Priority:** High
**Area:** Frontend/Backend Integration

## Context

The Paperclip integration (three-tier agent organization) has been integrated into Operator1. Backend RPC methods are complete, but several frontend-to-backend connections are missing.

## ✅ Completed

| Component                        | Status | Notes                                                                                        |
| -------------------------------- | ------ | -------------------------------------------------------------------------------------------- |
| Agent step loads workspace path  | ✅     | Calls `agents.files.list` to get actual path                                                 |
| Agent step filters workers       | ✅     | Uses `getConfiguredChildren()` for configured agents only                                    |
| Workspaces RPC                   | ✅     | Full CRUD: `create/list/get/update/archive/agents/assignAgent/removeAgent/updateAgentStatus` |
| OrgAgentPanel status persistence | ✅     | Calls `workspaces.updateAgentStatus` RPC                                                     |
| Workspaces page                  | ✅     | `/workspaces` with create/edit dialog                                                        |
| Onboarding healthCheck           | ✅     | Checks gateway, AI provider, channels, onboarding                                            |

## ❌ Remaining Tasks

### 1. Onboarding Complete Should Create Default Workspace

**File:** `src/gateway/server-methods/onboarding.ts`
**Method:** `onboarding.complete`

**Fix:**

```ts
// In onboarding.complete handler, after markOnboardingComplete():
const existingWorkspaces = WorkspaceStore.listWorkspaces();
if (existingWorkspaces.length === 0) {
  WorkspaceStore.createWorkspace({ name: "Default" });
}
```

**Impact:** Users finish wizard with a functional workspace ready to use.

---

### 2. Department Toggles Should Persist

**File:** `ui-next/src/components/onboarding/step-agents.tsx`
**Functions:** `toggleDepartment`, `toggleAgent`

**Fix:**

- When department is toggled off, call `agents.marketplace.disable` for the department head
- When department is toggled on, call `agents.marketplace.enable` for the department head
- When individual agent is toggled, call `agents.marketplace.enable/disable`

**Impact:** User selections survive page refresh and affect actual agent availability.

---

### 3. WorkspaceSelector Should Have "Create Workspace" Option

**File:** `ui-next/src/components/agents/org-workspace-selector.tsx`

**Fix:**

- Add a "Create Workspace..." option at the bottom of the dropdown
- Open a simple dialog or navigate to `/workspaces` with create modal open
- Alternatively, inline mini-form

**Impact:** Users can create workspaces directly from the organization page without navigating away.

---

### 4. Default Workspace Bootstrap on Fresh Install

**File:** `src/orchestration/workspace-store-sqlite.ts` or gateway startup

**Fix:**

- Add `ensureDefaultWorkspace()` function that creates a "Default" workspace if none exist
- Call this during gateway startup or when `workspaces.list` returns empty

**Impact:** Fresh installs have a workspace ready immediately, even if user skips onboarding.

---

## Related Files

- `src/gateway/server-methods/onboarding.ts`
- `src/gateway/server-methods/workspaces.ts`
- `src/orchestration/workspace-store-sqlite.ts`
- `ui-next/src/components/onboarding/step-agents.tsx`
- `ui-next/src/components/onboarding/onboarding-wizard.tsx`
- `ui-next/src/components/agents/org-workspace-selector.tsx`
- `ui-next/src/pages/agents/organization.tsx`

## Acceptance Criteria

1. [ ] Completing onboarding wizard creates a "Default" workspace if none exist
2. [ ] Department toggles in wizard persist via RPC calls
3. [ ] WorkspaceSelector dropdown includes "Create Workspace" option
4. [ ] Fresh install has at least one workspace after first gateway start
5. [ ] E2E test: complete wizard → verify workspace exists → verify agents assigned
