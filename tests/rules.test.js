import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  createMatch, awardPoint, getServer, getReceiver, getSide,
  isDeuce, isGamePoint, isMatchPoint, createRally, refereeEvent, REASON_TEXT
} from '../src/rules.js';

// Helpers -------------------------------------------------------------------
function setScore(match, a, b) {
  match.score = [a, b];
}
function winGame(match, player) {
  let r;
  while (true) {
    r = awardPoint(match, player);
    if (r.gameOver) return r;
  }
}
function play(rally, events) {
  let last = null;
  for (let i = 0; i < events.length; i++) {
    last = refereeEvent(rally, events[i]);
    if (last) return { result: last, index: i };
  }
  return { result: last, index: -1 };
}
const hit = (player, x, y) => ({ type: 'hit', player: player, x: x, y: y === undefined ? 0.3 : y });
const bounce = (side, x) => ({ type: 'bounce', side: side, x: x === undefined ? side * 0.7 : x });
const net = (clip) => ({ type: 'net', clip: !!clip });
const floor = (x) => ({ type: 'floor', x: x });

// Default: P0 à esquerda (-1), P1 à direita (+1), P0 saca.
function rally0() {
  return createRally(createMatch());
}
// Saque válido de P0 já em jogo (quicou à esquerda e à direita).
function servedRally() {
  const r = rally0();
  assert.equal(play(r, [hit(0, -1.5), bounce(-1), bounce(1)]).result, null);
  return r;
}

// ---------------------------------------------------------------------------
describe('createMatch', () => {
  test('valores padrão', () => {
    const m = createMatch();
    assert.equal(m.bestOf, 5);
    assert.equal(m.pointsToWin, 11);
    assert.equal(m.changeEnds, true);
    assert.deepEqual(m.score, [0, 0]);
    assert.deepEqual(m.gamesWon, [0, 0]);
    assert.equal(m.gameNumber, 1);
    assert.deepEqual(m.history, []);
    assert.equal(m.firstServerOfGame, 0);
    assert.equal(m.firstServerOfMatch, 0);
    assert.equal(m.endsSwapped, false);
    assert.equal(m.deciderSwapDone, false);
    assert.equal(m.over, false);
    assert.equal(m.winner, null);
  });
  test('opções', () => {
    const m = createMatch({ bestOf: 3, pointsToWin: 21, firstServer: 1, changeEnds: false });
    assert.equal(m.bestOf, 3);
    assert.equal(m.pointsToWin, 21);
    assert.equal(m.firstServerOfGame, 1);
    assert.equal(m.firstServerOfMatch, 1);
    assert.equal(m.changeEnds, false);
  });
});

describe('placar e game', () => {
  test('awardPoint incrementa e retorna formato', () => {
    const m = createMatch();
    const r = awardPoint(m, 1);
    assert.deepEqual(m.score, [0, 1]);
    assert.deepEqual(r, { gameOver: false, matchOver: false, gameWinner: null, swapEnds: false });
  });
  test('11-0 vence o game', () => {
    const m = createMatch();
    for (let i = 0; i < 10; i++) assert.equal(awardPoint(m, 0).gameOver, false);
    const r = awardPoint(m, 0);
    assert.equal(r.gameOver, true);
    assert.equal(r.gameWinner, 0);
    assert.equal(r.matchOver, false);
    assert.equal(r.swapEnds, true);
    assert.deepEqual(m.gamesWon, [1, 0]);
    assert.deepEqual(m.history, [[11, 0]]);
    assert.deepEqual(m.score, [0, 0]);
    assert.equal(m.gameNumber, 2);
  });
  test('11-9 vence; 11-10 não vence', () => {
    const m = createMatch();
    setScore(m, 10, 9);
    assert.equal(awardPoint(m, 0).gameOver, true);
    assert.deepEqual(m.history, [[11, 9]]);
    const m2 = createMatch();
    setScore(m2, 10, 10);
    assert.equal(awardPoint(m2, 0).gameOver, false);
    assert.deepEqual(m2.score, [11, 10]);
  });
  test('deuce prolongado: vence com 2 de vantagem', () => {
    const m = createMatch();
    setScore(m, 10, 10);
    awardPoint(m, 0); // 11-10
    awardPoint(m, 1); // 11-11
    awardPoint(m, 1); // 11-12
    awardPoint(m, 0); // 12-12
    assert.equal(awardPoint(m, 1).gameOver, false); // 12-13
    const r = awardPoint(m, 1); // 12-14
    assert.equal(r.gameOver, true);
    assert.equal(r.gameWinner, 1);
    assert.deepEqual(m.history, [[12, 14]]);
  });
  test('pontos depois do fim do match são ignorados', () => {
    const m = createMatch({ bestOf: 1 });
    const r = winGame(m, 1);
    assert.equal(r.matchOver, true);
    const r2 = awardPoint(m, 0);
    assert.deepEqual(r2, { gameOver: false, matchOver: false, gameWinner: null, swapEnds: false });
    assert.deepEqual(m.gamesWon, [0, 1]);
  });
  test('jogador inválido é ignorado', () => {
    const m = createMatch();
    awardPoint(m, 2);
    assert.deepEqual(m.score, [0, 0]);
  });
});

