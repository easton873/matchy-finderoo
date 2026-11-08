import './styles-common.css';
import './play.css';
import { DRAW_SIZE, MAX_POINTS, MAX_STROKES, type ClientState, type GuessInput, type HintPublic, type PlayerInfo, type Stroke } from '../../shared/types';
import { $, drawingSVG, esc, hintBody, ordinal, rankPlayers, socket, syncState, timerHTML } from './common';

interface View {
  header?: string;
  main: string;
  footer?: string;
  after?: () => void;
}

const app = $('#app')!;
const STORE = 'matchyfinderoo.player';

let state: ClientState | null = null;
let me: { code: string; token: string; name: string; id: string } | null = null;
let joinError = '';
let viewKey = '';
let closedMsg = '';

// hint phase drafts (kept across repaints)
let hintMode: 'type' | 'draw' = 'type';
let typed = '';
let strokes: Stroke[] = [];

// guess phase: which slot every other player currently sits in
type SlotKey = string; // 'pool' | 'partner' | 'none' | 'pair:0' | 'pair:1' ...
let place: Record<string, SlotKey> = {};
let selected: string | null = null;
let confirmIncomplete = false;
let initKey = '';

const params = new URLSearchParams(location.search);

function loadStored(): { code: string; token: string; name: string } | null {
  try {
    return JSON.parse(localStorage.getItem(STORE) || 'null');
  } catch {
    return null;
  }
}
const saveStored = (v: unknown) => {
  try {
    if (v) localStorage.setItem(STORE, JSON.stringify(v));
    else localStorage.removeItem(STORE);
  } catch {
    /* private mode: rejoin just won't survive a refresh */
  }
};

// ------------------------------------------------------------------ joining

function join(code: string, name: string, token?: string) {
  socket.emit('player:join', { code, name, token }, (res) => {
    if (res.ok) {
      me = { code: code.toUpperCase(), name, token: res.token, id: res.playerId };
      saveStored({ code: me.code, token: me.token, name });
      joinError = '';
      closedMsg = '';
    } else {
      joinError = res.error;
      if (token) saveStored(null);
      me = null;
    }
    viewKey = '';
    render();
  });
}

socket.on('connect', () => {
  document.querySelector('.conn')?.remove();
  const stored = loadStored();
  const want = (params.get('room') || '').toUpperCase();
  if (me) join(me.code, me.name, me.token); // reconnect after a drop
  else if (stored && (!want || want === stored.code)) join(stored.code, stored.name, stored.token);
  else render();
});
socket.on('disconnect', () => {
  if (!document.querySelector('.conn')) document.body.insertAdjacentHTML('beforeend', '<div class="conn">Reconnecting…</div>');
});
socket.on('closed', (reason) => {
  closedMsg = reason;
  me = null;
  state = null;
  saveStored(null);
  viewKey = '';
  render();
});
socket.on('state', (s) => {
  state = s;
  syncState(s);
  render();
});

// ------------------------------------------------------------------ small helpers

function header(kicker: string, title: string, opts: { sub?: string; timer?: boolean } = {}): string {
  return `<div class="htxt"><div class="kicker">${esc(kicker)}</div><div class="title">${title}</div>${opts.sub ? `<div class="sub">${esc(opts.sub)}</div>` : ''}</div>${opts.timer ? timerHTML() : ''}`;
}

const centerView = (emoji: string, title: string, text = '', extra = ''): string =>
  `<div class="center"><div class="big-emoji">${emoji}</div><h2>${esc(title)}</h2>${text ? `<p>${esc(text)}</p>` : ''}${extra}</div>`;

function chipsHTML(s: ClientState) {
  return `<div class="chips">${s.players.map((p) => `<span class="chip ${p.connected ? '' : 'off'}" style="--pc:${p.color}"><i>${p.emoji}</i>${esc(p.name)}</span>`).join('')}</div>`;
}

const byId = (s: ClientState, id: string | null | undefined) => s.players.find((p) => p.id === id);
const nameOf = (s: ClientState, id: string | null | undefined) => byId(s, id)?.name ?? '?';

function toast(msg: string) {
  const t = document.createElement('div');
  t.className = 'toast';
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 2500);
}

