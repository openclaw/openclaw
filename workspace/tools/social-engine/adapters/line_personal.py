"""LINE Personal adapter — Chrome extension via screenshot + AppleScript.

LINE Chrome 擴充套件 (ophjlpahpchlmihnnnihgmmeilfjmjjc) 跑在獨立 app 窗口裡。
CDP 看不到它，但可以用：
  - screencapture -l <windowID> 截圖
  - AppleScript (System Events) 操控鍵盤/滑鼠
  - Quartz CGWindowList 找窗口 ID

不需要 --remote-debugging-port，不需要 Playwright。正常 Chrome + 擴充套件就夠。
"""
import json
import os
import subprocess
import time
from pathlib import Path

from .base import ChannelAdapter

SCREENSHOTS_DIR = Path(__file__).parent.parent / "line-screenshots"


def _find_line_window_id() -> int | None:
    """Find LINE Chrome extension window ID via Quartz."""
    try:
        result = subprocess.run(
            ["python3", "-c", """
import Quartz
windows = Quartz.CGWindowListCopyWindowInfo(Quartz.kCGWindowListOptionOnScreenOnly, Quartz.kCGNullWindowID)
for w in windows:
    name = w.get('kCGWindowName', '')
    owner = w.get('kCGWindowOwnerName', '')
    if 'LINE' in str(name) and 'Chrome' in str(owner):
        print(w.get('kCGWindowNumber', ''))
        break
"""],
            capture_output=True, text=True, timeout=5
        )
        wid = result.stdout.strip()
        return int(wid) if wid else None
    except Exception:
        return None


def _screenshot_line(output_path: str = None) -> str | None:
    """Capture LINE window screenshot."""
    wid = _find_line_window_id()
    if not wid:
        return None

    SCREENSHOTS_DIR.mkdir(exist_ok=True)
    if not output_path:
        output_path = str(SCREENSHOTS_DIR / f"line-{int(time.time())}.png")

    try:
        subprocess.run(
            ["screencapture", "-l", str(wid), output_path],
            capture_output=True, timeout=10
        )
        if os.path.exists(output_path):
            return output_path
    except Exception:
        pass
    return None


def _focus_line_window():
    """Bring LINE window to front."""
    subprocess.run(["osascript", "-e", """
tell application "System Events"
    tell process "Google Chrome"
        set lineWin to first window whose name contains "LINE"
        perform action "AXRaise" of lineWin
    end tell
end tell
tell application "Google Chrome" to activate
"""], capture_output=True, timeout=5)
    time.sleep(0.5)


def _click_at(x: int, y: int):
    """Click at absolute screen coordinates."""
    subprocess.run(["osascript", "-e", f"""
tell application "System Events"
    click at {{{x}, {y}}}
end tell
"""], capture_output=True, timeout=5)
    time.sleep(0.3)


def _type_text(text: str):
    """Type text using AppleScript keystroke."""
    # Escape special characters for AppleScript
    escaped = text.replace("\\", "\\\\").replace('"', '\\"')
    subprocess.run(["osascript", "-e", f"""
tell application "System Events"
    keystroke "{escaped}"
end tell
"""], capture_output=True, timeout=10)


def _press_enter():
    """Press Enter key."""
    subprocess.run(["osascript", "-e", """
tell application "System Events"
    key code 36
end tell
"""], capture_output=True, timeout=5)


def _get_line_window_bounds() -> dict | None:
    """Get LINE window position and size."""
    try:
        result = subprocess.run(
            ["python3", "-c", """
import Quartz
windows = Quartz.CGWindowListCopyWindowInfo(Quartz.kCGWindowListOptionOnScreenOnly, Quartz.kCGNullWindowID)
for w in windows:
    name = w.get('kCGWindowName', '')
    owner = w.get('kCGWindowOwnerName', '')
    if 'LINE' in str(name) and 'Chrome' in str(owner):
        b = w.get('kCGWindowBounds', {})
        import json
        print(json.dumps({'x': int(b['X']), 'y': int(b['Y']), 'w': int(b['Width']), 'h': int(b['Height'])}))
        break
"""],
            capture_output=True, text=True, timeout=5
        )
        if result.stdout.strip():
            return json.loads(result.stdout.strip())
    except Exception:
        pass
    return None


