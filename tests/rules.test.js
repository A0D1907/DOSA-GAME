const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const R = require('../rules.js');

const mk = (pegs, visualMap, pieces) => ({
  pieces,
  visualMap: visualMap || { 0: 0, 1: 1, 2: 2, 3: 3 },
  pegsPerPlayer: pegs
});
const jail = (player, n) =>
  Array.from({ length: n }, (_, i) => ({ id: `${player}-${i}`, player, state: 'jail', pos: i }));

describe('visualMap', () => {
  test('identity with 0/1/3/4 seated', () => {
    assert.deepEqual(R.serverVisualMap([null, null, null, null]), { 0: 0, 1: 1, 2: 2, 3: 3 });
    assert.deepEqual(R.serverVisualMap(['a', null, null, null]), { 0: 0, 1: 1, 2: 2, 3: 3 });
    assert.deepEqual(R.serverVisualMap(['a', 'b', 'c', null]), { 0: 0, 1: 1, 2: 2, 3: 3 });
    assert.deepEqual(R.serverVisualMap(['a', 'b', 'c', 'd']), { 0: 0, 1: 1, 2: 2, 3: 3 });
  });

  test('2-player seats go opposite', () => {
    assert.deepEqual(R.serverVisualMap(['a', 'b', null, null]), { 0: 0, 1: 2, 2: 2, 3: 3 });
    assert.deepEqual(R.serverVisualMap([null, 'a', null, 'b']), { 0: 0, 1: 1, 2: 2, 3: 3 });
    assert.deepEqual(R.serverVisualMap(['a', null, null, 'b']), { 0: 0, 1: 1, 2: 2, 3: 2 });
  });
});

describe('jail exits', () => {
  test('4-peg: all rooks exit only on 6, to start 4', () => {
    const s = mk(4, null, [...jail(0, 4), ...jail(1, 4)]);
    assert.deepEqual(
      R.serverLegalMoves(s, 0, 6).map(m => `${m.action}:${m.target}`).sort(),
      ['leave_jail:4', 'leave_jail:4', 'leave_jail:4', 'leave_jail:4']
    );
    assert.deepEqual(R.serverLegalMoves(s, 0, 5), []);
    assert.deepEqual(R.serverLegalMoves(s, 0, 1), []);
  });

  test('2-peg: exits to start 4, remapped seat to 18', () => {
    assert.deepEqual(R.serverLegalMoves(mk(2, null, jail(0, 2)), 0, 6).map(m => m.target), [4, 4]);
    const s = mk(2, { 0: 0, 1: 1, 2: 2, 3: 3 }, jail(1, 2));
    assert.deepEqual(R.serverLegalMoves(s, 1, 6).map(m => m.target), [18, 18]);
    assert.deepEqual(R.serverLegalMoves(mk(2, null, jail(0, 2)), 0, 5), []);
  });

  test('2-peg: shortcut jumps a quarter (14) from inner corners', () => {
    const s = mk(2, null, [{ id: '0-0', player: 0, state: 'perimeter', pos: 8 }]);
    assert.deepEqual(R.serverLegalMoves(s, 0, 1), [{ pieceId: '0-0', action: 'shortcut', target: 22 }]);
  });
});

