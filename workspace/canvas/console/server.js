const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json({ limit: '5mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Resolve .openclaw root: server.js is at .openclaw/workspace/canvas/console/
const OPENCLAW_ROOT = path.resolve(__dirname, '..', '..', '..');

// --- helpers ---
function readJSON(filePath) {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
}
function writeJSON(filePath, data) {
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n', 'utf-8');
}
function safePath(rel) {
    const abs = path.resolve(OPENCLAW_ROOT, rel);
    if (!abs.startsWith(OPENCLAW_ROOT)) throw new Error('path traversal');
    return abs;
}

// --- Config (openclaw.json) ---
app.get('/api/config', (req, res) => {
    try {
        res.json(readJSON(path.join(OPENCLAW_ROOT, 'openclaw.json')));
    } catch (e) { res.status(500).json({ error: e.message }); }
});
app.put('/api/config', (req, res) => {
    try {
        writeJSON(path.join(OPENCLAW_ROOT, 'openclaw.json'), req.body);
        res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// --- Cron (cron/jobs.json) ---
app.get('/api/cron', (req, res) => {
    try {
        res.json(readJSON(path.join(OPENCLAW_ROOT, 'cron', 'jobs.json')));
    } catch (e) { res.status(500).json({ error: e.message }); }
});
app.put('/api/cron', (req, res) => {
    try {
        writeJSON(path.join(OPENCLAW_ROOT, 'cron', 'jobs.json'), req.body);
        res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// --- Sessions / Token stats ---
app.get('/api/sessions', (req, res) => {
    try {
        const stats = [];
        const agentsDir = path.join(OPENCLAW_ROOT, 'agents');
        if (!fs.existsSync(agentsDir)) return res.json([]);

        for (const agentId of fs.readdirSync(agentsDir)) {
            const sessFile = path.join(agentsDir, agentId, 'sessions', 'sessions.json');
            if (!fs.existsSync(sessFile)) continue;
            const sessions = readJSON(sessFile);
            for (const [key, session] of Object.entries(sessions)) {
                if (!session.updatedAt) continue;
                stats.push({
                    key,
                    agentId,
                    sessionId: session.sessionId,
                    model: session.model || 'unknown',
                    modelProvider: session.modelProvider || '',
                    inputTokens: session.inputTokens || 0,
                    outputTokens: session.outputTokens || 0,
                    totalTokens: session.totalTokens || 0,
                    contextTokens: session.contextTokens || 0,
                    updatedAt: session.updatedAt,
                    label: session.label || '',
                    chatType: session.chatType || '',
                    channel: session.lastChannel || ''
                });
            }
        }
        res.json(stats);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// --- File read/write ---
app.get('/api/file', (req, res) => {
    try {
        const filePath = safePath(req.query.path);
        if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'not found' });
        const content = fs.readFileSync(filePath, 'utf-8');
        res.json({ path: req.query.path, content });
    } catch (e) { res.status(500).json({ error: e.message }); }
});
app.put('/api/file', (req, res) => {
    try {
        const filePath = safePath(req.body.path);
        fs.writeFileSync(filePath, req.body.content, 'utf-8');
        res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// --- File list (workspace md/json files) ---
app.get('/api/files', (req, res) => {
    try {
        const files = [];
        const wsDir = path.join(OPENCLAW_ROOT, 'workspace');
        // top-level md files
        for (const f of fs.readdirSync(wsDir)) {
            if (f.endsWith('.md')) files.push('workspace/' + f);
        }
        // workspace-owner
        const ownerDir = path.join(OPENCLAW_ROOT, 'workspace-owner');
        if (fs.existsSync(ownerDir)) {
            for (const f of fs.readdirSync(ownerDir)) {
                if (f.endsWith('.md')) files.push('workspace-owner/' + f);
            }
        }
        files.push('openclaw.json');
        files.push('cron/jobs.json');
        res.json(files);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

const PORT = process.env.PORT || 3939;
app.listen(PORT, () => console.log(`OpenClaw Console → http://localhost:${PORT}`));
