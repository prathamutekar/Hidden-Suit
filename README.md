# Hidden Suit

A browser-based multiplayer **shedding card game** for 2–10 players, built with plain HTML, CSS and JavaScript. It has no frameworks, no build step and no server of its own (online rooms use Firebase's free Realtime Database).

Everybody tries to get rid of their cards. When you can't follow the active suit, you secretly dump **every** card of one suit face down, and the round ends on the spot. The player holding the highest card of the active suit has to collect everything, including the hidden cards only they will ever see.

---

## How to run

1. Download or clone this folder.
2. Double-click **`index.html`** (or drag it into any modern browser).

That's it. No server or install is needed. It also works when served from any static web server (e.g. XAMPP's `htdocs`).

> **Why no ES modules?** Browsers refuse to load `<script type="module">` from `file://` pages. The spec requires the game to run by simply opening `index.html`, so each file is a normal script that adds its functions to a single global namespace, `window.HiddenSuit`. Responsibilities are still split into separate files exactly like modules.

### Game modes

| Mode | Description |
|---|---|
| **Pass & Play** | All players share one device. Before each turn a privacy screen asks for the device to be passed; the hand only appears after **Reveal My Hand**, and it is hidden again right after **Confirm Move**. |
| **AI Practice** | You (Player 1) against 1–9 computer opponents. |
| **Online Room** | Each player uses their own phone/browser, synced through Firebase. Needs internet and a web address (GitHub Pages, any static host, or a local server); disabled on `file://`. |

### Online Room (Firebase Realtime Database)

Online play uses the free Firebase **Spark** plan, so there's no server of your own. The site itself can be hosted anywhere static, e.g. **GitHub Pages**.

**One-time Firebase setup** (already done for the project in `js/firebase-config.js`):

