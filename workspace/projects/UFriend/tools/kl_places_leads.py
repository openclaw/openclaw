#!/usr/bin/env python3
"""Generate Kuala Lumpur F&B leads using Google Places API.

Uses GOOGLE_API_KEY env var (recommended) or falls back to parsing tools/secrets.local.md.

Outputs JSON lines + a compact markdown-ish summary.

Google Places API endpoints used:
- Text Search: https://maps.googleapis.com/maps/api/place/textsearch/json
- Details: https://maps.googleapis.com/maps/api/place/details/json

Fields fetched (when available):
- name, formatted_address, place_id
- international_phone_number / formatted_phone_number
- website
- url (Google Maps url)
- rating, user_ratings_total
- business_status
"""

import json
import os
import re
import time
from pathlib import Path

import requests

# This script lives at projects/UFriend/tools/*.py
# Repo/workspace root is 3 levels up.
ROOT = Path(__file__).resolve().parents[3]
SECRETS = ROOT / "tools" / "secrets.local.md"


def load_key() -> str:
    key = os.getenv("GOOGLE_API_KEY")
    if key:
        return key.strip().strip('"')

    if SECRETS.exists():
        m = re.search(r"GOOGLE_API_KEY\s*=\s*\"([^\"]+)\"", SECRETS.read_text(encoding="utf-8", errors="ignore"))
        if m:
            return m.group(1)

    raise SystemExit("Missing GOOGLE_API_KEY (set env var or add to tools/secrets.local.md)")


def text_search(key: str, query: str, pagetoken: str | None = None):
    params = {"key": key}
    if pagetoken:
        params["pagetoken"] = pagetoken
    else:
        params["query"] = query

    r = requests.get("https://maps.googleapis.com/maps/api/place/textsearch/json", params=params, timeout=30)
    r.raise_for_status()
    return r.json()


def details(key: str, place_id: str):
    params = {
        "key": key,
        "place_id": place_id,
        "fields": ",".join(
            [
                "name",
                "formatted_address",
                "international_phone_number",
                "formatted_phone_number",
                "website",
                "url",
                "rating",
                "user_ratings_total",
                "business_status",
                "types",
            ]
        ),
    }
    r = requests.get("https://maps.googleapis.com/maps/api/place/details/json", params=params, timeout=30)
    r.raise_for_status()
    return r.json()


def dedupe_by_place_id(items):
    seen = set()
    out = []
    for it in items:
        pid = it.get("place_id")
        if not pid or pid in seen:
            continue
        seen.add(pid)
        out.append(it)
    return out


def main():
    key = load_key()

    # Queries tuned for “bigger” F&B targets: malls + well-known areas + chain-like keywords.
    queries = [
        "restaurant in Kuala Lumpur",
        "best restaurant in Kuala Lumpur",
        "hotpot in Kuala Lumpur",
        "bbq restaurant in Kuala Lumpur",
        "dim sum in Kuala Lumpur",
        "seafood restaurant in Kuala Lumpur",
        "restaurant in Bukit Bintang",
        "restaurant in KLCC",
        "restaurant in Mid Valley Megamall",
        "restaurant in Pavilion Kuala Lumpur",
        "restaurant in Sunway Pyramid",
    ]

    candidates = []

    for q in queries:
        data = text_search(key, q)
        candidates.extend(data.get("results", []))

        # Try to page once (Google requires a short delay before using next_page_token)
        token = data.get("next_page_token")
        if token:
            time.sleep(2.2)
            data2 = text_search(key, q, pagetoken=token)
            candidates.extend(data2.get("results", []))

    candidates = dedupe_by_place_id(candidates)

    # Filter to likely “bigger” (heuristic): many reviews
    def score(it):
        return (it.get("user_ratings_total") or 0, it.get("rating") or 0)

    candidates.sort(key=score, reverse=True)

    # Fetch details for top N
    top_n = int(os.getenv("TOP_N", "25"))
    picked = candidates[:top_n]

    out = []
    for it in picked:
        pid = it.get("place_id")
        if not pid:
            continue
        d = details(key, pid)
        res = d.get("result") or {}
        out.append(res)
        time.sleep(0.12)

    # Save artifacts
    out_dir = ROOT / "projects" / "UFriend" / "leads" / "kl"
    out_dir.mkdir(parents=True, exist_ok=True)

    json_path = out_dir / "kl_fnb_leads.json"
    json_path.write_text(json.dumps(out, ensure_ascii=False, indent=2), encoding="utf-8")

    # Also write a human-friendly list
    lines = []
    for i, r in enumerate(out, 1):
        phone = r.get("international_phone_number") or r.get("formatted_phone_number") or ""
        website = r.get("website") or ""
        addr = r.get("formatted_address") or ""
        rating = r.get("rating")
        reviews = r.get("user_ratings_total")
        gmap = r.get("url") or ""

        lines.append(
            f"{i}. {r.get('name','').strip()}\n"
            f"   - 地址: {addr}\n"
            f"   - 电话: {phone}\n"
            f"   - 官网: {website}\n"
            f"   - 评分/评论: {rating} / {reviews}\n"
            f"   - Google Maps: {gmap}\n"
        )

    md_path = out_dir / "kl_fnb_leads.md"
    md_path.write_text("\n".join(lines).strip() + "\n", encoding="utf-8")

    print(str(md_path))


if __name__ == "__main__":
    main()
