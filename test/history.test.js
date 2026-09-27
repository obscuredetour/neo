const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const H = require('../history.js');

// A throwaway book folder shaped like main.js book:create makes them
function makeBook(chapters = { 'ch-a': '<p>One.</p>', 'ch-b': '<p>Two.</p>' }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'neo-history-'));
  fs.mkdirSync(path.join(dir, 'chapters'));
  const meta = { id: path.basename(dir), title: 'Test', chapterOrder: Object.keys(chapters), chapterTitles: {}, chapterNotes: {}, sectionNotes: {} };
  fs.writeFileSync(path.join(dir, 'book.json'), JSON.stringify(meta));
  fs.writeFileSync(path.join(dir, 'stickies.json'), '[]');
  for (const [id, html] of Object.entries(chapters)) fs.writeFileSync(path.join(dir, 'chapters', id + '.html'), html);
  return dir;
}
const meta = (dir) => JSON.parse(fs.readFileSync(path.join(dir, 'book.json'), 'utf8'));
const setMeta = (dir, m) => fs.writeFileSync(path.join(dir, 'book.json'), JSON.stringify(m));
const writeCh = (dir, id, html) => {
  const f = path.join(dir, 'chapters', id + '.html');
  fs.writeFileSync(f, html);
  // make sure the mtime moves even on coarse clocks
  const t = new Date(Date.now() + Math.random() * 1e6);
  fs.utimesSync(f, t, t);
};
const countFiles = (dir) => {
  let n = 0;
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) e.isDirectory() ? walk(path.join(d, e.name)) : n++; };
  if (fs.existsSync(dir)) walk(dir);
  return n;
};

test('first commit creates the main draft; same tree again is unchanged', () => {
  const dir = makeBook();
  assert.equal(H.status(dir).enabled, false);
  const r = H.commit(dir, { message: 'Baseline', kind: 'auto', auto: 'init' });
  assert.ok(r.id);
  assert.ok(fs.existsSync(path.join(dir, '.history', 'branches', 'b-main.json')));
  assert.deepEqual(r.commit.changed.added, ['ch-a', 'ch-b']);
  assert.deepEqual(r.commit.parents, []);
  const again = H.commit(dir, { parent: r.id });
  assert.equal(again.unchanged, true);
  assert.equal(again.id, r.id);
  const st = H.status(dir, { branch: 'b-main', base: r.id });
  assert.equal(st.enabled, true);
  assert.equal(st.dirty, false);
});

test('changing one chapter writes one chapter object plus a tree', () => {
  const dir = makeBook();
  const r1 = H.commit(dir, {});
  const objects = path.join(dir, '.history', 'objects');
  const before = countFiles(objects);
  writeCh(dir, 'ch-b', '<p>Two, revised.</p>');
  const r2 = H.commit(dir, { parent: r1.id, message: 'Revise two' });
  assert.equal(countFiles(objects) - before, 2); // chapter blob + tree; notes unchanged
  assert.deepEqual(r2.commit.parents, [r1.id]);
  assert.deepEqual(r2.commit.changed.modified, ['ch-b']);
  assert.equal(r2.commit.changed.notes, false);
});

test('status goes dirty after an edit, clean after a commit, and caches hashes', () => {
  const dir = makeBook();
  const r1 = H.commit(dir, {});
  writeCh(dir, 'ch-a', '<p>One, changed.</p>');
  const st = H.status(dir, { base: r1.id });
  assert.equal(st.dirty, true);
  assert.deepEqual(st.dirtyChapters, ['ch-a']);
  assert.equal(st.last.message, '');
  const r2 = H.commit(dir, { parent: r1.id });
  assert.equal(H.status(dir, { base: r2.id }).dirty, false);
  // a second read reuses the cached hash (file untouched)
  const cache = H._caches.get(dir).hashes;
  assert.ok(cache.get(path.join(dir, 'chapters', 'ch-a.html')));
});

test('notes and stickies are part of the tree', () => {
  const dir = makeBook();
  const r1 = H.commit(dir, {});
  const m = meta(dir); m.chapterNotes = { 'ch-a': 'Opening' }; setMeta(dir, m);
  const st = H.status(dir, { base: r1.id });
  assert.equal(st.dirty, true);
  assert.equal(st.changed.notes, true);
});

test('reading objects: ok, tampered is corrupt, placeholder is syncing, unknown is missing', async () => {
  const dir = makeBook();
  const r = H.commit(dir, {});
  const t = await H.readTree(dir, r.commit.tree);
  assert.deepEqual(t.tree.order, ['ch-a', 'ch-b']);
  assert.deepEqual(t.notes.stickies, []);
  const sha = t.tree.chapters['ch-a'];
  assert.equal((await H.readBlob(dir, sha)).content, '<p>One.</p>');

  const hdir = H.historyDir(dir);
  const file = H.objectPath(hdir, sha, 'html');
  fs.writeFileSync(file, '<p>On');
  assert.equal((await H.readBlob(dir, sha)).error, 'corrupt');

  fs.unlinkSync(file);
  assert.equal((await H.readBlob(dir, sha)).error, 'missing');
  fs.writeFileSync(path.join(path.dirname(file), `.${sha}.html.icloud`), '');
  assert.equal((await H.readBlob(dir, sha)).error, 'syncing');
  assert.equal((await H.readBlob(dir, '../../book')).error, 'missing');
});

