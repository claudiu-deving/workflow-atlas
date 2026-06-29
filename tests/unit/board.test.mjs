// Unit tests for the pure model layer (shared/board.js). Run with: node --test
// Focus: deep nesting allowed up to a high safety cap, the cycle guard, and the path
// helpers the focus stack/breadcrumb rely on.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateBoard, boardAtPath, pathChain, nextId, boardBBox,
  parsePath, boardForSegs, mergeNode, applyBoardEdit, indexNodes, matchNode, NODE_W, COL_X,
} from '../../shared/board.js';

const node = (id, extra = {}) => ({ id, title: id, x: 0, y: 0, w: 240, h: 96, ...extra });
const board = (nodes = [], edges = []) => ({ nodes, edges });

test('validateBoard accepts a normal shallow board', () => {
  const b = board([node('n1'), node('n2')], [{ id: 'e1', from: 'n1', to: 'n2', kind: 'flow' }]);
  assert.doesNotThrow(() => validateBoard(b, 'board', 0, () => {}));
});

test('validateBoard accepts DEEP linear nesting (well past any real board)', () => {
  let leaf = board();
  let root = leaf;
  for (let i = 0; i < 40; i++) root = board([node('n1', { board: root })]);   // 40 levels deep
  assert.doesNotThrow(() => validateBoard(root, 'board', new Set(), () => {}),
    '40-level nesting must validate (old build threw past 6)');
});

test('validateBoard REJECTS pathologically deep nesting (stack-overflow guard)', () => {
  let root = board();
  for (let i = 0; i < 400; i++) root = board([node('n1', { board: root })]);  // 400 distinct levels, no cycle
  assert.throws(() => validateBoard(root, 'board', new Set(), () => {}), /too deep/i,
    'a thousands-deep payload must be rejected before it overflows the recursive walk');
});

test('validateBoard REJECTS an ancestor cycle (a board nesting itself)', () => {
  const b = board([node('n1')]);
  b.nodes[0].board = b;                       // self-reference → infinite recursion if unguarded
  assert.throws(() => validateBoard(b, 'board', new Set(), () => {}), /cycle/i);
});

test('validateBoard REJECTS a deeper ancestor cycle', () => {
  const root = board([node('n1')]);
  const child = board([node('m1')]);
  root.nodes[0].board = child;
  child.nodes[0].board = root;                // root → child → root
  assert.throws(() => validateBoard(root, 'board', new Set(), () => {}), /cycle/i);
});

test('validateBoard ALLOWS the same board object reused in sibling subtrees (not a cycle)', () => {
  const shared = board([node('leaf')]);
  const root = board([node('a', { board: shared }), node('b', { board: shared })]);
  assert.doesNotThrow(() => validateBoard(root, 'board', new Set(), () => {}));
});

test('validateBoard still rejects malformed shapes and dangling edges', () => {
  assert.throws(() => validateBoard({ nodes: 'x', edges: [] }, 'board', 0, () => {}), /nodes/);
  assert.throws(() => validateBoard(board([node('n1')], [{ id: 'e1', from: 'n1', to: 'ZZZ' }]), 'board', 0, () => {}), /endpoint/);
  assert.throws(() => validateBoard(board([{ id: 'n1' }]), 'board', 0, () => {}), /title/);
});

test('validateBoard checks edge.fromSide (accepts a valid side, rejects a bogus one)', () => {
  const ok = board([node('n1'), node('n2')], [{ id: 'e1', from: 'n1', to: 'n2', fromSide: 'right' }]);
  assert.doesNotThrow(() => validateBoard(ok, 'board', 0, () => {}));
  const bad = board([node('n1'), node('n2')], [{ id: 'e1', from: 'n1', to: 'n2', fromSide: 'north' }]);
  assert.throws(() => validateBoard(bad, 'board', 0, () => {}), /fromSide/);
});

test('server-style numeric 3rd arg is treated as a fresh traversal (back-compat)', () => {
  const b = board([node('n1', { board: board([node('m1')]) })]);
  assert.doesNotThrow(() => validateBoard(b, 'board', 0, () => {}));   // server calls validateBoard(x,'board',0,...)
});

test('boardAtPath descends to the child board, and stops at the deepest resolvable on a pruned path', () => {
  const leaf = board([node('z')]);
  const mid = board([node('m1', { board: leaf })]);
  const root = board([node('n1', { board: mid })]);
  assert.equal(boardAtPath(root, []), root);
  assert.equal(boardAtPath(root, ['n1']), mid);
  assert.equal(boardAtPath(root, ['n1', 'm1']), leaf);
  // pruned: 'gone' doesn't exist → return the deepest board that still resolved (mid)
  assert.equal(boardAtPath(root, ['n1', 'gone', 'whatever']), mid);
});

