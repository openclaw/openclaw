"""
X/Twitter Profile Editor via Playwright CDP
============================================
Connects to Chrome via CDP on port 9222 and automates profile editing.

Interface language: Traditional Chinese (zh-TW)

Discovered selectors and flow (2026-03-22):
-------------------------------------------

APPROACH 1: Setup Flow (/i/flow/setup_profile)
  - Only appears when profile hasn't been set up
  - Multi-step wizard: Photo -> Banner -> Bio -> Location -> Save
  - KNOWN ISSUE: The final "儲存" (Save) button can get stuck
  - Steps advance via "下一步" (Next) button
  - Skip via "暫時略過" (Skip for now) button
  - File upload via hidden input[type="file"] accepting image/jpeg,image/png,image/webp

APPROACH 2: Edit Profile Dialog (/settings/profile)  [RECOMMENDED]
  - Click "編輯個人資料" button on profile page (only after initial setup)
  - Opens a modal dialog with ALL fields at once
  - Much more reliable than the setup flow

SELECTORS (Edit Profile Dialog - /settings/profile):
  - Name:     textbox with current name value, type="text" (first textbox)
  - Bio:      textarea / textbox (second, no type="text"), 160 char limit
  - Location: textbox type="text" (third), 30 char limit
  - Website:  textbox type="text" (fourth), 100 char limit
  - Birthday: button, links to date picker
  - Save:     button "儲存" (top right of dialog)
  - Close:    button "關閉" (top left of dialog)
  - Banner upload: button "加入橫幅相片"
  - PFP upload:    button "加入頭像相片"
  - Remove PFP:    button "移除相片"

SELECTORS (Profile Page):
  - Edit Profile button: link href="/settings/profile" text "編輯個人資料"
  - Or if first time: link href="/i/flow/setup_profile" text "設定個人檔案"

SELECTORS (Pin Tweet):
  - Click "更多" (...) button on tweet
  - Menu item: "釘選至你的個人資料"
  - Confirm dialog: button "釘選"

OVERLAY HANDLING:
  - "解鎖 X 上的更多功能" overlay: press Escape
  - "你尚未獲得認證" banner: click X button to dismiss
  - "存取你的貼文分析" popup: click X to dismiss
  - Always dismiss overlays BEFORE interacting with page elements

IMAGE UPLOAD (via JavaScript injection):
  - Canvas-generated images work well for programmatic uploads
  - Direct file upload via DataTransfer API:
    1. Create canvas/blob with desired image
    2. Create File object
    3. Set input.files via DataTransfer
    4. Dispatch 'change' event with bubbles: true
  - Base64 file injection: atob() can fail on large strings in eval context
"""

import asyncio
import json
import time
from pathlib import Path

try:
    from playwright.async_api import async_playwright
except ImportError:
    print("pip install playwright  # required")
    raise


# --- Constants ---
CDP_URL = "http://localhost:9222"
PROFILE_URL = "https://x.com/{handle}"
EDIT_PROFILE_URL = "https://x.com/settings/profile"
HUMAN_DELAY = (1.5, 4.0)  # seconds, range for random delays

# Chinese UI text constants
TXT_EDIT_PROFILE = "編輯個人資料"
TXT_SETUP_PROFILE = "設定個人檔案"
TXT_SAVE = "儲存"
TXT_CLOSE = "關閉"
TXT_NEXT = "下一步"
TXT_SKIP = "暫時略過"
TXT_PIN_TO_PROFILE = "釘選至你的個人資料"
TXT_PIN_CONFIRM = "釘選"
TXT_ADD_BANNER = "加入橫幅相片"
TXT_ADD_AVATAR = "加入頭像相片"
TXT_REMOVE_PHOTO = "移除相片"
TXT_MORE = "更多"
TXT_NAME = "名稱"
TXT_BIO = "自我介紹"
TXT_LOCATION = "位置"
TXT_WEBSITE = "網站"


def _rand_delay():
    """Human-like random delay between actions."""
    import random
    return random.uniform(*HUMAN_DELAY)


