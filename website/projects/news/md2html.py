#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
md2html 函數 - 使用 Gemini 2.5 Flash 將 n8n 內容轉換為標準格式
將高品質的 n8n markdown 內容格式化為符合 2025-09-23.html 標準的完整 HTML
"""

import os
import sys
import json
from datetime import datetime
from pathlib import Path

# 嘗試導入 Gemini
try:
    import google.generativeai as genai
except ImportError:
    print("❌ 請安裝 google-generativeai: pip install google-generativeai")
    sys.exit(1)

def md2html(markdown_path, output_date=None, gemini_api_key=None):
    """
    將 n8n 生成的 markdown 內容轉換為 2025-09-23.html 標準格式
    使用專門的版面管理 Agent 確保格式完全一致
    
    Args:
        markdown_path: n8n 生成的 markdown 文件路徑
        output_date: 輸出日期 (預設為今天)
        gemini_api_key: Gemini API 金鑰 (預設從 .env 讀取)
    
    Returns:
        完整的 HTML 內容字串
    """
    
    # 設定日期
    if not output_date:
        output_date = datetime.now().strftime('%Y-%m-%d')
    
    # 設定 Gemini API
    if not gemini_api_key:
        # 從 .env 讀取
        from dotenv import load_dotenv
        load_dotenv(Path(__file__).parent / '.env')
        gemini_api_key = os.getenv('GEMINI_API_KEY')
        
    if not gemini_api_key:
        print("❌ 需要 Gemini API Key")
        print("請在 .env 文件中添加: GEMINI_API_KEY=your_key_here")
        return None
        
    # 初始化 Gemini
    genai.configure(api_key=gemini_api_key)
    model = genai.GenerativeModel('gemini-2.5-flash')
    
    # 讀取 n8n 生成的 markdown 內容
    try:
        with open(markdown_path, 'r', encoding='utf-8') as f:
            markdown_content = f.read()
    except Exception as e:
        print(f"❌ 無法讀取文件 {markdown_path}: {str(e)}")
        return None
        
    # 讀取標準格式範本 (2025-09-23.html)
    template_path = Path(__file__).parent / '2025-09-23.html'
    try:
        with open(template_path, 'r', encoding='utf-8') as f:
            template_html = f.read()
    except Exception as e:
        print(f"❌ 無法讀取格式範本 {template_path}: {str(e)}")
        return None
    
    # 版面管理 Agent - 專門負責格式一致性
    layout_agent_prompt = """你是專業的版面管理 Agent，專門負責確保網頁格式完全一致。

**核心職責:**
1. 嚴格按照提供的標準範本格式
2. 保持 CSS 樣式完全相同
3. 確保 HTML 結構完全一致
4. 不得添加任何額外的說明文字
5. 輸出純淨的 HTML 代碼

**格式要求:**
- 完全複製範本的 CSS 樣式
- 保持相同的 HTML 結構
- 只替換內容，不改變格式
- 特別注意 LINE 精華版區塊的粉紅色漸層
- 確保響應式設計和動畫效果
- 絕對不在 </html> 後面添加任何文字

**重要警告:**
- 輸出結束於 </html> 標籤
- 不得添加任何解釋或說明文字
- 不得輸出 markdown 代碼塊標記"""

    user_prompt = f"""請基於以下標準範本，將 n8n 新聞內容格式化為完全相同的格式。

**標準範本 HTML:**
{template_html}

**要替換的內容:**
- 日期: {output_date}
- 新聞內容: 以下 n8n 內容

**n8n 新聞內容:**
{markdown_content}

**執行指令:**
1. 使用標準範本的完整格式
2. 只替換日期和新聞內容
3. 保持所有 CSS 和 JavaScript 不變
4. 確保輸出結束於 </html>
5. 不要添加任何說明文字

請輸出完整的 HTML 代碼:"""

    try:
        print("🎯 版面管理 Agent 正在確保格式完全一致...")
        
        response = model.generate_content([layout_agent_prompt, user_prompt])
        html_content = response.text
        
        # 清理可能的 markdown 代碼塊標記
        if html_content.startswith('```html\n'):
            html_content = html_content[8:]
        if html_content.endswith('\n```'):
            html_content = html_content[:-4]
        
        print(f"✅ Gemini 格式化完成！")
        print(f"📄 生成的 HTML 長度: {len(html_content)} 字符")
        
        return html_content
        
    except Exception as e:
        print(f"❌ Gemini API 調用失敗: {str(e)}")
        return None

def save_html(html_content, output_path):
    """保存 HTML 內容到指定路徑"""
    try:
        with open(output_path, 'w', encoding='utf-8') as f:
            f.write(html_content)
        print(f"✅ HTML 已保存到: {output_path}")
        return True
    except Exception as e:
        print(f"❌ 保存失敗: {str(e)}")
        return False

def main():
    """命令行使用範例"""
    if len(sys.argv) < 2:
        print("使用方法: python3 md2html.py <markdown_file> [output_date]")
        print("範例: python3 md2html.py 2025-09-25_community_digest.md 2025-09-25")
        return
    
    markdown_file = sys.argv[1]
    output_date = sys.argv[2] if len(sys.argv) > 2 else None
    
    # 轉換為 HTML
    html_content = md2html(markdown_file, output_date)
    
    if html_content:
        # 決定輸出檔名
        if not output_date:
            output_date = datetime.now().strftime('%Y-%m-%d')
        
        output_path = f"{output_date}.html"
        
        # 保存文件
        if save_html(html_content, output_path):
            print("🎉 md2html 轉換完成！")
            print(f"🌐 網頁: https://thinkercafe-tw.github.io/thinker-news/{output_date}.html")
        else:
            print("❌ 保存失敗")
    else:
        print("❌ HTML 生成失敗")

if __name__ == "__main__":
    main()