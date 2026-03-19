"""Unified database for cross-channel social engine."""
import sqlite3
from pathlib import Path

DB_PATH = Path(__file__).parent.parent / "social.db"

SCHEMA = """
-- Cross-platform identity
CREATE TABLE IF NOT EXISTS contacts (
    canonical_id TEXT PRIMARY KEY,
    display_name TEXT,
    tier TEXT DEFAULT 'C',
    stance TEXT DEFAULT 'unknown',
    topics TEXT,
    recruitment_signal TEXT,
    engagement_depth INTEGER DEFAULT 0,
    last_interaction TEXT,
    notes TEXT
);

-- Platform handles
CREATE TABLE IF NOT EXISTS contact_handles (
    canonical_id TEXT NOT NULL,
    channel TEXT NOT NULL,
    handle TEXT NOT NULL,
    metadata TEXT,
    UNIQUE(channel, handle),
    FOREIGN KEY (canonical_id) REFERENCES contacts(canonical_id)
);

-- Unified interactions (all channels)
CREATE TABLE IF NOT EXISTS interactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    canonical_id TEXT,
    channel TEXT NOT NULL,
    direction TEXT NOT NULL,
    message_text TEXT,
    media_type TEXT,
    context_json TEXT,
    reply_to_id INTEGER,
    status TEXT DEFAULT 'received',
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (canonical_id) REFERENCES contacts(canonical_id)
);

-- Stance change tracking
CREATE TABLE IF NOT EXISTS stance_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    canonical_id TEXT NOT NULL,
    old_stance TEXT,
    new_stance TEXT,
    old_tier TEXT,
    new_tier TEXT,
    changed_at TEXT DEFAULT (datetime('now')),
    reason TEXT
);

-- Feed log (what we pushed to whom)
CREATE TABLE IF NOT EXISTS feed_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    canonical_id TEXT NOT NULL,
    channel TEXT NOT NULL,
    content TEXT NOT NULL,
    topic TEXT,
    sent_at TEXT DEFAULT (datetime('now')),
    response TEXT
);
"""


def get_conn(db_path=None):
    path = str(db_path or DB_PATH)
    conn = sqlite3.connect(path, timeout=30)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA busy_timeout=30000")
    conn.execute("PRAGMA journal_mode=WAL")
    return conn


def init_db(db_path=None):
    conn = get_conn(db_path)
    conn.executescript(SCHEMA)
    conn.commit()
    return conn
