import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createGame, updateGame, startMatch, resolvePoint, getMenuItems, MENU_ITEMS,
  POINT_OVER_TIME, GAME_OVER_TIME, computeAim, updateBounceHint
} from '../src/game.js';
import { refereeEvent } from '../src/rules.js';
import { TABLE_HALF, TABLE_W_HALF } from '../src/constants.js';

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
  press(game, 'up'); press(game, 'up'); press(game, 'up'); press(game, 'up');
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

  // "Ajuda de quique": padrão Sim, alterna com ◀ ▶ e A
  press(game, 'down');
  assert.equal(MENU_ITEMS[game.menu.index], 'bounceHelp');
  assert.equal(game.bounceHelp, true);
  let hi = getMenuItems(game)[game.menu.index];
  assert.equal(hi.label, 'Ajuda de quique');
  assert.equal(hi.value, 'Sim');
  press(game, 'right');
  assert.equal(game.bounceHelp, false);
  assert.equal(getMenuItems(game)[game.menu.index].value, 'Não');
  press(game, 'confirm');
  assert.equal(game.bounceHelp, true);

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
  for (let i = 0; i < 5; i++) press(game, 'up');
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
  assert.equal(typeof game.ball.z, 'number');
  assert.equal(typeof game.paddles[0].z, 'number');
  assert.ok(Math.abs(game.ball.z - game.paddles[0].z) < 0.3, 'bola na mão perto da raquete (z)');

  const serveIn = idle();
  serveIn.shotPressed = 'drive';
  updateGame(game, DT, [serveIn, idle()], menu());
  assert.equal(game.phase, 'rally');
  assert.ok(game.ball.vx * side < 0, 'bola vai em direção ao oponente');
  assert.equal(typeof game.ball.vz, 'number');
  assert.ok(game.rally && game.lastHitter === 0);
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

test('mapeamento de controle: moveY move a raquete em x do mundo e moveX em z, igual nos dois lados', function () {
  const game = createGame({ audio: silentAudio(), rng: mulberry32(11) });
  startMatch(game, { mode: '2p', bestOf: 3, firstServer: 0 });
  for (let pass = 0; pass < 2; pass++) {
    // pass 1: depois da troca de lados
    if (pass === 1) {
      for (let i = 0; i < 11; i++) {
        resolvePoint(game, { winner: 0, reason: 'OUT' });
        run(game, POINT_OVER_TIME + 0.05);
      }
      run(game, GAME_OVER_TIME + 0.05);
      assert.deepEqual(game.sides, [1, -1]);
    }
    for (let p = 0; p < 2; p++) {
      const pad = game.paddles[p];
      // começa no meio da zona para ter espaço nas duas direções
      pad.x = game.sides[p] * 1.9; pad.z = 0; pad.vx = 0; pad.vz = 0;
      const up = idle(); up.moveY = 1;
      const ins = [idle(), idle()]; ins[p] = up;
      const x0 = pad.x; const z0 = pad.z; const other = game.paddles[1 - p];
      const ox = other.x; const oz = other.z;
      run(game, 0.15, ins);
      assert.ok(pad.x > x0 + 0.05, 'p' + p + ' lado ' + game.sides[p] + ': cima deveria aumentar x (' + x0 + ' -> ' + pad.x + ')');
      assert.ok(Math.abs(pad.z - z0) < 0.02, 'cima não deveria mexer em z');
      assert.ok(Math.abs(other.x - ox) < 1e-9 && Math.abs(other.z - oz) < 1e-9, 'o outro jogador não se mexe');
      run(game, 0.3);
      const right = idle(); right.moveX = 1;
      ins[p] = right;
      const x1 = pad.x; const z1 = pad.z;
      run(game, 0.15, ins);
      assert.ok(pad.z > z1 + 0.05, 'direita deveria aumentar z');
      assert.ok(Math.abs(pad.x - x1) < 0.02, 'direita não deveria mexer em x');
      const left = idle(); left.moveX = -1;
      ins[p] = left;
      run(game, 0.5, ins);
      assert.ok(pad.z < z1, 'esquerda deveria diminuir z');
      run(game, 0.3);
    }
  }
});