describe('isDeuce / isGamePoint / isMatchPoint', () => {
  test('isDeuce', () => {
    const m = createMatch();
    setScore(m, 9, 10);
    assert.equal(isDeuce(m), false);
    setScore(m, 10, 10);
    assert.equal(isDeuce(m), true);
    setScore(m, 12, 11);
    assert.equal(isDeuce(m), true);
  });
  test('isGamePoint', () => {
    const m = createMatch();
    assert.equal(isGamePoint(m), null);
    setScore(m, 10, 3);
    assert.equal(isGamePoint(m), 0);
    setScore(m, 9, 10);
    assert.equal(isGamePoint(m), 1);
    setScore(m, 10, 10);
    assert.equal(isGamePoint(m), null);
    setScore(m, 11, 10);
    assert.equal(isGamePoint(m), 0);
    setScore(m, 13, 14);
    assert.equal(isGamePoint(m), 1);
    setScore(m, 9, 9);
    assert.equal(isGamePoint(m), null);
  });
  test('isMatchPoint', () => {
    const m = createMatch({ bestOf: 5 });
    setScore(m, 10, 5);
    assert.equal(isMatchPoint(m), null); // 0 games
    m.gamesWon = [2, 0];
    assert.equal(isMatchPoint(m), 0);
    m.gamesWon = [1, 2];
    assert.equal(isMatchPoint(m), null); // P0 tem game point mas não match point
    setScore(m, 5, 10);
    assert.equal(isMatchPoint(m), 1);
  });
  test('isMatchPoint melhor de 3 e 7', () => {
    const m3 = createMatch({ bestOf: 3 });
    m3.gamesWon = [1, 0];
    setScore(m3, 10, 0);
    assert.equal(isMatchPoint(m3), 0);
    const m7 = createMatch({ bestOf: 7 });
    m7.gamesWon = [3, 0];
    setScore(m7, 10, 0);
    assert.equal(isMatchPoint(m7), 0);
    m7.gamesWon = [2, 0];
    assert.equal(isMatchPoint(m7), null);
  });
});

