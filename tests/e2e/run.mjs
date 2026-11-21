// Testes ponta a ponta (Playwright + Chromium headless 1920x1080).
// Sobe um servidor estático próprio, simula 2 controles de Xbox (mock de navigator.getGamepads)
// e roda os cenários contra index.html (ES modules) e dist/index.html (bundle IIFE).
// Uso: npm run test:e2e   [--only=src|dist] [--no-build] [--headed]
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from './server.mjs';
import { mockGamepads } from './gamepad-mock.js';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const SHOTS = path.join(HERE, 'screenshots');
const args = process.argv.slice(2);
const ONLY = (args.find((a) => a.startsWith('--only=')) || '').split('=')[1] || null;

const BTN = { A: 0, B: 1, X: 2, Y: 3, LB: 4, RB: 5, LT: 6, RT: 7, VIEW: 8, MENU: 9, UP: 12, DOWN: 13, LEFT: 14, RIGHT: 15 };
const MENU = { mode1p: 0, mode2p: 1, bestOf: 2, difficulty: 3, bounceHelp: 4, howto: 5, play: 6 };
const NMENU = 7;
const TABLE_HALF = 1.37;
const TABLE_W_HALF = 0.7625;
const REASONS = ['SERVE_FAULT', 'SERVE_NET', 'OUT', 'NET', 'OWN_SIDE', 'DOUBLE_BOUNCE', 'MISS', 'OBSTRUCTION', 'DOUBLE_HIT', 'LET'];

const results = [];
const metrics = {};

function log(...a) { console.log(...a); }

class AssertionError extends Error {}
function check(cond, msg) { if (!cond) throw new AssertionError(msg); }

// Servidor esperado pelas regras ITTF (independente de rules.js): troca a cada 2 pontos;
// a partir de 10-10 a cada ponto. Quem saca primeiro alterna por game.
function expectedServer(m) {
  const first = m.gameNumber % 2 === 1 ? m.firstServerOfMatch : 1 - m.firstServerOfMatch;
  const a = m.score[0];
  const b = m.score[1];
  const d = m.pointsToWin - 1;
  const turns = (a >= d && b >= d) ? (d + (a + b - 2 * d)) : Math.floor((a + b) / 2);
  return (first + turns) % 2;
}

function validGame(a, b, pts) {
  const hi = Math.max(a, b);
  const lo = Math.min(a, b);
  if (hi < pts) return false;
  if (lo <= pts - 2) return hi === pts;      // 11-x, x<=9
  return hi - lo === 2;                       // deuce: 12-10, 13-11...
}

// ---------------------------------------------------------------------------
// Helpers de página
// ---------------------------------------------------------------------------

async function openPage(browser, target, query, opts) {
  const o = opts || {};
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  const errors = [];
  page.on('console', (msg) => { if (msg.type() === 'error') errors.push('console: ' + msg.text()); });
  page.on('pageerror', (err) => errors.push('pageerror: ' + (err && err.message)));
  page.on('requestfailed', (req) => errors.push('requestfailed: ' + req.url()));
  page.on('response', (res) => { if (res.status() >= 400) errors.push('HTTP ' + res.status() + ' ' + res.url()); });
  await page.addInitScript(mockGamepads, { count: o.pads === undefined ? 2 : o.pads });
  await page.goto(target.base + target.page + (query || ''), { waitUntil: 'load' });
  await page.waitForFunction(() => window.__pingpong && window.__pingpong.game && window.__frames > 3, null, { timeout: 15000 });
  return { page, context, errors };
}

async function frames(page, n) {
  const start = await page.evaluate(() => window.__frames);
  await page.waitForFunction((s) => window.__frames >= s, start + n, { polling: 'raf', timeout: 10000 });
}

async function press(page, pad, button, holdFrames) {
  await page.evaluate(([p, b]) => window.__mockPads.press(p, b), [pad, button]);
  await frames(page, holdFrames || 3);
  await page.evaluate(([p, b]) => window.__mockPads.release(p, b), [pad, button]);
  await frames(page, 3);
}

async function stick(page, pad, x, y) {
  await page.evaluate(([p, ax, ay]) => window.__mockPads.stick(p, ax, ay), [pad, x, y]);
}

// Stick esquerdo em coordenadas de MUNDO (v2): mundo +x = stick para cima (eixo 1 negativo),
// mundo +z = stick para a direita (eixo 0 positivo). Igual para os dois lados.
async function stickWorld(page, pad, wx, wz) {
  await stick(page, pad, wz, -wx);
}

const G = (page, fn, arg) => page.evaluate(fn, arg);
const state = (page) => G(page, () => {
  const g = window.__pingpong.game;
  return {
    screen: g.screen, phase: g.phase, mode: g.mode, server: g.server, sides: g.sides.slice(),
    menuIndex: g.menu.index, menuView: g.menu.view, pauseIndex: g.pauseIndex,
    score: g.match ? g.match.score.slice() : null,
    gamesWon: g.match ? g.match.gamesWon.slice() : null,
    gameNumber: g.match ? g.match.gameNumber : null,
    ball: { x: g.ball.x, y: g.ball.y, z: g.ball.z, vx: g.ball.vx, vy: g.ball.vy, vz: g.ball.vz },
    paddles: g.paddles.map((p) => ({ x: p.x, y: p.y, z: p.z })),
    lastPoint: g.lastPoint, rallyHits: g.rallyHits, lastHitter: g.lastHitter,
    bounceHelp: g.bounceHelp, bounceHint: g.bounceHint ? Object.assign({}, g.bounceHint) : null
  };
});

async function waitFor(page, fn, arg, timeout, what) {
  try {
    await page.waitForFunction(fn, arg, { polling: 'raf', timeout: timeout || 10000 });
  } catch (e) {
    const s = await state(page).catch(() => null);
    throw new AssertionError('timeout esperando ' + (what || fn.toString()) + ' — estado: ' + JSON.stringify(s));
  }
}

async function shot(page, target, name) {
  mkdirSync(SHOTS, { recursive: true });
  const file = path.join(SHOTS, target.name + '-' + name + '.png');
  await page.screenshot({ path: file });
  return file;
}

