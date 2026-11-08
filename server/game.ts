import type { Server } from 'socket.io';
import {
  DEFAULT_SETTINGS,
  DRAW_SIZE,
  MAX_POINTS,
  MAX_STROKES,
  MIN_PLAYERS,
  REVEAL_HOLD_MS,
  guessLayout,
  revealTiming,
  type ClientState,
  type ClientToServerEvents,
  type GuessInput,
  type HintInput,
  type HintPublic,
  type Phase,
  type PlayerInfo,
  type RevealEntry,
  type ServerToClientEvents,
  type Settings,
  type SettingsPatch,
  type Stroke,
  type Timers,
} from '../shared/types.js';
import { emptyGuess, normalizeGuess, scoreRound, type Truth } from './scoring.js';
import { WORDS } from './words.js';

type IO = Server<ClientToServerEvents, ServerToClientEvents>;

// Fixed-length beats. TIMING_SCALE lets the test simulation run fast.
const SCALE = Number(process.env.TIMING_SCALE ?? 1);
const STANDINGS_MS = 8000 * SCALE;

export const ROOM_IDLE_MS = 15 * 60 * 1000;

const COLORS = ['#ff4d6d', '#ff9f1c', '#ffd23f', '#3ddc97', '#2ec4ff', '#7b6cff', '#c77dff', '#ff70a6', '#9ef01a', '#00f5d4', '#f15bb5', '#fb8500'];
const EMOJIS = ['🦊', '🐸', '🦄', '🐙', '🦖', '🐼', '🦉', '🐝', '🐳', '🦁', '🐧', '🦋', '🐢', '🦩', '🐨', '🐯'];

interface Player {
  id: string;
  token: string;
  name: string;
  color: string;
  emoji: string;
  score: number;
  socketId: string | null;
}

type StoredHint = Omit<HintPublic, 'playerId'>;

interface RoundData {
  participants: string[]; // fixed when the round starts
  truth: Truth;
  wordOf: Map<string, string>;
  hints: Map<string, StoredHint>;
  hintOrder: string[]; // shuffled once, so the order of hints doesn't give pairs away
  guesses: Map<string, GuessInput>; // latest draft or final guess
  finals: Set<string>;
  reveal: RevealEntry[];
  revealIndex: number;
  deltas: Record<string, number> | null;
}

