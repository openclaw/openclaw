import pyautogui
from pywinauto import Application

# Connect to Tally
app = Application(backend='uia').connect(title='TallyPrime', timeout=5)
win = app.window(title='TallyPrime')
print('Window found:', win.window_text())
print('Window rect:', win.rectangle())
print('Is visible:', win.is_visible())
print('Is enabled:', win.is_enabled())

# Try to enumerate child controls
children = win.children()
print(f'\nChild controls: {len(children)}')
for i, c in enumerate(children[:30]):
    try:
        txt = c.window_text()[:80] if c.window_text() else ""
        cls = c.friendly_class_name()
        rect = c.rectangle()
        print(f'  [{i}] {cls} | text="{txt}" | rect={rect}')
    except Exception as e:
        print(f'  [{i}] error: {e}')

# Take screenshot
win.set_focus()
import time
time.sleep(0.5)
screenshot = pyautogui.screenshot(region=(
    win.rectangle().left, win.rectangle().top,
    win.rectangle().width(), win.rectangle().height()
))
screenshot.save('D:/openclaw/workspace/tally_screen.png')
print('\nScreenshot saved to tally_screen.png')
