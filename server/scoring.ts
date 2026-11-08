// Pure scoring + validation rules, kept free of sockets/timers so they can be unit tested.
import { guessLayout, type GuessInput, type RevealEntry } from '../shared/types.js';

export interface Truth {
  /** Real partnerships (a, b, shared word). */
  pairs: { a: string; b: string; word: string }[];
  /** The player left without a partner when the player count is odd. */
  odd: { id: string; word: string } | null;
}

export const emptyGuess = (): GuessInput => ({ partner: null, pairs: [], none: null });

/**
 * Cleans a guess from a client. Returns an error string if it is nonsense (unknown players, yourself, the same
 * player placed twice, too many slots). Incomplete partnerships (fewer than 2 players) are simply dropped.
 */
export function normalizeGuess(raw: unknown, self: string, participants: readonly string[]): GuessInput | string {
  const g = raw as Partial<GuessInput> | null;
  if (!g || typeof g !== 'object') return 'Invalid guess.';
  const valid = new Set(participants);
  const seen = new Set<string>();
  const take = (v: unknown): string | null | 'bad' => {
    if (v == null) return null;
    if (typeof v !== 'string' || v === self || !valid.has(v) || seen.has(v)) return 'bad';
    seen.add(v);
    return v;
  };
  const layout = guessLayout(participants.length);

  const partner = take(g.partner);
  if (partner === 'bad') return 'Invalid partner.';

  const none = take(g.none);
  if (none === 'bad') return 'Invalid "no partner" pick.';
  if (none && !layout.noneSlot) return 'There is nobody without a partner this round.';

  const pairsIn = Array.isArray(g.pairs) ? g.pairs : [];
  if (pairsIn.length > layout.pairSlots) return 'Too many partnerships.';
  const pairs: string[][] = [];
  for (const p of pairsIn) {
    if (!Array.isArray(p) || p.length > 2) return 'Invalid partnership.';
    const ids: string[] = [];
    for (const v of p) {
      const id = take(v);
      if (id === 'bad') return 'Invalid partnership.';
      if (id) ids.push(id);
    }
    if (ids.length === 2) pairs.push(ids);
  }
  return { partner, pairs, none };
}

export interface RoundScore {
  deltas: Record<string, number>;
  /** One entry per real partnership, plus one for the player without a partner (last). */
  entries: RevealEntry[];
}

/**
 * Scoring:
 *  +1 for finding your partner - but only if your partner also found you (both or neither get it).
 *  +1 for every other partnership you placed exactly right (no partial credit).
 *  +1 for correctly naming the player with no partner.
 */
export function scoreRound(truth: Truth, participants: readonly string[], guesses: ReadonlyMap<string, GuessInput>): RoundScore {
  const deltas: Record<string, number> = Object.fromEntries(participants.map((id) => [id, 0]));
  const guessOf = (id: string) => guesses.get(id) ?? emptyGuess();
  const entries: RevealEntry[] = [];

  for (const { a, b, word } of truth.pairs) {
    const aFoundB = guessOf(a).partner === b;
    const bFoundA = guessOf(b).partner === a;
    if (aFoundB && bFoundA) {
      deltas[a]++;
      deltas[b]++;
    }
    const guesserIds: string[] = [];
    for (const g of participants) {
      if (g === a || g === b) continue;
      const hit = guessOf(g).pairs.some(([x, y]) => (x === a && y === b) || (x === b && y === a));
      if (hit) {
        guesserIds.push(g);
        deltas[g]++;
      }
    }
    entries.push({ kind: 'pair', aId: a, bId: b, word, aFoundB, bFoundA, guesserIds });
  }

  if (truth.odd) {
    const guesserIds = participants.filter((g) => g !== truth.odd!.id && guessOf(g).none === truth.odd!.id);
    for (const g of guesserIds) deltas[g]++;
    entries.push({ kind: 'odd', aId: truth.odd.id, bId: null, word: truth.odd.word, aFoundB: false, bFoundA: false, guesserIds });
  }
  return { deltas, entries };
}
