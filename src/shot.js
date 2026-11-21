// Golpes e saques (física 3D, contrato v2): calcula a velocidade de saída da bola após o
// contato com a raquete. x = comprimento, y = altura, z = largura da mesa.
import {
  TABLE_HALF, NET_H, BALL_R, HIT_RADIUS, PHYSICS_DT, AIR_DRAG
} from './constants.js';
import { stepBall, copyBall } from './physics.js';

// --- Ajustes locais dos golpes ---
// vx: velocidade horizontal base (m/s); spin: rad/s; depth: profundidade base do quique alvo
// (|x| no lado do oponente); margin: folga mínima sobre a rede (m); minVx: vx mínimo ao
// ajustar a trajetória; err: sensibilidade à dispersão; fastTol: tolerância a bola rápida.
export var SHOT_PARAMS = {
  block:   { vx: 4.5,  spin: 15,   depth: 0.85, margin: 0.07, minVx: 2.8, err: 0.6, fastTol: 1.6 },
  drive:   { vx: 7.0,  spin: 40,   depth: 0.95, margin: 0.05, minVx: 4.0, err: 0.85, fastTol: 1.0 },
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
var AIM_DEPTH = 0.3;          // quanto aim.depth muda a profundidade
var AIM_LATERAL = 0.55;       // z do alvo de quique = aim.lateral * 0.55 (dentro da mesa)
var SERVE_START_Z = 0.7;      // |z| máximo de onde o saque sai (para o 1º quique cair na mesa)
var PADDLE_POWER = 0.3;       // fração da velocidade da raquete que vira força extra
var PADDLE_POWER_MAX = 1.5;   // m/s
var SWEET_SPOT = 0.7;         // fração de HIT_RADIUS sem penalidade de contato
var EDGE_PENALTY = 0.25;      // perda de qualidade em 1.0*HIT_RADIUS (contato na borda)
var SMASH_HIGH_Y = 0.25;      // abaixo disto o smash fica arriscado
var DISPERSION_VY = 1.1;      // m/s por unidade de erro
var DISPERSION_VX = 0.10;     // fração por unidade de erro
var DISPERSION_SPIN = 30;     // rad/s por unidade de erro
var DISPERSION_VZ = 0.5;      // m/s por unidade de erro
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

// Mira normalizada { lateral (+z), depth (+1 = mais fundo) }, ambos em -1..1.
// Compatibilidade: formato antigo { x, y } (x de tela/mundo em direção ao oponente = mais fundo,
// ou seja depth = x * dir; y ignorado).
export function normalizeAim(aim, dir) {
  if (!aim) return { lateral: 0, depth: 0 };
  if (aim.lateral !== undefined || aim.depth !== undefined) {
    return { lateral: clamp(aim.lateral || 0, -1, 1), depth: clamp(aim.depth || 0, -1, 1) };
  }
  return { lateral: 0, depth: clamp((aim.x || 0) * dir, -1, 1) };
}

// vz que leva a bola de z0 até zT em t segundos, com arrasto linear (Magnus não atua em z).
function vzFor(z0, zT, t) {
  if (!(t > 1e-3)) return 0;
  var f = (1 - Math.exp(-AIR_DRAG * t)) / AIR_DRAG;
  return (zT - z0) / f;
}

function dist3(ball, paddle) {
  var dx = ball.x - paddle.x;
  var dy = ball.y - paddle.y;
  var dz = (ball.z || 0) - (paddle.z || 0);
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

export function canHit(ball, paddle, side) {
  if (!ball || !paddle || ball.dead) return false;
  if (dist3(ball, paddle) > HIT_RADIUS) return false;
  return ball.vx * side > 0 || Math.abs(ball.vx) < 0.5;
}

// Simula o voo (plano x-y, z=0) até o primeiro evento. Retorna {dist, netY, kind, t} onde dist é
// a distância (ao longo de dir) do quique; netY é a altura do centro ao cruzar x=0 (ou -1).
function flyToFirstBounce(x, y, vx, vy, spin, dir) {
  var b = { x: x, y: y, z: 0, vx: vx, vy: vy, vz: 0, spin: spin };
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
      if (e.type === 'net') return { dist: -0.5, netY: netY, kind: 'net', t: t };
      if (e.type === 'bounce') return { dist: e.x * dir, netY: netY, kind: 'bounce', t: t };
      if (e.type === 'floor') {
        return { dist: e.x * dir > TABLE_HALF ? 10 : -10, netY: netY, kind: 'floor', t: t };
      }
    }
  }
  return { dist: 10, netY: netY, kind: 'timeout', t: t };
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
  var d = dist3(ball, paddle) / HIT_RADIUS;
  var off = clamp((d - SWEET_SPOT) / (1 - SWEET_SPOT), 0, 1.2);
  var q = 1 - EDGE_PENALTY * Math.pow(off, 1.3);
  var bvz = ball.vz || 0;
  var inSpeed = Math.sqrt(ball.vx * ball.vx + ball.vy * ball.vy + bvz * bvz);
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
  var rng = opts.rng || Math.random;
  var p = SHOT_PARAMS[shotType];
  var dir = -side;
  var aim = normalizeAim(opts.aim, dir);

  var depth = clamp(p.depth + aim.depth * AIM_DEPTH, MIN_DEPTH, MAX_DEPTH - 0.05);
  var zTarget = aim.lateral * AIM_LATERAL;

  var power = clamp((paddle.vx || 0) * dir * PADDLE_POWER, 0, PADDLE_POWER_MAX);
  var vx = p.vx + power;
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
      chosen = { vx: curVx * dir, vy: s.vy, t: r.t };
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
  var g4 = gauss(rng);
  var outVx = chosen.vx * (1 + g1 * DISPERSION_VX * err);
  var outVy = chosen.vy + g2 * DISPERSION_VY * err;
  var outSpin = spin + g3 * DISPERSION_SPIN * err;
  var vz = vzFor(ball.z || 0, zTarget, chosen.t);
  var outVz = vz + g4 * DISPERSION_VZ * err;

  return { vx: outVx, vy: outVy, vz: outVz, spin: outSpin, quality: quality, type: shotType };
}