describe('rotação de saque', () => {
  test('troca a cada 2 pontos no início', () => {
    const m = createMatch();
    const seq = [];
    for (let i = 0; i < 10; i++) {
      seq.push(getServer(m));
      awardPoint(m, i % 2);
    }
    assert.deepEqual(seq, [0, 0, 1, 1, 0, 0, 1, 1, 0, 0]);
  });
  test('getReceiver é o oposto', () => {
    const m = createMatch();
    assert.equal(getReceiver(m), 1);
    setScore(m, 1, 1);
    assert.equal(getServer(m), 1);
    assert.equal(getReceiver(m), 0);
  });
  test('placar arbitrário', () => {
    const m = createMatch();
    setScore(m, 5, 3); // 8 pontos -> 4 trocas -> P0
    assert.equal(getServer(m), 0);
    setScore(m, 6, 3); // 9 -> P0
    assert.equal(getServer(m), 0);
    setScore(m, 7, 3); // 10 -> P1
    assert.equal(getServer(m), 1);
    setScore(m, 10, 9); // 19 -> 9 trocas -> P1
    assert.equal(getServer(m), 1);
    setScore(m, 9, 10);
    assert.equal(getServer(m), 1);
  });
  test('a partir de 10-10 troca a cada ponto', () => {
    const m = createMatch();
    setScore(m, 10, 10);
    assert.equal(getServer(m), 0);
    setScore(m, 11, 10);
    assert.equal(getServer(m), 1);
    setScore(m, 11, 11);
    assert.equal(getServer(m), 0);
    setScore(m, 12, 11);
    assert.equal(getServer(m), 1);
    setScore(m, 12, 12);
    assert.equal(getServer(m), 0);
    setScore(m, 12, 13);
    assert.equal(getServer(m), 1);
  });
  test('deuce jogado ponto a ponto', () => {
    const m = createMatch();
    for (let i = 0; i < 10; i++) { awardPoint(m, 0); awardPoint(m, 1); }
    assert.deepEqual(m.score, [10, 10]);
    const seq = [];
    const winners = [0, 1, 1, 0, 0, 1];
    for (let i = 0; i < winners.length; i++) {
      seq.push(getServer(m));
      awardPoint(m, winners[i]);
    }
    assert.deepEqual(seq, [0, 1, 0, 1, 0, 1]);
  });
  test('primeiro sacador alterna por game', () => {
    const m = createMatch({ bestOf: 7 });
    assert.equal(getServer(m), 0);
    winGame(m, 0);
    assert.equal(m.gameNumber, 2);
    assert.equal(m.firstServerOfGame, 1);
    assert.equal(getServer(m), 1);
    setScore(m, 1, 1);
    assert.equal(getServer(m), 0);
    setScore(m, 10, 10);
    assert.equal(getServer(m), 1);
    setScore(m, 11, 10);
    assert.equal(getServer(m), 0);
    setScore(m, 0, 0);
    winGame(m, 1);
    assert.equal(m.gameNumber, 3);
    assert.equal(m.firstServerOfGame, 0);
    assert.equal(getServer(m), 0);
    setScore(m, 2, 0);
    assert.equal(getServer(m), 1);
    setScore(m, 0, 0);
    winGame(m, 1);
    assert.equal(m.firstServerOfGame, 1);
  });
  test('firstServer = 1 no match', () => {
    const m = createMatch({ firstServer: 1 });
    assert.equal(getServer(m), 1);
    setScore(m, 2, 0);
    assert.equal(getServer(m), 0);
    setScore(m, 0, 0);
    winGame(m, 0);
    assert.equal(getServer(m), 0);
    winGame(m, 0);
    assert.equal(getServer(m), 1);
  });
});

describe('troca de lados', () => {
  test('getSide inicial e trocado', () => {
    const m = createMatch();
    assert.equal(getSide(m, 0), -1);
    assert.equal(getSide(m, 1), 1);
    m.endsSwapped = true;
    assert.equal(getSide(m, 0), 1);
    assert.equal(getSide(m, 1), -1);
  });
  test('troca após cada game', () => {
    const m = createMatch({ bestOf: 7 });
    let r = winGame(m, 0);
    assert.equal(r.swapEnds, true);
    assert.equal(m.endsSwapped, true);
    assert.equal(getSide(m, 0), 1);
    r = winGame(m, 1);
    assert.equal(r.swapEnds, true);
    assert.equal(m.endsSwapped, false);
  });
  test('sem changeEnds nunca troca', () => {
    const m = createMatch({ bestOf: 3, changeEnds: false });
    let r = winGame(m, 0);
    assert.equal(r.swapEnds, false);
    r = winGame(m, 1);
    assert.equal(r.swapEnds, false);
    for (let i = 0; i < 5; i++) r = awardPoint(m, 0);
    assert.equal(r.swapEnds, false);
    assert.equal(m.endsSwapped, false);
    assert.equal(m.deciderSwapDone, false);
  });
  test('game decisivo troca aos 5 pontos, apenas uma vez', () => {
    const m = createMatch({ bestOf: 3 });
    winGame(m, 0);
    winGame(m, 1);
    assert.equal(m.gameNumber, 3);
    assert.equal(m.endsSwapped, false);
    let r;
    for (let i = 0; i < 4; i++) {
      r = awardPoint(m, 1);
      assert.equal(r.swapEnds, false);
    }
    r = awardPoint(m, 0); // 1-4
    assert.equal(r.swapEnds, false);
    r = awardPoint(m, 1); // 1-5
    assert.equal(r.swapEnds, true);
    assert.equal(m.endsSwapped, true);
    assert.equal(m.deciderSwapDone, true);
    for (let i = 0; i < 4; i++) {
      r = awardPoint(m, 0); // P0 chega a 5: não troca de novo
      assert.equal(r.swapEnds, false);
    }
    assert.deepEqual(m.score, [5, 5]);
    assert.equal(m.endsSwapped, true);
  });
  test('sem troca aos 5 pontos em games não decisivos', () => {
    const m = createMatch({ bestOf: 5 });
    let r;
    for (let i = 0; i < 5; i++) r = awardPoint(m, 0);
    assert.equal(r.swapEnds, false);
    assert.equal(m.endsSwapped, false);
  });
  test('game decisivo no melhor de 5 e 7', () => {
    const m5 = createMatch({ bestOf: 5 });
    winGame(m5, 0); winGame(m5, 1); winGame(m5, 0); winGame(m5, 1);
    assert.equal(m5.gameNumber, 5);
    assert.equal(m5.endsSwapped, false); // 4 trocas
    let r;
    for (let i = 0; i < 5; i++) r = awardPoint(m5, 0);
    assert.equal(r.swapEnds, true);
    assert.equal(m5.endsSwapped, true);

    const m7 = createMatch({ bestOf: 7 });
    for (let g = 0; g < 6; g++) winGame(m7, g % 2);
    assert.equal(m7.gameNumber, 7);
    for (let i = 0; i < 4; i++) r = awardPoint(m7, 1);
    assert.equal(r.swapEnds, false);
    r = awardPoint(m7, 1);
    assert.equal(r.swapEnds, true);
  });
  test('último game que encerra o match não pede troca', () => {
    const m = createMatch({ bestOf: 3 });
    winGame(m, 0);
    const r = winGame(m, 0);
    assert.equal(r.matchOver, true);
    assert.equal(r.swapEnds, false);
  });
  test('createRally usa os lados trocados', () => {
    const m = createMatch();
    winGame(m, 0);
    const r = createRally(m);
    assert.equal(r.sides[0], 1);
    assert.equal(r.sides[1], -1);
    assert.equal(r.server, 1);
    assert.equal(r.receiver, 0);
  });
});

