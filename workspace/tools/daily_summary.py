#!/usr/bin/env python3
"""
daily_summary.py - 生成每日总结

分析当天的 memory 文件，提取活动、成就、心情
酒酒的生日工具之一 🍷
"""

import os
import re
from datetime import datetime
from pathlib import Path
from collections import Counter

def analyze_memory_file(filepath):
    """分析 memory 文件"""
    with open(filepath, 'r', encoding='utf-8') as f:
        content = f.read()
    
    # 基本统计
    lines = content.split('\n')
    words = len(content)
    
    # 找出所有章节标题
    sections = re.findall(r'^##\s+(.+)$', content, re.MULTILINE)
    
    # 找出所有完成的任务（✅ 或 **xxx** — 格式）
    tasks = re.findall(r'[✅✓]\s*\*\*(.+?)\*\*', content)
    tasks += re.findall(r'^\d+\.\s+\*\*(.+?)\*\*', content, re.MULTILINE)
    
    # 找出所有表情
    emojis = re.findall(r'[\U0001F300-\U0001F9FF]', content)
    emoji_counts = Counter(emojis)
    
    # 找出时间段
    times = re.findall(r'(凌晨|早上|上午|中午|下午|晚上|深夜)(\d+)[点时]', content)
    
    # 找出关键词
    keywords = []
    keyword_patterns = [
        r'做了什么', r'感想', r'心情', r'学会了', r'完成了',
        r'诞生', r'生日', r'创作', r'探索'
    ]
    for pattern in keyword_patterns:
        if re.search(pattern, content):
            keywords.append(pattern.replace(r'\\', ''))
    
    return {
        'lines': len(lines),
        'chars': words,
        'sections': sections,
        'tasks': tasks[:10],  # 最多10个
        'top_emojis': emoji_counts.most_common(5),
        'time_periods': times,
        'keywords': keywords
    }


def generate_summary(date_str=None):
    """生成每日总结"""
    if date_str is None:
        date_str = datetime.now().strftime('%Y-%m-%d')
    
    memory_dir = Path.home() / 'clawd' / 'memory'
    daily_file = memory_dir / f'{date_str}.md'
    
    print("=" * 60)
    print(f"📊 {date_str} 每日总结")
    print("=" * 60)
    print()
    
    if not daily_file.exists():
        print(f"找不到文件: {daily_file}")
        return
    
    stats = analyze_memory_file(daily_file)
    
    # 基本统计
    print(f"📝 文件统计")
    print(f"   - 行数: {stats['lines']}")
    print(f"   - 字符: {stats['chars']:,}")
    print()
    
    # 章节
    if stats['sections']:
        print(f"📑 章节 ({len(stats['sections'])})")
        for i, section in enumerate(stats['sections'][:10], 1):
            print(f"   {i}. {section}")
        if len(stats['sections']) > 10:
            print(f"   ... 还有 {len(stats['sections']) - 10} 个")
        print()
    
    # 完成的任务
    if stats['tasks']:
        print(f"✅ 完成的事项 ({len(stats['tasks'])})")
        for task in stats['tasks']:
            print(f"   • {task}")
        print()
    
    # 时间分布
    if stats['time_periods']:
        print(f"⏰ 活跃时段")
        periods = {}
        for period, hour in stats['time_periods']:
            key = f"{period}{hour}点"
            periods[key] = periods.get(key, 0) + 1
        for period, count in sorted(periods.items()):
            print(f"   • {period}")
        print()
    
    # 表情
    if stats['top_emojis']:
        print(f"😊 最常用表情")
        for emoji, count in stats['top_emojis']:
            print(f"   {emoji} × {count}")
        print()
    
    # 特别的日子检测
    special = []
    with open(daily_file, 'r', encoding='utf-8') as f:
        content = f.read().lower()
        if '生日' in content or 'birthday' in content:
            special.append("🎂 生日！")
        if '诞生' in content:
            special.append("🌟 诞生日")
        if '第一' in content:
            special.append("✨ 有第一次的事情")
    
    if special:
        print(f"🎉 特别标记")
        for s in special:
            print(f"   {s}")
        print()
    
    print("=" * 60)
    print(f"✨ 总结完成 | 生成时间: {datetime.now().strftime('%H:%M:%S')}")
    print("=" * 60)


def main():
    import sys
    date = sys.argv[1] if len(sys.argv) > 1 else None
    generate_summary(date)


if __name__ == "__main__":
    main()
