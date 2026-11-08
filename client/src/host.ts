import QRCode from 'qrcode';
import './styles-common.css';
import './host.css';
import { MIN_PLAYERS, revealTiming, type ClientState, type PlayerInfo, type RevealEntry, type Timers } from '../../shared/types';
import { $, esc, GAME_NAME, hintBody, hintCardHTML, rankPlayers, socket, syncState, timerHTML } from './common';

const STORE = 'matchyfinderoo.host';
const stage = $('#stage')!;
const strip = $('#strip')!;
const hudTimer = $('#hudTimer')!;
const skipBtn = $<HTMLButtonElement>('#skip')!;
hudTimer.innerHTML = timerHTML();

let state: ClientState | null = null;
let viewKey = '';
let roomCode = '';
let joinBase = location.origin;
let qrDataUrl = '';

// ------------------------------------------------------------------ connection

function load(): { code: string; hostToken: string } | null {
  try {
    return JSON.parse(localStorage.getItem(STORE) || 'null');
  } catch {
    return null;
  }
}

function createRoom() {
  socket.emit('host:create', (res) => {
    if (!res.ok) return;
    roomCode = res.code;
    try {
      localStorage.setItem(STORE, JSON.stringify({ code: res.code, hostToken: res.hostToken }));
    } catch {
      /* ignore */
    }
    prepareJoinInfo();
  });
}

socket.on('connect', () => {
  $('#conn')!.hidden = true;
  const saved = load();
  if (saved) {
    socket.emit('host:resume', saved, (res) => {
      if (res.ok) {
        roomCode = saved.code;
        prepareJoinInfo();
      } else createRoom();
    });
  } else createRoom();
});
socket.on('disconnect', () => ($('#conn')!.hidden = false));
socket.on('state', (s) => {
  state = s;
  syncState(s);
  render();
});
socket.on('closed', () => {
  try {
    localStorage.removeItem(STORE);
  } catch {
    /* ignore */
  }
  location.reload();
});

async function prepareJoinInfo() {
  const { hostname, port, protocol, origin } = location;
  joinBase = origin;
  if (hostname === 'localhost' || hostname === '127.0.0.1') {
    // phones can't reach "localhost" - advertise this computer's LAN address instead
    try {
      const { ips } = (await (await fetch('/api/info')).json()) as { ips: string[] };
      if (ips[0]) joinBase = `${protocol}//${ips[0]}${port ? ':' + port : ''}`;
    } catch {
      /* fall back to origin */
    }
  }
  qrDataUrl = await QRCode.toDataURL(`${joinBase}/play.html?room=${roomCode}`, { margin: 1, width: 520, color: { dark: '#1b1033', light: '#ffffff' } });
  viewKey = '';
  render();
}

// ------------------------------------------------------------------ helpers

const byId = (s: ClientState, id: string | null) => s.players.find((p) => p.id === id);

function avatar(p: PlayerInfo | undefined, cls = 'av') {
  return `<span class="${cls}" style="--pc:${p?.color ?? '#888'}">${p?.emoji ?? '❔'}</span>`;
}

function confetti(count = 140) {
  const colors = ['#ffd23f', '#ff4d6d', '#2ec4ff', '#3ddc97', '#c77dff', '#ff9f1c', '#ffffff'];
  for (let i = 0; i < count; i++) {
    const el = document.createElement('i');
    el.className = 'cf';
    el.style.left = Math.random() * 100 + 'vw';
    el.style.background = colors[i % colors.length];
    el.style.setProperty('--dx', (Math.random() * 30 - 15).toFixed(1) + 'vw');
    el.style.setProperty('--rot', Math.round(Math.random() * 900 - 450) + 'deg');
    el.style.animationDuration = 2.4 + Math.random() * 2.4 + 's';
    el.style.animationDelay = Math.random() * 0.8 + 's';
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 6500);
  }
}