function openHintModal(h: HintPublic, s: ClientState) {
  const body = h.kind === 'draw' ? drawingSVG(h.strokes ?? []) : h.kind === 'text' ? `<div class="big-hint">${esc(h.text ?? '')}</div>` : '<p>No hint</p>';
  const m = document.createElement('div');
  m.className = 'modal';
  m.innerHTML = `<div class="card"><div class="kicker">${esc(nameOf(s, h.playerId))}'s hint</div>${body}<button class="btn ghost">Close</button></div>`;
  m.addEventListener('click', (e) => {
    if (e.target === m || (e.target as HTMLElement).closest('button')) m.remove();
  });
  document.body.appendChild(m);
}

// ------------------------------------------------------------------ views

function joinView(): View {
  const code = esc(params.get('room') || '');
  return {
    header: header('Welcome', 'Join the game'),
    main: `<form id="jf" style="display:flex;flex-direction:column;gap:16px;margin-top:8px">
      <div class="field"><label for="code">Room code</label><input id="code" maxlength="4" value="${code}" autocapitalize="characters" autocomplete="off" autocorrect="off" spellcheck="false" /></div>
      <div class="field"><label for="name">Your name</label><input id="name" maxlength="14" value="${esc(loadStored()?.name ?? '')}" autocomplete="off" /></div>
      <div class="error">${esc(closedMsg || joinError)}</div>
      <button class="btn green" type="submit">Join</button>
    </form>`,
    after: () => {
      $<HTMLFormElement>('#jf')!.addEventListener('submit', (e) => {
        e.preventDefault();
        const c = $<HTMLInputElement>('#code')!.value.trim().toUpperCase();
        const n = $<HTMLInputElement>('#name')!.value.trim();
        if (c.length !== 4) joinError = 'Room codes are 4 letters.';
        else if (!n) joinError = 'Please enter a name.';
        else return join(c, n);
        $('.error')!.textContent = joinError;
      });
      (params.get('room') ? $('#name') : $('#code'))?.focus();
    },
  };
}

// ---- hint phase

function hintView(s: ClientState): View {
  const you = s.you!;
  const kicker = `Round ${s.round}`;
  if (you.hintSubmitted) {
    return {
      header: header(kicker, 'Hint locked in ✓', { timer: true }),
      main: centerView('🤫', 'Nice and sneaky!', 'Waiting for everyone else…', `<div class="hint-card mine" style="--pc:${byId(s, you.id)?.color}"><div class="hint-body ${you.ownHint?.kind}">${you.ownHint ? hintInner(you.ownHint) : ''}</div></div>`),
    };
  }
  const max = s.settings.maxHintLength;
  return {
    header: header(kicker, 'Give a hint', { sub: 'Your partner has the same word. Keep it secret from everyone else!', timer: true }),
    main: `<div class="word-banner"><small>Your word</small><b>${esc(you.word ?? '')}</b></div>
      <div class="tabs"><button data-mode="type" class="${hintMode === 'type' ? 'on' : ''}">⌨️ Type a word</button><button data-mode="draw" class="${hintMode === 'draw' ? 'on' : ''}">✏️ Draw</button></div>
      ${
        hintMode === 'type'
          ? `<input class="type-input" id="typed" maxlength="${max}" placeholder="one word" autocomplete="off" autocapitalize="none" autocorrect="off" spellcheck="false" /><div class="note">One word only — no spaces (max ${max} characters)</div>`
          : `<div class="draw-wrap"><canvas id="cv" width="600" height="600"></canvas></div><div class="row"><button class="btn ghost" id="undo">↩ Undo</button><button class="btn ghost" id="clear">🗑 Clear</button></div>`
      }
      <div class="error" id="err"></div>`,
    footer: `<button class="btn green" id="send" disabled>Send hint</button>`,
    after: () => {
      app.querySelectorAll<HTMLElement>('[data-mode]').forEach((b) =>
        b.addEventListener('click', () => {
          hintMode = b.dataset.mode as 'type' | 'draw';
          render(true);
        }),
      );
      const send = $<HTMLButtonElement>('#send')!;
      const submit = (payload: Parameters<typeof socket.emit<'player:hint'>>[1]) => {
        send.disabled = true;
        socket.emit('player:hint', payload, (res) => {
          if (!res.ok) {
            $('#err')!.textContent = res.error;
            send.disabled = false;
          }
        });
      };
      if (hintMode === 'type') {
        const input = $<HTMLInputElement>('#typed')!;
        const upd = () => {
          input.value = input.value.replace(/\s/g, ''); // spaces are never allowed
          typed = input.value;
          send.disabled = typed.length === 0;
        };
        input.value = typed;
        input.addEventListener('input', upd);
        input.addEventListener('keydown', (e) => e.key === ' ' && e.preventDefault());
        upd();
        send.addEventListener('click', () => submit({ kind: 'text', text: typed }));
      } else {
        setupCanvas(() => (send.disabled = strokes.length === 0));
        send.disabled = strokes.length === 0;
        send.addEventListener('click', () => submit({ kind: 'draw', strokes }));
      }
    },
  };
}

