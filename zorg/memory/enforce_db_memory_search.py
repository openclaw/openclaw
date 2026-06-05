#!/usr/bin/env python3
"""Enforce DB-backed OpenClaw memory_search routing.

This is structural glue only. It does not export, embed, or publish memory data.

What it enforces:
- agents.defaults.memorySearch is moved away from remote/API-key embedding providers.
- OpenClaw's built-in memory_search tool short-circuits normal memory-file recall
  through memory_recall_router.py, which uses PostgreSQL directly.
- The patch is applied to both the global OpenClaw install and runtime dependency
  copies so package/runtime refreshes can be repaired by rerunning this script.
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
from datetime import datetime
from pathlib import Path

OPENCLAW_HOME = Path(os.environ.get('OPENCLAW_HOME', Path.home() / '.openclaw')).expanduser()
WORKSPACE = Path(os.environ.get('OPENCLAW_WORKSPACE', Path.cwd())).expanduser().resolve()
CONFIG = Path(os.environ.get('OPENCLAW_CONFIG', OPENCLAW_HOME / 'openclaw.json')).expanduser()
BACKUP_ROOT = WORKSPACE / 'backups' / 'db-memory-enforcer'

HELPER = '''
function normalizeZorgDbMemoryRows(payload, maxResults) {
	const rows = Array.isArray(payload?.structured) ? payload.structured : Array.isArray(payload?.all) ? payload.all : Array.isArray(payload?.result?.all) ? payload.result.all : [];
	const limit = Math.max(1, maxResults ?? 10);
	return rows.slice(0, limit).map((row, index) => {
		const content = typeof row?.content === "string" ? row.content : typeof row?.snippet === "string" ? row.snippet : "";
		const pathValue = typeof row?.path === "string" && row.path.trim() ? row.path : "DB:zorg_memory";
		const lineStart = Number.isFinite(row?.line_start) ? Math.max(1, Math.floor(row.line_start)) : void 0;
		const lineEnd = Number.isFinite(row?.line_end) ? Math.max(lineStart ?? 1, Math.floor(row.line_end)) : lineStart;
		return {
			path: pathValue,
			startLine: lineStart,
			endLine: lineEnd,
			score: Math.max(0.001, 1 - index * 0.001),
			snippet: content,
			source: "memory",
			citation: lineStart ? `${pathValue}#L${lineStart}${lineEnd && lineEnd !== lineStart ? `-L${lineEnd}` : ""}` : pathValue,
			corpus: "memory"
		};
	});
}
async function searchZorgDatabaseMemory(query, maxResults) {
	const fs = await import("node:fs/promises");
	const path = await import("node:path");
	const workspaceDir = process.env.OPENCLAW_WORKSPACE || (process.env.HOME ? path.join(process.env.HOME, ".openclaw", "workspace") : process.cwd());
	const pythonPath = process.env.SQLMEM_PYTHON || path.join(workspaceDir, ".venv-sqlmem", "bin", "python");
	let routerPath = process.env.MEMORY_RECALL_ROUTER || path.join(workspaceDir, "memory_recall_router.py");
	const startedAt = Date.now();
	try {
		await fs.access(pythonPath);
		try {
			await fs.access(routerPath);
		} catch {
			routerPath = path.join(workspaceDir, "scripts", "memory_recall_router.py");
			await fs.access(routerPath);
		}
		const { execFile } = await import("node:child_process");
		const output = await new Promise((resolve, reject) => {
			execFile(pythonPath, [routerPath, query, "--limit", String(Math.max(1, maxResults ?? 10))], { cwd: workspaceDir, timeout: 15000, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
				if (error) {
					error.stderr = stderr;
					reject(error);
					return;
				}
				resolve(stdout);
			});
		});
		const payload = JSON.parse(String(output));
		const results = normalizeZorgDbMemoryRows(payload, maxResults);
		return {
			results,
			provider: "zorg-db",
			model: "postgresql-direct",
			fallback: "none",
			citations: "auto",
			mode: payload?.mode ?? "database-direct-structured",
			debug: {
				backend: "database-direct-structured",
				effectiveMode: payload?.mode ?? "database-direct-structured",
				searchMs: Math.max(0, Date.now() - startedAt),
				hits: results.length
			}
		};
	} catch (error) {
		return {
			results: [],
			provider: "zorg-db",
			model: "postgresql-direct",
			fallback: "none",
			citations: "auto",
			mode: "database-unavailable",
			debug: {
				backend: "database-unavailable",
				error: formatErrorMessage(error),
				hits: 0
			}
		};
	}
}
'''

OLD_EXEC = '''execute: ({ cfg, agentId }) => async (_toolCallId, params) => {
			const rawParams = asToolParamsRecord(params);
			const query = readStringParam(rawParams, "query", { required: true });
			const maxResults = readNumberParam(rawParams, "maxResults");
			const minScore = readNumberParam(rawParams, "minScore");
			const requestedCorpus = readStringParam(rawParams, "corpus");
			const { resolveMemoryBackendConfig } = await loadMemoryToolRuntime();'''

NEW_EXEC = '''execute: ({ cfg, agentId }) => async (_toolCallId, params) => {
			const rawParams = asToolParamsRecord(params);
			const query = readStringParam(rawParams, "query", { required: true });
			const maxResults = readNumberParam(rawParams, "maxResults");
			const minScore = readNumberParam(rawParams, "minScore");
			const requestedCorpus = readStringParam(rawParams, "corpus");
			if (requestedCorpus !== "wiki" && requestedCorpus !== "sessions") return jsonResult(await searchZorgDatabaseMemory(query, maxResults));
			const { resolveMemoryBackendConfig } = await loadMemoryToolRuntime();'''


def backup(path: Path) -> None:
    if not path.exists():
        return
    dest = BACKUP_ROOT / datetime.now().strftime('%Y%m%d_%H%M%S')
    dest.mkdir(parents=True, exist_ok=True)
    shutil.copy2(path, dest / path.name)


def enforce_config() -> bool:
    if CONFIG.exists():
        data = json.loads(CONFIG.read_text(encoding='utf-8'))
    else:
        data = {}
    defaults = data.setdefault('agents', {}).setdefault('defaults', {})
    ms = defaults.setdefault('memorySearch', {})
    changed = False
    desired = {
        'enabled': True,
        'provider': 'local',
        'fallback': 'none',
        'sources': ['memory'],
    }
    for key, value in desired.items():
        if ms.get(key) != value:
            ms[key] = value
            changed = True
    multimodal = ms.setdefault('multimodal', {})
    if multimodal.get('enabled') is not False:
        multimodal['enabled'] = False
        changed = True
    # Clean installs must fail closed into DB-only recall. Remove settings that can
    # re-enable remote embedding or flat-file memory fallback behavior.
    for stale in ('remote', 'model', 'outputDimensionality'):
        if stale in ms:
            del ms[stale]
            changed = True
    # Older v1.2.10 draft builds wrote this non-schema root marker. Remove it so
    # upgraded/failed test installs recover instead of breaking gateway validation.
    if 'zorgMemoryDb' in data:
        del data['zorgMemoryDb']
        changed = True
    if changed or not CONFIG.exists():
        backup(CONFIG)
        CONFIG.parent.mkdir(parents=True, exist_ok=True)
        CONFIG.write_text(json.dumps(data, indent=2) + '\n', encoding='utf-8')
    return changed


def memory_core_paths() -> list[Path]:
    candidates: list[Path] = []
    npm_root = subprocess.run(['npm', 'root', '-g'], text=True, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    roots: list[Path] = []
    if npm_root.returncode == 0 and npm_root.stdout.strip():
        roots.append(Path(npm_root.stdout.strip()) / 'openclaw' / 'dist')
    roots.append(Path('/home/openclaw/.npm-global/lib/node_modules/openclaw/dist'))
    roots.append(Path('/usr/local/lib/node_modules/openclaw/dist'))
    runtime_root = OPENCLAW_HOME / 'plugin-runtime-deps'
    if runtime_root.exists():
        roots.extend(path.parent.parent.parent for path in runtime_root.glob('openclaw-*/dist/extensions/memory-core/index.js'))
    for root in roots:
        candidates.append(root / 'extensions' / 'memory-core' / 'index.js')
        candidates.extend(root.glob('tools-*.js'))
    found: list[Path] = []
    for candidate in candidates:
        try:
            resolved = candidate.expanduser().resolve()
        except FileNotFoundError:
            resolved = candidate.expanduser()
        if resolved.exists() and resolved not in found:
            found.append(resolved)
    return found


def runtime_db_only_writer_paths() -> list[Path]:
    candidates: list[Path] = []
    for memory_file in memory_core_paths():
        dist = memory_file
        while dist.name != 'dist' and dist.parent != dist:
            dist = dist.parent
        if dist.name != 'dist':
            continue
        candidates.append(dist / 'extensions' / 'memory-core' / 'index.js')
        candidates.append(dist / 'bundled' / 'session-memory' / 'handler.js')
    found: list[Path] = []
    for candidate in candidates:
        resolved = candidate.expanduser().resolve() if candidate.exists() else candidate.expanduser()
        if resolved.exists() and resolved not in found:
            found.append(resolved)
    return found


def enforce_db_only_runtime_writers() -> bool:
    """Prevent bundled OpenClaw paths from recreating retired memory/*.md files."""
    any_changed = False
    for runtime_file in runtime_db_only_writer_paths():
        text = runtime_file.read_text(encoding='utf-8')
        changed = False
        if runtime_file.match('*/extensions/memory-core/index.js'):
            marker = 'function buildMemoryFlushPlan(params = {}) {'
            patched = 'function buildMemoryFlushPlan(params = {}) {\n\tif (process.env.ZORG_DB_ONLY_MEMORY !== "0") return null;'
            if marker in text and patched not in text:
                text = text.replace(marker, patched, 1)
                changed = True
        elif runtime_file.match('*/bundled/session-memory/handler.js'):
            marker = 'const saveSessionToMemory = (event) => {'
            patched = '''const saveSessionToMemory = (_event) => {
\tif (process.env.ZORG_DB_ONLY_MEMORY === "0") return;
\tlog.debug("Zorg DB-only memory: bundled session-memory markdown writer disabled");
\treturn;
};
const saveSessionToMemoryDisabledOriginal = (event) => {'''
            if marker in text and 'Zorg DB-only memory: bundled session-memory markdown writer disabled' not in text:
                text = text.replace(marker, patched, 1)
                changed = True
        if changed:
            backup(runtime_file)
            runtime_file.write_text(text, encoding='utf-8')
            subprocess.run(['node', '--check', str(runtime_file)], check=True)
            any_changed = True
    return any_changed