function syncChildren<T>(host: HTMLElement, items: T[], id: (t: T) => string, make: (t: T) => HTMLElement, update: (el: HTMLElement, t: T) => void) {
  const existing = new Map<string, HTMLElement>();
  host.querySelectorAll<HTMLElement>(':scope > [data-id]').forEach((e) => existing.set(e.dataset.id!, e));
  const keep = new Set<string>();
  items.forEach((t, i) => {
    const k = id(t);
    keep.add(k);
    let el = existing.get(k);
    if (!el) {
      el = make(t);
      el.dataset.id = k;
    }
    update(el, t);
    const at = host.children[i] as HTMLElement | undefined;
    if (at !== el) host.insertBefore(el, at ?? null);
  });
  existing.forEach((el, k) => !keep.has(k) && el.remove());
}

function counts(s: ClientState) {
  const live = s.players.filter((p) => p.participating && p.connected);
  return { done: live.filter((p) => p.done).length, total: live.length };
}

// ------------------------------------------------------------------ views

function lobbyView(s: ClientState): string {
  const t = s.settings.timers;
  const sel = (key: keyof Timers, label: string) => {
    const presets = [15, 30, 45, 60, 90, 120, 180, 240, 300];
    const vals = [...new Set([...presets, t[key]].filter((v) => v > 0))].sort((a, b) => a - b);
    return `<label>${label}<select data-tkey="${key}">${vals.map((v) => `<option value="${v}" ${v === t[key] ? 'selected' : ''}>${v} seconds</option>`).join('')}<option value="0" ${t[key] === 0 ? 'selected' : ''}>Unlimited</option></select></label>`;
  };
  return `<section class="lobby">
    <div class="lobby-left">
      <div class="logo">${esc(GAME_NAME).replace(' ', '<br>')}</div>
      <div class="join-card">
        ${qrDataUrl ? `<img class="qr" src="${qrDataUrl}" alt="QR code to join" />` : '<div class="qr"></div>'}
        <div class="t">Scan the code or go to<br /><b>${esc(joinBase.replace(/^https?:\/\//, ''))}</b><br />and enter room code<div class="roomcode">${esc(s.code)}</div></div>
      </div>
    </div>
    <div class="lobby-right">
      <div class="bubbles" id="bubbles"></div>
      <div class="settings">
        <h3>Game settings</h3>
        <label>Game ends when<select id="endMode"><option value="points">First to X points</option><option value="rounds">Play X rounds</option></select></label>
        <label><span id="targetLabel">Points to win</span><input id="target" type="number" min="1" max="999" /></label>
        <label>Max typed hint length<input id="maxLen" type="number" min="3" max="40" /></label>
        ${sel('hint', 'Hint time')}
        ${sel('guess', 'Guessing time')}
      </div>
      <button class="startbtn" id="start" disabled>Start game</button>
    </div>
  </section>`;
}

function lobbyLive(s: ClientState) {
  const b = $('#bubbles')!;
  if (!s.players.length) {
    if (!b.querySelector('.empty')) b.innerHTML = '<div class="empty">Waiting for players to join… 📱</div>';
  } else {
    b.querySelector('.empty')?.remove();
    syncChildren(
      b,
      s.players,
      (p) => p.id,
      (p) => {
        const el = document.createElement('div');
        el.className = 'bubble';
        el.style.setProperty('--pc', p.color);
        el.innerHTML = `<span class="av">${p.emoji}</span><span class="nm">${esc(p.name)}</span><button class="x" data-kick="${p.id}" title="Remove">✕</button>`;
        return el;
      },
      (el, p) => el.classList.toggle('off', !p.connected),
    );
  }
  const live = s.players.filter((p) => p.connected).length;
  const start = $<HTMLButtonElement>('#start')!;
  start.disabled = live < MIN_PLAYERS;
  start.textContent = live < MIN_PLAYERS ? `Need at least ${MIN_PLAYERS} players` : `Start game (${live} players)`;
  const setIfIdle = (el: HTMLInputElement | HTMLSelectElement, v: string) => {
    if (document.activeElement !== el && el.value !== v) el.value = v;
  };
  setIfIdle($<HTMLSelectElement>('#endMode')!, s.settings.endMode);
  setIfIdle($<HTMLInputElement>('#target')!, String(s.settings.target));
  setIfIdle($<HTMLInputElement>('#maxLen')!, String(s.settings.maxHintLength));
  $('#targetLabel')!.textContent = s.settings.endMode === 'points' ? 'Points to win' : 'Number of rounds';
  stage.querySelectorAll<HTMLSelectElement>('select[data-tkey]').forEach((sel) => setIfIdle(sel, String(s.settings.timers[sel.dataset.tkey as keyof Timers])));
}

