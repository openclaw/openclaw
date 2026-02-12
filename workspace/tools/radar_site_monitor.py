#!/usr/bin/env python3
"""Official site monitor for Moltbot radar.

- Fetches configured official pages (and/or RSS when provided)
- Detects changes / new items by hashing extracted links
- Writes new radar entries into Obsidian vault
- Emits a compact Discord message body (stdout)

No external deps required (uses stdlib + requests if available, else urllib).
"""

from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import os
import re
import sys
import time
from pathlib import Path
from typing import Any

try:
    import yaml  # type: ignore
except Exception:
    yaml = None

try:
    import requests  # type: ignore
except Exception:
    requests = None

import urllib.request
import xml.etree.ElementTree as ET

ROOT = Path(os.path.expanduser("~/clawd"))
STATE_PATH = ROOT / "tmp" / "radar_site_state.json"
SITES_YML = ROOT / "tools" / "radar_sites.yml"
DEFAULT_VAULT = Path(os.path.expanduser(os.getenv("OBSIDIAN_VAULT", "~/Desktop/ObsidianVault")))
DEFAULT_ENTRIES_DIR = DEFAULT_VAULT / "Radar" / "Entries"

UA = "Mozilla/5.0 (X11; Linux x86_64) radar_site_monitor/1.0"


def http_get(url: str, timeout: int = 20) -> str:
    if requests:
        r = requests.get(url, headers={"User-Agent": UA}, timeout=timeout)
        r.raise_for_status()
        return r.text
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.read().decode("utf-8", errors="ignore")


def http_get_quick(url: str, timeout: int = 10) -> str:
    """Best-effort fetch: returns '' on any error."""
    try:
        return http_get(url, timeout=timeout)
    except Exception:
        return ""


def _load_sites_fallback_yaml_subset(txt: str) -> list[dict[str, Any]]:
    """Parse a tiny YAML subset used by tools/radar_sites.yml.

    Supported:
      - Top-level list of mappings ("- name: ...")
      - Scalar string values (no quoting/escaping)
      - One nested list field: urls: followed by "- https://..."

    This keeps the monitor runnable in minimal environments (no PyYAML).
    """

    sites: list[dict[str, Any]] = []
    cur: dict[str, Any] | None = None
    in_urls = False

    def commit() -> None:
        nonlocal cur, in_urls
        if cur is not None:
            # Normalize urls
            if "urls" in cur and not isinstance(cur["urls"], list):
                cur["urls"] = []
            sites.append(cur)
        cur = None
        in_urls = False

    for raw in txt.splitlines():
        line = raw.rstrip("\n")
        s = line.strip()
        if not s or s.startswith("#"):
            continue

        if s.startswith("-") and not s.startswith("- http") and not s.startswith("- https"):
            # New item
            commit()
            cur = {}
            in_urls = False
            s = s[1:].strip()
            if s:
                if ":" in s:
                    k, v = s.split(":", 1)
                    cur[k.strip()] = v.strip()
            continue

        if cur is None:
            continue

        # urls list entries
        if in_urls and s.startswith("-"):
            u = s[1:].strip()
            if u:
                cur.setdefault("urls", []).append(u)
            continue

        # key: value
        if ":" in s:
            k, v = s.split(":", 1)
            k = k.strip()
            v = v.strip()
            if k == "urls":
                in_urls = True
                cur.setdefault("urls", [])
            else:
                in_urls = False
                cur[k] = v

    commit()
    return sites


def load_sites() -> list[dict[str, Any]]:
    if not SITES_YML.exists():
        raise SystemExit(f"missing config: {SITES_YML}")
    txt = SITES_YML.read_text(encoding="utf-8")

    # Prefer PyYAML when available.
    if yaml is not None:
        data = yaml.safe_load(txt)
        if not isinstance(data, list):
            raise SystemExit("radar_sites.yml must be a list")
        return data

    # Fallback: parse our tiny subset.
    data = _load_sites_fallback_yaml_subset(txt)
    if not isinstance(data, list) or not data:
        raise SystemExit("Failed to parse radar_sites.yml (and PyYAML is not installed).")
    return data


