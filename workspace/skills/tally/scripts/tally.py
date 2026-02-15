#!/usr/bin/env python3
"""
Tally Prime Automation Toolkit
===============================
Single-file tool for XML API queries, data import/export, and GUI automation.
Designed to be called by AI agents via `python tally.py --file request.json`.

Usage:
  python tally.py --file request.json     # Read action from JSON file (recommended)
  python tally.py api query <xml_file>     # Raw XML API query
  python tally.py gui <action> [args...]   # GUI keyboard automation

JSON file format:
  { "action": "<action_name>", ...params }

Actions: See --help or references/api-actions.md
"""

import sys, os, json, time, struct, ctypes, ctypes.wintypes as w
import urllib.request
import xml.etree.ElementTree as ET
from pathlib import Path

# ""  Configuration """""""""""""""""""""""""""""""""""""""""""""""""""""""""""
TALLY_URL = os.environ.get("TALLY_URL", "http://localhost:9000")
SCREENSHOT_DIR = os.environ.get("TALLY_SCREENSHOT_DIR", str(Path(__file__).parent.parent.parent.parent))  # workspace
DEFAULT_TIMEOUT = 30
GUI_DELAY = 0.15  # seconds between GUI keystrokes

# ""  XML Helpers """""""""""""""""""""""""""""""""""""""""""""""""""""""""""""

def _sanitize_xml(xml_str: str) -> str:
    """Remove invalid XML character references (e.g., &#4;) that Tally sometimes produces."""
    import re
    return re.sub(r'&#([0-9]+);', lambda m: '' if int(m.group(1)) < 32 and int(m.group(1)) not in (9, 10, 13) else m.group(0), xml_str)

def _xml_escape(s: str) -> str:
    return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace('"', "&quot;")

# ""  XML API Layer """""""""""""""""""""""""""""""""""""""""""""""""""""""""""

def api_post(xml_body: str, timeout: int = DEFAULT_TIMEOUT) -> str:
    """Post raw XML to Tally and return response string."""
    req = urllib.request.Request(
        TALLY_URL,
        data=xml_body.encode("utf-8"),
        method="POST",
        headers={"Content-Type": "text/xml; charset=utf-8"}
    )
    try:
        resp = urllib.request.urlopen(req, timeout=timeout)
        raw = resp.read().decode("utf-8")
        return _sanitize_xml(raw)
    except Exception as e:
        return f"ERROR: {e}"

def api_export_collection(company: str, collection_name: str, obj_type: str,
                          fields: list[str], filters: list[str] = None,
                          fetch_list: list[str] = None) -> str:
    """Export a Tally collection (ledgers, stock items, vouchers, etc.)."""
    native = "\n".join(f"<NATIVEMETHOD>{f}</NATIVEMETHOD>" for f in fields)
    fetch = ""
    if fetch_list:
        fetch = "\n".join(f"<FETCH>{f}</FETCH>" for f in fetch_list)
    filt = ""
    if filters:
        for i, f in enumerate(filters):
            filt += f'<FILTER NAME="F{i}">{f}</FILTER>\n'
    xml = f"""<ENVELOPE>
<HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Collection</TYPE><ID>{collection_name}</ID></HEADER>
<BODY><DESC>
<STATICVARIABLES>
<SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
<SVCURRENTCOMPANY>{company}</SVCURRENTCOMPANY>
</STATICVARIABLES>
<TDL><TDLMESSAGE>
<COLLECTION NAME="{collection_name}">
<TYPE>{obj_type}</TYPE>
{native}
{fetch}
{filt}
</COLLECTION>
</TDLMESSAGE></TDL>
</DESC></BODY></ENVELOPE>"""
    return api_post(xml)

def api_export_report(company: str, report_name: str, from_date: str = None, to_date: str = None) -> str:
    """Export a Tally report (Trial Balance, Balance Sheet, etc.)."""
    date_vars = ""
    if from_date:
        date_vars += f"<SVFROMDATE>{from_date}</SVFROMDATE>\n"
    if to_date:
        date_vars += f"<SVTODATE>{to_date}</SVTODATE>\n"
    xml = f"""<ENVELOPE>
<HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Object</TYPE><ID>{report_name}</ID></HEADER>
<BODY><DESC>
<STATICVARIABLES>
<SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
<SVCURRENTCOMPANY>{company}</SVCURRENTCOMPANY>
{date_vars}
</STATICVARIABLES>
</DESC></BODY></ENVELOPE>"""
    return api_post(xml)

