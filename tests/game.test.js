import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createGame, updateGame, startMatch, resolvePoint, getMenuItems, MENU_ITEMS,
  POINT_OVER_TIME, GAME_OVER_TIME
} from '../src/game.js';
import { refereeEvent } from '../src/rules.js';
import { TABLE_HALF } from '../src/constants.js';

const DT = 1 / 60;

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function idle() {
  return {
    connected: true, source: 'keyboard', moveX: 0, moveY: 0, aimX: 0, aimY: 0,
    shot: null, shotPressed: null, pausePressed: false
  };
}

function menu(over) {
  const m = { up: false, down: false, left: false, right: false, confirm: false, back: false };
  if (over) for (const k in over) m[k] = over[k];
  return m;
}

function press(game, key) {
  const o = {};
  o[key] = true;
  updateGame(game, DT, [idle(), idle()], menu(o));
}

function run(game, seconds, inputs) {
  const n = Math.round(seconds / DT);
  for (let i = 0; i < n; i++) updateGame(game, DT, inputs || [idle(), idle()], menu());
}

function runUntil(game, pred, maxSeconds, inputs) {
  const n = Math.round(maxSeconds / DT);
  for (let i = 0; i < n; i++) {
    if (pred(game)) return true;
    updateGame(game, DT, inputs || [idle(), idle()], menu());
  }
  return pred(game);
}

function silentAudio() {
  const calls = [];
  return { calls: calls, play: function (n) { calls.push(n); }, setEnabled: function () {}, unlock: function () {} };
}

test('menu: navegação até iniciar partida 1P com melhor de 7', function () {
  const game = createGame({ audio: silentAudio(), rng: mulberry32(1) });
  assert.equal(game.screen, 'title');
  assert.equal(MENU_ITEMS[game.menu.index], 'play');

  // desce (wrap) para "1 Jogador" e confirma -> modo 1p, cursor vai para "Jogar"
  press(game, 'down');
  assert.equal(MENU_ITEMS[game.menu.index], 'mode1p');
  press(game, 'confirm');
  assert.equal(game.mode, '1p');
  assert.equal(MENU_ITEMS[game.menu.index], 'play');

  // sobe até "Partida" e ajusta para 7
  press(game, 'up'); press(game, 'up'); press(game, 'up');
  assert.equal(MENU_ITEMS[game.menu.index], 'bestOf');
  press(game, 'right');
  assert.equal(game.bestOf, 7);
  press(game, 'right');
  assert.equal(game.bestOf, 3);
  press(game, 'left');
  assert.equal(game.bestOf, 7);

  // dificuldade
  press(game, 'down');
  assert.equal(MENU_ITEMS[game.menu.index], 'difficulty');
  press(game, 'right');
  assert.equal(game.difficulty, 'hard');

  // "Como jogar" abre e volta
  press(game, 'down');
  press(game, 'confirm');
  assert.equal(game.menu.view, 'howto');
  press(game, 'back');
  assert.equal(game.menu.view, 'main');
  assert.equal(game.screen, 'title');

  const items = getMenuItems(game);
  assert.equal(items.length, MENU_ITEMS.length);
  assert.equal(items[0].label, '1 Jogador (vs CPU)');

  press(game, 'down');
  assert.equal(MENU_ITEMS[game.menu.index], 'play');
  press(game, 'confirm');
  assert.equal(game.screen, 'playing');
  assert.equal(game.phase, 'serve');
  assert.equal(game.match.bestOf, 7);
  assert.equal(game.ais[0], null);
  assert.ok(game.ais[1], 'jogador 2 deve ser CPU no modo 1P');
  assert.equal(game.names[1], 'CPU');
});

test('menu: modo 2 jogadores sem CPU', function () {
  const game = createGame({ audio: silentAudio(), rng: mulberry32(2) });
  press(game, 'up'); press(game, 'up'); press(game, 'up'); press(game, 'up');
  assert.equal(MENU_ITEMS[game.menu.index], 'mode2p');
  press(game, 'confirm');
  press(game, 'confirm');
  assert.equal(game.screen, 'playing');
  assert.equal(game.mode, '2p');
  assert.equal(game.ais[0], null);
  assert.equal(game.ais[1], null);
});