// Simula um saque; retorna {bounces, net, dead, netY, events, times}.
// bounces = posições ao longo de dir; events = eventos de quique (com z); times = instantes.
function simulateServe(start, side) {
  var b = copyBall(start);
  var dir = -side;
  var bounces = [];
  var events = [];
  var times = [];
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
      if (ev[i].type === 'bounce') { bounces.push(ev[i].x * dir); events.push(ev[i]); times.push(t); }
      else if (ev[i].type === 'net') net = true;
      else if (ev[i].type === 'floor') b.dead = true;
    }
  }
  return { bounces: bounces, net: net, dead: b.dead, netY: netY, events: events, times: times };
}

// Distância (ao longo de dir) do 2º quique, com categorias monótonas para bisseção.
function serveMetric(x, y, vx, vy, spin, side) {
  var r = simulateServe({ x: x, y: y, z: 0, vx: vx, vy: vy, vz: 0, spin: spin }, side);
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

function serveZAt2nd(x, y, z, vx, vy, vz, spin, side) {
  var r = simulateServe({ x: x, y: y, z: z, vx: vx, vy: vy, vz: vz, spin: spin }, side);
  if (r.events.length < 2) return null;
  return r.events[1].z;
}

function solveServeVz(x, y, z, vx, vy, spin, side, zTarget) {
  var r0 = simulateServe({ x: x, y: y, z: 0, vx: vx, vy: vy, vz: 0, spin: spin }, side);
  var t2 = r0.times.length >= 2 ? r0.times[1] : 0.6;
  var vz = vzFor(z, zTarget, t2);
  for (var it = 0; it < 3; it++) {
    var zz = serveZAt2nd(x, y, z, vx, vy, vz, spin, side);
    if (zz === null) break;
    var errZ = zTarget - zz;
    if (Math.abs(errZ) < 0.005) break;
    vz += errZ / ((1 - Math.exp(-AIR_DRAG * t2)) / AIR_DRAG);
  }
  return vz;
}

export function computeServe(opts) {
  var side = opts.side;
  var paddle = opts.paddle || { x: side * 1.6, y: 0.25, z: 0 };
  var type = SERVE_PARAMS[opts.shotType] ? opts.shotType : 'drive';
  var rng = opts.rng || Math.random;
  var p = SERVE_PARAMS[type];
  var dir = -side;
  var aim = normalizeAim(opts.aim, dir);

  // A bola sai da raquete, atrás da linha de fundo do sacador (altura mínima = lançamento).
  var x = side * Math.max(Math.abs(paddle.x), TABLE_HALF + 0.04);
  var y = clamp(paddle.y, SERVE_MIN_Y, SERVE_MAX_Y);
  var z = clamp(paddle.z || 0, -SERVE_START_Z, SERVE_START_Z);
  var depth = clamp(p.depth + aim.depth * AIM_DEPTH, 0.4, 1.2);
  var zTarget = aim.lateral * AIM_LATERAL;
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

  // Direção lateral: vz para o 2º quique cair em zTarget (o quique com spin altera um pouco vz,
  // então refina com a simulação 3D completa).
  var vz = solveServeVz(x, y, z, chosen.vx, chosen.vy, spin, side, zTarget);

  // Pequena variação natural e pequena chance de erro.
  var jitter = gauss(rng);
  var faultRoll = rng();
  var faultDir = rng() < 0.5 ? -1 : 1;
  var vyOut = chosen.vy + jitter * 0.03;
  if (faultRoll < SERVE_FAULT_CHANCE) vyOut += faultDir * (0.7 + 0.5 * rng());
  var vzOut = vz + gauss(rng) * 0.03;
  return { x: x, y: y, z: z, vx: chosen.vx, vy: vyOut, vz: vzOut, spin: spin };
}
