#!/usr/bin/env python3
"""
Content Forge — 帖文鍛造流程（10 節點）

每篇帖文經過：素材→蒸餾→白話→人格→視角→共振→增強→壓縮→圓桌→交付

Usage:
  python3 content_forge.py check "text"         # 跑節點 6-8（共振+壓縮檢查）
  python3 content_forge.py amplify "text"        # 跑節點 7（頻率增強）
  python3 content_forge.py full "text"           # 跑節點 6-8 完整流程
  python3 content_forge.py pipeline              # 從 content_pipeline 選最佳候選，跑完整流程
  python3 content_forge.py forge "素材文字"      # 跑完整 10 節點（含 AI）
  python3 content_forge.py forge-topic "主題"    # 從主題開始跑完整 10 節點
"""

import sys
import json
from pathlib import Path
from datetime import datetime, timezone, timedelta

SCRIPT_DIR = Path(__file__).parent
TW_TZ = timezone(timedelta(hours=8))

sys.path.insert(0, str(SCRIPT_DIR))
from content_brain import ResonanceFilter, ResonanceAmplifier, ContentScorer, PostScheduler

THREADS_MAX_CHARS = 500

# ── opus_llm loader ──

def _call_llm(prompt, max_tokens=1000, timeout=90):
    """Load opus_llm dynamically to avoid import issues."""
    import importlib.util
    spec = importlib.util.spec_from_file_location("opus_llm", str(SCRIPT_DIR.parent.parent / "lib" / "opus_llm.py"))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod.call_llm(prompt, max_tokens=max_tokens, timeout=timeout)


# ── Nodes 1-5: AI-powered content creation ──

def node_1_material(topic_or_raw):
    """Node 1: 素材收集 — 把主題或原始素材結構化"""
    prompt = f"""你是一位內容策展人。把以下素材整理成結構化筆記。

素材：{topic_or_raw}

輸出格式：
- 核心事實（3-5 個 bullet points，每個 < 20 字）
- 衝突點（這件事的張力在哪裡？）
- 受眾關聯（為什麼台灣不看新聞的上班族會在意？）

純文字，不要 JSON。"""
    return {"node": 1, "name": "素材收集", "output": _call_llm(prompt, max_tokens=500)}


def node_2_distill(material):
    """Node 2: 蒸餾 — 把結構化素材精煉成一句話核心"""
    prompt = f"""你是蒸餾器。從以下素材中提取一個核心洞見，用一句話表達（< 30 字）。

素材：
{material}

只輸出那一句話。不要解釋。"""
    return {"node": 2, "name": "蒸餾", "output": _call_llm(prompt, max_tokens=100)}


def node_3_plain(distilled):
    """Node 3: 白話 — 把洞見寫成白話文段落"""
    prompt = f"""把以下洞見寫成一段白話文（100-200 字）。

洞見：{distilled}

規則：
- 用「你」開頭或用具體場景開頭
- 不用專業術語
- 不用 emoji
- 寫給從不看新聞的人看"""
    return {"node": 3, "name": "白話", "output": _call_llm(prompt, max_tokens=300)}


def node_4_persona(plain_text):
    """Node 4: 人格注入 — Cruz 的聲音"""
    prompt = f"""你是 Cruz：離過婚的台灣博弈業者，帶著小孩，用 AI 做一人公司。
你的語氣：冷靜、直接、帶點自嘲但不賣慘。
你不說教。你用觀察代替結論。

把以下白話文改寫成你自己的聲音：

{plain_text}

不要加 emoji。不要加 hashtag。不要超過 250 字。"""
    return {"node": 4, "name": "人格注入", "output": _call_llm(prompt, max_tokens=400)}


def node_5_angle(persona_text):
    """Node 5: 視角選擇 — 選最強的切入角度"""
    prompt = f"""以下是一篇準帖文。選擇最強的切入視角重寫開頭。

原文：
{persona_text}

視角選項（選一個最適合的）：
A. 觀察者（「今天我注意到...」）
B. 反問（「你有沒有想過...」）
C. 場景（「昨天半夜三點，我...」）
D. 數字衝擊（「7,232 個讚 vs 3 個讚」）

只輸出重寫後的完整帖文。不要解釋你選了哪個。"""
    return {"node": 5, "name": "視角選擇", "output": _call_llm(prompt, max_tokens=400)}


def node_9_council(text):
    """Node 9: 圓桌（佛五審核）— 簡化版，用規則檢查"""
    issues = []
    if len(text) > THREADS_MAX_CHARS:
        issues.append(f"超過 {THREADS_MAX_CHARS} 字限制（{len(text)} 字）")
    if any(e in text for e in ['😀','😂','🔥','💪','🚀','✨','🎯','🙏','❤️']):
        issues.append("包含 emoji")
    if '#' in text:
        issues.append("包含 hashtag")
    if any(w in text for w in ['希望這對你有幫助', '以上是我的看法', '你覺得呢？', '歡迎留言']):
        issues.append("包含 AI 套話")
    if any(w in text for w in ['底層', '韭菜', '屌絲']):
        issues.append("包含敏感用詞")

    return {
        "node": 9,
        "name": "圓桌審核",
        "pass": len(issues) == 0,
        "issues": issues,
    }


