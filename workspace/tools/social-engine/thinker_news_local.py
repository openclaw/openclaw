#!/usr/bin/env python3
"""
Thinker News — 本地版
RSS 抓取 → 篩選 → AI 處理 → 輸出到 TG 戰情室 + latest.json

原版：GitHub Actions + OpenAI/DeepSeek ($3/mo)
本地版：Sentinel + opus_llm (Max 訂閱 $0)

Usage:
  python3 thinker_news_local.py          # 跑完整 pipeline
  python3 thinker_news_local.py fetch    # 只抓 RSS
  python3 thinker_news_local.py digest   # 只生成摘要（用已抓的資料）
"""

import sys
import json
import os
import time
from pathlib import Path
from datetime import datetime, timezone, timedelta

# Paths
SCRIPT_DIR = Path(__file__).parent
THINKER_NEWS_SRC = Path("/Users/sulaxd/Documents/thinker-news/scripts")
CLAWD_ROOT = SCRIPT_DIR.parent.parent
OUTPUT_DIR = SCRIPT_DIR
LATEST_JSON = OUTPUT_DIR / "thinker-news-latest.json"
RAW_CACHE = Path("/tmp/thinker-news-raw.json")

TW_TZ = timezone(timedelta(hours=8))

# Add thinker-news scripts and workspace lib to path
sys.path.insert(0, str(THINKER_NEWS_SRC))
sys.path.insert(0, str(CLAWD_ROOT / "workspace" / "lib"))
# Also add as package path for opus_llm
os.environ.setdefault("PYTHONPATH", str(CLAWD_ROOT / "workspace" / "lib"))


PANORAMA_SOURCES = {
    # L1 快訊 — 台灣
    'cna_politics': {'url': 'https://feeds.feedburner.com/rsscna/politics',    'region': 'tw',   'tier': 'L1'},
    'cna_intl':     {'url': 'https://feeds.feedburner.com/rsscna/intworld',    'region': 'intl', 'tier': 'L1'},
    'cna_finance':  {'url': 'https://feeds.feedburner.com/rsscna/finance',     'region': 'tw',   'tier': 'L1'},
    'ltn_focus':    {'url': 'http://news.ltn.com.tw/rss/focus.xml',            'region': 'tw',   'tier': 'L1'},
    'pts':          {'url': 'https://about.pts.org.tw/rss/XML/newsfeed.xml',   'region': 'tw',   'tier': 'L1'},
    # L2 分析 — 國際
    'bbc_world':    {'url': 'https://feeds.bbci.co.uk/news/world/rss.xml',     'region': 'intl', 'tier': 'L2'},
    'bbc_asia':     {'url': 'https://feeds.bbci.co.uk/news/world/asia/rss.xml','region': 'intl', 'tier': 'L2'},
    'ft':           {'url': 'https://www.ft.com/rss/home',                     'region': 'intl', 'tier': 'L2'},
    'ap':           {'url': 'https://apnews.com/index.rss',                    'region': 'intl', 'tier': 'L2'},
    # L3 深度 — 台灣觀點
    'reporter':     {'url': 'https://www.twreporter.org/a/rss2.xml',           'region': 'tw',   'tier': 'L3'},
    'newslens':     {'url': 'https://www.thenewslens.com/feed/all',            'region': 'tw',   'tier': 'L3'},
}


def fetch_rss():
    """Step 1: Fetch RSS from 8 tech sources + 11 panorama sources."""
    import feedparser
    from rss_fetcher import fetch_all_rss_feeds
    today = datetime.now(TW_TZ).strftime('%Y-%m-%d')

    # Original 8 tech sources
    print(f"📡 Fetching tech RSS for {today}...")
    articles = fetch_all_rss_feeds(today)
    print(f"  Tech: {len(articles)} articles from 8 sources")

    # Panorama sources
    print(f"📡 Fetching panorama RSS ({len(PANORAMA_SOURCES)} sources)...")
    panorama_count = 0
    for name, cfg in PANORAMA_SOURCES.items():
        try:
            feed = feedparser.parse(cfg['url'])
            for entry in feed.entries[:20]:
                articles.append({
                    'title': entry.get('title', ''),
                    'link': entry.get('link', ''),
                    'content': entry.get('summary', entry.get('description', ''))[:300],
                    'source': name,
                    'region': cfg['region'],
                    'tier': cfg['tier'],
                    'published': entry.get('published', ''),
                })
                panorama_count += 1
        except Exception as e:
            print(f"  ⚠️ {name}: {e}")

    print(f"  Panorama: {panorama_count} articles from {len(PANORAMA_SOURCES)} sources")
    print(f"✅ Total: {len(articles)} articles")

    # Cache raw articles
    RAW_CACHE.write_text(json.dumps(articles, ensure_ascii=False, default=str, indent=2))
    return articles