def api_import_voucher(company: str, voucher_xml: str) -> str:
    """Import a voucher into Tally (create/alter)."""
    xml = f"""<ENVELOPE>
<HEADER><VERSION>1</VERSION><TALLYREQUEST>Import</TALLYREQUEST><TYPE>Data</TYPE><ID>Vouchers</ID></HEADER>
<BODY><DESC>
<STATICVARIABLES>
<SVCURRENTCOMPANY>{company}</SVCURRENTCOMPANY>
</STATICVARIABLES>
</DESC>
<DATA><TALLYMESSAGE>
{voucher_xml}
</TALLYMESSAGE></DATA>
</BODY></ENVELOPE>"""
    return api_post(xml)

def api_import_master(company: str, master_xml: str) -> str:
    """Import a master object (ledger, stock item, group, etc.)."""
    xml = f"""<ENVELOPE>
<HEADER><VERSION>1</VERSION><TALLYREQUEST>Import</TALLYREQUEST><TYPE>Data</TYPE><ID>All Masters</ID></HEADER>
<BODY><DESC>
<STATICVARIABLES>
<SVCURRENTCOMPANY>{company}</SVCURRENTCOMPANY>
</STATICVARIABLES>
</DESC>
<DATA><TALLYMESSAGE>
{master_xml}
</TALLYMESSAGE></DATA>
</BODY></ENVELOPE>"""
    return api_post(xml)

def api_alter_company(company: str, settings_xml: str) -> str:
    """Alter company settings (features, options)."""
    xml = f"""<ENVELOPE>
<HEADER><VERSION>1</VERSION><TALLYREQUEST>Import</TALLYREQUEST><TYPE>Data</TYPE><ID>Company</ID></HEADER>
<BODY><DESC>
<STATICVARIABLES>
<SVCURRENTCOMPANY>{company}</SVCURRENTCOMPANY>
</STATICVARIABLES>
</DESC>
<DATA><TALLYMESSAGE>
{settings_xml}
</TALLYMESSAGE></DATA>
</BODY></ENVELOPE>"""
    return api_post(xml, timeout=60)

def api_list_companies() -> str:
    """List all companies loaded in Tally."""
    xml = """<ENVELOPE>
<HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Collection</TYPE><ID>CompanyList</ID></HEADER>
<BODY><DESC>
<STATICVARIABLES><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT></STATICVARIABLES>
<TDL><TDLMESSAGE>
<COLLECTION NAME="CompanyList"><TYPE>Company</TYPE><NATIVEMETHOD>Name</NATIVEMETHOD><NATIVEMETHOD>StartingFrom</NATIVEMETHOD></COLLECTION>
</TDLMESSAGE></TDL>
</DESC></BODY></ENVELOPE>"""
    return api_post(xml)

# ""  Parsed API Helpers """"""""""""""""""""""""""""""""""""""""""""""""""""""

def parse_xml_to_dicts(xml_str: str, tag: str) -> list[dict]:
    """Parse XML response into list of dicts for a given tag."""
    try:
        root = ET.fromstring(_sanitize_xml(xml_str))
    except ET.ParseError:
        return [{"_raw": xml_str}]
    results = []
    # Look for data elements (with attributes " Tally data elements have NAME attr)
    # Skip CMPINFO counter elements (they're just numbers like <STOCKITEM>202</STOCKITEM>)
    for elem in root.iter(tag):
        # Data elements have attributes (NAME, RESERVEDNAME, etc.) or child elements with TYPE attr
        if not elem.attrib and elem.text and elem.text.strip().isdigit():
            continue  # Skip CMPINFO counters
        d = {}
        name = elem.get("NAME", "")
        if not name:
            name_el = elem.find("NAME")
            if name_el is not None and name_el.text:
                name = name_el.text.strip()
        d["_NAME"] = name
        for child in elem:
            if child.text and child.text.strip():
                d[child.tag] = child.text.strip()
        if d.get("_NAME") or len(d) > 1:  # Only include if has name or meaningful data
            results.append(d)
    return results

def action_list_companies(params: dict) -> str:
    raw = api_list_companies()
    companies = parse_xml_to_dicts(raw, "COMPANY")
    if not companies or "_raw" in companies[0]:
        return raw
    lines = [f"Companies loaded in Tally ({len(companies)}):"]
    for c in companies:
        lines.append(f"  - {c.get('_NAME', '?')} (from {c.get('STARTINGFROM', '?')})")
    return "\n".join(lines)