async def _dismiss_overlays(page):
    """Dismiss known X overlays and banners."""
    await asyncio.sleep(1)
    # Try pressing Escape to dismiss any modal
    await page.keyboard.press("Escape")
    await asyncio.sleep(0.5)
    # Try clicking close buttons on known banners
    try:
        close_btns = await page.query_selector_all('[aria-label="關閉"]')
        for btn in close_btns:
            if await btn.is_visible():
                await btn.click()
                await asyncio.sleep(0.5)
    except Exception:
        pass


async def _upload_image_via_canvas(page, file_input_selector, image_spec):
    """
    Upload an image by generating it via canvas in the browser.

    image_spec: dict with keys:
      - width, height: canvas dimensions
      - bg_color: background color (e.g., '#000000')
      - elements: list of draw commands, each a dict:
        - type: 'text' | 'rect'
        - for text: color, font, text, x, y, align, baseline
        - for rect: color, x, y, w, h
      OR
      - file_path: local file path to upload (will use base64)
    """
    js_code = """
    async (spec) => {
        const canvas = document.createElement('canvas');
        canvas.width = spec.width;
        canvas.height = spec.height;
        const ctx = canvas.getContext('2d');

        // Background
        ctx.fillStyle = spec.bg_color || '#000000';
        ctx.fillRect(0, 0, canvas.width, canvas.height);

        // Draw elements
        for (const el of (spec.elements || [])) {
            if (el.type === 'text') {
                ctx.fillStyle = el.color || '#ffffff';
                ctx.font = el.font || '32px monospace';
                ctx.textAlign = el.align || 'center';
                ctx.textBaseline = el.baseline || 'middle';
                ctx.fillText(el.text, el.x, el.y);
            } else if (el.type === 'rect') {
                ctx.fillStyle = el.color || '#ffffff';
                ctx.fillRect(el.x, el.y, el.w, el.h);
            } else if (el.type === 'grid') {
                ctx.strokeStyle = el.color || 'rgba(0,255,0,0.08)';
                ctx.lineWidth = el.lineWidth || 1;
                const step = el.step || 50;
                for (let x = 0; x < canvas.width; x += step) {
                    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, canvas.height); ctx.stroke();
                }
                for (let y = 0; y < canvas.height; y += step) {
                    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(canvas.width, y); ctx.stroke();
                }
            }
        }

        const blob = await new Promise(r => canvas.toBlob(r, 'image/png'));
        const file = new File([blob], spec.filename || 'image.png', { type: 'image/png' });

        const fileInput = document.querySelector(spec.selector);
        if (!fileInput) throw new Error('File input not found: ' + spec.selector);

        const dt = new DataTransfer();
        dt.items.add(file);
        fileInput.files = dt.files;
        fileInput.dispatchEvent(new Event('change', { bubbles: true }));

        return { success: true, size: file.size };
    }
    """
    image_spec["selector"] = file_input_selector
    result = await page.evaluate(js_code, image_spec)
    return result