def filter_news(articles):
    """Step 2: Filter — panorama mode bypasses old tech-only filter.

    Instead of rule-based filtering, we:
    1. Dedupe by title
    2. Sort by recency
    3. Take top 50 across all categories
    4. Let AI decide what matters in Stage 1
    """
    # Try old filter first for tech articles
    try:
        from news_filter import filter_and_score_news
        today = datetime.now(TW_TZ).strftime('%Y-%m-%d')
        tech_filtered = filter_and_score_news(
            [a for a in articles if a.get('tier') is None],  # only original 8 sources
            today
        )
    except Exception:
        tech_filtered = []

    # Panorama articles: dedupe + sort by source priority
    seen_titles = set(a.get('title', '')[:30] for a in tech_filtered)
    panorama = []

    tier_order = {'L1': 0, 'L2': 1, 'L3': 2}
    panorama_articles = [a for a in articles if a.get('tier')]
    panorama_articles.sort(key=lambda a: tier_order.get(a.get('tier', 'L3'), 3))

    for a in panorama_articles:
        key = a.get('title', '')[:30]
        if key and key not in seen_titles:
            seen_titles.add(key)
            panorama.append(a)

    # Combine: tech (filtered) + panorama (top 30)
    combined = tech_filtered + panorama[:30]
    print(f"🔍 Filtered: {len(combined)} articles ({len(tech_filtered)} tech + {min(len(panorama), 30)} panorama)")
    return combined