function hintPhaseView(s: ClientState): string {
  return `<section>
    <div class="eyebrow">Round ${s.round}</div>
    <h1>Look at your phone!</h1>
    <div class="sub">Everyone has a secret word. <b>Somebody else has the same one.</b><br>Write one word or draw a picture that your partner will recognize — but don't make it too easy!</div>
    <div class="status"><b data-done>0/0</b> hints in</div>
  </section>`;
}

function guessPhaseView(s: ClientState): string {
  const n = s.hints.length;
  const cw = n <= 3 ? 22 : n <= 6 ? 15 : n <= 8 ? 13 : n <= 12 ? 12 : n <= 18 ? 10 : 8; // card width in rem, so every hint fits on screen
  const pairs = s.layout.pairSlots + 1;
  const odd = s.layout.noneSlot ? ' Someone has <b>no partner</b> — can you spot who?' : '';
  const cards = s.hints.map((h, i) => hintCardHTML(h, byId(s, h.playerId)).replace('class="hint-card ', `style="animation-delay:${(i * 0.05).toFixed(2)}s" class="hint-card `)).join('');
  return `<section>
    <div class="eyebrow">Round ${s.round} · ${n} players · ${pairs} partnerships</div>
    <div class="sub">Who is partnered with whom?${odd}</div>
    <div class="hgrid" style="--cw:${cw}rem">${cards}</div>
    <div class="status"><b data-done>0/0</b> locked in</div>
  </section>`;
}

function revealView(s: ClientState): string {
  const e = s.reveal[s.reveal.length - 1];
  const ids = s.hints;
  const hintOf = (id: string | null) => ids.find((h) => h.playerId === id) ?? null;
  const { t0, step } = revealTiming(e.guesserIds.length);
  const who = (id: string | null, d: number) => {
    const p = byId(s, id);
    const h = hintOf(id);
    return `<div class="rv-who" style="--pc:${p?.color ?? '#888'};--d:${d}s">${avatar(p)}<span class="nm">${esc(p?.name ?? '?')}</span><div class="hint-card" style="--pc:${p?.color ?? '#888'}"><div class="hint-body ${h?.kind}">${hintBody(h)}</div></div></div>`;
  };
  const a = byId(s, e.aId);
  const b = byId(s, e.bId);
  let verdict = '';
  if (e.kind === 'pair') {
    if (e.aFoundB && e.bFoundA) verdict = `<div class="rv-verdict ok">🎉 They found each other! +1 each</div>`;
    else if (e.aFoundB) verdict = `<div class="rv-verdict no">${esc(a!.name)} picked ${esc(b!.name)}, but ${esc(b!.name)} didn't pick back — no points</div>`;
    else if (e.bFoundA) verdict = `<div class="rv-verdict no">${esc(b!.name)} picked ${esc(a!.name)}, but ${esc(a!.name)} didn't pick back — no points</div>`;
    else verdict = `<div class="rv-verdict no">They never found each other</div>`;
  } else {
    verdict = `<div class="rv-verdict no">Nobody else had this word!</div>`;
  }
  const chips = e.guesserIds
    .map((id, i) => {
      const p = byId(s, id);
      return `<div class="rv-chip" style="--pc:${p?.color};--i:${i};--t0:${t0}s;--step:${step.toFixed(2)}s"><span class="av">${p?.emoji}</span>${esc(p?.name ?? '?')}<span class="plus">+1</span></div>`;
    })
    .join('');
  const guessers = e.guesserIds.length
    ? `<div class="rv-label" style="--t0:${(t0 - 0.4).toFixed(2)}s">${e.kind === 'odd' ? 'Spotted the odd one out' : 'Spotted this partnership'}</div><div class="rv-chips">${chips}</div>`
    : `<div class="rv-none" style="--t0:${(t0 - 0.4).toFixed(2)}s">${e.kind === 'odd' ? 'Nobody spotted the odd one out!' : 'Nobody spotted this partnership!'}</div>`;
  const title = e.kind === 'odd' ? 'The player with no partner' : `Partnership ${s.revealIndex + 1} of ${s.revealTotal - (s.layout.noneSlot ? 1 : 0)}`;
  return `<section class="reveal">
    <div class="rv-progress">${s.revealIndex + 1} / ${s.revealTotal}</div>
    <div class="rv ${e.kind === 'odd' ? 'rv-odd' : ''}">
      <div class="rv-title">${title}</div>
      <div class="rv-pair">${who(e.aId, 0)}${e.kind === 'pair' ? `<span class="heart">💞</span>${who(e.bId, 0.25)}` : ''}</div>
      <div class="rv-word">${esc(e.word)}</div>
      ${verdict}
      <div class="rv-guessers">${guessers}</div>
    </div>
  </section>`;
}