def _click_search_and_type(name: str):
    """Click the search box in LINE and type a contact name."""
    bounds = _get_line_window_bounds()
    if not bounds:
        return False

    _focus_line_window()
    time.sleep(0.3)

    # Search box is near top of sidebar, roughly at (x + 150, y + 55)
    search_x = bounds['x'] + 150
    search_y = bounds['y'] + 55
    _click_at(search_x, search_y)
    time.sleep(0.3)

    # Clear existing search
    subprocess.run(["osascript", "-e", """
tell application "System Events"
    keystroke "a" using command down
    key code 51
end tell
"""], capture_output=True, timeout=5)
    time.sleep(0.2)

    # Type search term
    _type_text(name)
    time.sleep(1)  # Wait for search results

    return True


def _click_first_result():
    """Click the first search result in LINE."""
    bounds = _get_line_window_bounds()
    if not bounds:
        return False

    # First result is roughly at (x + 150, y + 120)
    result_x = bounds['x'] + 150
    result_y = bounds['y'] + 120
    _click_at(result_x, result_y)
    time.sleep(0.5)
    return True


def _click_message_input():
    """Click the message input area in LINE."""
    bounds = _get_line_window_bounds()
    if not bounds:
        return False

    # Message input is at bottom-right of the window
    input_x = bounds['x'] + bounds['w'] // 2 + 150
    input_y = bounds['y'] + bounds['h'] - 40
    _click_at(input_x, input_y)
    time.sleep(0.3)
    return True


class LinePersonalAdapter(ChannelAdapter):
    channel_name = 'line_personal'

    def __init__(self):
        self._window_id = None

    def _ensure_window(self) -> bool:
        self._window_id = _find_line_window_id()
        return self._window_id is not None

    def scan(self) -> list:
        """Take screenshot of LINE and return path for vision analysis.

        Unlike other adapters, LINE scan returns screenshot paths
        that need to be read by Claude's vision to extract messages.
        """
        if not self._ensure_window():
            return []

        path = _screenshot_line()
        if path:
            return [{'type': 'screenshot', 'path': path, 'channel': 'line_personal'}]
        return []

    def send(self, handle: str, text: str) -> bool:
        """Send a message to a LINE contact.

        Args:
            handle: Contact display name (as shown in LINE)
            text: Message to send
        """
        if not self._ensure_window():
            return False

        # 1. Search for contact
        if not _click_search_and_type(handle):
            return False

        # 2. Click first result
        if not _click_first_result():
            return False

        # 3. Click message input
        if not _click_message_input():
            return False

        # 4. Type message
        _type_text(text)
        time.sleep(0.3)

        # 5. Send (Enter)
        _press_enter()
        time.sleep(0.5)

        return True

    def get_profile(self, handle: str) -> dict:
        return {'handle': handle, 'channel': 'line_personal'}

    def get_contacts_screenshot(self) -> str | None:
        """Take a screenshot of the contacts list for vision analysis."""
        if not self._ensure_window():
            return None

        # Click the contacts tab (person icon, top-left)
        bounds = _get_line_window_bounds()
        if bounds:
            _focus_line_window()
            contacts_x = bounds['x'] + 20
            contacts_y = bounds['y'] + 40
            _click_at(contacts_x, contacts_y)
            time.sleep(0.5)

        return _screenshot_line()

    def get_chat_screenshot(self, contact_name: str) -> str | None:
        """Open a chat with a contact and take a screenshot."""
        if not self._ensure_window():
            return None

        if not _click_search_and_type(contact_name):
            return None

        if not _click_first_result():
            return None

        time.sleep(1)
        return _screenshot_line()

    def is_available(self) -> bool:
        """Check if LINE Chrome extension window is open."""
        return _find_line_window_id() is not None

    def supports_feed(self) -> bool:
        return True
