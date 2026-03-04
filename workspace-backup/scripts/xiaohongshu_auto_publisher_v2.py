#!/usr/bin/env python3
"""
小红书自动发布器 v2 - 浏览器自动化版本
使用 OpenClaw Browser 工具实现自动发布
"""

import sys
import os
import json
import re
import time
from datetime import datetime, timedelta
from pathlib import Path


# 配置
COOKIE_FILE = "/home/node/.openclaw/config/xhs_cookie.json"
COOKIE_EXPIRY_HOURS = 12
XHS_PUBLISH_URL = "https://creator.xiaohongshu.com/publish/publish"
XHS_LOGIN_URL = "https://www.xiaohongshu.com"


class XiaohongshuPublisherV2:
    """小红书自动发布器 v2（浏览器自动化）"""

    def __init__(self):
        """初始化"""
        self.cookie_cache = self._load_cookie_cache()
        print(f"🔧 初始化发布器 v2")
        print(f"   Cookie 状态: {'有效' if self.cookie_cache else '无效或过期'}")

    def _load_cookie_cache(self):
        """加载 Cookie 缓存"""
        if os.path.exists(COOKIE_FILE):
            try:
                with open(COOKIE_FILE, 'r') as f:
                    cache = json.load(f)
                # 检查缓存是否过期
                cached_time = datetime.fromisoformat(cache.get('timestamp', '2020-01-01'))
                if datetime.now() - cached_time < timedelta(hours=COOKIE_EXPIRY_HOURS):
                    print(f"   Cookie 有效期: 剩余 {int((timedelta(hours=COOKIE_EXPIRY_HOURS) - (datetime.now() - cached_time)).total_seconds() / 3600)} 小时")
                    return cache
                else:
                    print(f"   Cookie 已过期（{cached_time}）")
            except Exception as e:
                print(f"   ⚠️ Cookie 缓存加载失败: {e}")
        return None

    def parse_content_file(self, file_path):
        """解析内容文件（同 v1 版本）"""
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

    def check_login_status_with_browser(self):
        """使用浏览器检查登录状态"""
        print(f"\n🌐 使用浏览器检查登录状态...")

        # TODO: 集成 OpenClaw Browser 工具
        # 这里需要调用 browser 工具来打开页面并检查登录状态
        # 目前先返回 False（未登录）
        return False

    def publish_with_browser(self, content_file):
        """使用浏览器自动发布"""
        print(f"\n📝 读取内容文件: {content_file}")

        # 解析内容
        parsed = self.parse_content_file(content_file)
        title = parsed['title']
        body = parsed['body']
        tags = parsed['tags']

        print(f"📌 标题: {title}")
        print(f"📄 正文长度: {len(body)} 字符")
        print(f"🏷️ 标签: {', '.join(tags)}")

        # 检查登录状态
        if not self.check_login_status_with_browser():
            print(f"\n⚠️ 未登录，需要先登录小红书")
            print(f"   请按以下步骤操作：")
            print(f"   1. 打开浏览器访问: {XHS_LOGIN_URL}")
            print(f"   2. 扫码登录")
            print(f"   3. 登录成功后，系统将自动继续发布")
            return False

        # TODO: 使用浏览器自动化发布
        # 1. 打开发布页面
        # 2. 填写标题
        # 3. 填写正文
        # 4. 添加标签（如果有）
        # 5. 点击发布按钮
        # 6. 等待发布完成

        print(f"\n⚠️ 浏览器自动化功能开发中...")
        print(f"   请手动发布:")
        print(f"   1. 访问: {XHS_PUBLISH_URL}")
        print(f"   2. 复制以下内容:")
        print(f"   " + "-" * 60)
        print(f"   标题: {title}")
        print(f"   " + "-" * 60)
        print(f"   正文:\n{body}")
        if tags:
            print(f"   " + "-" * 60)
            print(f"   标签: {' '.join(tags)}")
        print(f"   " + "-" * 60)

        return False

    def publish(self, content_file):
        """发布笔记（路由到 v1 或 v2）"""
        print(f"\n🚀 小红书自动发布器 v2")

        # 检查 Cookie
        if not self.cookie_cache:
            print(f"\n⚠️ Cookie 已过期或不存在，需要重新登录")
            print(f"   请按以下步骤操作：")
            print(f"   1. 打开浏览器访问: {XHS_LOGIN_URL}")
            print(f"   2. 扫码登录")
            print(f"   3. 登录成功后，使用浏览器插件导出 Cookie")
            print(f"   4. 保存 Cookie 到文件: {COOKIE_FILE}")

            # 提供手动发布指引
            parsed = self.parse_content_file(content_file)
            title = parsed['title']
            body = parsed['body']
            tags = parsed['tags']

            print(f"\n   或手动发布:")
            print(f"   " + "-" * 60)
            print(f"   标题: {title}")
            print(f"   " + "-" * 60)
            print(f"   正文:\n{body}")
            if tags:
                print(f"   " + "-" * 60)
                print(f"   标签: {' '.join(tags)}")
            print(f"   " + "-" * 60)

            return False

        # 尝试浏览器自动化
        return self.publish_with_browser(content_file)


def main():
    """主函数"""
    if len(sys.argv) < 2:
        print("使用方法: python3 xiaohongshu_auto_publisher_v2.py <content_file>")
        print("\n示例:")
        print("  python3 xiaohongshu_auto_publisher_v2.py xiaohongshu_content/xhs_1772234975912_1.md")
        sys.exit(1)

    content_file = sys.argv[1]

    if not os.path.exists(content_file):
        print(f"❌ 文件不存在: {content_file}")
        sys.exit(1)

    publisher = XiaohongshuPublisherV2()
    result = publisher.publish(content_file)

    if result:
        print(f"\n✅ 发布准备完成")
    else:
        print(f"\n❌ 发布失败")
        sys.exit(1)


if __name__ == '__main__':
    main()
