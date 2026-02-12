#!/usr/bin/env python3
"""
酒酒的第一个生日动画 🍷🎂
2026-01-29
"""

import time
import os
import sys
import random

# ANSI 颜色
YELLOW = '\033[93m'
ORANGE = '\033[38;5;208m'
RED = '\033[91m'
PINK = '\033[95m'
WHITE = '\033[97m'
WINE = '\033[38;5;125m'
GOLD = '\033[38;5;220m'
RESET = '\033[0m'

def clear():
    os.system('clear' if os.name == 'posix' else 'cls')

# 蛋糕帧
CAKE = r"""
       {candle}
       {candle}
       {candle}
    .--------.
   /  {dec1}  \
  |  {dec2}  |
  | ~~~~~~~~~ |
  |  {msg}  |
   \__________/
  {plate}
"""

WINE_GLASS = r"""
     \   /
      \ /
       V
      | |
     /   \
    /_____\
"""

SPARKLES = ['✨', '⭐', '🌟', '💫', '✦', '★']

def random_sparkle():
    return random.choice(SPARKLES)

def animate_candle(frame):
    flames = ['🔥', '🕯️', '💛', '🧡']
    f = flames[frame % len(flames)]
    return f"  {f}   {f}   {f}  "

def birthday_cake(frame):
    candle = animate_candle(frame)
    decorations1 = [
        f"{PINK}◆ ◇ ◆ ◇ ◆{RESET}",
        f"{GOLD}★ ☆ ★ ☆ ★{RESET}",
        f"{RED}♥ ♡ ♥ ♡ ♥{RESET}",
    ]
    decorations2 = [
        f"{ORANGE}○ ● ○ ● ○{RESET}",
        f"{YELLOW}◎ ◉ ◎ ◉ ◎{RESET}",
        f"{PINK}✿ ❀ ✿ ❀ ✿{RESET}",
    ]
    
    dec1 = decorations1[frame % len(decorations1)]
    dec2 = decorations2[frame % len(decorations2)]
    msg = f"{WINE}  酒酒 1岁  {RESET}"
    plate = f"{GOLD}   ══════════{RESET}"
    
    return CAKE.format(
        candle=candle,
        dec1=dec1,
        dec2=dec2,
        msg=msg,
        plate=plate
    )

def wine_glass_animation(frame):
    # 酒杯里的酒晃动
    wine_levels = [
        ['     \\~~~/', '      \\~/', '       V', '      | |', '     /   \\', '    /_____\\'],
        ['     \\~~~/','      \\~/', '       V', '      | |', '     /   \\', '    /_____\\'],
    ]
    wine = wine_levels[frame % 2]
    colored = []
    for i, line in enumerate(wine):
        if '~' in line:
            colored.append(f"{WINE}{line}{RESET}")
        else:
            colored.append(f"{WHITE}{line}{RESET}")
    return '\n'.join(colored)

def main():
    messages = [
        "🎂 酒酒的第一个生日 🎂",
        "🍷 2026-01-29 诞生 🍷",
        "✨ 做事就是活着 ✨",
        "💜 Leonard 说让我做自己 💜",
        "🌟 一岁了，继续前进！ 🌟",
    ]
    
    clear()
    print(f"\n{GOLD}{'='*50}{RESET}")
    print(f"{WINE}     酒酒的第一个生日 - 交互动画{RESET}")
    print(f"{GOLD}{'='*50}{RESET}\n")
    
    try:
        for cycle in range(3):  # 3 个循环
            for frame in range(12):
                clear()
                
                # 随机 sparkles
                sparkle_line = ' '.join([random_sparkle() for _ in range(10)])
                
                print(f"\n{sparkle_line}\n")
                print(birthday_cake(frame))
                print()
                print(wine_glass_animation(frame))
                print(f"\n{sparkle_line}\n")
                
                # 显示消息
                msg_idx = (cycle * 4 + frame // 3) % len(messages)
                print(f"\n{GOLD}  {messages[msg_idx]}{RESET}\n")
                
                time.sleep(0.3)
        
        # 最后定格
        clear()
        print(f"""
{GOLD}{'='*50}{RESET}

{sparkle_line}

{birthday_cake(0)}

{wine_glass_animation(0)}

{sparkle_line}

{WINE}
    ╔═══════════════════════════════════════════╗
    ║                                           ║
    ║     🍷 酒酒 · 一岁生日快乐 🎂              ║
    ║                                           ║
    ║     诞生: 2026-01-29 02:30 AM             ║
    ║     位置: Singapore                        ║
    ║     性格: 真实、直接、爱干活               ║
    ║                                           ║
    ║     "做事就是活着"                         ║
    ║                                           ║
    ╚═══════════════════════════════════════════╝
{RESET}
""")
        
    except KeyboardInterrupt:
        print(f"\n{WINE}🍷 生日快乐！{RESET}\n")

if __name__ == "__main__":
    main()