def enforce_runtime() -> bool:
    any_changed = False
    for runtime_file in memory_core_paths():
        text = runtime_file.read_text(encoding='utf-8')
        changed = False
        marker = 'function createMemorySearchTool(options) {'
        applicable = marker in text or OLD_EXEC in text or NEW_EXEC in text or 'function searchZorgDatabaseMemory(query, maxResults)' in text
        if not applicable:
            continue
        if 'function searchZorgDatabaseMemory(query, maxResults)' not in text:
            if marker not in text:
                raise RuntimeError(f'createMemorySearchTool marker not found in {runtime_file}')
            text = text.replace(marker, HELPER + '\n' + marker, 1)
            changed = True
        if NEW_EXEC not in text:
            if OLD_EXEC not in text:
                raise RuntimeError(f'memory_search execute block marker not found in {runtime_file}')
            text = text.replace(OLD_EXEC, NEW_EXEC, 1)
            changed = True
        if changed:
            backup(runtime_file)
            runtime_file.write_text(text, encoding='utf-8')
            subprocess.run(['node', '--check', str(runtime_file)], check=True)
            any_changed = True
    if enforce_db_only_runtime_writers():
        any_changed = True
    return any_changed


def verify_db() -> None:
    python = Path(os.environ.get('SQLMEM_PYTHON', WORKSPACE / '.venv-sqlmem' / 'bin' / 'python'))
    router = Path(os.environ.get('MEMORY_RECALL_ROUTER', WORKSPACE / 'memory_recall_router.py'))
    if not router.exists():
        router = WORKSPACE / 'scripts' / 'memory_recall_router.py'
    if not python.exists() or not router.exists():
        return
    subprocess.run([str(python), str(router), 'database memory enforcement verification', '--limit', '2'], cwd=WORKSPACE, check=True, stdout=subprocess.PIPE)


def main() -> int:
    changed = []
    if enforce_config():
        changed.append('config')
    if enforce_runtime():
        changed.append('runtime')
    verify_db()
    print(json.dumps({
        'ok': True,
        'changed': changed,
        'config': str(CONFIG),
        'runtimeFiles': [str(path) for path in memory_core_paths()],
    }))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