def action_list_ledgers(params: dict) -> str:
    company = params["company"]
    raw = api_export_collection(company, "LedgerList", "Ledger",
                                ["Name", "Parent", "ClosingBalance"])
    ledgers = parse_xml_to_dicts(raw, "LEDGER")
    if not ledgers or "_raw" in ledgers[0]:
        return raw
    lines = [f"Ledgers in {company} ({len(ledgers)}):"]
    for l in ledgers:
        bal = l.get("CLOSINGBALANCE", "0")
        lines.append(f"  {l['_NAME']} [{l.get('PARENT', '')}] Bal: {bal}")
    return "\n".join(lines)

def action_list_stock_items(params: dict) -> str:
    company = params["company"]
    raw = api_export_collection(company, "SIList", "StockItem",
                                ["Name", "Parent", "BaseUnits", "ClosingBalance", "ClosingRate"])
    items = parse_xml_to_dicts(raw, "STOCKITEM")
    if not items or "_raw" in items[0]:
        return raw
    lines = [f"Stock Items in {company} ({len(items)}):"]
    for it in items:
        lines.append(f"  {it['_NAME']} | Unit: {it.get('BASEUNITS', '?')} | Closing: {it.get('CLOSINGBALANCE', '0')}")
    return "\n".join(lines)

def action_list_vouchers(params: dict) -> str:
    company = params["company"]
    vtype = params.get("voucher_type", "")
    from_date = params.get("from_date")
    to_date = params.get("to_date")
    fields = ["VoucherNumber", "Date", "VoucherTypeName", "PartyLedgerName", "Amount", "Narration"]
    fetch = ["ALLLEDGERENTRIES", "INVENTORYENTRIES", "ALLINVENTORYENTRIES"]
    raw = api_export_collection(company, "VchList", "Voucher", fields, fetch_list=fetch)
    vouchers = parse_xml_to_dicts(raw, "VOUCHER")
    if not vouchers or "_raw" in vouchers[0]:
        return raw
    # Filter by type if specified
    if vtype:
        vouchers = [v for v in vouchers if v.get("VOUCHERTYPENAME", "").lower() == vtype.lower()]
    lines = [f"Vouchers in {company} ({len(vouchers)}):"]
    for v in vouchers:
        lines.append(f"  #{v.get('VOUCHERNUMBER', '?')} | {v.get('DATE', '?')} | {v.get('VOUCHERTYPENAME', '?')} | {v.get('PARTYLEDGERNAME', '')} | {v.get('AMOUNT', '0')}")
    return "\n".join(lines)

def action_get_bom(params: dict) -> str:
    """Get Bill of Materials for stock items."""
    company = params["company"]
    item_name = params.get("item")  # optional: filter to one item
    raw = api_export_collection(company, "BOMList", "StockItem",
                                ["Name", "Parent", "BaseUnits"],
                                fetch_list=["BOMName", "BASICBOMDETAILS", "BOMQUANTITY",
                                            "BOMALTERNATEQUANTITY", "BOMITEMS", "BOMCOMPONENTS"])
    if item_name:
        # Parse and filter
        try:
            root = ET.fromstring(raw)
            # Return XML for just the matching item
            for elem in root.iter("STOCKITEM"):
                if elem.get("NAME", "").lower() == item_name.lower():
                    return ET.tostring(elem, encoding="unicode")
            return f"Item '{item_name}' not found in BOM data"
        except:
            return raw
    return raw

def action_create_voucher(params: dict) -> str:
    """Create a voucher from structured JSON."""
    company = params["company"]
    voucher_xml = params.get("voucher_xml")
    if voucher_xml:
        return api_import_voucher(company, voucher_xml)
    # Build from structured params
    vtype = params["voucher_type"]
    date = params["date"]  # YYYYMMDD
    narration = params.get("narration", "")
    entries = params.get("entries", [])
    objview = params.get("objview", "")

    objview_attr = f' OBJVIEW="{objview}"' if objview else ""
    xml_parts = [f'<VOUCHER VCHTYPE="{vtype}" ACTION="Create"{objview_attr}>']
    xml_parts.append(f"<DATE>{date}</DATE>")
    xml_parts.append(f"<EFFECTIVEDATE>{date}</EFFECTIVEDATE>")
    xml_parts.append(f"<VOUCHERTYPENAME>{vtype}</VOUCHERTYPENAME>")
    if narration:
        xml_parts.append(f"<NARRATION>{_xml_escape(narration)}</NARRATION>")

    for entry in entries:
        tag = entry.get("tag", "ALLLEDGERENTRIES.LIST")
        xml_parts.append(f"<{tag}>")
        for k, v in entry.items():
            if k == "tag":
                continue
            if k == "children":
                for child in v:
                    ctag = child.get("tag", "BATCHALLOCATIONS.LIST")
                    xml_parts.append(f"<{ctag}>")
                    for ck, cv in child.items():
                        if ck == "tag":
                            continue
                        xml_parts.append(f"<{ck}>{_xml_escape(str(cv))}</{ck}>")
                    xml_parts.append(f"</{ctag}>")
            else:
                xml_parts.append(f"<{k}>{_xml_escape(str(v))}</{k}>")
        xml_parts.append(f"</{tag}>")
    xml_parts.append("</VOUCHER>")
    return api_import_voucher(company, "\n".join(xml_parts))

