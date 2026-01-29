# HEARTBEAT.md - Proactive Checks

Read `memory/heartbeat-state.json` for last check times.
Rotate through these checks — don't do all at once.

## Checks (if >4h since last)

- [ ] **Email:** Check for urgent unread messages
- [ ] **Calendar:** Upcoming events in next 24-48h
- [ ] **Weather:** Check weather if relevant

## Weekly Checks (if >7d since last)

- [ ] **Memory Consolidation:** Review recent `memory/YYYY-MM-DD.md` files
  - Extract significant lessons → update `MEMORY.md`

## Self-Maintenance

- [ ] **Disk Space:** Alert if < 10GB free
- [ ] **Memory Files Size:** Alert if > 500KB total

## Rules

- **Quiet hours:** 11 PM - 7 AM (no alerts unless critical)
- Update `memory/heartbeat-state.json` after each check
- Only alert if something actionable found
- Reply `HEARTBEAT_OK` if nothing needs attention
- Do 1-2 checks per heartbeat, rotate through them
