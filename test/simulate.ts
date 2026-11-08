// End-to-end smoke test: boots the server, plays full games with bot players over real sockets, and checks
// the rules (hint validation, no leaks of words/pairings, scoring, reveal order, rejoin, both end modes).
import { spawn } from 'node:child_process';
import { io, type Socket } from 'socket.io-client';
import assert from 'node:assert/strict';
import type { ClientState, GuessInput } from '../shared/types.js';

const PORT = 3112;
const URL = `http://localhost:${PORT}`;
const server = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], {
  env: { ...process.env, PORT: String(PORT), TIMING_SCALE: '0.05' },
  stdio: ['ignore', 'pipe', 'inherit'],
});
const ready = new Promise<void>((res) => server.stdout!.on('data', (d) => String(d).includes('listening') && res()));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const emitAck = <T,>(s: Socket, ev: string, ...args: unknown[]) => new Promise<T>((res) => (s as any).emit(ev, ...args, res));

interface Bot {
  name: string;
  sock: Socket;
  state: ClientState | null;
  id: string;
  token: string;
}

async function newRoom() {
  const host = io(URL, { forceNew: true });
  const h = { sock: host, state: null as ClientState | null };
  host.on('state', (s) => (h.state = s));
  const created = await emitAck<{ ok: true; code: string }>(host, 'host:create');
  assert(created.ok);
  return { ...h, h, code: created.code };
}

