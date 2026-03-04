#!/usr/bin/env python3
"""
小红书批量发布器 - 批量发布待发布内容

功能：
1. 扫描 xiaohongshu_content/ 目录
2. 读取所有待发布的 .md 文件
3. 逐个发布（使用 xiaohongshu_auto_publisher.py）
4. 发布成功后移到 published/ 目录
5. 记录发布结果

使用方法：
    python3 xiaohongshu_batch_publisher.py [--limit N]
"""

import os
import sys
import json
import shutil
from datetime import datetime
from pathlib import Path


# 配置
CONTENT_DIR = "/home/node/.openclaw/workspace/xiaohongshu_content"
PUBLISHED_DIR = "/home/node/.openclaw/workspace/xiaohongshu_content/published"
RESULT_FILE = "/home/node/.openclaw/workspace/xiaohongshu_publish_results.json"
AUTO_PUBLISHER = "/home/node/.openclaw/workspace/scripts/xiaohongshu_auto_publisher.py"


def scan_content_files():
    """扫描待发布内容"""
    content_dir = Path(CONTENT_DIR)
    published_dir = Path(PUBLISHED_DIR)

    # 获取所有 .md 文件（排除 published 目录）
    md_files = []
    for md_file in content_dir.glob("*.md"):
        # 排除 published 目录
        if not str(md_file).startswith(str(published_dir)):
            # 排除清单文件和发布引导文件
            file_name = md_file.name
            if "清单" not in file_name and "发布" not in file_name:
                md_files.append(md_file)

    # 按修改时间排序
    md_files.sort(key=lambda x: x.stat().st_mtime)

    return md_files


def publish_single_file(md_file):
    """发布单个文件"""
    print(f"\n{'='*60}")
    print(f"📝 正在发布: {md_file.name}")
    print(f"{'='*60}")

    # 调用自动发布脚本
    import subprocess
    result = subprocess.run(
        [sys.executable, AUTO_PUBLISHER, str(md_file)],
        capture_output=True,
        text=True
    )

    if result.returncode == 0:
        print(f"✅ 发布成功: {md_file.name}")

        # 移动到 published 目录
        published_dir = Path(PUBLISHED_DIR)
        published_dir.mkdir(parents=True, exist_ok=True)

        # 添加时间戳到文件名
        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        new_name = f"{timestamp}_{md_file.name}"
        new_path = published_dir / new_name

        shutil.move(str(md_file), str(new_path))
        print(f"📁 已移动到: {new_path}")

        return True, None
    else:
        print(f"❌ 发布失败: {md_file.name}")
        print(f"错误信息:\n{result.stderr}")
        return False, result.stderr


def main():
    """主函数"""
    import argparse

    parser = argparse.ArgumentParser(description="小红书批量发布器")
    parser.add_argument("--limit", type=int, default=1, help="发布数量限制（默认1）")
    parser.add_argument("--dry-run", action="store_true", help="仅扫描，不实际发布")
    args = parser.parse_args()

    # 扫描待发布内容
    print("📂 扫描待发布内容...")
    md_files = scan_content_files()

    if not md_files:
        print("✅ 没有待发布的内容")
        return

    print(f"📊 找到 {len(md_files)} 篇待发布内容:")
    for i, md_file in enumerate(md_files, 1):
        print(f"  {i}. {md_file.name}")

    if args.dry_run:
        print("\n🔍 模式：仅扫描，不实际发布")
        return

    # 限制发布数量
    if args.limit < len(md_files):
        md_files = md_files[:args.limit]
        print(f"\n📌 将发布前 {args.limit} 篇")

    # 逐个发布
    print(f"\n🚀 开始发布...")
    results = []

    for md_file in md_files:
        success, error = publish_single_file(md_file)

        results.append({
            "file": md_file.name,
            "success": success,
            "error": error,
            "timestamp": datetime.now().isoformat()
        })

        # 发布失败则停止
        if not success:
            print("\n⚠️ 发布失败，停止批处理")
            break

        # 成功后继续下一个
        time.sleep(1)  # 避免过快

    # 保存结果
    with open(RESULT_FILE, 'w', encoding='utf-8') as f:
        json.dump(results, f, indent=2, ensure_ascii=False)

    # 汇总结果
    success_count = sum(1 for r in results if r["success"])
    fail_count = len(results) - success_count

    print(f"\n{'='*60}")
    print(f"📊 发布完成")
    print(f"{'='*60}")
    print(f"✅ 成功: {success_count}")
    print(f"❌ 失败: {fail_count}")
    print(f"📄 结果文件: {RESULT_FILE}")
    print(f"{'='*60}")

    # 记录到 daily-notes
    daily_notes_file = f"/home/node/.openclaw/workspace/memory/daily-notes/{datetime.now().strftime('%Y-%m-%d')}.md"
    log_entry = f"""
### [小红书批量发布] (发布完成)
- 状态：{'部分成功' if fail_count > 0 else '全部成功'}
- 发布数量：{len(results)} 篇
- 成功：{success_count} 篇
- 失败：{fail_count} 篇
- 结果文件：{RESULT_FILE}
- 检索标签：#小红书 #批量发布 #内容发布
"""

    try:
        with open(daily_notes_file, 'a', encoding='utf-8') as f:
            f.write(log_entry)
        print(f"✅ 已记录到: {daily_notes_file}")
    except Exception as e:
        print(f"⚠️ 记录日志失败: {e}")


if __name__ == '__main__':
    main()