def ai_digest(filtered_news):
    """Step 3: AI processing — using opus_llm instead of OpenAI/DeepSeek."""
    # Direct import via importlib to avoid path pollution
    import importlib.util
    spec = importlib.util.spec_from_file_location("opus_llm", str(SCRIPT_DIR.parent.parent / "lib" / "opus_llm.py"))
    opus_mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(opus_mod)
    call_llm = opus_mod.call_llm
    from prompts import (
        DATA_ALCHEMIST_SYSTEM_PROMPT,
        TECH_NARRATOR_SYSTEM_PROMPT,
        EDITOR_IN_CHIEF_SYSTEM_PROMPT,
    )

    today = datetime.now(TW_TZ).strftime('%Y-%m-%d')

    # Stage 1: Panorama Curator — select and structure across all categories
    print("⚗️  Stage 1: 全景策展...")

    # Group by source type for AI context
    tech_news = [n for n in filtered_news if not n.get('tier')]
    l1_news = [n for n in filtered_news if n.get('tier') == 'L1']
    l2_news = [n for n in filtered_news if n.get('tier') == 'L2']
    l3_news = [n for n in filtered_news if n.get('tier') == 'L3']

    def format_titles(news_list, limit=15):
        return json.dumps([f"[{n.get('source','')}] {n['title']}" for n in news_list[:limit]], ensure_ascii=False)

    PANORAMA_PROMPT = """你是一位世界級的早報策展人。

你的讀者是台灣不看新聞的上班族。他們沒時間、沒耐心、但想知道今天世界發生了什麼。

任務：從以下新聞中選出最重要的 5 條，跨越不同領域。不要只選科技。

嚴格規則：
1. 只寫你確定的事實。如果 RSS 原文沒說清楚，寫「據報導」
2. 如果兩方立場對立，兩邊都要寫（「A 說...，但 B 說...」）
3. 不要腦補因果關係。「因為 X 所以 Y」只有在原文明確這樣寫時才能用
4. 每條附上來源名稱（cna/bbc/ft 等）
5. 用繁體中文。不要用 emoji。不要用 hashtag
6. 寫給不看國際新聞的人看。不要假設讀者知道背景

輸出格式（JSON）：
{"top5": [{"title": "...", "source": "rss來源名", "why": "一句話，讓完全不懂的人也秒懂", "category": "politics|economy|tech|security|society"}]}"""

    alchemist_prompt = f"""{PANORAMA_PROMPT}

---
台灣快訊（中央社、自由時報、公視）：
{format_titles(l1_news)}

國際分析（BBC、FT、AP）：
{format_titles(l2_news)}

台灣深度（報導者、關鍵評論網）：
{format_titles(l3_news)}

科技/AI：
{format_titles(tech_news)}

今日日期：{today}"""

    alchemist_output = call_llm(alchemist_prompt, max_tokens=2000, timeout=120)

    # Try to parse as JSON
    try:
        alchemist_json = json.loads(alchemist_output)
    except json.JSONDecodeError:
        # Try to extract JSON from the response
        import re
        match = re.search(r'\{[\s\S]+\}', alchemist_output)
        if match:
            try:
                alchemist_json = json.loads(match.group())
            except:
                alchemist_json = {"raw": alchemist_output}
        else:
            alchemist_json = {"raw": alchemist_output}

    print(f"✅ Stage 1 done")

    # Stage 1.5: Gemini DR fact-check injection (if reports available)
    dr_context = ""
    try:
        GEMINI_KNOWLEDGE = CLAWD_ROOT / "workspace" / "agents" / "gemini" / "knowledge"
        dr_index = GEMINI_KNOWLEDGE.parent / "knowledge" / "research-index.json"
        if not dr_index.exists():
            dr_index = CLAWD_ROOT / "workspace" / "agents" / "gemini" / "knowledge" / "research-index.json"

        # Also check for individual report files
        if GEMINI_KNOWLEDGE.exists():
            import glob
            recent_reports = sorted(GEMINI_KNOWLEDGE.glob("research-*.md"), key=lambda f: f.stat().st_mtime, reverse=True)
            # Use reports from last 48h
            from datetime import datetime as _dt
            cutoff = time.time() - 48 * 3600
            fresh = [r for r in recent_reports if r.stat().st_mtime > cutoff]
            if fresh:
                dr_snippets = []
                for rpath in fresh[:5]:  # max 5 reports
                    content = rpath.read_text()[:1000]
                    dr_snippets.append(f"[DR報告: {rpath.stem}]\n{content}")
                dr_context = "\n\n".join(dr_snippets)
                print(f"📚 Stage 1.5: 注入 {len(fresh)} 份 Gemini DR 報告作為 fact-check 參考")
    except Exception as e:
        print(f"  ⚠️ DR injection skipped: {e}")

    # Stage 2: Monocle Editor — write the daily broadcast
    print("📰 Stage 2: 早報撰稿...")

    EDITOR_PROMPT = """你是一位早報撰稿人。風格冷靜、精準、不廢話。

讀者是台灣不看新聞的上班族。他們的程度大概是：知道川普是美國總統，但不知道五角大廈跟 AI 有什麼關係。

規則：
- 繁體中文
- 不用 emoji
- 不用 hashtag
- 每條新聞最多三句話
- 第一句講「發生了什麼」（事實，不解讀）
- 第二句講「所以呢」（對一般人的意義）
- 第三句（可選）講「對台灣呢」
- 如果有對立觀點，兩邊都要說。不要只挑一邊
- 不確定的事寫「據報導」，不要寫成已確認
- 最後一句總結今天的共同脈絡
- 開頭只寫日期
- 結尾寫「明天同一時間。」

輸出純文字，不要 JSON。"""

    # Inject DR fact-check context if available
    dr_section = ""
    if dr_context:
        dr_section = f"""

---
以下是 Gemini Deep Research 的 fact-check 報告摘要。如果報告內容與 RSS 有衝突，以報告為準並標註「經查證」：
{dr_context[:2000]}"""

    narrator_prompt = f"""{EDITOR_PROMPT}

---
策展結果：{json.dumps(alchemist_json, ensure_ascii=False)[:3000]}{dr_section}

今日日期：{today}"""

    narrator_output = call_llm(narrator_prompt, max_tokens=1500, timeout=120)
    print(f"✅ Stage 2 done")

    # Stage 3: Final Polish — Monocle style, no emoji, no hashtag
    print("✍️  Stage 3: 最終打磨...")

    # Load world_facts for fact-check
    facts_context = ""
    facts_path = SCRIPT_DIR / "world_facts.yaml"
    if facts_path.exists():
        try:
            import yaml
            facts = yaml.safe_load(facts_path.read_text())
            # Flatten key numbers for AI reference
            fact_lines = []
            tw = facts.get("taiwan", {})
            if tw.get("semiconductors", {}).get("tsmc_global_foundry_share_pct"):
                fact_lines.append(f"台積電全球晶圓代工市佔: {tw['semiconductors']['tsmc_global_foundry_share_pct']}%")
            if tw.get("semiconductors", {}).get("tsmc_advanced_node_share_pct"):
                fact_lines.append(f"台積電先進製程市佔: {tw['semiconductors']['tsmc_advanced_node_share_pct']}%")
            if tw.get("energy", {}).get("lng_reserve_days"):
                fact_lines.append(f"台灣 LNG 安全存量: {tw['energy']['lng_reserve_days']} 天")
            ch = facts.get("china", {})
            if ch.get("taiwan_strait", {}).get("pla_aircraft_incursions_2024"):
                fact_lines.append(f"2024 共機擾台次數: {ch['taiwan_strait']['pla_aircraft_incursions_2024']}")
            us = facts.get("usa", {})
            if us.get("ai_defense", {}).get("anthropic_pentagon_status"):
                fact_lines.append(f"Anthropic/Pentagon: {us['ai_defense']['anthropic_pentagon_status']}")
            if fact_lines:
                facts_context = "\n\n校驗數字（如果原稿數字與此不符，以此為準）：\n" + "\n".join(f"- {l}" for l in fact_lines)
        except Exception:
            pass

    POLISH_PROMPT = f"""你是最終校對。把以下早報打磨成發佈版。

規則（違反任何一條就重寫）：
1. 不用 emoji（全部刪掉）
2. 不用 hashtag（全部刪掉）
3. 不用「早安」「大家好」
4. 開頭只有日期
5. 結尾是「明天同一時間。」
6. 繁體中文
7. 每條新聞不超過三句
8. 用「→」而非「白話：」
9. 數字必須準確。如果不確定，寫「據報導」{facts_context}

直接輸出打磨後的純文字。不要加任何說明。"""

    editor_prompt = f"""{POLISH_PROMPT}

---
原稿：
{narrator_output[:2000]}"""

    line_content = call_llm(editor_prompt, max_tokens=1000, timeout=90)
    print(f"✅ Stage 3 done")

    return {
        "date": today,
        "line_content": line_content,
        "notion_content": narrator_output,
        "generated_at": datetime.now(TW_TZ).isoformat(),
    }