test('stray sync files in commits/ are ignored', () => {
  const dir = makeBook();
  const r = H.commit(dir, {});
  const month = r.commit.date.slice(0, 7);
  const cdir = path.join(dir, '.history', 'commits', month);
  fs.copyFileSync(path.join(cdir, r.id + '.json'), path.join(cdir, r.id + ' 2.json'));
  fs.writeFileSync(path.join(cdir, 'f'.repeat(64) + '.json.nosync'), '{}');
  fs.writeFileSync(path.join(cdir, 'e'.repeat(64) + '.json'), '{"not":"matching its hash"}');
  H._caches.delete(dir);
  const commits = H.loadCommits(dir);
  assert.deepEqual([...commits.keys()], [r.id]);
});

test('tips: linear, diverged, joined, and a fresh draft', () => {
  const dir = makeBook();
  const r1 = H.commit(dir, {});
  writeCh(dir, 'ch-a', '<p>A1</p>');
  const r2 = H.commit(dir, { parent: r1.id });
  assert.deepEqual(H.status(dir, { base: r2.id }).tips, [r2.id]);

  // another device saved from r1 too
  writeCh(dir, 'ch-a', '<p>A2</p>');
  const r3 = H.commit(dir, { parent: r1.id });
  const st = H.status(dir, { base: r3.id });
  assert.equal(st.diverged, true);
  assert.deepEqual(new Set(st.tips), new Set([r2.id, r3.id]));

  // the next version joins them
  writeCh(dir, 'ch-a', '<p>A3</p>');
  const r4 = H.commit(dir, { parent: r3.id, join: true });
  assert.deepEqual(r4.commit.parents, [r3.id, r2.id]);
  assert.deepEqual(H.status(dir, { base: r4.id }).tips, [r4.id]);

  // a new draft starts at r4 and gets its own tip on its first save
  const b = H.createBranch(dir, { name: 'Darker ending', from: r4.id });
  assert.deepEqual(H.status(dir, { branch: b.id, base: r4.id }).tips, [r4.id]);
  writeCh(dir, 'ch-b', '<p>Darker.</p>');
  const r5 = H.commit(dir, { branch: b.id, parent: r4.id });
  assert.deepEqual(H.status(dir, { branch: b.id, base: r5.id }).tips, [r5.id]);
  assert.deepEqual(H.status(dir, { branch: 'b-main', base: r4.id }).tips, [r4.id]);
  const list = H.listBranches(dir);
  assert.equal(list[0].id, 'b-main');
  assert.equal(list[1].name, 'Darker ending');
  H.updateBranch(dir, b.id, { name: 'Darkest ending' });
  assert.equal(H.listBranches(dir)[1].name, 'Darkest ending');
});

test('log is newest first, filters by chapter, and follows a split back', () => {
  const dir = makeBook({ 'ch-a': '<p>Alpha.</p><p>Beta.</p>' });
  const r1 = H.commit(dir, { message: 'start' });
  writeCh(dir, 'ch-a', '<p>Alpha!</p><p>Beta.</p>');
  const r2 = H.commit(dir, { parent: r1.id, message: 'edit a' });
  // split: Beta moves to a new chapter
  writeCh(dir, 'ch-a', '<p>Alpha!</p>');
  writeCh(dir, 'ch-z', '<p>Beta.</p>');
  const m = meta(dir); m.chapterOrder = ['ch-a', 'ch-z']; setMeta(dir, m);
  const r3 = H.commit(dir, { parent: r2.id, message: 'split', hints: [{ op: 'split', from: 'ch-a', to: 'ch-z' }, { op: 'split', from: 'ch-gone', to: 'ch-z' }] });
  assert.deepEqual(r3.commit.hints, [{ op: 'split', from: 'ch-a', to: 'ch-z' }]);
  writeCh(dir, 'ch-a', '<p>Alpha!!</p>');
  const r4 = H.commit(dir, { parent: r3.id, message: 'edit a again' });

  const all = H.log(dir, { base: r4.id });
  assert.deepEqual(all.entries.map((c) => c.message), ['edit a again', 'split', 'edit a', 'start']);
  assert.equal(all.entries.at(-1).prevWords, null);

  const z = H.log(dir, { base: r4.id, chapterId: 'ch-z' });
  assert.deepEqual(z.entries.map((c) => c.message), ['split', 'edit a', 'start']);

  const paged = H.log(dir, { base: r4.id, limit: 2 });
  assert.equal(paged.entries.length, 2);
  assert.equal(paged.more, true);
  const next = H.log(dir, { base: r4.id, limit: 2, offset: 2 });
  assert.deepEqual(next.entries.map((c) => c.message), ['edit a', 'start']);
  assert.equal(next.more, false);
});

test('log reports a missing parent as truncated', () => {
  const dir = makeBook();
  const r1 = H.commit(dir, {});
  writeCh(dir, 'ch-a', '<p>x</p>');
  const r2 = H.commit(dir, { parent: r1.id });
  fs.unlinkSync(path.join(dir, '.history', 'commits', r1.commit.date.slice(0, 7), r1.id + '.json'));
  H._caches.delete(dir);
  const l = H.log(dir, { base: r2.id });
  assert.equal(l.entries.length, 1);
  assert.equal(l.truncated, 'syncing');
});

test('no .nosync temp files are left behind', () => {
  const dir = makeBook();
  H.commit(dir, {});
  const leftovers = [];
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); e.isDirectory() ? walk(p) : e.name.endsWith('.nosync') && leftovers.push(p); } };
  walk(path.join(dir, '.history'));
  assert.deepEqual(leftovers, []);
});