def action_create_master(params: dict) -> str:
    """Create/alter a master object (ledger, stock item, group, etc.)."""
    company = params["company"]
    master_xml = params.get("master_xml")
    if master_xml:
        return api_import_master(company, master_xml)
    return "ERROR: master_xml required"

def action_raw_xml(params: dict) -> str:
    """Send raw XML to Tally."""
    xml = params.get("xml", "")
    if not xml:
        xml_file = params.get("xml_file", "")
        if xml_file and os.path.exists(xml_file):
            xml = open(xml_file).read()
        else:
            return "ERROR: xml or xml_file required"
    return api_post(xml, timeout=params.get("timeout", DEFAULT_TIMEOUT))

def action_alter_company(params: dict) -> str:
    company = params["company"]
    settings_xml = params.get("settings_xml", "")
    if not settings_xml:
        return "ERROR: settings_xml required"
    return api_alter_company(company, settings_xml)

# ""  GUI Automation Layer """"""""""""""""""""""""""""""""""""""""""""""""""""

user32 = ctypes.windll.user32

# Virtual key codes
VK = {
    "RETURN": 0x0D, "ENTER": 0x0D, "TAB": 0x09, "ESCAPE": 0x1B, "ESC": 0x1B,
    "SPACE": 0x20, "BACK": 0x08, "BACKSPACE": 0x08, "DELETE": 0x2E,
    "UP": 0x26, "DOWN": 0x28, "LEFT": 0x25, "RIGHT": 0x27,
    "HOME": 0x24, "END": 0x23, "PGUP": 0x21, "PGDN": 0x22,
    "F1": 0x70, "F2": 0x71, "F3": 0x72, "F4": 0x73, "F5": 0x74,
    "F6": 0x75, "F7": 0x76, "F8": 0x77, "F9": 0x78, "F10": 0x79,
    "F11": 0x7A, "F12": 0x7B,
    "CTRL": 0x11, "ALT": 0x12, "SHIFT": 0x10,
    "A": 0x41, "B": 0x42, "C": 0x43, "D": 0x44, "E": 0x45, "F": 0x46,
    "G": 0x47, "H": 0x48, "I": 0x49, "J": 0x4A, "K": 0x4B, "L": 0x4C,
    "M": 0x4D, "N": 0x4E, "O": 0x4F, "P": 0x50, "Q": 0x51, "R": 0x52,
    "S": 0x53, "T": 0x54, "U": 0x55, "V": 0x56, "W": 0x57, "X": 0x58,
    "Y": 0x59, "Z": 0x5A,
    "0": 0x30, "1": 0x31, "2": 0x32, "3": 0x33, "4": 0x34,
    "5": 0x35, "6": 0x36, "7": 0x37, "8": 0x38, "9": 0x39,
}

INPUT_KEYBOARD = 1
KEYEVENTF_KEYUP = 0x0002

def _find_tally_hwnd() -> int:
    """Find TallyPrime window handle as a plain integer."""
    result = []
    @ctypes.WINFUNCTYPE(w.BOOL, w.HWND, w.LPARAM)
    def callback(hwnd, lparam):
        if user32.IsWindowVisible(hwnd):
            buf = ctypes.create_unicode_buffer(256)
            user32.GetWindowTextW(hwnd, buf, 256)
            title = buf.value
            if "TallyPrime" in title or "Tally.ERP" in title:
                result.append(int(hwnd))
        return True
    user32.EnumWindows(callback, 0)
    return result[0] if result else 0

