"""
Threads SQLite backend — stores posts, comments, profiles, replies, and drafts.
"""

import sqlite3
import os
import json
from datetime import datetime, timezone

DB_PATH = os.path.join(os.path.dirname(__file__), "threads.db")


def get_conn(db_path=None):
    conn = sqlite3.connect(db_path or DB_PATH, timeout=120)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    conn.execute("PRAGMA busy_timeout=120000")
    conn.execute("PRAGMA wal_autocheckpoint=100")
    return conn


def init_db(db_path=None):
    conn = get_conn(db_path)
    conn.executescript("""
    CREATE TABLE IF NOT EXISTS profiles (
        user_id TEXT PRIMARY KEY,
        username TEXT NOT NULL,
        display_name TEXT,
        bio TEXT,
        follower_count INTEGER DEFAULT 0,
        following_count INTEGER DEFAULT 0,
        is_verified INTEGER DEFAULT 0,
        profile_pic_url TEXT,
        meta_json TEXT,
        first_seen_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
    );

    CREATE TABLE IF NOT EXISTS posts (
        post_id TEXT PRIMARY KEY,
        user_id TEXT,
        text_content TEXT,
        media_url TEXT,
        media_type TEXT,
        like_count INTEGER DEFAULT 0,
        reply_count INTEGER DEFAULT 0,
        repost_count INTEGER DEFAULT 0,
        posted_at TEXT,
        fetched_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
        meta_json TEXT,
        FOREIGN KEY (user_id) REFERENCES profiles(user_id)
    );

    CREATE TABLE IF NOT EXISTS comments (
        comment_id TEXT PRIMARY KEY,
        post_id TEXT NOT NULL,
        user_id TEXT,
        parent_comment_id TEXT,
        text_content TEXT,
        like_count INTEGER DEFAULT 0,
        reply_count INTEGER DEFAULT 0,
        posted_at TEXT,
        fetched_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
        meta_json TEXT,
        FOREIGN KEY (post_id) REFERENCES posts(post_id),
        FOREIGN KEY (user_id) REFERENCES profiles(user_id),
        FOREIGN KEY (parent_comment_id) REFERENCES comments(comment_id)
    );

    CREATE TABLE IF NOT EXISTS replies (
        reply_id INTEGER PRIMARY KEY AUTOINCREMENT,
        comment_id TEXT NOT NULL,
        post_id TEXT NOT NULL,
        draft_id INTEGER,
        reply_text TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',  -- pending | approved | sent | failed | skipped
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
        sent_at TEXT,
        error_msg TEXT,
        meta_json TEXT,
        FOREIGN KEY (comment_id) REFERENCES comments(comment_id),
        FOREIGN KEY (post_id) REFERENCES posts(post_id)
    );

    CREATE TABLE IF NOT EXISTS drafts (
        draft_id INTEGER PRIMARY KEY AUTOINCREMENT,
        comment_id TEXT NOT NULL,
        post_id TEXT NOT NULL,
        draft_text TEXT NOT NULL,
        tone TEXT,
        strategy TEXT,
        score REAL,
        status TEXT NOT NULL DEFAULT 'draft',  -- draft | selected | discarded
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
        meta_json TEXT,
        FOREIGN KEY (comment_id) REFERENCES comments(comment_id),
        FOREIGN KEY (post_id) REFERENCES posts(post_id)
    );

    CREATE INDEX IF NOT EXISTS idx_comments_post ON comments(post_id);
    CREATE INDEX IF NOT EXISTS idx_replies_status ON replies(status);
    CREATE INDEX IF NOT EXISTS idx_drafts_comment ON drafts(comment_id);
    CREATE INDEX IF NOT EXISTS idx_posts_user ON posts(user_id);
    """)
    conn.commit()
    conn.close()


# ── Upsert helpers ──

def upsert_profile(conn, user_id, username, **kwargs):
    now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    conn.execute("""
        INSERT INTO profiles (user_id, username, display_name, bio,
            follower_count, following_count, is_verified, profile_pic_url, meta_json,
            first_seen_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(user_id) DO UPDATE SET
            username=excluded.username,
            display_name=COALESCE(excluded.display_name, profiles.display_name),
            bio=COALESCE(excluded.bio, profiles.bio),
            follower_count=COALESCE(excluded.follower_count, profiles.follower_count),
            following_count=COALESCE(excluded.following_count, profiles.following_count),
            is_verified=COALESCE(excluded.is_verified, profiles.is_verified),
            profile_pic_url=COALESCE(excluded.profile_pic_url, profiles.profile_pic_url),
            meta_json=COALESCE(excluded.meta_json, profiles.meta_json),
            updated_at=excluded.updated_at
    """, (
        user_id, username,
        kwargs.get("display_name"), kwargs.get("bio"),
        kwargs.get("follower_count"), kwargs.get("following_count"),
        kwargs.get("is_verified", 0), kwargs.get("profile_pic_url"),
        json.dumps(kwargs.get("meta")) if kwargs.get("meta") else None,
        now, now
    ))