def load_state() -> dict[str, Any]:
    if STATE_PATH.exists():
        return json.loads(STATE_PATH.read_text(encoding="utf-8"))
    return {"seen": {}}


def save_state(state: dict[str, Any]) -> None:
    STATE_PATH.parent.mkdir(parents=True, exist_ok=True)
    STATE_PATH.write_text(json.dumps(state, ensure_ascii=False, indent=2), encoding="utf-8")


LINK_RE = re.compile(r"href=[\"']([^\"'#?]+)[\"']", re.I)


def extract_links(html: str, base: str) -> list[str]:
    # Very lightweight: find hrefs; normalize relative links.
    from urllib.parse import urljoin

    links = []
    for m in LINK_RE.finditer(html):
        href = m.group(1).strip()
        if not href:
            continue
        if href.startswith("javascript:") or href.startswith("mailto:"):
            continue
        # Skip obvious static assets
        if re.search(r"\.(css|js|map|png|jpe?g|gif|webp|svg|ico|woff2?|ttf|eot)$", href, re.I):
            continue
        u = urljoin(base, href)
        # Only keep http(s)
        if u.startswith("http://") or u.startswith("https://"):
            links.append(u)
    # de-dupe while preserving order
    out = []
    seen = set()
    for u in links:
        if u in seen:
            continue
        seen.add(u)
        out.append(u)
    return out


def extract_rss_links(xml_text: str) -> list[str]:
    """Extract item links from RSS/Atom.

    Best-effort: returns [] on parse errors.
    """
    if not xml_text.strip():
        return []

    # Some feeds include invalid characters; be forgiving.
    try:
        root = ET.fromstring(xml_text)
    except Exception:
        return []

    links: list[str] = []

    # RSS 2.0: <rss><channel><item><link>...</link>
    for el in root.findall(".//item/link"):
        if el.text:
            u = el.text.strip()
            if u.startswith("http://") or u.startswith("https://"):
                links.append(u)

    # Atom: <feed><entry><link href="..."/>
    for el in root.findall(".//{*}entry/{*}link"):
        href = el.attrib.get("href", "").strip()
        if href.startswith("http://") or href.startswith("https://"):
            links.append(href)

    # De-dupe preserve order
    out: list[str] = []
    seen: set[str] = set()
    for u in links:
        if u in seen:
            continue
        seen.add(u)
        out.append(u)
    return out


def sha1(s: str) -> str:
    return hashlib.sha1(s.encode("utf-8")).hexdigest()


def ymd(now: dt.datetime) -> str:
    return now.strftime("%Y-%m-%d")


def yymmdd(now: dt.datetime) -> str:
    return now.strftime("%y%m%d")


def hhmm(now: dt.datetime) -> str:
    return now.strftime("%H:%M")


def safe_filename(s: str) -> str:
    s = re.sub(r"[\\/:*?\"<>|]", "-", s)
    s = re.sub(r"\s+", " ", s).strip()
    return s[:120]


def guess_title_from_url(url: str) -> str:
    # Fallback: last path chunk
    from urllib.parse import urlparse

    p = urlparse(url).path.rstrip("/")
    if not p:
        return url
    return p.split("/")[-1].replace("-", " ")


