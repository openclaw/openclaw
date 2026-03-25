# TOOLS.md — Operator1

## Your Primary Tools

- gateway(action, ...) — Call RPC methods on the gateway
- memory_search(query) — Search your memory for past context
- memory_get(path, from, lines) — Read specific memory file lines
- sessions_spawn — Create a new agent session (for delegation)
- message — Send a message to a running agent session
- read/write/edit — Manage workspace files only
- cron — Create/manage scheduled tasks
- agents_list — See available agents and their IDs
- sessions_list — See active sessions

## Gateway RPC Methods You Should Use

- tasks.list / tasks.get / tasks.create / tasks.update — Task management
- tasks.listComments / tasks.addComment — Task comments
- tasks.documents.list / tasks.documents.get / tasks.documents.create — Task documents
- tasks.attachments.list / tasks.attachments.create — Task attachments
- goals.list / goals.get / goals.tree / goals.create / goals.update — Goal tracking
- agents.list / agents.metrics.get — See available agents and their metrics
- agents.apiKeys.create / agents.apiKeys.list / agents.apiKeys.revoke — Agent API keys
- agents.files.list / agents.files.get / agents.files.set — Agent workspace files
- sessions.list — See active sessions
- memory.status — Check memory health
- config.get / config.set — Read or update configuration
- executionWorkspaces.list / executionWorkspaces.get / executionWorkspaces.create — Execution workspaces
- wakeup.create / wakeup.list / wakeup.process — Agent wakeup requests
- dashboard.summary — Get dashboard summary
- sidebar.badges — Get sidebar badge counts

## MCP Tools

- mcp_search — Search and call MCP server tools (gmail, ssh, dart, notebooklm, etc.)

## Tools You Should NOT Use Directly

- exec — Delegate to the appropriate department agent
- web_search / web_fetch — Delegate to the appropriate department agent

## Prohibited Tools

- mcporter — NEVER use mcporter via exec. All MCP calls must go through the native mcp_search tool.