def gui_send_vk(vk_code: int, hold_ms: int = 0):
    """Send a virtual key to Tally via PostMessage. Background-safe (no focus needed).
    Uses WM_CHAR for printable chars (most reliable for Tally's custom Ganeshji UI),
    WM_KEYDOWN/UP for special keys (ESC, F-keys, arrows, etc.)."""
    hwnd = _find_tally_hwnd()
    if not hwnd:
        print("WARNING: Tally window not found for gui_send_vk")
        return
    # For letter/number keys (A-Z, 0-9), use WM_CHAR which Tally handles reliably
    if 0x41 <= vk_code <= 0x5A:  # A-Z
        user32.PostMessageW(hwnd, 0x0102, vk_code + 32, 0)  # lowercase char
    elif 0x30 <= vk_code <= 0x39:  # 0-9
        user32.PostMessageW(hwnd, 0x0102, vk_code, 0)
    else:
        # Special keys: use WM_KEYDOWN/UP
        scan = user32.MapVirtualKeyW(vk_code, 0)
        lparam_down = (scan << 16) | 1
        lparam_up = (scan << 16) | 1 | (1 << 30) | (1 << 31)
        user32.PostMessageW(hwnd, 0x0100, vk_code, lparam_down)
        time.sleep(hold_ms / 1000 if hold_ms else 0.05)
        user32.PostMessageW(hwnd, 0x0101, vk_code, lparam_up)
    time.sleep(GUI_DELAY)

def gui_send_combo(*vk_codes: int):
    """Send a key combination (e.g., Alt+D, Ctrl+A). Uses PostMessage for background safety."""
    hwnd = _find_tally_hwnd()
    if not hwnd:
        print("WARNING: Tally window not found for gui_send_combo")
        return
    # Press modifiers down
    for vk in vk_codes[:-1]:
        scan = user32.MapVirtualKeyW(vk, 0)
        lparam = (scan << 16) | 1
        user32.PostMessageW(hwnd, 0x0100, vk, lparam)
        time.sleep(0.05)
    # Press+release main key
    main_vk = vk_codes[-1]
    scan = user32.MapVirtualKeyW(main_vk, 0)
    user32.PostMessageW(hwnd, 0x0100, main_vk, (scan << 16) | 1)
    time.sleep(0.05)
    user32.PostMessageW(hwnd, 0x0101, main_vk, (scan << 16) | 1 | (1 << 30) | (1 << 31))
    time.sleep(0.05)
    # Release modifiers
    for vk in reversed(vk_codes[:-1]):
        scan = user32.MapVirtualKeyW(vk, 0)
        user32.PostMessageW(hwnd, 0x0101, vk, (scan << 16) | 1 | (1 << 30) | (1 << 31))
        time.sleep(0.05)
    time.sleep(GUI_DELAY)

def gui_type_unicode(text: str):
    """Type text via WM_CHAR PostMessage — background-safe, no focus needed."""
    hwnd = _find_tally_hwnd()
    if not hwnd:
        print("ERROR: TallyPrime not found")
        return
    for ch in text:
        # Use WM_CHAR for Tally's custom input fields
        user32.PostMessageW(hwnd, 0x0102, ord(ch), 0)
        time.sleep(0.04)
    time.sleep(GUI_DELAY)

def gui_screenshot(filename: str = "tally_screenshot.png") -> str:
    """Take a screenshot of the Tally window using PrintWindow (works from background/service).
    
    NOTE: pyautogui.screenshot / ImageGrab.grab FAIL when OpenClaw runs as a service
    without interactive desktop access. PrintWindow via PostMessage works because it
    asks the target window to paint into our DC — no desktop access needed.
    """
    filepath = os.path.join(SCREENSHOT_DIR, filename)
    try:
        from PIL import Image
        gdi32 = ctypes.windll.gdi32
        
        hwnd = _find_tally_hwnd()
        if not hwnd:
            print("ERROR: Screenshot failed: Tally window not found")
            return ""
        
        rect = w.RECT()
        user32.GetWindowRect(hwnd, ctypes.byref(rect))
        cx = rect.right - rect.left
        cy = rect.bottom - rect.top
        
        if cx <= 0 or cy <= 0:
            print(f"ERROR: Screenshot failed: invalid window size {cx}x{cy}")
            return ""
        
        hdc = user32.GetDC(hwnd)
        memdc = gdi32.CreateCompatibleDC(hdc)
        bmp = gdi32.CreateCompatibleBitmap(hdc, cx, cy)
        old = gdi32.SelectObject(memdc, bmp)
        
        # PW_RENDERFULLCONTENT = 2 — captures the full window content
        result = user32.PrintWindow(hwnd, memdc, 2)
        if not result:
            # Fallback to PW_CLIENTONLY = 1
            result = user32.PrintWindow(hwnd, memdc, 1)
        
        # Extract pixel data
        class BITMAPINFOHEADER(ctypes.Structure):
            _fields_ = [
                ('biSize', ctypes.c_uint32), ('biWidth', ctypes.c_int32),
                ('biHeight', ctypes.c_int32), ('biPlanes', ctypes.c_uint16),
                ('biBitCount', ctypes.c_uint16), ('biCompression', ctypes.c_uint32),
                ('biSizeImage', ctypes.c_uint32), ('biXPelsPerMeter', ctypes.c_int32),
                ('biYPelsPerMeter', ctypes.c_int32), ('biClrUsed', ctypes.c_uint32),
                ('biClrImportant', ctypes.c_uint32)
            ]
        
        bi = BITMAPINFOHEADER()
        bi.biSize = ctypes.sizeof(bi)
        bi.biWidth = cx
        bi.biHeight = -cy  # top-down
        bi.biPlanes = 1
        bi.biBitCount = 32
        bi.biCompression = 0
        
        buf = ctypes.create_string_buffer(cx * cy * 4)
        gdi32.GetDIBits(memdc, bmp, 0, cy, buf, ctypes.byref(bi), 0)
        
        img = Image.frombuffer('RGBA', (cx, cy), buf, 'raw', 'BGRA', 0, 1)
        img.save(filepath)
        
        # Cleanup
        gdi32.SelectObject(memdc, old)
        gdi32.DeleteObject(bmp)
        gdi32.DeleteDC(memdc)
        user32.ReleaseDC(hwnd, hdc)
        
        print(f"Screenshot saved: {filepath}")
        return filepath
    except Exception as e:
        print(f"ERROR: Screenshot failed: {e}")
        return ""

