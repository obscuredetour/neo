const test = require('node:test');
const assert = require('node:assert/strict');
const D = require('../history-diff.js');

const join = (ops, keep) => ops.filter((o) => o.op === 'eq' || o.op === keep).map((o) => o.text).join('');

test('lcsOps: identical input is all eq', () => {
  const ops = D.lcsOps(['a', 'b', 'c'], ['a', 'b', 'c']);
  assert.deepEqual(ops.map((o) => o.op), ['eq', 'eq', 'eq']);
});

test('lcsOps: single insert, delete, replace', () => {
  assert.deepEqual(D.lcsOps(['a', 'c'], ['a', 'b', 'c']).map((o) => o.op), ['eq', 'ins', 'eq']);
  assert.deepEqual(D.lcsOps(['a', 'b', 'c'], ['a', 'c']).map((o) => o.op), ['eq', 'del', 'eq']);
  assert.deepEqual(D.lcsOps(['a', 'b', 'c'], ['a', 'x', 'c']).map((o) => o.op), ['eq', 'del', 'ins', 'eq']);
});

test('lcsOps: empty sides', () => {
  assert.deepEqual(D.lcsOps([], []), []);
  assert.deepEqual(D.lcsOps([], ['a']).map((o) => o.op), ['ins']);
  assert.deepEqual(D.lcsOps(['a'], []).map((o) => o.op), ['del']);
});

test('lcsOps: oversized middle falls back to a wholesale replace', () => {
  const a = Array.from({ length: 2500 }, (_, i) => 'a' + i);
  const b = Array.from({ length: 2500 }, (_, i) => 'b' + i);
  const ops = D.lcsOps(['x', ...a, 'y'], ['x', ...b, 'y']);
  assert.equal(ops.filter((o) => o.op === 'del').length, 2500);
  assert.equal(ops.filter((o) => o.op === 'ins').length, 2500);
  assert.equal(ops[0].op, 'eq');
  assert.equal(ops.at(-1).op, 'eq');
});

test('tokenize keeps apostrophes and hyphens inside words', () => {
  assert.deepEqual(D.tokenize('It’s my ex-wife’s, isn\'t it?'),
    ['It’s', ' ', 'my', ' ', 'ex-wife’s', ',', ' ', 'isn\'t', ' ', 'it', '?']);
  assert.deepEqual(D.tokenize(''), []);
});

test('diffWords: identical and empty', () => {
  assert.deepEqual(D.diffWords('same words', 'same words'), [{ op: 'eq', text: 'same words' }]);
  assert.deepEqual(D.diffWords('', ''), []);
  assert.deepEqual(D.diffWords('', 'new'), [{ op: 'ins', text: 'new' }]);
  assert.deepEqual(D.diffWords('old', ''), [{ op: 'del', text: 'old' }]);
});

test('diffWords: a single word change', () => {
  const ops = D.diffWords('The red fox ran.', 'The brown fox ran.');
  assert.deepEqual(ops, [
    { op: 'eq', text: 'The ' }, { op: 'del', text: 'red' }, { op: 'ins', text: 'brown' }, { op: 'eq', text: ' fox ran.' }
  ]);
});

test('diffWords: a lone space between changes folds into one edit', () => {
  const ops = D.diffWords('the red fox', 'a quick fox');
  assert.deepEqual(ops, [{ op: 'del', text: 'the red' }, { op: 'ins', text: 'a quick' }, { op: 'eq', text: ' fox' }]);
});

test('diffWords: round-trips on random text', () => {
  const words = ['silo', 'the', 'Juliette', 'wool', 'down', 'up', 'stairs', 'it’s', 'dark', ',', '.'];
  let seed = 7;
  const rnd = (n) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
  const sentence = () => Array.from({ length: 5 + rnd(30) }, () => words[rnd(words.length)]).join(rnd(5) ? ' ' : '  ');
  for (let t = 0; t < 200; t++) {
    const a = sentence(), b = sentence();
    const ops = D.diffWords(a, b);
    assert.equal(join(ops, 'del'), a);
    assert.equal(join(ops, 'ins'), b);
  }
});

test('diffWords: oversized paragraphs fall back to whole replace', () => {
  const a = 'word '.repeat(4000), b = 'other '.repeat(4000);
  assert.deepEqual(D.diffWords(a, b), [{ op: 'del', text: a }, { op: 'ins', text: b }]);
});

test('diffParagraphs pairs revised paragraphs as mod', () => {
  const a = ['Juliette climbed the stairs slowly.', 'The silo hummed.', 'Nobody spoke.'];
  const b = ['Juliette climbed the stairs quickly.', 'The silo hummed.', 'A new paragraph entirely different.', 'Nobody spoke.'];
  const ops = D.diffParagraphs(a, b);
  assert.deepEqual(ops, [
    { op: 'mod', a: 0, b: 0 }, { op: 'eq', a: 1, b: 1 }, { op: 'ins', b: 2 }, { op: 'eq', a: 2, b: 3 }
  ]);
});

test('diffParagraphs: unrelated replacement stays del + ins', () => {
  const ops = D.diffParagraphs(['Alpha beta gamma.'], ['Completely unrelated words here.']);
  assert.deepEqual(ops.map((o) => o.op), ['del', 'ins']);
});

test('diffParagraphs: revision after an inserted paragraph still pairs', () => {
  const a = ['The mayor was dead by morning.'];
  const b = ['An entirely fresh opening line.', 'The mayor was dead by dawn.'];
  assert.deepEqual(D.diffParagraphs(a, b), [{ op: 'ins', b: 0 }, { op: 'mod', a: 0, b: 1 }]);
});

test('diffParagraphs: formatting-only change (keys differ, text same) is mod', () => {
  const ops = D.diffParagraphs(['<i>hello</i> there'], ['hello there'], ['hello there'], ['hello there']);
  assert.deepEqual(ops, [{ op: 'mod', a: 0, b: 0 }]);
});

test('diffTrees: add, remove, modify, reorder, titles, notes', () => {
  const a = { order: ['c1', 'c2', 'c3'], chapters: { c1: 'h1', c2: 'h2', c3: 'h3' }, titles: { c1: 'One' }, notes: 'n1' };
  const b = { order: ['c3', 'c1', 'c4'], chapters: { c1: 'h1x', c3: 'h3', c4: 'h4' }, titles: { c1: 'Uno' }, notes: 'n2' };
  assert.deepEqual(D.diffTrees(a, b), {
    modified: ['c1'], added: ['c4'], removed: ['c2'], order: true, titles: ['c1'], notes: true
  });
});

test('diffTrees: first version against nothing', () => {
  const b = { order: ['c1'], chapters: { c1: 'h' }, titles: {}, notes: 'n' };
  const c = D.diffTrees(null, b);
  assert.deepEqual(c, { modified: [], added: ['c1'], removed: [], order: false, titles: [], notes: false });
  assert.equal(D.isEmptyChange(D.diffTrees(b, b)), true);
});

test('diffTrees: deleting a chapter is not a reorder', () => {
  const a = { order: ['c1', 'c2', 'c3'], chapters: { c1: 'a', c2: 'b', c3: 'c' } };
  const b = { order: ['c1', 'c3'], chapters: { c1: 'a', c3: 'c' } };
  assert.equal(D.diffTrees(a, b).order, false);
});
