// Golpes e saques: calcula a velocidade de saída da bola após o contato com a raquete.
import {
  TABLE_HALF, NET_H, BALL_R, HIT_RADIUS, PHYSICS_DT
} from './constants.js';
import { stepBall, copyBall } from './physics.js';

// --- Ajustes locais dos golpes ---
// vx: velocidade horizontal base (m/s); spin: rad/s; depth: profundidade base do quique alvo
// (|x| no lado do oponente); margin: folga mínima sobre a rede (m); minVx: vx mínimo ao
// ajustar a trajetória; err: sensibilidade à dispersão; fastTol: tolerância a bola rápida.
export var SHOT_PARAMS = {
  block:   { vx: 4.5,  spin: 15,   depth: 0.85, margin: 0.07, minVx: 2.8, err: 0.6, fastTol: 1.6 },
  drive:   { vx: 7.0,  spin: 40,   depth: 0.95, margin: 0.05, minVx: 4.0, err: 1.0, fastTol: 1.0 },
  topspin: { vx: 8.0,  spin: 120,  depth: 1.00, margin: 0.06, minVx: 4.5, err: 0.85, fastTol: 1.1 },
  chop:    { vx: 4.5,  spin: -100, depth: 0.90, margin: 0.035, minVx: 3.0, err: 0.85, fastTol: 1.2 },
  smash:   { vx: 12.5, spin: 25,   depth: 0.95, margin: 0.025, minVx: 9.0, err: 1.3, fastTol: 0.8 }
};

// Saque: velocidade horizontal, spin e profundidade do 2º quique.
export var SERVE_PARAMS = {
  block:   { vx: 3.6, spin: 20,  depth: 0.85 },
  drive:   { vx: 4.2, spin: 30,  depth: 0.95 },
  topspin: { vx: 4.6, spin: 90,  depth: 1.0 },
  chop:    { vx: 3.4, spin: -90, depth: 0.75 },
  smash:   { vx: 5.4, spin: 40,  depth: 1.1 }
};

var MIN_DEPTH = 0.35;
var MAX_DEPTH = 1.25;
var AIM_DEPTH = 0.3;          // quanto aim.x muda a profundidade
var PADDLE_POWER = 0.3;       // fração da velocidade da raquete que vira força extra
var PADDLE_POWER_MAX = 1.5;   // m/s
var SWEET_SPOT = 0.25;        // fração de HIT_RADIUS sem penalidade de contato
var SMASH_HIGH_Y = 0.25;      // abaixo disto o smash fica arriscado
var DISPERSION_VY = 1.1;      // m/s por unidade de erro
var DISPERSION_VX = 0.10;     // fração por unidade de erro
var DISPERSION_SPIN = 30;     // rad/s por unidade de erro
var SERVE_FAULT_CHANCE = 0.025;
var SERVE_NET_MARGIN = 0.03;   // folga mínima do saque sobre a rede (m)
var SERVE_ROBUST_DVY = 0.08;  // vizinhança de vy que também precisa ser válida
var SERVE_MIN_Y = 0.15;       // altura mínima de saída (bola lançada)
var SERVE_MAX_Y = 0.6;
var SIM_DT = PHYSICS_DT;
var SIM_MAX_T = 2.5;

function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }

function gauss(rng) {
  var u = rng();
  var v = rng();
  if (u < 1e-9) u = 1e-9;
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function paramsFor(table, type) {
  return table[type] || table.drive;
}

export function canHit(ball, paddle, side) {
  if (!ball || !paddle || ball.dead) return false;
  var dx = ball.x - paddle.x;
  var dy = ball.y - paddle.y;
  if (dx * dx + dy * dy > HIT_RADIUS * HIT_RADIUS) return false;
  return ball.vx * side > 0 || Math.abs(ball.vx) < 0.5;
}

// Simula o voo até o primeiro evento. Retorna {dist, netY, ok} onde dist é a distância
// (ao longo de dir) do quique; netY é a altura do centro ao cruzar x=0 (ou -1).
function flyToFirstBounce(x, y, vx, vy, spin, dir) {
  var b = { x: x, y: y, vx: vx, vy: vy, spin: spin };
  var netY = -1;
  var t = 0;
  while (t < SIM_MAX_T) {
    var px = b.x;
    var py = b.y;
    var ev = stepBall(b, SIM_DT);
    t += SIM_DT;
    if (netY < 0 && ((px < 0 && b.x >= 0) || (px > 0 && b.x <= 0))) {
      var k = px / (px - b.x);
      netY = py + (b.y - py) * k;
    }
    for (var i = 0; i < ev.length; i++) {
      var e = ev[i];
      if (e.type === 'net') return { dist: -0.5, netY: netY, kind: 'net' };
      if (e.type === 'bounce') return { dist: e.x * dir, netY: netY, kind: 'bounce' };
      if (e.type === 'floor') {
        return { dist: e.x * dir > TABLE_HALF ? 10 : -10, netY: netY, kind: 'floor' };
      }
    }
  }
  return { dist: 10, netY: netY, kind: 'timeout' };
}

// Bisseção em vy para que o primeiro quique caia em `target` (distância ao longo de dir).
function solveVy(x, y, vx, spin, dir, target) {
  var lo = -10;
  var hi = 10;
  var best = null;
  for (var it = 0; it < 34; it++) {
    var mid = (lo + hi) / 2;
    var r = flyToFirstBounce(x, y, vx, mid, spin, dir);
    if (r.dist < target) lo = mid; else hi = mid;
    best = { vy: mid, res: r };
    if (r.kind === 'bounce' && Math.abs(r.dist - target) < 0.004) break;
  }
  return best;
}

function contactQuality(ball, paddle, shotType, p) {
  var dx = ball.x - paddle.x;
  var dy = ball.y - paddle.y;
  var d = Math.sqrt(dx * dx + dy * dy) / HIT_RADIUS;
  var off = clamp((d - SWEET_SPOT) / (1 - SWEET_SPOT), 0, 1.2);
  var q = 1 - 0.8 * Math.pow(off, 1.3);
  var inSpeed = Math.sqrt(ball.vx * ball.vx + ball.vy * ball.vy);
  if (inSpeed > 7) q -= (inSpeed - 7) * 0.04 / p.fastTol;
  var inSpin = Math.abs(ball.spin || 0);
  if (inSpin > 60) q -= (inSpin - 60) * 0.002 / p.fastTol;
  if (shotType === 'smash' && ball.y < SMASH_HIGH_Y) q -= (SMASH_HIGH_Y - ball.y) * 2.4;
  return clamp(q, 0.05, 1);
}

export function computeShot(opts) {
  var ball = opts.ball;
  var paddle = opts.paddle;
  var side = opts.side;
  var shotType = SHOT_PARAMS[opts.shotType] ? opts.shotType : 'drive';
  var aim = opts.aim || { x: 0, y: 0 };
  var rng = opts.rng || Math.random;
  var p = SHOT_PARAMS[shotType];
  var dir = -side;

  var ax = clamp(aim.x || 0, -1, 1);
  var ay = clamp(aim.y || 0, -1, 1);
  var depth = clamp(p.depth + ax * dir * AIM_DEPTH, MIN_DEPTH, MAX_DEPTH - 0.05);

  var power = clamp((paddle.vx || 0) * dir * PADDLE_POWER, 0, PADDLE_POWER_MAX);
  var vx = p.vx * (1 - 0.1 * ay) + power;
  var spin = p.spin;

  var quality = contactQuality(ball, paddle, shotType, p);

  // Ajusta trajetória: tenta o alvo; se não passa a rede com folga, aprofunda o alvo e reduz vx.
  var clearTop = NET_H + BALL_R + p.margin;
  var chosen = null;
  var bestScore = -1e9;
  var curVx = vx;
  var curDepth = depth;
  for (var attempt = 0; attempt < 14; attempt++) {
    var s = solveVy(ball.x, ball.y, curVx * dir, spin, dir, curDepth);
    var r = s.res;
    var landOk = r.kind === 'bounce' && r.dist > 0.15 && r.dist < TABLE_HALF - 0.08;
    var clear = r.netY - clearTop;
    var score = (landOk ? 0 : -1) + Math.min(clear, 0) * 5;
    if (score > bestScore) {
      bestScore = score;
      chosen = { vx: curVx * dir, vy: s.vy };
    }
    if (landOk && clear >= 0) break;
    if (attempt % 2 === 0 && curDepth < MAX_DEPTH - 0.05) {
      curDepth = Math.min(curDepth + 0.08, MAX_DEPTH - 0.05);
    } else {
      curVx = Math.max(curVx * 0.9, p.minVx);
    }
  }

  // Dispersão proporcional a (1 - quality).
  var err = (1 - quality) * p.err;
  var g1 = gauss(rng);
  var g2 = gauss(rng);
  var g3 = gauss(rng);
  var outVx = chosen.vx * (1 + g1 * DISPERSION_VX * err);
  var outVy = chosen.vy + g2 * DISPERSION_VY * err;
  var outSpin = spin + g3 * DISPERSION_SPIN * err;

  return { vx: outVx, vy: outVy, spin: outSpin, quality: quality, type: shotType };
}

// Simula um saque; retorna {bounces, net, dead, netY}.
function simulateServe(start, side) {
  var b = copyBall(start);
  var dir = -side;
  var bounces = [];
  var net = false;
  var netY = -1;
  var t = 0;
  while (t < SIM_MAX_T && bounces.length < 2 && !b.dead) {
    var px = b.x;
    var py = b.y;
    var ev = stepBall(b, SIM_DT);
    t += SIM_DT;
    if (netY < 0 && ((px < 0 && b.x >= 0) || (px > 0 && b.x <= 0))) {
      netY = py + (b.y - py) * (px / (px - b.x));
    }
    for (var i = 0; i < ev.length; i++) {
      if (ev[i].type === 'bounce') bounces.push(ev[i].x * dir);
      else if (ev[i].type === 'net') net = true;
      else if (ev[i].type === 'floor') b.dead = true;
    }
  }
  return { bounces: bounces, net: net, dead: b.dead, netY: netY };
}

// Distância (ao longo de dir) do 2º quique, com categorias monótonas para bisseção.
function serveMetric(x, y, vx, vy, spin, side) {
  var r = simulateServe({ x: x, y: y, vx: vx, vy: vy, spin: spin }, side);
  if (r.bounces.length === 0) return { d: r.dead ? -20 : 20, r: r };
  if (r.bounces[0] > 0) return { d: 20, r: r };          // 1º quique já no lado do recebedor
  if (r.net || r.netY < NET_H + BALL_R + SERVE_NET_MARGIN) return { d: -5, r: r };
  if (r.bounces.length < 2) return { d: 20, r: r };      // passou do fundo depois do 1º quique
  return { d: r.bounces[1], r: r };
}

// Saque válido: 1º quique no lado do sacador, 2º no lado do recebedor, sem tocar a rede.
// `r.bounces` são posições ao longo da direção do saque (negativo = lado do sacador).
export function isValidServe(r) {
  return !r.net && r.bounces.length >= 2 && r.bounces[0] < 0 && r.bounces[1] > 0 &&
    r.bounces[1] <= TABLE_HALF && r.bounces[0] >= -TABLE_HALF;
}

function serveScore(m, depth) {
  if (!isValidServe(m.r) || m.r.netY < NET_H + BALL_R + SERVE_NET_MARGIN) return -1;
  var b2 = m.r.bounces[1];
  if (b2 > TABLE_HALF - 0.06 || m.r.bounces[0] > -0.1 || m.r.bounces[0] < -TABLE_HALF + 0.08) return -1;
  var score = 1 / (1 + Math.abs(b2 - depth) * 10);
  // prefere saques baixos (sem "balão")
  if (m.r.netY > 0.4) score -= (m.r.netY - 0.4) * 0.5;
  return score;
}

// Pontuação robusta: o pior caso entre vy e vizinhos (evita soluções na borda da mesa/rede).
function robustServeScore(x, y, vx, vy, spin, side, depth) {
  var s0 = serveScore(serveMetric(x, y, vx, vy, spin, side), depth);
  if (s0 < 0) return s0;
  var s1 = serveScore(serveMetric(x, y, vx, vy - SERVE_ROBUST_DVY, spin, side), depth);
  if (s1 < 0) return s1;
  var s2 = serveScore(serveMetric(x, y, vx, vy + SERVE_ROBUST_DVY, spin, side), depth);
  if (s2 < 0) return s2;
  return s0;
}

export function computeServe(opts) {
  var side = opts.side;
  var paddle = opts.paddle || { x: side * 1.6, y: 0.25 };
  var type = SERVE_PARAMS[opts.shotType] ? opts.shotType : 'drive';
  var aim = opts.aim || { x: 0, y: 0 };
  var rng = opts.rng || Math.random;
  var p = SERVE_PARAMS[type];
  var dir = -side;

  // A bola sai da raquete, atrás da linha de fundo do sacador (altura mínima = lançamento).
  var x = side * Math.max(Math.abs(paddle.x), TABLE_HALF + 0.04);
  var y = clamp(paddle.y, SERVE_MIN_Y, SERVE_MAX_Y);
  var ax = clamp(aim.x || 0, -1, 1);
  var depth = clamp(p.depth + ax * dir * AIM_DEPTH, 0.4, 1.2);
  var spin = p.spin;

  // Busca: para alguns vx candidatos, varredura em vy + refinamento local (a relação vy -> 2º
  // quique não é monótona: há a janela "bola cortada para baixo" e a janela "balão").
  var factors = [1, 0.85, 1.15, 0.7, 0.55];
  var best = null;
  var bestScore = -1;
  for (var f = 0; f < factors.length; f++) {
    var vx = p.vx * factors[f] * dir;
    var fBest = null;
    var fScore = -1;
    for (var vy = -6; vy <= 4.001; vy += 0.25) {
      var sc = robustServeScore(x, y, vx, vy, spin, side, depth);
      if (sc > fScore) { fScore = sc; fBest = vy; }
    }
    if (fBest === null) continue;
    var step = 0.125;
    for (var it = 0; it < 7; it++) {
      for (var k = -1; k <= 1; k += 2) {
        var cand = fBest + k * step;
        var sc2 = robustServeScore(x, y, vx, cand, spin, side, depth);
        if (sc2 > fScore) { fScore = sc2; fBest = cand; }
      }
      step /= 2;
    }
    if (fScore > bestScore) { bestScore = fScore; best = { vx: vx, vy: fBest }; }
    if (bestScore > 0.7) break;
  }
  var chosen = best || { vx: p.vx * dir, vy: -1.0 };

  // Pequena variação natural e pequena chance de erro.
  var jitter = gauss(rng);
  var faultRoll = rng();
  var faultDir = rng() < 0.5 ? -1 : 1;
  var vyOut = chosen.vy + jitter * 0.03;
  if (faultRoll < SERVE_FAULT_CHANCE) vyOut += faultDir * (0.7 + 0.5 * rng());
  return { x: x, y: y, vx: chosen.vx, vy: vyOut, spin: spin };
}
