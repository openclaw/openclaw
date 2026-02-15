# Tally GUI Automation Reference

## When to Use GUI vs API

| Use API when... | Use GUI when... |
|-----------------|-----------------|
| Creating/reading vouchers | API request times out (dialog blocking) |
| Querying data | Changing period (F2 in Gateway) |
| Exporting reports | Dismissing confirmation dialogs |
| Creating masters | Navigating menus for visual verification |
| Altering company settings | Features that trigger GUI prompts |

**Always try API first.** Fall back to GUI only when API fails or times out.

## Key Sequence Syntax

The `gui_keys` action accepts a string with space-separated tokens:

| Token | Example | Description |
|-------|---------|-------------|
| Key name | `ESC`, `F2`, `ENTER`, `TAB` | Single key press |
| `type:text` | `type:15-02-2026` | Type text into active field |
| `KEY*N` | `DOWN*5`, `TAB*3` | Repeat key N times |
| `MOD+KEY` | `ALT+D`, `CTRL+A` | Key combination |
| `wait:MS` | `wait:500` | Pause in milliseconds |

### Examples
```json
{"action": "gui_keys", "keys": "ESC ESC ESC"}
{"action": "gui_keys", "keys": "F2 wait:300 type:15-02-2026 ENTER", "screenshot": true}
{"action": "gui_keys", "keys": "ALT+D wait:300 ENTER"}
{"action": "gui_keys", "keys": "DOWN*3 ENTER wait:500 type:Journal ENTER"}
```

## Tally Keyboard Shortcuts (Gateway of Tally)

| Key | Action |
|-----|--------|
| `A` | Alter company |
| `C` | Create company |
| `D` | Display menu (reports) |
| `G` | Go To (voucher entry) |
| `K` | Quit |
| `S` | Shut company |
| `F1` | Select company |
| `F2` | Change period |
| `F3` | Change company |
| `F11` | Features (company settings) |
| `F12` | Configure |

## Voucher Entry Mode Shortcuts

| Key | Action |
|-----|--------|
| `F2` | Change date |
| `F5` | Payment voucher |
| `F6` | Receipt voucher |
| `F7` | Journal voucher |
| `F8` | Sales voucher |
| `F9` | Purchase voucher |
| `CTRL+F8` | Credit Note |
| `CTRL+F9` | Debit Note |
| `ALT+D` | Delete voucher |
| `ALT+A` | Add voucher (in Day Book) |
| `ALT+2` | Duplicate voucher |
| `CTRL+A` | Accept/Save screen |
| `ESC` | Back/Cancel |

## Display Menu Navigation

From Gateway, press `D` to enter Display, then:

| Key/Path | Report |
|----------|--------|
| `1` or `Trial Balance` | Trial Balance |
| `B` | Balance Sheet |
| `P` | Profit & Loss |
| `S` | Stock Summary |
| `D` | Day Book |
| `A` | Account Books → then select sub-report |

## Navigation Pattern for Any Task

1. **Escape to Gateway**: `ESC*10` (safe — extra ESCs are harmless at Gateway)
2. **Screenshot to verify**: `gui_screenshot`
3. **Navigate**: Use shortcut keys or `gui_navigate` with path
4. **Screenshot to verify**: Always screenshot after navigation
5. **Perform action**: Type data, select options
6. **Save**: `CTRL+A` or `ENTER` as needed
7. **Screenshot to verify**: Confirm action completed

## ⚠️ Critical Notes

### Text Input in Tally
Tally uses custom text fields. The tool types via `WM_CHAR` PostMessage (background-safe, no focus needed).

### Type-Ahead Lists
When Tally shows a selection list (ledger names, stock items), just type the first few characters — Tally filters automatically. Press ENTER to select.

### Period Handling
- F2 at Gateway changes the viewing period
- In EDU mode, period affects what vouchers are visible/editable
- Date format in GUI: `DD-MM-YYYY` (e.g., `15-02-2026`)
- Date format in API: `YYYYMMDD` (e.g., `20260215`)

### Confirmation Dialogs
Tally sometimes shows "Yes/No" dialogs. These block the API. Use:
```json
{"action": "gui_keys", "keys": "Y ENTER", "screenshot": true}
```
Or just ENTER (for default Yes).

### Workflow
ESC to Gateway → action via gui_keys → verify with API (or screenshot if API can't confirm).
