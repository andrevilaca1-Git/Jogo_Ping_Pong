// Física da bola e movimentação das raquetes (visão lateral 2D).
// Coordenadas: x ao longo da mesa (rede em x=0), y = altura acima do tampo.
// A posição (x, y) da bola é o CENTRO da bola: ela toca o tampo quando y = BALL_R.
import {
  TABLE_HALF, NET_H, BALL_R, GRAVITY, TABLE_RESTITUTION, FLOOR_Y, K_MAGNUS,
  AIR_DRAG, SPIN_DECAY, PHYSICS_DT, PADDLE_MAX_SPEED, PADDLE_ZONE
} from './constants.js';

// --- Ajustes locais ---
var MAX_SUBSTEP_DIST = 0.005;   // deslocamento máximo por subpasso (m)
var MAX_SUBSTEPS = 64;
var BOUNCE_SPIN_KICK = 0.002;   // vx += sign(vx)*spin*k no quique
var BOUNCE_SPIN_KEEP = 0.7;     // spin *= 0.7 no quique
var NET_CLIP_BAND = 0.012;      // faixa (m) logo abaixo do topo "efetivo" onde a bola raspa
var NET_CLIP_VX_KEEP = 0.6;     // raspando perde ~40% de vx
var NET_REBOUND = 0.15;         // rebatendo: vx = -vx*0.15
var PADDLE_ACCEL_RATE = 16;     // 1/s — suavização da velocidade da raquete
var PADDLE_DECEL_RATE = 22;     // 1/s — frenagem mais rápida que aceleração

function sign(v) { return v < 0 ? -1 : 1; }

export function createBall(x, y) {
  return { x: x === undefined ? 0 : x, y: y === undefined ? 0.3 : y, vx: 0, vy: 0, spin: 0 };
}

// Integra um subpasso de voo livre (sem colisões).
function integrateAir(ball, h) {
  var ay = -GRAVITY - K_MAGNUS * ball.spin * Math.abs(ball.vx);
  ball.vy += ay * h;
  var drag = 1 - AIR_DRAG * h;
  ball.vx *= drag;
  ball.vy *= drag;
  ball.x += ball.vx * h;
  ball.y += ball.vy * h;
  ball.spin *= (1 - SPIN_DECAY * h);
}

function substep(ball, h, events) {
  var px = ball.x;
  var py = ball.y;
  integrateAir(ball, h);

  // --- Rede (cruzamento de x = 0 entre posição anterior e nova) ---
  if ((px < 0 && ball.x >= 0) || (px > 0 && ball.x <= 0)) {
    var tN = px / (px - ball.x);
    var yN = py + (ball.y - py) * tN;
    var top = NET_H + BALL_R;
    if (yN < top && yN >= 0) {
      var clip = yN >= top - NET_CLIP_BAND;
      if (clip) {
        ball.vx *= NET_CLIP_VX_KEEP;
        // a fita da rede dá um pequeno "pulo" na bola
        ball.vy = Math.abs(ball.vy) * 0.3 + 0.4;
        if (ball.y < top) ball.y = top;
        ball.spin *= 0.5;
      } else {
        var from = sign(px);
        ball.vx = -ball.vx * NET_REBOUND;
        ball.x = from * (BALL_R + 0.001);
        ball.y = yN;
        ball.vy *= 0.5;
        ball.spin *= 0.3;
      }
      events.push({ type: 'net', clip: clip });
    }
  }

  // --- Tampo da mesa (centro cruza y = BALL_R descendo) ---
  if (py >= BALL_R && ball.y < BALL_R && ball.vy < 0) {
    var tT = (py - BALL_R) / (py - ball.y);
    var xT = px + (ball.x - px) * tT;
    if (Math.abs(xT) <= TABLE_HALF) {
      ball.y = BALL_R + (BALL_R - ball.y) * TABLE_RESTITUTION;
      ball.vy = -ball.vy * TABLE_RESTITUTION;
      ball.vx += sign(ball.vx) * ball.spin * BOUNCE_SPIN_KICK;
      ball.spin *= BOUNCE_SPIN_KEEP;
      events.push({ type: 'bounce', side: xT < 0 ? -1 : 1, x: xT });
    }
  }

  // --- Chão ---
  if (ball.y <= FLOOR_Y + BALL_R) {
    var tF = py > ball.y ? (py - (FLOOR_Y + BALL_R)) / (py - ball.y) : 1;
    var xF = px + (ball.x - px) * tF;
    ball.x = xF;
    ball.y = FLOOR_Y + BALL_R;
    ball.vx = 0;
    ball.vy = 0;
    ball.spin = 0;
    ball.dead = true;
    events.push({ type: 'floor', x: xF });
  }
}

