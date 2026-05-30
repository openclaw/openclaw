# Zorg MemoryDB Install Package

This directory contains the public-safe Zorg MemoryDB and LAN command chat install package for OpenClaw.

## Contents

- `install-zorg-memorydb.sh` installs prerequisites and copies packaged components into the OpenClaw workspace.
- `requirements.txt` declares the Python DB driver used by the recall tools.
- `db/schema.sql` creates the database structure.
- `db/seed_rules.sql` inserts public-safe production rules.
- `db/import_markdown_rules.py` imports packaged rules and retired markdown memory files into the database.
- `lan-command-chat/` contains the LAN command chat source bundle.
- `rules/` contains public-safe memory and install rules.

## Install Behavior

The OpenClaw installer calls this bootstrap when the package contains `zorg/install-zorg-memorydb.sh`. Set `ZORG_MEMORYDB_SKIP_BOOTSTRAP=1` to skip it for a special-purpose install.

The bootstrap prepares the database and LAN command chat for clean installs and existing installs. It preserves existing user data; the separate `prepare_public_baseline.sql` file is only for building a distributable public baseline and must not be run against a live user database.

When the add-on bootstrap is run through `sudo` without an explicit `OPENCLAW_HOME`, it installs into the invoking user's home directory instead of `/root`. This keeps the generated LAN command chat systemd service and its workspace on the same readable path. Set `OPENCLAW_HOME` explicitly only when a root-owned install is intentional.

## Agent-Readable Markdown

The bootstrap writes a Zorg MemoryDB usage block into the OpenClaw workspace markdown files the agent reads at startup: `AGENTS.md`, `SOUL.md`, `USER.md`, `TOOLS.md`, `IDENTITY.md`, and `HEARTBEAT.md`. It also copies `ZORG_MEMORYDB_MASTER_RULES.md` into the workspace root.

This is required because importing rules into PostgreSQL alone is not enough: the local LLM must be able to read how to use the database memory path before it can reliably call the DB-backed recall tools.

The Python recall tools install their dependencies from `zorg/requirements.txt` into `.venv-sqlmem`. They also re-exec through `.venv-sqlmem/bin/python` when launched with plain `python3`, so agent-readable commands do not fail just because the system Python lacks `psycopg2`.

## Coding And Install Rule Discipline

Changes to this package must follow the documented OpenClaw/Zorg install procedures and existing package source patterns before code is written. Check the relevant docs, package metadata, lifecycle scripts, generated runtime artifacts, and clean-install behavior instead of relying on generic coding memory or assumed APIs.

Installer and package fixes are not complete until the actual documented path is verified. For this repository, that means testing the GitHub/package install path or the explicit existing-install overlay path that the documentation tells users to run, not only a local checkout.

## Direct npm prerequisite repair

`zorg/check-node-version.cjs` is intentionally duplicated from the root OpenClaw lifecycle helper into this packaged Zorg tree. Direct git installs can run npm lifecycle scripts from a temporary packed tree before every root development script is present. Keeping the Node prerequisite repair helper under `zorg/` makes the repair path available during `npm install -g --install-links=true git+https://github.com/StefRush2099/Zorg_MemoryDB.git`, including on old hosts that start with Node v12. The same helper also checks for a missing `npm` binary after Node is compatible and attempts OS package-manager repair before the install continues. When it upgrades Node from an old running npm process, it exits with a retry instruction so the repaired Node/npm runtime owns the actual package install.
