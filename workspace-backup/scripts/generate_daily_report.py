#!/usr/bin/env python3
"""
每日早报生成脚本
按照 HEARTBEAT.md 格式生成早报内容
"""

import os
import json
from datetime import datetime, timezone, timedelta
from pathlib import Path

# 配置路径
WORKSPACE_DIR = Path("/home/node/.openclaw/workspace")
MEMORY_DIR = WORKSPACE_DIR / "memory"
GOALS_FILE = WORKSPACE_DIR / "GOALS.md"
STATE_FILE = WORKSPACE_DIR / "STATE.yaml"
HEARTBEAT_STATE = MEMORY_DIR / "heartbeat-state.json"
DAILY_NOTES_DIR = MEMORY_DIR / "daily-notes"


def get_shanghai_time():
    """获取上海时区时间"""
    tz = timezone(timedelta(hours=8))
    return datetime.now(tz)


def get_weather():
    """获取天气信息（简化版，实际应调用天气API）"""
    # TODO: 调用 wttr.in 或 Open-Meteo API
    return "☀️ 晴转多云 15-22°C", "明天可能有雨"


def read_goals():
    """读取 GOALS.md 提取当前目标"""
    if not GOALS_FILE.exists():
        return [], []
    
    goals_content = GOALS_FILE.read_text(encoding="utf-8")
    lines = goals_content.split("\n")
    
    current_priorities = []
    suggested_actions = []
    
    in_priority_section = False
    for line in lines:
        if "当前优先级" in line or "本月重点" in line:
            in_priority_section = True
            continue
        if in_priority_section and line.strip().startswith("#"):
            break
        if in_priority_section and line.strip().startswith("-"):
            current_priorities.append(line.strip("- ").strip())
    
    return current_priorities, suggested_actions


def read_state_tasks():
    """从 STATE.yaml 读取待办任务"""
    if not STATE_FILE.exists():
        return []
    
    try:
        import yaml
    except ImportError:
        # PyYAML 未安装，使用简单的文本解析
        return []
    
    try:
        state = yaml.safe_load(STATE_FILE.read_text(encoding="utf-8"))
        pending_tasks = []
        for task in state.get("tasks", []):
            if task.get("status") == "pending":
                pending_tasks.append({
                    "id": task.get("id", ""),
                    "desc": task.get("description", ""),
                    "priority": task.get("priority", "medium")
                })
        return sorted(pending_tasks, key=lambda x: {"high": 0, "medium": 1, "low": 2}.get(x["priority"], 1))
    except:
        return []


def read_yesterday_notes():
    """读取昨天的日志，提取关键进展"""
    yesterday = get_shanghai_time() - timedelta(days=1)
    yesterday_file = DAILY_NOTES_DIR / f"{yesterday.strftime('%Y-%m-%d')}.md"
    
    if not yesterday_file.exists():
        return "昨日无记录"
    
    notes = yesterday_file.read_text(encoding="utf-8")
    
    # 提取关键结果
    results = []
    for line in notes.split("\n"):
        if "**结果**：" in line:
            results.append(line.split("**结果**：")[1].strip())
    
    if results:
        return "\n".join([f"  • {r}" for r in results[:3]])
    return "昨日无重要进展"


def get_industry_news():
    """获取行业动态（简化版，实际应调用搜索API）"""
    # TODO: 使用 web_search 或 Tavily 搜索最新 AI/技术动态
    return [
        "OpenAI 发布 GPT-4.5，性能提升显著",
        "Anthropic Claude 3.5 Sonnet 开放 API",
        "本地模型 Ollama 支持 GPU 加速"
    ]


def get_inspiration():
    """获取今日一句"""
    quotes = [
        "代码写得好，Bug 少不了 — 关键是修得快",
        "测试先行，重构无忧",
        "简单 > 复杂，清晰 > 聪明",
        "今天的不开心就到此为止吧，明天依然光芒万丈",
        "最好的代码是不需要写的代码",
        "AI 不会取代你，会用 AI 的人会"
    ]
    import random
    return random.choice(quotes)


def generate_report():
    """生成完整早报"""
    now = get_shanghai_time()
    date_str = now.strftime("%Y年%m月%d日 %A")
    
    # 收集数据
    weather_today, weather_tomorrow = get_weather()
    goals, _ = read_goals()
    tasks = read_state_tasks()
    yesterday_summary = read_yesterday_notes()
    news = get_industry_news()
    inspiration = get_inspiration()
    
    # 生成报告
    report = f"""📅 今日早报 — {date_str}

🌤 天气
  {weather_today}
  明日：{weather_tomorrow}

"""
    
    # 目标进度
    if goals:
        report += "🎯 目标进度（GOALS.md）\n"
        for i, goal in enumerate(goals[:3], 1):
            report += f"  {i}. {goal}\n"
        report += "\n"
    
    # 今日任务
    if tasks:
        report += "📋 今日任务（STATE.yaml）\n"
        for task in tasks[:5]:
            priority_emoji = {"high": "🔴", "medium": "🟡", "low": "🟢"}.get(task["priority"], "⚪")
            report += f"  {priority_emoji} {task['desc']}\n"
        report += "\n"
    
    # Agent 可自主完成的任务
    report += """🤖 Agent 可自主完成的任务（今天可帮你做）
  1. 搜集竞品动态报告（自动搜索 + 总结）
  2. 整理 memory 知识库（归档旧记录）
  3. 更新被动收入资产（EvoMap + 水产市场）

"""
    
    # 昨日回顾
    report += f"📊 昨日回顾\n{yesterday_summary}\n\n"
    
    # 行业动态
    report += "🔍 行业动态\n"
    for item in news:
        report += f"  • {item}\n"
    report += "\n"
    
    # 今日一句
    report += f"💡 今日一句\n  {inspiration}\n"
    
    return report


def main():
    """主函数"""
    try:
        report = generate_report()
        
        # 输出到控制台
        print(report)
        print("\n" + "="*60)
        
        # 保存到文件（供其他脚本读取）
        output_file = Path("/tmp/daily_report.txt")
        output_file.write_text(report, encoding="utf-8")
        print(f"✅ 早报已保存到: {output_file}")
        
        return 0
    except Exception as e:
        print(f"❌ 生成早报失败: {e}")
        import traceback
        traceback.print_exc()
        return 1


if __name__ == "__main__":
    exit(main())
