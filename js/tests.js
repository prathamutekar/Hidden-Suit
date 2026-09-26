/*
 * tests.js
 * ---------------------------------------------------------------------------
 * PHASE 13 — Automated rule tests.
 *
 * These run in the browser from the debug panel (DEBUG_MODE = true) and also
 * from the command line:   node tests/run-tests.js
 *
 * Every scenario from the specification is implemented here exactly:
 *   - Scenario A  (section 45): hidden Diamonds, P3 collects with K♥
 *   - Scenario B  (section 46): clean round, P2 starts with K♥
 *   - Second test (section 47): hidden Hearts, P2 collects with J♣, no duplicates
 */
'use strict';

(function (HS) {
  const A = HS.ACTIONS;
  const S = HS.STATES;

  /* ------------------------------------------------------------------------
   * Scenario definitions (also used by the debug panel "Load scenario" buttons)
   * --------------------------------------------------------------------- */
  const SCENARIOS = {
    brokenA: {
      label: 'Scenario A — broken round (spec §45)',
      players: 4,
      starterId: 0,
      hands: [
        ['6H', '2C', '3S'],
        ['10H', '4C', '5S'],
        ['KH', '6C', '7S'],
        ['AD', '4D', '8C', '9S']     // P4 has NO hearts
      ]
    },
    cleanB: {
      label: 'Scenario B — clean round (spec §46)',
      players: 4,
      starterId: 0,
      hands: [
        ['6H', '2C'],
        ['KH', '3C'],
        ['JH', '4C'],
        ['9H', '5C']
      ]
    },
    brokenSecond: {
      label: 'Second test — hidden Hearts (spec §47)',
      players: 4,
      starterId: 0,
      hands: [
        ['7C', '2D'],
        ['JC', '3D'],
        ['2C', '4D'],
        ['AH', '5H', '9S']           // P4 has NO clubs; only ONE 5♥ can exist
      ]
    },
    finishEdge: {
      label: 'Player reaches 0 mid-round',
      players: 3,
      starterId: 0,
      hands: [
        ['7H'],
        ['9H', '2S', '8S'],
        ['3H', '4S', '5S']
      ]
    },
    gameOver: {
      label: 'Game over (2 players)',
      players: 2,
      starterId: 0,
      hands: [
        ['5H'],
        ['3H', '9S']
      ]
    }
  };

  /** Builds and starts an engine for one of the scenarios above. */
  function createScenarioGame(key, playerType) {
    const scenario = SCENARIOS[key];
    const engine = new HS.GameEngine();
    const players = [];
    for (let i = 0; i < scenario.players; i++) {
      players.push({ name: 'P' + (i + 1), type: playerType || 'human' });
    }
    engine.initializeGame({ players: players, hands: scenario.hands, starterId: scenario.starterId });
    engine.startGame();
    return engine;
  }

  /* ------------------------------------------------------------------------
   * Tiny test harness
   * --------------------------------------------------------------------- */
  function runTest(name, fn) {
    const messages = [];
    let passed = true;
    const check = function (condition, message) {
      if (!condition) { passed = false; messages.push('✗ ' + message); }
    };
    try {
      fn(check);
    } catch (err) {
      passed = false;
      messages.push('✗ Exception: ' + err.message);
    }
    return { name: name, passed: passed, messages: messages };
  }

  const play = (engine, playerId, cardId) => engine.dispatch({ type: A.PLAY_CARD, playerId: playerId, cardId: cardId });
  const hide = (engine, playerId, suit, cardIds) => engine.dispatch({ type: A.PLAY_HIDDEN_SUIT, playerId: playerId, suit: suit, cardIds: cardIds });
  const handIds = (engine, playerId) => engine.getPrivateView(playerId).hand.map(function (c) { return c.id; });
  const hasIds = (list, ids) => ids.every(function (id) { return list.indexOf(id) !== -1; });

  /** True if the serialized view mentions any of the given cards (by id or label). */
  function leaksCards(view, cardIds) {
    const json = JSON.stringify(view);
    return cardIds.some(function (id) {
      const card = HS.deck.cardFromId(id);
      return json.indexOf('"id":"' + id + '"') !== -1 || json.indexOf(card.rank + card.symbol) !== -1;
    });
  }

  /* ------------------------------------------------------------------------
   * The tests
   * --------------------------------------------------------------------- */
  const TESTS = [
    ['Deck has exactly 52 unique cards', function (check) {
      const deck = HS.deck.createDeck();
      check(deck.length === 52, 'deck length is ' + deck.length);
      check(new Set(deck.map(function (c) { return c.id; })).size === 52, 'duplicate ids in deck');
      check(deck.find(function (c) { return c.id === 'AH'; }).value === 14, 'Ace must be highest (14)');
    }],

    ['Dealing distributes all 52 cards for every player count', function (check) {
      for (let n = 2; n <= 10; n++) {
        const engine = new HS.GameEngine();
        const players = [];
        for (let i = 0; i < n; i++) players.push({ name: 'P' + (i + 1), type: 'human' });
        engine.initializeGame({ players: players, seed: n });
        const counts = engine.state.players.map(function (p) { return p.hand.length; });
        const total = counts.reduce(function (a, b) { return a + b; }, 0);
        check(total === 52, n + ' players: ' + total + ' cards dealt');
        check(Math.max.apply(null, counts) - Math.min.apply(null, counts) <= 1, n + ' players: uneven by more than 1');
      }
    }],

    ['Seeded deck is deterministic', function (check) {
      const a = HS.deck.shuffleDeck(HS.deck.createDeck(), HS.utils.createSeededRandom(42)).map(function (c) { return c.id; });
      const b = HS.deck.shuffleDeck(HS.deck.createDeck(), HS.utils.createSeededRandom(42)).map(function (c) { return c.id; });
      check(a.join() === b.join(), 'same seed produced different decks');
    }],

    ['SCENARIO A: hidden play ends the round, P3 collects, hidden cards stay private', function (check) {
      const engine = createScenarioGame('brokenA');
      check(play(engine, 0, '6H').ok, 'P1 6♥ rejected');
      check(engine.state.activeSuit === 'hearts', 'active suit should be hearts');
      check(play(engine, 1, '10H').ok, 'P2 10♥ rejected');
      check(play(engine, 2, 'KH').ok, 'P3 K♥ rejected');
      check(engine.state.status === S.SELECT_HIDDEN_SUIT, 'P4 should be forced to hide a suit');
      check(!play(engine, 3, '8C').ok, 'P4 must not play a visible off-suit card');
      check(!hide(engine, 3, 'diamonds', ['AD']).ok, 'P4 must not hide only SOME diamonds');
      check(!hide(engine, 3, 'hearts').ok, 'P4 must not hide a suit they do not hold');
      check(hide(engine, 3, 'diamonds').ok, 'P4 hidden diamonds rejected');

      const result = engine.state.lastRoundResult;
      check(engine.state.status === S.NEXT_ROUND, 'round should be resolved');
      check(result.type === 'broken', 'round type should be broken');
      check(result.collectorId === 2, 'P3 should collect');
      check(result.highestCard.id === 'KH', 'highest should be K♥');
      check(hasIds(handIds(engine, 2), ['6H', '10H', 'KH', 'AD', '4D']), 'P3 must receive all 5 round cards');
      check(handIds(engine, 3).join() === '8C,9S', 'P4 keeps only 8♣ 9♠');
      check(engine.state.nextStarterId === 2, 'P3 starts next round');
      check(engine.state.discardedCards.length === 0, 'nothing is discarded in a broken round');

      // PRIVACY: P1, P2, P4 and the public view must never show A♦ / 4♦.
      check(!leaksCards(engine.getPublicState(), ['AD', '4D']), 'public state leaks hidden cards');
      [0, 1, 3].forEach(function (id) {
        check(!leaksCards(engine.getPrivateView(id), ['AD', '4D']), 'P' + (id + 1) + ' can see the hidden cards');
      });
      check(engine.getPublicState().lastRoundResult.hiddenCount === undefined, 'public result leaks the hidden count');
      const collectorNotice = engine.getPrivateView(2).unreadNotices.find(function (n) { return n.hiddenCards.length; });
      check(collectorNotice && collectorNotice.hiddenCards.length === 2, 'collector must privately see the 2 hidden cards');

      check(engine.dispatch({ type: A.CONTINUE }).ok, 'continue rejected');
      check(engine.state.currentPlayerIndex === 2 && engine.state.status === S.SELECT_CARD, 'P3 should now lead');
      check(engine.getLegalCards(2).length === engine.state.players[2].hand.length, 'starter may play ANY card');
    }],

    ['Round ends IMMEDIATELY after a hidden play (later players never act)', function (check) {
      const engine = new HS.GameEngine();
      const players = [1, 2, 3, 4, 5, 6].map(function (n) { return { name: 'P' + n, type: 'human' }; });
      engine.initializeGame({ players: players, starterId: 0, hands: [
        ['6H', '2C'], ['9H', '3C'], ['KH', '4C'], ['7S', '3S', '5C'], ['2H', '6C'], ['3H', '7C']
      ] });
      engine.startGame();
      play(engine, 0, '6H'); play(engine, 1, '9H'); play(engine, 2, 'KH');
      hide(engine, 3, 'spades');
      check(engine.state.status === S.NEXT_ROUND, 'round should already be over');
      check(engine.state.lastRoundDisplay.length === 4, 'only 4 plays should exist');
      check(handIds(engine, 4).join() === '2H,6C' && handIds(engine, 5).join() === '3H,7C', 'P5/P6 must not have played');
      check(!play(engine, 4, '2H').ok, 'P5 must not be able to play after the round ended');
      check(engine.state.lastRoundResult.collectorId === 2, 'K♥ (P3) collects');
    }],

    ['SCENARIO B: clean round removes all cards, K♥ player starts next', function (check) {
      const engine = createScenarioGame('cleanB');
      check(!play(engine, 1, 'KH').ok, 'P2 must not play out of turn');
      play(engine, 0, '6H');
      check(!play(engine, 1, '3C').ok, 'P2 must follow hearts');
      play(engine, 1, 'KH'); play(engine, 2, 'JH'); play(engine, 3, '9H');
      const result = engine.state.lastRoundResult;
      check(result.type === 'clean', 'round type should be clean');
      check(result.highestCard.id === 'KH' && engine.state.nextStarterId === 1, 'P2 (K♥) starts next');
      const discarded = engine.state.discardedCards.map(function (c) { return c.id; });
      check(discarded.length === 4 && hasIds(discarded, ['6H', 'KH', 'JH', '9H']), 'all four hearts are discarded');
      [0, 1, 2, 3].forEach(function (id) {
        check(engine.state.players[id].hand.length === 1, 'P' + (id + 1) + ' should have exactly 1 card left (nobody collects)');
        check(handIds(engine, id).every(function (cid) { return discarded.indexOf(cid) === -1; }), 'discarded card returned to a hand');
      });
      engine.dispatch({ type: A.CONTINUE });
      check(engine.state.currentPlayerIndex === 1, 'P2 should lead round 2');
    }],

    ['SECOND TEST: hidden Hearts, J♣ player collects and starts; duplicates impossible', function (check) {
      const engine = createScenarioGame('brokenSecond');
      play(engine, 0, '7C'); play(engine, 1, 'JC'); play(engine, 2, '2C');
      check(hide(engine, 3, 'hearts').ok, 'P4 hidden hearts rejected');
      const result = engine.state.lastRoundResult;
      check(result.collectorId === 1 && result.highestCard.id === 'JC', 'P2 (J♣) should collect');
      check(hasIds(handIds(engine, 1), ['7C', 'JC', '2C', 'AH', '5H']), 'P2 must receive all round cards');
      check(engine.state.nextStarterId === 1, 'P2 starts next round');
      check(!leaksCards(engine.getPrivateView(0), ['AH', '5H']), 'P1 sees hidden hearts');

      let duplicateRejected = false;
      try {
        new HS.GameEngine().initializeGame({
          players: [{ name: 'A' }, { name: 'B' }],
          hands: [['AH', '5H'], ['5H', '2C']]
        });
      } catch (err) { duplicateRejected = true; }
      check(duplicateRejected, 'a second 5♥ must be rejected');
    }],

    ['Player reaching 0 is finished only AFTER the round resolves', function (check) {
      const engine = createScenarioGame('finishEdge');
      play(engine, 0, '7H');
      check(engine.state.players[0].hand.length === 0, 'P1 hand should be empty');
      check(engine.state.players[0].status === 'active', 'P1 must not be finished mid-round');
      check(engine.state.status === S.SELECT_CARD && engine.state.currentPlayerIndex === 1, 'round must continue to P2');
      play(engine, 1, '9H'); play(engine, 2, '3H');
      check(engine.state.players[0].status === 'finished' && engine.state.players[0].finishPosition === 1, 'P1 finished #1');
      check(engine.state.nextStarterId === 1, 'P2 (9♥) starts next');
      engine.dispatch({ type: A.CONTINUE });
      check(engine.state.roundParticipants.indexOf(0) === -1, 'finished P1 must not be in the rotation');
      check(!play(engine, 0, '7H').ok, 'finished player cannot play');
    }],

    ['Highest-card player who went out passes the lead to the next active player', function (check) {
      const engine = new HS.GameEngine();
      engine.initializeGame({ players: [{ name: 'P1' }, { name: 'P2' }, { name: 'P3' }], starterId: 0,
        hands: [['AH'], ['2H', '3C'], ['4H', '5C']] });
      engine.startGame();
      play(engine, 0, 'AH'); play(engine, 1, '2H'); play(engine, 2, '4H');
      check(engine.state.players[0].status === 'finished', 'P1 finished');
      check(engine.state.nextStarterId === 1, 'P2 (next active after P1) should start');
    }],

    ['Game over: last player holding cards is the loser', function (check) {
      const engine = createScenarioGame('gameOver');
      play(engine, 0, '5H'); play(engine, 1, '3H');
      check(engine.state.status === S.GAME_OVER, 'game should be over');
      const results = engine.state.results;
      check(results[0].playerId === 0 && results[0].position === 1, 'P1 is 1st');
      check(results[1].playerId === 1 && results[1].isLoser, 'P2 is the loser');
      check(!engine.dispatch({ type: A.CONTINUE }).ok, 'no actions after game over');
    }],

    ['Hidden player can empty their hand and finish', function (check) {
      const engine = new HS.GameEngine();
      engine.initializeGame({ players: [{ name: 'P1' }, { name: 'P2' }, { name: 'P3' }], starterId: 0,
        hands: [['6H', '2C'], ['3D', '4D'], ['8H', '9C']] });
      engine.startGame();
      play(engine, 0, '6H');
      hide(engine, 1, 'diamonds');
      check(engine.state.players[1].status === 'finished', 'P2 finished by hiding their last suit');
      check(engine.state.lastRoundResult.collectorId === 0, 'P1 collects');
      check(engine.state.players[2].hand.length === 2, 'P3 never played');
    }],

    ['AI vs AI: 300 random games finish with valid state', function (check) {
      for (let game = 0; game < 300; game++) {
        const count = 2 + (game % 9);
        const engine = new HS.GameEngine();
        const players = [];
        for (let i = 0; i < count; i++) players.push({ name: 'AI ' + (i + 1), type: 'ai' });
        engine.initializeGame({ players: players, seed: 1000 + game });
        engine.startGame();
        let steps = 0;
        while (engine.state.status !== S.GAME_OVER && steps < 20000) {
          steps++;
          if (engine.state.status === S.NEXT_ROUND) { engine.dispatch({ type: A.CONTINUE }); continue; }
          const id = engine.state.currentPlayerIndex;
          const move = HS.ai.chooseMove(engine.getPublicState(), engine.getPrivateView(id));
          const res = engine.dispatch(move);
          if (!res.ok) { check(false, 'AI made illegal move: ' + res.error); break; }
        }
        if (engine.state.status !== S.GAME_OVER) {
          check(false, 'game ' + game + ' (' + count + ' players) did not finish');
          break;
        }
        const res = engine.state.results;
        const losers = res.filter(function (r) { return r.isLoser; }).length;
        check(losers <= 1, 'more than one loser');
        check(res.length === count || (losers === 0 && res.length === count), 'every player must be ranked');
      }
    }]
  ];

  function runAll() {
    return TESTS.map(function (t) { return runTest(t[0], t[1]); });
  }

  HS.tests = {
    SCENARIOS: SCENARIOS,
    createScenarioGame: createScenarioGame,
    runAll: runAll
  };
})(window.HiddenSuit);