function hintInner(h: HintPublic): string {
  return h.kind === 'draw' ? drawingSVG(h.strokes ?? []) : `<div class="hint-text">${esc(h.text ?? '')}</div>`;
}

/** Black pen only. Points are stored on a 0..DRAW_SIZE square so every screen draws the same picture. */
function setupCanvas(onChange: () => void) {
  const cv = $<HTMLCanvasElement>('#cv')!;
  const ctx = cv.getContext('2d')!;
  const k = cv.width / DRAW_SIZE;
  const redraw = () => {
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, cv.width, cv.height);
    ctx.strokeStyle = '#000';
    ctx.fillStyle = '#000';
    ctx.lineWidth = 16 * k;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (const s of strokes) {
      if (s.length === 1) {
        ctx.beginPath();
        ctx.arc(s[0][0] * k, s[0][1] * k, 9 * k, 0, Math.PI * 2);
        ctx.fill();
        continue;
      }
      ctx.beginPath();
      s.forEach(([x, y], i) => (i ? ctx.lineTo(x * k, y * k) : ctx.moveTo(x * k, y * k)));
      ctx.stroke();
    }
  };
  const pointCount = () => strokes.reduce((n, s) => n + s.length, 0);
  const pos = (e: PointerEvent): [number, number] => {
    const r = cv.getBoundingClientRect();
    return [Math.round(((e.clientX - r.left) / r.width) * DRAW_SIZE), Math.round(((e.clientY - r.top) / r.height) * DRAW_SIZE)];
  };
  let current: Stroke | null = null;
  cv.addEventListener('pointerdown', (e) => {
    if (strokes.length >= MAX_STROKES || pointCount() >= MAX_POINTS) return toast('That is plenty of drawing! Undo or clear to keep going.');
    cv.setPointerCapture(e.pointerId);
    current = [pos(e)];
    strokes.push(current);
    redraw();
    onChange();
  });
  cv.addEventListener('pointermove', (e) => {
    if (!current || pointCount() >= MAX_POINTS) return;
    const p = pos(e);
    const last = current[current.length - 1];
    if (Math.hypot(p[0] - last[0], p[1] - last[1]) < 4) return;
    current.push(p);
    redraw();
  });
  const end = () => (current = null);
  cv.addEventListener('pointerup', end);
  cv.addEventListener('pointercancel', end);
  $('#undo')!.addEventListener('click', () => {
    strokes.pop();
    redraw();
    onChange();
  });
  $('#clear')!.addEventListener('click', () => {
    strokes = [];
    redraw();
    onChange();
  });
  redraw();
}

// ---- guess phase

function slotsFor(s: ClientState) {
  const list: { key: SlotKey; label: string; cap: number; cls: string }[] = [];
  for (let i = 0; i < s.layout.pairSlots; i++) list.push({ key: `pair:${i}`, label: `🤝 Partnership ${i + 1}`, cap: 2, cls: 'pair' });
  if (s.layout.noneSlot) list.push({ key: 'none', label: '🙅 Odd one out (no partner)', cap: 1, cls: 'none' });
  return list;
}

/** Everyone - including you - starts in the pool. Your own partnership is just one of the partnership slots. */
function initGuess(s: ClientState) {
  const key = `${s.code}|${s.round}`;
  if (key === initKey) return;
  initKey = key;
  selected = null;
  confirmIncomplete = false;
  place = {};
  s.participantIds.forEach((id) => (place[id] = 'pool'));
  const g = s.you!.guess; // restores a saved draft after a refresh / reconnect
  if (g) {
    if (g.none && g.none in place) place[g.none] = 'none';
    g.pairs.forEach((p, i) => p.forEach((id) => id in place && (place[id] = `pair:${i}`)));
  }
}

