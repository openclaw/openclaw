# Zorg MemoryDB Install Package

This directory contains the public-safe Zorg MemoryDB and LAN command chat install package for OpenClaw.

## Contents

- `install-zorg-memorydb.sh` installs prerequisites and copies packaged components into the OpenClaw workspace.
- `db/schema.sql` creates the database structure.
- `db/seed_rules.sql` inserts public-safe production rules.
- `db/import_markdown_rules.py` imports packaged rules and retired markdown memory files into the database.
- `lan-command-chat/` contains the LAN command chat source bundle.
- `rules/` contains public-safe memory and install rules.

## Install Behavior

The OpenClaw installer calls this bootstrap when the package contains `zorg/install-zorg-memorydb.sh`. Set `ZORG_MEMORYDB_SKIP_BOOTSTRAP=1` to skip it for a special-purpose install.

The bootstrap prepares the database and LAN command chat for clean installs and existing installs. It preserves existing user data; the separate `prepare_public_baseline.sql` file is only for building a distributable public baseline and must not be run against a live user database.

## Agent-Readable Markdown

The bootstrap writes a Zorg MemoryDB usage block into the OpenClaw workspace markdown files the agent reads at startup: `AGENTS.md`, `SOUL.md`, `USER.md`, `TOOLS.md`, `IDENTITY.md`, and `HEARTBEAT.md`. It also copies `ZORG_MEMORYDB_MASTER_RULES.md` into the workspace root.

This is required because importing rules into PostgreSQL alone is not enough: the local LLM must be able to read how to use the database memory path before it can reliably call the DB-backed recall tools.