async def update_x_profile(
    handle: str = "TangCruzZ",
    name: str | None = None,
    bio: str | None = None,
    location: str | None = None,
    website: str | None = None,
    pfp_spec: dict | None = None,
    banner_spec: dict | None = None,
    cdp_url: str = CDP_URL,
):
    """
    Update X/Twitter profile fields via Playwright CDP connection.

    Args:
        handle: Twitter handle (without @)
        name: Display name (None = don't change)
        bio: Bio text, max 160 chars (None = don't change)
        location: Location text, max 30 chars (None = don't change)
        website: Website URL, max 100 chars (None = don't change)
        pfp_spec: Dict for canvas-generated profile picture (see _upload_image_via_canvas)
        banner_spec: Dict for canvas-generated banner image
        cdp_url: Chrome DevTools Protocol URL

    Returns:
        dict with status and any errors
    """
    async with async_playwright() as p:
        browser = await p.chromium.connect_over_cdp(cdp_url)
        context = browser.contexts[0]
        page = context.pages[0] if context.pages else await context.new_page()

        result = {"status": "started", "changes": [], "errors": []}

        try:
            # 1. Navigate to profile
            await page.goto(PROFILE_URL.format(handle=handle), wait_until="networkidle")
            await asyncio.sleep(_rand_delay())
            await _dismiss_overlays(page)

            # 2. Check if we need setup flow or edit profile
            edit_btn = await page.query_selector(f'a[href="/settings/profile"]')
            setup_btn = await page.query_selector(f'a[href="/i/flow/setup_profile"]')

            if edit_btn:
                # Profile already set up - use edit dialog
                await edit_btn.click()
                await asyncio.sleep(_rand_delay())
                result["flow"] = "edit_dialog"
            elif setup_btn:
                # Need to go through setup flow first, then switch to edit
                # Skip the setup flow - just complete it minimally
                await setup_btn.click()
                await asyncio.sleep(_rand_delay())
                # Skip through all steps
                for _ in range(5):
                    skip_btn = await page.query_selector(f'button:has-text("{TXT_SKIP}")')
                    next_btn = await page.query_selector(f'button:has-text("{TXT_NEXT}")')
                    if skip_btn and await skip_btn.is_visible():
                        await skip_btn.click()
                        await asyncio.sleep(_rand_delay())
                    elif next_btn and await next_btn.is_visible():
                        await next_btn.click()
                        await asyncio.sleep(_rand_delay())
                    else:
                        break

                # Try to save/close the setup flow
                save_btn = await page.query_selector(f'button:has-text("{TXT_SAVE}")')
                if save_btn:
                    await save_btn.click()
                    await asyncio.sleep(3)

                # Close any remaining dialog
                close_btn = await page.query_selector(f'button:has-text("{TXT_CLOSE}")')
                if close_btn:
                    await close_btn.click()
                    await asyncio.sleep(2)

                # Now navigate to profile and use edit dialog
                await page.goto(PROFILE_URL.format(handle=handle), wait_until="networkidle")
                await asyncio.sleep(_rand_delay())
                edit_btn = await page.query_selector(f'a[href="/settings/profile"]')
                if edit_btn:
                    await edit_btn.click()
                    await asyncio.sleep(_rand_delay())
                result["flow"] = "setup_then_edit"
            else:
                result["errors"].append("Neither edit nor setup button found")
                result["status"] = "failed"
                return result

            # 3. Now we should be in the edit profile dialog
            # Wait for form fields to appear
            await asyncio.sleep(2)

            # Upload images if specified
            if pfp_spec:
                try:
                    add_avatar_btn = await page.query_selector(
                        f'button:has-text("{TXT_ADD_AVATAR}")'
                    )
                    if add_avatar_btn:
                        # Upload via canvas injection
                        upload_result = await _upload_image_via_canvas(
                            page, 'input[type="file"]', pfp_spec
                        )
                        result["changes"].append(f"pfp_uploaded: {upload_result}")
                        await asyncio.sleep(_rand_delay())
                        # Apply if in media editor
                        apply_btn = await page.query_selector(f'button:has-text("套用")')
                        if apply_btn and await apply_btn.is_visible():
                            await apply_btn.click()
                            await asyncio.sleep(_rand_delay())
                except Exception as e:
                    result["errors"].append(f"pfp_upload_error: {e}")

            if banner_spec:
                try:
                    add_banner_btn = await page.query_selector(
                        f'button:has-text("{TXT_ADD_BANNER}")'
                    )
                    if add_banner_btn:
                        upload_result = await _upload_image_via_canvas(
                            page, 'input[type="file"]', banner_spec
                        )
                        result["changes"].append(f"banner_uploaded: {upload_result}")
                        await asyncio.sleep(_rand_delay())
                        apply_btn = await page.query_selector(f'button:has-text("套用")')
                        if apply_btn and await apply_btn.is_visible():
                            await apply_btn.click()
                            await asyncio.sleep(_rand_delay())
                except Exception as e:
                    result["errors"].append(f"banner_upload_error: {e}")

            # Fill text fields
            # Strategy: find all textboxes in the dialog, identify by order/content
            textboxes = await page.query_selector_all(
                '[role="dialog"] input[type="text"], [role="dialog"] textarea'
            )

            # If no dialog role, try the group/form approach
            if not textboxes:
                textboxes = await page.query_selector_all(
                    'input[type="text"], textarea'
                )

            # Map fields by examining labels/placeholders
            field_map = {}
            for tb in textboxes:
                placeholder = await tb.get_attribute("placeholder") or ""
                value = await tb.input_value() if await tb.get_attribute("type") == "text" else ""
                aria_label = await tb.get_attribute("aria-label") or ""
                tag = await tb.evaluate("el => el.tagName.toLowerCase()")

                key = None
                if TXT_NAME in placeholder or TXT_NAME in aria_label or tag == "input":
                    if "name" not in field_map:
                        key = "name"
                if tag == "textarea" or TXT_BIO in placeholder or TXT_BIO in aria_label:
                    key = "bio"
                if TXT_LOCATION in placeholder or TXT_LOCATION in aria_label:
                    key = "location"
                if TXT_WEBSITE in placeholder or TXT_WEBSITE in aria_label:
                    key = "website"

                if key:
                    field_map[key] = tb

            # Fallback: assign by order (name, bio, location, website)
            if len(field_map) < 4 and len(textboxes) >= 4:
                order_keys = ["name", "bio", "location", "website"]
                for i, key in enumerate(order_keys):
                    if key not in field_map and i < len(textboxes):
                        field_map[key] = textboxes[i]

            # Fill fields
            if name is not None and "name" in field_map:
                tb = field_map["name"]
                await tb.click()
                await asyncio.sleep(0.5)
                await tb.fill("")
                await tb.type(name, delay=50)
                result["changes"].append(f"name={name}")
                await asyncio.sleep(_rand_delay())

            if bio is not None and "bio" in field_map:
                tb = field_map["bio"]
                await tb.click()
                await asyncio.sleep(0.5)
                # Clear existing text
                await page.keyboard.press("Meta+a")
                await page.keyboard.press("Backspace")
                await tb.type(bio, delay=30)
                result["changes"].append(f"bio={bio[:50]}...")
                await asyncio.sleep(_rand_delay())

            if location is not None and "location" in field_map:
                tb = field_map["location"]
                await tb.click()
                await asyncio.sleep(0.5)
                await tb.fill("")
                await tb.type(location, delay=50)
                result["changes"].append(f"location={location}")
                await asyncio.sleep(_rand_delay())

            if website is not None and "website" in field_map:
                tb = field_map["website"]
                await tb.click()
                await asyncio.sleep(0.5)
                await tb.fill("")
                await tb.type(website, delay=50)
                result["changes"].append(f"website={website}")
                await asyncio.sleep(_rand_delay())

            # 4. Save
            save_btn = await page.query_selector(f'button:has-text("{TXT_SAVE}")')
            if save_btn:
                await save_btn.click()
                await asyncio.sleep(5)
                result["status"] = "saved"
            else:
                result["errors"].append("Save button not found")
                result["status"] = "partial"

        except Exception as e:
            result["errors"].append(str(e))
            result["status"] = "error"

        return result