def node_10_deliver(text):
    """Node 10: 交付 — 最終格式檢查 + 輸出"""
    import re
    # Strip trailing whitespace
    text = '\n'.join(l.rstrip() for l in text.strip().split('\n'))
    # Remove double blank lines
    text = re.sub(r'\n{3,}', '\n\n', text)
    return {
        "node": 10,
        "name": "交付",
        "text": text,
        "chars": len(text),
        "pass": len(text) <= THREADS_MAX_CHARS,
    }


# ── Full 10-node pipeline ──

def forge_full(raw_input, verbose=True):
    """Run all 10 nodes on raw input. Returns final text + all node results."""
    results = []

    if verbose:
        print("🔨 Content Forge — 10 節點鍛造")
        print(f"   素材: {raw_input[:60]}...")
        print()

    # Node 1: 素材
    r1 = node_1_material(raw_input)
    results.append(r1)
    if verbose:
        print(f"  ✅ N1 素材收集")

    # Node 2: 蒸餾
    r2 = node_2_distill(r1["output"])
    results.append(r2)
    if verbose:
        print(f"  ✅ N2 蒸餾: {r2['output'][:60]}")

    # Node 3: 白話
    r3 = node_3_plain(r2["output"])
    results.append(r3)
    if verbose:
        print(f"  ✅ N3 白話 ({len(r3['output'])} 字)")

    # Node 4: 人格
    r4 = node_4_persona(r3["output"])
    results.append(r4)
    if verbose:
        print(f"  ✅ N4 人格注入 ({len(r4['output'])} 字)")

    # Node 5: 視角
    r5 = node_5_angle(r4["output"])
    results.append(r5)
    if verbose:
        print(f"  ✅ N5 視角選擇 ({len(r5['output'])} 字)")

    current_text = r5["output"]

    # Node 6: 共振
    r6 = node_6_resonance(current_text)
    results.append(r6)
    if verbose:
        print(f"  {'✅' if r6['pass'] else '❌'} N6 共振: {r6['score']}/100")

    # Node 7: 增強 (only if resonance < 65)
    if not r6["pass"]:
        r7 = node_7_amplify(current_text)
        results.append(r7)
        current_text = r7["text"]
        if verbose:
            print(f"  ✅ N7 增強: {r7['original_score']} → {r7['amplified_score']}")

        # If rule-based amplify still below 65, use AI rewrite
        r6b = node_6_resonance(current_text)
        if not r6b["pass"]:
            boost_prompt = f"""你是 Cruz：冷靜、直接、不賣慘、帶自嘲。
以下帖文需要更強的共振度。加入以下元素（自然融入，不要硬塞）：
- 一個具體場景或數字
- 一個讀者能帶入的切身感受
- 台灣人會在意的角度

原文：
{current_text}

重寫整篇。不要加 emoji。不超過 {THREADS_MAX_CHARS} 字。"""
            boosted = _call_llm(boost_prompt, max_tokens=500)
            r7b = node_6_resonance(boosted)
            if r7b["score"] > r6b["score"]:
                current_text = boosted
                r7b["name"] = "AI共振增強"
                results.append(r7b)
                if verbose:
                    print(f"  ✅ N7b AI增強: {r6b['score']} → {r7b['score']}")

    # Node 8: 壓縮
    r8 = node_8_compress(current_text)
    results.append(r8)
    if verbose:
        print(f"  {'✅' if r8['pass'] else '❌'} N8 壓縮: {r8['length']}/{THREADS_MAX_CHARS}")

    # If over limit, use AI to compress
    if not r8["pass"]:
        compress_prompt = f"""壓縮以下帖文到 {THREADS_MAX_CHARS} 字以內，保留核心意思和語氣。不要加 emoji。

{current_text}"""
        compressed = _call_llm(compress_prompt, max_tokens=400)
        current_text = compressed
        r8b = node_8_compress(current_text)
        r8b["name"] = "壓縮（AI）"
        results.append(r8b)
        if verbose:
            print(f"  {'✅' if r8b['pass'] else '❌'} N8b AI壓縮: {r8b['length']}/{THREADS_MAX_CHARS}")

    # Node 9: 圓桌
    r9 = node_9_council(current_text)
    results.append(r9)
    if verbose:
        if r9["pass"]:
            print(f"  ✅ N9 圓桌通過")
        else:
            print(f"  ❌ N9 圓桌: {', '.join(r9['issues'])}")

    # Node 10: 交付
    r10 = node_10_deliver(current_text)
    results.append(r10)
    if verbose:
        print(f"  ✅ N10 交付 ({r10['chars']} 字)")
        print(f"\n{'='*50}")
        print(r10["text"])
        print(f"{'='*50}")

    return {
        "text": r10["text"],
        "chars": r10["chars"],
        "results": results,
        "all_pass": all(r.get("pass", True) for r in results),
    }


