// Renderização Canvas 2D para TV (canvas lógico 1920x1080 escalado mantendo proporção).
// Física é 2D (visão lateral); o tampo é desenhado como trapézio fino para dar profundidade.
import { TABLE_HALF, NET_H, BALL_R, FLOOR_Y, PADDLE_R } from './constants.js';
import { isGamePoint, isMatchPoint, isDeuce, getServer } from './rules.js';
import { getMenuItems, PAUSE_ITEMS, MATCH_OVER_ITEMS, DIFFICULTY_TEXT } from './game.js';

export const VIEW_W = 1920;
export const VIEW_H = 1080;
const SAFE_X = 96;   // 5% de 1920
const SAFE_Y = 54;   // 5% de 1080
const FLOOR_SCREEN_Y = 930;

const FONT = '"Segoe UI", "Samsung One", Roboto, "Helvetica Neue", Arial, sans-serif';
const COLORS = {
  p1: '#ff4b3e',
  p1dark: '#a3161b',
  p2: '#3d8bff',
  p2dark: '#0d2d6b',
  ball: '#ff9a1f',
  gold: '#ffd25a',
  text: '#f4f6fb',
  dim: 'rgba(244,246,251,0.62)',
  panel: 'rgba(10,14,28,0.82)',
  tableTop: '#1f5fae',
  tableTopFar: '#184c8e',
  tableFace: '#0d2f5e',
  line: '#f8fbff'
};
const PLAYER_COLOR = [COLORS.p1, COLORS.p2];
const PLAYER_DARK = [COLORS.p1dark, COLORS.p2dark];

const TRAIL_LEN = 16;
const MAX_PARTICLES = 140;
const MAX_RINGS = 16;

function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }

function font(size, weight) {
  return (weight || '700') + ' ' + size + 'px ' + FONT;
}

function roundRectPath(ctx, x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.lineTo(x + w - rr, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + rr);
  ctx.lineTo(x + w, y + h - rr);
  ctx.quadraticCurveTo(x + w, y + h, x + w - rr, y + h);
  ctx.lineTo(x + rr, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - rr);
  ctx.lineTo(x, y + rr);
  ctx.quadraticCurveTo(x, y, x + rr, y);
  ctx.closePath();
}

function fillRound(ctx, x, y, w, h, r, color) {
  roundRectPath(ctx, x, y, w, h, r);
  ctx.fillStyle = color;
  ctx.fill();
}