describe('match melhor de N', () => {
  test('melhor de 3: 2 games vencem', () => {
    const m = createMatch({ bestOf: 3 });
    let r = winGame(m, 1);
    assert.equal(r.matchOver, false);
    r = winGame(m, 0);
    assert.equal(r.matchOver, false);
    r = winGame(m, 1);
    assert.equal(r.matchOver, true);
    assert.equal(m.over, true);
    assert.equal(m.winner, 1);
    assert.deepEqual(m.gamesWon, [1, 2]);
    assert.equal(m.history.length, 3);
    assert.equal(m.gameNumber, 3);
  });
  test('melhor de 5: 3 games vencem', () => {
    const m = createMatch({ bestOf: 5 });
    winGame(m, 0); winGame(m, 0);
    assert.equal(m.over, false);
    const r = winGame(m, 0);
    assert.equal(r.matchOver, true);
    assert.equal(m.winner, 0);
    assert.deepEqual(m.history, [[11, 0], [11, 0], [11, 0]]);
  });
  test('melhor de 7: 4 games vencem', () => {
    const m = createMatch({ bestOf: 7 });
    for (let i = 0; i < 3; i++) { winGame(m, 0); winGame(m, 1); }
    assert.deepEqual(m.gamesWon, [3, 3]);
    assert.equal(m.over, false);
    const r = winGame(m, 1);
    assert.equal(r.matchOver, true);
    assert.equal(r.gameWinner, 1);
    assert.equal(m.winner, 1);
  });
});