// Navega o menu só com o controle 1 até iniciar "2 Jogadores".
async function startTwoPlayersWithPad(page) {
  const s0 = await state(page);
  check(s0.screen === 'title', 'tela inicial deveria ser title, é ' + s0.screen);
  const playIdx = s0.menuIndex; // foco inicial em "Jogar"
  await press(page, 0, BTN.DOWN);
  let s = await state(page);
  check(playIdx === MENU.play, 'foco inicial deveria ser "Jogar" (' + MENU.play + '), é ' + playIdx);
  check(s.menuIndex === (playIdx + 1) % NMENU, 'D-pad baixo deveria mover o foco (' + s.menuIndex + ')');
  await press(page, 1, BTN.DOWN); // 2º controle também navega o menu
  s = await state(page);
  check(s.menuIndex === (playIdx + 2) % NMENU, 'D-pad baixo do controle 2 deveria mover o foco');
  await press(page, 0, BTN.UP);
  s = await state(page);
  check(s.menuIndex === (playIdx + 1) % NMENU, 'D-pad cima deveria voltar o foco');
  await press(page, 0, BTN.DOWN);
  s = await state(page);
  check(s.menuIndex === MENU.mode2p, 'foco deveria estar em "2 Jogadores" (índice 1), está em ' + s.menuIndex);
  await press(page, 0, BTN.A);
  s = await state(page);
  check(s.screen === 'title' && s.mode === '2p', 'A em "2 Jogadores" deveria escolher modo 2p (' + s.mode + ')');
  check(s.menuIndex === playIdx, 'após escolher o modo o foco deveria ir para "Jogar"');
  await press(page, 0, BTN.A);
  await waitFor(page, () => window.__pingpong.game.screen === 'playing', null, 5000, 'screen playing');
  s = await state(page);
  check(s.mode === '2p' && s.phase === 'serve', 'partida 2p deveria começar em serve');
}

async function serve(page) {
  const s = await state(page);
  check(s.phase === 'serve', 'esperava phase serve para sacar, é ' + s.phase);
  await frames(page, 20); // > 0.25 s de preparação
  await press(page, s.server, BTN.A);
  return s.server;
}

// Joga um ponto (saque + bola corre sozinha). Retorna {before, after, server, sawPointOver}.
async function playPoint(page) {
  await waitFor(page, () => window.__pingpong.game.phase === 'serve', null, 10000, 'phase serve');
  const before = await state(page);
  const m = await G(page, () => JSON.parse(JSON.stringify(window.__pingpong.game.match)));
  check(before.server === expectedServer(m),
    'sacador ' + before.server + ' difere do esperado pelas regras ' + expectedServer(m) + ' em ' + before.score);
  await serve(page);
  await waitFor(page, () => window.__pingpong.game.phase !== 'serve', null, 3000, 'saque aceito');
  // Na v2 o bloqueio automático devolve bolas para raquetes paradas no centro, e o ponto
  // poderia durar indefinidamente. O recebedor sai do caminho (stick para a lateral).
  const receiverPad = 1 - before.server;
  await stickWorld(page, receiverPad, 0, 1);
  await waitFor(page, () => window.__pingpong.game.phase === 'pointOver' || window.__pingpong.game.phase === 'gameOver',
    null, 15000, 'fim do ponto');
  await stickWorld(page, receiverPad, 0, 0);
  const after = await state(page);
  return { before, after, server: before.server };
}

// ---------------------------------------------------------------------------
// Cenários
// ---------------------------------------------------------------------------

const scenarios = [];
function scenario(id, title, fn) { scenarios.push({ id, title, fn }); }

scenario(1, 'Carrega sem erros, canvas, __pingpong, tela title', async (browser, t) => {
  const { page, context, errors } = await openPage(browser, t, '');
  const info = await G(page, () => {
    const c = document.querySelector('canvas');
    return {
      canvas: !!c, w: c && c.width, h: c && c.height,
      api: !!(window.__pingpong && window.__pingpong.game && window.__pingpong.input),
      screen: window.__pingpong.game.screen,
      pads: navigator.getGamepads().filter(Boolean).length
    };
  });
  check(info.canvas, 'canvas não encontrado');
  check(info.w > 0 && info.h > 0, 'canvas sem tamanho');
  check(info.api, 'window.__pingpong não exposto');
  check(info.screen === 'title', 'tela inicial ' + info.screen);
  check(info.pads === 2, 'mock deveria expor 2 controles');
  // canvas desenhado (não totalmente uniforme)
  const varied = await G(page, () => {
    const c = document.querySelector('canvas');
    const tmp = document.createElement('canvas');
    tmp.width = 64; tmp.height = 36;
    const ctx = tmp.getContext('2d');
    ctx.drawImage(c, 0, 0, 64, 36);
    const d = ctx.getImageData(0, 0, 64, 36).data;
    const set = {};
    for (let i = 0; i < d.length; i += 4) set[(d[i] >> 4) + ',' + (d[i + 1] >> 4) + ',' + (d[i + 2] >> 4)] = 1;
    return Object.keys(set).length;
  });
  check(varied > 8, 'canvas parece vazio (' + varied + ' cores)');
  await frames(page, 30);
  await shot(page, t, '01-title');
  check(errors.length === 0, 'erros: ' + errors.join(' | '));
  await context.close();
});

scenario(2, 'Menu só com controle até "2 Jogadores"; ambos conectados via gamepad', async (browser, t) => {
  const { page, context, errors } = await openPage(browser, t, '');
  await startTwoPlayersWithPad(page);
  await frames(page, 5);
  const pl = await G(page, () => {
    const g = window.__pingpong.game;
    return { assign: window.__pingpong.input.assignment, li: g.lastInputs.map((p) => ({ c: p.connected, s: p.source, i: p.gamepadIndex })), names: g.names };
  });
  check(pl.assign[0] === 0 && pl.assign[1] === 1, 'atribuição de controles ' + JSON.stringify(pl.assign));
  for (let p = 0; p < 2; p++) {
    check(pl.li[p].c === true && pl.li[p].s === 'gamepad' && pl.li[p].i === p,
      'jogador ' + (p + 1) + ' não aparece conectado via gamepad: ' + JSON.stringify(pl.li[p]));
  }
  check(pl.names[0] === 'Jogador 1' && pl.names[1] === 'Jogador 2', 'nomes ' + pl.names);
  await shot(page, t, '02-serve-2p');
  check(errors.length === 0, 'erros: ' + errors.join(' | '));
  await context.close();
});