def save_output(result):
    """Step 4: Save latest.json."""
    LATEST_JSON.write_text(json.dumps(result, ensure_ascii=False, indent=2))
    print(f"💾 Saved to {LATEST_JSON}")


def run_full_pipeline():
    """Run everything."""
    start = time.time()
    print(f"{'='*50}")
    print(f"  Thinker News — Local Pipeline")
    print(f"  {datetime.now(TW_TZ).strftime('%Y-%m-%d %H:%M TW')}")
    print(f"{'='*50}\n")

    # Step 1: Fetch
    articles = fetch_rss()

    # Step 2: Filter
    filtered = filter_news(articles)

    # Step 3: AI Digest
    if not filtered:
        print("⚠️ No articles after filtering. Using raw top 20.")
        filtered = articles[:20]

    result = ai_digest(filtered)

    # Step 4: Save
    save_output(result)

    elapsed = time.time() - start
    print(f"\n✅ Pipeline complete in {elapsed:.0f}s")
    print(f"📄 Brief preview:\n{result['line_content'][:300]}")

    return result


if __name__ == '__main__':
    if len(sys.argv) >= 2:
        cmd = sys.argv[1]
        if cmd == 'fetch':
            fetch_rss()
        elif cmd == 'digest':
            if RAW_CACHE.exists():
                articles = json.loads(RAW_CACHE.read_text())
                filtered = filter_news(articles)
                result = ai_digest(filtered or articles[:20])
                save_output(result)
            else:
                print("No cached RSS data. Run 'fetch' first.")
        else:
            print(__doc__)
    else:
        run_full_pipeline()
