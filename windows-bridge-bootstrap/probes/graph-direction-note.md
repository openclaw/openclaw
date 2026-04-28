# Microsoft Graph Direction Note

Recommended next lane for mailbox access:

- prefer Microsoft Graph over Outlook COM
- keep Phase 6 read-only
- start with delegated auth and `Mail.Read`
- implement `graph-auth-status` before login and mail scan handlers

Rationale:

- COM failed with class-not-registered in current execution context
- Graph is more portable and better aligned with mailbox-data access than local client automation
- existing queue bridge is already enough for Graph-oriented handlers