scenario(3, 'Saque com A -> rally; stick esquerdo move a raquete certa em x e z nos dois lados', async (browser, t) => {
  const { page, context, errors } = await openPage(browser, t, '');
  await startTwoPlayersWithPad(page);

  // Cada controle move apenas a sua raquete (P1 = controle 0, P2 = controle 1), no plano da mesa:
  // stick para cima -> +x do mundo, stick para a direita -> +z. A altura (y) é automática.
  async function moveDelta(pad, wx, wz, n) {
    const a = await state(page);
    await stickWorld(page, pad, wx, wz);
    await frames(page, n || 10);
    await stickWorld(page, pad, 0, 0);
    await frames(page, 20); // deixa a raquete frear
    const b = await state(page);
    const o = 1 - pad;
    return {
      dx: b.paddles[pad].x - a.paddles[pad].x,
      dz: b.paddles[pad].z - a.paddles[pad].z,
      other: Math.abs(b.paddles[o].x - a.paddles[o].x) + Math.abs(b.paddles[o].z - a.paddles[o].z)
    };
  }
  async function checkMove(pad, label) {
    const who = label + ': jogador ' + (pad + 1);
    // +x / -x (o sacador fica atrás da linha de fundo; ainda assim tem folga nos dois sentidos)
    for (const dir of [1, -1]) {
      const d = await moveDelta(pad, dir, 0);
      check(d.dx * dir > 0.02, who + ' stick ' + (dir > 0 ? 'cima' : 'baixo') + ' não moveu a raquete em ' +
        (dir > 0 ? '+x' : '-x') + ' (dx=' + d.dx.toFixed(3) + ')');
      check(Math.abs(d.dz) < 0.01, who + ' stick vertical mexeu em z (' + d.dz.toFixed(3) + ')');
      check(d.other < 0.005, who + ': raquete do outro jogador se moveu (' + d.other.toFixed(3) + ')');
    }
    for (const dir of [1, -1]) {
      const d = await moveDelta(pad, 0, dir);
      check(d.dz * dir > 0.05, who + ' stick ' + (dir > 0 ? 'direita' : 'esquerda') + ' não moveu a raquete em ' +
        (dir > 0 ? '+z' : '-z') + ' (dz=' + d.dz.toFixed(3) + ')');
      check(Math.abs(d.dx) < 0.01, who + ' stick horizontal mexeu em x (' + d.dx.toFixed(3) + ')');
      check(d.other < 0.005, who + ': raquete do outro jogador se moveu (' + d.other.toFixed(3) + ')');
    }
  }

  let s = await state(page);
  check(s.sides[0] === -1 && s.sides[1] === 1, 'lados iniciais ' + s.sides);
  for (let p = 0; p < 2; p++) await checkMove(p, 'saque/lado ' + (s.sides[p] < 0 ? 'de baixo' : 'de cima'));

  const srv = await serve(page);
  await waitFor(page, () => window.__pingpong.game.phase === 'rally', null, 2000, 'phase rally após A');
  s = await state(page);
  check(s.lastHitter === srv && s.rallyHits >= 1, 'saque não registrado');
  check(Math.abs(s.ball.vx) > 0.5, 'bola parada após saque');
  check(typeof s.ball.z === 'number' && typeof s.ball.vz === 'number', 'bola sem z/vz');
  // Move o receptor (rede + lateral) e o sacador (para trás + lateral) durante o rally.
  const rcv = 1 - srv;
  const a = await state(page);
  await stickWorld(page, rcv, -s.sides[rcv] * 0.7, 0.7);
  await stickWorld(page, srv, s.sides[srv] * 0.7, -0.7);
  await frames(page, 8);
  await stickWorld(page, rcv, 0, 0);
  await stickWorld(page, srv, 0, 0);
  const b = await state(page);
  check((b.paddles[rcv].x - a.paddles[rcv].x) * -s.sides[rcv] > 0.01, 'receptor não se moveu em x no rally');
  check(b.paddles[rcv].z - a.paddles[rcv].z > 0.01, 'receptor não se moveu em z no rally');
  check((b.paddles[srv].x - a.paddles[srv].x) * s.sides[srv] > 0.01 || Math.abs(b.paddles[srv].x) > 2.45,
    'sacador não se moveu em x no rally');
  check(b.paddles[srv].z - a.paddles[srv].z < -0.01, 'sacador não se moveu em z no rally');
  // Altura automática: a raquete do receptor acompanha a altura da bola que chega.
  const yTrack = await G(page, (r) => new Promise((resolve) => {
    const g = window.__pingpong.game;
    let best = 9;
    let n = 0;
    (function loop() {
      const bl = g.ball;
      const side = g.sides[r];
      if (g.phase === 'rally' && bl.vx * side > 0 && bl.x * side > 0.3 && bl.y > -0.3 && bl.y < 1.1) {
        best = Math.min(best, Math.abs(g.paddles[r].y - bl.y));
      }
      if (++n > 120 || g.phase !== 'rally') resolve(best); else requestAnimationFrame(loop);
    })();
  }), rcv);
  check(yTrack < 0.08, 'altura automática da raquete não acompanhou a bola (menor |dy|=' + yTrack.toFixed(3) + ')');
  await shot(page, t, '03-rally');

  // Força fim do 1º game (placar 10-0 para J1) e joga pontos até trocar de lado.
  // (o placar é alterado durante o banner do ponto, antes de beginServe recalcular o sacador)
  await waitFor(page, () => window.__pingpong.game.phase === 'pointOver', null, 15000, 'fim do 1º ponto');
  await G(page, () => { const m = window.__pingpong.game.match; m.score[0] = 10; m.score[1] = 0; });
  for (let i = 0; i < 12; i++) {
    const r = await playPoint(page);
    if (r.after.phase === 'gameOver' || (r.after.gamesWon && r.after.gamesWon[0] + r.after.gamesWon[1] > 0)) break;
  }
  await waitFor(page, () => window.__pingpong.game.phase === 'serve' && window.__pingpong.game.match.gameNumber === 2,
    null, 10000, 'início do game 2');
  s = await state(page);
  check(s.sides[0] === 1 && s.sides[1] === -1, 'lados deveriam ter trocado no game 2: ' + s.sides);
  await frames(page, 20);
  await shot(page, t, '03-swapped-sides');
  for (let p = 0; p < 2; p++) await checkMove(p, 'após troca/lado ' + (s.sides[p] < 0 ? 'de baixo' : 'de cima'));
  check(errors.length === 0, 'erros: ' + errors.join(' | '));
  await context.close();
});

