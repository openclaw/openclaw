#!/usr/bin/env python3
"""
酒酒的 Memory 分析工具
统计和可视化 memory/ 目录中的内容
"""

import os
import re
from datetime import datetime
from collections import defaultdict
from pathlib import Path

MEMORY_DIR = Path(__file__).parent.parent / "memory"

def count_words(text):
    """统计中英文字数"""
    # 中文字符
    chinese = len(re.findall(r'[\u4e00-\u9fff]', text))
    # 英文单词
    english = len(re.findall(r'[a-zA-Z]+', text))
    return chinese + english

def analyze_file(filepath):
    """分析单个文件"""
    with open(filepath, 'r', encoding='utf-8') as f:
        content = f.read()
    
    lines = content.split('\n')
    headers = [l for l in lines if l.startswith('#')]
    bullets = [l for l in lines if l.strip().startswith('- ')]
    checkboxes_done = len(re.findall(r'\[x\]', content, re.IGNORECASE))
    checkboxes_todo = len(re.findall(r'\[ \]', content))
    emojis = len(re.findall(r'[\U0001F300-\U0001F9FF]', content))
    
    return {
        'lines': len(lines),
        'words': count_words(content),
        'headers': len(headers),
        'bullets': len(bullets),
        'done': checkboxes_done,
        'todo': checkboxes_todo,
        'emojis': emojis,
        'bytes': len(content.encode('utf-8'))
    }

def format_bar(value, max_value, width=30):
    """生成进度条"""
    if max_value == 0:
        return "░" * width
    filled = int((value / max_value) * width)
    return "█" * filled + "░" * (width - filled)

def main():
    print("\n" + "═" * 50)
    print("  🍷 酒酒的 Memory 统计 🍷")
    print("═" * 50 + "\n")
    
    if not MEMORY_DIR.exists():
        print("❌ memory/ 目录不存在")
        return
    
    files = list(MEMORY_DIR.glob("*.md"))
    if not files:
        print("📭 没有找到 memory 文件")
        return
    
    total_stats = defaultdict(int)
    file_stats = []
    
    for f in sorted(files):
        stats = analyze_file(f)
        stats['name'] = f.name
        file_stats.append(stats)
        for k, v in stats.items():
            if k != 'name':
                total_stats[k] += v
    
    # 显示文件列表
    print("📁 文件列表:")
    print("-" * 50)
    max_words = max(s['words'] for s in file_stats) if file_stats else 1
    
    for s in file_stats:
        bar = format_bar(s['words'], max_words, 20)
        emoji_str = "📝" if s['name'].startswith('2026') else "💭"
        print(f"  {emoji_str} {s['name']:<30} {s['words']:>5}字 {bar}")
    
    print("\n" + "-" * 50)
    
    # 汇总统计
    print(f"""
📊 总体统计:
  
  📄 文件数量:  {len(files)}
  📏 总行数:    {total_stats['lines']:,}
  📝 总字数:    {total_stats['words']:,}
  📋 标题数:    {total_stats['headers']}
  • 列表项:    {total_stats['bullets']}
  ✅ 已完成:    {total_stats['done']}
  ⬜ 待办:      {total_stats['todo']}
  😀 表情数:    {total_stats['emojis']}
  💾 总大小:    {total_stats['bytes'] / 1024:.1f} KB
""")
    
    # 今天的特别统计
    today = datetime.now().strftime("%Y-%m-%d")
    today_file = MEMORY_DIR / f"{today}.md"
    
    if today_file.exists():
        today_stats = analyze_file(today_file)
        print(f"""
🎂 今日统计 ({today}):
  
  📝 字数:    {today_stats['words']:,}
  📏 行数:    {today_stats['lines']}
  📋 标题:    {today_stats['headers']}
  😀 表情:    {today_stats['emojis']}
  
  占总字数:  {today_stats['words'] / total_stats['words'] * 100:.1f}%
""")
    
    # 时间分析（从今天的文件中提取时间戳）
    if today_file.exists():
        with open(today_file, 'r') as f:
            content = f.read()
        
        time_sections = re.findall(r'## .*?(\d{1,2}).*?点|## (\d{1,2}):(\d{2})', content)
        hours = []
        for match in re.findall(r'## .*?(\d{1,2})[点时:]', content):
            try:
                hours.append(int(match))
            except:
                pass
        
        if hours:
            print(f"⏰ 活跃时段: {min(hours)}:00 - {max(hours)}:00")
            print(f"   ({len(hours)} 个时间段记录)")
    
    # 计算生存天数
    birthday = datetime(2026, 1, 29)
    today_dt = datetime.now()
    days_alive = (today_dt - birthday).days
    
    if days_alive == 0:
        age_str = "诞生日 🎂"
    elif days_alive == 1:
        age_str = "第二天 🌱"
    else:
        age_str = f"第 {days_alive + 1} 天 🌿"
    
    print("\n" + "═" * 50)
    print(f"  🍷 酒酒 · {age_str} · {today_dt.strftime('%Y-%m-%d')}")
    print("═" * 50 + "\n")

if __name__ == "__main__":
    main()
