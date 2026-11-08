// Types and constants shared by the server and both clients (host screen + phones).

export type Phase =
  | 'lobby'
  | 'hint' // everyone sees their word and types a one-word hint or draws a picture
  | 'guess' // everyone sees all hints and sorts the other players into slots
  | 'reveal' // partnerships revealed one by one, with who guessed them
  | 'standings' // current standings
  | 'gameOver';

/** Timer values are seconds. 0 means "unlimited" (the phase ends when everybody is done, or the host skips). */
export interface Timers {
  hint: number;
  guess: number;
}

export interface Settings {
  endMode: 'points' | 'rounds';
  target: number; // points to reach, or number of rounds
  maxHintLength: number; // characters in a typed hint (no spaces allowed)
  timers: Timers;
}

export type SettingsPatch = Partial<Omit<Settings, 'timers'>> & { timers?: Partial<Timers> };

export const MIN_PLAYERS = 3;

export const DEFAULT_SETTINGS: Settings = {
  endMode: 'points',
  target: 10,
  maxHintLength: 20,
  timers: { hint: 90, guess: 120 },
};

// ---- drawings ----------------------------------------------------------------------------

/** Drawings live on a square 0..DRAW_SIZE canvas. A stroke is a list of points; the pen is always black. */
export const DRAW_SIZE = 1000;
export type Stroke = [number, number][];
export const MAX_STROKES = 200;
export const MAX_POINTS = 4000;

export type HintInput = { kind: 'text'; text: string } | { kind: 'draw'; strokes: Stroke[] };

export interface HintPublic {
  playerId: string;
  kind: 'text' | 'draw' | 'none';
  text?: string;
  strokes?: Stroke[];
}

// ---- guesses -----------------------------------------------------------------------------

/**
 * What one player thinks the pairings are. Every player (including yourself) can be placed.
 * - pairs: partnerships, 2 player ids each (your own partnership is just one of them)
 * - none: who they think has no partner (only when the player count is odd)
 */
export interface GuessInput {
  pairs: string[][];
  none: string | null;
}

/** Number of "Partnership N" slots, and whether there is an "odd one out" slot, for a given player count. */
export function guessLayout(playerCount: number) {
  return { pairSlots: Math.floor(playerCount / 2), noneSlot: playerCount % 2 === 1 };
}

// ---- reveal ------------------------------------------------------------------------------

export interface RevealEntry {
  kind: 'pair' | 'odd';
  aId: string;
  bId: string | null; // null for the player without a partner
  word: string;
  aFoundB: boolean; // a named b as their partner
  bFoundA: boolean;
  /** Other players who correctly placed this partnership (or correctly flagged the player with no partner). */
  guesserIds: string[];
}

export const REVEAL_HOLD_MS = 2000;
/** How long one reveal card takes to animate; used by the big screen's CSS delays and the server's timer. */
export function revealTiming(guesserCount: number) {
  const t0 = 2.6; // seconds until the guessers start dropping in
  const step = Math.min(0.5, 3 / Math.max(1, guesserCount));
  const endSec = guesserCount === 0 ? t0 + 0.6 : t0 + guesserCount * step + 0.5;
  return { t0, step, endMs: Math.round(endSec * 1000) };
}

// ---- state -------------------------------------------------------------------------------

export interface PlayerInfo {
  id: string;
  name: string;
  color: string;
  emoji: string;
  score: number;
  connected: boolean;
  /** Playing in the current round (late joiners spectate until the next round). */
  participating: boolean;
  /** Has finished whatever the current phase is waiting on. */
  done: boolean;
}

export interface YouInfo {
  id: string;
  participating: boolean;
  word: string | null; // your secret word (hint + guess phases only)
  hintSubmitted: boolean;
  ownHint: HintPublic | null;
  guessSubmitted: boolean;
  guess: GuessInput | null; // your latest saved guess (draft or final)
}

export interface ClientState {
  code: string;
  phase: Phase;
  paused: boolean;
  serverNow: number;
  deadline: number | null;
  settings: Settings;
  players: PlayerInfo[];
  round: number;
  participantIds: string[];
  hints: HintPublic[]; // guess phase onward
  layout: { pairSlots: number; noneSlot: boolean };
  reveal: RevealEntry[]; // entries revealed so far
  revealIndex: number;
  revealTotal: number;
  roundDeltas: Record<string, number> | null;
  winnerIds: string[];
  you: YouInfo | null;
}

// ---- socket events -----------------------------------------------------------------------

export type Ack<T = object> = (res: ({ ok: true } & T) | { ok: false; error: string }) => void;

export interface ClientToServerEvents {
  'host:create': (cb: Ack<{ code: string; hostToken: string }>) => void;
  'host:resume': (p: { code: string; hostToken: string }, cb: Ack) => void;
  'host:settings': (p: SettingsPatch) => void;
  'host:start': () => void;
  'host:skip': () => void;
  'host:playAgain': () => void;
  'host:kick': (p: { playerId: string }) => void;
  'player:join': (p: { code: string; name: string; token?: string }, cb: Ack<{ token: string; playerId: string }>) => void;
  'player:hint': (p: HintInput, cb?: Ack) => void;
  'player:guess': (p: { guess: GuessInput; final: boolean }, cb?: Ack) => void;
}

export interface ServerToClientEvents {
  state: (s: ClientState) => void;
  closed: (reason: string) => void;
}
