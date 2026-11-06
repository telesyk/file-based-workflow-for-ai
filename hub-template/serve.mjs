#!/usr/bin/env node
// Workflow Hub: local server. No dependencies. Binds to 127.0.0.1 only.
//
//   node serve.mjs [--port 8787]
//
// GET  /                       the board (index.html)
// GET  /vendor/marked.min.js   Markdown renderer
// GET  /projects.json          project ids and titles (no paths)
// GET  /p/<id>/<path>          read-only files of one project (allow-listed extensions)
// GET  /api/session            a random token for this server run (same-origin only)
// POST /api/task-status        the ONLY write: change a task's "status:" (and "updated:") line

import http from 'node:http';
import { readFileSync, writeFileSync, renameSync, unlinkSync, realpathSync, statSync, existsSync, createReadStream } from 'node:fs';
import { join, dirname, extname, relative, isAbsolute, sep } from 'node:path';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { loadProjects, scanProject, syncProject, todayLocal } from './sync-manifests.mjs';

const HUB_DIR = dirname(fileURLToPath(import.meta.url));
const argPort = process.argv.indexOf('--port');
const PORT = argPort >= 0 ? Number(process.argv[argPort + 1]) : 8787;
const HOST = '127.0.0.1';
const TOKEN = randomBytes(24).toString('hex');
const ALLOWED_HOSTS = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`]);
const MOVE_TARGETS = ['backlog', 'in-progress', 'testing', 'done'];
const PROJECT_EXT = new Set(['.md', '.json', '.sql', '.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp']);
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8', '.sql': 'text/plain; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.svg': 'image/svg+xml', '.webp': 'image/webp',
};

if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) { console.error('Invalid --port'); process.exit(1); }

function send(res, code, body, type = 'text/plain; charset=utf-8') {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(body);
}
const sendJson = (res, code, obj) => send(res, code, JSON.stringify(obj), 'application/json; charset=utf-8');

function serveFile(req, res, abs) {
  let st;
  try { st = statSync(abs); } catch { return send(res, 404, 'Not found'); }
  if (!st.isFile()) return send(res, 404, 'Not found');
  res.writeHead(200, {
    'Content-Type': MIME[extname(abs).toLowerCase()] || 'application/octet-stream',
    'Content-Length': st.size, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
  });
  if (req.method === 'HEAD') return res.end();
  createReadStream(abs).on('error', () => res.destroy()).pipe(res);
}

// Returns the real absolute path of a file strictly inside `root`, or null.
function resolveInProject(root, rest) {
  let decoded;
  try { decoded = decodeURIComponent(rest); } catch { return null; }
  if (!decoded || /[\0\\:]/.test(decoded)) return null;
  const parts = decoded.split('/');
  if (parts.some((s) => s === '' || s === '.' || s === '..')) return null;
  if (!PROJECT_EXT.has(extname(decoded).toLowerCase())) return null;
  let real, rootReal;
  try { real = realpathSync(join(root, ...parts)); rootReal = realpathSync(root); } catch { return null; }
  const rel = relative(rootReal, real);
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return null;
  return real;
}

function sameOriginOk(req) {
  const origin = req.headers.origin;
  if (origin && origin !== `http://${req.headers.host}`) return false;
  const sfs = req.headers['sec-fetch-site'];
  if (sfs && sfs !== 'same-origin' && sfs !== 'none') return false;
  return true;
}