test('pathChain yields {id,title,node} for each step and stops at a break', () => {
  const mid = board([node('m1', { title: 'Mid', board: board() })]);
  const root = board([node('n1', { title: 'Root', board: mid })]);
  const chain = pathChain(root, ['n1', 'm1']);
  assert.deepEqual(chain.map((c) => c.title), ['Root', 'Mid']);
  assert.equal(chain[0].node, root.nodes[0]);
  assert.deepEqual(pathChain(root, ['n1', 'nope']).map((c) => c.title), ['Root']);
});

test('nextId never reuses a deleted suffix', () => {
  assert.equal(nextId([{ id: 'n1' }, { id: 'n3' }], 'n'), 'n4');
  assert.equal(nextId([], 'e'), 'e1');
});

test('boardBBox floors an empty board so fit-scale never divides by zero', () => {
  const bb = boardBBox(board());
  assert.ok(bb.w > 0 && bb.h > 0);
});

/* ---------------- transclusion: node.boardRef (shared components) ---------------- */
test('validateBoard accepts a boardRef slug and rejects board+boardRef together', () => {
  assert.doesNotThrow(() => validateBoard(board([node('n1', { boardRef: 'ai-review' })]), 'board', 0, () => {}));
  assert.throws(() => validateBoard(board([node('n1', { boardRef: 'Not A Slug' })]), 'board', 0, () => {}), /boardRef must be a sheet-id slug/);
  assert.throws(() => validateBoard(board([node('n1', { boardRef: 'x', board: board() })]), 'board', 0, () => {}), /private \(board\) OR shared \(boardRef\)/);
});

/* ---------------- granular editing: parsePath / boardForSegs / mergeNode / applyBoardEdit ---------------- */
test('parsePath splits sheet + node segments and rejects bad input', () => {
  assert.deepEqual(parsePath('checkout/n3'), { sheetId: 'checkout', segs: ['n3'] });
  assert.deepEqual(parsePath('#checkout/n1/n2'), { sheetId: 'checkout', segs: ['n1', 'n2'] });
  assert.deepEqual(parsePath('checkout'), { sheetId: 'checkout', segs: [] });
  assert.throws(() => parsePath(''), /empty path/);
  assert.throws(() => parsePath('Bad Id/n1'), /invalid sheet id/);
});

test('boardForSegs descends, errors on a typo, refuses a boardRef, and createLast adds a leaf board', () => {
  const leaf = board([node('z')]);
  const mid = board([node('m1', { board: leaf })]);
  const root = board([node('n1', { board: mid })]);
  assert.equal(boardForSegs(root, []), root);
  assert.equal(boardForSegs(root, ['n1']), mid);
  assert.equal(boardForSegs(root, ['n1', 'm1']), leaf);
  assert.throws(() => boardForSegs(root, ['nope']), /no node/);            // a typo errors, never vivifies
  assert.throws(() => boardForSegs(board([node('x')]), ['x', 'y']), /no child board/);  // non-leaf must already nest
  assert.throws(() => boardForSegs(board([node('r1', { boardRef: 'svc' })]), ['r1']), /shared component/);
  const c = board([node('p')]);
  const made = boardForSegs(c, ['p'], { createLast: true });               // only the LEAF's board is created
  assert.ok(made && Array.isArray(made.nodes) && c.nodes[0].board === made);
});

test('mergeNode: top-level replaces, detail merges per key, null clears, id is fixed', () => {
  const n = { id: 'n1', title: 't', detail: { in: ['a'], note: 'old', open: ['q1'] } };
  mergeNode(n, { status: 'done', detail: { note: 'new', open: ['q1', 'q2'] } });
  assert.equal(n.status, 'done');
  assert.deepEqual(n.detail.in, ['a']);          // untouched detail key survives
  assert.equal(n.detail.note, 'new');            // replaced
  assert.deepEqual(n.detail.open, ['q1', 'q2']); // array fully replaced
  mergeNode(n, { detail: { note: null } });      // null clears a key inside detail
  assert.ok(!('note' in n.detail));
  mergeNode(n, { sub: 's' }); assert.equal(n.sub, 's');
  mergeNode(n, { sub: null }); assert.ok(!('sub' in n));   // null clears a top-level field
  mergeNode(n, { id: 'CHANGED' }); assert.equal(n.id, 'n1');  // id is addressing, never merged
});