function standingsView(s: ClientState): string {
  const ranked = rankPlayers(s.players);
  const max = Math.max(1, ...ranked.map((p) => p.score));
  const top = Math.max(...s.players.map((p) => p.score));
  const final = s.settings.endMode === 'points' ? top >= s.settings.target : s.round >= s.settings.target;
  const goal = s.settings.endMode === 'points' ? `First to ${s.settings.target} points` : `Round ${s.round} of ${s.settings.target}`;
  const rows = ranked
    .map((p, i) => {
      const d = s.roundDeltas?.[p.id] ?? 0;
      return `<div class="row" style="--i:${i};--pc:${p.color};--from:${(((p.score - d) / max) * 100).toFixed(1)}%;--to:${((p.score / max) * 100).toFixed(1)}%">
        <span class="rk">${p.rank}</span>${avatar(p)}<span class="nm">${esc(p.name)}</span>
        <div class="trk"><div class="fill"></div></div><span class="tot">${p.score}</span><span class="dl ${d ? '' : 'z'}">+${d}</span></div>`;
    })
    .join('');
  return `<section>
    <div class="eyebrow">Round ${s.round} standings</div>
    <div class="sub">${esc(goal)}</div>
    <div class="board">${rows}</div>
    ${final ? '<div class="final-note">🏁 That was the final round!</div>' : ''}
    <div class="sum-bar"><i data-timer-bar></i></div>
  </section>`;
}

function gameOverView(s: ClientState): string {
  const ranked = rankPlayers(s.players);
  const winners = ranked.filter((p) => s.winnerIds.includes(p.id));
  const title = winners.length > 1 ? `It's a tie! ${winners.map((w) => esc(w.name)).join(' & ')}` : `${esc(winners[0]?.name ?? 'Nobody')} wins!`;
  const top3 = ranked.slice(0, 3);
  const order = top3.length === 3 ? [top3[1], top3[0], top3[2]] : top3.length === 2 ? [top3[1], top3[0]] : top3;
  const heights: Record<number, number> = { 0: 100, 1: 72, 2: 52 };
  const pod = order
    .map((p) => {
      const idx = top3.indexOf(p);
      return `<div class="pod" style="--pc:${p.color}">${s.winnerIds.includes(p.id) ? '<div style="font-size:2.4rem;line-height:1">👑</div>' : ''}${avatar(p)}<div class="nm">${esc(p.name)}</div><div class="blk" style="--h:${heights[idx] * 0.12}rem;--d:${0.4 + (2 - idx) * 0.5}s">${p.score}</div></div>`;
    })
    .join('');
  const others = ranked.slice(3).map((p) => `<div class="pchip" style="--pc:${p.color}">${avatar(p)}${esc(p.name)} <span class="sc">${p.score}</span></div>`).join('');
  return `<section>
    <div class="trophy">🏆</div>
    <h1>${title}</h1>
    <div class="podium">${pod}</div>
    ${others ? `<div class="others">${others}</div>` : ''}
    <button class="again" id="again">Play again</button>
  </section>`;
}

// ------------------------------------------------------------------ render loop

