// Máquina de estados do jogo (lógica pura, sem DOM). Roda no Node para testes.
// Sintaxe compatível com navegadores antigos de TV (sem ?. ?? campos de classe etc.).
import { TABLE_HALF, PHYSICS_DT, FLOOR_Y, SIDE_LEFT, SIDE_RIGHT } from './constants.js';
import {
  createMatch, awardPoint, getServer, getSide, createRally, refereeEvent, REASON_TEXT
} from './rules.js';
import { createBall, stepBall, movePaddle } from './physics.js';
import { canHit, computeShot, computeServe } from './shot.js';
import { createAI, updateAI } from './ai.js';

// Durações (s)
export const POINT_OVER_TIME = 1.6;
export const GAME_OVER_TIME = 3;
export const HIT_COOLDOWN = 0.15;
export const STALL_TIME = 6;
export const MAX_FRAME_DT = 0.1;
export const MAX_STEPS_PER_UPDATE = 60;
const SWAP_NOTICE_TIME = 2.4;
const MAX_EFFECTS = 48;

export const BEST_OF_OPTIONS = [3, 5, 7];
export const DIFFICULTIES = ['easy', 'normal', 'hard'];
export const DIFFICULTY_TEXT = { easy: 'Fácil', normal: 'Normal', hard: 'Difícil' };

export const MENU_ITEMS = ['mode1p', 'mode2p', 'bestOf', 'difficulty', 'howto', 'play'];
export const PAUSE_ITEMS = ['resume', 'quit'];
export const MATCH_OVER_ITEMS = ['again', 'menu'];

function emptyInput() {
  return {
    connected: false, source: 'none', moveX: 0, moveY: 0, aimX: 0, aimY: 0,
    shot: null, shotPressed: null, pausePressed: false
  };
}
const NO_INPUT = emptyInput();
const NO_MENU = { up: false, down: false, left: false, right: false, confirm: false, back: false };

function noop() {}

// Estatísticas da partida (para HUD/testes): golpes por rally e motivos de ponto.
function newStats() {
  return { points: 0, longestRally: 0, totalHits: 0, reasons: {} };
}

function other(p) { return p === 0 ? 1 : 0; }

function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }

// ---------------------------------------------------------------------------
// Criação
// ---------------------------------------------------------------------------

export function createGame(opts) {
  const o = opts || {};
  const audio = o.audio || { play: noop, setEnabled: noop, unlock: noop };
  const game = {
    screen: 'title',          // 'title' | 'playing' | 'paused' | 'matchOver'
    phase: null,              // em 'playing': 'serve' | 'rally' | 'pointOver' | 'gameOver'
    mode: '1p',               // '1p' | '2p' | 'cpu' (demo CPU vs CPU)
    bestOf: o.bestOf || 5,
    difficulty: o.difficulty || 'normal',
    autoplay: false,
    audio: audio,
    rng: o.rng || Math.random,
    rumble: o.rumble || noop,
    time: 0,                  // relógio total (animações)
    phaseTime: 0,
    menu: { index: MENU_ITEMS.indexOf('play'), view: 'main' }, // view: 'main' | 'howto'
    pauseIndex: 0,
    matchOverIndex: 0,
    matchOverTime: 0,
    match: null,
    rally: null,
    ball: createBall(0, 0.3),
    paddles: [{ x: -1.75, y: 0.2, vx: 0, vy: 0 }, { x: 1.75, y: 0.2, vx: 0, vy: 0 }],
    sides: [SIDE_LEFT, SIDE_RIGHT],
    ais: [null, null],
    names: ['Jogador 1', 'CPU'],
    server: 0,
    lastHitter: null,
    lastShot: null,
    cooldown: [0, 0],
    accumulator: 0,
    rallyTime: 0,
    sinceEvent: 0,
    rallyHits: 0,
    lastPoint: null,          // { winner, reason, text, isLet }
    pendingResult: null,      // retorno de awardPoint do último ponto
    lastGame: null,           // { number, winner, score:[a,b] }
    swapNotice: 0,            // >0: mostrar "Troca de lados"
    shake: 0,                 // intensidade da tremida de câmera
    effects: [],              // fila de efeitos visuais para o render consumir
    lastInputs: [emptyInput(), emptyInput()],
    stats: newStats()
  };
  if (o.autoplay) {
    startMatch(game, { mode: 'cpu-vs-cpu', bestOf: game.bestOf, difficulty: game.difficulty });
  }
  return game;
}

