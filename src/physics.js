// Física 3D da bola e movimentação das raquetes (contrato v2 — visão superior).
// Coordenadas: x ao longo da mesa (rede em x=0), y = altura acima do tampo, z = largura.
// A posição (x, y, z) da bola é o CENTRO da bola: ela toca o tampo quando y = BALL_R.
import {
  TABLE_HALF, TABLE_W_HALF, NET_W_HALF, NET_H, BALL_R, GRAVITY, TABLE_RESTITUTION, FLOOR_Y,
  K_MAGNUS, AIR_DRAG, SPIN_DECAY, PHYSICS_DT, PADDLE_MAX_SPEED, PADDLE_ZONE
} from './constants.js';

// --- Ajustes locais ---
var MAX_SUBSTEP_DIST = 0.005;   // deslocamento máximo por subpasso (m)
var MAX_SUBSTEPS = 64;
var BOUNCE_SPIN_KICK = 0.002;   // |v horizontal| += spin*k no quique
var BOUNCE_SPIN_KEEP = 0.7;     // spin *= 0.7 no quique
var NET_CLIP_BAND = 0.012;      // faixa (m) logo abaixo do topo "efetivo" onde a bola raspa
var NET_CLIP_VX_KEEP = 0.6;     // raspando perde ~40% de vx
var NET_REBOUND = 0.15;         // rebatendo: vx = -vx*0.15
var PADDLE_ACCEL_RATE = 16;     // 1/s — suavização da velocidade da raquete
var PADDLE_DECEL_RATE = 22;     // 1/s — frenagem mais rápida que aceleração
var HEIGHT_TRACK_RATE = 22;     // 1/s — altura automática seguindo a bola
var HEIGHT_RETURN_RATE = 4;     // 1/s — volta para a altura de espera
var HEIGHT_FEED_MAX = 8;        // m/s — limite do feed-forward de vy da bola
export var PADDLE_WAIT_Y = 0.25; // altura de espera da raquete

function sign(v) { return v < 0 ? -1 : 1; }

export function createBall(x, y, z) {
  return {
    x: x === undefined ? 0 : x,
    y: y === undefined ? 0.3 : y,
    z: z === undefined ? 0 : z,
    vx: 0, vy: 0, vz: 0, spin: 0
  };
}

// Integra um subpasso de voo livre (sem colisões).
// Magnus só no plano vertical, proporcional a |vx| (mantém a calibração dos golpes e deixa o
// movimento em z desacoplado: z(t) = z0 + vz*(1 - e^(-D t))/D).
function integrateAir(ball, h) {
  var ay = -GRAVITY - K_MAGNUS * ball.spin * Math.abs(ball.vx);
  ball.vy += ay * h;
  var drag = 1 - AIR_DRAG * h;
  ball.vx *= drag;
  ball.vy *= drag;
  ball.vz *= drag;
  ball.x += ball.vx * h;
  ball.y += ball.vy * h;
  ball.z += ball.vz * h;
  ball.spin *= (1 - SPIN_DECAY * h);
}