function currentGuess(s: ClientState): GuessInput {
  const inSlot = (k: SlotKey) => Object.keys(place).filter((id) => place[id] === k);
  return {
    none: inSlot('none')[0] ?? null,
    pairs: Array.from({ length: s.layout.pairSlots }, (_, i) => inSlot(`pair:${i}`)),
  };
}

function saveDraft(s: ClientState) {
  socket.emit('player:guess', { guess: currentGuess(s), final: false });
}

/** The thing you drag: a player's name together with the hint (word or drawing) they gave. */
function cardHTML(s: ClientState, id: string) {
  const p = byId(s, id);
  const h = s.hints.find((x) => x.playerId === id) ?? null;
  const you = id === s.you!.id;
  return `<div class="pcard ${selected === id ? 'sel' : ''}" data-chip="${esc(id)}" style="--pc:${p?.color ?? '#888'}"><div class="pc-who"><i>${p?.emoji ?? '❔'}</i><span>${esc(p?.name ?? '?')}</span></div><div class="pc-body ${h?.kind ?? 'none'}">${hintBody(h)}</div>${you ? '<b class="you-tag">you</b>' : ''}<button class="zoom" data-zoom="${esc(id)}" aria-label="Enlarge">🔍</button></div>`;
}

function place_(s: ClientState, id: string, slot: SlotKey): boolean {
  if (place[id] === slot) return true;
  if (slot !== 'pool') {
    const def = slotsFor(s).find((x) => x.key === slot);
    if (!def) return false;
    const occupants = Object.keys(place).filter((x) => place[x] === slot);
    if (occupants.length >= def.cap) {
      if (def.cap === 1) place[occupants[0]] = 'pool'; // swap: the old card goes back to the pool
      else {
        toast('That partnership is full — move someone out first.');
        return false;
      }
    }
  }
  place[id] = slot;
  selected = null;
  confirmIncomplete = false;
  saveDraft(s);
  return true;
}

function guessView(s: ClientState): View {
  const you = s.you!;
  initGuess(s);
  const locked = you.guessSubmitted;
  const kicker = `Round ${s.round} · your word: ${you.word ?? ''}`;
  if (locked) {
    return {
      header: header(kicker, 'Guesses locked in ✓', { timer: true }),
      main: centerView('🔒', 'Sit tight!', 'Waiting for everyone else to finish guessing…'),
    };
  }
  const slots = slotsFor(s);
  const slotHTML = (d: (typeof slots)[number]) => {
    const items = Object.keys(place).filter((id) => place[id] === d.key);
    return `<div class="slot ${d.cls}" data-slot="${d.key}"><div class="slot-label">${d.label}</div><div class="slot-items">${items.map((id) => cardHTML(s, id)).join('') || `<span class="ph">drag ${d.cap === 2 ? 'two cards' : 'a card'} here</span>`}</div></div>`;
  };
  const poolIds = s.participantIds.filter((id) => place[id] === 'pool');
  const unplaced = poolIds.length;
  return {
    header: header(kicker, 'Who is partnered?', { sub: 'Drag each card into a partnership — find yours too! (or tap a card, then a slot)', timer: true }),
    main: `<div class="slot pool" data-slot="pool"><div class="slot-label">Players &amp; their hints · 🔍 to enlarge</div><div class="slot-items">${poolIds.map((id) => cardHTML(s, id)).join('') || '<span class="ph">everyone is placed ✓</span>'}</div></div>
      ${slots.map(slotHTML).join('')}`,
    footer: `<button class="btn ${confirmIncomplete ? '' : 'green'}" id="submit">${unplaced && confirmIncomplete ? `${unplaced} not placed — tap again to submit anyway` : 'Submit guesses'}</button>`,
    after: () => {
      app.querySelectorAll<HTMLElement>('.zoom').forEach((el) =>
        el.addEventListener('click', (e) => {
          e.stopPropagation();
          const h = s.hints.find((x) => x.playerId === el.dataset.zoom);
          if (h) openHintModal(h, s);
        }),
      );
      app.querySelectorAll<HTMLElement>('[data-slot]').forEach((el) =>
        el.addEventListener('click', (e) => {
          if (swallowClick || (e.target as HTMLElement).closest('.pcard') || !selected) return;
          if (place_(s, selected, el.dataset.slot!)) render(true);
        }),
      );
      setupDrag(s);
      $('#submit')!.addEventListener('click', () => {
        if (unplaced && !confirmIncomplete) {
          confirmIncomplete = true;
          return render(true);
        }
        socket.emit('player:guess', { guess: currentGuess(s), final: true }, (res) => {
          if (!res.ok) toast(res.error);
        });
      });
    },
  };
}

