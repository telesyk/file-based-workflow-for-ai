#!/usr/bin/env node
// Workflow Hub: manifest generator and validator. No dependencies.
//
// Usage (from anywhere):
//   node sync-manifests.mjs --all
//   node sync-manifests.mjs --project <id>
//   add --dry-run to only report (nothing is written)
//
// It reads projects.json (next to this script), scans tasks/*.md and notes/**/*.md of every
// project, and writes <project>/board/manifest.json. Problems are reported, never fixed silently.
// Exit code: 0 = ok, 2 = at least one error was found, 1 = bad usage.

import { readFileSync, writeFileSync, existsSync, readdirSync, copyFileSync, mkdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const STATUSES = ['backlog', 'in-progress', 'testing', 'done', 'unstaged'];
export const SCHEMA = 1;
const HUB_DIR = dirname(fileURLToPath(import.meta.url));
const ID_RE = /^[a-z0-9][a-z0-9-]*$/;
const REF_RE = /^([a-z0-9][a-z0-9-]*)\/([A-Za-z0-9._-]+)$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function todayLocal() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// ---------- frontmatter ----------
// Supported: flat "key: value" scalars, inline arrays "[a, b]", an inline comment after " #".
// A value that contains " #" must be quoted. Nothing else (no nested YAML).

function unquote(s) {
  const m = s.match(/^(["'])(.*)\1$/);
  return m ? m[2] : s;
}

function parseValue(raw) {
  const v = raw.trim();
  if (v[0] === '"') {
    // Double-quoted: \" and \\ are escapes. Text after the closing quote (a comment) is ignored.
    let out = '';
    for (let i = 1; i < v.length; i++) {
      const c = v[i];
      if (c === '\\' && i + 1 < v.length) {
        const n = v[++i];
        out += n === 'n' ? '\n' : n === 't' ? '\t' : n === '"' || n === '\\' || n === '/' ? n : c + n;
      } else if (c === '"') return out;
      else out += c;
    }
  } else if (v[0] === "'") {
    // Single-quoted: '' is an escaped quote.
    let out = '';
    for (let i = 1; i < v.length; i++) {
      if (v[i] === "'") { if (v[i + 1] === "'") { out += "'"; i++; } else return out; }
      else out += v[i];
    }
  }
  const noComment = v.replace(/(^|\s)#.*$/, '').trim();
  if (noComment === 'null' || noComment === '~') return '';
  if (noComment.startsWith('[') && noComment.endsWith(']')) {
    return noComment.slice(1, -1).split(',').map((s) => unquote(s.trim())).filter(Boolean);
  }
  return noComment;
}

export function parseFrontmatter(text) {
  const m = text.replace(/^\uFEFF/, '').match(/^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/);
  if (!m) return null;
  const data = {};
  const unsupported = [];
  for (const line of m[1].split(/\r?\n/)) {
    if (!line.trim() || /^\s*#/.test(line)) continue;
    const kv = line.match(/^([A-Za-z_][\w-]*):[ \t]*(.*)$/);
    if (!kv) { unsupported.push(line.trim()); continue; }
    data[kv[1]] = parseValue(kv[2]);
  }
  return { data, unsupported };
}

// Status rules: an exact enum word at the start keeps that word (rest goes to note);
// anything else becomes "unstaged" and the whole text goes to note.
export function normalizeStatus(rawStatus, rawNote) {
  const raw = typeof rawStatus === 'string' ? rawStatus.trim() : '';
  const note = typeof rawNote === 'string' ? rawNote.trim() : '';
  if (STATUSES.includes(raw)) return { status: raw, note, changed: false };
  const first = raw.split(/\s+/)[0];
  if (raw && STATUSES.includes(first)) {
    return { status: first, note: [raw.slice(first.length).trim(), note].filter(Boolean).join(' '), changed: true };
  }
  return { status: 'unstaged', note: [raw, note].filter(Boolean).join(' '), changed: true };
}

// ---------- scanning one project ----------

const byName = (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

function walkMd(dir, prefix, out) {
  for (const e of readdirSync(dir, { withFileTypes: true }).sort(byName)) {
    if (e.isDirectory()) walkMd(join(dir, e.name), `${prefix}${e.name}/`, out);
    else if (e.name.endsWith('.md')) out.push(`${prefix}${e.name}`);
  }
}

export function scanProject(root, projectId) {
  const problems = [];
  const add = (level, file, msg) => problems.push({ level, project: projectId, file, msg });
  const tasks = [];
  const notes = [];

  const tdir = join(root, 'tasks');
  if (existsSync(tdir)) {
    for (const e of readdirSync(tdir, { withFileTypes: true }).sort(byName)) {
      const file = `tasks/${e.name}`;
      if (e.isDirectory()) { add('warn', file, 'subfolder in tasks/ is ignored (tasks must be flat)'); continue; }
      if (!e.name.endsWith('.md')) continue;
      const fm = parseFrontmatter(readFileSync(join(tdir, e.name), 'utf8'));
      if (!fm) { add('error', file, 'no frontmatter'); continue; }
      const d = fm.data;
      fm.unsupported.forEach((u) => add('warn', file, `unsupported frontmatter line ignored: ${u}`));
      let id = d.id || '';
      if (!id) { add('error', file, 'missing id'); id = e.name.replace(/\.md$/, ''); }
      else if (!(e.name === `${id}.md` || e.name.startsWith(`${id}-`))) add('error', file, `id "${id}" does not match the filename`);
      if (d.status === undefined) add('warn', file, 'missing status (shown as unstaged)');
      const ns = normalizeStatus(d.status, d.note);
      if (d.status !== undefined && ns.changed) add('warn', file, `status "${d.status}" is not one of the five values (shown as ${ns.status})`);
      if (!d.title) add('warn', file, 'missing title');
      for (const k of ['created', 'updated']) {
        if (!d[k]) add('warn', file, `missing ${k}`);
        else if (!DATE_RE.test(d[k])) add('warn', file, `${k} "${d[k]}" is not YYYY-MM-DD`);
      }
      let related = [];
      if (Array.isArray(d.related)) related = d.related;
      else if (d.related) add('error', file, 'related must be an inline list, for example [other/task-001]');
      tasks.push({
        id, title: d.title || e.name.replace(/\.md$/, ''), status: ns.status, stage: d.stage || '', source: d.source || '',
        created: d.created || '', updated: d.updated || '', file, note: ns.note, related, relatedBy: [],
      });
    }
    const seen = new Map();
    tasks.forEach((t) => seen.set(t.id, (seen.get(t.id) || 0) + 1));
    tasks.filter((t) => seen.get(t.id) > 1).forEach((t) => add('error', t.file, `duplicate task id "${t.id}"`));
  }

  const ndir = join(root, 'notes');
  if (existsSync(ndir)) {
    const files = [];
    walkMd(ndir, '', files);
    for (const rel of files) {
      const file = `notes/${rel}`;
      const slash = rel.indexOf('/');
      let category = slash > 0 ? rel.slice(0, slash) : 'uncategorized';
      if (slash < 0) add('warn', file, 'note is not inside a category folder (shown as "uncategorized")');
      const text = readFileSync(join(ndir, rel), 'utf8');
      const fm = parseFrontmatter(text);
      if (!fm) { add('warn', file, 'no frontmatter'); }
      const d = fm ? fm.data : {};
      if (fm) fm.unsupported.forEach((u) => add('warn', file, `unsupported frontmatter line ignored: ${u}`));
      // "archive: <date>" marks a note whose title and dates were not recorded: the date stands in for
      // created and updated, and the title comes from the first "# " heading.
      const archive = d.archive || '';
      if (archive && !DATE_RE.test(archive)) add('warn', file, `archive "${archive}" is not YYYY-MM-DD`);
      const h1 = (text.replace(/^\uFEFF/, '').replace(/^---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/, '').match(/^# +(.+?)\s*$/m) || [])[1] || '';
      if (!d.title && !archive) add('warn', file, 'missing title');
      for (const k of ['created', 'updated']) {
        if (!d[k] && !archive) add('warn', file, `missing ${k}`);
        else if (d[k] && !DATE_RE.test(d[k])) add('warn', file, `${k} "${d[k]}" is not YYYY-MM-DD`);
      }
      const entry = {
        title: d.title || h1 || rel.replace(/\.md$/, ''), category, created: d.created || archive, updated: d.updated || archive, file,
      };
      if (archive) entry.archive = archive;
      notes.push(entry);
    }
  }

  tasks.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : a.file < b.file ? -1 : 1));
  notes.sort((a, b) => (a.file < b.file ? -1 : 1));
  return { tasks, notes, problems };
}

// ---------- project list ----------

export function loadProjects(hubDir = HUB_DIR) {
  const problems = [];
  const file = join(hubDir, 'projects.json');
  let cfg;
  try { cfg = JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); }
  catch (e) { return { solution: '', projects: [], problems: [{ level: 'error', project: '-', file: 'projects.json', msg: `cannot read projects.json: ${e.message}` }] }; }
  const projects = [];
  const ids = new Set();
  for (const p of Array.isArray(cfg.projects) ? cfg.projects : []) {
    if (!p || typeof p.id !== 'string' || !ID_RE.test(p.id)) { problems.push({ level: 'error', project: String(p && p.id), file: 'projects.json', msg: 'id must be a lowercase slug (a-z, 0-9, -)' }); continue; }
    if (ids.has(p.id)) { problems.push({ level: 'error', project: p.id, file: 'projects.json', msg: 'duplicate project id' }); continue; }
    if (typeof p.path !== 'string' || !p.path) { problems.push({ level: 'error', project: p.id, file: 'projects.json', msg: 'missing path' }); continue; }
    ids.add(p.id);
    projects.push({ id: p.id, title: p.title || p.id, root: resolve(hubDir, p.path) });
  }
  return { solution: typeof cfg.solution === 'string' ? cfg.solution : '', projects, problems };
}

// ---------- all projects: scan + resolve cross-project links ----------

export function buildAll(projects) {
  const result = new Map();
  const scans = new Map();
  for (const p of projects) {
    if (!existsSync(p.root)) {
      result.set(p.id, { manifest: null, problems: [{ level: 'error', project: p.id, file: '.', msg: `project path not found: ${p.root}` }] });
      continue;
    }
    const s = scanProject(p.root, p.id);
    scans.set(p.id, s);
  }
  const index = new Map();
  for (const [pid, s] of scans) index.set(pid, new Map(s.tasks.map((t) => [t.id, t])));

  for (const [pid, s] of scans) {
    for (const t of s.tasks) {
      for (const ref of t.related) {
        const m = REF_RE.exec(ref);
        if (!m) { s.problems.push({ level: 'error', project: pid, file: t.file, msg: `malformed related reference "${ref}" (use <project-id>/<task-id>)` }); continue; }
        const target = index.get(m[1]);
        if (!target) { s.problems.push({ level: 'error', project: pid, file: t.file, msg: `related "${ref}": unknown project "${m[1]}"` }); continue; }
        const tt = target.get(m[2]);
        if (!tt) { s.problems.push({ level: 'error', project: pid, file: t.file, msg: `related "${ref}": task not found` }); continue; }
        const back = `${pid}/${t.id}`;
        if (!tt.relatedBy.includes(back)) tt.relatedBy.push(back);
      }
    }
  }
  for (const [pid, s] of scans) {
    s.tasks.forEach((t) => t.relatedBy.sort());
    result.set(pid, {
      manifest: { schema: SCHEMA, project: pid, generated: todayLocal(), tasks: s.tasks, notes: s.notes },
      problems: s.problems,
    });
  }
  return result;
}

// ---------- writing a manifest ----------

const strip = (m) => JSON.stringify({ ...m, generated: undefined });

export function diffManifests(oldM, newM) {
  const out = [];
  if (!oldM) return ['no previous manifest'];
  if (oldM.schema !== SCHEMA) out.push(`previous manifest has another format (schema: ${oldM.schema === undefined ? 'none' : oldM.schema})`);
  const cmp = (kind, oldList, newList, keyFn, label) => {
    const o = new Map((oldList || []).map((x) => [keyFn(x), x]));
    const n = new Map((newList || []).map((x) => [keyFn(x), x]));
    for (const [k, v] of n) {
      if (!o.has(k)) out.push(`+ ${kind} ${k}${label(v)}`);
      else {
        const ov = o.get(k);
        const fields = Object.keys(v).filter((f) => JSON.stringify(v[f]) !== JSON.stringify(ov[f]));
        if (fields.length) out.push(`~ ${kind} ${k}: ${fields.map((f) => `${f} ${JSON.stringify(ov[f])} -> ${JSON.stringify(v[f])}`).join('; ')}`);
      }
    }
    for (const [k] of o) if (!n.has(k)) out.push(`- ${kind} ${k}`);
  };
  cmp('task', oldM.tasks, newM.tasks, (t) => t.id, (t) => ` (${t.status})`);
  cmp('note', oldM.notes, newM.notes, (x) => x.file, () => '');
  return out;
}

export function writeManifest(root, manifest, { backup = false, dryRun = false } = {}) {
  const dir = join(root, 'board');
  const path = join(dir, 'manifest.json');
  let old = null;
  if (existsSync(path)) { try { old = JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, '')); } catch { old = null; } }
  if (old && strip(old) === strip(manifest)) return { changed: false, wrote: false, diff: [], backupPath: '' };
  const diff = diffManifests(old, manifest);
  if (dryRun) return { changed: true, wrote: false, diff, backupPath: '' };
  mkdirSync(dir, { recursive: true });
  let backupPath = '';
  // First-run safety: keep a copy only of a manifest this hub did not write itself (no matching schema).
  if (backup && existsSync(path) && (!old || old.schema !== SCHEMA)) {
    backupPath = `${path}.bak-${todayLocal()}`;
    if (!existsSync(backupPath)) copyFileSync(path, backupPath);
    else backupPath = `${backupPath} (already existed, kept)`;
  }
  writeFileSync(path, JSON.stringify(manifest, null, 2) + '\n');
  return { changed: true, wrote: true, diff, backupPath };
}

// Rebuilds one project's manifest (used by serve.mjs after a status change).
// Cross-project links are resolved read-only against all projects.
export function syncProject(hubDir, id, opts = {}) {
  const { projects } = loadProjects(hubDir);
  const p = projects.find((x) => x.id === id);
  if (!p) throw new Error(`unknown project "${id}"`);
  const all = buildAll(projects);
  const r = all.get(id);
  if (!r || !r.manifest) throw new Error(`project "${id}" is not reachable`);
  const w = writeManifest(p.root, r.manifest, opts);
  return { manifest: r.manifest, problems: r.problems, write: w };
}

// ---------- CLI ----------

function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const all = args.includes('--all');
  const pi = args.indexOf('--project');
  const only = pi >= 0 ? args[pi + 1] : '';
  if (!all && !only) {
    console.error('Usage: node sync-manifests.mjs --all | --project <id>  [--dry-run]');
    process.exit(1);
  }
  const { projects, problems: cfgProblems } = loadProjects(HUB_DIR);
  if (only && !projects.some((p) => p.id === only)) {
    console.error(`Unknown project id "${only}". Known: ${projects.map((p) => p.id).join(', ') || '(none)'}`);
    process.exit(1);
  }
  const results = buildAll(projects);
  let errors = cfgProblems.filter((p) => p.level === 'error').length;
  cfgProblems.forEach((p) => console.log(`  [${p.level}] ${p.file}: ${p.msg}`));

  for (const p of projects) {
    if (only && p.id !== only) continue;
    const r = results.get(p.id);
    console.log(`\n== ${p.id} (${p.root})`);
    if (!r.manifest) {
      r.problems.forEach((x) => console.log(`  [${x.level}] ${x.msg}`));
      errors += r.problems.length;
      continue;
    }
    const w = writeManifest(p.root, r.manifest, { backup: true, dryRun });
    if (!w.changed) console.log(`  manifest unchanged (${r.manifest.tasks.length} tasks, ${r.manifest.notes.length} notes)`);
    else {
      console.log(`  manifest ${dryRun ? 'WOULD CHANGE (dry run)' : 'written'}: ${r.manifest.tasks.length} tasks, ${r.manifest.notes.length} notes`);
      if (w.backupPath) console.log(`  previous manifest saved as ${w.backupPath} (delete it after you confirm the result)`);
      w.diff.slice(0, 40).forEach((l) => console.log(`    ${l}`));
      if (w.diff.length > 40) console.log(`    ... and ${w.diff.length - 40} more`);
    }
    r.problems.forEach((x) => console.log(`  [${x.level}] ${x.file}: ${x.msg}`));
    errors += r.problems.filter((x) => x.level === 'error').length;
  }
  console.log(errors ? `\n${errors} error(s) found. Please review.` : '\nNo errors.');
  process.exit(errors ? 2 : 0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();