function playSound(game, name, opts) {
  try { game.audio.play(name, opts); } catch (e) { /* áudio nunca derruba o jogo */ }
}

function doRumble(game, player, strength, ms) {
  if (game.ais[player]) return;
  try { game.rumble(player, strength, ms); } catch (e) { /* ignore */ }
}

function pushEffect(game, fx) {
  if (game.effects.length >= MAX_EFFECTS) game.effects.shift();
  game.effects.push(fx);
}

export function getPlayerName(game, p) {
  return game.names[p];
}

// ---------------------------------------------------------------------------
// Partida
// ---------------------------------------------------------------------------

export function startMatch(game, opts) {
  const o = opts || {};
  let mode = o.mode || game.mode || '1p';
  if (mode === 'cpu-vs-cpu' || mode === 'demo') mode = 'cpu';
  game.mode = mode;
  if (o.bestOf) game.bestOf = o.bestOf;
  if (o.difficulty) game.difficulty = o.difficulty;
  game.autoplay = mode === 'cpu';
  const level = game.difficulty;
  const rng = game.rng;
  if (mode === 'cpu') {
    game.ais = [createAI({ level: o.difficultyLeft || level, rng: rng }), createAI({ level: level, rng: rng })];
    game.names = ['CPU 1', 'CPU 2'];
  } else if (mode === '2p') {
    game.ais = [null, null];
    game.names = ['Jogador 1', 'Jogador 2'];
  } else {
    game.ais = [null, createAI({ level: level, rng: rng })];
    game.names = ['Jogador 1', 'CPU'];
  }
  const firstServer = o.firstServer === 0 || o.firstServer === 1
    ? o.firstServer : (game.rng() < 0.5 ? 0 : 1);
  game.match = createMatch({
    bestOf: game.bestOf,
    pointsToWin: o.pointsToWin || 11,
    firstServer: firstServer,
    changeEnds: true
  });
  game.screen = 'playing';
  game.lastPoint = null;
  game.pendingResult = null;
  game.lastGame = null;
  game.swapNotice = 0;
  game.effects.length = 0;
  game.stats = newStats();
  beginServe(game, true);
  return game;
}

function placePaddles(game) {
  for (let p = 0; p < 2; p++) {
    const side = game.sides[p];
    const pad = game.paddles[p];
    const isServer = p === game.server;
    pad.x = side * (isServer ? 1.55 : 1.8);
    pad.y = isServer ? 0.12 : 0.28;
    pad.vx = 0;
    pad.vy = 0;
  }
}

function beginServe(game, reposition) {
  const m = game.match;
  game.server = getServer(m);
  const s0 = getSide(m, 0);
  const s1 = getSide(m, 1);
  const swapped = s0 !== game.sides[0];
  game.sides = [s0, s1];
  game.rally = createRally(m);
  if (reposition || swapped) placePaddles(game);
  game.phase = 'serve';
  game.phaseTime = 0;
  game.cooldown[0] = 0;
  game.cooldown[1] = 0;
  game.lastHitter = null;
  game.lastShot = null;
  game.rallyTime = 0;
  game.sinceEvent = 0;
  game.rallyHits = 0;
  game.accumulator = 0;
  const b = game.ball;
  b.vx = 0; b.vy = 0; b.spin = 0; b.dead = false;
  holdBall(game);
}

function holdBall(game) {
  const side = game.sides[game.server];
  const pad = game.paddles[game.server];
  const b = game.ball;
  // Bola na mão livre, pequeno "quique" de preparação acima da raquete.
  b.x = pad.x - side * 0.03;
  b.y = pad.y + 0.09 + 0.05 * Math.abs(Math.sin(game.phaseTime * 3.2));
  b.vx = 0; b.vy = 0; b.spin = 0;
}

function getInput(game, p, inputs, dt) {
  const ai = game.ais[p];
  if (ai) {
    const r = updateAI(ai, {
      ball: game.ball,
      paddle: game.paddles[p],
      side: game.sides[p],
      phase: game.phase,
      isServer: game.server === p,
      ballInPlay: game.phase === 'rally',
      dt: dt
    });
    return r || NO_INPUT;
  }
  const inp = inputs && inputs[p];
  return inp || NO_INPUT;
}