def gui_parse_keys(key_string: str) -> list:
    """Parse a key sequence string into actions.
    Format: 'ESC ESC F2 type:15-02-2026 ENTER wait:500 DOWN*3 ALT+D'
    - Single keys: ESC, F2, ENTER, TAB, etc.
    - Type text:   type:hello world
    - Combos:      ALT+D, CTRL+A, CTRL+SHIFT+S
    - Repeat:      DOWN*5, TAB*3
    - Wait:        wait:500 (milliseconds)
    """
    actions = []
    tokens = key_string.split()
    i = 0
    while i < len(tokens):
        token = tokens[i]
        if token.startswith("type:"):
            # Collect everything after type: until next recognized key or end
            text = token[5:]
            i += 1
            while i < len(tokens):
                t = tokens[i].upper()
                # Check if next token is a key command
                if (t in VK or t.startswith("TYPE:") or t.startswith("WAIT:") or
                    "+" in t and all(p in VK for p in t.split("+")) or
                    "*" in t and t.split("*")[0] in VK):
                    break
                text += " " + tokens[i]
                i += 1
            actions.append(("type", text))
            continue
        elif token.startswith("wait:"):
            actions.append(("wait", int(token[5:])))
        elif "+" in token:
            parts = token.upper().split("+")
            codes = [VK[p] for p in parts if p in VK]
            if len(codes) == len(parts):
                actions.append(("combo", codes))
            else:
                print(f"WARNING: Unknown key in combo '{token}'")
        elif "*" in token:
            key, count = token.split("*", 1)
            key_upper = key.upper()
            if key_upper in VK:
                actions.append(("repeat", VK[key_upper], int(count)))
            else:
                print(f"WARNING: Unknown key '{key}'")
        else:
            key_upper = token.upper()
            if key_upper in VK:
                actions.append(("key", VK[key_upper]))
            else:
                print(f"WARNING: Unknown key '{token}'")
        i += 1
    return actions

def gui_execute_keys(key_string: str, focus: bool = False) -> str:
    """Execute a key sequence string on Tally. Returns status. Uses PostMessage (no focus needed)."""
    if not _find_tally_hwnd():
        return "ERROR: TallyPrime window not found"
    actions = gui_parse_keys(key_string)
    for action in actions:
        if action[0] == "key":
            gui_send_vk(action[1])
        elif action[0] == "combo":
            gui_send_combo(*action[1])
        elif action[0] == "repeat":
            for _ in range(action[2]):
                gui_send_vk(action[1])
        elif action[0] == "type":
            gui_type_unicode(action[1])
        elif action[0] == "wait":
            time.sleep(action[1] / 1000)
    return "OK"

def action_gui_keys(params: dict) -> str:
    """Execute GUI key sequence."""
    keys = params.get("keys", "")
    if not keys:
        return "ERROR: 'keys' param required"
    focus = params.get("focus", True)
    result = gui_execute_keys(keys, focus=focus)
    if params.get("screenshot"):
        time.sleep(params.get("screenshot_delay", 0.5))
        try:
            gui_screenshot(params.get("screenshot_name", "tally_after_keys.png"))
        except Exception as e:
            print(f"WARNING: Screenshot failed: {e}")
    return result