scenario(4, 'Ponto disputado: placar coerente, banner pointOver, volta a serve', async (browser, t) => {
  const { page, context, errors } = await openPage(browser, t, '');
  await startTwoPlayersWithPad(page);
  const sawBanner = [];
  for (let i = 0; i < 4; i++) {
    const r = await playPoint(page);
    const lp = r.after.lastPoint;
    check(lp && typeof lp.text === 'string' && lp.text.length > 0, 'lastPoint sem texto');
    check(REASONS.indexOf(lp.reason) >= 0, 'motivo inválido ' + lp.reason);
    if (lp.isLet) {
      check(r.after.score[0] === r.before.score[0] && r.after.score[1] === r.before.score[1], 'let mudou o placar');
    } else {
      check(lp.winner === 0 || lp.winner === 1, 'vencedor inválido');
      const exp = r.before.score.slice();
      exp[lp.winner]++;
      check(r.after.score[0] === exp[0] && r.after.score[1] === exp[1],
        'placar ' + r.before.score + ' -> ' + r.after.score + ' não bate com vencedor ' + lp.winner);
      // coerência do motivo: erro de saque é sempre ponto do recebedor
      if (lp.reason === 'SERVE_FAULT' || lp.reason === 'SERVE_NET') {
        check(lp.winner !== r.server, 'erro de saque deu ponto ao sacador');
      }
    }
    check(r.after.phase === 'pointOver', 'esperava pointOver, phase=' + r.after.phase);
    if (i === 0) {
      await frames(page, 24); // banner termina a animação de entrada
      check((await state(page)).phase === 'pointOver', 'banner sumiu cedo demais');
      sawBanner.push(await shot(page, t, '04-point-banner'));
    }
    await waitFor(page, () => window.__pingpong.game.phase === 'serve', null, 5000, 'volta para serve');
    const s = await state(page);
    const m = await G(page, () => JSON.parse(JSON.stringify(window.__pingpong.game.match)));
    check(s.server === expectedServer(m), 'sacador após ponto ' + s.server + ' != ' + expectedServer(m));
    log('      ponto ' + (i + 1) + ': ' + r.before.score.join('-') + ' -> ' + r.after.score.join('-') +
      ' (' + lp.reason + ', sacador J' + (r.server + 1) + ', próximo sacador J' + (s.server + 1) + ')');
  }
  check(errors.length === 0, 'erros: ' + errors.join(' | '));
  await context.close();
});

scenario(5, 'MENU pausa e congela a bola; A em "Continuar" retoma', async (browser, t) => {
  const { page, context, errors } = await openPage(browser, t, '');
  await startTwoPlayersWithPad(page);
  await serve(page);
  await waitFor(page, () => window.__pingpong.game.phase === 'rally', null, 2000, 'rally');
  await frames(page, 4);
  // Botões de golpe (B = chop, X = topspin, RT = smash) NÃO podem pausar durante o jogo.
  for (const [b, name] of [[BTN.B, 'B'], [BTN.X, 'X'], [BTN.RT, 'RT']]) {
    await press(page, 0, b, 2);
    const sp = await state(page);
    check(sp.screen === 'playing', 'botão ' + name + ' (golpe) pausou o jogo: screen=' + sp.screen);
  }
  await press(page, 1, BTN.MENU); // qualquer controle pode pausar
  let s = await state(page);
  check(s.screen === 'paused', 'MENU deveria pausar, screen=' + s.screen);
  check(s.pauseIndex === 0, 'foco da pausa deveria estar em Continuar');
  const b1 = s.ball;
  await frames(page, 30);
  s = await state(page);
  check(s.ball.x === b1.x && s.ball.y === b1.y, 'bola se moveu durante a pausa');
  await shot(page, t, '05-paused');
  await press(page, 0, BTN.A);
  s = await state(page);
  check(s.screen === 'playing', 'A em Continuar deveria retomar, screen=' + s.screen);
  await frames(page, 10);
  s = await state(page);
  check(s.phase !== 'rally' || s.ball.x !== b1.x || s.ball.y !== b1.y, 'bola não voltou a se mover');
  // pausa de novo e retoma com MENU (atalho)
  await press(page, 0, BTN.MENU);
  check((await state(page)).screen === 'paused', 'segunda pausa falhou');
  await press(page, 0, BTN.MENU);
  check((await state(page)).screen === 'playing', 'MENU na pausa deveria retomar');
  // VIEW (botão de "voltar" do Xbox) pausa; B na pausa retoma
  await press(page, 1, BTN.VIEW);
  check((await state(page)).screen === 'paused', 'VIEW deveria pausar');
  await press(page, 1, BTN.B);
  check((await state(page)).screen === 'playing', 'B na pausa deveria retomar');
  check(errors.length === 0, 'erros: ' + errors.join(' | '));
  await context.close();
});

scenario(6, 'Teclado/remoto Samsung: setas + Enter; Voltar (10009) sai de "Como jogar"', async (browser, t) => {
  const { page, context, errors } = await openPage(browser, t, '', { pads: 0 });
  // Remoto Samsung: só keyCode (sem event.code), como em TVs Tizen antigas.
  async function remote(keyCode) {
    await page.evaluate((kc) => {
      for (const type of ['keydown', 'keyup']) {
        const e = new KeyboardEvent(type, { bubbles: true, cancelable: true });
        Object.defineProperty(e, 'keyCode', { get: () => kc });
        Object.defineProperty(e, 'which', { get: () => kc });
        window.dispatchEvent(e);
      }
    }, keyCode);
    await frames(page, 3);
  }
  let s = await state(page);
  const start = s.menuIndex;
  await page.keyboard.press('ArrowDown'); await frames(page, 3);
  s = await state(page);
  check(start === MENU.play, 'foco inicial deveria ser Jogar, é ' + start);
  check(s.menuIndex === (start + 1) % NMENU, 'ArrowDown não moveu o foco');
  await page.keyboard.press('ArrowUp'); await frames(page, 3);
  await page.keyboard.press('ArrowUp'); await frames(page, 3);
  s = await state(page);
  check(s.menuIndex === MENU.howto, 'ArrowUp x2 deveria focar "Como jogar" (' + MENU.howto + '), foco=' + s.menuIndex);
  await page.keyboard.press('Enter'); await frames(page, 3);
  s = await state(page);
  check(s.menuView === 'howto', 'Enter em "Como jogar" deveria abrir a tela, view=' + s.menuView);
  await shot(page, t, '06-howto');
  await remote(10009);
  s = await state(page);
  check(s.menuView === 'main' && s.screen === 'title', 'Voltar (10009) deveria voltar ao menu, view=' + s.menuView);
  // remoto: setas por keyCode (38/40) + Enter (13) iniciam 1 Jogador
  await remote(40); // -> índice 6 (Jogar)
  s = await state(page);
  check(s.menuIndex === MENU.play, 'keyCode 40 deveria mover o foco para Jogar, foco=' + s.menuIndex);
  await remote(13);
  s = await state(page);
  check(s.screen === 'playing' && s.mode === '1p', 'Enter (13) em Jogar deveria iniciar 1P, screen=' + s.screen);
  // Voltar durante a partida pausa
  await remote(10009);
  s = await state(page);
  check(s.screen === 'paused', 'Voltar na partida deveria pausar, screen=' + s.screen);
  await remote(10009);
  check((await state(page)).screen === 'playing', 'Voltar na pausa deveria retomar');
  check(errors.length === 0, 'erros: ' + errors.join(' | '));
  await context.close();
});