async def pin_tweet(
    handle: str = "TangCruzZ",
    tweet_url: str = None,
    cdp_url: str = CDP_URL,
):
    """
    Pin a tweet to the profile.

    Args:
        handle: Twitter handle
        tweet_url: Full URL of the tweet to pin
        cdp_url: Chrome DevTools Protocol URL
    """
    async with async_playwright() as p:
        browser = await p.chromium.connect_over_cdp(cdp_url)
        context = browser.contexts[0]
        page = context.pages[0] if context.pages else await context.new_page()

        result = {"status": "started"}

        try:
            await page.goto(tweet_url, wait_until="networkidle")
            await asyncio.sleep(_rand_delay())
            await _dismiss_overlays(page)

            # Click the "..." (More) button on the tweet
            more_btn = await page.query_selector(
                f'article button[aria-label="{TXT_MORE}"]'
            )
            if not more_btn:
                # Fallback: first "更多" button in the article
                more_btns = await page.query_selector_all(f'button[aria-label="{TXT_MORE}"]')
                more_btn = more_btns[0] if more_btns else None

            if not more_btn:
                result["status"] = "error"
                result["error"] = "More button not found"
                return result

            await more_btn.click()
            await asyncio.sleep(_rand_delay())

            # Click "釘選至你的個人資料"
            pin_item = await page.query_selector(
                f'[role="menuitem"]:has-text("{TXT_PIN_TO_PROFILE}")'
            )
            if not pin_item:
                result["status"] = "error"
                result["error"] = "Pin menu item not found"
                return result

            await pin_item.click()
            await asyncio.sleep(_rand_delay())

            # Confirm pin
            confirm_btn = await page.query_selector(
                f'button:has-text("{TXT_PIN_CONFIRM}")'
            )
            if confirm_btn:
                await confirm_btn.click()
                await asyncio.sleep(3)
                result["status"] = "pinned"
            else:
                result["status"] = "error"
                result["error"] = "Pin confirm button not found"

        except Exception as e:
            result["status"] = "error"
            result["error"] = str(e)

        return result


