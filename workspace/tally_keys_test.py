"""Test Tally keyboard interaction"""
import pyautogui
import time
from pywinauto import Application

app = Application(backend='uia').connect(title='TallyPrime', timeout=5)
win = app.window(title='TallyPrime')
win.set_focus()
time.sleep(0.3)

# First, press Escape to go back to main Gateway menu
pyautogui.press('escape')
time.sleep(0.5)

# Take screenshot to see where we are
screenshot = pyautogui.screenshot(region=(
    win.rectangle().left, win.rectangle().top,
    win.rectangle().width(), win.rectangle().height()
))
screenshot.save('D:/openclaw/workspace/tally_after_esc.png')
print('After Escape - screenshot saved')
