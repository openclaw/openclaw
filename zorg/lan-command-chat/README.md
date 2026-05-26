# Zorg LAN Console

Next.js LAN/local command chat console for OpenClaw/Zorg MemoryDB deployments.

The console provides a local browser chat surface that talks to the OpenClaw Gateway, stores conversation traffic in PostgreSQL-backed memory, and keeps communication available if an external channel such as Telegram is unavailable. Zorg is responsible for maintaining this channel as base communication infrastructure, not as an optional side app.

## Local operating contract on this host

- Primary local service: `lan-chat.service` on port `3001`.
- LAN front door: `lan-chat-nginx` on port `80`, proxying to the 3001 service.
- Port `3000` is retired for this host and should not be treated as the live console.
- A user-level `lan-chat-health.timer` checks the 3001 service and LAN front door every minute and safely restarts the affected service if either path fails.
- This channel must remain available for Stefan and authorized local AI-agent coordination, including La DJ Beta / DJ Beta back-channel handoffs.

## Features

- Local web chat UI
- Gateway-backed `chat.send` / history access
- PostgreSQL memory ingestion for LAN chat messages
- Runtime and database status display
- Runtime token/thinking telemetry follows the freshest relevant OpenClaw command session. The status and activity endpoints inspect a broad sessions.list window and prefer the active/recent LAN chat, main, Telegram direct, or webchat session instead of pinning telemetry to a stale configured session.
- Optional file upload support
- Nginx front-end for simple LAN access
- Built-in fallback command chat for operator and authorized local agent coordination

## Configuration

Copy the example environment file if running outside the bundled service setup:

```bash
cp .env.local.example .env.local
```

Useful environment variables:

- `GATEWAY_SESSION_KEY` — OpenClaw session key to expose
- `CHAT_SOURCE_LABEL` — label shown in injected metadata
- `CHAT_HISTORY_LIMIT` — message count to return
- `GATEWAY_CALL_TIMEOUT_MS` — gateway request timeout
- `GATEWAY_HOST` — gateway host

## Privacy boundary

Do not commit `.env.local`, live OpenClaw state, credentials, uploaded files, build output, or node dependencies. This directory is intended to contain source and install structure only.

## Login password reset procedure

The default landing page is a password login gate for the LAN command chat. To rotate access, generate a new strong random password, update `LAN_CHAT_PASSWORD_HASH` with a salted PBKDF2-SHA256 hash, update/keep `LAN_CHAT_AUTH_SECRET` for signed login cookies, rebuild/restart `lan-chat`, then send the new plaintext password to the operator at the approved email address. If email is unavailable, use the backup secure-channel procedure: direct the operator/user to open the OpenClaw TUI on the LAN and provide the password there, keeping the password on an internal LAN channel. Do not commit plaintext passwords.

## Browser alerts and speech unlock

The command chat can request browser notification permission and unlock audio playback from a user click via the **Enable alerts + speech** button. This follows browser autoplay/notification policy: notification permission and audio playback must be initiated from a user gesture, and secure contexts are required for the browser prompt. When enabled, new assistant replies may trigger a browser notification and play speech through `/api/tts`; if a browser/API blocks either path, the UI reports the degraded state instead of pretending it is active.

Visual verification for UI changes must include desktop light mode, desktop dark mode, and mobile viewport screenshots, and screenshots must be sent to Stefan rather than only saved locally.

## Telemetry verification

The live UI reads:

- /api/chat/status for model, thinking level, token counters, and current session identity.
- /api/chat/activity for the current thinking/tool/result/reply activity feed.

After OpenClaw or LAN chat upgrades, verify both endpoints against the browser UI. Token counters should show non-zero input/output or total usage for the freshest active command session, and activity should follow the same session rather than old LAN-chat history. If either endpoint falls back to stale data, check the session-selection logic before changing routing, login, or nginx.
