// Unit tests for the pure model layer (shared/board.js). Run with: node --test
// Focus: deep nesting allowed up to a high safety cap, the cycle guard, and the path
// helpers the focus stack/breadcrumb rely on.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateBoard, boardAtPath, pathChain, nextId, boardBBox,
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