function substep(ball, h, events) {
  var px = ball.x;
  var py = ball.y;
  var pz = ball.z;
  integrateAir(ball, h);

  // --- Rede (cruzamento de x = 0; só entre os postes, |z| <= NET_W_HALF) ---
  if ((px < 0 && ball.x >= 0) || (px > 0 && ball.x <= 0)) {
    var tN = px / (px - ball.x);
    var yN = py + (ball.y - py) * tN;
    var zN = pz + (ball.z - pz) * tN;
    var top = NET_H + BALL_R;
    if (yN < top && yN >= 0 && Math.abs(zN) <= NET_W_HALF) {
      var clip = yN >= top - NET_CLIP_BAND;
      if (clip) {
        ball.vx *= NET_CLIP_VX_KEEP;
        ball.vz *= NET_CLIP_VX_KEEP;
        // a fita da rede dá um pequeno "pulo" na bola
        ball.vy = Math.abs(ball.vy) * 0.3 + 0.4;
        if (ball.y < top) ball.y = top;
        ball.spin *= 0.5;
      } else {
        var from = sign(px);
        ball.vx = -ball.vx * NET_REBOUND;
        ball.x = from * (BALL_R + 0.001);
        ball.y = yN;
        ball.z = zN;
        ball.vy *= 0.5;
        ball.vz *= 0.5;
        ball.spin *= 0.3;
      }
      events.push({ type: 'net', clip: clip });
    }
  }

  // --- Tampo da mesa (centro cruza y = BALL_R descendo, dentro de x e z da mesa) ---
  if (py >= BALL_R && ball.y < BALL_R && ball.vy < 0) {
    var tT = (py - BALL_R) / (py - ball.y);
    var xT = px + (ball.x - px) * tT;
    var zT = pz + (ball.z - pz) * tT;
    if (Math.abs(xT) <= TABLE_HALF && Math.abs(zT) <= TABLE_W_HALF) {
      ball.y = BALL_R + (BALL_R - ball.y) * TABLE_RESTITUTION;
      ball.vy = -ball.vy * TABLE_RESTITUTION;
      // topspin acelera / backspin freia, ao longo da direção horizontal do movimento
      var hs = Math.sqrt(ball.vx * ball.vx + ball.vz * ball.vz);
      var kick = ball.spin * BOUNCE_SPIN_KICK;
      if (hs > 1e-6) {
        ball.vx += (ball.vx / hs) * kick;
        ball.vz += (ball.vz / hs) * kick;
      } else {
        ball.vx += sign(ball.vx) * kick;
      }
      ball.spin *= BOUNCE_SPIN_KEEP;
      events.push({ type: 'bounce', side: xT < 0 ? -1 : 1, x: xT, z: zT });
    }
  }

  // --- Chão ---
  if (ball.y <= FLOOR_Y + BALL_R) {
    var tF = py > ball.y ? (py - (FLOOR_Y + BALL_R)) / (py - ball.y) : 1;
    var xF = px + (ball.x - px) * tF;
    var zF = pz + (ball.z - pz) * tF;
    ball.x = xF;
    ball.y = FLOOR_Y + BALL_R;
    ball.z = zF;
    ball.vx = 0;
    ball.vy = 0;
    ball.vz = 0;
    ball.spin = 0;
    ball.dead = true;
    events.push({ type: 'floor', x: xF, z: zF });
  }
}

// Avança a bola dt segundos (com subpassos). Muta `ball`. Retorna eventos.
export function stepBall(ball, dt) {
  var events = [];
  if (ball.dead) return events;
  if (ball.z === undefined) ball.z = 0;
  if (ball.vz === undefined) ball.vz = 0;
  var speed = Math.max(Math.abs(ball.vx), Math.abs(ball.vy), Math.abs(ball.vz));
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
  var c = {
    x: ball.x, y: ball.y, z: ball.z || 0,
    vx: ball.vx, vy: ball.vy, vz: ball.vz || 0,
    spin: ball.spin || 0
  };
  if (ball.dead) c.dead = true;
  return c;
}

// Simula uma cópia da bola. Retorna amostras [{t, x, y, z, vx, vy, vz, events}].
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
    out.push({ t: t, x: b.x, y: b.y, z: b.z, vx: b.vx, vy: b.vy, vz: b.vz, events: ev });
  }
  return out;
}

// Zona da raquete do lado `side` (PADDLE_ZONE é do lado esquerdo; o direito é espelhado em x).
export function paddleZone(side) {
  var zone = {
    xMin: PADDLE_ZONE.xMin, xMax: PADDLE_ZONE.xMax,
    yMin: PADDLE_ZONE.yMin, yMax: PADDLE_ZONE.yMax,
    zMin: PADDLE_ZONE.zMin, zMax: PADDLE_ZONE.zMax
  };
  if (side === 1) {
    zone.xMin = -PADDLE_ZONE.xMax;
    zone.xMax = -PADDLE_ZONE.xMin;
  }
  return zone;
}