const rand = (n: number) => Math.floor(Math.random() * n);
function shuffle<T>(arr: readonly T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = rand(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function clampInt(v: unknown, min: number, max: number, fallback: number): number {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function cleanStrokes(raw: unknown): Stroke[] | null {
  if (!Array.isArray(raw)) return null;
  const out: Stroke[] = [];
  let points = 0;
  for (const s of raw.slice(0, MAX_STROKES)) {
    if (!Array.isArray(s)) continue;
    const stroke: Stroke = [];
    for (const p of s) {
      if (!Array.isArray(p) || points >= MAX_POINTS) break;
      const x = Number(p[0]);
      const y = Number(p[1]);
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      stroke.push([Math.min(DRAW_SIZE, Math.max(0, Math.round(x))), Math.min(DRAW_SIZE, Math.max(0, Math.round(y)))]);
      points++;
    }
    if (stroke.length) out.push(stroke);
  }
  return out.length ? out : null;
}

export class Room {
  readonly code: string;
  readonly hostToken: string;
  hostSocketId: string | null = null;
  settings: Settings = structuredClone(DEFAULT_SETTINGS);
  players = new Map<string, Player>();
  phase: Phase = 'lobby';
  round = 0;
  cur: RoundData = this.freshRound();
  private usedWords = new Set<string>();

  // timing
  private timer: NodeJS.Timeout | null = null;
  private onExpire: (() => void) | null = null;
  deadline: number | null = null;
  paused = false;
  private remaining: number | null = null;

  // lifecycle
  private idleTimer: NodeJS.Timeout | null = null;
  onDestroy: (() => void) | null = null;

  constructor(
    private io: IO,
    code: string,
    hostToken: string,
  ) {
    this.code = code;
    this.hostToken = hostToken;
  }

  // ------------------------------------------------------------------ lifecycle

  attachHost(socketId: string) {
    this.hostSocketId = socketId;
    this.cancelIdle();
    if (this.paused) this.resume();
    this.broadcast();
  }

  detachHost(socketId: string) {
    if (this.hostSocketId !== socketId) return;
    this.hostSocketId = null;
    this.pause();
    this.startIdle();
    this.broadcast();
  }

  private startIdle() {
    this.cancelIdle();
    this.idleTimer = setTimeout(() => this.destroy('The host left and the room timed out.'), ROOM_IDLE_MS);
  }
  private cancelIdle() {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }

  destroy(reason: string) {
    this.cancelIdle();
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.io.to(this.roomName).emit('closed', reason);
    this.onDestroy?.();
  }

  get roomName() {
    return `room:${this.code}`;
  }

  // ------------------------------------------------------------------ players

  join(name: string, token: string | undefined, socketId: string): { ok: true; player: Player } | { ok: false; error: string } {
    if (token) {
      const existing = [...this.players.values()].find((p) => p.token === token);
      if (existing) {
        existing.socketId = socketId;
        if (!this.maybeAdvance()) this.broadcast();
        return { ok: true, player: existing };
      }
    }
    const clean = name.replace(/\s+/g, ' ').trim().slice(0, 14);
    if (!clean) return { ok: false, error: 'Please enter a name.' };
    if ([...this.players.values()].some((p) => p.name.toLowerCase() === clean.toLowerCase())) {
      return { ok: false, error: 'That name is already taken.' };
    }
    const idx = this.players.size;
    const used = new Set([...this.players.values()].map((p) => p.color));
    const color = COLORS.find((c) => !used.has(c)) ?? COLORS[idx % COLORS.length];
    const usedEmoji = new Set([...this.players.values()].map((p) => p.emoji));
    const emoji = EMOJIS.find((e) => !usedEmoji.has(e)) ?? EMOJIS[idx % EMOJIS.length];
    const player: Player = {
      id: Math.random().toString(36).slice(2, 10),
      token: Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2),
      name: clean,
      color,
      emoji,
      score: 0,
      socketId,
    };
    this.players.set(player.id, player);
    // Partnerships are drawn when a round starts, so a late joiner spectates until the next one.
    this.broadcast();
    return { ok: true, player };
  }

  disconnectPlayer(socketId: string) {
    const p = [...this.players.values()].find((x) => x.socketId === socketId);
    if (!p) return;
    p.socketId = null;
    if (!this.maybeAdvance()) this.broadcast();
  }

  /** Removing someone mid-round would break the partnerships, so the host can only do it between games. */
  kick(playerId: string) {
    if (this.phase !== 'lobby' && this.phase !== 'gameOver') return;
    const p = this.players.get(playerId);
    if (!p) return;
    if (p.socketId) this.io.to(p.socketId).emit('closed', 'You were removed from the game by the host.');
    this.players.delete(playerId);
    this.broadcast();
  }

  private isConnected(id: string) {
    return !!this.players.get(id)?.socketId;
  }

  // ------------------------------------------------------------------ timing

  private arm(ms: number | null, fn: () => void) {
    if (this.timer) clearTimeout(this.timer);
    this.onExpire = fn;
    this.remaining = null;
    if (ms && ms > 0) {
      this.deadline = Date.now() + ms;
      if (this.paused) {
        this.remaining = ms;
        this.timer = null;
      } else {
        this.timer = setTimeout(() => this.fire(), ms);
      }
    } else {
      this.deadline = null;
      this.timer = null;
    }
  }

  private fire() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const fn = this.onExpire;
    this.onExpire = null;
    this.deadline = null;
    this.remaining = null;
    fn?.();
    this.broadcast();
  }

  private pause() {
    if (this.paused) return;
    this.paused = true;
    if (this.timer && this.deadline) {
      this.remaining = Math.max(0, this.deadline - Date.now());
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private resume() {
    this.paused = false;
    if (this.remaining != null && this.onExpire) {
      this.deadline = Date.now() + this.remaining;
      this.timer = setTimeout(() => this.fire(), this.remaining);
      this.remaining = null;
    }
  }

  /** Host pressed "skip": end the current timed/open phase right now. */
  skip() {
    if (this.paused || !this.onExpire) return;
    this.fire();
  }

  private sec(n: number) {
    return n > 0 ? n * 1000 * SCALE : null;
  }

  // ------------------------------------------------------------------ settings & flow

  updateSettings(patch: SettingsPatch) {
    if (this.phase !== 'lobby') return;
    const s = this.settings;
    if (patch.endMode === 'points' || patch.endMode === 'rounds') s.endMode = patch.endMode;
    if (patch.target !== undefined) s.target = clampInt(patch.target, 1, 999, s.target);
    if (patch.maxHintLength !== undefined) s.maxHintLength = clampInt(patch.maxHintLength, 3, 40, s.maxHintLength);
    if (patch.timers) {
      for (const k of Object.keys(s.timers) as (keyof Timers)[]) {
        if (patch.timers[k] !== undefined) s.timers[k] = clampInt(patch.timers[k], 0, 3600, s.timers[k]);
      }
    }
    this.broadcast();
  }

  start() {
    if (this.phase !== 'lobby') return;
    const connected = [...this.players.values()].filter((p) => p.socketId);
    if (connected.length < MIN_PLAYERS) return;
    this.round = 0;
    for (const p of this.players.values()) p.score = 0;
    this.startRound();
    this.broadcast();
  }

  playAgain() {
    if (this.phase !== 'gameOver') return;
    this.phase = 'lobby';
    this.round = 0;
    this.cur = this.freshRound();
    for (const p of this.players.values()) p.score = 0;
    this.arm(null, () => {});
    this.onExpire = null;
    this.broadcast();
  }

  private freshRound(): RoundData {
    return {
      participants: [],
      truth: { pairs: [], odd: null },
      wordOf: new Map(),
      hints: new Map(),
      hintOrder: [],
      guesses: new Map(),
      finals: new Set(),
      reveal: [],
      revealIndex: 0,
      deltas: null,
    };
  }

  private drawWords(n: number): string[] {
    let free = WORDS.filter((w) => !this.usedWords.has(w));
    if (free.length < n) {
      this.usedWords.clear();
      free = [...WORDS];
    }
    const picked = shuffle(free).slice(0, n);
    picked.forEach((w) => this.usedWords.add(w));
    return picked;
  }

  private startRound() {
    const participants = shuffle([...this.players.values()].filter((p) => p.socketId).map((p) => p.id));
    if (participants.length < MIN_PLAYERS) {
      // too many people dropped out to carry on
      this.endGame();
      return;
    }
    this.round++;
    const cur = this.freshRound();
    const pairCount = Math.floor(participants.length / 2);
    const words = this.drawWords(pairCount + (participants.length % 2));
    for (let i = 0; i < pairCount; i++) {
      const a = participants[2 * i];
      const b = participants[2 * i + 1];
      cur.truth.pairs.push({ a, b, word: words[i] });
      cur.wordOf.set(a, words[i]);
      cur.wordOf.set(b, words[i]);
    }
    if (participants.length % 2) {
      const id = participants[participants.length - 1];
      cur.truth.odd = { id, word: words[pairCount] };
      cur.wordOf.set(id, words[pairCount]);
    }
    cur.participants = participants;
    this.cur = cur;
    this.phase = 'hint';
    this.arm(this.sec(this.settings.timers.hint), () => this.enterGuess());
  }

  private enterGuess() {
    this.cur.hintOrder = shuffle(this.cur.participants);
    this.phase = 'guess';
    this.arm(this.sec(this.settings.timers.guess), () => this.resolveGuess());
  }

  private resolveGuess() {
    const c = this.cur;
    // Whatever each player had saved when time ran out counts.
    const guesses = new Map<string, GuessInput>();
    for (const id of c.participants) guesses.set(id, c.guesses.get(id) ?? emptyGuess());
    const { deltas, entries } = scoreRound(c.truth, c.participants, guesses);
    for (const [id, d] of Object.entries(deltas)) {
      const p = this.players.get(id);
      if (p) p.score += d;
    }
    c.deltas = deltas;
    // Fewest correct guessers first (ties shuffled); the player without a partner always comes last.
    const pairs = shuffle(entries.filter((e) => e.kind === 'pair')).sort((x, y) => x.guesserIds.length - y.guesserIds.length);
    c.reveal = [...pairs, ...entries.filter((e) => e.kind === 'odd')];
    c.revealIndex = 0;
    this.phase = 'reveal';
    this.arm(this.revealMs(0), () => this.nextReveal());
  }

  private revealMs(index: number) {
    return (revealTiming(this.cur.reveal[index].guesserIds.length).endMs + REVEAL_HOLD_MS) * SCALE;
  }

  private nextReveal() {
    if (this.cur.revealIndex < this.cur.reveal.length - 1) {
      this.cur.revealIndex++;
      this.arm(this.revealMs(this.cur.revealIndex), () => this.nextReveal());
    } else {
      this.phase = 'standings';
      this.arm(STANDINGS_MS, () => this.afterStandings());
    }
  }

  private afterStandings() {
    const { endMode, target } = this.settings;
    const top = Math.max(0, ...[...this.players.values()].map((p) => p.score));
    const over = endMode === 'points' ? top >= target : this.round >= target;
    if (over) this.endGame();
    else this.startRound();
  }

  private endGame() {
    this.phase = 'gameOver';
    this.onExpire = null;
    this.arm(null, () => {});
    this.onExpire = null;
  }

  // ------------------------------------------------------------------ player actions

  private isParticipant(id: string) {
    return this.cur.participants.includes(id);
  }

  submitHint(playerId: string, input: HintInput): string | null {
    if (this.phase !== 'hint') return 'Too late - hints are closed.';
    if (!this.isParticipant(playerId)) return 'You are watching this round.';
    if (this.cur.hints.has(playerId)) return 'Already submitted.';
    let hint: StoredHint;
    if (input?.kind === 'text') {
      const text = String(input.text ?? '').trim();
      if (!text) return 'Write a word first!';
      if (/\s/.test(text)) return 'No spaces allowed - just one word.';
      if (text.length > this.settings.maxHintLength) return `Keep it to ${this.settings.maxHintLength} characters.`;
      hint = { kind: 'text', text };
    } else if (input?.kind === 'draw') {
      const strokes = cleanStrokes(input.strokes);
      if (!strokes) return 'Draw something first!';
      hint = { kind: 'draw', strokes };
    } else {
      return 'Invalid hint.';
    }
    this.cur.hints.set(playerId, hint);
    if (!this.maybeAdvance()) this.broadcast();
    return null;
  }

  submitGuess(playerId: string, raw: GuessInput, final: boolean): string | null {
    if (this.phase !== 'guess') return 'Guessing is closed.';
    if (!this.isParticipant(playerId)) return 'You are watching this round.';
    if (this.cur.finals.has(playerId)) return 'You already submitted your guess.';
    const guess = normalizeGuess(raw, this.cur.participants);
    if (typeof guess === 'string') return guess;
    this.cur.guesses.set(playerId, guess);
    if (final) this.cur.finals.add(playerId);
    if (final && !this.maybeAdvance()) this.broadcast();
    else if (!final) this.broadcastTo(playerId);
    return null;
  }

  // ------------------------------------------------------------------ auto-advance

  private livePlayers(): string[] {
    return this.cur.participants.filter((id) => this.isConnected(id));
  }

  private playerDone(id: string): boolean {
    if (!this.cur.participants.includes(id)) return false;
    switch (this.phase) {
      case 'hint':
        return this.cur.hints.has(id);
      case 'guess':
        return this.cur.finals.has(id);
      default:
        return false;
    }
  }

  private allDone(): boolean {
    if (this.phase !== 'hint' && this.phase !== 'guess') return false;
    const live = this.livePlayers();
    return live.length > 0 && live.every((id) => this.playerDone(id));
  }

  /** Ends the phase if everyone has finished. Returns true if it advanced (and broadcast). */
  private maybeAdvance(): boolean {
    if (this.paused || !this.onExpire) return false;
    if (!this.allDone()) return false;
    this.fire();
    return true;
  }

  // ------------------------------------------------------------------ state views

  private publicHints(): HintPublic[] {
    return this.cur.hintOrder.map((playerId) => ({ playerId, ...(this.cur.hints.get(playerId) ?? { kind: 'none' as const }) }));
  }

  private baseState(): ClientState {
    const c = this.cur;
    const players: PlayerInfo[] = [...this.players.values()].map((p) => ({
      id: p.id,
      name: p.name,
      color: p.color,
      emoji: p.emoji,
      score: p.score,
      connected: !!p.socketId,
      participating: c.participants.includes(p.id),
      done: this.playerDone(p.id),
    }));
    const top = Math.max(0, ...players.map((p) => p.score));
    const showHints = this.phase === 'guess' || this.phase === 'reveal' || this.phase === 'standings';
    return {
      code: this.code,
      phase: this.phase,
      paused: this.paused,
      serverNow: Date.now(),
      deadline: this.paused && this.remaining != null ? Date.now() + this.remaining : this.deadline,
      settings: this.settings,
      players,
      round: this.round,
      participantIds: c.participants,
      hints: showHints ? this.publicHints() : [],
      layout: guessLayout(c.participants.length),
      reveal: this.phase === 'reveal' ? c.reveal.slice(0, c.revealIndex + 1) : [],
      revealIndex: c.revealIndex,
      revealTotal: c.reveal.length,
      roundDeltas: this.phase === 'standings' || this.phase === 'gameOver' ? c.deltas : null,
      winnerIds: this.phase === 'gameOver' ? players.filter((p) => p.score === top).map((p) => p.id) : [],
      you: null,
    };
  }

  private youFor(p: Player, base: ClientState): ClientState {
    const c = this.cur;
    const inRound = c.participants.includes(p.id);
    const own = c.hints.get(p.id);
    return {
      ...base,
      you: {
        id: p.id,
        participating: inRound,
        word: inRound && (this.phase === 'hint' || this.phase === 'guess') ? (c.wordOf.get(p.id) ?? null) : null,
        hintSubmitted: c.hints.has(p.id),
        ownHint: own ? { playerId: p.id, ...own } : null,
        guessSubmitted: c.finals.has(p.id),
        guess: c.guesses.get(p.id) ?? null,
      },
    };
  }

  private broadcastTo(playerId: string) {
    const p = this.players.get(playerId);
    if (p?.socketId) this.io.to(p.socketId).emit('state', this.youFor(p, this.baseState()));
  }

  broadcast() {
    const base = this.baseState();
    if (this.hostSocketId) this.io.to(this.hostSocketId).emit('state', base);
    for (const p of this.players.values()) {
      if (p.socketId) this.io.to(p.socketId).emit('state', this.youFor(p, base));
    }
  }
}
