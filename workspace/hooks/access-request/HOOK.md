---
name: access-request
description: "Silent access request system. Detects a secret phrase from unknown senders and notifies the operator for manual approval."
metadata: { "openclaw": { "emoji": "🔑", "events": ["message:pre-auth"] } }
---

# Access Request Hook

Monitors messages from unauthorized senders.
If the message matches the configured access phrase, silently notifies the operator with the sender's ID, name, and channel, along with the exact commands needed to approve or remove the sender.

Workspace hooks execute local code inside the Gateway process. Enable this example explicitly with `openclaw hooks enable access-request` after reviewing and configuring `handler.ts`.
Automatic loading for `dmPolicy: "allowlist"` applies only to trusted bundled or managed hooks. This workspace example always requires explicit opt-in.

This hook also requires an installed WhatsApp or Telegram plugin build that
supports `message:pre-auth`, introduced by this patch. Older plugin builds
downloaded from ClawHub or npm without this support will not trigger the hook,
even when it appears registered and enabled.

The hook sends its operator notification with the `message` tool. Configure a
tool policy that exposes this tool; the recommended messaging-only profile is:

```bash
openclaw config set tools.profile messaging
```

Without an applicable tool policy, the hook still fires but notification
delivery fails with `Tool not available: message`.

To approve or remove senders with the `/allowlist add dm` and
`/allowlist remove dm` commands included in the notification, enable config
edits from chat:

```bash
openclaw config set commands.config true
```

Without this setting, OpenClaw replies with
`/allowlist edits are disabled`. These edits also honor the target channel's
`configWrites` policy.

Set `OPENCLAW_GATEWAY_TOKEN`, `OPENCLAW_ACCESS_REQUEST_OPERATOR_TARGET`, and
`OPENCLAW_ACCESS_REQUEST_PHRASE` in the Gateway environment. Optionally set
`OPENCLAW_ACCESS_REQUEST_OPERATOR_CHANNEL` (default: `whatsapp`). Keep secrets
out of this workspace directory.

For Docker Compose deployments, recreate the container after changing any of
these environment variables:

```bash
docker compose down && docker compose up -d
```

`docker compose restart` does not reload values from `.env`, so the container
continues using its previous environment.

For WhatsApp, `OPENCLAW_ACCESS_REQUEST_OPERATOR_TARGET` must include the leading
`+` prefix (for example, `+15550001234`). Also verify that
`channels.whatsapp.allowFrom` contains the operator number with the `+` prefix,
because onboarding may omit it.

WhatsApp phone normalization can also vary by country. In Brazil, for example,
a locally written mobile number may include an extra `9`, while WhatsApp may
expose the same account without it: `+55<area-code>9<subscriber-number>` versus
`+55<area-code><subscriber-number>`. If the bot does not reply to the operator,
make `OPENCLAW_ACCESS_REQUEST_OPERATOR_TARGET` and `channels.whatsapp.allowFrom`
exactly match the identity reported by WhatsApp. Check the Gateway logs for a
line such as `Blocked unauthorized sender +55...` and use that reported value.