function doServe(game, inp) {
  const p = game.server;
  const side = game.sides[p];
  const pad = game.paddles[p];
  const shotType = inp.shotPressed || 'drive';
  const res = computeServe({
    side: side, paddle: pad, shotType: shotType,
    aim: { x: inp.aimX || 0, y: inp.aimY || 0 }, rng: game.rng
  });
  const b = game.ball;
  b.x = res.x; b.y = res.y; b.vx = res.vx; b.vy = res.vy; b.spin = res.spin || 0;
  b.dead = false;
  game.phase = 'rally';
  game.phaseTime = 0;
  game.lastHitter = p;
  game.lastShot = shotType;
  game.cooldown[p] = HIT_COOLDOWN;
  game.sinceEvent = 0;
  game.rallyHits = 1;
  playSound(game, 'serve');
  pushEffect(game, { type: 'hit', x: b.x, y: b.y, power: 0.3, player: p, shot: shotType, t: game.time });
  doRumble(game, p, 0.25, 60);
  const r = refereeEvent(game.rally, { type: 'hit', player: p, x: b.x, y: b.y });
  if (r) endPoint(game, r);
}

function shotPower(type) {
  if (type === 'smash') return 1;
  if (type === 'topspin') return 0.75;
  if (type === 'drive') return 0.6;
  if (type === 'chop') return 0.4;
  return 0.3;
}

function handleEvents(game, events) {
  if (!events) return false;
  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    if (e.type === 'bounce') {
      playSound(game, 'bounce');
      pushEffect(game, { type: 'bounce', x: e.x, y: 0, t: game.time });
    } else if (e.type === 'net') {
      playSound(game, 'net');
      pushEffect(game, { type: 'net', x: 0, y: game.ball.y, t: game.time });
    } else if (e.type === 'floor') {
      pushEffect(game, { type: 'floor', x: e.x, y: FLOOR_Y, t: game.time });
    }
    if (game.phase === 'rally') {
      game.sinceEvent = 0;
      const r = refereeEvent(game.rally, e);
      if (r) {
        endPoint(game, r);
        return true;
      }
    }
  }
  return false;
}

function tryHits(game, frameInputs) {
  const b = game.ball;
  for (let p = 0; p < 2; p++) {
    if (game.cooldown[p] > 0) continue;
    const side = game.sides[p];
    const pad = game.paddles[p];
    if (!canHit(b, pad, side)) continue;
    const inp = frameInputs[p];
    const shotType = inp.shot || 'block';
    const res = computeShot({
      ball: b, paddle: pad, side: side, shotType: shotType,
      aim: { x: inp.aimX || 0, y: inp.aimY || 0 }, rng: game.rng
    });
    b.vx = res.vx; b.vy = res.vy; b.spin = res.spin || 0;
    game.cooldown[p] = HIT_COOLDOWN;
    game.lastHitter = p;
    game.lastShot = res.type || shotType;
    game.rallyHits += 1;
    game.sinceEvent = 0;
    const power = shotPower(shotType);
    playSound(game, 'hit', { power: power });
    pushEffect(game, {
      type: 'hit', x: b.x, y: b.y, power: power, player: p, shot: shotType,
      quality: res.quality, t: game.time
    });
    doRumble(game, p, 0.2 + 0.6 * power, shotType === 'smash' ? 140 : 70);
    if (shotType === 'smash') game.shake = Math.max(game.shake, 1);
    if (game.phase === 'rally') {
      const r = refereeEvent(game.rally, { type: 'hit', player: p, x: b.x, y: b.y });
      if (r) {
        endPoint(game, r);
        return true;
      }
    }
  }
  return false;
}

function outOfWorld(b) {
  return b.x < -6 || b.x > 6 || b.y > 8 || b.y < FLOOR_Y - 0.5 ||
    b.x !== b.x || b.y !== b.y; // NaN
}

function forceDecision(game) {
  const b = game.ball;
  const r = refereeEvent(game.rally, { type: 'floor', x: b.x === b.x ? b.x : 0 });
  if (r) {
    endPoint(game, r);
    return;
  }
  // Fallback: o árbitro não decidiu — ponto do oponente de quem bateu por último.
  const hitter = game.lastHitter === null ? game.server : game.lastHitter;
  endPoint(game, { winner: other(hitter), reason: 'OUT' });
}