def build_md(*, title_cn: str, now: dt.datetime, tier: str, source: str, url: str, tags: list[str], summary: str, points: list[str]) -> str:
    tags_arr = ", ".join(tags)
    fm = (
        "---\n"
        f"type: radar\n"
        f"date: {ymd(now)}\n"
        f"time: '{hhmm(now)}'\n"
        f"tier: {tier}\n"
        f"source: {source}\n"
        f"url: {url}\n"
        f"tags: [{tags_arr}]\n"
        "---\n\n"
    )
    body = [f"# {title_cn}\n", f"- **时间**: {ymd(now)} {hhmm(now)}\n", f"- **来源**: {source}\n", f"- **链接**: {url}\n", "\n", f"## 一句话\n{summary}\n\n", "## 要点\n"]
    for p in points[:5]:
        body.append(f"- {p}\n")
    body.append("\n")
    return fm + "".join(body)


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description="Official-site radar sources monitor (HTML + RSS/Atom).")
    p.add_argument("--vault", default=str(DEFAULT_VAULT), help="Obsidian vault path (default: $OBSIDIAN_VAULT or ~/Desktop/ObsidianVault)")
    p.add_argument("--no-vault", action="store_true", help="Do not write Obsidian entries; only print the Discord message")
    p.add_argument("--max-sites", type=int, default=8, help="Max number of sites to scan (default: 8)")
    p.add_argument("--max-candidates", type=int, default=10, help="Max candidate links per HTML page (default: 10)")
    p.add_argument("--max-feed-items", type=int, default=20, help="Max items to read from RSS/Atom feed (default: 20)")
    p.add_argument("--max-new", type=int, default=10, help="Stop after collecting this many new entries (default: 10)")
    p.add_argument("--per-site-new", type=int, default=2, help="Max new entries per site (default: 2)")
    p.add_argument("--timeout", type=int, default=10, help="HTTP timeout seconds per request (default: 10)")
    p.add_argument("--budget", type=int, default=30, help="Overall time budget seconds (default: 30)")
    p.add_argument("-v", "--verbose", action="store_true", help="Print progress to stderr")
    args = p.parse_args(argv)

    now = dt.datetime.now(dt.timezone(dt.timedelta(hours=8)))
    started = time.time()

    vault_path = Path(os.path.expanduser(args.vault))
    entries_dir = None if args.no_vault else (vault_path / "Radar" / "Entries")

    sites = load_sites()[: max(args.max_sites, 0)]
    state = load_state()
    seen: dict[str, list[str]] = state.get("seen", {})

    new_entries: list[dict[str, Any]] = []

    for idx, site in enumerate(sites, start=1):
        if len(new_entries) >= args.max_new:
            break
        if time.time() - started > args.budget:
            break

        name = site.get("name")
        entity = site.get("entity") or re.sub(r"\W+", "", (name or "")).lower()
        topic = site.get("topic") or "ai-official"
        urls = site.get("urls") or []
        rss_url = site.get("rss") or ""
        if not name or (not urls and not rss_url):
            continue

        site_key = sha1("|".join([name] + list(urls) + ([rss_url] if rss_url else [])))
        prev = set(seen.get(site_key, []))

        if args.verbose:
            sys.stderr.write(f"[{idx}/{len(sites)}] {name}...\n")
            sys.stderr.flush()

        added_this_site = 0

        # Prefer RSS/Atom when provided (more stable than HTML scraping).
        if rss_url and added_this_site < args.per_site_new and len(new_entries) < args.max_new:
            feed = http_get_quick(str(rss_url), timeout=args.timeout)
            for link in extract_rss_links(feed)[: args.max_feed_items]:
                if time.time() - started > args.budget:
                    break
                if len(new_entries) >= args.max_new or added_this_site >= args.per_site_new:
                    break
                if link in prev:
                    continue

                page = http_get_quick(link, timeout=args.timeout)

                title = None
                m = re.search(r"<title>(.*?)</title>", page, re.I | re.S)
                if m:
                    title = re.sub(r"\s+", " ", m.group(1)).strip()
                title = title or guess_title_from_url(link)

                text = re.sub(r"<script.*?</script>", " ", page, flags=re.I | re.S)
                text = re.sub(r"<style.*?</style>", " ", text, flags=re.I | re.S)
                text = re.sub(r"<[^>]+>", " ", text)
                text = re.sub(r"\s+", " ", text).strip()
                summary = text[:180] + ("…" if len(text) > 180 else "")

                new_entries.append(
                    {
                        "source": name,
                        "entity": entity,
                        "topic": topic,
                        "url": link,
                        "title": title,
                        "summary": summary or title,
                    }
                )
                added_this_site += 1
                prev.add(link)

        for u in urls:
            if time.time() - started > args.budget:
                break
            if len(new_entries) >= args.max_new or added_this_site >= args.per_site_new:
                break

            html = http_get_quick(u, timeout=args.timeout)
            if not html:
                continue

            links = extract_links(html, u)
            # Only consider same-domain links (official)
            from urllib.parse import urlparse

            dom = urlparse(u).netloc
            official_links = [x for x in links if urlparse(x).netloc.endswith(dom)]

            # Heuristic: keep first N links; the page often contains nav links too.
            # Filter out obvious non-content paths.
            filt = []
            for x in official_links:
                if any(seg in x for seg in ["/tag/", "/category/", "/author/", "/search", "/privacy", "/terms"]):
                    continue
                filt.append(x)
            candidates = filt[: max(args.max_candidates, 0)]

            # Diff
            for link in candidates:
                if time.time() - started > args.budget:
                    break
                if len(new_entries) >= args.max_new or added_this_site >= args.per_site_new:
                    break
                if link in prev:
                    continue
                # quick fetch to create a short summary
                page = http_get_quick(link, timeout=args.timeout)

                title = None
                m = re.search(r"<title>(.*?)</title>", page, re.I | re.S)
                if m:
                    title = re.sub(r"\s+", " ", m.group(1)).strip()
                title = title or guess_title_from_url(link)

                # Very light summary: first 200 chars of visible-ish text
                text = re.sub(r"<script.*?</script>", " ", page, flags=re.I | re.S)
                text = re.sub(r"<style.*?</style>", " ", text, flags=re.I | re.S)
                text = re.sub(r"<[^>]+>", " ", text)
                text = re.sub(r"\s+", " ", text).strip()
                summary = text[:180] + ("…" if len(text) > 180 else "")

                new_entries.append(
                    {
                        "source": name,
                        "entity": entity,
                        "topic": topic,
                        "url": link,
                        "title": title,
                        "summary": summary or title,
                    }
                )
                added_this_site += 1

            # Update prev for this url pass
            prev.update(candidates)

        seen[site_key] = list(sorted(prev))[-5000:]  # cap

    # Save state
    state["seen"] = seen
    save_state(state)

    if not new_entries:
        return 0

    # Optionally write Obsidian entries + always emit Discord message
    date_dir = None
    if entries_dir is not None:
        try:
            date_dir = entries_dir / ymd(now)
            date_dir.mkdir(parents=True, exist_ok=True)
        except Exception:
            # Vault missing/unwritable: fall back to message-only mode.
            date_dir = None

    # Compose one Discord message
    lines = [f"雷达｜{now.strftime('%H')}:00｜官方公告"]

    for e in new_entries:
        source = e["source"]
        entity = e["entity"]
        topic = e["topic"]
        url = e["url"]
        title = e["title"]
        summary = e["summary"]

        # Title in Chinese: keep as-is but prefix source (rough)
        title_cn = f"{source}更新：{title}" if source not in str(title) else str(title)
        title_cn = re.sub(r"\s+", " ", title_cn).strip()

        fn = safe_filename(f"{title_cn}-{yymmdd(now)}") + ".md"
        md = build_md(
            title_cn=title_cn,
            now=now,
            tier="trusted",
            source=source,
            url=url,
            tags=["radar", "source/trusted", f"topic/{topic}", f"entity/{entity}"],
            summary=summary,
            points=["（自动抓取）请打开链接查看官方原文；如需我提炼要点/中英对照，回复我。"],
        )
        if date_dir is not None:
            (date_dir / fn).write_text(md, encoding="utf-8")

        lines.append(f"- {source}：{summary}\n  链接: <{url}>")

    sys.stdout.write("\n".join(lines) + "\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