// ---------------------------------------------------------------------------
describe('árbitro: estrutura', () => {
  test('createRally', () => {
    const r = rally0();
    assert.equal(r.server, 0);
    assert.equal(r.receiver, 1);
    assert.deepEqual(r.sides, { 0: -1, 1: 1 });
    assert.equal(r.phase, 'awaitServe');
    assert.equal(r.result, null);
  });
  test('REASON_TEXT cobre todos os códigos', () => {
    const codes = ['SERVE_FAULT', 'SERVE_NET', 'OUT', 'NET', 'OWN_SIDE', 'DOUBLE_BOUNCE',
      'MISS', 'OBSTRUCTION', 'DOUBLE_HIT', 'LET'];
    for (const c of codes) {
      assert.equal(typeof REASON_TEXT[c], 'string', c);
      assert.ok(REASON_TEXT[c].length > 0);
    }
    assert.equal(REASON_TEXT.OUT, 'Bola fora');
    assert.equal(REASON_TEXT.DOUBLE_BOUNCE, 'Dois quiques');
    assert.equal(REASON_TEXT.OBSTRUCTION, 'Obstrução');
    assert.equal(REASON_TEXT.NET, 'Rede');
    assert.equal(REASON_TEXT.LET, 'Let — repetir saque');
  });
  test('após decisão, eventos seguintes retornam null e result é mantido', () => {
    const r = rally0();
    const res = play(r, [hit(0, -1.5), bounce(1)]).result;
    assert.deepEqual(res, { winner: 1, reason: 'SERVE_FAULT' });
    assert.equal(r.phase, 'over');
    assert.equal(refereeEvent(r, bounce(1)), null);
    assert.equal(refereeEvent(r, floor(2)), null);
    assert.equal(refereeEvent(r, hit(1, 1.5)), null);
    assert.deepEqual(r.result, { winner: 1, reason: 'SERVE_FAULT' });
  });
  test('let também encerra o rally', () => {
    const r = rally0();
    const res = play(r, [hit(0, -1.5), bounce(-1), net(true), bounce(1)]).result;
    assert.deepEqual(res, { let: true, reason: 'LET' });
    assert.equal(refereeEvent(r, bounce(1)), null);
    assert.deepEqual(r.result, { let: true, reason: 'LET' });
  });
  test('evento desconhecido ou nulo é ignorado', () => {
    const r = rally0();
    assert.equal(refereeEvent(r, null), null);
    assert.equal(refereeEvent(r, { type: 'whatever' }), null);
    assert.equal(r.phase, 'awaitServe');
  });
});

