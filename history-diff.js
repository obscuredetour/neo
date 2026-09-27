// NEO — version-history diffs
// Pure functions shared by the main process (require) and the renderer
// (a classic <script>, exposed as window.NeoDiff). No DOM, no dependencies:
// strings and arrays in, edit operations out.

(function (root) {
  'use strict';

  // Past this many DP cells a diff isn't worth the wait — the changed
  // middle is reported as one wholesale replacement instead.
  const MAX_CELLS = 4e6;
  const MAX_TOKENS = 3000;

  // Longest-common-subsequence edit script between two arrays.
  // Returns [{op:'eq', a, b} | {op:'del', a} | {op:'ins', b}] in order,
  // with deletions before insertions wherever the two are interchangeable.
  function lcsOps(a, b, eq) {
    eq = eq || ((x, y) => x === y);
    const ops = [];
    let start = 0;
    while (start < a.length && start < b.length && eq(a[start], b[start])) {
      ops.push({ op: 'eq', a: start, b: start });
      start++;
    }
    let endA = a.length, endB = b.length;
    const tail = [];
    while (endA > start && endB > start && eq(a[endA - 1], b[endB - 1])) {
      endA--; endB--;
      tail.push({ op: 'eq', a: endA, b: endB });
    }

    const n = endA - start, m = endB - start;
    if (n && m && n * m <= MAX_CELLS) {
      // L[i][j] = LCS length of a[start+i..endA) and b[start+j..endB)
      const w = m + 1;
      const L = new Uint32Array((n + 1) * w);
      for (let i = n - 1; i >= 0; i--) {
        for (let j = m - 1; j >= 0; j--) {
          L[i * w + j] = eq(a[start + i], b[start + j])
            ? L[(i + 1) * w + j + 1] + 1
            : Math.max(L[(i + 1) * w + j], L[i * w + j + 1]);
        }
      }
      let i = 0, j = 0;
      while (i < n && j < m) {
        if (eq(a[start + i], b[start + j])) {
          ops.push({ op: 'eq', a: start + i, b: start + j }); i++; j++;
        } else if (L[(i + 1) * w + j] >= L[i * w + j + 1]) {
          ops.push({ op: 'del', a: start + i }); i++;
        } else {
          ops.push({ op: 'ins', b: start + j }); j++;
        }
      }
      for (; i < n; i++) ops.push({ op: 'del', a: start + i });
      for (; j < m; j++) ops.push({ op: 'ins', b: start + j });
    } else {
      for (let i = start; i < endA; i++) ops.push({ op: 'del', a: i });
      for (let j = start; j < endB; j++) ops.push({ op: 'ins', b: j });
    }
    for (let k = tail.length - 1; k >= 0; k--) ops.push(tail[k]);
    return ops;
  }

  // Words, runs of whitespace, and single punctuation marks. Apostrophes
  // (straight and curly) and hyphens stay inside words: don't, it’s, ex-wife.
  const TOKEN_RE = /\s+|[\p{L}\p{N}\p{M}'’\-]+|[^\s\p{L}\p{N}\p{M}]/gu;
  function tokenize(text) {
    return String(text || '').match(TOKEN_RE) || [];
  }

  function wordSet(text) {
    const s = new Set();
    for (const t of tokenize(text)) {
      if (/[\p{L}\p{N}]/u.test(t)) s.add(t.toLowerCase());
    }
    return s;
  }

  function similarity(a, b) {
    const A = wordSet(a), B = wordSet(b);
    if (!A.size && !B.size) return 1;
    let shared = 0;
    for (const w of A) if (B.has(w)) shared++;
    return shared / (A.size + B.size - shared);
  }

  // Paragraph-level diff. Keys decide identity (sanitized paragraph HTML, so
  // a formatting-only change still counts); texts decide whether a deleted
  // and an inserted paragraph are really one paragraph, revised.
  // Returns [{op:'eq',a,b} | {op:'del',a} | {op:'ins',b} | {op:'mod',a,b}].
  function diffParagraphs(aKeys, bKeys, aTexts, bTexts) {
    aTexts = aTexts || aKeys;
    bTexts = bTexts || bKeys;
    const raw = lcsOps(aKeys, bKeys);
    const out = [];
    let k = 0;
    while (k < raw.length) {
      if (raw[k].op === 'eq') { out.push(raw[k]); k++; continue; }
      const dels = [], ins = [];
      while (k < raw.length && raw[k].op !== 'eq') {
        if (raw[k].op === 'del') dels.push(raw[k].a); else ins.push(raw[k].b);
        k++;
      }
      pairRun(dels, ins, aTexts, bTexts, out);
    }
    return detectMoves(out, aKeys, bKeys, aTexts);
  }

  // A paragraph taken out in one place and put back unchanged in another
  // was moved, not rewritten. Both halves keep their op (so reconstruction
  // still holds) and point at each other: del.movedTo = b, ins.movedFrom = a.
  // Only paragraphs that occur once on each side, and aren't trivially
  // short, count — "Yes." turning up twice is not a move.
  const MIN_MOVE_CHARS = 20;
  function detectMoves(ops, aKeys, bKeys, aTexts) {
    const dels = new Map(), ins = new Map();
    const add = (m, key, k) => { if (!m.has(key)) m.set(key, []); m.get(key).push(k); };
    ops.forEach((o, k) => {
      if (o.op === 'del') add(dels, aKeys[o.a], k);
      else if (o.op === 'ins') add(ins, bKeys[o.b], k);
    });
    const countA = new Map(), countB = new Map();
    for (const key of aKeys) countA.set(key, (countA.get(key) || 0) + 1);
    for (const key of bKeys) countB.set(key, (countB.get(key) || 0) + 1);
    for (const [key, ds] of dels) {
      const is = ins.get(key);
      if (ds.length !== 1 || !is || is.length !== 1) continue;
      if (countA.get(key) !== 1 || countB.get(key) !== 1) continue;
      const d = ops[ds[0]], i = ops[is[0]];
      if (String(aTexts[d.a] || '').trim().length < MIN_MOVE_CHARS) continue;
      d.movedTo = i.b;
      i.movedFrom = d.a;
    }
    return ops;
  }

  // Within one changed run, pair deletions with insertions in order when
  // they read as the same paragraph revised (word-overlap ≥ 0.5).
  const LOOKAHEAD = 8;
  function pairRun(dels, ins, aTexts, bTexts, out) {
    const similar = (i, j) => similarity(aTexts[dels[i]], bTexts[ins[j]]) >= 0.5;
    let i = 0, j = 0;
    while (i < dels.length && j < ins.length) {
      if (similar(i, j)) {
        out.push({ op: 'mod', a: dels[i], b: ins[j] }); i++; j++;
        continue;
      }
      // is this deletion revised a little further down? emit the new
      // paragraphs in between first
      let found = -1;
      for (let jj = j + 1; jj < ins.length && jj <= j + LOOKAHEAD; jj++) {
        if (similar(i, jj)) { found = jj; break; }
      }
      if (found >= 0) {
        while (j < found) out.push({ op: 'ins', b: ins[j++] });
      } else {
        out.push({ op: 'del', a: dels[i++] });
      }
    }
    while (i < dels.length) out.push({ op: 'del', a: dels[i++] });
    while (j < ins.length) out.push({ op: 'ins', b: ins[j++] });
  }

  // Word-level diff inside one paragraph: [{op:'eq'|'del'|'ins', text}].
  // Joining eq+del gives the old text; eq+ins gives the new.
  function diffWords(aText, bText) {
    aText = String(aText || '');
    bText = String(bText || '');
    if (aText === bText) return aText ? [{ op: 'eq', text: aText }] : [];
    const A = tokenize(aText), B = tokenize(bText);
    if (A.length > MAX_TOKENS || B.length > MAX_TOKENS) {
      return [aText && { op: 'del', text: aText }, bText && { op: 'ins', text: bText }].filter(Boolean);
    }
    const ops = lcsOps(A, B);

    // Collapse into segments: an unchanged run, or a change (del + ins).
    // A lone space between two changes folds into the change, so
    // "the red fox" → "a quick fox" reads as one edit, not two.
    const segs = [];
    let cur = null;
    const change = () => {
      if (!cur || cur.op !== 'chg') { cur = { op: 'chg', del: '', ins: '' }; segs.push(cur); }
      return cur;
    };
    for (let k = 0; k < ops.length; k++) {
      const o = ops[k];
      if (o.op === 'eq') {
        const t = A[o.a];
        const prevChg = cur && cur.op === 'chg';
        const nextChg = k + 1 < ops.length && ops[k + 1].op !== 'eq';
        if (prevChg && nextChg && /^\s{1,2}$/.test(t)) {
          cur.del += t; cur.ins += t;
          continue;
        }
        if (!cur || cur.op !== 'eq') { cur = { op: 'eq', text: '' }; segs.push(cur); }
        cur.text += t;
      } else if (o.op === 'del') {
        change().del += A[o.a];
      } else {
        change().ins += B[o.b];
      }
    }
    const out = [];
    for (const s of segs) {
      if (s.op === 'eq') out.push({ op: 'eq', text: s.text });
      else {
        if (s.del) out.push({ op: 'del', text: s.del });
        if (s.ins) out.push({ op: 'ins', text: s.ins });
      }
    }
    return out;
  }

  // What changed between two book trees (either may be null — the very
  // first version compares against nothing). The shape stored on commits.
  function diffTrees(aTree, bTree) {
    const aCh = (aTree && aTree.chapters) || {};
    const bCh = (bTree && bTree.chapters) || {};
    const aOrder = (aTree && aTree.order) || [];
    const bOrder = (bTree && bTree.order) || [];
    const aTitles = (aTree && aTree.titles) || {};
    const bTitles = (bTree && bTree.titles) || {};
    const modified = [], added = [], removed = [], titles = [];
    for (const id of bOrder) {
      if (!(id in aCh)) added.push(id);
      else if (aCh[id] !== bCh[id]) modified.push(id);
      if ((aTitles[id] || '') !== (bTitles[id] || '') && id in aCh) titles.push(id);
    }
    for (const id of aOrder) if (!(id in bCh)) removed.push(id);
    // order counts as changed only when the chapters both trees share
    // appear in a different sequence
    const shared = new Set(aOrder.filter((id) => id in bCh));
    const a2 = aOrder.filter((id) => shared.has(id));
    const b2 = bOrder.filter((id) => shared.has(id));
    const order = a2.some((id, i) => id !== b2[i]);
    const notes = (aTree ? aTree.notes : null) !== (bTree ? bTree.notes : null) && !!aTree;
    return { modified, added, removed, order, titles, notes };
  }

  // Does a `changed` record touch any chapter at all?
  function isEmptyChange(c) {
    return !c || (!c.modified.length && !c.added.length && !c.removed.length &&
      !c.order && !c.titles.length && !c.notes);
  }

  const NeoDiff = { lcsOps, tokenize, similarity, diffParagraphs, diffWords, diffTrees, isEmptyChange };

  if (typeof module === 'object' && module.exports) module.exports = NeoDiff;
  else root.NeoDiff = NeoDiff;
})(this);
