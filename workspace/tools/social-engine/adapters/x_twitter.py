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


def _extract_tweet_data(article):
    """Extract structured data from a tweet article element."""
    try:
        text = article.text_content() or ''
        # Get tweet link
        links = article.locator('a[href*="/status/"]').all()
        tweet_url = ''
        tweet_id = ''
        for link in links:
            href = link.get_attribute('href') or ''
            if '/status/' in href and 'photo' not in href and 'analytics' not in href:
                tweet_url = f'https://x.com{href}' if href.startswith('/') else href
                # Extract tweet ID from URL
                parts = href.split('/status/')
                if len(parts) > 1:
                    tweet_id = parts[1].split('/')[0].split('?')[0]
                break

        # Get author handle
        handle_el = article.locator('a[href^="/"][role="link"] span').first
        handle = ''
        try:
            all_links = article.locator('a[href^="/"]').all()
            for a in all_links:
                href = a.get_attribute('href') or ''
                if href.startswith('/') and '/status/' not in href and len(href) > 1:
                    handle = href.strip('/')
                    if handle and not handle.startswith('i/') and '/' not in handle:
                        break
                    handle = ''
        except Exception:
            pass

        # Get display name
        name_el = article.locator('[data-testid="User-Name"]').first
        display_name = ''
        try:
            if name_el.is_visible():
                display_name = name_el.text_content().split('@')[0].strip()[:50]
        except Exception:
            pass

        # Get timestamp
        time_el = article.locator('time').first
        timestamp = ''
        try:
            if time_el.is_visible():
                timestamp = time_el.get_attribute('datetime') or ''
        except Exception:
            pass

        return {
            'text': text[:500],
            'url': tweet_url,
            'id': tweet_id,
            'handle': handle,
            'display_name': display_name,
            'timestamp': timestamp,
        }
    except Exception:
        return None


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

            # Try to get follower count
            followers = 0
            try:
                follower_link = page.locator(f'a[href="/{handle}/verified_followers"]').first
                if follower_link.is_visible():
                    ft = follower_link.text_content() or ''
                    # Parse "1,234 Followers" or "12.5K Followers"
                    import re
                    m = re.search(r'([\d,.]+[KMkm]?)', ft)
                    if m:
                        val = m.group(1).replace(',', '')
                        if val.upper().endswith('K'):
                            followers = int(float(val[:-1]) * 1000)
                        elif val.upper().endswith('M'):
                            followers = int(float(val[:-1]) * 1000000)
                        else:
                            followers = int(float(val))
            except Exception:
                pass

            return {
                'handle': handle,
                'name': name[:50],
                'bio': bio[:200],
                'followers': followers,
                'platform': 'x',
            }
        except Exception:
            return {'handle': handle, 'platform': 'x'}
        finally:
            p.stop()

    def get_engagement(self, tweet_url: str) -> dict:
        """Get tweet engagement stats (likes, retweets, replies, views)."""
        p, browser, context = _connect()
        try:
            page = _get_x_page(context)
            _dismiss_overlays(page)

            page.goto(tweet_url, timeout=15000)
            _human_delay(3, 5)
            _dismiss_overlays(page)

            stats = {'url': tweet_url, 'likes': 0, 'retweets': 0,
                     'replies': 0, 'views': 0, 'bookmarks': 0}

            # Extract engagement counts from the tweet detail page
            # X uses aria-labels like "123 Likes", "45 Reposts"
            try:
                article = page.locator('article[data-testid="tweet"]').first

                # Try specific data-testid buttons
                for key, testid in [
                    ('replies', 'reply'),
                    ('retweets', 'retweet'),
                    ('likes', 'like'),
                    ('bookmarks', 'bookmark'),
                ]:
                    try:
                        btn = article.locator(f'[data-testid="{testid}"]').first
                        if btn.is_visible():
                            label = btn.get_attribute('aria-label') or ''
                            import re
                            m = re.search(r'([\d,]+)', label)
                            if m:
                                stats[key] = int(m.group(1).replace(',', ''))
                    except Exception:
                        continue

                # Views — look for "views" text near the tweet
                try:
                    all_text = article.text_content() or ''
                    import re
                    vm = re.search(r'([\d,.]+[KMkm]?)\s*[Vv]iews', all_text)
                    if vm:
                        val = vm.group(1).replace(',', '')
                        if val.upper().endswith('K'):
                            stats['views'] = int(float(val[:-1]) * 1000)
                        elif val.upper().endswith('M'):
                            stats['views'] = int(float(val[:-1]) * 1000000)
                        else:
                            stats['views'] = int(float(val))
                except Exception:
                    pass

            except Exception:
                # Fallback: raw text
                stats['raw_stats'] = page.locator('article[data-testid="tweet"]').first.text_content()[:300]

            return stats
        except Exception:
            return {'url': tweet_url}
        finally:
            p.stop()

    def scan_search(self, query: str, max_results: int = 10) -> list[dict]:
        """Search X for specific keywords and return tweet results."""
        p, browser, context = _connect()
        try:
            page = _get_x_page(context)
            _dismiss_overlays(page)

            # Use X search with "Latest" tab for freshness
            import urllib.parse
            encoded = urllib.parse.quote(query)
            page.goto(f'https://x.com/search?q={encoded}&src=typed_query&f=live',
                      timeout=15000)
            _human_delay(3, 6)
            _dismiss_overlays(page)

            # Scroll to load more tweets
            for _ in range(random.randint(2, 4)):
                page.mouse.wheel(0, random.randint(300, 500))
                _human_delay(1.5, 3)

            articles = page.locator('article[data-testid="tweet"]').all()
            results = []
            for article in articles[:max_results]:
                data = _extract_tweet_data(article)
                if data and data['text']:
                    data['search_query'] = query
                    results.append(data)

            return results
        except Exception as e:
            print(f'[x] scan_search error: {e}')
            return []
        finally:
            p.stop()

    def scan_account(self, handle: str, max_results: int = 10) -> list[dict]:
        """Scan a specific account's recent tweets."""
        p, browser, context = _connect()
        try:
            page = _get_x_page(context)
            _dismiss_overlays(page)

            page.goto(f'https://x.com/{handle}', timeout=15000)
            _human_delay(3, 6)
            _dismiss_overlays(page)

            # Scroll to load tweets
            for _ in range(random.randint(2, 4)):
                page.mouse.wheel(0, random.randint(300, 500))
                _human_delay(2, 4)

            articles = page.locator('article[data-testid="tweet"]').all()
            results = []
            for article in articles[:max_results]:
                data = _extract_tweet_data(article)
                if data and data['text']:
                    data['source_account'] = handle
                    results.append(data)

            return results
        except Exception as e:
            print(f'[x] scan_account error: {e}')
            return []
        finally:
            p.stop()

    def quote_tweet(self, tweet_url: str, text: str) -> bool:
        """Quote tweet with commentary."""
        p, browser, context = _connect()
        try:
            page = _get_x_page(context)
            _dismiss_overlays(page)

            page.goto(tweet_url, timeout=15000)
            _human_delay(3, 5)
            _dismiss_overlays(page)

            # Click retweet button to get the menu
            retweet_btn = page.locator('[data-testid="retweet"]').first
            retweet_btn.click()
            _human_delay(0.8, 1.5)

            # Click "Quote" option from the dropdown
            quote_option = page.locator('[data-testid="Dropdown"] a[href*="compose"], [role="menuitem"]:has-text("Quote")').first
            if not quote_option.is_visible():
                # Try alternative: look for menuitem with quote text
                quote_option = page.locator('[role="menuitem"]').all()
                for opt in quote_option:
                    opt_text = opt.text_content() or ''
                    if 'quote' in opt_text.lower() or '引用' in opt_text:
                        opt = opt
                        break
                else:
                    print('[x] quote_tweet: could not find Quote option')
                    return False

            quote_option.click()
            _human_delay(2, 3)
            _dismiss_overlays(page)

            # Type in the compose box
            compose = page.locator('[data-testid="tweetTextarea_0"]').first
            compose.click()
            _human_delay(0.5, 1.0)
            _type_human(page, text)
            _human_delay(1, 2)

            # Post
            tweet_btn = page.locator('[data-testid="tweetButton"]').first
            tweet_btn.click()
            _human_delay(3, 5)

            return True
        except Exception as e:
            print(f'[x] quote_tweet error: {e}')
            return False
        finally:
            p.stop()

    def follow(self, handle: str) -> bool:
        """Follow an account."""
        p, browser, context = _connect()
        try:
            page = _get_x_page(context)
            _dismiss_overlays(page)

            page.goto(f'https://x.com/{handle}', timeout=15000)
            _human_delay(3, 5)
            _dismiss_overlays(page)

            # Look for the Follow button (not Following)
            # data-testid can be "follow" or the text-based button
            follow_btn = page.locator(
                f'[data-testid="{handle}-follow"], '
                f'[aria-label="Follow @{handle}"]'
            ).first
            if follow_btn.is_visible():
                _human_delay(0.5, 1.5)
                follow_btn.click()
                _human_delay(2, 3)
                return True
            else:
                # May already be following
                print(f'[x] follow: no Follow button for @{handle} (may already follow)')
                return False
        except Exception as e:
            print(f'[x] follow error: {e}')
            return False
        finally:
            p.stop()

    def get_notifications(self) -> list[dict]:
        """Check notifications — returns mentions and replies to our tweets."""
        p, browser, context = _connect()
        try:
            page = _get_x_page(context)
            _dismiss_overlays(page)

            # Go to Mentions tab specifically
            page.goto('https://x.com/notifications/mentions', timeout=15000)
            _human_delay(3, 5)
            _dismiss_overlays(page)

            # Scroll a bit
            page.mouse.wheel(0, random.randint(200, 400))
            _human_delay(1.5, 3)

            articles = page.locator('article[data-testid="tweet"]').all()
            results = []
            for article in articles[:15]:
                data = _extract_tweet_data(article)
                if data and data['text']:
                    data['notification_type'] = 'mention'
                    results.append(data)

            return results
        except Exception as e:
            print(f'[x] get_notifications error: {e}')
            return []
        finally:
            p.stop()