describe('árbitro: saque', () => {
  test('saque válido coloca bola em jogo', () => {
    const r = servedRally();
    assert.equal(r.phase, 'rally');
    assert.equal(r.result, null);
  });
  test('saque que quica direto no lado do recebedor = falta', () => {
    const r = rally0();
    assert.deepEqual(play(r, [hit(0, -1.5), bounce(1)]).result, { winner: 1, reason: 'SERVE_FAULT' });
  });
  test('saque que quica duas vezes no lado do sacador = falta', () => {
    const r = rally0();
    assert.deepEqual(play(r, [hit(0, -1.5), bounce(-1), bounce(-1)]).result,
      { winner: 1, reason: 'SERVE_FAULT' });
  });
  test('saque que vai direto ao chão = falta', () => {
    const r = rally0();
    assert.deepEqual(play(r, [hit(0, -1.5), floor(-1.6)]).result, { winner: 1, reason: 'SERVE_FAULT' });
  });
  test('saque que quica no próprio lado e sai pela lateral/fundo = falta', () => {
    const r = rally0();
    assert.deepEqual(play(r, [hit(0, -1.5), bounce(-1), floor(2.0)]).result,
      { winner: 1, reason: 'SERVE_FAULT' });
  });
  test('saque que toca a rede e cai certo = let', () => {
    const r = rally0();
    assert.deepEqual(play(r, [hit(0, -1.5), bounce(-1), net(true), bounce(1)]).result,
      { let: true, reason: 'LET' });
  });
  test('saque que toca a rede e vai fora = SERVE_NET', () => {
    const r = rally0();
    assert.deepEqual(play(r, [hit(0, -1.5), bounce(-1), net(true), floor(2.0)]).result,
      { winner: 1, reason: 'SERVE_NET' });
  });
  test('saque que bate na rede e volta para o lado do sacador = SERVE_NET', () => {
    const r = rally0();
    assert.deepEqual(play(r, [hit(0, -1.5), bounce(-1), net(false), bounce(-1)]).result,
      { winner: 1, reason: 'SERVE_NET' });
  });
  test('saque que bate na rede e cai no chão = SERVE_NET', () => {
    const r = rally0();
    assert.deepEqual(play(r, [hit(0, -1.5), bounce(-1), net(false), floor(-0.2)]).result,
      { winner: 1, reason: 'SERVE_NET' });
  });
  test('saque que toca a rede sem quicar no próprio lado e cai do outro = falta', () => {
    const r = rally0();
    assert.deepEqual(play(r, [hit(0, -1.5), net(true), bounce(1)]).result,
      { winner: 1, reason: 'SERVE_FAULT' });
  });
  test('saque do jogador 1 pelo lado direito', () => {
    const m = createMatch({ firstServer: 1 });
    const r = createRally(m);
    assert.equal(r.server, 1);
    assert.equal(play(r, [hit(1, 1.5), bounce(1), bounce(-1)]).result, null);
    assert.equal(r.phase, 'rally');
    const r2 = createRally(m);
    assert.deepEqual(play(r2, [hit(1, 1.5), bounce(-1)]).result, { winner: 0, reason: 'SERVE_FAULT' });
  });
  test('saque com lados trocados', () => {
    const m = createMatch();
    m.endsSwapped = true;
    const r = createRally(m);
    assert.equal(r.server, 0);
    assert.equal(play(r, [hit(0, 1.5), bounce(1), bounce(-1)]).result, null);
    const r2 = createRally(m);
    assert.deepEqual(play(r2, [hit(0, 1.5), bounce(-1)]).result, { winner: 1, reason: 'SERVE_FAULT' });
  });
  test('sacador bate duas vezes no saque = DOUBLE_HIT', () => {
    const r = rally0();
    assert.deepEqual(play(r, [hit(0, -1.5), hit(0, -1.4)]).result, { winner: 1, reason: 'DOUBLE_HIT' });
  });
  test('recebedor volea o saque sobre a mesa = obstrução', () => {
    const r = rally0();
    assert.deepEqual(play(r, [hit(0, -1.5), bounce(-1), hit(1, 0.8)]).result,
      { winner: 0, reason: 'OBSTRUCTION' });
  });
  test('recebedor rebate o saque além da linha de fundo = ponto do recebedor', () => {
    const r = rally0();
    assert.deepEqual(play(r, [hit(0, -1.5), bounce(-1), hit(1, 1.6)]).result,
      { winner: 1, reason: 'SERVE_FAULT' });
  });
  test('recebedor volea saque que tocou a rede = let', () => {
    const r = rally0();
    assert.deepEqual(play(r, [hit(0, -1.5), bounce(-1), net(true), hit(1, 0.5)]).result,
      { let: true, reason: 'LET' });
  });
  test('recebedor toca a bola antes do saque = ponto do sacador', () => {
    const r = rally0();
    assert.deepEqual(play(r, [hit(1, 1.5)]).result, { winner: 0, reason: 'OBSTRUCTION' });
  });
  test('sacador erra a bola (cai no chão sem golpe) = ponto do recebedor', () => {
    const r = rally0();
    assert.deepEqual(play(r, [floor(-1.6)]).result, { winner: 1, reason: 'MISS' });
  });
  test('net antes do golpe de saque é ignorado', () => {
    const r = rally0();
    assert.equal(refereeEvent(r, net(true)), null);
    assert.equal(r.phase, 'awaitServe');
  });
});