test('applyBoardEdit upserts/patches/deletes nodes & edges, cascading incident edges', () => {
  const b = board([node('n1'), node('n2')], [{ id: 'e1', from: 'n1', to: 'n2', kind: 'flow' }]);
  let sum = applyBoardEdit(b, { nodes: [{ id: 'n1', status: 'done' }] });
  assert.deepEqual(sum.updated, ['n1']);
  assert.equal(b.nodes.find((n) => n.id === 'n1').status, 'done');

  sum = applyBoardEdit(b, { nodes: [{ id: 'n3', title: 'Three', status: 'todo' }] });
  assert.deepEqual(sum.created, ['n3']);
  const n3 = b.nodes.find((n) => n.id === 'n3');
  assert.equal(n3.title, 'Three'); assert.equal(n3.w, NODE_W); assert.equal(n3.x, COL_X);
  assert.throws(() => applyBoardEdit(b, { nodes: [{ id: 'n4' }] }), /requires a title/);  // create needs a title

  sum = applyBoardEdit(b, { edges: [{ from: 'n2', to: 'n3' }] });          // new edge gets an auto id
  assert.ok(sum.created.some((x) => x.startsWith('edge:')));
  assert.ok(b.edges.find((e) => e.from === 'n2' && e.to === 'n3'));

  sum = applyBoardEdit(b, { deleteNodes: ['n2'] });                        // delete cascades its edges
  assert.deepEqual(sum.deletedNodes, ['n2']);
  assert.ok(!b.nodes.find((n) => n.id === 'n2'));
  assert.ok(!b.edges.find((e) => e.from === 'n2' || e.to === 'n2'));       // e1 and n2→n3 both gone
  assert.throws(() => applyBoardEdit(b, { deleteNodes: ['zzz'] }), /no node/);
  assert.throws(() => applyBoardEdit(b, { deleteEdges: ['nope'] }), /no edge/);
});

test('indexNodes flattens every node with its path, descends inline boards, treats boardRef as a leaf', () => {
  const leaf = board([node('z')]);
  const mid = board([node('m1', { board: leaf }), node('m2', { boardRef: 'other' })]);
  const root = board([node('n1', { board: mid }), node('n2')]);
  const paths = indexNodes(root, 'sheet').map((x) => x.path);
  assert.deepEqual(paths, ['sheet/n1', 'sheet/n1/m1', 'sheet/n1/m1/z', 'sheet/n1/m2', 'sheet/n2']);
  assert.ok(paths.includes('sheet/n1/m2') && !paths.some((p) => p.startsWith('sheet/n1/m2/')));  // boardRef = leaf, not descended
});

test('matchNode searches id/title/sub/note/in/out/open/algorithm, case-insensitive', () => {
  const n = node('pg', { title: 'PostgreSQL', sub: ':5433', algorithm: 'anomaly-score',
    detail: { in: ['SQL via Npgsql'], out: ['Rows'], note: 'EF model', open: [] } });
  assert.equal(matchNode(n, 'postgres').field, 'title');
  assert.equal(matchNode(n, 'npgsql').field, 'in');          // case-insensitive, inside detail.in
  assert.equal(matchNode(n, 'ef model').field, 'note');
  assert.equal(matchNode(n, 'anomaly').field, 'algorithm');
  assert.equal(matchNode(n, ':5433').field, 'sub');
  assert.equal(matchNode(n, 'nonexistent'), null);
  assert.equal(matchNode(n, '').field, 'all');               // empty query = index mode (matches everything)
});

test('boardAtPath / pathChain resolve a boardRef via the injected childOf resolver', () => {
  // sheet "svc" is the shared component; the consumer mounts it at n1.
  const svcBoard = board([node('s1')]);
  const sheets = { svc: { id: 'svc', board: svcBoard } };
  const root = board([node('n1', { boardRef: 'svc' })]);
  const childOf = (n) => n.board || (n.boardRef ? (sheets[n.boardRef] || {}).board : null);
  // Without the resolver the path stops at the mount (boardRef is opaque)…
  assert.equal(boardAtPath(root, ['n1']), root);
  // …with it, the path crosses into the mounted sheet's board.
  assert.equal(boardAtPath(root, ['n1'], childOf), svcBoard);
  const chain = pathChain(root, ['n1', 's1'], childOf);
  assert.deepEqual(chain.map((c) => c.id), ['n1', 's1']);
});
