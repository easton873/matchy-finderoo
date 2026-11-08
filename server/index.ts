import express from 'express';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { Server } from 'socket.io';
import type { ClientToServerEvents, ServerToClientEvents } from '../shared/types.js';
import { Room } from './game.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 3000);

const app = express();
const server = http.createServer(app);
const io = new Server<ClientToServerEvents, ServerToClientEvents>(server, {
  // Phones on flaky wifi: be patient before declaring them gone.
  pingInterval: 10000,
  pingTimeout: 20000,
});

const rooms = new Map<string, Room>();
const CODE_LETTERS = 'ABCDEFGHJKMNPQRSTUVWXYZ'; // no I, L, O: easy to read from a TV

function newCode(): string {
  for (let i = 0; i < 1000; i++) {
    let code = '';
    for (let j = 0; j < 4; j++) code += CODE_LETTERS[Math.floor(Math.random() * CODE_LETTERS.length)];
    if (!rooms.has(code)) return code;
  }
  throw new Error('no room codes left');
}

// ---------------------------------------------------------------- http

app.get('/health', (_req, res) => res.send('ok'));

// LAN addresses so a host opened at "localhost" can still show a QR code phones can reach.
app.get('/api/info', (_req, res) => {
  const ips: string[] = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const i of list ?? []) if (i.family === 'IPv4' && !i.internal) ips.push(i.address);
  }
  res.json({ ips, port: PORT });
});

const clientDir = path.resolve(__dirname, process.env.CLIENT_DIR ?? '../../client');
app.use(express.static(clientDir));

// ---------------------------------------------------------------- sockets

io.on('connection', (socket) => {
  let room: Room | null = null;
  let role: 'host' | 'player' | null = null;

  const bind = (r: Room, as: 'host' | 'player') => {
    room = r;
    role = as;
    socket.join(r.roomName);
  };

  socket.on('host:create', (cb) => {
    const code = newCode();
    const hostToken = randomBytes(16).toString('hex');
    const r = new Room(io, code, hostToken);
    r.onDestroy = () => rooms.delete(code);
    rooms.set(code, r);
    bind(r, 'host');
    r.attachHost(socket.id);
    cb({ ok: true, code, hostToken });
  });

  socket.on('host:resume', ({ code, hostToken }, cb) => {
    const r = rooms.get(String(code ?? '').toUpperCase());
    if (!r || r.hostToken !== hostToken) return cb({ ok: false, error: 'Room not found.' });
    bind(r, 'host');
    r.attachHost(socket.id);
    cb({ ok: true });
  });

  socket.on('player:join', ({ code, name, token }, cb) => {
    const r = rooms.get(String(code ?? '').trim().toUpperCase());
    if (!r) return cb({ ok: false, error: "We can't find that room. Check the code on the big screen." });
    const res = r.join(String(name ?? ''), token, socket.id);
    if (!res.ok) return cb(res);
    bind(r, 'player');
    (socket.data as { playerId?: string }).playerId = res.player.id;
    cb({ ok: true, token: res.player.token, playerId: res.player.id });
  });

  const asHost = (fn: (r: Room) => void) => () => {
    if (room && role === 'host') fn(room);
  };
  socket.on('host:settings', (p) => room && role === 'host' && room.updateSettings(p ?? {}));
  socket.on('host:start', asHost((r) => r.start()));
  socket.on('host:skip', asHost((r) => r.skip()));
  socket.on('host:playAgain', asHost((r) => r.playAgain()));
  socket.on('host:kick', (p) => room && role === 'host' && room.kick(String(p?.playerId)));

  const pid = () => (socket.data as { playerId?: string }).playerId;
  socket.on('player:hint', (input, cb) => {
    if (!room || role !== 'player' || !pid()) return;
    const err = room.submitHint(pid()!, input);
    cb?.(err ? { ok: false, error: err } : { ok: true });
  });
  socket.on('player:guess', (p, cb) => {
    if (!room || role !== 'player' || !pid()) return;
    const err = room.submitGuess(pid()!, p?.guess, !!p?.final);
    cb?.(err ? { ok: false, error: err } : { ok: true });
  });

  socket.on('disconnect', () => {
    if (!room) return;
    if (role === 'host') room.detachHost(socket.id);
    else room.disconnectPlayer(socket.id);
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n  Game server listening on http://localhost:${PORT}`);
  for (const list of Object.values(os.networkInterfaces())) {
    for (const i of list ?? []) if (i.family === 'IPv4' && !i.internal) console.log(`  On your network:  http://${i.address}:${PORT}`);
  }
  console.log('');
});