async function runDemoMatch(browser, t, level, fast, timeoutMs) {
  const { page, context, errors } = await openPage(browser, t, '?demo=1&bestOf=3&level=' + level + '&fast=' + fast);
  const t0 = Date.now();
  const s0 = await state(page);
  check(s0.screen === 'playing' && s0.mode === 'cpu', 'demo deveria iniciar CPU x CPU, screen=' + s0.screen + ' mode=' + s0.mode);
  await waitFor(page, () => window.__pingpong.game.screen === 'matchOver', null, timeoutMs, 'matchOver (' + level + ')');
  const res = await G(page, () => {
    const g = window.__pingpong.game;
    return { match: JSON.parse(JSON.stringify(g.match)), stats: JSON.parse(JSON.stringify(g.stats)) };
  });
  const ms = Date.now() - t0;
  return { page, context, errors, res, ms };
}

function validateMatch(m) {
  const pts = m.pointsToWin;
  check(m.over === true, 'match.over deveria ser true');
  check(m.winner === 0 || m.winner === 1, 'vencedor inválido');
  check(m.gamesWon[m.winner] === 2 && m.gamesWon[1 - m.winner] <= 1, 'games ' + m.gamesWon);
  check(m.history.length === m.gamesWon[0] + m.gamesWon[1], 'history ' + JSON.stringify(m.history));
  const won = [0, 0];
  for (const [a, b] of m.history) {
    check(validGame(a, b, pts), 'game inválido ' + a + '-' + b);
    won[a > b ? 0 : 1]++;
  }
  check(won[0] === m.gamesWon[0] && won[1] === m.gamesWon[1], 'history não bate com gamesWon');
  const lastGame = m.history[m.history.length - 1];
  check((lastGame[0] > lastGame[1] ? 0 : 1) === m.winner, 'último game não foi do vencedor');
}

scenario(7, 'Partida completa ?demo=1&fast=N melhor de 3 chega a matchOver com placar válido', async (browser, t) => {
  const { page, context, errors, res, ms } = await runDemoMatch(browser, t, 'normal', 40, 120000);
  validateMatch(res.match);
  log('      ' + res.match.history.map((g) => g.join('-')).join(', ') + ' vencedor CPU ' + (res.match.winner + 1) +
    ' em ' + (ms / 1000).toFixed(1) + 's reais');
  await frames(page, 20);
  await shot(page, t, '07-match-over');
  check(errors.length === 0, 'erros: ' + errors.join(' | '));
  await context.close();
});

scenario(8, 'Jogabilidade CPU x CPU (normal e hard): z dos quiques, golpes por rally e motivos de ponto', async (browser, t) => {
  for (const level of ['normal', 'hard']) {
    const { page, context, errors, res } = await runDemoMatch(browser, t, level, 50, 150000);
    validateMatch(res.match);
    const st = res.stats;
    check(typeof st.totalHits === 'number' && st.reasons, 'game.stats sem totalHits/reasons');
    let pts = 0;
    for (const k in st.reasons) pts += st.reasons[k];
    check(pts === st.points, 'soma dos motivos (' + pts + ') != pontos (' + st.points + ')');
    const avg = st.totalHits / st.points;
    const serveErr = (st.reasons.SERVE_FAULT || 0) + (st.reasons.SERVE_NET || 0);
    check(typeof st.bounces === 'number' && st.bounces > 20, 'game.stats sem quiques registrados (' + st.bounces + ')');
    const zMean = st.bounceZSum / st.bounces;
    const zSd = Math.sqrt(Math.max(0, st.bounceZSqSum / st.bounces - zMean * zMean));
    const key = t.name + '/' + level;
    metrics[key] = {
      points: st.points, avgHitsPerRally: +avg.toFixed(2), longestRally: st.longestRally,
      serveErrorPct: +(100 * serveErr / st.points).toFixed(1), reasons: st.reasons,
      bounces: st.bounces, bounceZMean: +zMean.toFixed(3), bounceZSd: +zSd.toFixed(3),
      bounceZMaxAbs: +st.bounceZMaxAbs.toFixed(3),
      score: res.match.history.map((g) => g.join('-')).join(', ')
    };
    log('      ' + level + ': ' + st.points + ' pontos, média ' + avg.toFixed(2) + ' golpes/rally, maior rally ' +
      st.longestRally + ', erros de saque ' + metrics[key].serveErrorPct + '%, z dos quiques: média ' +
      zMean.toFixed(3) + ' dp ' + zSd.toFixed(3) + ' max|z| ' + st.bounceZMaxAbs.toFixed(3) +
      ' (' + st.bounces + '), motivos ' + JSON.stringify(st.reasons));
    // Metas de jogabilidade v2: a bola circula pela mesa (sem ficar no centro), rallies nem
    // curtos nem intermináveis, e o saque quase nunca erra.
    check(zSd >= 0.2, level + ': desvio padrão de z dos quiques ' + zSd.toFixed(3) + ' < 0.2 m (jogo pelo centro)');
    check(st.bounceZMaxAbs <= TABLE_W_HALF + 1e-6, level + ': quique fora da largura da mesa (' + st.bounceZMaxAbs + ')');
    check(avg >= 4 && avg <= 20, level + ': média de golpes por rally ' + avg.toFixed(2) + ' fora de [4, 20]');
    check(serveErr / st.points < 0.1, level + ': ' + metrics[key].serveErrorPct + '% dos pontos por erro de saque (>= 10%)');
    check(errors.length === 0, 'erros: ' + errors.join(' | '));
    await context.close();
  }
});

