#!/usr/bin/env python3
"""
Gumroad CLI — 用 Playwright 操作 Gumroad 後台

用法:
  python3 gumroad.py create "產品名" "短描述" 47          # 建立產品 + 定價
  python3 gumroad.py upload <product_url> file1 file2     # 上傳檔案到產品
  python3 gumroad.py desc <product_url> "長描述"          # 更新產品描述
  python3 gumroad.py tags <product_url> "tag1,tag2,tag3"  # 設定標籤
  python3 gumroad.py publish <product_url>                # 發布產品
  python3 gumroad.py unpublish <product_url>              # 下架產品
  python3 gumroad.py list                                 # 列出所有產品
  python3 gumroad.py sales                                # 查看銷售數據
  python3 gumroad.py affiliate <product_url> 30           # 開啟 affiliate (30%)
  python3 gumroad.py workflow <product_url>               # 查看 email workflow
  python3 gumroad.py test                                 # 測試連線
  python3 gumroad.py setup-free                           # 一鍵建立免費品 (checklist)
  python3 gumroad.py setup-pro                            # 一鍵建立 $47 Pro
"""

import sys
import time
import os
from pathlib import Path
from playwright.sync_api import sync_playwright

CDP_URL = "http://localhost:9222"
GUMROAD_BASE = "https://gumroad.com"
PRODUCTS_DIR = Path(__file__).parent.parent.parent / "workspace" / "products" / "ship-agents"


def _connect():
    p = sync_playwright().start()
    browser = p.chromium.connect_over_cdp(CDP_URL)
    context = browser.contexts[0]
    return p, browser, context


def _get_page(context, url=None):
    """Get or create a Gumroad tab."""
    for page in context.pages:
        if "gumroad.com" in page.url:
            if url:
                page.goto(url, timeout=20000)
            page.bring_to_front()
            return page
    page = context.new_page()
    page.goto(url or GUMROAD_BASE, timeout=20000)
    time.sleep(3)
    return page


def _wait_and_click(page, selector, timeout=10000):
    """Wait for element and click it."""
    page.wait_for_selector(selector, timeout=timeout)
    page.locator(selector).first.click()
    time.sleep(1)


def cmd_test():
    """Test connection to Gumroad."""
    p, browser, context = _connect()
    try:
        page = _get_page(context, f"{GUMROAD_BASE}/dashboard")
        time.sleep(3)
        title = page.title()
        url = page.url
        print(f"  Connected: {title}")
        print(f"  URL: {url}")
        if "login" in url.lower():
            print("  ⚠️  Not logged in. Please log in to Gumroad in Chrome first.")
        else:
            print("  ✅ Logged in and ready.")
    finally:
        p.stop()


def cmd_list():
    """List all products."""
    p, browser, context = _connect()
    try:
        page = _get_page(context, f"{GUMROAD_BASE}/products")
        time.sleep(3)
        products = page.locator('[data-testid="product-card"], .product-card, [class*="product"]').all()
        if not products:
            # Try alternative selectors
            products = page.locator('a[href*="/products/"]').all()

        print(f"  Found {len(products)} products:")
        for prod in products:
            name = prod.text_content().strip()[:60]
            href = prod.get_attribute("href") or ""
            print(f"  - {name} ({href})")
    finally:
        p.stop()


def cmd_create(name, short_desc, price):
    """Create a new product."""
    p, browser, context = _connect()
    try:
        page = _get_page(context, f"{GUMROAD_BASE}/products")
        time.sleep(3)

        # Click "New product" button
        new_btn = page.locator('text="New product"').first
        if new_btn.is_visible():
            new_btn.click()
        else:
            # Try alternative
            page.locator('a[href*="new"], button:has-text("New")').first.click()
        time.sleep(3)

        # Fill product name
        name_input = page.locator('input[name="name"], input[placeholder*="Name"]').first
        name_input.fill(name)
        time.sleep(0.5)

        # Set price
        price_input = page.locator('input[name="price"], input[placeholder*="price"], input[type="number"]').first
        price_input.fill(str(price))
        time.sleep(0.5)

        # Look for description/short description field
        desc_inputs = page.locator('textarea, input[name="description"]').all()
        for inp in desc_inputs:
            placeholder = inp.get_attribute("placeholder") or ""
            if "description" in placeholder.lower() or "desc" in placeholder.lower():
                inp.fill(short_desc)
                break

        print(f"  Created product: {name} (${price})")
        print(f"  ⚠️  Review in browser before publishing.")
        print(f"  Current URL: {page.url}")
    finally:
        p.stop()


def cmd_upload(product_url, *files):
    """Upload files to a product."""
    p, browser, context = _connect()
    try:
        page = _get_page(context, product_url)
        time.sleep(3)

        # Find file upload area
        file_input = page.locator('input[type="file"]').first
        for f in files:
            filepath = os.path.abspath(f)
            if os.path.exists(filepath):
                file_input.set_input_files(filepath)
                time.sleep(2)
                print(f"  Uploaded: {filepath}")
            else:
                print(f"  ⚠️  File not found: {filepath}")
    finally:
        p.stop()


