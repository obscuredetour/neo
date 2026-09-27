// NEO — version history
// Git-like history for a book, kept as plain files in <book>/.history/.
//
//   objects/ab/<sha256>.html     a chapter, byte for byte as it was saved
//   objects/cd/<sha256>.json     a tree (the whole book at one moment) or its notes
//   commits/2026-09/<sha256>.json  a version: parents, tree, message, what changed
//   branches/<id>.json           a draft's name (its tip is derived, never stored)
//
// Objects and commits are named by the hash of their own bytes and never
// change, so two synced devices can't write conflicting copies of one. The
// only mutable state is which version the book was last saved from, and that
// lives in book.json (`history: {branch, base}`), next to the chapters it
// describes. No Electron here, so `node --test` can load it directly.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const NeoDiff = require('./history-diff.js');

const NAME_RE = /^[0-9a-f]{64}\.(html|json)$/;
const MAIN_BRANCH = 'b-main';

function sha256(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

// JSON with sorted keys and no whitespace: equal data, equal bytes, equal hash
function canonicalJSON(value) {
  return JSON.stringify(sortKeys(value));
}
function sortKeys(v) {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === 'object') {
    const out = {};
    for (const k of Object.keys(v).sort()) if (v[k] !== undefined) out[k] = sortKeys(v[k]);
    return out;
  }
  return v;
}

const historyDir = (bookDir) => path.join(bookDir, '.history');
const objectPath = (hdir, sha, ext) => path.join(hdir, 'objects', sha.slice(0, 2), `${sha}.${ext}`);