// "Humano" simulado: script simples no navegador que prevê a bola em 3D (gravidade, arrasto,
// efeito e quique, sem rede) e move o stick esquerdo do controle 1 no plano da mesa até o ponto
// onde a bola vai passar depois de quicar no seu lado (stick cima = +x, direita = +z). A altura
// da raquete é automática. Sem acesso à IA; só lê o estado visível da bola e da própria raquete.
function installHumanBot() {
  const g = window.__pingpong.game;
  const pads = window.__mockPads;
  const DZ = 0.18;
  const bot = { returns: 0, serves: 0, cpuHits: 0, frames: 0, lastHits: 0, aPressedAt: -1, zs: [], padZMin: 0, padZMax: 0, zTravel: 0, xTravel: 0, prev: null };
  window.__bot = bot;
  function predict(b, side) {
    let x = b.x, y = b.y, z = b.z || 0, vx = b.vx, vy = b.vy, vz = b.vz || 0, spin = b.spin || 0;
    let bounced = false;
    const dt = 1 / 240;
    let best = null;
    for (let i = 0; i < 600; i++) {
      vy += (-9.81 - 0.004 * spin * Math.abs(vx)) * dt;
      const d = 1 - 0.12 * dt;
      vx *= d; vy *= d; vz *= d; spin *= 1 - 0.3 * dt;
      const py = y;
      x += vx * dt; y += vy * dt; z += vz * dt;
      if (py >= 0.02 && y < 0.02 && vy < 0 && Math.abs(x) <= 1.37 && Math.abs(z) <= 0.7625) {
        vy = -vy * 0.88;
        y = 0.02;
        const hs = Math.sqrt(vx * vx + vz * vz) || 1;
        vx += vx / hs * spin * 0.002; vz += vz / hs * spin * 0.002;
        spin *= 0.7;
        if (x * side > 0) bounced = true;
      }
      if (bounced && x * side >= 0.95) {
        best = { x, z };
        // ponto de contato: ápice depois do quique (ou o que der antes de sair da zona)
        if (vy <= 0 || x * side >= 2.2) return best;
      }
      if (y < -0.5) break;
    }
    return best;
  }
  function setStick(wx, wz) {
    // controlador P (mundo) com inversão da deadzone radial do input.js
    let ox = wz * 8, oy = wx * 8;
    const mag = Math.sqrt(ox * ox + oy * oy);
    if (mag > 1) { ox /= mag; oy /= mag; }
    const m = Math.min(1, mag);
    let ax = 0, ay = 0;
    if (m > 0.02) {
      const raw = DZ + (1 - DZ) * m;
      ax = (ox / (m || 1)) * raw; ay = (oy / (m || 1)) * raw;
    }
    pads.stick(0, ax, -ay); // eixo Y do gamepad: cima negativo; cima = mundo +x
  }
  function tick() {
    bot.frames++;
    if (g.screen === 'playing') {
      const side = g.sides[0];
      const pad = g.paddles[0];
      const b = g.ball;
      if (g.phase === 'serve') {
        setStick(0, 0);
        if (g.server === 0) {
          if (bot.aPressedAt < 0 && g.phaseTime > 0.6) { pads.press(0, 0); bot.aPressedAt = bot.frames; bot.serves++; }
        }
      } else if (g.phase === 'rally') {
        let target = { x: side * 1.7, z: 0 };
        if (b.vx * side > 0.2) {
          const p = predict(b, side);
          if (p) target = p;
        }
        setStick(target.x - pad.x, target.z - pad.z);
        bot.padZMin = Math.min(bot.padZMin, pad.z);
        bot.padZMax = Math.max(bot.padZMax, pad.z);
        if (bot.prev) { bot.xTravel += Math.abs(pad.x - bot.prev.x); bot.zTravel += Math.abs(pad.z - bot.prev.z); }
        bot.prev = { x: pad.x, z: pad.z };
        if (g.rallyHits > bot.lastHits) {
          if (g.lastHitter === 0 && g.rallyHits > 1) {
            bot.returns++;
            bot.zs.push(+b.z.toFixed(3));
          }
          if (g.lastHitter === 1) bot.cpuHits++;
        }
      } else {
        setStick(0, 0);
      }
      if (g.phase !== 'rally') bot.prev = null;
      bot.lastHits = g.phase === 'serve' ? 0 : g.rallyHits;
      if (bot.aPressedAt >= 0 && bot.frames - bot.aPressedAt > 4) { pads.release(0, 0); bot.aPressedAt = -1; }
    }
    window.requestAnimationFrame(tick);
  }
  window.requestAnimationFrame(tick);
}

scenario(9, 'Humano simulado com o controle devolve a bola contra a CPU', async (browser, t) => {
  const { page, context, errors } = await openPage(browser, t, '');
  // 1 Jogador (padrão) -> Dificuldade Fácil, iniciar com A
  let s = await state(page);
  check(s.mode === '1p', 'modo padrão deveria ser 1p');
  await press(page, 0, BTN.UP); // Como jogar
  await press(page, 0, BTN.UP); // Ajuda de quique
  await press(page, 0, BTN.UP); // Dificuldade
  check((await state(page)).menuIndex === MENU.difficulty, 'foco deveria estar em Dificuldade');
  await press(page, 0, BTN.LEFT); // Normal -> Fácil
  const diff = await G(page, () => window.__pingpong.game.difficulty);
  check(diff === 'easy', 'D-pad esquerda deveria trocar dificuldade para Fácil, é ' + diff);
  await press(page, 0, BTN.DOWN);
  await press(page, 0, BTN.DOWN);
  await press(page, 0, BTN.DOWN);
  check((await state(page)).menuIndex === MENU.play, 'foco deveria voltar para Jogar');
  await press(page, 0, BTN.A);
  await waitFor(page, () => window.__pingpong.game.screen === 'playing', null, 5000, 'partida 1p');
  await page.evaluate(installHumanBot);
  const deadline = Date.now() + 60000;
  let bot = null;
  let shotTaken = false;
  while (Date.now() < deadline) {
    await page.waitForTimeout(500);
    bot = await G(page, () => Object.assign({}, window.__bot, { score: window.__pingpong.game.match.score.slice(), screen: window.__pingpong.game.screen }));
    if (!shotTaken && bot.returns >= 1) { await shot(page, t, '09-human-rally'); shotTaken = true; }
    if (bot.returns >= 8) break;
    if (bot.screen !== 'playing') break;
  }
  metrics[t.name + '/human'] = bot;
  log('      humano simulado: ' + bot.returns + ' devoluções (z do contato ' + JSON.stringify(bot.zs) + '), ' +
    bot.cpuHits + ' golpes da CPU, ' + bot.serves + ' saques, placar ' + bot.score.join('-') +
    ', raquete em z de ' + bot.padZMin.toFixed(2) + ' a ' + bot.padZMax.toFixed(2) +
    ' (percurso no rally: x ' + bot.xTravel.toFixed(2) + ' m, z ' + bot.zTravel.toFixed(2) + ' m)');
  check(bot.returns >= 3, 'humano simulado devolveu só ' + bot.returns + ' bolas em 60 s');
  // o stick esquerdo foi usado nas duas dimensões do plano da mesa (x já é necessário para alcançar a bola)
  check(bot.zTravel > 0.2 && bot.xTravel > 0.5, 'humano simulado não moveu a raquete em x e z no rally (x ' +
    bot.xTravel.toFixed(2) + ' m, z ' + bot.zTravel.toFixed(2) + ' m)');
  check(errors.length === 0, 'erros: ' + errors.join(' | '));
  await context.close();
});