async function addBots(code: string, names: string[], leaks: string[]) {
  const bots: Bot[] = [];
  for (const name of names) {
    const sock = io(URL, { forceNew: true });
    const bot: Bot = { name, sock, state: null, id: '', token: '' };
    sock.on('state', (s: ClientState) => {
      bot.state = s;
      const json = JSON.stringify(s);
      // nobody may learn the pairings or other players' words before the reveal
      if (s.phase === 'hint' || s.phase === 'guess') {
        if (/partnerOf|"pairs":\[\{|truth|wordOf/.test(json)) leaks.push(`${name}: pairing data in ${s.phase}`);
      }
      if (s.phase === 'hint' && s.hints.length) leaks.push(`${name}: hints visible during hint phase`);
    });
    const res = await emitAck<{ ok: true; token: string; playerId: string }>(sock, 'player:join', { code, name });
    assert(res.ok, 'join ok');
    bot.id = res.playerId;
    bot.token = res.token;
    bots.push(bot);
  }
  return bots;
}

/** A bot that knows the truth (via shared words) plays perfectly; used to check that scoring pays out. */
async function playGame(label: string, names: string[], settings: object, opts: { perfect?: boolean; checkHints?: boolean } = {}) {
  const leaks: string[] = [];
  const room = await newRoom();
  const bots = await addBots(room.code, names, leaks);
  const host = room.sock;
  const hs = () => room.h.state!;

  host.emit('host:settings', settings);
  await sleep(100);
  host.emit('host:start');
  await sleep(100);
  const N = names.length;
  if (N < 3) {
    assert.equal(hs().phase, 'lobby', 'cannot start with fewer than 3 players');
    return { leaks, room, bots };
  }

  const handled = new Set<string>();
  const t0 = Date.now();
  const sawPhases = new Set<string>();
  const words = new Map<string, Map<string, string>>(); // round -> playerId -> word
  let checkedStd = false;

  while (hs().phase !== 'gameOver') {
    assert(Date.now() - t0 < 60000, `${label}: timed out in phase ${hs().phase}`);
    const s = hs();
    sawPhases.add(s.phase);
    const key = `${s.round}:${s.phase}:${s.revealIndex}`;
    if (!handled.has(key)) {
      handled.add(key);
      if (s.phase === 'hint') {
        assert.equal(s.participantIds.length, N);
        assert.deepEqual(s.layout, { pairSlots: Math.floor(N / 2), noneSlot: N % 2 === 1 });
        const round = new Map<string, string>();
        for (const b of bots) {
          await sleep(5);
          assert(b.state!.you!.word, `${b.name} has a word`);
          round.set(b.id, b.state!.you!.word!);
        }
        words.set(String(s.round), round);
        // exactly one pair per word, and the odd player has a unique word
        const counts = new Map<string, number>();
        for (const w of round.values()) counts.set(w, (counts.get(w) ?? 0) + 1);
        assert([...counts.values()].every((n) => n <= 2), 'at most 2 players share a word');
        assert.equal([...counts.values()].filter((n) => n === 1).length, N % 2, 'odd count -> exactly one unpaired word');

        if (!checkedStd) {
          checkedStd = true;
          // hint validation: spaces, empty, too long, double submit, bad strokes
          const b0 = bots[0];
          assert.equal((await emitAck<{ ok: boolean }>(b0.sock, 'player:hint', { kind: 'text', text: 'two words' })).ok, false, 'spaces rejected');
          assert.equal((await emitAck<{ ok: boolean }>(b0.sock, 'player:hint', { kind: 'text', text: ' ' })).ok, false, 'empty rejected');
          assert.equal((await emitAck<{ ok: boolean }>(b0.sock, 'player:hint', { kind: 'text', text: 'x'.repeat(200) })).ok, false, 'too long rejected');
          assert.equal((await emitAck<{ ok: boolean }>(b0.sock, 'player:hint', { kind: 'draw', strokes: [] })).ok, false, 'empty drawing rejected');
          assert.equal((await emitAck<{ ok: boolean }>(b0.sock, 'player:hint', { kind: 'bogus' })).ok, false, 'garbage rejected');
          // a hint equal to the word is allowed
          const own = await emitAck<{ ok: boolean }>(b0.sock, 'player:hint', { kind: 'text', text: b0.state!.you!.word! });
          assert(own.ok, 'hint identical to the word is NOT blocked');
          assert.equal((await emitAck<{ ok: boolean }>(b0.sock, 'player:hint', { kind: 'text', text: 'again' })).ok, false, 'double submit rejected');
          // drawing with out-of-range numbers is clamped
          const d = await emitAck<{ ok: boolean }>(bots[1].sock, 'player:hint', { kind: 'draw', strokes: [[[5, 5], [99999, -50], [300, 300]]] });
          assert(d.ok, 'drawing accepted');
          for (let i = 2; i < bots.length; i++) bots[i].sock.emit('player:hint', { kind: 'text', text: `hint${i}` });
        } else {
          bots.forEach((b, i) => b.sock.emit('player:hint', { kind: 'text', text: `hint${i}` }));
        }
      } else if (s.phase === 'guess') {
        await sleep(30);
        assert.equal(s.hints.length, N, 'all hints visible');
        const draw = s.hints.find((h) => h.kind === 'draw');
        if (s.round === 1 && opts.checkHints) {
          assert(draw && draw.strokes![0].every(([x, y]) => x >= 0 && x <= 1000 && y >= 0 && y <= 1000), 'strokes clamped');
          const mine = bots[0].state!.hints.find((h) => h.playerId === bots[0].id)!;
          assert.equal(mine.text, bots[0].state!.you!.word, 'own hint shown');
        }
        // pairing is derived from words: players sharing a word are partners
        const round = words.get(String(s.round)) ?? new Map<string, string>(); // empty if the timer outran the bot (timeout scenario)
        const partnerOf = (id: string) => [...round.entries()].find(([o, w]) => o !== id && w === round.get(id))?.[0] ?? null;
        const unpaired = bots.find((b) => partnerOf(b.id) === null)?.id ?? null;
        const pairsAll: string[][] = [];
        for (const b of bots) {
          const p = partnerOf(b.id);
          if (p && b.id < p) pairsAll.push([b.id, p]);
        }
        for (const b of bots) {
                    const layout = s.layout;
          let guess: GuessInput;
          if (opts.perfect) {
            // everyone (including the odd one out) places every real partnership and names the unpaired player
            guess = { pairs: pairsAll.slice(0, layout.pairSlots), none: layout.noneSlot ? unpaired : null };
          } else {
            guess = { pairs: [], none: null };
          }
          if (b === bots[0] && s.round === 1 && s.settings.timers.guess === 0) {
            // validation: unknown players, the same player twice, too many partnerships
            const x = bots[1].id;
            const y = bots[2].id;
            const bad1 = await emitAck<{ ok: boolean }>(b.sock, 'player:guess', { guess: { pairs: [['nobody', x]], none: null }, final: true });
            assert.equal(bad1.ok, false, 'unknown player rejected');
            const bad2 = await emitAck<{ ok: boolean }>(b.sock, 'player:guess', { guess: { pairs: [[x, y], [x, b.id]], none: null }, final: true });
            assert.equal(bad2.ok, false, 'same player in two slots rejected');
            const tooMany = Array.from({ length: layout.pairSlots + 1 }, () => [x, y]);
            const bad3 = await emitAck<{ ok: boolean }>(b.sock, 'player:guess', { guess: { pairs: tooMany, none: null }, final: true });
            assert.equal(bad3.ok, false, 'too many partnerships rejected');
            // placing yourself is fine, and a saved draft survives (state echo)
            const dr = await emitAck<{ ok: boolean }>(b.sock, 'player:guess', { guess: { pairs: [[b.id, x]], none: null }, final: false });
            assert(dr.ok, 'can place yourself in a partnership');
            await sleep(30);
            assert.deepEqual(b.state!.you!.guess!.pairs, [[b.id, x]], 'draft saved and echoed');
          }
          const r = await emitAck<{ ok: boolean; error?: string }>(b.sock, 'player:guess', { guess, final: true });
          if (s.settings.timers.guess > 0) continue; // timed scenario: the phase may already be over, which is fine
          assert(r.ok, `guess accepted: ${r.error}`);
          const again = await emitAck<{ ok: boolean }>(b.sock, 'player:guess', { guess, final: true });
          assert.equal(again.ok, false, 'cannot change a submitted guess');
        }
      } else if (s.phase === 'reveal' && s.revealIndex === 0) {
        // words only now revealed
        assert(s.reveal[0].word);
      }
      if (s.phase === 'standings') {
        const sumDeltas = Object.values(s.roundDeltas!).reduce((a, b) => a + b, 0);
        if (opts.perfect) {
          // everyone perfect: each real pair scores 1 each (mutual) = 2P; every paired player also places the other
          // P-1 pairs, and the odd player places all P; and when N is odd every player (odd one included) names the odd one.
          const P = Math.floor(N / 2);
          const expected = 2 * P + 2 * P * (P - 1) + (N % 2 ? P + N : 0);
          assert.equal(sumDeltas, expected, 'perfect round total');
        } else {
          assert.equal(sumDeltas, 0, 'empty guesses score nothing');
        }
      }
    }
    await sleep(15);
  }
  sawPhases.add('gameOver');
  for (const ph of ['reveal', 'standings', 'gameOver']) assert(sawPhases.has(ph), `${label}: saw ${ph}`);
  if (hs().settings.timers.hint === 0) for (const ph of ['hint', 'guess']) assert(sawPhases.has(ph), `${label}: saw ${ph}`);
  assert.deepEqual(leaks, [], `${label}: no leaks`);
  return { leaks, room, bots };
}

async function main() {
  await ready;

  // ---- 4 players (even), rounds mode, perfect play
  {
    const { room } = await playGame('even/rounds', ['Ann', 'Bo', 'Cy', 'Di'], { endMode: 'rounds', target: 2, timers: { hint: 0, guess: 0 } }, { perfect: true, checkHints: true });
    assert.equal(room.h.state!.round, 2, 'played 2 rounds');
    assert(room.h.state!.players.every((p) => p.score > 0), 'everyone scored with perfect play');
    // play again resets
    room.sock.emit('host:playAgain');
    await sleep(100);
    assert.equal(room.h.state!.phase, 'lobby');
    assert(room.h.state!.players.every((p) => p.score === 0));
    console.log('even/rounds ok - scores:', room.h.state!.players.length);
  }

  // ---- 5 players (odd) perfect play, points mode
  {
    const { room } = await playGame('odd/points', ['A', 'B', 'C', 'D', 'E'], { endMode: 'points', target: 5, timers: { hint: 0, guess: 0 } }, { perfect: true });
    const top = Math.max(...room.h.state!.players.map((p) => p.score));
    assert(top >= 5, 'points target reached');
    console.log('odd/points ok - ended after', room.h.state!.round, 'rounds, top score', top);
  }

  // ---- 3 players, nobody guesses: timers expire by themselves, zero points, rounds mode ends
  {
    const { room } = await playGame('three/timeout', ['X', 'Y', 'Z'], { endMode: 'rounds', target: 1, timers: { hint: 1, guess: 1 } }, { perfect: false });
    assert(room.h.state!.players.every((p) => p.score === 0));
    console.log('three/timeout ok');
  }

  // ---- fewer than 3 players can't start; late joiner spectates; rejoin keeps identity
  {
    await playGame('too-few', ['P', 'Q'], {}, {});
    const leaks: string[] = [];
    const room = await newRoom();
    const bots = await addBots(room.code, ['R', 'S', 'T'], leaks);
    room.sock.emit('host:settings', { endMode: 'rounds', target: 1, timers: { hint: 0, guess: 0 } });
    room.sock.emit('host:start');
    await sleep(150);
    assert.equal(room.h.state!.phase, 'hint');
    const late = await addBots(room.code, ['Late'], leaks);
    await sleep(100);
    assert.equal(late[0].state!.you!.participating, false, 'late joiner spectates');
    assert.equal(late[0].state!.you!.word, null, 'spectator sees no word');
    assert.equal(room.h.state!.participantIds.length, 3);
    // rejoin with token keeps identity and word
    const word = bots[0].state!.you!.word;
    bots[0].sock.disconnect();
    await sleep(50);
    const sock = io(URL, { forceNew: true });
    sock.on('state', (st: ClientState) => (bots[0].state = st));
    const r = await emitAck<{ ok: boolean; playerId: string }>(sock, 'player:join', { code: room.code, name: 'whatever', token: bots[0].token });
    assert(r.ok && r.playerId === bots[0].id, 'rejoin keeps identity');
    await sleep(80);
    assert.equal(bots[0].state!.you!.word, word, 'rejoin keeps word');
    // duplicate names and bad room codes
    assert.equal((await emitAck<{ ok: boolean }>(io(URL, { forceNew: true }), 'player:join', { code: room.code, name: 'r' })).ok, false, 'duplicate name');
    assert.equal((await emitAck<{ ok: boolean }>(io(URL, { forceNew: true }), 'player:join', { code: 'ZZZZ', name: 'x' })).ok, false, 'bad code');
    console.log('lobby/rejoin/spectator ok');
  }

  console.log('\nALL CHECKS PASSED');
}

main()
  .catch((e) => {
    console.error('\nFAILED:', e);
    process.exitCode = 1;
  })
  .finally(() => {
    server.kill();
    setTimeout(() => process.exit(), 100);
  });