# ── 10 Node definitions (6-8 original) ──

def node_6_resonance(text):
    """Node 6: 共振檢測"""
    rf = ResonanceFilter()
    result = rf.score(text)
    return {
        "node": 6,
        "name": "共振檢測",
        "score": result["total_score"],
        "frequencies": result["top_frequencies"],
        "pass": result["total_score"] >= 65,
    }


def node_7_amplify(text, target=65):
    """Node 7: 頻率增強（規則引擎版）"""
    amp = ResonanceAmplifier()
    result = amp.amplify(text, target_score=target)
    return {
        "node": 7,
        "name": "頻率增強",
        "original_score": result["original_score"],
        "amplified_score": result["amplified_score"],
        "bridges_added": result["bridges_added"],
        "injected": result["injected_frequencies"],
        "text": result["amplified_text"],
    }


def node_8_compress(text, max_chars=THREADS_MAX_CHARS):
    """Node 8: 字數壓縮"""
    length = len(text)
    over = length - max_chars
    return {
        "node": 8,
        "name": "字數壓縮",
        "length": length,
        "limit": max_chars,
        "over": max(0, over),
        "pass": length <= max_chars,
    }


def node_6_8_check(text):
    """Run nodes 6-8: resonance + amplify if needed + compress check."""
    results = []

    # Node 6
    r6 = node_6_resonance(text)
    results.append(r6)

    current_text = text

    # Node 7 (only if resonance < 65)
    if not r6["pass"]:
        r7 = node_7_amplify(text)
        results.append(r7)
        current_text = r7["text"]
        # Re-check resonance after amplify
        r6b = node_6_resonance(current_text)
        r6b["name"] = "共振（增強後）"
        results.append(r6b)

    # Node 8
    r8 = node_8_compress(current_text)
    results.append(r8)

    return {
        "text": current_text,
        "results": results,
        "all_pass": all(r.get("pass", True) for r in results),
    }


def pipeline_suggest():
    """Pick best candidate from content_pipeline, run through forge."""
    from content_brain import ContentBrain
    brain = ContentBrain()
    suggestion = brain.suggest_next_post()

    if not suggestion.get("suggestion"):
        print("Pipeline empty or no candidates")
        return None

    sug = suggestion["suggestion"]
    text = sug.get("text_preview", "")
    category = sug.get("category", "?")
    score = sug.get("score", 0)

    print(f"📋 Pipeline candidate: [{category}] {score:.0f}pts")
    print(f"   「{text[:80]}」")
    print()

    result = node_6_8_check(text)

    return {
        "candidate": sug,
        "forge_result": result,
    }


# ── CLI ──

def print_results(data):
    """Pretty print forge results."""
    for r in data.get("results", []):
        icon = "✅" if r.get("pass", True) else "❌"
        print(f"  {icon} Node {r['node']}: {r['name']}")

        if r["node"] == 6:
            freqs = ", ".join(f"{f[0]}({f[1]})" for f in r.get("frequencies", []))
            print(f"     共振: {r['score']}/100 | {freqs}")
        elif r["node"] == 7:
            print(f"     {r['original_score']} → {r['amplified_score']} (+{r['amplified_score']-r['original_score']})")
            if r["injected"]:
                print(f"     注入: {', '.join(r['injected'])}")
        elif r["node"] == 8:
            if r["over"] > 0:
                print(f"     {r['length']} 字（超過 {r['over']} 字）")
            else:
                print(f"     {r['length']} 字 ✓")

    print()
    if data.get("all_pass"):
        print("  🟢 All checks passed")
    else:
        print("  🔴 Some checks failed")


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(0)

    cmd = sys.argv[1]

    if cmd == "check" and len(sys.argv) >= 3:
        text = " ".join(sys.argv[2:])
        result = node_6_8_check(text)
        print_results(result)

    elif cmd == "amplify" and len(sys.argv) >= 3:
        text = " ".join(sys.argv[2:])
        r7 = node_7_amplify(text)
        print(f"Original:  {r7['original_score']}/100")
        print(f"Amplified: {r7['amplified_score']}/100")
        print(f"Bridges:   {r7['bridges_added']} ({', '.join(r7['injected'])})")
        print(f"\n{'='*40}\n{r7['text']}")

    elif cmd == "full" and len(sys.argv) >= 3:
        text = " ".join(sys.argv[2:])
        result = node_6_8_check(text)
        print_results(result)
        print(f"\n{'='*40}")
        print(result["text"])

    elif cmd == "pipeline":
        result = pipeline_suggest()
        if result:
            print()
            print_results(result["forge_result"])

    elif cmd == "forge" and len(sys.argv) >= 3:
        raw = " ".join(sys.argv[2:])
        forge_full(raw)

    elif cmd == "forge-topic" and len(sys.argv) >= 3:
        topic = " ".join(sys.argv[2:])
        forge_full(f"主題：{topic}")

    else:
        print(__doc__)