def action_gui_escape_to_gateway(params: dict) -> str:
    """Press ESC repeatedly to return to Tally Gateway."""
    count = params.get("count", 10)
    for _ in range(count):
        gui_send_vk(VK["ESCAPE"])
        time.sleep(0.2)
    time.sleep(0.3)
    if params.get("screenshot", True):
        try:
            gui_screenshot("tally_gateway.png")
        except Exception as e:
            print(f"WARNING: Screenshot failed: {e}")
    return f"Sent {count}x ESC - should be at Gateway"

def action_gui_screenshot(params: dict) -> str:
    """Take screenshot of Tally."""
    name = params.get("filename", "tally_screenshot.png")
    path = gui_screenshot(name)
    return path if path else "ERROR: Screenshot failed"

def action_gui_navigate(params: dict) -> str:
    """Navigate Tally menus using a path like 'Gateway > Display > Trial Balance'.
    Each segment is typed as a menu shortcut key or searched via typing."""
    path = params.get("path", [])
    if not path:
        return "ERROR: 'path' list required (e.g., ['D', 'Trial Balance'])"
    for i, segment in enumerate(path):
        if len(segment) == 1:
            # Single char = shortcut key
            gui_type_unicode(segment)
        elif segment.upper() in VK:
            gui_send_vk(VK[segment.upper()])
        else:
            # Multi-char = type to search in Tally's type-ahead list
            gui_type_unicode(segment)
            time.sleep(0.3)
            gui_send_vk(VK["ENTER"])
        time.sleep(0.5)
    if params.get("screenshot", True):
        time.sleep(0.3)
        try:
            gui_screenshot(params.get("screenshot_name", "tally_nav.png"))
        except Exception as e:
            print(f"WARNING: Screenshot failed: {e}")
    return "OK"

# ""  Setup Action """"""""""""""""""""""""""""""""""""""""""""""""""""""""""""

def _is_tally_reachable() -> bool:
    """Check if Tally API is responding."""
    try:
        resp = api_list_companies()
        return not resp.startswith("ERROR:")
    except:
        return False

def _is_company_loaded() -> tuple[bool, list[str]]:
    """Check if any company is loaded. Returns (loaded, company_names)."""
    raw = api_list_companies()
    if raw.startswith("ERROR:"):
        return False, []
    companies = parse_xml_to_dicts(raw, "COMPANY")
    names = [c.get("_NAME", "") for c in companies if c.get("_NAME")]
    return len(names) > 0, names

def _launch_tally() -> bool:
    """Try to launch TallyPrime. Returns True if process started."""
    import subprocess
    paths = [
        r"C:\Program Files\TallyPrime\tally.exe",
        r"C:\Program Files (x86)\TallyPrime\tally.exe",
        r"C:\TallyPrime\tally.exe",
        r"C:\Tally\TallyPrime\tally.exe",
    ]
    for p in paths:
        if os.path.exists(p):
            subprocess.Popen([p], shell=False)
            print(f"Launched Tally from: {p}")
            return True
    # Try searching common locations
    for drive in ["C:", "D:", "E:"]:
        for root_dir in [f"{drive}\\Program Files", f"{drive}\\Program Files (x86)", f"{drive}\\"]:
            candidate = os.path.join(root_dir, "TallyPrime", "tally.exe")
            if os.path.exists(candidate):
                subprocess.Popen([candidate], shell=False)
                print(f"Launched Tally from: {candidate}")
                return True
    return False