# --- Preset image specs ---
PFP_TERMINAL_CURSOR = {
    "width": 400,
    "height": 400,
    "bg_color": "#000000",
    "filename": "x-pfp.png",
    "elements": [
        {
            "type": "text",
            "color": "#00ff00",
            "font": "bold 160px monospace",
            "text": ">_",
            "x": 200,
            "y": 200,
            "align": "center",
            "baseline": "middle",
        }
    ],
}

BANNER_SHIP_AI_AGENTS = {
    "width": 1500,
    "height": 500,
    "bg_color": "#0a0a0a",
    "filename": "x-banner.png",
    "elements": [
        {
            "type": "grid",
            "color": "rgba(0, 255, 0, 0.08)",
            "step": 50,
            "lineWidth": 1,
        },
        {
            "type": "text",
            "color": "#00ff00",
            "font": "bold 64px monospace",
            "text": "Ship AI Agents to Production",
            "x": 750,
            "y": 220,
            "align": "center",
            "baseline": "middle",
        },
        {
            "type": "text",
            "color": "rgba(0, 255, 0, 0.6)",
            "font": "28px monospace",
            "text": "10 agents  \u00b7  90+ days  \u00b7  zero babysitting",
            "x": 750,
            "y": 300,
            "align": "center",
            "baseline": "middle",
        },
        {
            "type": "text",
            "color": "rgba(0, 255, 0, 0.4)",
            "font": "20px monospace",
            "text": "$ ./deploy --agents=all --mode=production --uptime=forever",
            "x": 50,
            "y": 440,
            "align": "left",
            "baseline": "middle",
        },
    ],
}


# --- CLI ---
if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(description="Update X/Twitter profile")
    parser.add_argument("--handle", default="TangCruzZ")
    parser.add_argument("--name", default=None)
    parser.add_argument("--bio", default=None)
    parser.add_argument("--location", default=None)
    parser.add_argument("--website", default=None)
    parser.add_argument("--pfp", action="store_true", help="Set terminal cursor PFP")
    parser.add_argument("--banner", action="store_true", help="Set Ship AI Agents banner")
    parser.add_argument("--pin", default=None, help="Tweet URL to pin")
    parser.add_argument("--cdp", default=CDP_URL, help="CDP URL")

    args = parser.parse_args()

    async def main():
        if args.pin:
            result = await pin_tweet(
                handle=args.handle,
                tweet_url=args.pin,
                cdp_url=args.cdp,
            )
            print(json.dumps(result, indent=2))
            return

        result = await update_x_profile(
            handle=args.handle,
            name=args.name,
            bio=args.bio,
            location=args.location,
            website=args.website,
            pfp_spec=PFP_TERMINAL_CURSOR if args.pfp else None,
            banner_spec=BANNER_SHIP_AI_AGENTS if args.banner else None,
            cdp_url=args.cdp,
        )
        print(json.dumps(result, indent=2))

    asyncio.run(main())
