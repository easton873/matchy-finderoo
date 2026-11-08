import { io, type Socket } from 'socket.io-client';
import { DRAW_SIZE, type ClientState, type ClientToServerEvents, type HintPublic, type PlayerInfo, type ServerToClientEvents, type Stroke } from '../../shared/types';

export const GAME_NAME = 'Matchy Finderoo';

export const socket: Socket<ServerToClientEvents, ClientToServerEvents> = io({ transports: ['websocket', 'polling'] });

export const $ = <T extends HTMLElement = HTMLElement>(sel: string, root: ParentNode = document) => root.querySelector(sel) as T | null;

const ESC: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (s: string) => String(s).replace(/[&<>"']/g, (c) => ESC[c]);

// ---- server clock + countdowns ----------------------------------------------------------

let clockOffset = 0;
let deadline: number | null = null;
let paused = false;
let total = 0;
let lastDeadlineSeen: number | null = null;

export function syncState(s: ClientState) {
  clockOffset = s.serverNow - Date.now();
  paused = s.paused;
  deadline = s.deadline;
  if (s.deadline !== lastDeadlineSeen) {
    lastDeadlineSeen = s.deadline;
    total = s.deadline ? Math.max(1000, s.deadline - s.serverNow) : 0;
  }
  tick();
}

/** Fraction of the current phase timer remaining, 0..1 (1 when unlimited). */
function tick() {
  const left = deadline ? Math.max(0, deadline - (Date.now() + clockOffset)) : null;
  const secs = left == null ? null : Math.ceil(left / 1000);
  const frac = left == null || !total ? 1 : Math.min(1, left / total);
  document.querySelectorAll<HTMLElement>('[data-timer]').forEach((el) => {
    const text = paused ? '⏸' : secs == null ? '∞' : String(secs);
    const label = el.querySelector<HTMLElement>('[data-timer-text]') ?? el;
    if (label.textContent !== text) label.textContent = text;
    el.style.setProperty('--frac', String(frac));
    el.classList.toggle('urgent', secs != null && secs <= 5 && !paused);
    el.classList.toggle('unlimited', secs == null);
  });
  document.querySelectorAll<HTMLElement>('[data-timer-bar]').forEach((el) => {
    el.style.transform = `scaleX(${frac})`;
  });
}
setInterval(tick, 200);

export const timerHTML = (cls = '') =>
  `<div class="timer ${cls}" data-timer><svg viewBox="0 0 36 36"><circle class="track" cx="18" cy="18" r="16"/><circle class="arc" cx="18" cy="18" r="16"/></svg><span data-timer-text>∞</span></div>`;

export function ordinal(n: number) {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

/** Competition ranking with ties sharing a rank. */
export function rankPlayers<T extends { score: number }>(players: T[]): (T & { rank: number })[] {
  const sorted = [...players].sort((a, b) => b.score - a.score);
  return sorted.map((p, i) => ({ ...p, rank: sorted.findIndex((q) => q.score === p.score) + 1 }));
}

// ---- hints (typed word or black-pen drawing) -----------------------------------------------

/** A drawing as an inline SVG. The pen is always black on white. */
export function drawingSVG(strokes: Stroke[]): string {
  const paths = strokes
    .map((s) => {
      if (s.length === 1) return `<circle cx="${s[0][0]}" cy="${s[0][1]}" r="9" fill="#000"/>`;
      return `<path d="M${s.map((p) => p.join(' ')).join('L')}" fill="none" stroke="#000" stroke-width="16" stroke-linecap="round" stroke-linejoin="round"/>`;
    })
    .join('');
  return `<svg class="drawing" viewBox="0 0 ${DRAW_SIZE} ${DRAW_SIZE}" xmlns="http://www.w3.org/2000/svg"><rect width="${DRAW_SIZE}" height="${DRAW_SIZE}" fill="#fff"/>${paths}</svg>`;
}

export function hintBody(h: HintPublic | null | undefined): string {
  if (!h || h.kind === 'none') return `<div class="hint-none">no hint</div>`;
  if (h.kind === 'draw') return drawingSVG(h.strokes ?? []);
  return `<div class="hint-text">${esc(h.text ?? '')}</div>`;
}

/** A player's hint card with their name on it. */
export function hintCardHTML(h: HintPublic, p: PlayerInfo | undefined, extra = ''): string {
  return `<div class="hint-card ${extra}" data-hint="${esc(h.playerId)}" style="--pc:${p?.color ?? '#888'}"><div class="hint-who"><i>${p?.emoji ?? '❔'}</i><span>${esc(p?.name ?? '?')}</span></div><div class="hint-body ${h.kind}">${hintBody(h)}</div></div>`;
}