// Write beside the target under a .nosync name (iCloud ignores those), then
// rename into place — a synced reader never sees half a file.
function atomicWrite(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.nosync';
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

function readJSONFile(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

// ---------------------------------------------------------------------------
// Per-book caches. Commits never change once written, and chapter hashes are
// reused while a file's mtime and size hold, so status stays cheap.
// ---------------------------------------------------------------------------
const caches = new Map();
function cacheFor(bookDir) {
  let c = caches.get(bookDir);
  if (!c) {
    c = { hashes: new Map(), commits: new Map(), seen: new Set(), trees: new Map() };
    caches.set(bookDir, c);
  }
  return c;
}

// ---------------------------------------------------------------------------
// Objects
// ---------------------------------------------------------------------------
function writeObject(hdir, data, ext) {
  const sha = sha256(data);
  const file = objectPath(hdir, sha, ext);
  if (!fs.existsSync(file)) atomicWrite(file, data);
  return sha;
}

function hasObject(hdir, sha, ext) {
  return fs.existsSync(objectPath(hdir, sha, ext));
}

// {content} | {error: 'missing' | 'corrupt' | 'syncing'}. An iCloud-evicted
// file leaves a hidden ".<name>.icloud" placeholder: still downloading, not lost.
async function readObject(hdir, sha, ext) {
  if (!/^[0-9a-f]{64}$/.test(String(sha))) return { error: 'missing' };
  const file = objectPath(hdir, sha, ext);
  let buf;
  try {
    buf = await fs.promises.readFile(file);
  } catch {
    const placeholder = path.join(path.dirname(file), `.${sha}.${ext}.icloud`);
    return { error: fs.existsSync(placeholder) ? 'syncing' : 'missing' };
  }
  if (sha256(buf) !== sha) return { error: 'corrupt' };
  return { content: buf.toString('utf8') };
}

function readObjectSync(hdir, sha, ext) {
  try {
    const buf = fs.readFileSync(objectPath(hdir, sha, ext));
    return sha256(buf) === sha ? buf.toString('utf8') : null;
  } catch {
    return null;
  }
}

function readTreeSync(bookDir, sha) {
  if (!sha) return null;
  const cache = cacheFor(bookDir);
  if (cache.trees.has(sha)) return cache.trees.get(sha);
  const text = readObjectSync(historyDir(bookDir), sha, 'json');
  if (!text) return null;
  const tree = JSON.parse(text);
  cache.trees.set(sha, tree);
  return tree;
}

// ---------------------------------------------------------------------------
// The working tree: the book as it is on disk right now
// ---------------------------------------------------------------------------
function notesBlob(meta, stickies) {
  return canonicalJSON({
    chapterNotes: meta.chapterNotes || {},
    sectionNotes: meta.sectionNotes || {},
    stickies: Array.isArray(stickies) ? stickies : []
  });
}

// Returns {tree, treeJSON, treeSha, notes, files}. With `full`, `files` maps
// each chapter's sha to its bytes (for writing objects); otherwise hashes come
// from the mtime cache where possible.
function readWorkingTree(bookDir, { full = false } = {}) {
  const meta = readJSONFile(path.join(bookDir, 'book.json'), null);
  if (!meta) throw new Error('book.json unreadable');
  const cache = cacheFor(bookDir).hashes;
  const order = Array.isArray(meta.chapterOrder) ? meta.chapterOrder.slice() : [];
  const chapters = {};
  const titles = {};
  const files = new Map();
  for (const id of order) {
    const file = path.join(bookDir, 'chapters', id + '.html');
    let st = null;
    try { st = fs.statSync(file); } catch { /* a missing file reads as empty, like chapter:read */ }
    const hit = st && cache.get(file);
    if (!full && hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) {
      chapters[id] = hit.sha;
    } else {
      const buf = st ? fs.readFileSync(file) : Buffer.alloc(0);
      const sha = sha256(buf);
      chapters[id] = sha;
      if (st) cache.set(file, { mtimeMs: st.mtimeMs, size: st.size, sha });
      if (full) files.set(sha, buf);
    }
    const t = meta.chapterTitles && meta.chapterTitles[id];
    if (t) titles[id] = t;
  }
  const notes = notesBlob(meta, readJSONFile(path.join(bookDir, 'stickies.json'), []));
  const tree = { v: 1, order, titles, chapters, notes: sha256(notes) };
  const treeJSON = canonicalJSON(tree);
  return { tree, treeJSON, treeSha: sha256(treeJSON), notes, files, meta };
}

// ---------------------------------------------------------------------------
// Commits
// ---------------------------------------------------------------------------
// Picks up any commit files not seen before (including ones that arrived by
// sync since the last call). Unreadable files are retried next time.
function loadCommits(bookDir) {
  const cache = cacheFor(bookDir);
  const root = path.join(historyDir(bookDir), 'commits');
  let months = [];
  try { months = fs.readdirSync(root); } catch { return cache.commits; }
  for (const month of months) {
    if (!/^\d{4}-\d{2}$/.test(month)) continue;
    let names = [];
    try { names = fs.readdirSync(path.join(root, month)); } catch { continue; }
    for (const name of names) {
      if (!NAME_RE.test(name) || !name.endsWith('.json') || cache.seen.has(name)) continue;
      try {
        const buf = fs.readFileSync(path.join(root, month, name));
        const id = name.slice(0, 64);
        if (sha256(buf) !== id) continue;
        const c = JSON.parse(buf.toString('utf8'));
        c.id = id;
        cache.commits.set(id, c);
        cache.seen.add(name);
      } catch { /* not downloaded yet — try again later */ }
    }
  }
  return cache.commits;
}

function readCommit(bookDir, id) {
  return loadCommits(bookDir).get(id) || null;
}

// ---------------------------------------------------------------------------
// Branches (drafts)
// ---------------------------------------------------------------------------
function readBranches(bookDir) {
  const dir = path.join(historyDir(bookDir), 'branches');
  const out = {};
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return out; }
  for (const name of names) {
    if (!/^b-[a-z0-9-]+\.json$/.test(name)) continue;
    const b = readJSONFile(path.join(dir, name), null);
    if (b && b.id) out[b.id] = b;
  }
  return out;
}

function writeBranch(bookDir, b) {
  atomicWrite(path.join(historyDir(bookDir), 'branches', b.id + '.json'), JSON.stringify(b, null, 2));
  return b;
}

function ensureMainBranch(bookDir, device) {
  const file = path.join(historyDir(bookDir), 'branches', MAIN_BRANCH + '.json');
  if (fs.existsSync(file)) return;
  writeBranch(bookDir, { id: MAIN_BRANCH, name: 'Main draft', from: null, created: new Date().toISOString(), device: device || null, archived: false });
}

// A branch's tips are its commits that no other commit on the same branch
// builds on. More than one tip means two devices saved from the same point:
// diverged, and the next version joins them. A draft with no commits of its
// own yet sits on the version it was started from.
function branchTips(commits, branches, branchId) {
  const onBranch = [];
  for (const c of commits.values()) if (c.branch === branchId) onBranch.push(c);
  const built = new Set();
  for (const c of onBranch) for (const p of c.parents || []) built.add(p);
  const tips = onBranch.filter((c) => !built.has(c.id))
    .sort((x, y) => (y.date || '').localeCompare(x.date || ''))
    .map((c) => c.id);
  if (tips.length) return tips;
  const b = branches[branchId];
  return b && b.from ? [b.from] : [];
}

function listBranches(bookDir) {
  const commits = loadCommits(bookDir);
  const branches = readBranches(bookDir);
  return Object.values(branches).map((b) => {
    const tips = branchTips(commits, branches, b.id);
    const tip = commits.get(tips[0]);
    return { ...b, tips, diverged: tips.length > 1, lastDate: tip ? tip.date : b.created };
  }).sort((x, y) => (x.id === MAIN_BRANCH ? -1 : y.id === MAIN_BRANCH ? 1 : (y.lastDate || '').localeCompare(x.lastDate || '')));
}

function createBranch(bookDir, { name, from, device }) {
  const id = 'b-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6);
  return writeBranch(bookDir, {
    id, name: String(name || 'New draft').slice(0, 80), from: from || null,
    created: new Date().toISOString(), device: device || null, archived: false
  });
}

function updateBranch(bookDir, id, patch) {
  const b = readBranches(bookDir)[id];
  if (!b) throw new Error('No such draft');
  return writeBranch(bookDir, { ...b, ...patch, id });
}

// ---------------------------------------------------------------------------
// Lineage NEO didn't see happen (a crash before the hint was saved, or an
// edit made in Pocket): a new chapter whose opening paragraph just left an
// existing chapter was split from it; a vanished chapter whose opening now
// sits inside another was merged into it.
// ---------------------------------------------------------------------------
const ENTITIES = { '&nbsp;': ' ', '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'" };
function paraTexts(html) {
  const out = [];
  const re = /<p\b([^>]*)>([\s\S]*?)<\/p>/gi;
  let m;
  while ((m = re.exec(String(html || '')))) {
    if (/\bghost\b/.test(m[1])) continue; // outline placeholders aren't prose
    const t = m[2].replace(/<[^>]+>/g, '').replace(/&[a-z#0-9]+;/gi, (e) => ENTITIES[e] || ' ')
      .replace(/\s+/g, ' ').trim();
    if (t.length >= 12) out.push(t); // skips *** and one-word lines
  }
  return out;
}

function inferHints(parentTree, tree, changed, known, readHtml) {
  if (!parentTree) return [];
  const hinted = new Set(known.map((h) => (h.op === 'split' ? h.to : h.from)));
  const added = changed.added.filter((id) => !hinted.has(id));
  const removed = changed.removed.filter((id) => !hinted.has(id));
  if (!added.length && !removed.length) return [];
  const cache = new Map();
  const paras = (sha) => {
    if (!sha) return new Set();
    if (!cache.has(sha)) cache.set(sha, paraTexts(readHtml(sha)));
    return cache.get(sha);
  };
  const asSet = (sha) => new Set(paras(sha));
  // chapters present on both sides are the only possible other halves
  const shared = tree.order.filter((id) => id in parentTree.chapters);
  const out = [];
  for (const id of added) {
    const first = paras(tree.chapters[id])[0];
    if (!first) continue;
    const from = shared.find((p) => asSet(parentTree.chapters[p]).has(first) && !asSet(tree.chapters[p]).has(first));
    if (from) out.push({ op: 'split', from, to: id, inferred: true });
  }
  for (const id of removed) {
    const first = paras(parentTree.chapters[id])[0];
    if (!first) continue;
    const into = shared.find((q) => asSet(tree.chapters[q]).has(first) && !asSet(parentTree.chapters[q]).has(first));
    if (into) out.push({ op: 'merge', from: id, into, inferred: true });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Save a version
// ---------------------------------------------------------------------------
// opts: {message, kind: 'named'|'checkpoint'|'auto', auto, branch, parent,
//        extraParents, join, hints, author, device, words, restoredFrom}
// With `join`, any other tips of the branch (another device saved from the
// same point) become extra parents, so the new version brings them together.
// Returns {id, commit} or {unchanged: true, id} when nothing differs from parent.
function commit(bookDir, opts = {}) {
  const hdir = historyDir(bookDir);
  const branch = opts.branch || MAIN_BRANCH;
  const commits = loadCommits(bookDir);
  const branches = readBranches(bookDir);

  const wt = readWorkingTree(bookDir, { full: true });
  let parent = opts.parent && commits.has(opts.parent) ? opts.parent : null;
  if (!parent) parent = branchTips(commits, branches, branch)[0] || opts.parent || null;
  const others = opts.join ? branchTips(commits, branches, branch) : [];
  const extra = [...new Set([...(opts.extraParents || []), ...others])].filter((p) => p && p !== parent);
  const parentCommit = commits.get(parent);

  if (parentCommit && parentCommit.tree === wt.treeSha && !extra.length) {
    return { unchanged: true, id: parent };
  }

  // objects first, commit last: a commit never points at a missing object
  for (const [sha, buf] of wt.files) if (!hasObject(hdir, sha, 'html')) writeObject(hdir, buf, 'html');
  writeObject(hdir, wt.notes, 'json');
  writeObject(hdir, wt.treeJSON, 'json');
  if (branch === MAIN_BRANCH) ensureMainBranch(bookDir, opts.device);

  const parentTree = parentCommit ? readTreeSync(bookDir, parentCommit.tree) : null;
  const changed = NeoDiff.diffTrees(parentTree, wt.tree);
  const known = new Set([...Object.keys(wt.tree.chapters), ...Object.keys((parentTree && parentTree.chapters) || {})]);
  const hints = (opts.hints || []).filter((h) =>
    h && (h.op === 'split' || h.op === 'merge') && known.has(h.from) && known.has(h.to || h.into));
  const readHtml = (sha) => (wt.files.has(sha) ? wt.files.get(sha).toString('utf8') : readObjectSync(hdir, sha, 'html'));
  hints.push(...inferHints(parentTree, wt.tree, changed, hints, readHtml));

  const date = new Date().toISOString();
  const record = {
    v: 1,
    parents: [parent, ...extra].filter(Boolean),
    branch,
    tree: wt.treeSha,
    changed,
    hints,
    message: String(opts.message || '').slice(0, 500),
    kind: opts.kind || 'named',
    auto: opts.auto || null,
    author: opts.author || null,
    device: opts.device || null,
    date,
    words: Number.isFinite(opts.words) ? opts.words : null,
    restoredFrom: opts.restoredFrom || null
  };
  const json = canonicalJSON(record);
  const id = sha256(json);
  atomicWrite(path.join(hdir, 'commits', date.slice(0, 7), id + '.json'), json);
  const cache = cacheFor(bookDir);
  cache.commits.set(id, { ...record, id });
  cache.seen.add(id + '.json');
  cache.trees.set(wt.treeSha, wt.tree);
  return { id, commit: { ...record, id } };
}

// ---------------------------------------------------------------------------
// Status: is the book different from the version it was last saved from?
// head = book.history from book.json: {branch, base}
// ---------------------------------------------------------------------------
function status(bookDir, head = {}) {
  const hdir = historyDir(bookDir);
  const commits = loadCommits(bookDir);
  const branches = readBranches(bookDir);
  const enabled = commits.size > 0 || fs.existsSync(path.join(hdir, 'branches', MAIN_BRANCH + '.json'));
  const branch = head.branch || MAIN_BRANCH;
  const tips = branchTips(commits, branches, branch);
  const base = head.base || null;
  const baseCommit = base ? commits.get(base) : null;
  const wt = readWorkingTree(bookDir);
  let dirty = true, changed = null;
  if (baseCommit) {
    dirty = baseCommit.tree !== wt.treeSha;
    if (dirty) changed = NeoDiff.diffTrees(readTreeSync(bookDir, baseCommit.tree), wt.tree);
  }
  const dirtyChapters = changed
    ? [...changed.modified, ...changed.added]
    : (dirty ? wt.tree.order.slice() : []);
  const b = branches[branch];
  return {
    enabled,
    branch,
    branchName: b ? b.name : (branch === MAIN_BRANCH ? 'Main draft' : branch),
    base,
    baseMissing: !!base && !baseCommit,
    tips,
    diverged: tips.length > 1,
    dirty,
    dirtyChapters,
    changed,
    last: baseCommit ? { message: baseCommit.message, date: baseCommit.date, kind: baseCommit.kind, auto: baseCommit.auto } : null
  };
}

// ---------------------------------------------------------------------------
// Log: versions newest first, walking back from the branch's tips (and the
// book's base) through parents. With chapterId, only versions that touched
// that chapter — following it back through splits and merges into the
// chapters it came from.
// ---------------------------------------------------------------------------
function log(bookDir, { branch, base, chapterId, limit = 100, offset = 0 } = {}) {
  const commits = loadCommits(bookDir);
  const branches = readBranches(bookDir);
  const starts = new Set(branchTips(commits, branches, branch || MAIN_BRANCH));
  if (base) starts.add(base);

  const queue = [];
  const queued = new Set();
  let truncated = null;
  const push = (id) => {
    if (!id || queued.has(id)) return;
    queued.add(id);
    const c = commits.get(id);
    if (!c) { truncated = 'syncing'; return; }
    queue.push(c);
  };
  for (const id of starts) push(id);

  const relevant = chapterId ? new Set([chapterId]) : null;
  const touches = (c) => {
    const ch = c.changed || {};
    for (const list of [ch.modified, ch.added, ch.removed, ch.titles]) {
      for (const id of list || []) if (relevant.has(id)) return true;
    }
    return false;
  };

  const entries = [];
  let matched = 0, more = false;
  while (queue.length) {
    // newest first across however many lines of history are open
    let best = 0;
    for (let i = 1; i < queue.length; i++) if ((queue[i].date || '') > (queue[best].date || '')) best = i;
    const c = queue.splice(best, 1)[0];
    let include = true;
    if (relevant) {
      include = touches(c);
      for (const h of c.hints || []) {
        const target = h.op === 'split' ? h.to : h.into;
        if (relevant.has(target) && !relevant.has(h.from)) { relevant.add(h.from); include = true; }
      }
    }
    if (include) {
      const prev = commits.get((c.parents || [])[0]);
      if (matched >= offset && entries.length < limit) entries.push({ ...c, prevWords: prev ? prev.words : null });
      else if (entries.length >= limit) { more = true; break; }
      matched++;
    }
    for (const p of c.parents || []) push(p);
  }
  return { entries, more, truncated };
}

// ---------------------------------------------------------------------------
// Reading old versions
// ---------------------------------------------------------------------------
async function readTree(bookDir, sha) {
  const r = await readObject(historyDir(bookDir), sha, 'json');
  if (r.error) return r;
  try {
    const tree = JSON.parse(r.content);
    const n = await readObject(historyDir(bookDir), tree.notes, 'json');
    return { tree, notes: n.error ? null : JSON.parse(n.content), notesError: n.error || null };
  } catch {
    return { error: 'corrupt' };
  }
}

function readBlob(bookDir, sha, ext = 'html') {
  if (ext !== 'html' && ext !== 'json') return Promise.resolve({ error: 'missing' });
  return readObject(historyDir(bookDir), sha, ext);
}

module.exports = {
  MAIN_BRANCH,
  sha256,
  canonicalJSON,
  historyDir,
  objectPath,
  readWorkingTree,
  readObject,
  loadCommits,
  readCommit,
  branchTips,
  listBranches,
  createBranch,
  updateBranch,
  commit,
  status,
  log,
  readTree,
  readBlob,
  paraTexts,
  _caches: caches
};
