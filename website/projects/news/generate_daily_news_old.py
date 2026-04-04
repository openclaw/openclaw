#!/usr/bin/env python3
"""
Thinker News Daily Generator
自動生成每日AI新聞並更新GitHub Pages
"""

import os
import sys
import json
import subprocess
from datetime import datetime
from pathlib import Path

# 添加父目錄到路徑以導入生成器
sys.path.append('/Users/thinkercafe/Documents/ProjectChimera_MemoryPalace')
from avery_ai_news_generator import AveryNewsGenerator

class ThinkerNewsPublisher:
    def __init__(self):
        self.repo_path = Path('/Users/thinkercafe/Documents/thinker-news')
        self.generator = AveryNewsGenerator()
        
    def generate_daily_content(self):
        """生成今日內容"""
        print("🚀 開始生成今日AI科技日報...")
        results = self.generator.generate_outputs()
        
        if "error" in results:
            print(f"❌ 生成失敗: {results['error']}")
            return None
            
        return results
    
    def create_daily_html(self, content: str, date_str: str):
        """將Markdown內容轉換為HTML頁面"""
        
        # 解析Markdown內容
        lines = content.split('\n')
        html_content = self._parse_markdown_to_html(lines, date_str)
        
        # 生成完整HTML頁面
        html_template = f"""<!DOCTYPE html>
<html lang="zh-TW">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>{date_str} AI 科技日報 | Thinker News</title>
    <meta name="description" content="{date_str} AI科技重點新聞精選 - Thinker News">
    <link rel="icon" href="data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 100 100%22><text y=%22.9em%22 font-size=%2290%22>🤖</text></svg>">
    <style>
        {self._get_css_styles()}
    </style>
</head>
<body>
    <div class="container">
        <a href="./index.html" class="back-link">← 返回首頁</a>
        
        <header class="article-header">
            <div class="article-date">📅 {date_str}</div>
            <h1 class="article-title">🤖 AI 科技日報精選</h1>
        </header>
        
        {html_content}
        
        <div class="footer-nav">
            <a href="./index.html" class="nav-button">🏠 返回首頁</a>
            <a href="https://github.com/ThinkerCafe-tw/thinker-news" class="nav-button" target="_blank">⭐ GitHub</a>
        </div>
    </div>
    
    <script>
        {self._get_javascript()}
    </script>
</body>
</html>"""
        
        return html_template
    
    def _parse_markdown_to_html(self, lines, date_str):
        """將Markdown轉換為HTML"""
        html_sections = []
        current_section = []
        current_section_title = ""
        
        for line in lines:
            line = line.strip()
            if not line:
                continue
                
            if line.startswith('### '):
                # 保存前一個section
                if current_section:
                    html_sections.append(self._build_section(current_section_title, current_section))
                    current_section = []
                
                current_section_title = line[4:]  # 移除 '### '
            elif line.startswith('**') and line.endswith('**'):
                # 標題項目
                current_section.append(('title', line[2:-2]))  # 移除 **
            elif line.startswith('- '):
                # 列表項目
                current_section.append(('item', line[2:]))
            elif line.startswith('[閱讀更多]') or line.startswith('([閱讀更多]'):
                # 連結
                current_section.append(('link', line))
            else:
                # 普通文字
                current_section.append(('text', line))
        
        # 處理最後一個section
        if current_section:
            html_sections.append(self._build_section(current_section_title, current_section))
        
        return '\n'.join(html_sections)
    
    def _build_section(self, title, content):
        """建立HTML section"""
        # 為深度洞察section添加特殊樣式
        if '深度洞察分析' in title:
            section_html = f'<div class="content-section insight-section"><h2>{title}</h2>'
            section_html += '<div class="insight-dashboard">'
        else:
            section_html = f'<div class="content-section"><h2>{title}</h2>'
        
        current_item = {}
        
        for content_type, text in content:
            if content_type == 'title':
                if current_item:
                    section_html += self._build_item_html(current_item)
                current_item = {'title': text, 'content': [], 'link': ''}
            elif content_type == 'item':
                if '：' in text or ' - ' in text:
                    current_item = {'title': text, 'content': [], 'link': ''}
                else:
                    if current_item:
                        current_item['content'].append(text)
            elif content_type == 'link':
                if current_item:
                    current_item['link'] = text
            elif content_type == 'text':
                if current_item:
                    current_item['content'].append(text)
                else:
                    section_html += f'<p>{text}</p>'
        
        # 處理最後一個item
        if current_item:
            section_html += self._build_item_html(current_item)
        
        section_html += '</div>'
        return section_html
    
    def _build_item_html(self, item):
        """建立單個item的HTML"""
        if not item.get('title'):
            return ''
            
        html = f'<h3>{item["title"]}</h3>'
        
        for content in item['content']:
            html += f'<p>{content}</p>'
        
        if item.get('link'):
            # 提取連結URL
            link_text = item['link']
            if '](http' in link_text:
                start = link_text.find('](') + 2
                end = link_text.find(')', start)
                url = link_text[start:end]
                html += f'<p><a href="{url}" class="news-link external-link" target="_blank">閱讀更多</a></p>'
        
        return html
    
    def _get_css_styles(self):
        """返回CSS樣式"""
        return """
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { 
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Microsoft JhengHei', sans-serif;
            line-height: 1.7; color: #333; 
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            min-height: 100vh;
        }
        .insight-section { 
            background: linear-gradient(135deg, rgba(102, 126, 234, 0.1), rgba(118, 75, 162, 0.1));
            border: 2px solid #667eea; position: relative;
        }
        .insight-section::before { 
            content: "🔍"; position: absolute; top: 15px; right: 20px;
            font-size: 1.5em; opacity: 0.7;
        }
        .insight-dashboard { 
            background: rgba(255, 255, 255, 0.1); padding: 20px; border-radius: 10px;
            margin: 15px 0; border-left: 4px solid #667eea;
        }
        .container { max-width: 800px; margin: 0 auto; padding: 20px; }
        .back-link { 
            display: inline-block; margin-bottom: 20px; color: white; text-decoration: none;
            background: rgba(255, 255, 255, 0.2); padding: 10px 20px; border-radius: 20px;
            transition: all 0.3s ease; backdrop-filter: blur(10px);
        }
        .back-link:hover { background: rgba(255, 255, 255, 0.3); transform: translateX(-5px); }
        .article-header { 
            text-align: center; background: rgba(255, 255, 255, 0.95);
            backdrop-filter: blur(10px); border-radius: 20px; padding: 40px 30px;
            margin-bottom: 30px; box-shadow: 0 20px 40px rgba(0, 0, 0, 0.1);
        }
        .article-date { font-size: 1.1em; color: #667eea; font-weight: 600; margin-bottom: 15px; }
        .article-title { 
            font-size: 2.2em; font-weight: 800; margin-bottom: 20px;
            background: linear-gradient(45deg, #667eea, #764ba2);
            -webkit-background-clip: text; -webkit-text-fill-color: transparent;
            background-clip: text; line-height: 1.3;
        }
        .content-section { 
            background: rgba(255, 255, 255, 0.95); backdrop-filter: blur(10px);
            border-radius: 20px; padding: 40px; margin-bottom: 30px;
            box-shadow: 0 20px 40px rgba(0, 0, 0, 0.1);
        }
        .content-section h2 { 
            color: #667eea; font-size: 1.6em; margin-bottom: 20px;
            border-bottom: 2px solid #667eea; padding-bottom: 10px; font-weight: 700;
        }
        .content-section h3 { color: #555; font-size: 1.3em; margin: 25px 0 15px; font-weight: 600; }
        .content-section p { margin-bottom: 15px; line-height: 1.7; font-size: 1.05em; }
        .news-link { color: #667eea; text-decoration: none; font-weight: 600; transition: all 0.3s ease; }
        .news-link:hover { color: #764ba2; text-decoration: underline; }
        .external-link::after { content: " 🔗"; font-size: 0.8em; }
        .footer-nav { text-align: center; padding: 30px; color: white; }
        .nav-button { 
            display: inline-block; background: rgba(255, 255, 255, 0.2); color: white;
            text-decoration: none; padding: 12px 24px; border-radius: 25px; margin: 0 10px;
            transition: all 0.3s ease; backdrop-filter: blur(10px);
        }
        .nav-button:hover { background: rgba(255, 255, 255, 0.3); transform: translateY(-2px); }
        @media (max-width: 600px) {
            .container { padding: 15px; }
            .article-header { padding: 25px 20px; }
            .article-title { font-size: 1.8em; }
            .content-section { padding: 25px; }
        }
        """
    
    def _get_javascript(self):
        """返回JavaScript"""
        return """
        document.addEventListener('DOMContentLoaded', function() {
            const sections = document.querySelectorAll('.content-section');
            sections.forEach((section, index) => {
                section.style.opacity = '0';
                section.style.transform = 'translateY(20px)';
                setTimeout(() => {
                    section.style.transition = 'all 0.6s ease';
                    section.style.opacity = '1';
                    section.style.transform = 'translateY(0)';
                }, index * 150);
            });
        });
        """
    
    def update_index_page(self, date_str: str, title: str):
        """更新首頁的新聞列表"""
        index_path = self.repo_path / 'index.html'
        
        if not index_path.exists():
            print("❌ index.html 不存在")
            return False
        
        # 讀取現有內容
        content = index_path.read_text(encoding='utf-8')
        
        # 新的新聞項目HTML
        new_item = f'''            <div class="news-item">
                <div class="news-date">📅 {date_str} (今日)</div>
                <div class="news-title">🚀 {title}</div>
                <div class="news-description">
                    今日AI科技重點新聞精選，涵蓋最新的工具應用、產業趨勢與安全警報。
                </div>
                <a href="./{date_str}.html" class="news-link">閱讀完整報告 📖</a>
            </div>'''
        
        # 替換舊的今日新聞
        start_marker = '<div class="news-item">'
        end_marker = '</div>'
        
        start_idx = content.find(start_marker)
        if start_idx != -1:
            # 找到第一個news-item的結束位置
            temp_content = content[start_idx:]
            count = 0
            end_idx = start_idx
            
            for i, char in enumerate(temp_content):
                if temp_content[i:i+5] == '<div ':
                    count += 1
                elif temp_content[i:i+6] == '</div>':
                    count -= 1
                    if count == 0:
                        end_idx = start_idx + i + 6
                        break
            
            # 替換內容
            updated_content = content[:start_idx] + new_item + content[end_idx:]
            
            # 寫回檔案
            index_path.write_text(updated_content, encoding='utf-8')
            print("✅ 首頁已更新")
            return True
        
        print("❌ 無法找到要替換的新聞項目")
        return False
    
    def commit_and_push(self, date_str: str):
        """提交並推送到GitHub"""
        try:
            os.chdir(self.repo_path)
            
            # Git操作
            subprocess.run(['git', 'add', '.'], check=True)
            subprocess.run(['git', 'commit', '-m', f'Add daily news for {date_str}'], check=True)
            subprocess.run(['git', 'push', 'origin', 'main'], check=True)
            
            print("✅ 已推送到GitHub")
            return True
            
        except subprocess.CalledProcessError as e:
            print(f"❌ Git操作失敗: {e}")
            return False
    
    def publish_daily(self):
        """完整的每日發布流程"""
        today = datetime.now().strftime('%Y-%m-%d')
        print(f"📅 開始發布 {today} 的AI科技日報...")
        
        # 1. 生成內容
        results = self.generate_daily_content()
        if not results:
            return False
        
        # 2. 創建HTML頁面
        notion_content = results['notion_version']
        html_content = self.create_daily_html(notion_content, today)
        
        # 保存HTML檔案
        html_path = self.repo_path / f'{today}.html'
        html_path.write_text(html_content, encoding='utf-8')
        print(f"✅ 已創建 {today}.html")
        
        # 3. 更新首頁
        title = "今日AI科技重點新聞精選"
        self.update_index_page(today, title)
        
        # 4. 提交到GitHub
        success = self.commit_and_push(today)
        
        if success:
            print(f"""
🎉 發布完成！
📄 網頁: https://thinkercafe-tw.github.io/thinker-news/{today}.html
🏠 首頁: https://thinkercafe-tw.github.io/thinker-news/
            """)
        
        return success

def main():
    """主函數"""
    publisher = ThinkerNewsPublisher()
    success = publisher.publish_daily()
    
    if success:
        print("🚀 Thinker News 每日發布成功！")
    else:
        print("❌ 發布失敗，請檢查錯誤訊息")
    
    return success

if __name__ == "__main__":
    main()