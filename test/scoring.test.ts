// Unit tests for the scoring + guess validation rules (no sockets involved).
import assert from 'node:assert/strict';
import { guessLayout, type GuessInput } from '../shared/types.js';
import { normalizeGuess, scoreRound, type Truth } from '../server/scoring.js';

const g = (partner: string | null, pairs: string[][] = [], none: string | null = null): GuessInput => ({ partner, pairs, none });
const run = (truth: Truth, ids: string[], guesses: Record<string, GuessInput>) => scoreRound(truth, ids, new Map(Object.entries(guesses)));

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

{
  // everyone perfect: 1 (partner) + 2 (the other two pairs) = 3 each
  const perfect: Record<string, GuessInput> = {
    A: g('B', [['C', 'D']]),
    B: g('A', [['E', 'F']]),
    C: g('D', [['A', 'B']]),
    D: g('C', [['F', 'E']]), // order inside a pair doesn't matter
    E: g('F', [['A', 'B']]),
    F: g('E', [['C', 'D']]),
  };
  const r = run(truth6, ids6, perfect);
  assert.deepEqual(r.deltas, { A: 2, B: 2, C: 2, D: 2, E: 2, F: 2 }); // one pair slot each (layout: 6 players -> 2 pair slots)
}
assert.deepEqual(guessLayout(6), { pairSlots: 2, noneSlot: false });
{
  const perfect: Record<string, GuessInput> = {
    A: g('B', [['C', 'D'], ['E', 'F']]),
    B: g('A', [['C', 'D'], ['E', 'F']]),
    C: g('D', [['A', 'B'], ['E', 'F']]),
    D: g('C', [['A', 'B'], ['E', 'F']]),
    E: g('F', [['A', 'B'], ['C', 'D']]),
    F: g('E', [['A', 'B'], ['C', 'D']]),
  };
  const r = run(truth6, ids6, perfect);
  for (const id of ids6) assert.equal(r.deltas[id], 3, `${id} perfect = 3`);
  const e = r.entries.find((x) => x.aId === 'A')!;
  assert(e.aFoundB && e.bFoundA);
  assert.deepEqual([...e.guesserIds].sort(), ['C', 'D', 'E', 'F']);
}
{
  // partner point is mutual: A finds B but B doesn't find A -> neither gets it
  const r = run(truth6, ids6, { A: g('B'), B: g('C') });
  assert.equal(r.deltas.A, 0);
  assert.equal(r.deltas.B, 0);
  const e = r.entries.find((x) => x.aId === 'A')!;
  assert(e.aFoundB && !e.bFoundA, 'reveal reports who found whom');
}
{
  // no partial credit: A-C is wrong even though A and C each sit in a real pair
  const r = run(truth6, ids6, { E: g(null, [['A', 'C'], ['B', 'D']]) });
  assert.equal(r.deltas.E, 0);
  // a pair where only one member is right scores nothing; the exact pair scores
  const r2 = run(truth6, ids6, { E: g(null, [['A', 'B'], ['C', 'E']]) });
  assert.equal(r2.deltas.E, 1);
}
{
  // you can't be credited for your own partnership via a pair slot, and a missing guess is just empty
  const r = run(truth6, ids6, {});
  for (const id of ids6) assert.equal(r.deltas[id], 0);
}

// ---- 5 players: A-B, C-D, E has no partner ---------------------------------------------
assert.deepEqual(guessLayout(5), { pairSlots: 1, noneSlot: true });
assert.deepEqual(guessLayout(3), { pairSlots: 0, noneSlot: true });
assert.deepEqual(guessLayout(4), { pairSlots: 1, noneSlot: false });
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
    A: g('B', [], 'E'), // finds partner (mutual) + spots the odd one out
    B: g('A', [['C', 'D']], 'E'), // would need 2 slots but layout is 1 -> still: partner mutual, pair, odd
    C: g('A', [], 'E'), // wrong partner, right odd
    D: g('C', [], 'A'), // partner right but C didn't find D -> 0; wrong odd
    E: g('A', [['B', 'C']], 'D'), // the odd one out can't score by flagging themselves; wrong guesses
  });
  assert.equal(r.deltas.A, 2); // partner + odd
  assert.equal(r.deltas.B, 3); // partner + CD pair + odd
  assert.equal(r.deltas.C, 1); // odd only
  assert.equal(r.deltas.D, 0);
  assert.equal(r.deltas.E, 0);
  const odd = r.entries[r.entries.length - 1];
  assert.equal(odd.kind, 'odd');
  assert.deepEqual([...odd.guesserIds].sort(), ['A', 'B', 'C']);
  const cd = r.entries.find((x) => x.aId === 'C')!;
  assert(!cd.aFoundB && cd.bFoundA, 'D named C but C did not name D');
  assert.deepEqual(cd.guesserIds, ['B']);
}

// ---- validation ------------------------------------------------------------------------
const ids = ['A', 'B', 'C', 'D', 'E'];
assert.deepEqual(normalizeGuess({ partner: 'B', pairs: [['C', 'D']], none: 'E' }, 'A', ids), { partner: 'B', pairs: [['C', 'D']], none: 'E' });
assert.equal(typeof normalizeGuess({ partner: 'A', pairs: [], none: null }, 'A', ids), 'string', 'cannot pick yourself');
assert.equal(typeof normalizeGuess({ partner: 'Z', pairs: [], none: null }, 'A', ids), 'string', 'unknown player');
assert.equal(typeof normalizeGuess({ partner: 'B', pairs: [['B', 'C']], none: null }, 'A', ids), 'string', 'same player twice');
assert.equal(typeof normalizeGuess({ partner: null, pairs: [['B', 'C'], ['D', 'E']], none: null }, 'A', ids), 'string', 'too many pair slots');
assert.equal(typeof normalizeGuess({ partner: null, pairs: [], none: 'B' }, 'A', ['A', 'B', 'C', 'D']), 'string', 'no "no partner" slot when even');
assert.deepEqual(normalizeGuess({ partner: null, pairs: [['B']], none: null }, 'A', ids), { partner: null, pairs: [], none: null }, 'incomplete pair dropped');
assert.equal(typeof normalizeGuess(null, 'A', ids), 'string');

console.log('scoring tests passed');