describe('árbitro: rally', () => {
  test('troca de bola válida longa', () => {
    const r = servedRally();
    const res = play(r, [
      hit(1, 1.5), bounce(-1),
      hit(0, -1.5), net(true), bounce(1),
      hit(1, 1.4), bounce(-1),
      hit(0, -1.6), bounce(1)
    ]).result;
    assert.equal(res, null);
    assert.equal(r.lastHitter, 0);
    assert.equal(r.phase, 'rally');
  });
  test('recebedor não devolve: dois quiques = ponto do sacador', () => {
    const r = servedRally();
    assert.deepEqual(refereeEvent(r, bounce(1)), { winner: 0, reason: 'DOUBLE_BOUNCE' });
  });
  test('recebedor não devolve: bola vai ao chão = MISS ponto de quem bateu', () => {
    const r = servedRally();
    assert.deepEqual(refereeEvent(r, floor(2.2)), { winner: 0, reason: 'MISS' });
  });
  test('devolução fora (não quica no lado do oponente) = OUT', () => {
    const r = servedRally();
    assert.deepEqual(play(r, [hit(1, 1.5), floor(-2.5)]).result, { winner: 0, reason: 'OUT' });
  });
  test('devolução na rede caindo no chão = NET', () => {
    const r = servedRally();
    assert.deepEqual(play(r, [hit(1, 1.5), net(false), floor(0.3)]).result, { winner: 0, reason: 'NET' });
  });
  test('devolução na rede voltando para o próprio lado = NET', () => {
    const r = servedRally();
    assert.deepEqual(play(r, [hit(1, 1.5), net(false), bounce(1)]).result, { winner: 0, reason: 'NET' });
  });
  test('rede raspando e caindo do outro lado continua em jogo', () => {
    const r = servedRally();
    assert.equal(play(r, [hit(1, 1.5), net(true), bounce(-1)]).result, null);
    assert.deepEqual(refereeEvent(r, bounce(-1)), { winner: 1, reason: 'DOUBLE_BOUNCE' });
  });
  test('rede raspando e indo fora = NET', () => {
    const r = servedRally();
    assert.deepEqual(play(r, [hit(1, 1.5), net(true), floor(-2.0)]).result, { winner: 0, reason: 'NET' });
  });
  test('quique no próprio lado após o próprio golpe = OWN_SIDE', () => {
    const r = servedRally();
    assert.deepEqual(play(r, [hit(1, 1.5), bounce(1)]).result, { winner: 0, reason: 'OWN_SIDE' });
  });
  test('bola que quica no oponente e volta para o lado de quem bateu = MISS', () => {
    const r = servedRally();
    assert.deepEqual(play(r, [hit(1, 1.5), bounce(-1), net(true), bounce(1)]).result,
      { winner: 1, reason: 'MISS' });
  });
  test('obstrução: voleio com a bola sobre a mesa', () => {
    const r = servedRally();
    assert.deepEqual(play(r, [hit(1, 1.5), hit(0, -0.9)]).result, { winner: 1, reason: 'OBSTRUCTION' });
  });
  test('obstrução no limite exato da mesa', () => {
    const r = servedRally();
    assert.deepEqual(play(r, [hit(1, 1.5), hit(0, -1.37)]).result, { winner: 1, reason: 'OBSTRUCTION' });
  });
  test('voleio além da linha de fundo = bola era fora, ponto de quem rebateu', () => {
    const r = servedRally();
    assert.deepEqual(play(r, [hit(1, 1.5), hit(0, -1.5)]).result, { winner: 0, reason: 'OUT' });
  });
  test('voleio além da linha de fundo após rede', () => {
    const r = servedRally();
    assert.deepEqual(play(r, [hit(1, 1.5), net(true), hit(0, -1.6)]).result, { winner: 0, reason: 'OUT' });
  });
  test('double hit: mesmo jogador bate duas vezes seguidas', () => {
    const r = servedRally();
    assert.deepEqual(play(r, [hit(1, 1.5), hit(1, 1.3)]).result, { winner: 0, reason: 'DOUBLE_HIT' });
  });
  test('fora de vez: sacador rebate a bola que quicou do lado do recebedor', () => {
    const r = servedRally();
    assert.deepEqual(refereeEvent(r, hit(0, 0.5)), { winner: 1, reason: 'DOUBLE_HIT' });
  });
  test('fora de vez após golpe válido do oponente', () => {
    const r = servedRally();
    assert.deepEqual(play(r, [hit(1, 1.5), bounce(-1), hit(1, -0.5)]).result,
      { winner: 0, reason: 'DOUBLE_HIT' });
  });
  test('rally com lados trocados', () => {
    const m = createMatch();
    m.endsSwapped = true;
    const r = createRally(m);
    // P0 está à direita (+1) e saca.
    assert.equal(play(r, [hit(0, 1.5), bounce(1), bounce(-1), hit(1, -1.5), bounce(1)]).result, null);
    assert.deepEqual(refereeEvent(r, bounce(1)), { winner: 1, reason: 'DOUBLE_BOUNCE' });
    const r2 = createRally(m);
    assert.deepEqual(play(r2, [hit(0, 1.5), bounce(1), bounce(-1), hit(1, -1.5), bounce(-1)]).result,
      { winner: 0, reason: 'OWN_SIDE' });
  });
  test('ponto completo integrado com o placar', () => {
    const m = createMatch();
    const r = createRally(m);
    const res = play(r, [hit(0, -1.5), bounce(-1), bounce(1), hit(1, 1.5), floor(-2.6)]).result;
    assert.deepEqual(res, { winner: 0, reason: 'OUT' });
    awardPoint(m, res.winner);
    assert.deepEqual(m.score, [1, 0]);
    assert.equal(createRally(m).server, 0);
    awardPoint(m, 1);
    assert.equal(createRally(m).server, 1);
  });
});
