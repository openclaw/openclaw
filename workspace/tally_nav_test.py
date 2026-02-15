"""Test Tally two-key navigation"""
import pyautogui
import time
from pywinauto import Application

app = Application(backend='uia').connect(title='TallyPrime', timeout=5)
win = app.window(title='TallyPrime')
win.set_focus()
time.sleep(0.3)

def screenshot(name):
    time.sleep(0.5)
    rect = win.rectangle()
    ss = pyautogui.screenshot(region=(rect.left, rect.top, rect.width(), rect.height()))
    path = f'D:/openclaw/workspace/tally_{name}.png'
    ss.save(path)
    print(f'Saved: {name}')

# Test 1: Press 'V' for Vouchers
pyautogui.press('v')
screenshot('vouchers')

# Go back
pyautogui.press('escape')
screenshot('back_to_gateway')

# Test 2: Press 'C' then 'R' for Create (two-key: Cr)
# Actually in Tally, bold letters are the shortcut. "Create" has C and r highlighted
# Let's try just pressing the first highlighted letter
pyautogui.press('c')
screenshot('after_c')

# Go back
pyautogui.press('escape')
time.sleep(0.3)

# Test 3: Try "Go To" with G
pyautogui.press('g')
screenshot('goto')

pyautogui.press('escape')
screenshot('final')

print('All navigation tests complete!')
