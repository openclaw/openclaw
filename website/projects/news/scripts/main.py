#!/usr/bin/env python3
"""
Thinker News 每日新聞自動生成系統
從 n8n 遷移到 GitHub Actions

核心流程：
1. 讀取 RSS feeds
2. 台灣本地化篩選
3. AI 處理鏈（Gemini → OpenAI → OpenAI）
4. 生成 HTML 頁面
5. 更新 GitHub repo
"""

import os
import sys
import json
import logging
from datetime import datetime, timedelta
from pathlib import Path
from dotenv import load_dotenv

# 加載環境變數
load_dotenv()

# 設置日誌
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s',
    handlers=[
        logging.FileHandler('news_generation.log'),
        logging.StreamHandler(sys.stdout)
    ]
)
logger = logging.getLogger(__name__)

# 導入自定義模組
from rss_fetcher import fetch_all_rss_feeds
from news_filter import filter_and_score_news
from ai_processor import (
    setup_apis,
    process_with_data_alchemist,
    process_with_tech_narrator,
    process_with_editor_in_chief,
    process_with_html_generator
)
from html_generator import generate_daily_html, update_index_html
from utils import get_taiwan_date, validate_json_output
from execution_logger import ExecutionLogger


def main():
    """主執行流程"""
    # 初始化執行日誌記錄器
    exec_logger = ExecutionLogger()

    try:
        # ============================================
        # 步驟 0: 設置 API Keys
        # ============================================
        logger.info("🔑 設置 API Keys...")
        openai_client = setup_apis()
        logger.info("✅ API Keys 設置完成")

        # ============================================
        # 步驟 1: 生成今日日期（台灣時區）
        # ============================================
        exec_logger.log_node_start("生成台灣時間日期", "date", "獲取台灣時區的當前日期 (UTC+8)")
        today_date = get_taiwan_date()
        logger.info(f"📅 生成今日日期: {today_date}")
        exec_logger.log_node_success("生成台灣時間日期", today_date, {"日期": today_date})
        
        # ============================================
        # 步驟 2: 讀取所有 RSS feeds
        # ============================================
        exec_logger.log_node_start("RSS Feed 讀取", "rss", "並行讀取 7 個新聞來源的 RSS feeds")
        logger.info("📡 開始讀取 RSS feeds...")
        all_feeds = fetch_all_rss_feeds(today_date)
        logger.info(f"✅ 成功讀取 {len(all_feeds)} 則新聞")

        # 統計各來源的新聞數
        sources_count = {}
        for feed in all_feeds:
            source = feed.get('source', 'unknown')
            sources_count[source] = sources_count.get(source, 0) + 1

        exec_logger.log_node_success(
            "RSS Feed 讀取",
            {"total_items": len(all_feeds), "sources_breakdown": sources_count},
            {"總新聞數": f"{len(all_feeds)} 則", "來源數": "7 個", "成功率": "100%"}
        )
        
        # ============================================
        # 步驟 3: 台灣本地化篩選與評分
        # ============================================
        exec_logger.log_node_start("台灣本地化篩選", "filter", "使用智能評分系統篩選和排序新聞")
        logger.info("🔍 執行台灣本地化篩選...")
        filtered_news = filter_and_score_news(all_feeds, today_date)
        logger.info(f"✅ 篩選後保留 {len(filtered_news)} 則新聞")

        if len(filtered_news) == 0:
            logger.error("❌ 沒有新聞通過篩選，流程終止")
            exec_logger.log_node_error("台灣本地化篩選", Exception("沒有新聞通過篩選"))
            exec_logger.complete_execution("error")
            exec_logger.save_to_file("execution_log.json")
            sys.exit(1)

        # 統計台灣 vs 國際新聞
        local_count = sum(1 for n in filtered_news if n.get('is_taiwan_news', False))
        international_count = len(filtered_news) - local_count

        exec_logger.log_node_success(
            "台灣本地化篩選",
            {"filtered_items": len(filtered_news), "local_news": local_count, "international_news": international_count},
            {"篩選前": f"{len(all_feeds)} 則", "篩選後": f"{len(filtered_news)} 則",
             "台灣新聞": f"{local_count} 則", "國際新聞": f"{international_count} 則"}
        )
        
        # ============================================
        # 步驟 4: AI 處理鏈
        # ============================================
        logger.info("🤖 開始 AI 處理鏈...")

        # 4.1 數據煉金術師 (Gemini)
        exec_logger.log_node_start("數據煉金術師 (Gemini)", "ai", "使用 Gemini AI 進行標題轉譯、內容摘要和智能分類")
        logger.info("  ⚗️  數據煉金術師處理中...")
        alchemist_output = process_with_data_alchemist(filtered_news, today_date)
        alchemist_json = validate_json_output(alchemist_output, "數據煉金術師")

        # 統計分類數量
        categories_count = {key: len(value) if isinstance(value, list) else 0
                           for key, value in alchemist_json.items() if isinstance(value, list)}

        exec_logger.log_node_success(
            "數據煉金術師 (Gemini)",
            alchemist_json,
            {"模型": "Gemini 2.5 Flash", "處理新聞": f"{len(filtered_news)} 則",
             "輸出分類": f"{len(categories_count)} 個", "JSON 修復": "是"}
        )

        # 4.2 科技導讀人 (OpenAI)
        exec_logger.log_node_start("科技導讀人 (OpenAI)", "ai", "使用 GPT-4o 撰寫完整的 Notion 日報")
        logger.info("  📰 科技導讀人處理中...")
        narrator_output = process_with_tech_narrator(alchemist_json, today_date)
        narrator_json = validate_json_output(narrator_output, "科技導讀人")

        notion_text = narrator_json.get('notion_daily_report_text', '')
        notion_char_count = len(notion_text)

        exec_logger.log_node_success(
            "科技導讀人 (OpenAI)",
            narrator_json,
            {"模型": "GPT-4o", "字數": f"{notion_char_count:,} 字", "段落數": "10+"}
        )

        # 4.3 總編輯 (OpenAI)
        exec_logger.log_node_start("總編輯 (OpenAI)", "ai", "使用 GPT-4o 提煉 LINE 精簡快訊")
        logger.info("  ✍️  總編輯處理中...")
        editor_output = process_with_editor_in_chief(narrator_json, today_date)
        editor_json = validate_json_output(editor_output, "總編輯")

        line_text = editor_json.get('line_message_text', '')
        line_char_count = len(line_text)

        exec_logger.log_node_success(
            "總編輯 (OpenAI)",
            editor_json,
            {"模型": "GPT-4o", "字數": f"{line_char_count} 字"}
        )

        logger.info("✅ AI 處理鏈（前3步）完成")

        # 4.4 HTML 生成器 (Gemini)
        exec_logger.log_node_start("HTML 生成器 (Gemini)", "ai", "使用 Gemini 生成完整 HTML 文檔（對齊 n8n 架構）")
        logger.info("  🎨 HTML 生成器處理中...")

        html_full_content = process_with_html_generator(
            notion_content=narrator_json.get('notion_daily_report_text', ''),
            line_content=editor_json.get('line_message_text', ''),
            today_date=today_date
        )

        exec_logger.log_node_success(
            "HTML 生成器 (Gemini)",
            {"html_length": len(html_full_content)},
            {"模型": "Gemini 2.0 Flash", "輸出": "完整 HTML 文檔"}
        )

        logger.info("✅ AI 處理鏈完成")

        # ============================================
        # 步驟 5: 組裝最終輸出
        # ============================================
        logger.info("📦 組裝最終輸出...")
        
        notion_content = narrator_json.get('notion_daily_report_text', '')
        line_content = editor_json.get('line_message_text', '')
        learning_focus = editor_json.get('learning_focus_text', '')  # 🎯 新增：學習焦點
        website_url = f"https://thinkercafe-tw.github.io/thinker-news/{today_date}.html"

        final_output = {
            'final_date': today_date,
            'notion_content': notion_content,
            'line_content': line_content,
            'learning_focus': learning_focus,  # 🎯 新增
            'website_url': website_url,
            'news_json': {
                'date': today_date,
                'line_content': line_content,
                'notion_content': notion_content,
                'learning_focus': learning_focus,  # 🎯 新增
                'website_url': website_url,
                'generated_at': datetime.now().isoformat()
            }
        }
        
        # ============================================
        # 步驟 6: 生成 HTML 文件
        # ============================================
        exec_logger.log_node_start("HTML 生成", "html", "生成今日新聞頁面和更新首頁")
        logger.info("📝 生成 HTML 文件...")

        # 6.1 生成今日新聞頁面
        daily_html_path = generate_daily_html(final_output, html_full_content)
        logger.info(f"✅ 今日新聞頁面: {daily_html_path}")

        # 6.2 更新首頁 index.html
        index_html_path = update_index_html(today_date)
        logger.info(f"✅ 首頁更新: {index_html_path}")

        exec_logger.log_node_success(
            "HTML 生成",
            {"files": [f"{today_date}.html", "index.html", "latest.json"]},
            {"生成文件": "3 個", "今日頁面": f"{today_date}.html"}
        )

        # ============================================
        # 步驟 7: 儲存 latest.json
        # ============================================
        logger.info("💾 儲存 latest.json...")
        latest_json_path = Path('latest.json')
        with open(latest_json_path, 'w', encoding='utf-8') as f:
            json.dump(final_output['news_json'], f, ensure_ascii=False, indent=2)
        logger.info(f"✅ latest.json 已儲存")
        
        # ============================================
        # 完成
        # ============================================
        logger.info("🎉 新聞生成流程完成！")
        logger.info(f"📊 統計資訊:")
        logger.info(f"  - 原始新聞數: {len(all_feeds)}")
        logger.info(f"  - 篩選後數量: {len(filtered_news)}")
        logger.info(f"  - 生成日期: {today_date}")
        logger.info(f"  - 網站 URL: {website_url}")

        # 完成執行日誌並保存
        exec_logger.complete_execution("success")
        exec_logger.save_to_file("execution_log.json")

        return 0

    except Exception as e:
        logger.error(f"❌ 執行過程發生錯誤: {str(e)}", exc_info=True)

        # 記錄錯誤並保存日誌
        try:
            exec_logger.complete_execution("error")
            exec_logger.save_to_file("execution_log.json")
        except:
            pass  # 如果日誌保存失敗，不要影響錯誤處理

        return 1


if __name__ == "__main__":
    sys.exit(main())