test('fluxo saque -> rally -> ponto', function () {
  const audio = silentAudio();
  const game = createGame({ audio: audio, rng: mulberry32(3) });
  startMatch(game, { mode: '2p', bestOf: 3, firstServer: 0 });
  assert.equal(game.phase, 'serve');
  assert.equal(game.server, 0);
  const side = game.sides[0];

  // segurando a bola: ela acompanha a raquete do sacador
  run(game, 0.5);
  assert.equal(game.phase, 'serve');
  assert.ok(Math.abs(game.ball.x - game.paddles[0].x) < 0.1);
  assert.ok(game.paddles[0].x * side >= TABLE_HALF);

  const serveIn = idle();
  serveIn.shotPressed = 'drive';
  updateGame(game, DT, [serveIn, idle()], menu());
  assert.equal(game.phase, 'rally');
  assert.ok(game.ball.vx * side < 0, 'bola vai em direção ao oponente');
  assert.ok(audio.calls.indexOf('serve') >= 0);

  const ok = runUntil(game, function (g) { return g.phase === 'pointOver'; }, 12);
  assert.ok(ok, 'o ponto deve terminar');
  assert.ok(game.lastPoint);
  assert.ok(typeof game.lastPoint.text === 'string' && game.lastPoint.text.length > 0);
  if (!game.lastPoint.isLet) {
    assert.equal(game.match.score[0] + game.match.score[1], 1);
  }
  run(game, POINT_OVER_TIME + 0.1);
  assert.equal(game.phase, 'serve');
});

test('let repete o saque sem alterar o placar', function () {
  const game = createGame({ audio: silentAudio(), rng: mulberry32(4) });
  startMatch(game, { mode: '2p', bestOf: 3, firstServer: 1 });
  const serveIn = idle();
  serveIn.shotPressed = 'drive';
  run(game, 0.3);
  updateGame(game, DT, [idle(), serveIn], menu());
  assert.equal(game.phase, 'rally');
  // saque que toca a rede e cai certo no lado do recebedor
  const sSrv = game.rally.sides[1];
  let r = refereeEvent(game.rally, { type: 'bounce', side: sSrv, x: sSrv * 0.6 });
  assert.equal(r, null);
  r = refereeEvent(game.rally, { type: 'net', clip: true });
  assert.equal(r, null);
  r = refereeEvent(game.rally, { type: 'bounce', side: -sSrv, x: -sSrv * 0.6 });
  assert.ok(r && r.let, 'árbitro deve marcar let');
  assert.ok(resolvePoint(game, r));
  assert.equal(game.phase, 'pointOver');
  assert.equal(game.lastPoint.isLet, true);
  assert.deepEqual(game.match.score, [0, 0]);
  run(game, POINT_OVER_TIME + 0.1);
  assert.equal(game.phase, 'serve');
  assert.equal(game.server, 1);
  assert.deepEqual(game.match.score, [0, 0]);
});

test('troca de lados entre games', function () {
  const game = createGame({ audio: silentAudio(), rng: mulberry32(5) });
  startMatch(game, { mode: '2p', bestOf: 3, firstServer: 0 });
  assert.deepEqual(game.sides, [-1, 1]);
  for (let i = 0; i < 11; i++) {
    assert.equal(game.phase, 'serve');
    assert.ok(resolvePoint(game, { winner: 0, reason: 'OUT' }));
    run(game, POINT_OVER_TIME + 0.05);
  }
  assert.equal(game.phase, 'gameOver');
  assert.deepEqual(game.lastGame.score, [11, 0]);
  assert.equal(game.match.gamesWon[0], 1);
  run(game, GAME_OVER_TIME + 0.05);
  assert.equal(game.phase, 'serve');
  assert.deepEqual(game.sides, [1, -1]);
  assert.ok(game.paddles[0].x > 0, 'raquete do J1 agora à direita');
  assert.ok(game.paddles[1].x < 0, 'raquete do J2 agora à esquerda');
  assert.equal(game.server, 1, 'quem sacou primeiro alterna a cada game');
  assert.ok(game.swapNotice > 0);
});

function validGame(h, pointsToWin) {
  const hi = Math.max(h[0], h[1]);
  const lo = Math.min(h[0], h[1]);
  if (hi < pointsToWin) return false;
  if (hi - lo < 2) return false;
  if (hi > pointsToWin && hi - lo !== 2) return false;
  return true;
}