// Encerra o ponto atual com um resultado do árbitro ({winner, reason} ou {let:true}).
// Exportado para testes/ferramentas; o fluxo normal chama via refereeEvent.
export function resolvePoint(game, result) {
  if (game.screen !== 'playing' || (game.phase !== 'rally' && game.phase !== 'serve')) return false;
  endPoint(game, result);
  return true;
}

function endPoint(game, result) {
  game.phase = 'pointOver';
  game.phaseTime = 0;
  const isLet = !!result.let;
  const reason = result.reason || (isLet ? 'LET' : 'OUT');
  game.lastPoint = {
    winner: isLet ? null : result.winner,
    reason: reason,
    text: REASON_TEXT[reason] || reason,
    isLet: isLet
  };
  game.pendingResult = null;
  if (game.rallyHits > game.stats.longestRally) game.stats.longestRally = game.rallyHits;
  if (!isLet) {
    game.stats.points += 1;
    game.stats.totalHits += game.rallyHits;
    game.stats.reasons[reason] = (game.stats.reasons[reason] || 0) + 1;
    game.pendingResult = awardPoint(game.match, result.winner);
    playSound(game, 'score');
    doRumble(game, result.winner, 0.35, 120);
  } else {
    playSound(game, 'net');
  }
}

function physicsStep(game, frameInputs) {
  const dt = PHYSICS_DT;
  for (let p = 0; p < 2; p++) {
    const inp = frameInputs[p];
    movePaddle(game.paddles[p], game.sides[p], inp.moveX || 0, inp.moveY || 0, dt);
    if (game.cooldown[p] > 0) game.cooldown[p] -= dt;
  }
  const b = game.ball;
  if (game.phase === 'rally') {
    if (tryHits(game, frameInputs)) return;
  }
  if (b.dead) return;
  const events = stepBall(b, dt);
  if (game.phase === 'rally') {
    game.rallyTime += dt;
    game.sinceEvent += dt;
    if (handleEvents(game, events)) return;
    if (game.sinceEvent > STALL_TIME || outOfWorld(b) || b.dead) {
      forceDecision(game);
    }
  } else if (events && events.length) {
    // Bola "morta" ainda quica depois do ponto: só efeitos/sons.
    for (let i = 0; i < events.length; i++) {
      if (events[i].type === 'bounce') playSound(game, 'bounce', { power: 0.5 });
    }
    if (outOfWorld(b)) b.dead = true;
  }
}

function runPhysics(game, dt, frameInputs) {
  game.accumulator += dt;
  let steps = 0;
  while (game.accumulator >= PHYSICS_DT && steps < MAX_STEPS_PER_UPDATE) {
    game.accumulator -= PHYSICS_DT;
    steps++;
    const before = game.phase;
    physicsStep(game, frameInputs);
    if (game.phase !== before && game.phase !== 'rally' && game.phase !== 'pointOver') break;
  }
  if (steps >= MAX_STEPS_PER_UPDATE) game.accumulator = 0;
}

function updatePlaying(game, dt, inputs) {
  const frameInputs = game.lastInputs;
  frameInputs[0] = getInput(game, 0, inputs, dt);
  frameInputs[1] = getInput(game, 1, inputs, dt);
  game.phaseTime += dt;
  if (game.swapNotice > 0) game.swapNotice = Math.max(0, game.swapNotice - dt);

  if (game.phase === 'serve') {
    const srv = game.server;
    for (let p = 0; p < 2; p++) {
      const inp = frameInputs[p];
      const pad = game.paddles[p];
      const side = game.sides[p];
      movePaddle(pad, side, inp.moveX || 0, inp.moveY || 0, dt);
      if (p === srv) {
        // Sacador fica atrás da linha de fundo, com a raquete acima do tampo.
        if (pad.x * side < TABLE_HALF + 0.06) pad.x = side * (TABLE_HALF + 0.06);
        pad.y = clamp(pad.y, 0.02, 0.6);
      }
    }
    holdBall(game);
    const sInp = frameInputs[srv];
    if (sInp.shotPressed && game.phaseTime > 0.25) doServe(game, sInp);
    return;
  }

  if (game.phase === 'rally' || game.phase === 'pointOver') {
    runPhysics(game, dt, frameInputs);
    if (game.phase === 'pointOver' && game.phaseTime >= POINT_OVER_TIME) finishPoint(game);
    return;
  }

  if (game.phase === 'gameOver') {
    for (let p = 0; p < 2; p++) {
      const inp = frameInputs[p];
      movePaddle(game.paddles[p], game.sides[p], inp.moveX || 0, inp.moveY || 0, dt);
    }
    if (game.phaseTime >= GAME_OVER_TIME) {
      if (game.match.over) {
        game.screen = 'matchOver';
        game.matchOverIndex = 0;
        game.matchOverTime = 0;
      } else {
        const res = game.pendingResult;
        if (res && res.swapEnds) game.swapNotice = SWAP_NOTICE_TIME;
        game.pendingResult = null;
        beginServe(game, true);
      }
    }
  }
}