def upsert_post(conn, post_id, user_id, text_content, **kwargs):
    conn.execute("""
        INSERT INTO posts (post_id, user_id, text_content, media_url, media_type,
            like_count, reply_count, repost_count, posted_at, meta_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(post_id) DO UPDATE SET
            text_content=COALESCE(excluded.text_content, posts.text_content),
            like_count=COALESCE(excluded.like_count, posts.like_count),
            reply_count=COALESCE(excluded.reply_count, posts.reply_count),
            repost_count=COALESCE(excluded.repost_count, posts.repost_count),
            fetched_at=strftime('%Y-%m-%dT%H:%M:%SZ','now'),
            meta_json=COALESCE(excluded.meta_json, posts.meta_json)
    """, (
        post_id, user_id, text_content,
        kwargs.get("media_url"), kwargs.get("media_type"),
        kwargs.get("like_count", 0), kwargs.get("reply_count", 0),
        kwargs.get("repost_count", 0), kwargs.get("posted_at"),
        json.dumps(kwargs.get("meta")) if kwargs.get("meta") else None
    ))


def upsert_comment(conn, comment_id, post_id, user_id, text_content, **kwargs):
    conn.execute("""
        INSERT INTO comments (comment_id, post_id, user_id, parent_comment_id,
            text_content, like_count, reply_count, posted_at, meta_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(comment_id) DO UPDATE SET
            text_content=COALESCE(excluded.text_content, comments.text_content),
            like_count=COALESCE(excluded.like_count, comments.like_count),
            reply_count=COALESCE(excluded.reply_count, comments.reply_count),
            fetched_at=strftime('%Y-%m-%dT%H:%M:%SZ','now'),
            meta_json=COALESCE(excluded.meta_json, comments.meta_json)
    """, (
        comment_id, post_id, user_id,
        kwargs.get("parent_comment_id"), text_content,
        kwargs.get("like_count", 0), kwargs.get("reply_count", 0),
        kwargs.get("posted_at"),
        json.dumps(kwargs.get("meta")) if kwargs.get("meta") else None
    ))


def add_draft(conn, comment_id, post_id, draft_text, **kwargs):
    cur = conn.execute("""
        INSERT INTO drafts (comment_id, post_id, draft_text, tone, strategy, score, meta_json)
        VALUES (?, ?, ?, ?, ?, ?, ?)
    """, (
        comment_id, post_id, draft_text,
        kwargs.get("tone"), kwargs.get("strategy"), kwargs.get("score"),
        json.dumps(kwargs.get("meta")) if kwargs.get("meta") else None
    ))
    return cur.lastrowid


def add_reply(conn, comment_id, post_id, reply_text, draft_id=None, **kwargs):
    cur = conn.execute("""
        INSERT INTO replies (comment_id, post_id, draft_id, reply_text, status, meta_json)
        VALUES (?, ?, ?, ?, ?, ?)
    """, (
        comment_id, post_id, draft_id, reply_text,
        kwargs.get("status", "pending"),
        json.dumps(kwargs.get("meta")) if kwargs.get("meta") else None
    ))
    return cur.lastrowid


# ── Query helpers ──

def get_pending_replies(conn):
    return conn.execute(
        "SELECT * FROM replies WHERE status='pending' ORDER BY created_at"
    ).fetchall()


def get_pending_count(conn):
    return conn.execute(
        "SELECT COUNT(*) as cnt FROM replies WHERE status='pending'"
    ).fetchone()["cnt"]


def mark_reply_sent(conn, reply_id):
    now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    conn.execute(
        "UPDATE replies SET status='sent', sent_at=? WHERE reply_id=?",
        (now, reply_id)
    )


def mark_reply_failed(conn, reply_id, error_msg=""):
    conn.execute(
        "UPDATE replies SET status='failed', error_msg=? WHERE reply_id=?",
        (error_msg, reply_id)
    )


def mark_reply_skipped(conn, reply_id):
    conn.execute(
        "UPDATE replies SET status='skipped' WHERE reply_id=?",
        (reply_id,)
    )


def get_post_with_comments(conn, post_id):
    post = conn.execute("SELECT * FROM posts WHERE post_id=?", (post_id,)).fetchone()
    comments = conn.execute(
        "SELECT * FROM comments WHERE post_id=? ORDER BY posted_at", (post_id,)
    ).fetchall()
    return post, comments


def get_drafts_for_comment(conn, comment_id):
    return conn.execute(
        "SELECT * FROM drafts WHERE comment_id=? ORDER BY score DESC", (comment_id,)
    ).fetchall()


def get_stats(conn):
    stats = {}
    for table in ("profiles", "posts", "comments", "replies", "drafts"):
        stats[table] = conn.execute(f"SELECT COUNT(*) as cnt FROM {table}").fetchone()["cnt"]
    stats["pending_replies"] = get_pending_count(conn)
    return stats


# ── CLI ──

if __name__ == "__main__":
    init_db()
    conn = get_conn()
    stats = get_stats(conn)
    conn.close()
    print(f"✅ DB initialized at {DB_PATH}")
    print(f"   Tables: {', '.join(stats.keys())}")
    print(f"   All counts: {json.dumps(stats)}")