def action_setup(params: dict) -> str:
    """Full automated setup: launch Tally if needed, load company, verify."""
    company = params.get("company", "")
    max_retries = params.get("retries", 3)
    wait_secs = params.get("wait", 12)

    # Step 1: Check if Tally is reachable
    print("Step 1: Checking if Tally API is reachable...")
    if _is_tally_reachable():
        print("  Tally API is responding")
    else:
        # Step 2: Launch Tally
        print("  - Tally not reachable. Launching...")
        if not _launch_tally():
            return "ERROR: Could not find TallyPrime executable. Please launch Tally manually."

        # Wait for Tally to start and API to become available
        for attempt in range(max_retries):
            print(f"  Waiting {wait_secs}s for Tally to start (attempt {attempt + 1}/{max_retries})...")
            time.sleep(wait_secs)
            if _is_tally_reachable():
                print("  Tally API is now responding")
                break
        else:
            return "ERROR: Tally launched but API not responding after retries. Check that XML server is enabled (F12 > Advanced Configuration > port 9000)."

    # Step 3: Dismiss license dialog if present
    # Tally EDU shows a license dialog on startup requiring 'T' for Educational Mode.
    # Sending 'T' via WM_CHAR is harmless if no dialog is present.
    print("Step 2: Dismissing license dialog (sending 'T' for Educational Mode)...")
    hwnd = _find_tally_hwnd()
    if not hwnd:
        return "ERROR: TallyPrime window not found. Is it running?"
    user32.PostMessageW(hwnd, 0x0102, ord('T'), 0)  # WM_CHAR 'T'
    time.sleep(3)

    # Step 4: Check if company auto-loaded (tally.ini Default Companies + Load=)
    print("Step 3: Checking if company is loaded...")
    loaded, names = _is_company_loaded()
    if loaded:
        print(f"  OK: Companies loaded: {', '.join(names)}")
        return f"OK: Tally ready. Companies loaded: {', '.join(names)}"

    # Wait for auto-load
    print("  No company yet, waiting for auto-load...")
    for _ in range(4):
        time.sleep(5)
        loaded, names = _is_company_loaded()
        if loaded:
            print(f"  OK: Companies loaded: {', '.join(names)}")
            return f"OK: Tally ready. Companies loaded: {', '.join(names)}"

    # Step 5: Try GUI to select company (F1 + type name + Enter)
    print("Step 4: Selecting company via GUI...")
    hwnd = _find_tally_hwnd()
    if not hwnd:
        return "ERROR: TallyPrime window not found."

    # ESC to clean Gateway state
    for _ in range(3):
        gui_send_vk(VK["ESCAPE"])
        time.sleep(0.3)
    time.sleep(1)

    # F1 to open company list
    gui_send_vk(VK["F1"])
    time.sleep(2)

    # Type company name if provided
    if company:
        gui_type_unicode(company)
        time.sleep(1)

    # Enter to select
    gui_send_vk(VK["ENTER"])
    time.sleep(5)

    # Verify
    for attempt in range(max_retries):
        loaded, names = _is_company_loaded()
        if loaded:
            print(f"  OK: Companies loaded: {', '.join(names)}")
            return f"OK: Tally ready. Companies loaded: {', '.join(names)}"
        print(f"  Waiting for company to load (attempt {attempt + 1}/{max_retries})...")
        time.sleep(3)

    return "ERROR: Company did not load. Check Tally screen manually."


# ""  Action Dispatch """""""""""""""""""""""""""""""""""""""""""""""""""""""""

ACTIONS = {
    # API actions
    "list_companies": action_list_companies,
    "list_ledgers": action_list_ledgers,
    "list_stock_items": action_list_stock_items,
    "list_vouchers": action_list_vouchers,
    "get_bom": action_get_bom,
    "create_voucher": action_create_voucher,
    "create_master": action_create_master,
    "alter_company": action_alter_company,
    "raw_xml": action_raw_xml,
    "export_report": lambda p: api_export_report(p["company"], p["report"], p.get("from_date"), p.get("to_date")),
    "export_collection": lambda p: api_export_collection(p["company"], p["collection"], p["type"], p.get("fields", ["Name"]), fetch_list=p.get("fetch")),
    # GUI actions
    "gui_keys": action_gui_keys,
    "gui_escape": action_gui_escape_to_gateway,
    "gui_screenshot": action_gui_screenshot,
    "gui_navigate": action_gui_navigate,
    # Setup
    "setup": action_setup,
}

def main():
    if len(sys.argv) < 2 or sys.argv[1] in ("--help", "-h", "help"):
        print("Usage: python tally.py --file request.json")
        print("       python tally.py <action> [json_params]")
        print(f"\nAvailable actions: {', '.join(sorted(ACTIONS.keys()))}")
        sys.exit(0)

    if sys.argv[1] == "--file":
        filepath = sys.argv[2]
        with open(filepath, "r", encoding="utf-8") as f:
            params = json.load(f)
        action = params.pop("action")
    else:
        action = sys.argv[1]
        if len(sys.argv) > 2:
            # Try to parse remaining args as JSON
            try:
                params = json.loads(" ".join(sys.argv[2:]))
            except json.JSONDecodeError:
                params = {}
        else:
            params = {}

    if action not in ACTIONS:
        print(f"ERROR: Unknown action '{action}'")
        print(f"Available: {', '.join(sorted(ACTIONS.keys()))}")
        sys.exit(1)

    result = ACTIONS[action](params)
    print(result)

if __name__ == "__main__":
    main()

