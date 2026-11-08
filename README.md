# Matchy Finderoo

A Jackbox-style party game. One laptop/TV shows the main screen, everyone else plays on their phone.

Everybody is secretly given a word, and **exactly one other player has the same word** – that's your partner. You each give the room a hint (one typed word, or a black-pen drawing) that your partner will recognize but nobody else should. Then you study everybody's hints and work out who is partnered with whom. With an odd number of players, one person has a word nobody else has – and no partner.

**How a round works**

1. **Hint** – each player sees their secret word and either types **one word** (spaces aren't allowed) or **draws** a picture (black pen only). Being too obvious is allowed – it just helps the other teams too.
2. **Guess** – all hints appear on the big screen and on every phone. Each player drags *other players' names* into slots:
   - **My partner** (1 slot)
   - **Partnership 1, 2, …** (2 names each) – guesses for the *other* pairs
   - **Has no partner** (only when the player count is odd)
   - names you haven't placed wait in the **Players** list
   
   On a phone you can also tap a name and then tap a slot.
3. **Reveal** – partnerships are revealed one by one on the big screen, with their word, both hints, whether the two partners found each other, and who spotted the partnership. The player with no partner comes last.
4. **Standings** – current standings, then straight into the next round (new partners, new words).

**Scoring**

- **+1 for finding your partner – but only if your partner also found you.** If either of you misses, neither of you gets it.
- **+1 for every other partnership you place exactly right.** No partial credit.
- **+1 for correctly naming the player with no partner.**

The game ends at the end of the round in which someone reaches **X points**, or after **X rounds** (chosen in the lobby; ties are allowed). At least **3 players** are needed.

## Run it locally

```bash
npm install
npm run build
npm start          # http://localhost:3000
```

Open `http://localhost:3000/host.html` on the laptop/TV. The lobby shows a QR code and room code; phones on the same Wi‑Fi can scan it (the QR code automatically uses your computer's LAN address, shown in the terminal as "On your network").

For development with hot reload: `npm run dev` (server on :3000, Vite on :5173 – open `http://localhost:5173/host.html`).

Other scripts: `npm run typecheck`, `npm run test:unit` (scoring rules), `npm run test:sim` (plays full bot games over real sockets), `npm test` (both).

## Settings (host lobby)

- Game ends when someone reaches **X points**, or after **X rounds**
- Max typed hint length (default 20 characters)
- Timers for hinting and guessing. Each can be set to **Unlimited** – the phase then ends when everybody is done, or when the host presses **Skip** (button or space bar).

Phases also end early as soon as every connected player has finished. When a guess timer runs out, each player's latest saved arrangement counts. Players who reconnect (refresh, lock their phone) rejoin automatically and keep their score, word and guesses. Players who join mid-round watch until the next round. If the host screen disconnects the game pauses, and the room is kept for 15 minutes.

## Adding words

Edit `server/words.ts` – it's a plain list of single words. Each round draws one word per partnership (no repeats until the list runs out).

## Deploy on Render (free tier)

Push this repo to GitHub, then in Render choose **New → Blueprint** and select the repo (it reads `render.yaml`), or create a **Web Service** manually with:

- Build command: `npm install --include=dev && npm run build`
- Start command: `npm start`
- Health check path: `/health`

Notes: the free tier sleeps after inactivity (first visit takes ~30–60s to wake up) and game rooms live in memory, so a restart ends any running game.

## Layout

```
shared/   types + socket event contracts shared by server and clients
server/   Express + socket.io: game state machine (game.ts), scoring rules (scoring.ts), word list (words.ts)
client/   Vite multi-page app: index.html (landing), host.html (big screen), play.html (phones)
test/     scoring unit tests + bot simulation
```

Built on the same stack as [multiplayer-eric](https://github.com/easton873/multiplayer-eric).