test('partida CPU vs CPU melhor de 3 completa chega a matchOver com placar válido', function () {
  const game = createGame({ audio: silentAudio(), rng: mulberry32(42) });
  startMatch(game, { mode: 'cpu-vs-cpu', bestOf: 3, difficulty: 'hard' });
  assert.equal(game.mode, 'cpu');
  assert.ok(game.ais[0] && game.ais[1]);
  const reasons = {};
  let lastStats = 0;
  const done = runUntil(game, function (g) {
    if (g.stats.points !== lastStats && g.lastPoint) {
      lastStats = g.stats.points;
      reasons[g.lastPoint.reason] = (reasons[g.lastPoint.reason] || 0) + 1;
    }
    return g.screen === 'matchOver';
  }, 3 * 3600);
  assert.ok(done, 'partida deve terminar');
  const m = game.match;
  assert.equal(m.over, true);
  assert.ok(m.winner === 0 || m.winner === 1);
  assert.equal(m.gamesWon[m.winner], 2);
  assert.ok(m.gamesWon[1 - m.winner] <= 1);
  assert.equal(m.history.length, m.gamesWon[0] + m.gamesWon[1]);
  for (let i = 0; i < m.history.length; i++) {
    assert.ok(validGame(m.history[i], 11), 'game inválido: ' + m.history[i].join('-'));
  }
  assert.ok(Object.keys(reasons).length >= 1);
  // a partir do resumo, "Jogar novamente" reinicia
  run(game, 0.6);
  press(game, 'confirm');
  assert.equal(game.screen, 'playing');
  assert.equal(game.match.over, false);
});

test('createGame({autoplay:true}) já começa CPU vs CPU', function () {
  const game = createGame({ audio: silentAudio(), rng: mulberry32(7), autoplay: true, bestOf: 3 });
  assert.equal(game.screen, 'playing');
  assert.equal(game.mode, 'cpu');
  assert.ok(runUntil(game, function (g) { return g.phase === 'rally'; }, 5), 'CPU deve sacar');
});

test('pausa congela o estado', function () {
  const game = createGame({ audio: silentAudio(), rng: mulberry32(8) });
  startMatch(game, { mode: '2p', bestOf: 3, firstServer: 0 });
  run(game, 0.3);
  const serveIn = idle();
  serveIn.shotPressed = 'topspin';
  updateGame(game, DT, [serveIn, idle()], menu());
  run(game, 0.1);
  assert.equal(game.phase, 'rally');

  const p = idle();
  p.pausePressed = true;
  updateGame(game, DT, [p, idle()], menu());
  assert.equal(game.screen, 'paused');
  const snap = JSON.stringify({
    ball: game.ball, paddles: game.paddles, score: game.match.score,
    phase: game.phase, phaseTime: game.phaseTime, rally: game.rally
  });
  const moving = idle();
  moving.moveX = 1; moving.moveY = 1; moving.shot = 'smash';
  run(game, 2, [moving, moving]);
  assert.equal(game.screen, 'paused');
  const snap2 = JSON.stringify({
    ball: game.ball, paddles: game.paddles, score: game.match.score,
    phase: game.phase, phaseTime: game.phaseTime, rally: game.rally
  });
  assert.equal(snap2, snap);

  // Continuar (confirm no item "Continuar")
  press(game, 'confirm');
  assert.equal(game.screen, 'playing');
  const bx = game.ball.x;
  run(game, 0.05);
  assert.notEqual(game.ball.x, bx);

  // Pausar e sair para o menu
  updateGame(game, DT, [idle(), idle()], menu({ back: true }));
  assert.equal(game.screen, 'paused');
  press(game, 'down');
  press(game, 'confirm');
  assert.equal(game.screen, 'title');
});

test('regressão: B do controle (chop) não pausa a partida; voltar do remoto/VIEW pausa', () => {
  const game = createGame({ audio: silentAudio(), rng: mulberry32(7) });
  startMatch(game, { mode: '2p', bestOf: 3, firstServer: 0 });
  // B do gamepad gera menu.back mas não systemBack
  updateGame(game, DT, [idle(), idle()], menu({ back: true, systemBack: false }));
  assert.equal(game.screen, 'playing');
  updateGame(game, DT, [idle(), idle()], menu({ back: true, systemBack: true }));
  assert.equal(game.screen, 'paused');
  // na pausa, B (back) retoma
  updateGame(game, DT, [idle(), idle()], menu({ back: true, systemBack: false }));
  assert.equal(game.screen, 'playing');
});