function makeCanvas(w, h) {
  if (typeof document === 'undefined') return null;
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

// ---------------------------------------------------------------------------
// Fundo estático (pré-renderizado uma vez)
// ---------------------------------------------------------------------------

function buildBackground() {
  const c = makeCanvas(VIEW_W, VIEW_H);
  if (!c) return null;
  const g = c.getContext('2d');
  // Arena escura
  let grad = g.createLinearGradient(0, 0, 0, VIEW_H);
  grad.addColorStop(0, '#05070f');
  grad.addColorStop(0.55, '#0b1226');
  grad.addColorStop(1, '#070a14');
  g.fillStyle = grad;
  g.fillRect(0, 0, VIEW_W, VIEW_H);

  // Arquibancada ao fundo (silhuetas suaves)
  g.fillStyle = 'rgba(30,40,70,0.35)';
  for (let row = 0; row < 4; row++) {
    const y = 560 + row * 34;
    for (let i = 0; i < 46; i++) {
      const x = 20 + i * 42 + ((row % 2) * 21);
      const h = 18 + ((i * 7 + row * 13) % 9);
      g.beginPath();
      g.arc(x, y - h, 11, 0, Math.PI * 2);
      g.fill();
      g.fillRect(x - 14, y - h + 6, 28, 26);
    }
  }
  // Placas de publicidade (barreira)
  grad = g.createLinearGradient(0, 700, 0, 770);
  grad.addColorStop(0, '#141c38');
  grad.addColorStop(1, '#0c1226');
  g.fillStyle = grad;
  g.fillRect(0, 700, VIEW_W, 70);
  g.fillStyle = 'rgba(255,255,255,0.05)';
  g.fillRect(0, 700, VIEW_W, 3);
  g.font = font(34, '800');
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  const boards = ['PING PONG TV', 'TÊNIS DE MESA', 'PING PONG TV', 'TÊNIS DE MESA'];
  for (let i = 0; i < boards.length; i++) {
    g.fillStyle = i % 2 === 0 ? 'rgba(255,154,31,0.22)' : 'rgba(61,139,255,0.22)';
    g.fillText(boards[i], 240 + i * 480, 736);
  }

  // Piso
  grad = g.createLinearGradient(0, 770, 0, VIEW_H);
  grad.addColorStop(0, '#3a1f1a');
  grad.addColorStop(1, '#1a0d0b');
  g.fillStyle = grad;
  g.fillRect(0, 770, VIEW_W, VIEW_H - 770);
  // linhas do piso
  g.strokeStyle = 'rgba(255,255,255,0.04)';
  g.lineWidth = 2;
  for (let i = -12; i <= 12; i++) {
    g.beginPath();
    g.moveTo(960 + i * 60, 770);
    g.lineTo(960 + i * 200, VIEW_H);
    g.stroke();
  }

  // Holofotes: cones de luz vindos de cima
  const lights = [600, 960, 1320];
  for (let i = 0; i < lights.length; i++) {
    const lx = lights[i];
    grad = g.createLinearGradient(0, 0, 0, 940);
    grad.addColorStop(0, 'rgba(190,215,255,0.16)');
    grad.addColorStop(1, 'rgba(190,215,255,0)');
    g.fillStyle = grad;
    g.beginPath();
    g.moveTo(lx - 30, 0);
    g.lineTo(lx + 30, 0);
    g.lineTo(lx + 420, 940);
    g.lineTo(lx - 420, 940);
    g.closePath();
    g.fill();
    g.fillStyle = 'rgba(230,240,255,0.9)';
    g.beginPath();
    g.ellipse(lx, 6, 46, 10, 0, 0, Math.PI * 2);
    g.fill();
  }
  // Poça de luz no chão
  grad = g.createRadialGradient(960, FLOOR_SCREEN_Y, 40, 960, FLOOR_SCREEN_Y, 900);
  grad.addColorStop(0, 'rgba(255,240,215,0.30)');
  grad.addColorStop(0.5, 'rgba(255,240,215,0.10)');
  grad.addColorStop(1, 'rgba(255,240,215,0)');
  g.fillStyle = grad;
  g.save();
  g.translate(960, FLOOR_SCREEN_Y);
  g.scale(1, 0.22);
  g.translate(-960, -FLOOR_SCREEN_Y);
  g.beginPath();
  g.arc(960, FLOOR_SCREEN_Y, 900, 0, Math.PI * 2);
  g.fill();
  g.restore();

  // Vinheta
  grad = g.createRadialGradient(960, 540, 300, 960, 540, 1150);
  grad.addColorStop(0, 'rgba(0,0,0,0)');
  grad.addColorStop(1, 'rgba(0,0,0,0.65)');
  g.fillStyle = grad;
  g.fillRect(0, 0, VIEW_W, VIEW_H);
  return c;
}

// ---------------------------------------------------------------------------
// Renderer
// ---------------------------------------------------------------------------

export function createRenderer(canvas, opts) {
  const o = opts || {};
  const ctx = canvas.getContext('2d');
  const bg = buildBackground();
  const rand = o.rng || Math.random;

  const view = { scale: 1, offX: 0, offY: 0, w: VIEW_W, h: VIEW_H };
  const cam = { s: 380, cx: 960, surfY: FLOOR_SCREEN_Y + FLOOR_Y * 380, shakeX: 0, shakeY: 0 };

  // Rastro da bola (buffer circular)
  const trailX = new Float32Array(TRAIL_LEN);
  const trailY = new Float32Array(TRAIL_LEN);
  let trailHead = 0;
  let trailCount = 0;

  // Partículas (pool fixo)
  const pX = new Float32Array(MAX_PARTICLES);
  const pY = new Float32Array(MAX_PARTICLES);
  const pVX = new Float32Array(MAX_PARTICLES);
  const pVY = new Float32Array(MAX_PARTICLES);
  const pLife = new Float32Array(MAX_PARTICLES);
  const pMax = new Float32Array(MAX_PARTICLES);
  const pSize = new Float32Array(MAX_PARTICLES);
  const pColor = new Array(MAX_PARTICLES);
  let pNext = 0;
  // Anéis/flash (em coordenadas de mundo)
  const rX = new Float32Array(MAX_RINGS);
  const rY = new Float32Array(MAX_RINGS);
  const rLife = new Float32Array(MAX_RINGS);
  const rMax = new Float32Array(MAX_RINGS);
  const rSize = new Float32Array(MAX_RINGS);
  const rColor = new Array(MAX_RINGS);
  const rFlat = new Uint8Array(MAX_RINGS);
  let rNext = 0;

  const swing = [0, 0];      // animação de swing por jogador (s restantes)
  const swingDir = [1, 1];
  let flash = 0;             // flash de tela (smash)
  let lastTime = -1;
  let titleT = 0;

  function resize(cssW, cssH, dpr) {
    const ratio = Math.min(dpr || 1, 1.5);
    canvas.width = Math.max(1, Math.round(cssW * ratio));
    canvas.height = Math.max(1, Math.round(cssH * ratio));
    const s = Math.min(canvas.width / VIEW_W, canvas.height / VIEW_H);
    view.scale = s;
    view.offX = (canvas.width - VIEW_W * s) / 2;
    view.offY = (canvas.height - VIEW_H * s) / 2;
  }

  function sx(x) { return cam.cx + x * cam.s + cam.shakeX; }
  function sy(y) { return cam.surfY - y * cam.s + cam.shakeY; }

  function spawnParticle(x, y, vx, vy, life, size, color) {
    const i = pNext;
    pNext = (pNext + 1) % MAX_PARTICLES;
    pX[i] = x; pY[i] = y; pVX[i] = vx; pVY[i] = vy;
    pLife[i] = life; pMax[i] = life; pSize[i] = size; pColor[i] = color;
  }

  function spawnRing(x, y, size, life, color, flat) {
    const i = rNext;
    rNext = (rNext + 1) % MAX_RINGS;
    rX[i] = x; rY[i] = y; rSize[i] = size; rLife[i] = life; rMax[i] = life;
    rColor[i] = color; rFlat[i] = flat ? 1 : 0;
  }

  function consumeEffects(game) {
    const list = game.effects;
    for (let i = 0; i < list.length; i++) {
      const fx = list[i];
      const x = sx(fx.x);
      const y = sy(fx.y);
      if (fx.type === 'hit') {
        const power = fx.power || 0.4;
        const color = fx.player === 0 ? COLORS.p1 : COLORS.p2;
        const n = 8 + Math.round(power * 18);
        for (let k = 0; k < n; k++) {
          const a = rand() * Math.PI * 2;
          const sp = 120 + rand() * 520 * (0.5 + power);
          spawnParticle(x, y, Math.cos(a) * sp, Math.sin(a) * sp, 0.25 + rand() * 0.35,
            2 + rand() * 4, k % 3 === 0 ? '#ffffff' : (k % 3 === 1 ? COLORS.gold : color));
        }
        spawnRing(fx.x, fx.y, 30 + power * 70, 0.3, color, false);
        if (fx.player === 0 || fx.player === 1) {
          swing[fx.player] = 0.22;
          swingDir[fx.player] = fx.shot === 'chop' ? -1 : 1;
        }
        if (fx.shot === 'smash') flash = Math.max(flash, 0.5);
      } else if (fx.type === 'bounce') {
        spawnRing(fx.x, 0, 26, 0.35, 'rgba(255,255,255,0.9)', true);
        for (let k = 0; k < 5; k++) {
          spawnParticle(x, y, (rand() - 0.5) * 240, -80 - rand() * 160, 0.25, 2 + rand() * 2,
            'rgba(255,255,255,0.9)');
        }
      } else if (fx.type === 'net') {
        for (let k = 0; k < 10; k++) {
          spawnParticle(x, y, (rand() - 0.5) * 300, (rand() - 0.8) * 300, 0.35, 2.5,
            k % 2 ? '#ffffff' : '#bcd6ff');
        }
        spawnRing(0, fx.y, 40, 0.3, 'rgba(255,255,255,0.8)', false);
      } else if (fx.type === 'floor') {
        spawnRing(fx.x, FLOOR_Y, 34, 0.4, 'rgba(255,255,255,0.5)', true);
      }
    }
    list.length = 0;
  }

  function updateCamera(game, dt) {
    let far = 2.0;
    if (game.screen !== 'title') {
      for (let p = 0; p < 2; p++) {
        const ax = Math.abs(game.paddles[p].x) + 0.2;
        if (ax > far) far = ax;
      }
      const bx = Math.abs(game.ball.x) + 0.1;
      if (game.phase === 'rally' && bx > far && bx < 3.2) far = bx;
    }
    const target = clamp((VIEW_W / 2 - 60) / far, 300, 430);
    const k = clamp(dt * 2.5, 0, 1);
    cam.s += (target - cam.s) * k;
    cam.surfY = FLOOR_SCREEN_Y + FLOOR_Y * cam.s; // chão fica fixo na tela
    const sh = game.shake || 0;
    if (sh > 0.01) {
      cam.shakeX = (rand() - 0.5) * 22 * sh;
      cam.shakeY = (rand() - 0.5) * 16 * sh;
    } else {
      cam.shakeX = 0;
      cam.shakeY = 0;
    }
  }

  // -------------------------------------------------------------------------
  // Mesa
  // -------------------------------------------------------------------------

  function drawTable() {
    const s = cam.s;
    const depth = s * 0.13;            // espessura visual do tampo em perspectiva
    const inset = s * 0.09;            // borda do fundo mais estreita
    const xl = sx(-TABLE_HALF);
    const xr = sx(TABLE_HALF);
    const surf = sy(0);
    const nearY = surf + depth / 2;
    const farY = surf - depth / 2;
    const thick = Math.max(10, s * 0.035);
    const floorY = sy(FLOOR_Y);

    // sombra no chão
    ctx.fillStyle = 'rgba(0,0,0,0.45)';
    ctx.beginPath();
    ctx.ellipse((xl + xr) / 2, floorY + 4, (xr - xl) * 0.56, 22, 0, 0, Math.PI * 2);
    ctx.fill();

    // pernas (fundo, mais escuras)
    ctx.fillStyle = '#1a1d26';
    const legW = Math.max(8, s * 0.03);
    const legsX = [-1.05, 1.05];
    for (let i = 0; i < 2; i++) {
      const lx = sx(legsX[i] * 0.94);
      ctx.fillRect(lx - legW / 2, farY, legW * 0.8, floorY - 14 - farY);
    }
    // estrutura central
    ctx.fillStyle = '#20232d';
    ctx.fillRect(sx(-1.1), nearY + thick, sx(1.1) - sx(-1.1), Math.max(6, s * 0.02));
    // pernas da frente
    ctx.fillStyle = '#2b2f3b';
    for (let i = 0; i < 2; i++) {
      const lx = sx(legsX[i]);
      ctx.fillRect(lx - legW / 2, nearY + thick, legW, floorY - (nearY + thick));
      ctx.fillStyle = '#111';
      ctx.fillRect(lx - legW / 2 - 3, floorY - 6, legW + 6, 8);
      ctx.fillStyle = '#2b2f3b';
    }

    // face frontal do tampo
    let grad = ctx.createLinearGradient(0, nearY, 0, nearY + thick);
    grad.addColorStop(0, '#16447f');
    grad.addColorStop(1, COLORS.tableFace);
    ctx.fillStyle = grad;
    ctx.fillRect(xl, nearY, xr - xl, thick);

    // tampo (trapézio)
    grad = ctx.createLinearGradient(0, farY, 0, nearY);
    grad.addColorStop(0, COLORS.tableTopFar);
    grad.addColorStop(1, COLORS.tableTop);
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.moveTo(xl + inset, farY);
    ctx.lineTo(xr - inset, farY);
    ctx.lineTo(xr, nearY);
    ctx.lineTo(xl, nearY);
    ctx.closePath();
    ctx.fill();
    // brilho do holofote no tampo
    grad = ctx.createRadialGradient(sx(0), surf, 10, sx(0), surf, (xr - xl) * 0.55);
    grad.addColorStop(0, 'rgba(255,255,255,0.20)');
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = grad;
    ctx.fill();

    // linhas brancas: bordas e linha central
    ctx.strokeStyle = COLORS.line;
    ctx.lineWidth = Math.max(2.5, s * 0.008);
    ctx.lineJoin = 'round';
    ctx.stroke();
    ctx.lineWidth = Math.max(1.5, s * 0.005);
    ctx.beginPath();
    ctx.moveTo(xl + inset / 2, surf);
    ctx.lineTo(xr - inset / 2, surf);
    ctx.stroke();
    // aresta frontal iluminada
    ctx.strokeStyle = 'rgba(255,255,255,0.55)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(xl, nearY + 1);
    ctx.lineTo(xr, nearY + 1);
    ctx.stroke();

    return { nearY: nearY, farY: farY, inset: inset };
  }

  function drawNet(geom) {
    const s = cam.s;
    const x = sx(0);
    const h = NET_H * s;
    const skew = s * 0.025;
    const nearY = geom.nearY + 4;
    const farY = geom.farY - 4;
    // malha
    ctx.fillStyle = 'rgba(230,240,255,0.16)';
    ctx.beginPath();
    ctx.moveTo(x, nearY);
    ctx.lineTo(x, nearY - h);
    ctx.lineTo(x + skew, farY - h);
    ctx.lineTo(x + skew, farY);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = 'rgba(230,240,255,0.30)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let i = 1; i < 6; i++) {
      const t = i / 6;
      ctx.moveTo(x, nearY - h * t);
      ctx.lineTo(x + skew, farY - h * t);
    }
    ctx.stroke();
    // fita branca superior
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = Math.max(3, s * 0.009);
    ctx.beginPath();
    ctx.moveTo(x, nearY - h);
    ctx.lineTo(x + skew, farY - h);
    ctx.stroke();
    // postes
    const pw = Math.max(5, s * 0.014);
    ctx.fillStyle = '#c9ced8';
    ctx.fillRect(x + skew - pw / 2, farY - h - 3, pw * 0.8, h + 6);
    ctx.fillStyle = '#e8ebf1';
    ctx.fillRect(x - pw / 2, nearY - h - 4, pw, h + 10);
    ctx.fillStyle = '#5a606c';
    ctx.fillRect(x - pw, nearY + 2, pw * 2, 7);
  }

  // -------------------------------------------------------------------------
  // Bola, sombra, rastro
  // -------------------------------------------------------------------------

  function pushTrail(game) {
    const b = game.ball;
    const moving = game.phase === 'rally' || game.phase === 'pointOver';
    if (!moving || b.dead) {
      if (trailCount > 0) trailCount--;
      return;
    }
    trailX[trailHead] = sx(b.x);
    trailY[trailHead] = sy(b.y);
    trailHead = (trailHead + 1) % TRAIL_LEN;
    if (trailCount < TRAIL_LEN) trailCount++;
  }

  function ballRadius() {
    return Math.max(9, BALL_R * cam.s * 1.35);
  }

  function drawBallShadow(game) {
    const b = game.ball;
    const r = ballRadius();
    let groundY;
    let h;
    if (Math.abs(b.x) <= TABLE_HALF && b.y >= -0.01) {
      groundY = 0;
      h = b.y;
    } else {
      groundY = FLOOR_Y;
      h = b.y - FLOOR_Y;
    }
    const k = clamp(1 - h / 1.4, 0.15, 1);
    ctx.fillStyle = 'rgba(0,0,0,' + (0.5 * k).toFixed(3) + ')';
    ctx.beginPath();
    ctx.ellipse(sx(b.x), sy(groundY) + 2, r * (1.6 - 0.6 * k) + 2, r * 0.45, 0, 0, Math.PI * 2);
    ctx.fill();
  }

  function drawBall(game) {
    const b = game.ball;
    const r = ballRadius();
    // rastro
    if (trailCount > 1) {
      for (let i = 0; i < trailCount; i++) {
        const idx = (trailHead - 1 - i + TRAIL_LEN * 2) % TRAIL_LEN;
        const t = 1 - i / trailCount;
        ctx.globalAlpha = 0.42 * t * t;
        ctx.fillStyle = i < 3 ? '#fff3dc' : COLORS.ball;
        ctx.beginPath();
        ctx.arc(trailX[idx], trailY[idx], r * (0.35 + 0.6 * t), 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
    }
    const x = sx(b.x);
    const y = sy(b.y);
    // brilho
    ctx.fillStyle = 'rgba(255,170,60,0.22)';
    ctx.beginPath();
    ctx.arc(x, y, r * 2, 0, Math.PI * 2);
    ctx.fill();
    const grad = ctx.createRadialGradient(x - r * 0.35, y - r * 0.4, r * 0.1, x, y, r);
    grad.addColorStop(0, '#ffffff');
    grad.addColorStop(0.35, '#ffd29a');
    grad.addColorStop(1, COLORS.ball);
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
    // marca girando (spin visível)
    const ang = game.time * clamp((b.spin || 0) * 0.15, -30, 30);
    ctx.strokeStyle = 'rgba(180,80,0,0.55)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(x, y, r * 0.62, ang, ang + 1.4);
    ctx.stroke();
  }

  // -------------------------------------------------------------------------
  // Raquetes
  // -------------------------------------------------------------------------

  function drawPaddle(game, p, dt) {
    const pad = game.paddles[p];
    const side = game.sides[p];
    const x = sx(pad.x);
    const y = sy(pad.y);
    const R = Math.max(26, PADDLE_R * cam.s * 1.15);
    if (swing[p] > 0) swing[p] = Math.max(0, swing[p] - dt);
    const sw = swing[p] > 0 ? Math.sin((swing[p] / 0.22) * Math.PI) * 0.7 * swingDir[p] : 0;
    // inclinação: face voltada para a rede, cabo para baixo/para fora
    const tilt = side * (0.32 + clamp(pad.vy * 0.06, -0.25, 0.25)) - side * sw;

    // sombra da raquete
    ctx.fillStyle = 'rgba(0,0,0,0.25)';
    ctx.beginPath();
    const gy = Math.abs(pad.x) <= TABLE_HALF && pad.y > 0 ? sy(0) : sy(FLOOR_Y);
    ctx.ellipse(x, gy + 3, R * 0.9, R * 0.18, 0, 0, Math.PI * 2);
    ctx.fill();

    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(tilt);
    // cabo
    ctx.fillStyle = '#c99a5b';
    roundRectPath(ctx, -R * 0.16, R * 0.75, R * 0.32, R * 1.0, R * 0.1);
    ctx.fill();
    ctx.fillStyle = 'rgba(70,40,15,0.55)';
    ctx.fillRect(-R * 0.16, R * 1.15, R * 0.32, R * 0.12);
    ctx.fillRect(-R * 0.16, R * 1.4, R * 0.32, R * 0.12);
    // madeira (borda)
    ctx.fillStyle = '#d9b07a';
    ctx.beginPath();
    ctx.ellipse(0, 0, R * 0.62, R, 0, 0, Math.PI * 2);
    ctx.fill();
    // borracha
    const grad = ctx.createLinearGradient(-R * 0.5, -R, R * 0.5, R);
    if (p === 0) {
      grad.addColorStop(0, '#ff6a5c');
      grad.addColorStop(1, '#b3141a');
    } else {
      grad.addColorStop(0, '#3a3f4c');
      grad.addColorStop(1, '#0b0d12');
    }
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.ellipse(-side * R * 0.06, 0, R * 0.52, R * 0.9, 0, 0, Math.PI * 2);
    ctx.fill();
    if (p === 1) {
      ctx.strokeStyle = COLORS.p2;
      ctx.lineWidth = 3;
      ctx.stroke();
    }
    // reflexo
    ctx.fillStyle = 'rgba(255,255,255,0.16)';
    ctx.beginPath();
    ctx.ellipse(-side * R * 0.15, -R * 0.35, R * 0.18, R * 0.35, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    // marcador do jogador acima da raquete
    ctx.fillStyle = PLAYER_COLOR[p];
    ctx.beginPath();
    ctx.moveTo(x, y - R - 14);
    ctx.lineTo(x - 11, y - R - 32);
    ctx.lineTo(x + 11, y - R - 32);
    ctx.closePath();
    ctx.fill();
    ctx.font = font(26, '800');
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    ctx.fillStyle = COLORS.text;
    ctx.fillText(game.ais[p] ? 'CPU' : ('J' + (p + 1)), x, y - R - 36);
  }

  // -------------------------------------------------------------------------
  // Partículas
  // -------------------------------------------------------------------------

  function drawParticles(dt) {
    for (let i = 0; i < MAX_PARTICLES; i++) {
      if (pLife[i] <= 0) continue;
      pLife[i] -= dt;
      if (pLife[i] <= 0) continue;
      pVY[i] += 900 * dt;
      pX[i] += pVX[i] * dt;
      pY[i] += pVY[i] * dt;
      const t = pLife[i] / pMax[i];
      ctx.globalAlpha = t;
      ctx.fillStyle = pColor[i];
      ctx.fillRect(pX[i] - pSize[i] / 2, pY[i] - pSize[i] / 2, pSize[i], pSize[i]);
    }
    ctx.globalAlpha = 1;
    for (let i = 0; i < MAX_RINGS; i++) {
      if (rLife[i] <= 0) continue;
      rLife[i] -= dt;
      if (rLife[i] <= 0) continue;
      const t = 1 - rLife[i] / rMax[i];
      const rad = rSize[i] * (0.3 + t);
      ctx.globalAlpha = 1 - t;
      ctx.strokeStyle = rColor[i];
      ctx.lineWidth = 4 * (1 - t) + 1;
      ctx.beginPath();
      if (rFlat[i]) ctx.ellipse(sx(rX[i]), sy(rY[i]), rad, rad * 0.25, 0, 0, Math.PI * 2);
      else ctx.arc(sx(rX[i]), sy(rY[i]), rad, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  // -------------------------------------------------------------------------
  // HUD
  // -------------------------------------------------------------------------

  function drawServeIcon(x, y, r) {
    ctx.fillStyle = COLORS.ball;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.7)';
    ctx.beginPath();
    ctx.arc(x - r * 0.3, y - r * 0.3, r * 0.35, 0, Math.PI * 2);
    ctx.fill();
  }

  function drawScoreboard(game) {
    const m = game.match;
    if (!m) return;
    const W = 1180;
    const H = 138;
    const x0 = (VIEW_W - W) / 2;
    const y0 = SAFE_Y;
    fillRound(ctx, x0, y0, W, H, 22, COLORS.panel);
    ctx.strokeStyle = 'rgba(255,255,255,0.10)';
    ctx.lineWidth = 2;
    roundRectPath(ctx, x0, y0, W, H, 22);
    ctx.stroke();

    const leftP = game.sides[0] < 0 ? 0 : 1;
    const server = game.phase === 'serve' || game.phase === 'rally' ? game.server : getServer(m);
    const needed = Math.floor(m.bestOf / 2) + 1;
    for (let k = 0; k < 2; k++) {
      const p = k === 0 ? leftP : 1 - leftP;
      const isLeft = k === 0;
      const bx = isLeft ? x0 : x0 + W / 2 + 90;
      const bw = W / 2 - 90;
      // faixa de cor
      ctx.fillStyle = PLAYER_COLOR[p];
      if (isLeft) ctx.fillRect(x0 + 18, y0 + 22, 10, H - 44);
      else ctx.fillRect(x0 + W - 28, y0 + 22, 10, H - 44);
      // nome
      ctx.font = font(42, '700');
      ctx.textBaseline = 'middle';
      ctx.fillStyle = COLORS.text;
      ctx.textAlign = isLeft ? 'left' : 'right';
      const nameX = isLeft ? bx + 50 : bx + bw - 50;
      ctx.fillText(game.names[p], nameX, y0 + 48);
      const nameW = ctx.measureText(game.names[p]).width;
      if (server === p && !m.over) {
        drawServeIcon(isLeft ? nameX + nameW + 26 : nameX - nameW - 26, y0 + 48, 12);
      }
      // games (bolinhas)
      for (let g = 0; g < needed; g++) {
        const gx = isLeft ? nameX + 12 + g * 34 : nameX - 12 - g * 34;
        ctx.beginPath();
        ctx.arc(gx, y0 + 100, 11, 0, Math.PI * 2);
        if (g < m.gamesWon[p]) {
          ctx.fillStyle = COLORS.gold;
          ctx.fill();
        } else {
          ctx.strokeStyle = 'rgba(255,255,255,0.35)';
          ctx.lineWidth = 3;
          ctx.stroke();
        }
      }
      // pontos
      ctx.font = font(96, '800');
      ctx.textAlign = 'center';
      ctx.fillStyle = COLORS.text;
      const ptsX = isLeft ? x0 + W / 2 - 150 : x0 + W / 2 + 150;
      fillRound(ctx, ptsX - 80, y0 + 14, 160, H - 28, 16, PLAYER_DARK[p]);
      ctx.fillStyle = '#ffffff';
      ctx.fillText(String(m.score[p]), ptsX, y0 + H / 2 + 6);
    }
    // centro
    ctx.textAlign = 'center';
    ctx.fillStyle = COLORS.dim;
    ctx.font = font(26, '700');
    ctx.fillText('GAME', VIEW_W / 2, y0 + 40);
    ctx.font = font(52, '800');
    ctx.fillStyle = COLORS.text;
    ctx.fillText(String(m.gameNumber), VIEW_W / 2, y0 + 82);
    ctx.font = font(22, '600');
    ctx.fillStyle = COLORS.dim;
    ctx.fillText('Melhor de ' + m.bestOf, VIEW_W / 2, y0 + 118);

    // status: MATCH POINT / GAME POINT / DEUCE
    if (game.phase === 'serve' || game.phase === 'rally') {
      let label = null;
      let color = COLORS.gold;
      const mp = isMatchPoint(m);
      const gp = isGamePoint(m);
      if (mp !== null) { label = 'MATCH POINT · ' + game.names[mp]; color = '#ff5470'; }
      else if (gp !== null) { label = 'GAME POINT · ' + game.names[gp]; }
      else if (isDeuce(m)) { label = 'DEUCE'; color = '#7fe3ff'; }
      if (label) {
        ctx.font = font(36, '800');
        const tw = ctx.measureText(label).width + 60;
        const pulse = 0.85 + 0.15 * Math.sin(game.time * 6);
        ctx.globalAlpha = pulse;
        fillRound(ctx, (VIEW_W - tw) / 2, y0 + H + 14, tw, 58, 29, color);
        ctx.globalAlpha = 1;
        ctx.fillStyle = '#0b0e18';
        ctx.fillText(label, VIEW_W / 2, y0 + H + 45);
      }
    }
  }

  function drawBanner(title, subtitle, color, t) {
    const appear = clamp(t / 0.18, 0, 1);
    const yy = 372 - (1 - appear) * 30;
    ctx.globalAlpha = appear;
    ctx.font = font(76, '800');
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const w1 = ctx.measureText(title).width;
    ctx.font = font(44, '600');
    const w2 = subtitle ? ctx.measureText(subtitle).width : 0;
    const W = Math.max(w1, w2) + 120;
    const H = subtitle ? 190 : 120;
    fillRound(ctx, (VIEW_W - W) / 2, yy - H / 2, W, H, 26, COLORS.panel);
    ctx.fillStyle = color;
    ctx.fillRect((VIEW_W - W) / 2 + 26, yy - H / 2, W - 52, 6);
    ctx.font = font(76, '800');
    ctx.fillStyle = color;
    ctx.fillText(title, VIEW_W / 2, subtitle ? yy - 34 : yy);
    if (subtitle) {
      ctx.font = font(44, '600');
      ctx.fillStyle = COLORS.text;
      ctx.fillText(subtitle, VIEW_W / 2, yy + 48);
    }
    ctx.globalAlpha = 1;
  }

  function drawPointBanner(game) {
    const lp = game.lastPoint;
    if (!lp) return;
    if (lp.isLet) {
      drawBanner('LET', 'Repetir saque', '#7fe3ff', game.phaseTime);
    } else {
      drawBanner('Ponto: ' + game.names[lp.winner], lp.text, PLAYER_COLOR[lp.winner], game.phaseTime);
    }
  }

  function drawGameOverPanel(game) {
    const lg = game.lastGame;
    if (!lg) return;
    const m = game.match;
    const t = clamp(game.phaseTime / 0.25, 0, 1);
    ctx.globalAlpha = t;
    const W = 980;
    const H = 360;
    const x0 = (VIEW_W - W) / 2;
    const y0 = 300;
    fillRound(ctx, x0, y0, W, H, 30, 'rgba(8,12,24,0.9)');
    ctx.fillStyle = PLAYER_COLOR[lg.winner];
    ctx.fillRect(x0 + 30, y0, W - 60, 8);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = font(40, '700');
    ctx.fillStyle = COLORS.dim;
    ctx.fillText('Fim do Game ' + lg.number, VIEW_W / 2, y0 + 62);
    ctx.font = font(72, '800');
    ctx.fillStyle = PLAYER_COLOR[lg.winner];
    ctx.fillText(game.names[lg.winner] + ' vence', VIEW_W / 2, y0 + 146);
    ctx.font = font(92, '800');
    ctx.fillStyle = COLORS.text;
    ctx.fillText(lg.score[0] + '  –  ' + lg.score[1], VIEW_W / 2, y0 + 240);
    ctx.font = font(34, '600');
    ctx.fillStyle = COLORS.dim;
    let info = 'Games: ' + game.names[0] + ' ' + m.gamesWon[0] + ' × ' + m.gamesWon[1] + ' ' + game.names[1];
    if (!m.over && lg.swapEnds) info += '  ·  Troca de lados';
    ctx.fillText(info, VIEW_W / 2, y0 + 318);
    ctx.globalAlpha = 1;
  }

  function drawServeHint(game) {
    if (game.phase !== 'serve') return;
    const p = game.server;
    if (game.ais[p]) return;
    const a = clamp((game.phaseTime - 0.4) / 0.4, 0, 1);
    if (a <= 0) return;
    ctx.globalAlpha = a * (0.75 + 0.25 * Math.sin(game.time * 4));
    const text = game.names[p] + ': aperte um golpe para sacar';
    ctx.font = font(38, '700');
    const tw = ctx.measureText(text).width + 140;
    const y = VIEW_H - SAFE_Y - 150;
    fillRound(ctx, (VIEW_W - tw) / 2, y - 34, tw, 68, 34, COLORS.panel);
    drawButtonGlyph((VIEW_W - tw) / 2 + 50, y, 'A', '#3cc34a', 24);
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = COLORS.text;
    ctx.fillText(text, (VIEW_W - tw) / 2 + 90, y + 2);
    ctx.globalAlpha = 1;
  }

  function drawSwapNotice(game) {
    if (!(game.swapNotice > 0)) return;
    ctx.globalAlpha = clamp(game.swapNotice / 0.5, 0, 1);
    ctx.font = font(46, '800');
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const text = 'Troca de lados';
    const tw = ctx.measureText(text).width + 80;
    fillRound(ctx, (VIEW_W - tw) / 2, 290, tw, 80, 40, 'rgba(255,210,90,0.92)');
    ctx.fillStyle = '#121212';
    ctx.fillText(text, VIEW_W / 2, 332);
    ctx.globalAlpha = 1;
  }

  function drawControllerIcon(x, y, w, color) {
    const h = w * 0.62;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(x - w * 0.5, y - h * 0.15);
    ctx.quadraticCurveTo(x - w * 0.5, y - h * 0.5, x - w * 0.25, y - h * 0.5);
    ctx.lineTo(x + w * 0.25, y - h * 0.5);
    ctx.quadraticCurveTo(x + w * 0.5, y - h * 0.5, x + w * 0.5, y - h * 0.15);
    ctx.lineTo(x + w * 0.42, y + h * 0.45);
    ctx.quadraticCurveTo(x + w * 0.3, y + h * 0.6, x + w * 0.18, y + h * 0.2);
    ctx.lineTo(x - w * 0.18, y + h * 0.2);
    ctx.quadraticCurveTo(x - w * 0.3, y + h * 0.6, x - w * 0.42, y + h * 0.45);
    ctx.closePath();
    ctx.fill();
  }

  function drawControllerStatus(game, info) {
    const players = info && info.players;
    for (let p = 0; p < 2; p++) {
      const isAI = !!game.ais[p];
      const pi = players && players[p];
      let label;
      let ok;
      if (isAI) {
        label = 'CPU · ' + (DIFFICULTY_TEXT[game.difficulty] || game.difficulty);
        ok = true;
      } else if (pi && pi.connected && pi.source === 'gamepad') {
        label = 'Controle conectado'; ok = true;
      } else if (pi && pi.connected && pi.source === 'keyboard') {
        label = 'Teclado'; ok = true;
      } else {
        label = 'Conecte um controle'; ok = false;
      }
      const left = p === 0;
      const y = VIEW_H - SAFE_Y - 30;
      ctx.font = font(28, '700');
      const text = game.names[p] + ' — ' + label;
      const tw = ctx.measureText(text).width + 110;
      const x0 = left ? SAFE_X : VIEW_W - SAFE_X - tw;
      fillRound(ctx, x0, y - 30, tw, 60, 30, 'rgba(8,12,24,0.7)');
      drawControllerIcon(x0 + 44, y, 46, ok ? PLAYER_COLOR[p] : '#5b6172');
      ctx.fillStyle = ok ? COLORS.text : '#ffb4b4';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(text, x0 + 84, y + 1);
    }
  }

  function drawButtonGlyph(x, y, letter, color, r) {
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#ffffff';
    ctx.font = font(Math.round(r * 1.1), '800');
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(letter, x, y + 1);
  }

  function drawMenuList(items, cx, y0, w, rowH, time) {
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      const y = y0 + i * rowH;
      if (it.focused) {
        const pulse = 0.85 + 0.15 * Math.sin(time * 5);
        ctx.globalAlpha = pulse;
        fillRound(ctx, cx - w / 2, y, w, rowH - 12, (rowH - 12) / 2, COLORS.ball);
        ctx.globalAlpha = 1;
      } else {
        fillRound(ctx, cx - w / 2, y, w, rowH - 12, (rowH - 12) / 2, 'rgba(255,255,255,0.07)');
      }
      const textColor = it.focused ? '#141018' : (it.disabled ? 'rgba(244,246,251,0.35)' : COLORS.text);
      ctx.fillStyle = textColor;
      ctx.textBaseline = 'middle';
      ctx.font = font(42, it.focused ? '800' : '700');
      const cy = y + (rowH - 12) / 2 + 2;
      if (it.value !== null && it.value !== undefined) {
        ctx.textAlign = 'left';
        ctx.fillText(it.label, cx - w / 2 + 48, cy);
        ctx.textAlign = 'right';
        const val = (it.adjustable ? '◀  ' : '') + it.value + (it.adjustable ? '  ▶' : '');
        ctx.fillText(val, cx + w / 2 - 44, cy);
      } else {
        ctx.textAlign = 'center';
        ctx.fillText(it.label, cx, cy);
        if (it.selected) {
          ctx.textAlign = 'left';
          ctx.fillText('●', cx - w / 2 + 44, cy);
        }
      }
    }
  }

  function drawTitleBall(t) {
    // bola animada quicando sobre a mesa no título
    const period = 1.8;
    const ph = (t % (period * 2)) / period;      // 0..2
    const dir = ph < 1 ? 1 : -1;
    const u = ph < 1 ? ph : ph - 1;
    const x = dir * (-1.2 + 2.4 * u);
    const bounceU = (u * 2) % 1;
    const y = 0.02 + 0.32 * 4 * bounceU * (1 - bounceU);
    const px = sx(x);
    const py = sy(y);
    const r = ballRadius();
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    ctx.beginPath();
    ctx.ellipse(px, sy(0) + 2, r * 1.3, r * 0.4, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = COLORS.ball;
    ctx.beginPath();
    ctx.arc(px, py, r, 0, Math.PI * 2);
    ctx.fill();
  }

  function drawTitle(game) {
    ctx.fillStyle = 'rgba(4,6,14,0.55)';
    ctx.fillRect(0, 0, VIEW_W, VIEW_H);
    // título
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = font(150, '900');
    const wob = Math.sin(titleT * 1.6) * 4;
    ctx.fillStyle = 'rgba(0,0,0,0.45)';
    ctx.fillText('PING PONG', VIEW_W / 2 + 6, 190 + 8 + wob);
    const grad = ctx.createLinearGradient(0, 120, 0, 260);
    grad.addColorStop(0, '#ffffff');
    grad.addColorStop(1, '#ffc36b');
    ctx.fillStyle = grad;
    ctx.fillText('PING PONG', VIEW_W / 2, 190 + wob);
    const titleW = ctx.measureText('PING PONG').width;
    const badgeX = VIEW_W / 2 + titleW / 2 + 24;
    fillRound(ctx, badgeX, 112 + wob, 120, 70, 16, COLORS.p1);
    ctx.font = font(52, '900');
    ctx.fillStyle = '#fff';
    ctx.fillText('TV', badgeX + 60, 149 + wob);
    ctx.font = font(36, '600');
    ctx.fillStyle = COLORS.dim;
    ctx.fillText('Tênis de mesa no sofá · 1 ou 2 jogadores', VIEW_W / 2, 290);

    if (game.menu.view === 'howto') {
      drawHowTo(game);
      return;
    }
    const items = getMenuItems(game);
    fillRound(ctx, VIEW_W / 2 - 440, 340, 880, items.length * 84 + 50, 30, 'rgba(8,12,24,0.78)');
    drawMenuList(items, VIEW_W / 2, 366, 800, 84, game.time);

    // dicas de navegação
    const y = VIEW_H - SAFE_Y - 34;
    ctx.font = font(30, '600');
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    let x = VIEW_W / 2 - 430;
    ctx.fillStyle = COLORS.dim;
    ctx.fillText('LS / D-pad: navegar', x, y);
    x += 330;
    drawButtonGlyph(x, y, 'A', '#3cc34a', 22);
    ctx.textAlign = 'left';
    ctx.font = font(30, '600');
    ctx.fillStyle = COLORS.dim;
    ctx.fillText('confirmar', x + 34, y);
    x += 220;
    drawButtonGlyph(x, y, 'B', '#e2412f', 22);
    ctx.textAlign = 'left';
    ctx.font = font(30, '600');
    ctx.fillStyle = COLORS.dim;
    ctx.fillText('voltar  ·  ◀ ▶ ajustar', x + 34, y);
  }

  function drawXboxController(cx, cy, scale) {
    const w = 460 * scale;
    const h = 300 * scale;
    ctx.fillStyle = '#e9ecf2';
    ctx.beginPath();
    ctx.moveTo(cx - w * 0.36, cy - h * 0.42);
    ctx.quadraticCurveTo(cx, cy - h * 0.52, cx + w * 0.36, cy - h * 0.42);
    ctx.quadraticCurveTo(cx + w * 0.5, cy - h * 0.38, cx + w * 0.52, cy + h * 0.05);
    ctx.quadraticCurveTo(cx + w * 0.56, cy + h * 0.55, cx + w * 0.4, cy + h * 0.5);
    ctx.quadraticCurveTo(cx + w * 0.3, cy + h * 0.45, cx + w * 0.2, cy + h * 0.15);
    ctx.lineTo(cx - w * 0.2, cy + h * 0.15);
    ctx.quadraticCurveTo(cx - w * 0.3, cy + h * 0.45, cx - w * 0.4, cy + h * 0.5);
    ctx.quadraticCurveTo(cx - w * 0.56, cy + h * 0.55, cx - w * 0.52, cy + h * 0.05);
    ctx.quadraticCurveTo(cx - w * 0.5, cy - h * 0.38, cx - w * 0.36, cy - h * 0.42);
    ctx.closePath();
    ctx.fill();
    // gatilho RT
    ctx.fillStyle = '#9aa1ad';
    fillRound(ctx, cx + w * 0.2, cy - h * 0.62, w * 0.2, h * 0.16, 10 * scale, '#9aa1ad');
    // sticks
    const sticks = [[-0.3, -0.12], [0.14, 0.08]];
    for (let i = 0; i < 2; i++) {
      const x = cx + sticks[i][0] * w;
      const y = cy + sticks[i][1] * h;
      ctx.fillStyle = '#2a2e38';
      ctx.beginPath();
      ctx.arc(x, y, 34 * scale, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#454b58';
      ctx.beginPath();
      ctx.arc(x, y, 22 * scale, 0, Math.PI * 2);
      ctx.fill();
    }
    // D-pad
    const dx = cx - 0.14 * w;
    const dy = cy + 0.08 * h;
    ctx.fillStyle = '#2a2e38';
    ctx.fillRect(dx - 10 * scale, dy - 30 * scale, 20 * scale, 60 * scale);
    ctx.fillRect(dx - 30 * scale, dy - 10 * scale, 60 * scale, 20 * scale);
    // ABXY
    const bx = cx + 0.3 * w;
    const by = cy - 0.12 * h;
    const off = 30 * scale;
    drawButtonGlyph(bx, by + off, 'A', '#3cc34a', 18 * scale);
    drawButtonGlyph(bx + off, by, 'B', '#e2412f', 18 * scale);
    drawButtonGlyph(bx - off, by, 'X', '#2f7de2', 18 * scale);
    drawButtonGlyph(bx, by - off, 'Y', '#e8b923', 18 * scale);
    // MENU
    ctx.fillStyle = '#2a2e38';
    ctx.beginPath();
    ctx.arc(cx + 0.07 * w, cy - 0.18 * h, 10 * scale, 0, Math.PI * 2);
    ctx.fill();
    return {
      ls: [cx - 0.3 * w, cy - 0.12 * h], rs: [cx + 0.14 * w, cy + 0.08 * h],
      a: [bx, by + off], b: [bx + off, by], x: [bx - off, by], rt: [cx + 0.3 * w, cy - h * 0.58],
      menu: [cx + 0.07 * w, cy - 0.18 * h], dpad: [dx, dy]
    };
  }

  function drawHowTo(game) {
    const x0 = SAFE_X + 40;
    const y0 = 330;
    const W = VIEW_W - 2 * (SAFE_X + 40);
    const H = 640;
    fillRound(ctx, x0, y0, W, H, 30, 'rgba(8,12,24,0.88)');
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.font = font(52, '800');
    ctx.fillStyle = COLORS.gold;
    ctx.fillText('Como jogar', x0 + 50, y0 + 56);

    drawXboxController(x0 + 330, y0 + 300, 0.95);

    const rows = [
      ['LS / D-pad', 'Mover a raquete'],
      ['RS', 'Mirar profundidade (curta / funda)'],
      ['A', 'Drive (golpe reto)'],
      ['X', 'Topspin (efeito para frente)'],
      ['B', 'Chop / corte (efeito para trás)'],
      ['RT', 'Smash (forte; arriscado em bola baixa)'],
      ['Sem botão', 'Bloqueio automático (seguro)'],
      ['MENU', 'Pausar']
    ];
    const colX = x0 + 700;
    let y = y0 + 120;
    for (let i = 0; i < rows.length; i++) {
      const key = rows[i][0];
      let color = '#3a4152';
      if (key === 'A') color = '#3cc34a';
      else if (key === 'B') color = '#e2412f';
      else if (key === 'X') color = '#2f7de2';
      else if (key === 'RT') color = '#8a6bd6';
      ctx.font = font(30, '800');
      const kw = Math.max(64, ctx.measureText(key).width + 34);
      fillRound(ctx, colX, y - 24, kw, 48, 24, color);
      ctx.fillStyle = '#fff';
      ctx.textAlign = 'center';
      ctx.fillText(key, colX + kw / 2, y + 1);
      ctx.textAlign = 'left';
      ctx.font = font(34, '600');
      ctx.fillStyle = COLORS.text;
      ctx.fillText(rows[i][1], colX + 230, y + 1);
      y += 52;
    }
    // teclado
    ctx.font = font(28, '700');
    ctx.fillStyle = COLORS.gold;
    ctx.fillText('Teclado', x0 + 60, y0 + 530);
    ctx.font = font(28, '600');
    ctx.fillStyle = COLORS.text;
    ctx.fillText('J1: WASD mover · F drive · G topspin · H corte · T smash · Esc pausa', x0 + 60, y0 + 570);
    ctx.fillText('J2: Setas mover · K drive · L topspin · J corte · I smash · P pausa', x0 + 60, y0 + 606);
    ctx.textAlign = 'right';
    ctx.fillStyle = COLORS.dim;
    ctx.fillText('Segure o golpe antes da bola chegar.  A / B: voltar', x0 + W - 50, y0 + 56);
  }

  function drawPause(game) {
    ctx.fillStyle = 'rgba(3,5,12,0.7)';
    ctx.fillRect(0, 0, VIEW_W, VIEW_H);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = font(110, '900');
    ctx.fillStyle = COLORS.text;
    ctx.fillText('PAUSADO', VIEW_W / 2, 380);
    const items = [];
    for (let i = 0; i < PAUSE_ITEMS.length; i++) {
      items.push({
        label: PAUSE_ITEMS[i] === 'resume' ? 'Continuar' : 'Sair para o menu',
        value: null, focused: i === game.pauseIndex
      });
    }
    drawMenuList(items, VIEW_W / 2, 500, 640, 90, game.time);
  }

  function drawMatchOver(game) {
    const m = game.match;
    ctx.fillStyle = 'rgba(3,5,12,0.78)';
    ctx.fillRect(0, 0, VIEW_W, VIEW_H);
    if (!m) return;
    const w = m.winner === null ? 0 : m.winner;
    const t = game.matchOverTime || 0;
    // confete simples
    for (let i = 0; i < 40; i++) {
      const px = (i * 173 + t * (60 + (i % 7) * 20)) % VIEW_W;
      const py = (i * 97 + t * (140 + (i % 5) * 40)) % VIEW_H;
      ctx.fillStyle = i % 3 === 0 ? COLORS.gold : (i % 3 === 1 ? PLAYER_COLOR[w] : '#ffffff');
      ctx.globalAlpha = 0.6;
      ctx.fillRect(px, py, 10, 16);
    }
    ctx.globalAlpha = 1;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = font(44, '700');
    ctx.fillStyle = COLORS.dim;
    ctx.fillText('FIM DE PARTIDA', VIEW_W / 2, 170);
    ctx.font = font(120, '900');
    ctx.fillStyle = PLAYER_COLOR[w];
    ctx.fillText(game.names[w] + ' venceu!', VIEW_W / 2, 280);
    ctx.font = font(72, '800');
    ctx.fillStyle = COLORS.text;
    ctx.fillText(m.gamesWon[0] + ' × ' + m.gamesWon[1] + ' em games', VIEW_W / 2, 400);
    // placar por game
    const n = m.history.length;
    const chipW = 170;
    const gap = 20;
    let x = VIEW_W / 2 - (n * chipW + (n - 1) * gap) / 2;
    for (let i = 0; i < n; i++) {
      const h = m.history[i];
      const gw = h[0] > h[1] ? 0 : 1;
      fillRound(ctx, x, 470, chipW, 110, 18, 'rgba(255,255,255,0.08)');
      ctx.fillStyle = PLAYER_COLOR[gw];
      ctx.fillRect(x + 16, 470, chipW - 32, 6);
      ctx.font = font(24, '600');
      ctx.fillStyle = COLORS.dim;
      ctx.fillText('Game ' + (i + 1), x + chipW / 2, 502);
      ctx.font = font(44, '800');
      ctx.fillStyle = COLORS.text;
      ctx.fillText(h[0] + '-' + h[1], x + chipW / 2, 548);
      x += chipW + gap;
    }
    ctx.font = font(30, '600');
    ctx.fillStyle = COLORS.dim;
    ctx.fillText(game.names[0] + ' × ' + game.names[1] + '  ·  Maior rally: ' +
      game.stats.longestRally + ' golpes', VIEW_W / 2, 625);
    const items = [];
    for (let i = 0; i < MATCH_OVER_ITEMS.length; i++) {
      items.push({
        label: MATCH_OVER_ITEMS[i] === 'again' ? 'Jogar novamente' : 'Menu',
        value: null, focused: i === game.matchOverIndex
      });
    }
    drawMenuList(items, VIEW_W / 2, 690, 640, 92, game.time);
  }

  // -------------------------------------------------------------------------
  // Frame
  // -------------------------------------------------------------------------

  function render(game, info) {
    let dt = lastTime < 0 ? 1 / 60 : game.time - lastTime;
    if (!(dt >= 0) || dt > 0.1) dt = 1 / 60;
    // em pausa o tempo do jogo não anda; animações de UI usam dt real pequeno
    const uiDt = info && info.dt ? Math.min(info.dt, 0.1) : 1 / 60;
    lastTime = game.time;
    titleT += uiDt;

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.setTransform(view.scale, 0, 0, view.scale, view.offX, view.offY);

    updateCamera(game, uiDt);
    if (bg) ctx.drawImage(bg, 0, 0);
    else {
      ctx.fillStyle = '#0b1226';
      ctx.fillRect(0, 0, VIEW_W, VIEW_H);
    }

    const geom = drawTable();
    const inMatch = game.screen !== 'title' && game.match;
    if (inMatch) {
      consumeEffects(game);
      pushTrail(game);
      drawBallShadow(game);
      drawNet(geom);
      drawPaddle(game, 0, dt);
      drawPaddle(game, 1, dt);
      drawBall(game);
      drawParticles(dt);
    } else {
      game.effects.length = 0;
      drawNet(geom);
      drawTitleBall(titleT);
    }

    if (flash > 0) {
      ctx.globalAlpha = flash * 0.35;
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, VIEW_W, VIEW_H);
      ctx.globalAlpha = 1;
      flash = Math.max(0, flash - uiDt * 2.5);
    }

    if (game.screen === 'title') {
      drawTitle(game);
      return;
    }
    if (game.screen !== 'matchOver') drawScoreboard(game);
    if (game.screen === 'playing' || game.screen === 'paused') {
      if (game.screen === 'playing') {
        if (game.phase === 'pointOver') drawPointBanner(game);
        if (game.phase === 'gameOver') drawGameOverPanel(game);
        drawServeHint(game);
        drawSwapNotice(game);
      }
      if (game.mode === 'cpu') {
        ctx.font = font(30, '800');
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = 'rgba(255,210,90,0.85)';
        ctx.fillText('DEMO · CPU × CPU', VIEW_W / 2, VIEW_H - SAFE_Y - 30);
      }
      drawControllerStatus(game, info);
    }
    if (game.screen === 'paused') drawPause(game);
    if (game.screen === 'matchOver') drawMatchOver(game);
  }

  return { render: render, resize: resize, ctx: ctx, view: view, camera: cam };
}