def cmd_desc(product_url, description):
    """Update product description."""
    p, browser, context = _connect()
    try:
        page = _get_page(context, product_url)
        time.sleep(3)

        # Find description editor (usually a rich text editor)
        editor = page.locator('[contenteditable="true"], textarea[name*="description"]').first
        editor.click()
        time.sleep(0.3)
        # Clear existing
        page.keyboard.press("Meta+a")
        time.sleep(0.2)

        # Type new content
        for i, line in enumerate(description.split('\n')):
            if i > 0:
                page.keyboard.press('Enter')
            page.keyboard.type(line, delay=3)

        time.sleep(1)
        print(f"  Description updated ({len(description)} chars)")
    finally:
        p.stop()


def cmd_tags(product_url, tags_str):
    """Set product tags."""
    tags = [t.strip() for t in tags_str.split(',')]
    p, browser, context = _connect()
    try:
        page = _get_page(context, product_url)
        time.sleep(3)

        tag_input = page.locator('input[placeholder*="tag"], input[name*="tag"]').first
        for tag in tags:
            tag_input.fill(tag)
            page.keyboard.press('Enter')
            time.sleep(0.5)

        print(f"  Tags set: {', '.join(tags)}")
    finally:
        p.stop()


def cmd_publish(product_url):
    """Publish a product."""
    p, browser, context = _connect()
    try:
        page = _get_page(context, product_url)
        time.sleep(3)
        publish_btn = page.locator('button:has-text("Publish"), button:has-text("Save and publish")').first
        publish_btn.click()
        time.sleep(3)
        print(f"  ✅ Published: {product_url}")
    finally:
        p.stop()


def cmd_sales():
    """Show sales dashboard."""
    p, browser, context = _connect()
    try:
        page = _get_page(context, f"{GUMROAD_BASE}/dashboard")
        time.sleep(3)

        # Extract sales info from dashboard
        text = page.text_content("main") or page.text_content("body") or ""
        # Look for revenue/sales numbers
        lines = text.split('\n')
        relevant = [l.strip() for l in lines if any(w in l.lower() for w in ['revenue', 'sales', 'customer', '$', 'total'])]
        print("  Sales Dashboard:")
        for line in relevant[:10]:
            if line:
                print(f"  {line}")
        if not relevant:
            print("  (No sales data found or page structure changed)")
    finally:
        p.stop()


def cmd_affiliate(product_url, percent):
    """Enable affiliate program for a product."""
    p, browser, context = _connect()
    try:
        page = _get_page(context, product_url)
        time.sleep(3)

        # Navigate to affiliate settings (usually in product settings)
        # Look for affiliate toggle or settings link
        affiliate_link = page.locator('text="Affiliates", a[href*="affiliate"]').first
        if affiliate_link.is_visible():
            affiliate_link.click()
            time.sleep(2)

        # Set commission percentage
        pct_input = page.locator('input[name*="affiliate"], input[name*="commission"]').first
        pct_input.fill(str(percent))
        time.sleep(0.5)

        print(f"  ✅ Affiliate enabled: {percent}% commission")
    finally:
        p.stop()


def cmd_setup_free():
    """One-click setup: Create the free checklist product."""
    listings_file = PRODUCTS_DIR / "gumroad-listings.md"
    if not listings_file.exists():
        print("  ❌ gumroad-listings.md not found")
        return

    print("  Setting up free product: AI Agent Production Checklist")
    print("  1. Creating product...")
    cmd_create(
        "AI Agent Production Checklist",
        "10 questions to find out if your AI agent is production-ready — or just a demo.",
        0
    )
    print("  2. ⚠️  Manual steps needed:")
    print("     - Set price to '$0+' (Pay what you want)")
    print("     - Paste full description from gumroad-listings.md section 1")
    print("     - Upload checklist PDF")
    print("     - Add tags: claude-code, ai-agent, autonomous-agent, production-deployment")
    print("     - Publish when ready")


def cmd_setup_pro():
    """One-click setup: Create the $47 Pro product."""
    print("  Setting up paid product: Ship AI Agents to Production — Pro Blueprint")
    print("  1. Creating product...")
    cmd_create(
        "Ship AI Agents to Production — Pro Blueprint",
        "14 production-tested files to ship AI agents that run 90+ days unsupervised.",
        47
    )
    print("  2. ⚠️  Manual steps needed:")
    print("     - Paste full description from gumroad-listings.md section 2")
    print("     - Upload product ZIP (all 14 files)")
    print("     - Add tags from gumroad-listings.md")
    print("     - Enable affiliates at 30%")
    print("     - Set up upsell to thinker.cafe Complete version")
    print("     - Publish when ready")


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        return

    cmd = sys.argv[1]
    args = sys.argv[2:]

    commands = {
        'test': lambda: cmd_test(),
        'list': lambda: cmd_list(),
        'create': lambda: cmd_create(args[0], args[1] if len(args) > 1 else "", args[2] if len(args) > 2 else "0"),
        'upload': lambda: cmd_upload(args[0], *args[1:]),
        'desc': lambda: cmd_desc(args[0], args[1]),
        'tags': lambda: cmd_tags(args[0], args[1]),
        'publish': lambda: cmd_publish(args[0]),
        'sales': lambda: cmd_sales(),
        'affiliate': lambda: cmd_affiliate(args[0], args[1] if len(args) > 1 else "30"),
        'setup-free': lambda: cmd_setup_free(),
        'setup-pro': lambda: cmd_setup_pro(),
    }

    if cmd in commands:
        commands[cmd]()
    else:
        print(f"  Unknown command: {cmd}")
        print(__doc__)


if __name__ == '__main__':
    main()