1. Create a project at [console.firebase.google.com](https://console.firebase.google.com).
2. **Realtime Database** → Create database (pick a nearby location) → start in *locked mode*.
3. **Rules** tab → paste the contents of `firebase-rules.json` → **Publish**.
4. **Authentication** → Sign-in method → enable **Anonymous**.
5. **Project settings** → Your apps → add a **Web app** → copy its `firebaseConfig` into `js/firebase-config.js` (these values are public by design; the rules protect the data).

**Publishing on GitHub Pages:** push this folder to a GitHub repository, then **Settings → Pages → Deploy from a branch → main / (root)**. Your game will be at `https://USERNAME.github.io/REPO-NAME/`. No build step is needed.

**Playing:**

1. Everyone opens the game's web address on their own phone.
2. Host: choose **Online Room**, enter a name, tap **Create Room**. Share the 4-letter code or use **Copy invite link**.
3. Others: choose **Online Room**, enter a name and the code (an invite link fills it in), tap **Join Room**.
4. The host can add computer players (**Add Bot**) or remove players, then taps **Start Game** (2–10 players).

How it works and its limits:

- The **host's browser runs the real `GameEngine`** and is authoritative. Guests send moves into the room's `inbox`; the host applies them and writes each guest a bundle containing the public state plus **only their own** private view.
- The security rules (`firebase-rules.json`) make sure a phone can read only its own private view, can only send moves as itself, and that only the host can start the game, publish state or close the room.
- Game states are stored as JSON strings because Firebase drops empty arrays and `null` values.
- **The host must keep the page open.** If the host refreshes, the game resumes from a host-only snapshot. Guests can refresh and rejoin too. Sign-in and session are per browser tab, so several tabs on one computer can act as different players for testing.
- The host's device holds the full secret state. That is fine among friends, but a determined host could inspect it.
- Rooms older than 24 hours are deleted automatically the next time someone creates a room.

---

## Rules

1. A standard 52-card deck is shuffled and **all** cards are dealt (hands may be uneven).
2. Players sit in a fixed circular order. A random player starts the first round.
3. **Active suit.** The round starter plays **any** card; its suit becomes the active suit.
4. **Following.** Each following player who holds the active suit **must** play exactly one card of it (any one).
5. **Hidden suit.** A player with **no** card of the active suit chooses one suit they hold and secretly plays **all** cards of that suit face down. Opponents never learn the suit, the cards or how many.
6. **The round ends immediately** after a hidden play. Nobody after that player plays.
7. **Broken round.** The highest card of the *original* active suit collects **every** card of the round, hidden cards included. Only the collector (and the hider) know the hidden cards. The collector starts the next round.
8. **Clean round.** If everyone followed suit, nobody collects: all the round's cards are **permanently removed**. The highest active-suit card's owner starts the next round.
9. **Finishing.** A player whose hand is empty *after the round has been resolved* finishes (#1, #2, …) and leaves the rotation.
10. **Loser.** When only one player still holds cards, the game ends and that player loses.

Rank order: `2 < 3 < 4 < 5 < 6 < 7 < 8 < 9 < 10 < J < Q < K < A`.

### Interpretations of cases the spec did not cover

- **The next starter just finished.** If the player with the highest card emptied their hand in that round, the **next active player clockwise** leads the next round.
- **Several players finish in the same round.** They are ranked in the order they played in that round.
- **Nobody is left.** If every remaining player empties their hand in the same clean round, the game ends with **no loser**.
- **Hidden-card count and "Cards remaining".** The public view never shows how many hidden cards were played. Seat card counts are still shown (the spec asks for them), so an attentive player could work the number out from count changes. Set `SHOW_PUBLIC_HIDDEN_COUNT: true` in `js/utils.js` if you prefer to show the number openly.

---

## Project structure

```
Hidden Suit/
├── index.html          Page layout, overlays, rules text
├── css/
│   └── style.css       Table, cards, responsive layout, animations
├── js/
│   ├── utils.js        Namespace, config (DEBUG_MODE), constants, state names, helpers, EventEmitter
│   ├── deck.js         createDeck(), shuffleDeck(), dealCards(), cardFromId()
│   ├── player.js       createPlayer() and hand helpers
│   ├── game.js         GameEngine: ALL rules and the state machine (no DOM code)
│   ├── ai.js           AI decision-making using only legitimately known info
│   ├── sound.js        Web Audio sound effects (no audio files)
│   ├── ui.js           Rendering only: turns view data into HTML
│   ├── tests.js        Automated rule tests + scenario definitions
│   ├── debug.js        Developer testing panel (DEBUG_MODE only)
│   ├── firebase-config.js  Firebase project settings (public values)
│   ├── network.js      Online: Firebase rooms, RemoteEngine (guest), HostSession (host)
│   ├── online.js       Online: create/join room, lobby, listeners, resume
│   └── main.js         Controller: wires engine ⇄ UI ⇄ AI, pass-and-play flow, settings
├── firebase-rules.json Security rules to paste into Firebase → Realtime Database → Rules
└── tests/
    └── run-tests.js    Optional Node.js runner for js/tests.js
```

---

## How the game engine works

### Data model

```js
card   = { id: "AH", rank: "A", value: 14, suit: "hearts", symbol: "♥", color: "red" }
player = { id: 0, name: "Player 1", type: "human", hand: [], status: "active", finishPosition: null }
```

Cards are always identified by their unique `id` and are frozen objects.

### One-way data flow

```
UI click ──► engine.dispatch(action)
                 ├─ validateMove(action)   → error message or null
                 ├─ applyMove(action)      → changes the secret state
                 ├─ validateGameIntegrity()
                 └─ emit('stateChanged')
                          │
UI  ◄── renderGame(engine.getPublicState(), engine.getPrivateView(viewerId))
```

Actions:

```js
{ type: 'PLAY_CARD',        playerId, cardId }
{ type: 'PLAY_HIDDEN_SUIT', playerId, suit }       // the engine takes ALL cards of that suit
{ type: 'CONTINUE' }                                // start the next round
{ type: 'ACK_NOTICES',      playerId }              // mark private notices as read
```

### Public vs private views

- `getPublicState()` contains seat card counts, visible round cards, a face-down marker for hidden plays, the public log and results. It **never** includes hidden cards.
- `getPrivateView(playerId)` contains that player's hand, their legal cards, hidden-suit options and private notices (for example, the hidden cards they just collected).

The UI and the AI only ever receive these two views.

### State machine (`HS.STATES`)

```
SETUP → ROUND_START → PLAYER_TURN → SELECT_CARD ───────────────┐
                                  ↘ SELECT_HIDDEN_SUIT          │ (everyone followed)
                                        │ (hidden play)         │
                                        ▼                       ▼
                               ROUND_RESOLUTION ◄──────────────┘
                                        ▼
                                 PLAYER_FINISHED
                                  ▼          ▼
                             NEXT_ROUND   GAME_OVER
                                  │ CONTINUE
                                  └──► ROUND_START
```

Every action checks the current state first, so for example no card can be played during `ROUND_RESOLUTION`, and normal card plays are rejected during `SELECT_HIDDEN_SUIT`.

### Validation

After every action `validateGameIntegrity()` asserts that:

- no card is duplicated,
- the total card count never changes and never exceeds 52,
- finished players hold no cards,
- discarded cards never return to a hand.

`validateMove()` rejects:

- cards the player doesn't hold,
- off-suit cards when the player can follow,
- suits the player doesn't hold,
- partial hidden plays,
- plays after the round has ended,
- turns taken by finished players or by the wrong player.

---

## Testing

- **In the browser:** set `DEBUG_MODE: true` in `js/utils.js` and reload. A debug panel appears with:
  - *Run all rule tests*
  - *Verify live game* (exactly 52 cards, no duplicates)
  - scenario loaders with forced hands (Scenario A, Scenario B, second test, player reaching 0, game over)
  - a seeded deterministic deck
  - *Force starter* and *Force lead suit*
- **From a terminal (optional):** `node tests/run-tests.js`

Implemented tests include the spec's exact scenarios:

- **Scenario A (§45):** 6♥, 10♥, K♥, then P4 secretly plays A♦ 4♦. The round ends, P3 collects all five cards and leads next. P1, P2, P4 and the public view never contain A♦/4♦.
- **Scenario B (§46):** 6♥, K♥, J♥, 9♥ is a clean round. All four cards are discarded, nobody collects, and P2 leads next.
- **Second test (§47):** 7♣, J♣, 2♣, then P4 hides A♥ 5♥. P2 collects and leads. A duplicate 5♥ is rejected.
- A hidden play stops later players from acting.
- A player reaching 0 mid-round is only finished after resolution.
- Game over and loser detection.
- 300 full AI-vs-AI games (2–10 players) run with integrity checks after every move.

The debug panel shows only counts and state, never card identities. *Dump state to console* prints the secret state for development.

---

## How to add or improve the AI

`js/ai.js` exposes `chooseMove(publicState, privateView)` and returns a normal action object, which the controller passes to `engine.dispatch()`, so AI moves are validated exactly like human moves. The AI cannot cheat because it never receives the engine's secret state.

Current heuristics:

- **Leading:** play the lowest card of the suit opponents most likely still hold (13 − own cards − publicly removed cards). This makes a clean round likely and collecting unlikely.
- **Following:** play the highest card that stays *under* the current highest card. If every card beats it, play the highest when you're last (the round will be clean), otherwise the lowest.
- **Hidden suit:** dump the suit with the most cards (ties: higher total rank).

To make it smarter, add memory of public events (which visible cards each player collected, which players failed to follow which suit) and use it in `chooseLeadCard` / `chooseFollowCard`. Keep the rule: **only public info + own hand**.

---

## Online multiplayer design

The **Online Room** mode (`js/network.js`, `js/online.js`) follows the design below, with Firebase Realtime Database as the transport. To swap in WebSocket or WebRTC, replace the Firebase calls in `js/network.js`. The engine and UI stay the same.

```
Device A ──action──► Host device (runs GameEngine, authoritative)
                         │ validateMove → applyMove
                         ├──► every client: getPublicState()
                         └──► each client:  getPrivateView(thatPlayerId) only
```

1. Run one `GameEngine` on the host (or a server).
2. Clients send action objects (`PLAY_CARD`, `PLAY_HIDDEN_SUIT`, …) over WebSocket/WebRTC. The host must check that the sender really is `action.playerId`.
3. On `stateChanged`, the host sends everyone `getPublicState()` and sends each player **only their own** `getPrivateView()`. Hidden cards therefore reach only the hider and the collector.
4. On clients, replace the direct `engine.dispatch()` calls in `main.js` with "send to host", and render from the received views. `ui.js` needs no changes.

Never send full hands or hidden plays to other clients; the host keeps the authoritative state.

---

## Settings saved in localStorage

Number of players, game mode, player names, sound on/off and AI speed. Unfinished games are deliberately **not** saved.