// Registra, no navegador, os quiques reais (efeitos 'bounce' antes de o render consumi-los) e o
// bounceHint visto a cada frame. Resultado em window.__hintLog.
function installHintLogger() {
  const pp = window.__pingpong;
  const g = pp.game;
  const log = { frames: 0, rallyFrames: 0, hintFrames: 0, hints: [], bounces: [], wrong: [] };
  window.__hintLog = log;
  const orig = pp.renderer.render;
  pp.renderer.render = function (game, info) {
    for (let i = 0; i < game.effects.length; i++) {
      const e = game.effects[i];
      if (e.type === 'bounce' && game.phase === 'rally') log.bounces.push({ x: e.x, z: e.z, t: e.t });
    }
    return orig.apply(this, arguments);
  };
  (function loop() {
    log.frames++;
    if (g.screen === 'playing' && g.phase === 'rally') {
      log.rallyFrames++;
      const h = g.bounceHint;
      if (h) {
        log.hintFrames++;
        const recv = g.lastHitter === null ? null : 1 - g.lastHitter;
        const last = log.hints[log.hints.length - 1];
        if (!last || last.x !== h.x || last.z !== h.z) {
          log.hints.push({ x: h.x, z: h.z, side: h.side, player: h.player, recv: recv,
            recvSide: recv === null ? null : g.sides[recv] });
        }
        if (recv !== null && (h.player !== recv || h.side !== g.sides[recv])) {
          log.wrong.push({ hint: Object.assign({}, h), recv: recv, sides: g.sides.slice() });
        }
      }
    }
    requestAnimationFrame(loop);
  })();
}

scenario(10, 'Ajuda de quique: opção alterna no menu; ligada, bounceHint aparece do lado de quem recebe', async (browser, t) => {
  const { page, context, errors } = await openPage(browser, t, '');
  let s = await state(page);
  check(s.bounceHelp === true, 'Ajuda de quique deveria começar ligada');
  await press(page, 0, BTN.UP); // Como jogar
  await press(page, 0, BTN.UP); // Ajuda de quique
  s = await state(page);
  check(s.menuIndex === MENU.bounceHelp, 'foco deveria estar em "Ajuda de quique" (' + MENU.bounceHelp + '), é ' + s.menuIndex);
  await press(page, 0, BTN.A);
  check((await state(page)).bounceHelp === false, 'A em "Ajuda de quique" deveria desligar');
  await frames(page, 6);
  await shot(page, t, '10-menu-bounce-help-off');
  await press(page, 0, BTN.RIGHT);
  check((await state(page)).bounceHelp === true, 'D-pad direita deveria religar');
  await press(page, 0, BTN.LEFT);
  check((await state(page)).bounceHelp === false, 'D-pad esquerda deveria desligar');

  // Desligada: 2 jogadores, alguns saques — nenhum bounceHint.
  await press(page, 0, BTN.DOWN); await press(page, 0, BTN.DOWN); // Como jogar -> Jogar
  check((await state(page)).menuIndex === MENU.play, 'foco deveria estar em Jogar');
  await press(page, 0, BTN.UP); await press(page, 0, BTN.UP); await press(page, 0, BTN.UP);
  await press(page, 0, BTN.UP); await press(page, 0, BTN.UP); // -> 2 Jogadores (1)
  check((await state(page)).menuIndex === MENU.mode2p, 'foco deveria estar em 2 Jogadores');
  await press(page, 0, BTN.A); // escolhe 2p, foco vai para Jogar
  await press(page, 0, BTN.A);
  await waitFor(page, () => window.__pingpong.game.screen === 'playing', null, 5000, 'partida 2p');
  await page.evaluate(installHintLogger);
  // Raquetes paradas no centro devolvem a bola sozinhas (bloqueio automático) e o ponto não acaba:
  // os dois jogadores seguram o stick para o lado (a devolução de verdade é testada no cenário 11).
  const sideSticks = async (v) => { await stickWorld(page, 0, 0, v); await stickWorld(page, 1, 0, -v); };
  await sideSticks(1);
  for (let i = 0; i < 2; i++) await playPoint(page);
  await sideSticks(0);
  let lg = await G(page, () => window.__hintLog);
  check(lg.rallyFrames > 10, 'sem frames de rally');
  check(lg.hintFrames === 0, 'ajuda desligada mas bounceHint apareceu em ' + lg.hintFrames + ' frames');

  // A opção fica no menu principal: volta ao menu (pausa -> Sair), liga e joga de novo.
  await waitFor(page, () => window.__pingpong.game.phase === 'serve', null, 5000, 'serve');
  await press(page, 0, BTN.MENU);
  await press(page, 0, BTN.DOWN); // Sair
  await press(page, 0, BTN.A);
  await waitFor(page, () => window.__pingpong.game.screen === 'title', null, 3000, 'volta ao title');
  await press(page, 0, BTN.UP); await press(page, 0, BTN.UP); // -> Ajuda de quique
  await press(page, 0, BTN.RIGHT);
  s = await state(page);
  check(s.bounceHelp === true && s.menuIndex === MENU.bounceHelp, 'religar Ajuda de quique falhou');
  await press(page, 0, BTN.DOWN); await press(page, 0, BTN.DOWN);
  await press(page, 0, BTN.A);
  await waitFor(page, () => window.__pingpong.game.screen === 'playing', null, 5000, 'partida 2p (ajuda ligada)');
  await G(page, () => { const l = window.__hintLog; l.rallyFrames = 0; l.hintFrames = 0; l.hints = []; l.bounces = []; l.wrong = []; });
  let shotHint = false;
  await sideSticks(1);
  for (let i = 0; i < 4; i++) {
    await waitFor(page, () => window.__pingpong.game.phase === 'serve', null, 10000, 'phase serve');
    await serve(page);
    if (!shotHint) {
      // (um saque raro na rede não tem quique previsto do outro lado: tenta no próximo)
      await waitFor(page, () => !!window.__pingpong.game.bounceHint || window.__pingpong.game.phase !== 'rally',
        null, 3000, 'bounceHint após o saque');
      if (await G(page, () => !!window.__pingpong.game.bounceHint)) {
        await shot(page, t, '10-bounce-hint');
        shotHint = true;
      }
    }
    await waitFor(page, () => window.__pingpong.game.phase === 'pointOver' || window.__pingpong.game.phase === 'gameOver',
      null, 15000, 'fim do ponto');
  }
  await sideSticks(0);
  lg = await G(page, () => window.__hintLog);
  check(shotHint, 'nenhum saque mostrou bounceHint');
  check(lg.hintFrames > 5, 'ajuda ligada mas bounceHint quase não apareceu (' + lg.hintFrames + ' frames)');
  check(lg.wrong.length === 0, 'bounceHint fora do lado/jogador de quem recebe: ' + JSON.stringify(lg.wrong[0]));
  for (const h of lg.hints) {
    check(Math.abs(h.x) <= TABLE_HALF + 1e-6 && Math.abs(h.z) <= TABLE_W_HALF + 1e-6, 'bounceHint fora da mesa ' + JSON.stringify(h));
    check(h.x * h.recvSide > 0, 'bounceHint não está na metade de quem recebe ' + JSON.stringify(h));
  }
  // A previsão bate com o quique real no lado de quem recebe (o mais próximo entre os quiques reais).
  let matched = 0;
  for (const h of lg.hints) {
    let best = 9;
    for (const b of lg.bounces) best = Math.min(best, Math.hypot(b.x - h.x, b.z - h.z));
    if (best < 0.05) matched++;
  }
  log('      dicas de quique: ' + lg.hints.length + ' (' + matched + ' batem com o quique real), ' +
    lg.hintFrames + '/' + lg.rallyFrames + ' frames de rally com dica');
  check(matched >= Math.ceil(lg.hints.length * 0.75), 'só ' + matched + '/' + lg.hints.length + ' dicas batem com o quique real');
  check(errors.length === 0, 'erros: ' + errors.join(' | '));
  await context.close();
});