function finishPoint(game) {
  const lp = game.lastPoint;
  if (!lp || lp.isLet) {
    beginServe(game, false);
    return;
  }
  const res = game.pendingResult;
  if (res && (res.gameOver || res.matchOver)) {
    const m = game.match;
    const last = m.history[m.history.length - 1];
    game.lastGame = {
      number: m.history.length,
      winner: res.gameWinner,
      score: last ? [last[0], last[1]] : [0, 0],
      swapEnds: !!res.swapEnds
    };
    game.phase = 'gameOver';
    game.phaseTime = 0;
    playSound(game, res.matchOver ? 'win' : 'score');
    if (res.matchOver) {
      doRumble(game, res.gameWinner, 0.8, 400);
    }
    return;
  }
  if (res && res.swapEnds) game.swapNotice = SWAP_NOTICE_TIME;
  game.pendingResult = null;
  beginServe(game, false);
}

// ---------------------------------------------------------------------------
// Menus
// ---------------------------------------------------------------------------

function cycle(list, value, dir) {
  let i = list.indexOf(value);
  if (i < 0) i = 0;
  i = (i + dir + list.length) % list.length;
  return list[i];
}

export function getMenuItems(game) {
  const items = [];
  for (let i = 0; i < MENU_ITEMS.length; i++) {
    const id = MENU_ITEMS[i];
    let label = '';
    let value = null;
    let selected = false;
    let adjustable = false;
    if (id === 'mode1p') { label = '1 Jogador (vs CPU)'; selected = game.mode === '1p'; }
    else if (id === 'mode2p') { label = '2 Jogadores'; selected = game.mode === '2p'; }
    else if (id === 'bestOf') { label = 'Partida'; value = 'Melhor de ' + game.bestOf; adjustable = true; }
    else if (id === 'difficulty') {
      label = 'Dificuldade CPU'; value = DIFFICULTY_TEXT[game.difficulty] || game.difficulty;
      adjustable = true;
    }
    else if (id === 'howto') label = 'Como jogar';
    else if (id === 'play') label = 'Jogar';
    items.push({
      id: id, label: label, value: value, selected: selected, adjustable: adjustable,
      focused: i === game.menu.index,
      disabled: id === 'difficulty' && game.mode === '2p'
    });
  }
  return items;
}

function updateTitle(game, menu) {
  const m = game.menu;
  if (m.view === 'howto') {
    if (menu.back || menu.confirm) {
      m.view = 'main';
      playSound(game, 'menu');
    }
    return;
  }
  const n = MENU_ITEMS.length;
  if (menu.up) { m.index = (m.index - 1 + n) % n; playSound(game, 'menu'); }
  if (menu.down) { m.index = (m.index + 1) % n; playSound(game, 'menu'); }
  const id = MENU_ITEMS[m.index];
  let dir = 0;
  if (menu.left) dir = -1;
  if (menu.right) dir = 1;
  if (dir !== 0) {
    if (id === 'bestOf') { game.bestOf = cycle(BEST_OF_OPTIONS, game.bestOf, dir); playSound(game, 'menu'); }
    else if (id === 'difficulty') { game.difficulty = cycle(DIFFICULTIES, game.difficulty, dir); playSound(game, 'menu'); }
    else if (id === 'mode1p' || id === 'mode2p') {
      game.mode = game.mode === '1p' ? '2p' : '1p';
      playSound(game, 'menu');
    }
  }
  if (menu.confirm) {
    playSound(game, 'menu');
    if (id === 'mode1p') { game.mode = '1p'; m.index = MENU_ITEMS.indexOf('play'); }
    else if (id === 'mode2p') { game.mode = '2p'; m.index = MENU_ITEMS.indexOf('play'); }
    else if (id === 'bestOf') game.bestOf = cycle(BEST_OF_OPTIONS, game.bestOf, 1);
    else if (id === 'difficulty') game.difficulty = cycle(DIFFICULTIES, game.difficulty, 1);
    else if (id === 'howto') m.view = 'howto';
    else if (id === 'play') {
      if (game.mode !== '1p' && game.mode !== '2p') game.mode = '1p';
      startMatch(game, { mode: game.mode });
    }
  }
}