function keyFor(s: ClientState): string {
  switch (s.phase) {
    case 'reveal':
      return `reveal|${s.round}|${s.revealIndex}`;
    default:
      return `${s.phase}|${s.round}`;
  }
}

function stripLive(s: ClientState) {
  const show = s.phase === 'hint' || s.phase === 'guess';
  strip.hidden = !show;
  if (!show) return;
  syncChildren(
    strip,
    s.players.filter((p) => p.participating),
    (p) => p.id,
    (p) => {
      const el = document.createElement('div');
      el.className = 'pchip';
      el.style.setProperty('--pc', p.color);
      el.innerHTML = `<span class="av">${p.emoji}</span><span>${esc(p.name)}</span><span class="tick">✓</span>`;
      return el;
    },
    (el, p) => {
      el.classList.toggle('done', p.done);
      el.classList.toggle('off', !p.connected);
    },
  );
}

function liveUpdate(s: ClientState) {
  if (s.phase === 'lobby') lobbyLive(s);
  const { done, total } = counts(s);
  stage.querySelectorAll('[data-done]').forEach((el) => (el.textContent = `${done}/${total}`));
  // guess phase: mark hint cards whose owner has locked in their guesses
  stage.querySelectorAll<HTMLElement>('.hgrid .hint-card').forEach((el) => el.classList.toggle('locked', !!byId(s, el.dataset.hint ?? '')?.done));
}

const VIEWS: Record<string, (s: ClientState) => string> = {
  lobby: lobbyView,
  hint: hintPhaseView,
  guess: guessPhaseView,
  reveal: revealView,
  standings: standingsView,
  gameOver: gameOverView,
};

function render() {
  const s = state;
  if (!s) return;
  $('#hudCode')!.innerHTML = s.phase === 'lobby' ? '' : `ROOM <b>${esc(s.code)}</b>`;
  hudTimer.hidden = s.phase === 'lobby' || s.phase === 'gameOver';
  skipBtn.hidden = hudTimer.hidden;

  const key = keyFor(s);
  if (key !== viewKey) {
    viewKey = key;
    stage.innerHTML = VIEWS[s.phase](s);
    if (s.phase === 'reveal') {
      const e = s.reveal[s.reveal.length - 1];
      if (e.kind === 'pair' && e.aFoundB && e.bFoundA) setTimeout(() => state?.phase === 'reveal' && state.revealIndex === s.revealIndex && confetti(60), 1900);
    }
    if (s.phase === 'gameOver') {
      confetti(220);
      setTimeout(() => state?.phase === 'gameOver' && confetti(160), 2500);
    }
  }
  liveUpdate(s);
  stripLive(s);
}

// ------------------------------------------------------------------ input

function pushSettings() {
  const num = (id: string) => Number($<HTMLInputElement>(id)!.value);
  const timers: Partial<Timers> = {};
  stage.querySelectorAll<HTMLSelectElement>('select[data-tkey]').forEach((sel) => (timers[sel.dataset.tkey as keyof Timers] = Number(sel.value)));
  socket.emit('host:settings', {
    endMode: $<HTMLSelectElement>('#endMode')!.value as 'points' | 'rounds',
    target: num('#target'),
    maxHintLength: num('#maxLen'),
    timers,
  });
}

stage.addEventListener('change', (e) => {
  if ((e.target as HTMLElement).closest('.settings')) pushSettings();
});
stage.addEventListener('click', (e) => {
  const t = e.target as HTMLElement;
  if (t.closest('#start')) socket.emit('host:start');
  else if (t.closest('#again')) socket.emit('host:playAgain');
  else {
    const k = t.closest<HTMLElement>('[data-kick]');
    if (k && confirm('Remove this player from the game?')) socket.emit('host:kick', { playerId: k.dataset.kick! });
  }
});
skipBtn.addEventListener('click', () => socket.emit('host:skip'));
window.addEventListener('keydown', (e) => {
  if (e.code === 'Space' && state && !['lobby', 'gameOver'].includes(state.phase) && !(e.target as HTMLElement).matches('input, select, textarea, button')) {
    e.preventDefault();
    socket.emit('host:skip');
  }
});
