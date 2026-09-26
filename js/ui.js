/*
 * ui.js
 * ---------------------------------------------------------------------------
 * PHASE 9 — Rendering only.
 *
 * This file turns VIEW DATA into HTML. It never reads or changes the engine.
 * It receives:
 *   publicState  -> engine.getPublicState()        (safe for everyone)
 *   privateView  -> engine.getPrivateView(id) or null when the hand must be hidden
 *   uiState      -> selection / mode info owned by main.js
 *
 * User clicks are forwarded to handler functions supplied by main.js.
 */
'use strict';

(function (HS) {
  const { escapeHtml, getSuitInfo, formatCard } = HS.utils;
  const S = HS.STATES;

  const $ = function (id) { return document.getElementById(id); };
  let handlers = {};
  let lastRoundKey = null;      // used to animate only newly played cards
  let lastPlayCount = 0;
  let lastLogLength = 0;

  /* ------------------------------------------------------------------------
   * CARD HTML
   * --------------------------------------------------------------------- */

  /** HTML for a face-up playing card. */
  function cardHtml(card, extraClasses, attrs) {
    return '<div class="card card--' + card.color + ' ' + (extraClasses || '') + '" data-card-id="' +
      card.id + '" ' + (attrs || '') + ' aria-label="' + card.rank + ' of ' + getSuitInfo(card.suit).name + '">' +
      '<span class="card__corner card__corner--top">' + card.rank + '<br>' + card.symbol + '</span>' +
      '<span class="card__pip">' + card.symbol + '</span>' +
      '<span class="card__corner card__corner--bottom">' + card.rank + '<br>' + card.symbol + '</span>' +
      '</div>';
  }

  /** HTML for a face-down card (used for hidden plays). */
  function cardBackHtml(extraClasses, label) {
    return '<div class="card card--back ' + (extraClasses || '') + '" aria-label="Hidden cards">' +
      '<span class="card__lock">🔒</span>' + (label ? '<span class="card__back-label">' + label + '</span>' : '') +
      '</div>';
  }

  function suitLabel(suitKey) {
    const suit = getSuitInfo(suitKey);
    return '<span class="suit-' + suit.color + '">' + suit.symbol + ' ' + suit.name + '</span>';
  }

  function nameOf(publicState, playerId) {
    const p = publicState.players[playerId];
    return p ? escapeHtml(p.name) : '—';
  }

  /** "Ada starts" but "You start" (AI mode names the human "You"). */
  function verb(publicState, playerId, singular, plural) {
    const p = publicState.players[playerId];
    return p && p.name === 'You' ? plural : singular;
  }

  /* ------------------------------------------------------------------------
   * MAIN RENDER
   * --------------------------------------------------------------------- */

  function renderGame(publicState, privateView, uiState) {
    renderActiveSuit(publicState);
    renderPlayerStatus(publicState, uiState);
    renderRoundCards(publicState);
    showTurnIndicator(publicState, uiState);
    renderPlayerHands(publicState, privateView, uiState);
    renderLog(publicState.log);
  }

  /** Round number, active suit, starter, current turn. */
  function renderActiveSuit(publicState) {
    const current = publicState.currentPlayerId;
    const suitHtml = publicState.activeSuit
      ? '<span class="active-suit active-suit--' + getSuitInfo(publicState.activeSuit).color + '">' +
        suitLabel(publicState.activeSuit) + '</span>'
      : '<span class="muted">not set yet</span>';

    $('round-info').innerHTML =
      '<div class="round-info__round">ROUND ' + publicState.roundNumber + '</div>' +
      '<div class="round-info__grid">' +
      '<span>Active suit</span><strong>' + suitHtml + '</strong>' +
      '<span>Starter</span><strong>' + nameOf(publicState, publicState.roundStarterId) + '</strong>' +
      '<span>Turn</span><strong>' + (current !== null ? nameOf(publicState, current) : '—') + '</strong>' +
      '<span>Removed</span><strong>' + publicState.discardedCount + ' cards</strong>' +
      '</div>';
  }

  /** Player seats around the table (desktop) / chips (mobile). */
  function renderPlayerStatus(publicState, uiState) {
    const players = publicState.players;
    const count = players.length;
    const bottomId = uiState.bottomPlayerId || 0;
    const container = $('seats');

    container.innerHTML = players.map(function (p) {
      // Place seats clockwise on an ellipse, with `bottomId` at the bottom.
      const slot = (p.id - bottomId + count) % count;
      const angle = (90 + slot * (360 / count)) * Math.PI / 180;
      const x = 50 + 46 * Math.cos(angle);
      const y = 50 + 43 * Math.sin(angle);

      const classes = ['seat'];
      if (p.id === publicState.currentPlayerId) classes.push('seat--turn');
      if (p.id === publicState.roundStarterId && publicState.status !== S.GAME_OVER) classes.push('seat--starter');
      if (p.status === 'finished') classes.push('seat--finished');
      if (p.status === 'loser') classes.push('seat--loser');

      let badge = '';
      if (p.status === 'finished') badge = '<span class="badge badge--gold">#' + p.finishPosition + '</span>';
      else if (p.status === 'loser') badge = '<span class="badge badge--red">LOSER</span>';
      else if (p.id === publicState.currentPlayerId) badge = '<span class="badge badge--turn">TURN</span>';
      else if (p.id === publicState.roundStarterId) badge = '<span class="badge">STARTER</span>';

      const initials = escapeHtml(p.name).slice(0, 2).toUpperCase();
      return '<div class="' + classes.join(' ') + '" data-player-id="' + p.id + '" data-x="' + x.toFixed(1) +
        '" data-y="' + y.toFixed(1) + '">' +
        '<div class="seat__avatar">' + (p.type === 'ai' ? '🤖' : initials) + '</div>' +
        '<div class="seat__info">' +
        '<div class="seat__name">' + escapeHtml(p.name) + '</div>' +
        '<div class="seat__meta"><span class="mini-back"></span>' + p.handCount + ' card' + (p.handCount === 1 ? '' : 's') + '</div>' +
        '</div>' + badge + '</div>';
    }).join('');

    // Position via CSS custom properties (the stylesheet decides whether to use them).
    container.querySelectorAll('.seat').forEach(function (seat) {
      seat.style.setProperty('--x', seat.dataset.x + '%');
      seat.style.setProperty('--y', seat.dataset.y + '%');
    });
  }

  /** Cards played this round (visible cards face up, hidden plays face down). */
  function renderRoundCards(publicState) {
    const area = $('round-area');
    const plays = publicState.roundPlays;
    const roundKey = publicState.roundNumber;
    if (roundKey !== lastRoundKey) { lastRoundKey = roundKey; lastPlayCount = 0; }

    const result = publicState.lastRoundResult;
    area.classList.toggle('round-area--collected', !!(result && result.type === 'broken'));
    area.classList.toggle('round-area--removed', !!(result && result.type === 'clean'));

    if (plays.length === 0) {
      area.innerHTML = '<div class="round-area__empty">Waiting for ' +
        nameOf(publicState, publicState.currentPlayerId) + ' to lead…</div>';
      lastPlayCount = 0;
      return;
    }

    area.innerHTML = plays.map(function (play, index) {
      const isNew = index >= lastPlayCount ? ' play--new' : '';
      const isHighest = play.kind === 'visible' && publicState.highestCard &&
        play.card.id === publicState.highestCard.id ? ' play--highest' : '';
      const inner = play.kind === 'visible'
        ? cardHtml(play.card, '')
        : renderHiddenCards(play);
      return '<div class="play' + isNew + isHighest + (play.kind === 'hidden' ? ' play--hidden' : '') + '">' +
        inner + '<div class="play__name">' + nameOf(publicState, play.playerId) + '</div></div>';
    }).join('');
    lastPlayCount = plays.length;
  }

  /** Public face-down marker for a hidden play. Never contains card identities. */
  function renderHiddenCards(play) {
    const label = play.count ? play.count + ' hidden' : 'Hidden cards';
    return '<div class="hidden-stack">' + cardBackHtml('card--stack-3') + cardBackHtml('card--stack-2') +
      cardBackHtml('card--stack-1', label) + '</div>';
  }

  /** Message in the middle of the table about whose turn it is. */
  function showTurnIndicator(publicState, uiState) {
    const el = $('table-message');
    const current = publicState.players[publicState.currentPlayerId];
    let text = '';
    if (publicState.status === S.GAME_OVER) text = '🏆 Game over';
    else if (publicState.status === S.NEXT_ROUND) {
      text = publicState.lastRoundResult && publicState.lastRoundResult.type === 'clean'
        ? '✨ Clean round — cards removed' : '📥 Round collected';
    } else if (current) {
      if (current.type === 'ai') text = '🤖 ' + escapeHtml(current.name) + ' is thinking…';
      else if (uiState.mode !== 'pass' && current.id === uiState.viewerId) text = '👉 Your turn';
      else text = '👉 ' + escapeHtml(current.name) + "'s turn";
    }
    el.textContent = '';
    el.innerHTML = text;
  }

  /* ------------------------------------------------------------------------
   * PRIVATE HAND
   * --------------------------------------------------------------------- */

  function renderPlayerHands(publicState, privateView, uiState) {
    const handEl = $('hand');
    const title = $('hand-title');
    const message = $('hand-message');
    const confirm = $('btn-confirm');

    if (!privateView) {
      title.innerHTML = '🔒 Hand hidden';
      message.textContent = uiState.mode === 'pass'
        ? 'Hands stay hidden until the right player presses "Reveal My Hand".'
        : '';
      handEl.innerHTML = '';
      $('hidden-suit-panel').innerHTML = '';
      $('private-notices').innerHTML = '';
      confirm.hidden = true;
      return;
    }

    const me = publicState.players[privateView.playerId];
    title.innerHTML = (uiState.mode !== 'pass' ? 'Your hand' : escapeHtml(privateView.name) + "'s hand") +
      ' <span class="muted">(' + privateView.hand.length + ' card' + (privateView.hand.length === 1 ? '' : 's') + ')</span>';

    message.innerHTML = handInstruction(publicState, privateView, me);
    renderPrivateNotices(privateView);
    renderHiddenSuitPanel(publicState, privateView, uiState);

    // Cards received from the last collection get a "new" marker (private info).
    const freshIds = {};
    privateView.unreadNotices.forEach(function (n) {
      n.cards.forEach(function (c) { freshIds[c.id] = 'new'; });
      n.hiddenCards.forEach(function (c) { freshIds[c.id] = 'secret'; });
    });

    // Group cards by suit so large hands stay readable on small screens.
    handEl.innerHTML = HS.SUITS.map(function (suit) {
      const cards = privateView.hand.filter(function (c) { return c.suit === suit.key; });
      if (!cards.length) return '';
      return '<div class="hand-group">' + cards.map(function (card) {
        const classes = [];
        const legal = privateView.legalCardIds.indexOf(card.id) !== -1;
        if (privateView.isMyTurn && !privateView.mustPlayHidden) classes.push(legal ? 'card--legal' : 'card--disabled');
        if (privateView.mustPlayHidden) classes.push(card.suit === uiState.selectedSuit ? 'card--hidden-pick' : 'card--muted');
        if (card.id === uiState.selectedCardId) classes.push('card--selected');
        if (freshIds[card.id] === 'new') classes.push('card--fresh');
        if (freshIds[card.id] === 'secret') classes.push('card--secret');
        return cardHtml(card, 'card--hand ' + classes.join(' '), 'role="button" tabindex="0"');
      }).join('') + '</div>';
    }).join('');

    const canConfirm = privateView.isMyTurn &&
      (privateView.mustPlayHidden ? !!uiState.selectedSuit : !!uiState.selectedCardId);
    confirm.hidden = !privateView.isMyTurn;
    confirm.disabled = !canConfirm;
    confirm.textContent = privateView.mustPlayHidden ? '🔒 Confirm Secret Play' : 'Confirm Move';
  }

  function handInstruction(publicState, privateView, me) {
    if (me.status === 'finished') return '🏁 You finished #' + me.finishPosition + '! Watch the others play.';
    if (me.status === 'loser') return 'You were the last player holding cards.';
    if (!privateView.isMyTurn) {
      const current = publicState.players[publicState.currentPlayerId];
      return current ? 'Waiting for ' + escapeHtml(current.name) + '…' : '';
    }
    if (privateView.mustPlayHidden) {
      return '⚠️ You cannot follow ' + suitLabel(publicState.activeSuit) + '. Choose a suit to play secretly.';
    }
    if (privateView.isStarter) {
      return privateView.forcedLeadSuit
        ? '🧪 Debug: lead a ' + suitLabel(privateView.forcedLeadSuit) + ' card.'
        : '⭐ You start the round — play <strong>any</strong> card. Its suit becomes the active suit.';
    }
    return 'You must follow ' + suitLabel(publicState.activeSuit) + ' — pick one of the highlighted cards.';
  }

  /** Suit-selection interface for the hidden-suit mechanic. */
  function renderHiddenSuitPanel(publicState, privateView, uiState) {
    const panel = $('hidden-suit-panel');
    if (!privateView.mustPlayHidden) { panel.innerHTML = ''; return; }

    const buttons = privateView.hiddenSuitOptions.map(function (opt) {
      const suit = getSuitInfo(opt.suit);
      const selected = uiState.selectedSuit === opt.suit ? ' suit-btn--selected' : '';
      return '<button type="button" class="suit-btn suit-btn--' + suit.color + selected + '" data-suit="' + opt.suit + '">' +
        '<span class="suit-btn__symbol">' + suit.symbol + '</span>' +
        '<span class="suit-btn__name">' + suit.name.toUpperCase() + '</span>' +
        '<span class="suit-btn__count">' + opt.count + ' card' + (opt.count === 1 ? '' : 's') + '</span></button>';
    }).join('');

    let summary = '';
    if (uiState.selectedSuit) {
      const chosen = privateView.hand.filter(function (c) { return c.suit === uiState.selectedSuit; });
      summary = '<div class="hidden-summary">You selected ' + suitLabel(uiState.selectedSuit) + '. ' +
        '<strong>' + chosen.length + ' card' + (chosen.length === 1 ? '' : 's') + '</strong> will be secretly played: ' +
        chosen.map(formatCard).join(' ') + '</div>';
    }

    panel.innerHTML = '<div class="hidden-panel">' +
      '<div class="hidden-panel__title">You cannot follow ' + suitLabel(publicState.activeSuit) +
      '. Choose a suit to secretly discard — <em>all</em> its cards go face down:</div>' +
      '<div class="suit-btn-row">' + buttons + '</div>' + summary + '</div>';
  }

  /** Private messages for the viewer (e.g. hidden cards they just collected). */
  function renderPrivateNotices(privateView) {
    const el = $('private-notices');
    if (!privateView.unreadNotices.length) { el.innerHTML = ''; return; }
    el.innerHTML = '<div class="notice">' +
      '<div class="notice__label">🔐 Private — only you can see this</div>' +
      privateView.unreadNotices.map(function (n) {
        const hidden = n.hiddenCards.length
          ? '<div class="notice__cards">' + n.hiddenCards.map(function (c) { return cardHtml(c, 'card--mini card--secret'); }).join('') + '</div>'
          : '';
        return '<div class="notice__item">' + escapeHtml(n.text) + hidden + '</div>';
      }).join('') +
      '<button type="button" class="btn btn--small" data-action="dismiss-notices">Got it</button></div>';
  }

  /* ------------------------------------------------------------------------
   * LOG
   * --------------------------------------------------------------------- */

  function renderLog(log) {
    const list = $('log-list');
    if (log.length === lastLogLength) return;
    if (log.length < lastLogLength) { list.innerHTML = ''; lastLogLength = 0; }
    const fragment = log.slice(lastLogLength).map(function (entry) {
      return '<li class="log-entry log-entry--' + entry.type + '">' + escapeHtml(entry.text) + '</li>';
    }).join('');
    list.insertAdjacentHTML('beforeend', fragment);
    lastLogLength = log.length;
    list.scrollTop = list.scrollHeight;
  }

  function resetRenderMemory() {
    lastRoundKey = null;
    lastPlayCount = 0;
    lastLogLength = 0;
    $('log-list').innerHTML = '';
  }

  /* ------------------------------------------------------------------------
   * MODALS, RESULTS, PRIVACY SCREEN, TOASTS
   * --------------------------------------------------------------------- */

  /** actions: [{ label, className, onClick }] */
  function showModal(title, bodyHtml, actions, extraClass) {
    $('modal-title').innerHTML = title;
    $('modal-body').innerHTML = bodyHtml;
    const actionsEl = $('modal-actions');
    actionsEl.innerHTML = '';
    (actions || []).forEach(function (action) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'btn ' + (action.className || 'btn--primary');
      btn.textContent = action.label;
      btn.addEventListener('click', function () {
        hideModal();
        if (action.onClick) action.onClick();
      });
      actionsEl.appendChild(btn);
    });
    const modal = document.querySelector('#modal .modal');
    modal.className = 'modal ' + (extraClass || '');
    $('modal').hidden = false;
    modal.scrollTop = 0;
    const first = actionsEl.querySelector('button');
    if (first) first.focus({ preventScroll: true });
  }

  function hideModal() {
    $('modal').hidden = true;
  }

  function isModalOpen() {
    return !$('modal').hidden;
  }

  function confirmDialog(title, text, confirmLabel, onConfirm) {
    showModal(title, '<p>' + text + '</p>', [
      { label: 'Cancel', className: 'btn--ghost' },
      { label: confirmLabel, className: 'btn--danger', onClick: onConfirm }
    ], 'modal--small');
  }

  function showRules() {
    showModal('📖 How to Play Hidden Suit', $('rules-template').innerHTML,
      [{ label: 'Got it', className: 'btn--primary' }], 'modal--wide');
  }

  /**
   * Round result. `privateExtra` is optional HTML shown ONLY when the viewer
   * is allowed to see it (AI mode, where the single human is the viewer).
   */
  function showRoundResult(publicState, privateExtra, onContinue, options) {
    const opts = options || {};
    const r = publicState.lastRoundResult;
    let title;
    let body;
    const highest = cardHtml(r.highestCard, 'card--mini');
    const finished = (r.finishedThisRound || []).map(function (id) {
      const p = publicState.players[id];
      return '<div class="result-finish">🏁 ' + escapeHtml(p.name) + ' finished #' + p.finishPosition + '!</div>';
    }).join('');

    if (r.type === 'broken') {
      title = '📥 ROUND ENDED';
      const hiddenLine = r.hiddenCount !== undefined ? r.hiddenCount + ' hidden cards' : '🔒 hidden cards';
      body = '<p class="result-lead"><strong>' + nameOf(publicState, r.collectorId) + '</strong> ' +
        verb(publicState, r.collectorId, 'wins', 'win') + ' the round with ' + highest + '</p>' +
        '<p>' + nameOf(publicState, r.hiddenPlayerId) + ' could not follow ' + suitLabel(r.activeSuit) +
        ' and secretly played cards.</p>' +
        '<div class="result-box"><div>Collected:</div><div><strong>' + r.visibleCount + ' visible card' +
        (r.visibleCount === 1 ? '' : 's') + '</strong></div><div><strong>' + hiddenLine + '</strong></div></div>';
    } else {
      title = '✨ CLEAN ROUND';
      body = '<p class="result-lead">Everyone followed ' + suitLabel(r.activeSuit) + '.</p>' +
        '<div class="result-box"><div>Cards removed from the game:</div><div><strong>' + r.removedCount +
        '</strong></div><div>Highest card: ' + highest + ' (' + nameOf(publicState, r.highestPlayerId) + ')</div></div>';
    }
    body += finished;
    if (privateExtra) body += privateExtra;
    if (r.nextStarterId !== undefined) {
      body += '<p class="result-next">▶ <strong>' + nameOf(publicState, r.nextStarterId) + '</strong> ' +
        verb(publicState, r.nextStarterId, 'starts', 'start') + ' the next round.</p>';
    }
    if (opts.note) body += '<p class="muted">' + escapeHtml(opts.note) + '</p>';
    showModal(title, body, [{ label: opts.label || 'Continue', className: 'btn--primary', onClick: onContinue }],
      'modal--result modal--' + r.type);
  }

  /**
   * Final standings. options.guest = true shows "OK" instead of "Play Again"
   * (only the online host can start a new game).
   */
  function renderResults(publicState, onPlayAgain, onMenu, options) {
    const opts = options || {};
    const rows = publicState.results.map(function (r) {
      const medal = r.isLoser ? '💀' : ['🥇', '🥈', '🥉'][r.position - 1] || '🏅';
      const place = r.isLoser ? 'Last' : ordinal(r.position);
      return '<li class="results__row' + (r.isLoser ? ' results__row--loser' : '') + '">' +
        '<span class="results__medal">' + medal + '</span><span class="results__place">' + place + '</span>' +
        '<span class="results__name">' + escapeHtml(r.name) + '</span>' +
        (r.isLoser ? '<span class="results__note">LOSER · ' + r.cardsLeft + ' cards left</span>' : '') + '</li>';
    }).join('');
    const noLoser = publicState.results.some(function (r) { return r.isLoser; })
      ? '' : '<p class="muted">Everyone emptied their hand in the same round — no loser this time!</p>';
    const note = opts.guest ? '<p class="muted">Waiting for the host to start a new game…</p>' : '';
    showModal('🏆 GAME OVER', '<ol class="results">' + rows + '</ol>' + noLoser + note, [
      { label: opts.guest ? 'Leave Room' : 'Exit to Menu', className: 'btn--ghost', onClick: onMenu },
      { label: opts.guest ? 'OK' : 'Play Again', className: 'btn--primary', onClick: onPlayAgain }
    ], 'modal--gameover');
  }

  function ordinal(n) {
    const suffix = ['th', 'st', 'nd', 'rd'];
    const v = n % 100;
    return n + (suffix[(v - 20) % 10] || suffix[v] || suffix[0]);
  }

  function showPrivacyScreen(playerName, text) {
    $('privacy-title').textContent = playerName + "'s Turn";
    $('privacy-text').textContent = text || 'Pass the device to ' + playerName + '. Everyone else, look away!';
    $('privacy-screen').hidden = false;
    $('btn-reveal').focus();
  }

  function hidePrivacyScreen() {
    $('privacy-screen').hidden = true;
  }

  function showToast(text, type) {
    const toast = document.createElement('div');
    toast.className = 'toast toast--' + (type || 'info');
    toast.textContent = text;
    $('toast-container').appendChild(toast);
    setTimeout(function () { toast.classList.add('toast--leaving'); }, 2400);
    setTimeout(function () { toast.remove(); }, 2900);
  }

  function showScreen(name) {
    document.querySelectorAll('.screen').forEach(function (s) { s.classList.remove('screen--active'); });
    $('screen-' + name).classList.add('screen--active');
  }

  /** Flash a seat (player finished, collected, etc.). */
  function pulseSeat(playerId, className) {
    const seat = document.querySelector('.seat[data-player-id="' + playerId + '"]');
    if (!seat) return;
    seat.classList.remove(className);
    void seat.offsetWidth; // restart CSS animation
    seat.classList.add(className);
  }

  /* ------------------------------------------------------------------------
   * EVENT BINDING (delegated, set up once)
   * --------------------------------------------------------------------- */

  function bindHandlers(newHandlers) {
    handlers = newHandlers;

    const onCardActivate = function (event) {
      const cardEl = event.target.closest('.card--hand');
      if (cardEl) handlers.onCardClick(cardEl.dataset.cardId);
    };
    $('hand').addEventListener('click', onCardActivate);
    $('hand').addEventListener('keydown', function (event) {
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onCardActivate(event); }
    });
    $('hand').addEventListener('dblclick', function (event) {
      if (event.target.closest('.card--legal')) handlers.onConfirm();
    });
    $('hidden-suit-panel').addEventListener('click', function (event) {
      const btn = event.target.closest('[data-suit]');
      if (btn) handlers.onSuitClick(btn.dataset.suit);
    });
    $('private-notices').addEventListener('click', function (event) {
      if (event.target.closest('[data-action="dismiss-notices"]')) handlers.onDismissNotices();
    });
    $('btn-confirm').addEventListener('click', function () { handlers.onConfirm(); });
    $('btn-reveal').addEventListener('click', function () { handlers.onReveal(); });
  }

  HS.ui = {
    cardHtml: cardHtml,
    renderGame: renderGame,
    renderPlayerHands: renderPlayerHands,
    renderRoundCards: renderRoundCards,
    renderActiveSuit: renderActiveSuit,
    renderPlayerStatus: renderPlayerStatus,
    renderHiddenCards: renderHiddenCards,
    renderResults: renderResults,
    renderLog: renderLog,
    showTurnIndicator: showTurnIndicator,
    showRoundResult: showRoundResult,
    showModal: showModal,
    hideModal: hideModal,
    isModalOpen: isModalOpen,
    confirmDialog: confirmDialog,
    showRules: showRules,
    showPrivacyScreen: showPrivacyScreen,
    hidePrivacyScreen: hidePrivacyScreen,
    showToast: showToast,
    showScreen: showScreen,
    pulseSeat: pulseSeat,
    resetRenderMemory: resetRenderMemory,
    bindHandlers: bindHandlers,
    suitLabel: suitLabel
  };
})(window.HiddenSuit);
