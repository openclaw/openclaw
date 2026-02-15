---
name: tally
description: "Automate Tally Prime (accounting software) via XML API and GUI keyboard automation. Use for: querying ledgers/stock items/vouchers, creating vouchers (sales, purchase, journal, manufacturing journal, stock journal), managing masters (ledgers, stock items, groups), exporting reports (trial balance, P&L, balance sheet, day book, stock summary), Bill of Materials (BOM), company settings (F11 features), and any Tally operation. Supports both headless XML API (fast, reliable) and GUI keyboard automation (for dialogs, period changes, visual verification). Use when the user mentions Tally, accounting entries, vouchers, ledgers, stock items, manufacturing journals, or any Tally Prime operation."
---

# Tally Prime Automation

## Architecture

Two layers — **always try API first**, fall back to GUI only when needed:

1. **XML API** (`localhost:9000`) — Fast, reliable. Handles queries, exports, voucher/master creation.
2. **GUI Automation** — Keyboard-driven via `PostMessageW` + `WM_CHAR`. **Works from background processes without focus.**

All GUI automation works from background (no window focus needed). Uses `PostMessageW` internally.

## How to Use

Write a JSON file with the `Write` tool, then run:

```
python scripts/tally.py --file request.json
```

### Quick Examples

**List companies:**
```json
{"action": "list_companies"}
```

**List stock items:**
```json
{"action": "list_stock_items", "company": "PAVISHA POLYMERS"}
```

**Create a journal voucher:**
```json
{
  "action": "create_voucher",
  "company": "PAVISHA POLYMERS",
  "voucher_type": "Journal",
  "date": "20260215",
  "narration": "Test",
  "entries": [
    {"tag": "ALLLEDGERENTRIES.LIST", "LEDGERNAME": "Cash", "ISDEEMEDPOSITIVE": "Yes", "AMOUNT": "-100"},
    {"tag": "ALLLEDGERENTRIES.LIST", "LEDGERNAME": "Profit & Loss A/c", "ISDEEMEDPOSITIVE": "No", "AMOUNT": "100"}
  ]
}
```

**GUI: Screenshot current state:**
```json
{"action": "gui_screenshot", "filename": "tally_now.png"}
```

**GUI: Send keystrokes:**
```json
{"action": "gui_keys", "keys": "ESC*5 wait:300 F2 wait:300 type:15-02-2026 ENTER", "screenshot": true}
```

## Key Sequence Syntax (gui_keys)

| Token | Meaning |
|-------|---------|
| `ESC`, `F2`, `ENTER`, `TAB`, `DOWN` | Single key |
| `type:hello world` | Type text into field |
| `DOWN*5` | Repeat key N times |
| `ALT+D`, `CTRL+A` | Key combo |
| `wait:500` | Pause (milliseconds) |

## API vs GUI Decision

| Situation | Use |
|-----------|-----|
| Query/export data | API |
| Create voucher/master | API first, GUI if API errors |
| Change period (F2) | GUI |
| Enable features (F11) | API `alter_company` first; if timeout → GUI to dismiss dialog |
| Delete voucher | GUI (`ALT+D` then confirm) |
| Verify state visually | GUI screenshot |

## Workflow Pattern

1. **API call** → check response for errors
2. If error/timeout → **gui_screenshot** to see Tally state
3. Analyze screenshot → **gui_keys** to fix (dismiss dialog, navigate, etc.)
4. **gui_screenshot** to verify
5. Repeat until done

## References

- **[api-actions.md](references/api-actions.md)** — All API actions, voucher entry structures, master creation, report names, company settings
- **[gui-automation.md](references/gui-automation.md)** — Keyboard shortcuts, menu navigation, key sequence syntax, troubleshooting

## Startup & Setup (follow this EVERY TIME before doing any Tally work)

Use the `setup` action — it handles everything automatically:
```json
{"action": "setup", "company": "PAVISHA POLYMERS"}
```

This will:
1. Check if Tally API is reachable (port 9000)
2. If not → launch TallyPrime and wait for it to come up
3. Check if a company is loaded
4. If not → use GUI keys to open the company (F1 → type name → ENTER)
5. Verify the company loaded via API
6. Return ready status with company details

**After setup, verify via API** (e.g., `list_companies`), not screenshots. Setup only checks if *any* company is loaded — it does NOT switch companies.

### Switching/Loading Companies (IMPORTANT)
Companies on disk are NOT automatically loaded. To open a different company:
1. Press **F3** at Gateway → opens "Change Company" menu
2. Navigate to **"Select Company"** (3rd option) and press ENTER
3. This shows ALL companies on disk (not just currently loaded ones)
4. Type company name or arrow-select, then ENTER to load it
Only after "Select Company" loads it will the API see the company.

### If wrong company is loaded after setup
Use GUI to switch:
```
ESC*5 → F3 → UP UP ENTER (Select Company) → type name → ENTER
```
Then verify via API: `list_companies`

### If setup fails completely
Ask user to: open TallyPrime, load company, ensure XML API on port 9000 (F12 > Advanced Configuration).

### Setting the period (for EDU mode or specific date ranges)
```json
{"action": "gui_keys", "keys": "ESC*5 wait:300 F2 wait:300 type:01-04-2025 ENTER type:31-03-2026 ENTER wait:500"}
```
Then verify with an API call (e.g., `list_companies` or `list_ledgers`).

## Critical Rules

1. **Dates**: API uses `YYYYMMDD`, GUI uses `DD-MM-YYYY`
2. **Tally amounts**: DEBIT = negative, CREDIT = positive
3. **Quantities**: Include unit with space, e.g., `" 2016 pc"`, `" 94 kg 752 gm."`
4. **XML escaping**: `&` → `&amp;`, handled automatically by `create_voucher`
5. **EDU mode**: Vouchers must match the current GUI period. Use today's date.
6. **After GUI actions** — verify via API when possible, screenshot when API can't confirm
7. **ESC is safe**: Extra ESCs at Gateway are harmless. When lost, `ESC*10` returns to Gateway.
