"""X/Twitter adapter — Playwright-based, human-like behavior."""
import time
import random
from pathlib import Path
from .base import ChannelAdapter

CDP_URL = "http://localhost:9222"


def _human_delay(min_s=1.5, max_s=4.0):
    """Simulate human reaction time."""
    time.sleep(random.uniform(min_s, max_s))


def _connect():
    from playwright.sync_api import sync_playwright
    p = sync_playwright().start()
    browser = p.chromium.connect_over_cdp(CDP_URL)
    context = browser.contexts[0]
    return p, browser, context


def _get_x_page(context):
    """Find existing X tab or create one."""
    for page in context.pages:
        if 'x.com' in page.url:
            return page
    page = context.new_page()
    page.goto('https://x.com/home', timeout=20000)
    _human_delay(3, 5)
    return page


def _dismiss_overlays(page):
    """Handle popups like a human — read, then close."""
    try:
        # Check for upgrade/premium overlays
        layers = page.locator('#layers')
        if layers.is_visible():
            # Look for close/dismiss buttons in overlays
            close_btns = page.locator(
                '#layers [aria-label="關閉"], '
                '#layers [aria-label="Close"], '
                '#layers [data-testid="app-bar-close"]'
            ).all()
            for btn in close_btns:
                if btn.is_visible():
                    _human_delay(0.8, 1.5)  # "Read" the popup first
                    btn.click()
                    _human_delay(0.5, 1.0)
                    return True

            # Try clicking the mask/backdrop
            mask = page.locator('#layers [data-testid="mask"]').first
            if mask.is_visible():
                _human_delay(0.5, 1.0)
                mask.click()
                _human_delay(0.5, 1.0)
                return True

            # Last resort: Escape key (like a human pressing Esc)
            _human_delay(0.3, 0.8)
            page.keyboard.press('Escape')
            _human_delay(0.5, 1.0)
    except Exception:
        pass
    return False


def _type_human(page, text, delay_ms_min=20, delay_ms_max=80):
    """Type like a human — variable speed, occasional pauses."""
    for i, char in enumerate(text):
        page.keyboard.type(char, delay=random.randint(delay_ms_min, delay_ms_max))
        # Occasional longer pause (thinking)
        if random.random() < 0.03:
            time.sleep(random.uniform(0.3, 0.8))


