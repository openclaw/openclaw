#!/usr/bin/env python3
"""
小红书自动发布器 - 基于 OpenClaw Browser 工具

功能：
1. 自动登录（Cookie 缓存 12 小时）
2. 自动发布笔记（标题、正文、图片）
3. 话题标签识别（最后一行 #标签）
4. 发布结果记录

使用方法：
    python3 xiaohongshu_auto_publisher.py <content_file>
"""

import json
import os
import sys
import re
import time
from datetime import datetime, timedelta
from pathlib import Path


# 配置
COOKIE_FILE = "/home/node/.openclaw/config/xhs_cookie.json"
COOKIE_EXPIRY_HOURS = 12
XHS_PUBLISH_URL = "https://creator.xiaohongshu.com/publish/publish"
XHS_LOGIN_URL = "https://www.xiaohongshu.com"


class XiaohongshuPublisher:
    """小红书自动发布器"""

    def __init__(self):
        self.cookie_cache = self._load_cookie_cache()

    def _load_cookie_cache(self):
        """加载 Cookie 缓存"""
        if os.path.exists(COOKIE_FILE):
            try:
                with open(COOKIE_FILE, 'r') as f:
                    cache = json.load(f)
                # 检查缓存是否过期
                cached_time = datetime.fromisoformat(cache.get('timestamp', '2020-01-01'))
                if datetime.now() - cached_time < timedelta(hours=COOKIE_EXPIRY_HOURS):
                    return cache
            except Exception as e:
                print(f"⚠️ Cookie 缓存加载失败: {e}")
        return None

    def _save_cookie_cache(self, cookies):
        """保存 Cookie 缓存"""
        try:
            cache = {
                'timestamp': datetime.now().isoformat(),
                'cookies': cookies
            }
            os.makedirs(os.path.dirname(COOKIE_FILE), exist_ok=True)
            with open(COOKIE_FILE, 'w') as f:
                json.dump(cache, f, indent=2)
            print(f"✅ Cookie 已缓存，有效期 {COOKIE_EXPIRY_HOURS} 小时")
        except Exception as e:
            print(f"⚠️ Cookie 缓存保存失败: {e}")

    def check_login_status(self):
        """检查登录状态"""
        if self.cookie_cache:
            age = datetime.now() - datetime.fromisoformat(self.cookie_cache['timestamp'])
            if age < timedelta(hours=COOKIE_EXPIRY_HOURS):
                print(f"✅ Cookie 有效（剩余 {COOKIE_EXPIRY_HOURS - age.seconds//3600} 小时）")
                return True
        print("⚠️ Cookie 已过期或不存在，需要重新登录")
        return False

    def parse_content_file(self, file_path):
        """解析内容文件

        支持两种格式：
        1. 标准格式：#标题\n元数据\n---\n正文\n#标签
        2. 指令格式：**标题**：xxx\n**正文**：xxx
        """
        with open(file_path, 'r', encoding='utf-8') as f:
            content = f.read()

        lines = content.split('\n')

        # 方案1：标准格式（第一行是 #标题）
        if lines and lines[0].strip().startswith('#'):
            title = lines[0].strip().lstrip('#').strip()

            # 找到正文开始位置（第一个 --- 之后）
            body_start_idx = 0
            for i, line in enumerate(lines):
                if line.strip() == '---':
                    body_start_idx = i + 1
                    break

            # 找到正文结束位置（遇到 --- 或新的 ## 标题之前）
            body_end_idx = len(lines)
            for i in range(body_start_idx, len(lines)):
                line = lines[i].strip()
                if line == '---' or (line.startswith('##') and i > body_start_idx):
                    body_end_idx = i
                    break

            # 提取正文
            body_lines = []
            in_metadata = True
            for i in range(body_start_idx, body_end_idx):
                line = lines[i]
                # 跳过空行和元数据
                if i < body_start_idx + 5:
                    # 开头几行可能是元数据，跳过
                    if line.startswith('分类：') or line.startswith('生成时间：'):
                        continue
                body_lines.append(line)

            # 提取标签（在正文最后几行查找 #标签 格式）
            tags = []
            if body_lines:
                # 检查正文最后几行是否有纯标签行
                for i in range(len(body_lines) - 1, -1, -1):
                    line = body_lines[i].strip()
                    # 跳过空行
                    if not line:
                        continue
                    # 跳过 Markdown 标题（## xxx）
                    if line.startswith('##'):
                        continue
                    # 检查是否是纯标签行（只包含 #标签，没有其他内容）
                    if re.match(r'^#\S+(?:\s+#\S+)*$', line):
                        tags = re.findall(r'#\S+', line)
                        # 移除标签行和前面的空行
                        body_lines = body_lines[:i]
                        # 移除后面的空行
                        while body_lines and not body_lines[-1].strip():
                            body_lines.pop()
                        break
                    # 如果到了正文的主要内容部分，停止查找
                    if line and not line.startswith('#'):
                        break

            # 组合正文
            body = '\n'.join(body_lines).strip()

        # 方案2：指令格式（**标题**：xxx）
        else:
            title_match = re.search(r'\*\*标题\*\*.*?:?\s*```\s*(.+?)\s*```', content, re.DOTALL)
            if title_match:
                title = title_match.group(1).strip()
            else:
                # 如果没有明确的标题，使用文件名
                title = os.path.basename(file_path).replace('.md', '')

            # 提取正文
            body_match = re.search(r'\*\*正文\*\*.*?:?\s*```\s*(.+?)\s*```', content, re.DOTALL)
            if body_match:
                body = body_match.group(1).strip()
            else:
                # 提取所有内容（排除标题和代码块）
                body_lines = []
                for line in lines:
                    if not line.strip():
                        continue
                    if line.strip().startswith('#'):
                        continue
                    if line.strip() == '```':
                        continue
                    if re.match(r'^\*\*[^*]+\*\*.*?:\s*$', line):
                        continue
                    body_lines.append(line)
                body = '\n'.join(body_lines).strip()

            # 提取标签
            tags = []
            tag_match = re.search(r'\*\*标签\*\*.*?:?\s*```\s*(.+?)\s*```', content, re.DOTALL)
            if tag_match:
                tags = re.findall(r'#\S+', tag_match.group(1))

        return {
            'title': title,
            'body': body,
            'tags': tags
        }

    def publish(self, content_file):
        """发布笔记"""
        print(f"📝 读取内容文件: {content_file}")

        # 解析内容
        parsed = self.parse_content_file(content_file)
        title = parsed['title']
        body = parsed['body']
        tags = parsed['tags']

        print(f"📌 标题: {title}")
        print(f"📄 正文长度: {len(body)} 字符")
        print(f"🏷️ 标签: {', '.join(tags)}")

        # 检查登录状态
        if not self.check_login_status():
            print("\n⚠️ 需要登录小红书")
            print("请按以下步骤操作：")
            print(f"1. 打开浏览器访问: {XHS_LOGIN_URL}")
            print("2. 扫码登录")
            print("3. 登录成功后，导出 Cookie（使用浏览器插件）")
            print("4. 将 Cookie 保存到:", COOKIE_FILE)
            print("\n💡 或者手动发布:")
            print(f"1. 访问: {XHS_PUBLISH_URL}")
            print("2. 复制以下内容:")
            print("-" * 50)
            print(f"标题: {title}")
            print("-" * 50)
            print(f"正文:\n{body}")
            if tags:
                print("-" * 50)
                print(f"标签: {' '.join(tags)}")
            print("-" * 50)
            return False

        # TODO: 实现自动发布逻辑（需要 OpenClaw Browser 工具）
        # 当前先返回手动发布指引
        print("\n⚠️ 自动发布功能开发中...")
        print("请手动发布:")
        print(f"1. 访问: {XHS_PUBLISH_URL}")
        print("2. 复制以下内容:")
        print("-" * 50)
        print(f"标题: {title}")
        print("-" * 50)
        print(f"正文:\n{body}")
        if tags:
            print("-" * 50)
            print(f"标签: {' '.join(tags)}")
        print("-" * 50)

        return True


def main():
    """主函数"""
    if len(sys.argv) < 2:
        print("使用方法: python3 xiaohongshu_auto_publisher.py <content_file>")
        print("\n示例:")
        print("  python3 xiaohongshu_auto_publisher.py xiaohongshu_content/立即发布_第1篇.md")
        sys.exit(1)

    content_file = sys.argv[1]

    if not os.path.exists(content_file):
        print(f"❌ 文件不存在: {content_file}")
        sys.exit(1)

    publisher = XiaohongshuPublisher()
    result = publisher.publish(content_file)

    if result:
        print("\n✅ 发布准备完成")
    else:
        print("\n❌ 发布失败")
        sys.exit(1)


if __name__ == '__main__':
    main()