// Avança a bola dt segundos (com subpassos). Muta `ball`. Retorna eventos.
export function stepBall(ball, dt) {
  var events = [];
  if (ball.dead) return events;
  var speed = Math.max(Math.abs(ball.vx), Math.abs(ball.vy));
  var n = Math.ceil((speed * dt) / MAX_SUBSTEP_DIST);
  if (n < 1) n = 1;
  if (n > MAX_SUBSTEPS) n = MAX_SUBSTEPS;
  var h = dt / n;
  for (var i = 0; i < n; i++) {
    substep(ball, h, events);
    if (ball.dead) break;
  }
  return events;
}

export function copyBall(ball) {
  var c = { x: ball.x, y: ball.y, vx: ball.vx, vy: ball.vy, spin: ball.spin || 0 };
  if (ball.dead) c.dead = true;
  return c;
}

// Simula uma cópia da bola. Retorna amostras [{t, x, y, vx, vy, events}].
export function predictBall(ball, maxTime, dt) {
  if (dt === undefined) dt = PHYSICS_DT;
  var b = copyBall(ball);
  var out = [];
  var t = 0;
  var steps = Math.ceil(maxTime / dt);
  for (var i = 0; i < steps; i++) {
    if (b.dead) break;
    var ev = stepBall(b, dt);
    t += dt;
    out.push({ t: t, x: b.x, y: b.y, vx: b.vx, vy: b.vy, events: ev });
  }
  return out;
}

export function paddleZone(side) {
  if (side === 1) {
    return { xMin: -PADDLE_ZONE.xMax, xMax: -PADDLE_ZONE.xMin, yMin: PADDLE_ZONE.yMin, yMax: PADDLE_ZONE.yMax };
  }
  return { xMin: PADDLE_ZONE.xMin, xMax: PADDLE_ZONE.xMax, yMin: PADDLE_ZONE.yMin, yMax: PADDLE_ZONE.yMax };
}

export function clampPaddle(paddle, side) {
  var z = paddleZone(side);
  if (paddle.x < z.xMin) { paddle.x = z.xMin; if (paddle.vx < 0) paddle.vx = 0; }
  if (paddle.x > z.xMax) { paddle.x = z.xMax; if (paddle.vx > 0) paddle.vx = 0; }
  if (paddle.y < z.yMin) { paddle.y = z.yMin; if (paddle.vy < 0) paddle.vy = 0; }
  if (paddle.y > z.yMax) { paddle.y = z.yMax; if (paddle.vy > 0) paddle.vy = 0; }
  return paddle;
}

function approach(v, target, dt) {
  // acelera suave; freia/inverte mais rápido
  var rate = (Math.abs(target) < Math.abs(v) || target * v < 0) ? PADDLE_DECEL_RATE : PADDLE_ACCEL_RATE;
  var k = rate * dt;
  if (k > 1) k = 1;
  return v + (target - v) * k;
}

// moveX/moveY em -1..1 (coordenadas de tela: direita +, cima +; x de tela = x do mundo).
export function movePaddle(paddle, side, moveX, moveY, dt) {
  var mx = moveX || 0;
  var my = moveY || 0;
  var mag = Math.sqrt(mx * mx + my * my);
  if (mag > 1) { mx /= mag; my /= mag; }
  if (paddle.vx === undefined) paddle.vx = 0;
  if (paddle.vy === undefined) paddle.vy = 0;
  paddle.vx = approach(paddle.vx, mx * PADDLE_MAX_SPEED, dt);
  paddle.vy = approach(paddle.vy, my * PADDLE_MAX_SPEED, dt);
  var sp = Math.sqrt(paddle.vx * paddle.vx + paddle.vy * paddle.vy);
  if (sp > PADDLE_MAX_SPEED) {
    paddle.vx *= PADDLE_MAX_SPEED / sp;
    paddle.vy *= PADDLE_MAX_SPEED / sp;
  }
  paddle.x += paddle.vx * dt;
  paddle.y += paddle.vy * dt;
  return clampPaddle(paddle, side);
}