class XTwitterAdapter(ChannelAdapter):
    channel_name = 'x'

    def scan(self) -> list[dict]:
        """Scan notifications for new mentions/replies."""
        p, browser, context = _connect()
        try:
            page = _get_x_page(context)
            _dismiss_overlays(page)

            page.goto('https://x.com/notifications', timeout=15000)
            _human_delay(3, 5)
            _dismiss_overlays(page)

            notifications = page.locator('article[data-testid="tweet"]').all()
            results = []
            for notif in notifications[:10]:
                try:
                    text = notif.text_content() or ''
                    handle_el = notif.locator('a[href^="/"]').first
                    handle = handle_el.get_attribute('href').strip('/') if handle_el.is_visible() else '?'
                    results.append({
                        'handle': handle,
                        'text': text[:500],
                        'media_type': 'text',
                        'timestamp': '',
                        'raw_id': '',
                    })
                except Exception:
                    continue
            return results
        finally:
            p.stop()

    def send(self, handle: str, text: str) -> bool:
        """Post a tweet or reply."""
        p, browser, context = _connect()
        try:
            page = _get_x_page(context)
            _dismiss_overlays(page)

            # Go to compose
            page.goto('https://x.com/compose/tweet', timeout=15000)
            _human_delay(2, 4)
            _dismiss_overlays(page)

            # Find compose box
            compose = page.locator('[data-testid="tweetTextarea_0"]').first
            compose.click()
            _human_delay(0.5, 1.0)

            _type_human(page, text)
            _human_delay(1, 2)

            # Click tweet button
            tweet_btn = page.locator('[data-testid="tweetButton"]').first
            tweet_btn.click()
            _human_delay(3, 5)

            return True
        except Exception as e:
            print(f'[x] send error: {e}')
            return False
        finally:
            p.stop()

    def reply_to_tweet(self, tweet_url: str, text: str) -> bool:
        """Reply to a specific tweet."""
        p, browser, context = _connect()
        try:
            page = _get_x_page(context)
            _dismiss_overlays(page)

            page.goto(tweet_url, timeout=15000)
            _human_delay(3, 5)
            _dismiss_overlays(page)

            # Find reply box
            reply_box = page.locator('[data-testid="tweetTextarea_0"]').first
            reply_box.click()
            _human_delay(0.5, 1.0)

            _type_human(page, text)
            _human_delay(1, 2)

            # Click reply button
            reply_btn = page.locator('[data-testid="tweetButtonInline"]').first
            reply_btn.click()
            _human_delay(3, 5)

            return True
        except Exception as e:
            print(f'[x] reply error: {e}')
            return False
        finally:
            p.stop()

    def post_thread(self, tweets: list[str]) -> str:
        """Post a thread (first tweet + replies). Returns URL of first tweet."""
        p, browser, context = _connect()
        try:
            page = _get_x_page(context)
            _dismiss_overlays(page)

            # Post first tweet
            compose = page.locator('[data-testid="tweetTextarea_0"]').first
            compose.click()
            _human_delay(0.5, 1.0)
            _type_human(page, tweets[0])
            _human_delay(1, 2)

            tweet_btn = page.locator('[data-testid="tweetButtonInline"]').first
            tweet_btn.click()
            _human_delay(4, 6)
            _dismiss_overlays(page)

            # Go to profile to find the tweet
            profile = page.locator('[data-testid="AppTabBar_Profile_Link"]').first
            profile.click()
            _human_delay(3, 5)
            _dismiss_overlays(page)

            # Click first tweet
            first_tweet = page.locator('article[data-testid="tweet"]').first
            first_tweet.click()
            _human_delay(3, 5)
            _dismiss_overlays(page)

            tweet_url = page.url

            # Reply with remaining tweets
            for i, tweet_text in enumerate(tweets[1:]):
                _dismiss_overlays(page)

                reply_box = page.locator('[data-testid="tweetTextarea_0"]').first
                reply_box.click(timeout=10000)
                _human_delay(0.5, 1.0)
                _type_human(page, tweet_text)
                _human_delay(1, 2)

                reply_btn = page.locator('[data-testid="tweetButtonInline"]').first
                reply_btn.click(timeout=10000)
                _human_delay(4, 7)  # Longer delay between thread tweets
                _dismiss_overlays(page)

                print(f'  Thread {i+2}/{len(tweets)} posted')

            return tweet_url
        except Exception as e:
            print(f'[x] thread error: {e}')
            return ''
        finally:
            p.stop()

    def get_profile(self, handle: str) -> dict:
        """Get user profile info."""
        p, browser, context = _connect()
        try:
            page = _get_x_page(context)
            _dismiss_overlays(page)

            page.goto(f'https://x.com/{handle}', timeout=15000)
            _human_delay(3, 5)
            _dismiss_overlays(page)

            name = page.locator('[data-testid="UserName"]').first.text_content() or handle
            bio_el = page.locator('[data-testid="UserDescription"]').first
            bio = bio_el.text_content() if bio_el.is_visible() else ''

            return {
                'handle': handle,
                'name': name[:50],
                'bio': bio[:200],
                'platform': 'x',
            }
        except Exception:
            return {'handle': handle, 'platform': 'x'}
        finally:
            p.stop()

    def get_engagement(self, tweet_url: str) -> dict:
        """Get tweet engagement stats."""
        p, browser, context = _connect()
        try:
            page = _get_x_page(context)
            _dismiss_overlays(page)

            page.goto(tweet_url, timeout=15000)
            _human_delay(3, 5)
            _dismiss_overlays(page)

            # Extract stats from the tweet
            stats_text = page.locator('article[data-testid="tweet"]').first.text_content() or ''

            return {
                'url': tweet_url,
                'raw_stats': stats_text[:300],
            }
        except Exception:
            return {'url': tweet_url}
        finally:
            p.stop()