export function goToTitle(game) {
  game.screen = 'title';
  game.phase = null;
  game.menu.view = 'main';
  game.menu.index = MENU_ITEMS.indexOf('play');
  game.autoplay = false;
  if (game.mode === 'cpu') game.mode = '1p';
  game.effects.length = 0;
}

export function pauseGame(game) {
  if (game.screen !== 'playing') return false;
  game.screen = 'paused';
  game.pauseIndex = 0;
  playSound(game, 'menu');
  return true;
}

export function resumeGame(game) {
  if (game.screen !== 'paused') return false;
  game.screen = 'playing';
  playSound(game, 'menu');
  return true;
}

export function togglePause(game) {
  if (game.screen === 'playing') return pauseGame(game);
  if (game.screen === 'paused') return resumeGame(game);
  return false;
}

function anyPausePressed(game, inputs) {
  if (!inputs) return false;
  for (let p = 0; p < 2; p++) {
    if (inputs[p] && inputs[p].pausePressed) return true;
  }
  return false;
}

function updatePaused(game, inputs, menu) {
  if (anyPausePressed(game, inputs) || menu.back) {
    resumeGame(game);
    return;
  }
  const n = PAUSE_ITEMS.length;
  if (menu.up) { game.pauseIndex = (game.pauseIndex - 1 + n) % n; playSound(game, 'menu'); }
  if (menu.down) { game.pauseIndex = (game.pauseIndex + 1) % n; playSound(game, 'menu'); }
  if (menu.confirm) {
    if (PAUSE_ITEMS[game.pauseIndex] === 'resume') resumeGame(game);
    else { playSound(game, 'menu'); goToTitle(game); }
  }
}

function updateMatchOver(game, dt, menu) {
  game.matchOverTime += dt;
  const n = MATCH_OVER_ITEMS.length;
  if (menu.up || menu.left) { game.matchOverIndex = (game.matchOverIndex - 1 + n) % n; playSound(game, 'menu'); }
  if (menu.down || menu.right) { game.matchOverIndex = (game.matchOverIndex + 1) % n; playSound(game, 'menu'); }
  if (menu.back) { playSound(game, 'menu'); goToTitle(game); return; }
  if (menu.confirm && game.matchOverTime > 0.5) {
    playSound(game, 'menu');
    if (MATCH_OVER_ITEMS[game.matchOverIndex] === 'again') {
      startMatch(game, { mode: game.mode });
    } else {
      goToTitle(game);
    }
  }
}

// ---------------------------------------------------------------------------
// Atualização principal
// ---------------------------------------------------------------------------

export function updateGame(game, dt, inputs, menuInput) {
  if (!(dt > 0)) dt = 0;
  if (dt > MAX_FRAME_DT) dt = MAX_FRAME_DT;
  const menu = menuInput || NO_MENU;
  game.time += dt;
  if (game.shake > 0) game.shake = Math.max(0, game.shake - dt * 3);

  if (game.screen === 'title') {
    updateTitle(game, menu);
  } else if (game.screen === 'playing') {
    if (anyPausePressed(game, inputs) || menu.back) {
      pauseGame(game);
      return game;
    }
    updatePlaying(game, dt, inputs);
  } else if (game.screen === 'paused') {
    updatePaused(game, inputs, menu);
  } else if (game.screen === 'matchOver') {
    updateMatchOver(game, dt, menu);
  }
  return game;
}