describe('perimeter play', () => {
  test('plain move and capture offered', () => {
    const s = mk(4, null, [
      { id: '0-0', player: 0, state: 'perimeter', pos: 10 },
      { id: '1-0', player: 1, state: 'perimeter', pos: 13 }
    ]);
    const moves = R.serverLegalMoves(s, 0, 3).filter(m => m.target === 13);
    assert.equal(moves.length, 1);
    assert.equal(moves[0].action, 'move');
  });

  test('own rook blocks landing on the track', () => {
    const s = mk(4, null, [
      { id: '0-0', player: 0, state: 'perimeter', pos: 10 },
      { id: '0-1', player: 0, state: 'perimeter', pos: 13 }
    ]);
    assert.deepEqual(R.serverLegalMoves(s, 0, 3).filter(m => m.pieceId === '0-0'), []);
  });

  test('capture jails the enemy into a free jail slot', () => {
    const s = mk(4, null, [
      { id: '0-0', player: 0, state: 'perimeter', pos: 10 },
      { id: '1-0', player: 1, state: 'perimeter', pos: 13 },
      { id: '1-1', player: 1, state: 'jail', pos: 0 }
    ]);
    R.serverApplyMove(s, '0-0', 'move', 13);
    const victim = s.pieces.find(p => p.id === '1-0');
    assert.equal(victim.state, 'jail');
    assert.equal(victim.pos, 1);
  });

  test('shortcut forced on 1 and exclusive; normal moves when no cut occupied', () => {
    const open = mk(4, null, [
      { id: '0-0', player: 0, state: 'perimeter', pos: 10 },
      { id: '0-1', player: 0, state: 'perimeter', pos: 30 }
    ]);
    assert.deepEqual(R.serverLegalMoves(open, 0, 1), [{ pieceId: '0-0', action: 'shortcut', target: 26 }]);

    const none = mk(4, null, [
      { id: '0-0', player: 0, state: 'perimeter', pos: 11 },
      { id: '0-1', player: 0, state: 'perimeter', pos: 30 }
    ]);
    const normal = R.serverLegalMoves(none, 0, 1);
    assert.ok(normal.length > 0);
    assert.ok(!normal.some(m => m.action === 'shortcut'));
  });
});

describe('home stretch', () => {
  test('2-peg dist-53 roll-2 enters occupied home (stacking allowed)', () => {
    // start idx 4 -> dist 53 sits on idx 1; roll 2 hits home0, roll 3 home1
    const s = mk(2, null, [
      { id: '0-0', player: 0, state: 'perimeter', pos: 1 },
      { id: '0-1', player: 0, state: 'home', pos: 0 }
    ]);
    assert.equal(R.serverLegalMoves(s, 0, 2).filter(m => m.action === 'home' && m.target === 0).length, 1);
    assert.equal(R.serverLegalMoves(s, 0, 3).filter(m => m.action === 'home' && m.target === 1).length, 1);
  });

  test('every distance has a legal roll in both modes', () => {
    for (const pegs of [2, 4]) {
      const maxPer = pegs === 2 ? 54 : 62;
      const thr = maxPer + 1;
      for (let dist = 0; dist <= maxPer; dist++) {
        const ok = [1, 2, 3, 4, 5, 6].some(d => {
          const td = dist + d;
          return td <= maxPer || (td - thr) < pegs;
        });
        assert.ok(ok, `${pegs}-peg dist ${dist} has no legal roll`);
      }
    }
  });

  test('apply rejects unknown pieces and actions', () => {
    const s = mk(4, null, jail(0, 4));
    assert.equal(R.serverApplyMove(s, '0-9', 'move', 5), null);
    assert.equal(R.serverApplyMove(s, '0-0', 'fly', 5), null);
  });
});

describe('mercyRoll', () => {
  test('no pity means no mercy, natural 6 never mercy', () => {
    assert.deepEqual(R.mercyRoll(0, () => 3), { value: 3, mercy: false });
    assert.deepEqual(R.mercyRoll(5, () => 6), { value: 6, mercy: false });
  });

  test('pity converts with a rigged coin, both ways', () => {
    const realRandom = Math.random;
    try {
      Math.random = () => 0;
      assert.deepEqual(R.mercyRoll(5, () => 3), { value: 6, mercy: true });
      Math.random = () => 0.999999;
      assert.deepEqual(R.mercyRoll(5, () => 3), { value: 3, mercy: false });
    } finally {
      Math.random = realRandom;
    }
  });

  test('live crypto rolls stay in 1..6 and roughly uniform', () => {
    const counts = [0, 0, 0, 0, 0, 0, 0];
    for (let i = 0; i < 6000; i++) {
      const { value, mercy } = R.mercyRoll(0);
      assert.ok(value >= 1 && value <= 6);
      assert.equal(mercy, false);
      counts[value]++;
    }
    for (let v = 1; v <= 6; v++) {
      assert.ok(counts[v] > 800 && counts[v] < 1200, `face ${v}: ${counts[v]}`);
    }
  });
});