test('mapeamento também vale no rally (com altura automática da raquete)', function () {
  const game = createGame({ audio: silentAudio(), rng: mulberry32(12) });
  startMatch(game, { mode: '2p', bestOf: 3, firstServer: 0 });
  run(game, 0.3);
  const s = idle(); s.shotPressed = 'drive';
  updateGame(game, DT, [s, idle()], menu());
  assert.equal(game.phase, 'rally');
  const rcv = game.paddles[1];
  const x0 = rcv.x; const z0 = rcv.z;
  const down = idle(); down.moveY = -1; down.moveX = 1; // receptor (em cima) vai para trás e para a direita
  run(game, 0.1, [idle(), down]);
  assert.ok(rcv.x < x0, 'baixo deveria diminuir x também para o jogador de cima');
  assert.ok(rcv.z > z0, 'direita deveria aumentar z também para o jogador de cima');
  assert.ok(rcv.y > -0.5 && rcv.y < 1.3, 'altura automática dentro da zona');
});

test('mira: stick direito se |RS|>0.3, senão stick esquerdo; depth = aimY * -side', function () {
  const inp = idle();
  inp.moveX = 0.5; inp.moveY = 1; inp.aimX = 0.1; inp.aimY = 0.1;
  let a = computeAim(inp, -1);
  assert.equal(a.lateral, 0.5);
  assert.equal(a.depth, 1, 'jogador de baixo: cima = mais fundo');
  a = computeAim(inp, 1);
  assert.equal(a.depth, -1, 'jogador de cima: cima = mais curto');
  inp.aimX = -0.8; inp.aimY = -0.6;
  a = computeAim(inp, 1);
  assert.equal(a.lateral, -0.8);
  assert.ok(Math.abs(a.depth - 0.6) < 1e-9);
  const out = { lateral: 0, depth: 0 };
  assert.equal(computeAim(inp, -1, out), out, 'reutiliza objeto (sem alocação)');
});

test('evento hit enviado ao árbitro inclui z; ajuda de quique prevê ponto no lado do recebedor', function () {
  const game = createGame({ audio: silentAudio(), rng: mulberry32(13) });
  startMatch(game, { mode: '2p', bestOf: 3, firstServer: 0 });
  run(game, 0.3);
  const s = idle(); s.shotPressed = 'drive';
  updateGame(game, DT, [s, idle()], menu());
  assert.equal(game.phase, 'rally');
  const hitFx = game.effects.filter(function (e) { return e.type === 'hit'; });
  assert.ok(hitFx.length >= 1 && typeof hitFx[0].z === 'number', 'efeito de golpe com z');
  const h = game.bounceHint;
  assert.ok(h, 'deve haver ponto de quique previsto');
  assert.equal(h.side, game.sides[1], 'no lado do recebedor');
  assert.equal(h.player, 1);
  assert.ok(Math.abs(h.x) <= TABLE_HALF + 1e-6 && Math.abs(h.z) <= TABLE_W_HALF + 1e-6);
  // desligado: sem previsão
  game.bounceHelp = false;
  assert.equal(updateBounceHint(game), null);
  assert.equal(game.bounceHint, null);
});

test('game.stats e mudança de lados mantêm z coerente; CPU x CPU registra golpes', function () {
  const game = createGame({ audio: silentAudio(), rng: mulberry32(21) });
  startMatch(game, { mode: 'cpu-vs-cpu', bestOf: 3 });
  runUntil(game, function (g) { return g.stats.points >= 6; }, 600);
  assert.ok(game.stats.points >= 6);
  assert.ok(game.stats.totalHits >= game.stats.points, 'cada ponto tem ao menos o saque');
  assert.ok(game.stats.longestRally >= 1);
  assert.ok(Object.keys(game.stats.reasons).length >= 1);
  for (let p = 0; p < 2; p++) assert.ok(isFinite(game.paddles[p].z));
});
