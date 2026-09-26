/*
 * ai.js
 * ---------------------------------------------------------------------------
 * PHASE 11 — Simple, honest AI.
 *
 * FAIR PLAY: the AI only ever receives
 *   - publicState   (engine.getPublicState())      -> what everyone can see
 *   - privateView   (engine.getPrivateView(aiId))  -> its OWN hand
 * It never touches the engine's secret state, so it cannot see other hands
 * or anybody's hidden cards.
 *
 * chooseMove() returns an ACTION object that is sent through engine.dispatch()
 * exactly like a human move, so the engine validates AI moves too.
 */
'use strict';

(function (HS) {
  const A = HS.ACTIONS;

  /** Main entry point: decide the AI's next action. */
  function chooseMove(publicState, privateView) {
    if (privateView.mustPlayHidden) {
      return { type: A.PLAY_HIDDEN_SUIT, playerId: privateView.playerId,
        suit: chooseHiddenSuit(privateView) };
    }
    const legal = privateView.hand.filter(function (c) {
      return privateView.legalCardIds.indexOf(c.id) !== -1;
    });
    const card = privateView.isStarter
      ? chooseLeadCard(publicState, privateView, legal)
      : chooseFollowCard(publicState, privateView, legal);
    return { type: A.PLAY_CARD, playerId: privateView.playerId, cardId: card.id };
  }

  /**
   * LEADING: we want a CLEAN round (cards leave the game) and we don't want
   * to be highest if the round breaks (the highest card collects everything).
   * So lead the LOWEST card of the suit opponents most likely still hold.
   * "Likely" is estimated only from public info: 13 minus our own cards of
   * that suit minus cards of that suit we've SEEN removed in clean rounds.
   */
  function chooseLeadCard(publicState, privateView, legal) {
    const seenRemoved = countPubliclyRemovedBySuit(publicState);
    let best = null;
    legal.forEach(function (card) {
      const mine = privateView.hand.filter(function (c) { return c.suit === card.suit; }).length;
      const unseenOutThere = 13 - mine - (seenRemoved[card.suit] || 0);
      // Higher score = better. Unseen cards dominate; low rank breaks ties.
      const score = unseenOutThere * 20 - card.value;
      if (!best || score > best.score) best = { card: card, score: score };
    });
    return best.card;
  }

  /**
   * FOLLOWING:
   *  - If we can stay UNDER the current highest card, play our biggest such
   *    card (dumps a high card without risking collection).
   *  - If every card we hold beats the current highest:
   *      * last to play -> the round will be clean, so dump our HIGHEST card
   *        (we'll just start the next round).
   *      * otherwise    -> play our LOWEST to limit the risk of collecting.
   */
  function chooseFollowCard(publicState, privateView, legal) {
    const highest = publicState.highestCard;
    const sorted = legal.slice().sort(function (a, b) { return a.value - b.value; });
    const under = sorted.filter(function (c) { return !highest || c.value < highest.value; });
    if (under.length > 0) return under[under.length - 1];

    const activePlayers = publicState.players.filter(function (p) { return p.status === 'active'; }).length;
    const playsSoFar = publicState.roundPlays.length;
    const isLastToPlay = playsSoFar === activePlayers - 1;
    return isLastToPlay ? sorted[sorted.length - 1] : sorted[0];
  }

  /**
   * HIDDEN SUIT: dump the suit with the MOST cards (biggest hand reduction).
   * Ties go to the suit with the higher total rank (get rid of strong cards).
   */
  function chooseHiddenSuit(privateView) {
    let best = null;
    privateView.hiddenSuitOptions.forEach(function (option) {
      const rankSum = privateView.hand
        .filter(function (c) { return c.suit === option.suit; })
        .reduce(function (sum, c) { return sum + c.value; }, 0);
      const score = option.count * 100 + rankSum;
      if (!best || score > best.score) best = { suit: option.suit, score: score };
    });
    return best.suit;
  }

  /** Counts cards per suit removed in clean rounds (they were played face up, so this is public). */
  function countPubliclyRemovedBySuit(publicState) {
    const counts = {};
    HS.SUITS.forEach(function (s) { counts[s.key] = 0; });
    publicState.discardedCards.forEach(function (card) { counts[card.suit] += 1; });
    return counts;
  }

  HS.ai = {
    chooseMove: chooseMove,
    chooseLeadCard: chooseLeadCard,
    chooseFollowCard: chooseFollowCard,
    chooseHiddenSuit: chooseHiddenSuit
  };
})(window.HiddenSuit);