export function clampPaddle(paddle, side) {
  var z = paddleZone(side);
  if (paddle.z === undefined) paddle.z = 0;
  if (paddle.x < z.xMin) { paddle.x = z.xMin; if (paddle.vx < 0) paddle.vx = 0; }
  if (paddle.x > z.xMax) { paddle.x = z.xMax; if (paddle.vx > 0) paddle.vx = 0; }
  if (paddle.y < z.yMin) { paddle.y = z.yMin; if (paddle.vy < 0) paddle.vy = 0; }
  if (paddle.y > z.yMax) { paddle.y = z.yMax; if (paddle.vy > 0) paddle.vy = 0; }
  if (paddle.z < z.zMin) { paddle.z = z.zMin; if (paddle.vz < 0) paddle.vz = 0; }
  if (paddle.z > z.zMax) { paddle.z = z.zMax; if (paddle.vz > 0) paddle.vz = 0; }
  return paddle;
}

function approach(v, target, dt) {
  // acelera suave; freia/inverte mais rápido
  var rate = (Math.abs(target) < Math.abs(v) || target * v < 0) ? PADDLE_DECEL_RATE : PADDLE_ACCEL_RATE;
  var k = rate * dt;
  if (k > 1) k = 1;
  return v + (target - v) * k;
}

// moveX/moveZ em -1..1, em coordenadas de MUNDO (+x ao longo da mesa, +z na largura).
// Não mexe em y (a altura é automática: ver trackPaddleHeight).
export function movePaddle(paddle, side, moveX, moveZ, dt) {
  var mx = moveX || 0;
  var mz = moveZ || 0;
  var mag = Math.sqrt(mx * mx + mz * mz);
  if (mag > 1) { mx /= mag; mz /= mag; }
  if (paddle.vx === undefined) paddle.vx = 0;
  if (paddle.vz === undefined) paddle.vz = 0;
  if (paddle.z === undefined) paddle.z = 0;
  paddle.vx = approach(paddle.vx, mx * PADDLE_MAX_SPEED, dt);
  paddle.vz = approach(paddle.vz, mz * PADDLE_MAX_SPEED, dt);
  var sp = Math.sqrt(paddle.vx * paddle.vx + paddle.vz * paddle.vz);
  if (sp > PADDLE_MAX_SPEED) {
    paddle.vx *= PADDLE_MAX_SPEED / sp;
    paddle.vz *= PADDLE_MAX_SPEED / sp;
  }
  paddle.x += paddle.vx * dt;
  paddle.z += paddle.vz * dt;
  return clampPaddle(paddle, side);
}

// Altura automática da raquete. Quando a bola vem em direção ao lado (ball.vx*side > 0) ou está
// quase parada, suaviza paddle.y em direção a ball.y (limitado à zona), com feed-forward de
// ball.vy para não ficar atrasada. Caso contrário volta suavemente para PADDLE_WAIT_Y.
// Atualiza paddle.vy com a velocidade vertical resultante.
export function trackPaddleHeight(paddle, ball, side, dt) {
  var zone = paddleZone(side);
  var y0 = paddle.y === undefined ? PADDLE_WAIT_Y : paddle.y;
  var y = y0;
  var tracking = !!ball && !ball.dead && (ball.vx * side > 0 || Math.abs(ball.vx) < 0.5);
  if (tracking) {
    var target = ball.y;
    var inside = true;
    if (target < zone.yMin) { target = zone.yMin; inside = false; }
    if (target > zone.yMax) { target = zone.yMax; inside = false; }
    if (inside) {
      var feed = ball.vy || 0;
      if (feed > HEIGHT_FEED_MAX) feed = HEIGHT_FEED_MAX;
      if (feed < -HEIGHT_FEED_MAX) feed = -HEIGHT_FEED_MAX;
      y += feed * dt;
    }
    var k = HEIGHT_TRACK_RATE * dt;
    if (k > 1) k = 1;
    y += (target - y) * k;
  } else {
    var kr = HEIGHT_RETURN_RATE * dt;
    if (kr > 1) kr = 1;
    y += (PADDLE_WAIT_Y - y) * kr;
  }
  if (y < zone.yMin) y = zone.yMin;
  if (y > zone.yMax) y = zone.yMax;
  paddle.y = y;
  paddle.vy = dt > 0 ? (y - y0) / dt : 0;
  return paddle;
}