function safeEqual(a, b) {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

// ---------- the one write: change a task status ----------

function moveTaskStatus({ project, id, from, to }) {
  if (typeof project !== 'string' || typeof id !== 'string' || typeof from !== 'string' || typeof to !== 'string') return [400, { error: 'bad request' }];
  if (!/^[A-Za-z0-9._-]+$/.test(id)) return [400, { error: 'bad task id' }];
  if (!MOVE_TARGETS.includes(to)) return [400, { error: `target status must be one of: ${MOVE_TARGETS.join(', ')}` }];
  if (from === to) return [400, { error: 'task already has this status' }];

  const { projects } = loadProjects(HUB_DIR);
  const p = projects.find((x) => x.id === project);
  if (!p) return [404, { error: `unknown project "${project}"` }];
  if (!existsSync(p.root)) return [404, { error: 'project path not found' }];

  const scan = scanProject(p.root, p.id);
  const matches = scan.tasks.filter((t) => t.id === id);
  if (!matches.length) return [404, { error: `task "${id}" not found` }];
  if (matches.length > 1) return [409, { error: `duplicate task id "${id}"; fix the duplicate first` }];
  const entry = matches[0];
  if (entry.status !== from) {
    // The files changed since the board loaded: refresh this project's manifest so the board shows the truth.
    try { syncProject(HUB_DIR, project); } catch { /* the 409 is still correct */ }
    return [409, { error: `status changed meanwhile (now "${entry.status}")`, current: entry.status }];
  }

  // The file must be a real task file inside <root>/tasks (no folders, no traversal).
  const abs = resolveInProject(p.root, entry.file);
  if (!abs || !/^tasks\/[^/]+\.md$/.test(entry.file)) return [400, { error: 'task file is not allowed' }];

  const raw = readFileSync(abs, 'utf8');
  const m = raw.match(/^(\uFEFF?---\r?\n)([\s\S]*?)(\r?\n---)/);
  if (!m) return [422, { error: 'task file has no frontmatter' }];
  let block = m[2];
  const setLine = (key, value) => {
    const re = new RegExp(`^(${key}:[ \\t]*)(.*?)([ \\t]+#.*)?$`, 'm');
    if (!re.test(block)) return false;
    block = block.replace(re, (_all, p1, _p2, p3) => p1 + value + (p3 || ''));
    return true;
  };
  if (!setLine('status', to)) return [422, { error: 'task file has no "status:" line' }];
  if (!setLine('updated', todayLocal())) return [422, { error: 'task file has no "updated:" line; add it first' }];
  const out = m[1] + block + m[3] + raw.slice(m[0].length);

  const tmp = `${abs}.hub-tmp`;
  try {
    writeFileSync(tmp, out, 'utf8');
    renameSync(tmp, abs);
  } catch (e) {
    try { unlinkSync(tmp); } catch { /* ignore */ }
    return [500, { error: `could not write the task file: ${e.message}` }];
  }

  const synced = syncProject(HUB_DIR, project);
  const task = synced.manifest.tasks.find((t) => t.id === id);
  const stageTasks = task && task.stage ? synced.manifest.tasks.filter((t) => t.stage === task.stage) : [];
  const stageComplete = stageTasks.length > 0 && stageTasks.every((t) => t.status === 'done');
  return [200, { ok: true, task, stageComplete }];
}

function handleMove(req, res) {
  if (!sameOriginOk(req)) return sendJson(res, 403, { error: 'cross-origin request refused' });
  if (!(req.headers['content-type'] || '').startsWith('application/json')) return sendJson(res, 415, { error: 'JSON required' });
  if (!safeEqual(String(req.headers['x-hub-token'] || ''), TOKEN)) return sendJson(res, 403, { error: 'bad or missing token' });
  const chunks = [];
  let size = 0;
  req.on('data', (c) => {
    size += c.length;
    if (size > 10_000) { sendJson(res, 413, { error: 'body too large' }); req.destroy(); } else chunks.push(c);
  });
  req.on('end', () => {
    if (res.writableEnded) return;
    let body;
    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return sendJson(res, 400, { error: 'invalid JSON' }); }
    try {
      const [code, payload] = moveTaskStatus(body || {});
      sendJson(res, code, payload);
    } catch (e) {
      sendJson(res, 500, { error: e.message });
    }
  });
}

// ---------- request router ----------

function handle(req, res) {
  if (!ALLOWED_HOSTS.has(String(req.headers.host))) return send(res, 403, 'Forbidden host');
  const url = new URL(req.url, `http://${req.headers.host}`);
  const path = url.pathname;

  if (req.method === 'POST') {
    if (path === '/api/task-status') return handleMove(req, res);
    return send(res, 405, 'Method not allowed');
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed');

  if (path === '/' || path === '/index.html') return serveFile(req, res, join(HUB_DIR, 'index.html'));
  if (path === '/vendor/marked.min.js') return serveFile(req, res, join(HUB_DIR, 'vendor', 'marked.min.js'));
  if (path === '/projects.json') {
    const { solution, projects } = loadProjects(HUB_DIR);
    return sendJson(res, 200, { solution, projects: projects.map((p) => ({ id: p.id, title: p.title })) });
  }
  if (path === '/api/session') {
    if (!sameOriginOk(req)) return sendJson(res, 403, { error: 'cross-origin request refused' });
    return sendJson(res, 200, { token: TOKEN });
  }
  const m = path.match(/^\/p\/([a-z0-9][a-z0-9-]*)\/(.+)$/);
  if (m) {
    const p = loadProjects(HUB_DIR).projects.find((x) => x.id === m[1]);
    if (!p) return send(res, 404, 'Unknown project');
    const abs = resolveInProject(p.root, m[2]);
    if (!abs) return send(res, 404, 'Not found');
    return serveFile(req, res, abs);
  }
  return send(res, 404, 'Not found');
}

const server = http.createServer((req, res) => {
  try { handle(req, res); } catch (e) { if (!res.headersSent) send(res, 500, 'Server error'); else res.destroy(); console.error(e); }
});
server.on('error', (e) => {
  console.error(e.code === 'EADDRINUSE' ? `Port ${PORT} is already in use. Try: node serve.mjs --port ${PORT + 1}` : e.message);
  process.exit(1);
});
server.listen(PORT, HOST, () => {
  console.log(`Workflow Hub: http://localhost:${PORT}/  (bound to ${HOST} only; Ctrl+C to stop)`);
  const { projects, problems } = loadProjects(HUB_DIR);
  projects.forEach((p) => console.log(`  ${existsSync(p.root) ? 'ok     ' : 'MISSING'} ${p.id}  ->  ${p.root}`));
  problems.forEach((p) => console.log(`  [${p.level}] ${p.file}: ${p.msg}`));
});