let swallowClick = false;

/** Pointer-based drag and drop (HTML5 drag events don't work on phones). A short tap just selects a card. */
function setupDrag(s: ClientState) {
  const main = $('main', app)!;
  let d: { id: string; el: HTMLElement; x: number; y: number; ghost: HTMLElement | null; scroller: number | null; lastY: number } | null = null;

  const slotAt = (x: number, y: number) => document.elementFromPoint(x, y)?.closest<HTMLElement>('[data-slot]') ?? null;
  const highlight = (target: HTMLElement | null) => {
    app.querySelectorAll('.slot.over').forEach((e) => e.classList.remove('over'));
    target?.classList.add('over');
  };
  const stop = () => {
    if (d?.scroller) clearInterval(d.scroller);
    d?.ghost?.remove();
    d?.el.classList.remove('dragging');
    highlight(null);
    d = null;
  };

  app.querySelectorAll<HTMLElement>('.pcard').forEach((card) => {
    card.addEventListener('pointerdown', (e) => {
      if ((e.target as HTMLElement).closest('.zoom')) return;
      card.setPointerCapture(e.pointerId);
      d = { id: card.dataset.chip!, el: card, x: e.clientX, y: e.clientY, ghost: null, scroller: null, lastY: e.clientY };
    });
    card.addEventListener('pointermove', (e) => {
      if (!d) return;
      d.lastY = e.clientY;
      if (!d.ghost) {
        if (Math.hypot(e.clientX - d.x, e.clientY - d.y) < 8) return;
        d.ghost = card.cloneNode(true) as HTMLElement;
        d.ghost.classList.add('ghost');
        document.body.appendChild(d.ghost);
        card.classList.add('dragging');
        // scroll the screen when dragging near the top/bottom edge
        d.scroller = window.setInterval(() => {
          if (!d) return;
          const r = main.getBoundingClientRect();
          if (d.lastY < r.top + 60) main.scrollTop -= 10;
          else if (d.lastY > r.bottom - 60) main.scrollTop += 10;
        }, 16);
      }
      d.ghost.style.left = e.clientX + 'px';
      d.ghost.style.top = e.clientY + 'px';
      highlight(slotAt(e.clientX, e.clientY));
    });
    const up = (e: PointerEvent) => {
      if (!d) return;
      const wasDrag = !!d.ghost;
      const { id } = d;
      const target = wasDrag ? slotAt(e.clientX, e.clientY) : null;
      stop();
      swallowClick = true;
      setTimeout(() => (swallowClick = false), 60);
      if (wasDrag) {
        if (target) place_(s, id, target.dataset.slot!);
      } else {
        selected = selected === id ? null : id;
      }
      render(true);
    };
    card.addEventListener('pointerup', up);
    card.addEventListener('pointercancel', () => {
      stop();
      render(true);
    });
  });
}

// ---- reveal / standings / game over

function revealView(s: ClientState): View {
  const you = s.you!;
  const e = s.reveal[s.reveal.length - 1];
  let msg = '';
  if (e) {
    const mineId = you.id;
    if (e.kind === 'pair' && (e.aId === mineId || e.bId === mineId)) {
      const other = e.aId === mineId ? e.bId : e.aId;
      const iFound = e.aId === mineId ? e.aFoundB : e.bFoundA;
      const theyFound = e.aId === mineId ? e.bFoundA : e.aFoundB;
      if (iFound && theyFound) msg = `<p class="good-msg">You and ${esc(nameOf(s, other))} found each other! +1</p>`;
      else if (iFound) msg = `<p class="bad-msg">You picked ${esc(nameOf(s, other))}, but they didn't pick you. No point.</p>`;
      else if (theyFound) msg = `<p class="bad-msg">${esc(nameOf(s, other))} picked you, but you didn't pick them. No point.</p>`;
      else msg = `<p class="bad-msg">You and ${esc(nameOf(s, other))} didn't find each other.</p>`;
    } else if (e.kind === 'odd' && e.aId === you.id) {
      msg = e.guesserIds.includes(you.id) ? `<p class="good-msg">You worked out you had no partner! +1</p>` : `<p class="bad-msg">You had no partner this round!</p>`;
    } else if (e.guesserIds.includes(mineId)) {
      msg = `<p class="good-msg">You spotted this one! +1</p>`;
    } else {
      msg = `<p class="bad-msg">You didn't get this one.</p>`;
    }
  }
  return { header: header(`Round ${s.round}`, 'The big reveal'), main: centerView('📺', 'Eyes on the big screen!', '', msg) };
}

