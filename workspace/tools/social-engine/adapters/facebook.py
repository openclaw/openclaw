"""Facebook Page adapter — read/write via Graph API."""
import os
import json
import urllib.request
import urllib.parse
import urllib.error
from pathlib import Path
from .base import ChannelAdapter

ENV_PATH = Path(__file__).parent.parent / ".env"


def _load_env():
    if ENV_PATH.exists():
        for line in ENV_PATH.read_text().splitlines():
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                os.environ.setdefault(k.strip(), v.strip())


_load_env()

PAGE_ID = os.environ.get("FB_PAGE_ID", "")
PAGE_TOKEN = os.environ.get("FB_PAGE_TOKEN", "")
API_BASE = "https://graph.facebook.com/v21.0"


def api_get(endpoint, params=None):
    params = params or {}
    params["access_token"] = PAGE_TOKEN
    qs = urllib.parse.urlencode(params)
    url = f"{API_BASE}/{endpoint}?{qs}"
    try:
        with urllib.request.urlopen(urllib.request.Request(url), timeout=15) as resp:
            return json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        body = e.read().decode()[:300]
        print(f"  ❌ FB API {e.code}: {body}")
        return None


def api_post(endpoint, data):
    data["access_token"] = PAGE_TOKEN
    body = urllib.parse.urlencode(data).encode()
    url = f"{API_BASE}/{endpoint}"
    try:
        req = urllib.request.Request(url, data=body, method="POST")
        with urllib.request.urlopen(req, timeout=15) as resp:
            return json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        body = e.read().decode()[:300]
        print(f"  ❌ FB API POST {e.code}: {body}")
        return None


class FacebookAdapter(ChannelAdapter):
    channel_name = "facebook"

    def scan(self):
        """Get recent posts + comments from the Page."""
        data = api_get(f"{PAGE_ID}/posts", {
            "fields": "id,message,created_time,likes.summary(true),comments.summary(true),comments{id,message,from,created_time,like_count}",
            "limit": 10
        })
        if not data or "data" not in data:
            return []

        messages = []
        for post in data["data"]:
            for comment in post.get("comments", {}).get("data", []):
                from_user = comment.get("from", {})
                messages.append({
                    "handle": from_user.get("name", "unknown"),
                    "handle_id": from_user.get("id", ""),
                    "text": comment.get("message", ""),
                    "media_type": "TEXT",
                    "timestamp": comment.get("created_time"),
                    "raw_id": comment.get("id"),
                    "post_id": post["id"],
                    "post_text": post.get("message", "")[:100],
                })
        return messages

    def send(self, handle, text, reply_to_id=None):
        """Post a comment on a FB post or reply to a comment."""
        if reply_to_id:
            # Reply to a specific comment
            result = api_post(f"{reply_to_id}/comments", {"message": text})
        else:
            # Post on the page
            result = api_post(f"{PAGE_ID}/feed", {"message": text})
        return bool(result and "id" in result)

    def publish_post(self, message, link=None):
        """Publish a new post to the Page."""
        data = {"message": message}
        if link:
            data["link"] = link
        result = api_post(f"{PAGE_ID}/feed", data)
        if result and "id" in result:
            print(f"  ✅ Published to FB: {result['id']}")
            return result["id"]
        return None

    def get_page_info(self):
        return api_get(PAGE_ID, {"fields": "name,fan_count,category,about"})

    def get_posts(self, limit=10):
        return api_get(f"{PAGE_ID}/posts", {
            "fields": "id,message,created_time,likes.summary(true),comments.summary(true),permalink_url",
            "limit": limit
        })

    def get_comments(self, post_id):
        return api_get(f"{post_id}/comments", {
            "fields": "id,message,from,created_time,like_count,comment_count",
            "limit": 100
        })

    def get_profile(self, handle):
        return {"handle": handle, "channel": "facebook"}
