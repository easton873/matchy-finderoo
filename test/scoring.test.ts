// Unit tests for the scoring + guess validation rules (no sockets involved).
import assert from 'node:assert/strict';
import { guessLayout, type GuessInput } from '../shared/types.js';
import { normalizeGuess, scoreRound, type Truth } from '../server/scoring.js';

const g = (pairs: string[][] = [], none: string | null = null): GuessInput => ({ pairs, none });
const run = (truth: Truth, ids: string[], guesses: Record<string, GuessInput>) => scoreRound(truth, ids, new Map(Object.entries(guesses)));

// ---- layout: one slot per partnership, plus an odd-one-out slot when the count is odd ------------
assert.deepEqual(guessLayout(3), { pairSlots: 1, noneSlot: true });
assert.deepEqual(guessLayout(4), { pairSlots: 2, noneSlot: false });
assert.deepEqual(guessLayout(5), { pairSlots: 2, noneSlot: true });
assert.deepEqual(guessLayout(6), { pairSlots: 3, noneSlot: false });

// ---- 6 players, 3 pairs: A-B, C-D, E-F ---------------------------------------------------
const truth6: Truth = {
  pairs: [
    { a: 'A', b: 'B', word: 'apple' },
    { a: 'C', b: 'D', word: 'cat' },
    { a: 'E', b: 'F', word: 'egg' },
  ],
  odd: null,
};
const ids6 = ['A', 'B', 'C', 'D', 'E', 'F'];
const allPairs = [['A', 'B'], ['C', 'D'], ['E', 'F']];

{
  // everyone perfect: 1 (own pair, mutual) + 2 (the other pairs) = 3 each. Order inside a pair doesn't matter.
  const r = run(truth6, ids6, Object.fromEntries(ids6.map((id) => [id, g(allPairs.map((p) => (id < 'C' ? [...p].reverse() : p)))])));
  for (const id of ids6) assert.equal(r.deltas[id], 3, `${id} perfect = 3`);
  const e = r.entries.find((x) => x.aId === 'A')!;
  assert(e.aFoundB && e.bFoundA);
  assert.deepEqual([...e.guesserIds].sort(), ['C', 'D', 'E', 'F'], 'only OTHER players are listed as having spotted a pair');
}
{
  // finding your partner is mutual: A places A+B, but B doesn't -> neither gets the point
  const r = run(truth6, ids6, { A: g([['A', 'B']]), B: g([['B', 'C']]) });
  assert.equal(r.deltas.A, 0);
  assert.equal(r.deltas.B, 0);
  const e = r.entries.find((x) => x.aId === 'A')!;
  assert(e.aFoundB && !e.bFoundA, 'reveal reports who found whom');
  // ...and when both do it, both score
  const r2 = run(truth6, ids6, { A: g([['A', 'B']]), B: g([['B', 'A']]) });
  assert.equal(r2.deltas.A, 1);
  assert.equal(r2.deltas.B, 1);
}
{
  // a correct pair placed by someone outside it scores right away, even if the pair members never placed themselves
  const r = run(truth6, ids6, { E: g([['A', 'B']]) });
  assert.equal(r.deltas.E, 1);
  assert.equal(r.deltas.A, 0);
}
{
  // no partial credit: A-C is wrong even though A and C each sit in a real pair
  const r = run(truth6, ids6, { E: g([['A', 'C'], ['B', 'D']]) });
  assert.equal(r.deltas.E, 0);
  // you can't earn a point for placing yourself with a wrong partner
  const r2 = run(truth6, ids6, { A: g([['A', 'C']]), C: g([['A', 'C']]) });
  assert.equal(r2.deltas.A + r2.deltas.C, 0);
  // empty / missing guesses score nothing
  const r3 = run(truth6, ids6, {});
  for (const id of ids6) assert.equal(r3.deltas[id], 0);
}

// ---- 5 players: A-B, C-D, E has no partner ---------------------------------------------
const truth5: Truth = {
  pairs: [
    { a: 'A', b: 'B', word: 'apple' },
    { a: 'C', b: 'D', word: 'cat' },
  ],
  odd: { id: 'E', word: 'emu' },
};
const ids5 = ['A', 'B', 'C', 'D', 'E'];
{
  const r = run(truth5, ids5, {
    A: g([['A', 'B'], ['C', 'D']], 'E'), // own pair (mutual) + CD + odd = 3
    B: g([['B', 'A'], ['D', 'C']], 'E'), // own pair (mutual) + CD + odd = 3
    C: g([['A', 'C'], ['B', 'D']], 'E'), // wrong pairs, right odd = 1
    D: g([['C', 'D']], 'A'), // own pair, but C didn't place it -> 0; wrong odd -> 0
    E: g([['A', 'B']], 'E'), // spotted AB (+1) and correctly placed themselves as the odd one out (+1)
  });
  assert.equal(r.deltas.A, 3);
  assert.equal(r.deltas.B, 3);
  assert.equal(r.deltas.C, 1);
  assert.equal(r.deltas.D, 0);
  assert.equal(r.deltas.E, 2);
  const odd = r.entries[r.entries.length - 1];
  assert.equal(odd.kind, 'odd');
  assert.deepEqual([...odd.guesserIds].sort(), ['A', 'B', 'C', 'E']);
  const cd = r.entries.find((x) => x.aId === 'C')!;
  assert(!cd.aFoundB && cd.bFoundA, 'D placed C+D but C did not');
  assert.deepEqual(cd.guesserIds, ['A', 'B']);
}

// ---- validation ------------------------------------------------------------------------
const ids = ['A', 'B', 'C', 'D', 'E'];
assert.deepEqual(normalizeGuess({ pairs: [['A', 'B'], ['C', 'D']], none: 'E' }, ids), { pairs: [['A', 'B'], ['C', 'D']], none: 'E' });
assert.equal(typeof normalizeGuess({ pairs: [['Z', 'A']], none: null }, ids), 'string', 'unknown player');
assert.equal(typeof normalizeGuess({ pairs: [['A', 'B'], ['B', 'C']], none: null }, ids), 'string', 'same player twice');
assert.equal(typeof normalizeGuess({ pairs: [['A', 'B']], none: 'A' }, ids), 'string', 'same player in a pair and the odd slot');
assert.equal(typeof normalizeGuess({ pairs: [['A', 'B'], ['C', 'D'], ['E']], none: null }, ids), 'string', 'too many pair slots');
assert.equal(typeof normalizeGuess({ pairs: [], none: 'B' }, ['A', 'B', 'C', 'D']), 'string', 'no odd slot when even');
assert.deepEqual(normalizeGuess({ pairs: [['B']], none: null }, ids), { pairs: [], none: null }, 'incomplete pair dropped');
assert.equal(typeof normalizeGuess(null, ids), 'string');

console.log('scoring tests passed');