function standingsView(s: ClientState): View {
  const you = s.you!;
  const mine = rankPlayers(s.players).find((p) => p.id === you.id)!;
  const d = s.roundDeltas?.[you.id] ?? 0;
  return {
    header: header(`Round ${s.round}`, 'Standings'),
    main: `<div class="center"><div class="delta ${d ? '' : 'zero'}">${d ? '+' + d + (d === 1 ? ' point' : ' points') : 'No points this round'}</div><div class="rank">${ordinal(mine.rank)}</div><h2>${mine.score} ${mine.score === 1 ? 'point' : 'points'}</h2><p>Next round starts in a moment.</p></div>`,
  };
}

function buildView(s: ClientState): View {
  const you = s.you!;
  const mePlayer = s.players.find((p) => p.id === you.id)!;

  if (['hint', 'guess', 'reveal', 'standings'].includes(s.phase) && !you.participating) {
    return {
      header: header(`Round ${s.round}`, 'Round in progress'),
      main: centerView('🍿', "You're in!", "You'll join in at the start of the next round. Watch the big screen until then."),
    };
  }

  switch (s.phase) {
    case 'lobby':
      return {
        header: header(`Room ${s.code}`, `You're in, ${esc(mePlayer.name)}!`),
        main: centerView(mePlayer.emoji, 'Waiting for the host…', 'The game will start soon. Look at the big screen.', chipsHTML(s)),
      };
    case 'hint':
      return hintView(s);
    case 'guess':
      return guessView(s);
    case 'reveal':
      return revealView(s);
    case 'standings':
      return standingsView(s);
    case 'gameOver': {
      const mine = rankPlayers(s.players).find((p) => p.id === you.id)!;
      const won = s.winnerIds.includes(you.id);
      return {
        header: header('Game over', won ? 'You win! 🏆' : `You placed ${ordinal(mine.rank)}`),
        main: centerView(won ? '🏆' : '🎉', `${mine.score} ${mine.score === 1 ? 'point' : 'points'}`, 'Thanks for playing! Look at the big screen for the final standings.'),
      };
    }
  }
  return { main: '' };
}

function viewKeyFor(s: ClientState): string {
  const y = s.you!;
  const base = `${s.phase}|${s.round}|${y.participating}`;
  switch (s.phase) {
    case 'lobby':
      return `${base}|${s.players.length}|${s.players.map((p) => p.connected).join('')}`;
    case 'hint':
      return `${base}|${y.hintSubmitted}`;
    case 'guess':
      return `${base}|${y.guessSubmitted}`;
    case 'reveal':
      return `${base}|${s.revealIndex}`;
    default:
      return base;
  }
}

function render(force = false) {
  if (!me || !state || !state.you) {
    const key = 'join|' + closedMsg + joinError;
    if (!force && key === viewKey) return;
    viewKey = key;
    paint(joinView(), false);
    return;
  }
  const s = state;
  const key = viewKeyFor(s);
  if (!force && key === viewKey) return;
  const [phase, round] = key.split('|');
  if (phase !== viewKey.split('|')[0] || round !== viewKey.split('|')[1]) {
    if (phase === 'hint' && viewKey.split('|')[1] !== round) {
      typed = '';
      strokes = [];
      hintMode = 'type';
    }
  }
  viewKey = key;
  paint(buildView(s), force);
}

function paint(v: View, keepScroll: boolean) {
  const scroll = $('main', app)?.scrollTop ?? 0;
  app.innerHTML = `<header>${v.header ?? ''}</header><main>${v.main}</main><footer>${v.footer ?? ''}</footer>`;
  if (keepScroll) $('main', app)!.scrollTop = scroll;
  v.after?.();
  if (state) syncState(state);
}

render();