scenario(11, 'Rally CPU x CPU: bola alta com sombra/linha (screenshot); bounceHint sempre do lado de quem recebe', async (browser, t) => {
  const { page, context, errors } = await openPage(browser, t, '?demo=1&level=normal');
  await page.evaluate(installHintLogger);
  // Espera uma bola alta sobre a mesa durante o rally (ápice depois do quique ou lob).
  await waitFor(page, () => {
    const g = window.__pingpong.game;
    return g.phase === 'rally' && g.rallyHits >= 2 && g.ball.y > 0.3 && Math.abs(g.ball.x) > 0.25 &&
      Math.abs(g.ball.x) < 1.1 && Math.abs(g.ball.z) < 0.7;
  }, null, 40000, 'bola alta no rally');
  const b = (await state(page)).ball;
  await shot(page, t, '11-rally-high-ball');
  log('      bola em x=' + b.x.toFixed(2) + ' y=' + b.y.toFixed(2) + ' z=' + b.z.toFixed(2));
  await waitFor(page, () => window.__hintLog.hints.length >= 12, null, 40000, '12 dicas de quique');
  const lg = await G(page, () => window.__hintLog);
  check(lg.wrong.length === 0, 'bounceHint fora do lado/jogador de quem recebe: ' + JSON.stringify(lg.wrong[0]));
  for (const h of lg.hints) check(h.x * h.recvSide > 0, 'bounceHint fora da metade de quem recebe ' + JSON.stringify(h));
  check(errors.length === 0, 'erros: ' + errors.join(' | '));
  await context.close();
});

// ---------------------------------------------------------------------------
// Execução
// ---------------------------------------------------------------------------

async function main() {
  if (!args.includes('--no-build')) {
    log('> build (dist/)');
    execFileSync(process.execPath, ['build.mjs'], { cwd: ROOT, stdio: 'inherit' });
  }
  check(existsSync(path.join(ROOT, 'dist', 'index.html')), 'dist/index.html não existe (rode npm run build)');
  const srv = await startServer(ROOT);
  const browser = await chromium.launch({
    headless: !args.includes('--headed'),
    args: ['--autoplay-policy=no-user-gesture-required']
  });
  const targets = [
    { name: 'src', base: srv.url, page: '/index.html' },
    { name: 'dist', base: srv.url, page: '/dist/index.html' }
  ].filter((t) => !ONLY || t.name === ONLY);
  const onlyIds = (args.find((a) => a.startsWith('--scenarios=')) || '').split('=')[1];
  const ids = onlyIds ? onlyIds.split(',').map(Number) : null;
  try {
    for (const t of targets) {
      log('\n=== ' + t.name + ' (' + t.page + ') ===');
      for (const sc of scenarios) {
        if (ids && ids.indexOf(sc.id) < 0) continue;
        const t0 = Date.now();
        try {
          await sc.fn(browser, t);
          results.push({ target: t.name, id: sc.id, title: sc.title, ok: true, ms: Date.now() - t0 });
          log('  ok   ' + sc.id + '. ' + sc.title + ' (' + ((Date.now() - t0) / 1000).toFixed(1) + 's)');
        } catch (e) {
          results.push({ target: t.name, id: sc.id, title: sc.title, ok: false, error: e.message });
          log('  FAIL ' + sc.id + '. ' + sc.title + '\n       ' + (e instanceof AssertionError ? e.message : e.stack));
        }
      }
    }
  } finally {
    await browser.close();
    await srv.close();
  }
  mkdirSync(SHOTS, { recursive: true });
  writeFileSync(path.join(SHOTS, 'report.json'), JSON.stringify({ date: new Date().toISOString(), results, metrics }, null, 2));
  const failed = results.filter((r) => !r.ok);
  log('\nMétricas de jogabilidade:');
  for (const k in metrics) log('  ' + k + ': ' + JSON.stringify(metrics[k]));
  log('\n' + (results.length - failed.length) + '/' + results.length + ' cenários ok. Relatório: ' +
    path.relative(ROOT, path.join(SHOTS, 'report.json')));
  if (failed.length || results.length === 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
