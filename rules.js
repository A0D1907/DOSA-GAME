// Shared authoritative game rules (used by the server; mirrors the client).
// Board geometry per mode. Positions are absolute perimeter indices.

const BOARD_MODES = {
  4: { step: 16, off: 4, total: 64, maxPer: 62, starts: [4, 20, 36, 52], cuts: [10, 26, 42, 58] },
  2: { step: 8, off: 2, total: 32, maxPer: 30, starts: [2, 10, 18, 26], cuts: [5, 13, 21, 29] }
};

// Same 2-player opposite-seat remap the clients use (identity otherwise).
// `slots`: array of 4 (socket id | 'bot' | null).
function serverVisualMap(slots) {
  const vm = { 0: 0, 1: 1, 2: 2, 3: 3 };
  const active = slots.map((s, i) => s ? i : null).filter(i => i !== null);
  if (active.length === 2) {
    vm[active[0]] = active[0];
    vm[active[1]] = (active[0] + 2) % 4;
  }
  return vm;
}

// All moves the rules allow for `player` with this dice value.
// `state`: { pieces, visualMap, pegsPerPlayer }.
// 1:1 with the client logic, including the safe-home stacking exemption.
function serverLegalMoves(state, player, dice) {
  const cfg = BOARD_MODES[state.pegsPerPlayer === 2 ? 2 : 4];
  const vm = state.visualMap || { 0: 0, 1: 1, 2: 2, 3: 3 };
  const v = vm[player];
  const start = v * cfg.step + cfg.off;
  const ownAt = (st, pos) => state.pieces.some(p => p.player === player && p.state === st && p.pos === pos);

  if (dice === 1) {
    const forced = [];
    for (const pc of state.pieces.filter(p => p.player === player)) {
      if (pc.state === 'perimeter' && cfg.cuts.includes(pc.pos)) {
        const t = (pc.pos + cfg.step) % cfg.total;
        if (!ownAt('perimeter', t)) forced.push({ pieceId: pc.id, action: 'shortcut', target: t });
      }
    }
    if (forced.length > 0) return forced;
  }

  const moves = [];
  for (const pc of state.pieces.filter(p => p.player === player)) {
    if (pc.state === 'jail') {
      if (dice === 6) moves.push({ pieceId: pc.id, action: 'leave_jail', target: start });
    } else if (pc.state === 'perimeter') {
      const cur = (pc.pos - start + cfg.total) % cfg.total;
      const td = cur + dice;
      if (td <= cfg.maxPer) {
        moves.push({ pieceId: pc.id, action: 'move', target: (pc.pos + dice) % cfg.total });
      } else {
        const hp = td - (cfg.maxPer + 1);
        if (hp < state.pegsPerPlayer) moves.push({ pieceId: pc.id, action: 'home', target: hp });
      }
    } else if (pc.state === 'home') {
      const tp = pc.pos + dice;
      if (tp < state.pegsPerPlayer) moves.push({ pieceId: pc.id, action: 'home', target: tp });
    }
  }
  return moves.filter(m => m.action === 'home' || !ownAt('perimeter', m.target));
}

// Apply a validated move to a pieces array (positions + captures).
// Mutates and returns the moved piece, or null.
function serverApplyMove(state, pieceId, action, target) {
  const piece = state.pieces.find(p => p.id === pieceId);
  if (!piece) return null;
  if (action === 'leave_jail' || action === 'shortcut' || action === 'move') {
    piece.state = 'perimeter'; piece.pos = target;
  } else if (action === 'home') {
    piece.state = 'home'; piece.pos = target;
  } else {
    return null;
  }
  if (piece.state === 'perimeter') {
    const enemies = state.pieces.filter(p => p.player !== piece.player && p.state === 'perimeter' && p.pos === piece.pos);
    enemies.forEach(e => {
      e.state = 'jail';
      const taken = state.pieces.filter(p => p.id !== e.id && p.player === e.player && p.state === 'jail').map(p => p.pos);
      const n = state.pegsPerPlayer;
      for (let i = 0; i < n; i++) {
        if (!taken.includes(i)) { e.pos = i; break; }
      }
    });
  }
  return piece;
}

module.exports = { BOARD_MODES, serverVisualMap, serverLegalMoves, serverApplyMove };
