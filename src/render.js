// Renderização Canvas 2D para TV (canvas lógico 1920x1080 escalado mantendo proporção).
// v2 — visão superior 3D: câmera virtual em perspectiva, atrás e acima do lado de baixo
// (side -1), inclinada ~60° em relação ao chão. A mesa aparece na VERTICAL da tela.
// Mundo: +x = para cima na tela (longe da câmera), +z = para a direita, y = altura.
import {
  TABLE_HALF, TABLE_W_HALF, NET_W_HALF, NET_H, BALL_R, FLOOR_Y, PADDLE_R
} from './constants.js';
import { isGamePoint, isMatchPoint, isDeuce, getServer } from './rules.js';
import { getMenuItems, PAUSE_ITEMS, MATCH_OVER_ITEMS, DIFFICULTY_TEXT } from './game.js';

export const VIEW_W = 1920;
export const VIEW_H = 1080;
const SAFE_X = 72;
const SAFE_Y = 48;

// ---------------------------------------------------------------------------
// Câmera (perspectiva real)
// ---------------------------------------------------------------------------

// Parâmetros: inclinação em relação ao chão, distância ao alvo, alvo no tampo (x),
// e dois pontos-âncora usados para ajustar a distância focal e o centro vertical da tela,
// garantindo que as zonas dos dois jogadores (x até ±2.5 m) fiquem visíveis.
export const CAMERA = {
  pitchDeg: 60,
  dist: 7.0,
  targetX: 0.3,
  anchorNear: { x: -2.45, y: 0.12, sy: 1050 },
  anchorFar: { x: 2.5, y: 0.55, sy: 34 },
  centerX: VIEW_W / 2,
  // calculados em setupCamera():
  focal: 0, centerY: 0, posX: 0, posY: 0, sin: 0, cos: 0
};

function setupCamera(c) {
  const th = c.pitchDeg * Math.PI / 180;
  c.sin = Math.sin(th);
  c.cos = Math.cos(th);
  c.posX = c.targetX - c.dist * c.cos;
  c.posY = c.dist * c.sin;
  const ra = camRatio(c, c.anchorNear.x, c.anchorNear.y);
  const rb = camRatio(c, c.anchorFar.x, c.anchorFar.y);
  c.focal = (c.anchorNear.sy - c.anchorFar.sy) / (rb - ra);
  c.centerY = c.anchorNear.sy + c.focal * ra;
}

function camRatio(c, x, y) {
  const dx = x - c.posX;
  const dy = y - c.posY;
  return (dx * c.sin + dy * c.cos) / (dx * c.cos - dy * c.sin);
}

setupCamera(CAMERA);

// Projeta (x, y, z) do mundo em `out` = { sx, sy, scale } (scale = pixels por metro).
export function projectInto(x, y, z, out) {
  const c = CAMERA;
  const dx = x - c.posX;
  const dy = y - c.posY;
  let depth = dx * c.cos - dy * c.sin;
  if (depth < 0.2) depth = 0.2;
  const k = c.focal / depth;
  out.sx = c.centerX + z * k;
  out.sy = c.centerY - (dx * c.sin + dy * c.cos) * k;
  out.scale = k;
  return out;
}

export function project(x, y, z) {
  return projectInto(x, y, z, { sx: 0, sy: 0, scale: 0 });
}

// Trapézio do tampo na tela (para saber se algo no chão está escondido pela mesa).
const TABLE_SCREEN = (function () {
  const nl = project(-TABLE_HALF, 0, -TABLE_W_HALF);
  const nr = project(-TABLE_HALF, 0, TABLE_W_HALF);
  const fl = project(TABLE_HALF, 0, -TABLE_W_HALF);
  const fr = project(TABLE_HALF, 0, TABLE_W_HALF);
  return {
    nearY: nl.sy + 8, farY: fl.sy, nearL: nl.sx, nearR: nr.sx, farL: fl.sx, farR: fr.sx
  };
})();

export function hiddenByTable(sx, sy) {
  const t = TABLE_SCREEN;
  if (sy < t.farY || sy > t.nearY) return false;
  const u = (sy - t.farY) / (t.nearY - t.farY);
  const l = t.farL + (t.nearL - t.farL) * u;
  const r = t.farR + (t.nearR - t.farR) * u;
  return sx > l && sx < r;
}

// ---------------------------------------------------------------------------
// Estilo
// ---------------------------------------------------------------------------

const FONT = '"Segoe UI", "Samsung One", Roboto, "Helvetica Neue", Arial, sans-serif';
const COLORS = {
  p1: '#ff4b3e',
  p1dark: '#7d1416',
  p2: '#3d8bff',
  p2dark: '#0d2d6b',
  ball: '#ff9a1f',
  gold: '#ffd25a',
  text: '#f4f6fb',
  dim: 'rgba(244,246,251,0.66)',
  panel: 'rgba(10,14,28,0.84)',
  tableTop: '#1f63b4',
  tableTopFar: '#17508f',
  tableFace: '#0c2b57',
  line: '#f8fbff'
};
const PLAYER_COLOR = [COLORS.p1, COLORS.p2];
const PLAYER_DARK = [COLORS.p1dark, COLORS.p2dark];

const TRAIL_LEN = 14;
const MAX_PARTICLES = 140;
const MAX_RINGS = 16;
const BALL_VISUAL = 2.2;   // a bola é desenhada um pouco maior que o real (leitura no sofá)
const PADDLE_VISUAL = 1.5;

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

// Pontos temporários reutilizáveis (sem alocação por frame).
const P0 = { sx: 0, sy: 0, scale: 0 };
const P1 = { sx: 0, sy: 0, scale: 0 };
const P2 = { sx: 0, sy: 0, scale: 0 };
const P3 = { sx: 0, sy: 0, scale: 0 };

// Quadrilátero no plano horizontal y=h (x0..x1, z0..z1).
function pathFlatQuad(g, x0, x1, z0, z1, h) {
  projectInto(x0, h, z0, P0);
  projectInto(x0, h, z1, P1);
  projectInto(x1, h, z1, P2);
  projectInto(x1, h, z0, P3);
  g.beginPath();
  g.moveTo(P0.sx, P0.sy);
  g.lineTo(P1.sx, P1.sy);
  g.lineTo(P2.sx, P2.sy);
  g.lineTo(P3.sx, P3.sy);
  g.closePath();
}

// Quadrilátero vertical em x fixo (z0..z1, y0..y1).
function pathXWall(g, x, z0, z1, y0, y1) {
  projectInto(x, y0, z0, P0);
  projectInto(x, y0, z1, P1);
  projectInto(x, y1, z1, P2);
  projectInto(x, y1, z0, P3);
  g.beginPath();
  g.moveTo(P0.sx, P0.sy);
  g.lineTo(P1.sx, P1.sy);
  g.lineTo(P2.sx, P2.sy);
  g.lineTo(P3.sx, P3.sy);
  g.closePath();
}

// Quadrilátero vertical em z fixo (x0..x1, y0..y1).
function pathZWall(g, z, x0, x1, y0, y1) {
  projectInto(x0, y0, z, P0);
  projectInto(x1, y0, z, P1);
  projectInto(x1, y1, z, P2);
  projectInto(x0, y1, z, P3);
  g.beginPath();
  g.moveTo(P0.sx, P0.sy);
  g.lineTo(P1.sx, P1.sy);
  g.lineTo(P2.sx, P2.sy);
  g.lineTo(P3.sx, P3.sy);
  g.closePath();
}

// ---------------------------------------------------------------------------
// Cena estática (arena + mesa) pré-renderizada uma vez — a câmera é fixa.
// ---------------------------------------------------------------------------

function buildScene() {
  const c = makeCanvas(VIEW_W, VIEW_H);
  if (!c) return null;
  const g = c.getContext('2d');
  drawSceneTo(g);
  return c;
}

function drawSceneTo(g) {
  // Fundo (escuro, arquibancada distante)
  let grad = g.createLinearGradient(0, 0, 0, VIEW_H);
  grad.addColorStop(0, '#04060d');
  grad.addColorStop(1, '#0a0f1f');
  g.fillStyle = grad;
  g.fillRect(0, 0, VIEW_W, VIEW_H);

  const FY = FLOOR_Y;
  // Piso da arena
  pathFlatQuad(g, -4.2, 9, -9, 9, FY);
  grad = g.createLinearGradient(0, 0, 0, VIEW_H);
  grad.addColorStop(0, '#120c12');
  grad.addColorStop(1, '#1d1216');
  g.fillStyle = grad;
  g.fill();

  // Quadra (piso esportivo avermelhado) com linha branca
  const CX0 = -3.9;
  const CX1 = 3.2;
  const CZ = 2.6;
  pathFlatQuad(g, CX0, CX1, -CZ, CZ, FY);
  grad = g.createLinearGradient(0, 0, 0, VIEW_H);
  grad.addColorStop(0, '#3e1a1a');
  grad.addColorStop(0.5, '#5a2321');
  grad.addColorStop(1, '#6a2a25');
  g.fillStyle = grad;
  g.fill();
  g.strokeStyle = 'rgba(255,255,255,0.10)';
  g.lineWidth = 2;
  g.stroke();
  // Juntas do piso (tábuas ao longo de x)
  g.strokeStyle = 'rgba(0,0,0,0.12)';
  g.lineWidth = 1;
  for (let zz = -CZ + 0.3; zz < CZ; zz += 0.3) {
    projectInto(CX0, FY, zz, P0);
    projectInto(CX1, FY, zz, P1);
    g.beginPath();
    g.moveTo(P0.sx, P0.sy);
    g.lineTo(P1.sx, P1.sy);
    g.stroke();
  }

  // Poça de luz do holofote no centro
  projectInto(0, FY, 0, P0);
  g.save();
  g.translate(P0.sx, P0.sy);
  g.scale(1, 0.72);
  grad = g.createRadialGradient(0, 0, 30, 0, 0, 720);
  grad.addColorStop(0, 'rgba(255,236,210,0.20)');
  grad.addColorStop(0.6, 'rgba(255,236,210,0.06)');
  grad.addColorStop(1, 'rgba(255,236,210,0)');
  g.fillStyle = grad;
  g.beginPath();
  g.arc(0, 0, 720, 0, Math.PI * 2);
  g.fill();
  g.restore();

  // Barreiras (placas) ao fundo e nas laterais
  const BH = 0.6;
  pathXWall(g, CX1, -CZ, CZ, FY, FY + BH);
  grad = g.createLinearGradient(0, 0, 0, 120);
  grad.addColorStop(0, '#1b2648');
  grad.addColorStop(1, '#0e1530');
  g.fillStyle = grad;
  g.fill();
  g.strokeStyle = 'rgba(255,255,255,0.12)';
  g.lineWidth = 2;
  g.stroke();
  // Texto nas placas do fundo
  projectInto(CX1, FY + BH * 0.5, 0, P0);
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.font = font(Math.round(P0.scale * 0.2), '800');
  const boards = ['PING PONG TV', 'TÊNIS DE MESA'];
  for (let i = 0; i < 2; i++) {
    projectInto(CX1, FY + BH * 0.5, (i === 0 ? -1 : 1) * 1.1, P1);
    g.fillStyle = i % 2 === 0 ? 'rgba(255,154,31,0.45)' : 'rgba(110,170,255,0.45)';
    g.fillText(boards[i], P1.sx, P1.sy);
  }
  for (let s = -1; s <= 1; s += 2) {
    pathZWall(g, s * CZ, -4.2, CX1, FY, FY + BH);
    g.fillStyle = '#121a36';
    g.fill();
    g.strokeStyle = 'rgba(255,255,255,0.08)';
    g.stroke();
  }

  // Sombra da mesa no chão (luz de cima)
  pathFlatQuad(g, -TABLE_HALF - 0.1, TABLE_HALF + 0.1, -TABLE_W_HALF - 0.1, TABLE_W_HALF + 0.1, FY);
  g.fillStyle = 'rgba(0,0,0,0.3)';
  g.fill();

  // Pernas e estrutura (desenhadas de trás para frente)
  const legs = [[1.05, -0.62], [1.05, 0.62], [-1.05, -0.62], [-1.05, 0.62]];
  for (let i = 0; i < legs.length; i++) {
    projectInto(legs[i][0], -0.04, legs[i][1], P0);
    projectInto(legs[i][0], FY, legs[i][1], P1);
    g.strokeStyle = i < 2 ? '#1b1f2a' : '#2d3240';
    g.lineWidth = Math.max(5, P1.scale * 0.045);
    g.lineCap = 'butt';
    g.beginPath();
    g.moveTo(P0.sx, P0.sy);
    g.lineTo(P1.sx, P1.sy);
    g.stroke();
  }

  // Face frontal (lado da câmera) do tampo
  pathXWall(g, -TABLE_HALF, -TABLE_W_HALF, TABLE_W_HALF, -0.045, 0);
  g.fillStyle = COLORS.tableFace;
  g.fill();

  // Tampo
  pathFlatQuad(g, -TABLE_HALF, TABLE_HALF, -TABLE_W_HALF, TABLE_W_HALF, 0);
  projectInto(TABLE_HALF, 0, 0, P0);
  projectInto(-TABLE_HALF, 0, 0, P1);
  grad = g.createLinearGradient(0, P0.sy, 0, P1.sy);
  grad.addColorStop(0, COLORS.tableTopFar);
  grad.addColorStop(1, COLORS.tableTop);
  g.fillStyle = grad;
  g.fill();
  // brilho do holofote
  projectInto(0, 0, 0, P2);
  g.save();
  g.translate(P2.sx, P2.sy);
  g.scale(1, 1.35);
  grad = g.createRadialGradient(0, 0, 10, 0, 0, 260);
  grad.addColorStop(0, 'rgba(255,255,255,0.16)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.beginPath();
  g.arc(0, 0, 260, 0, Math.PI * 2);
  g.fill();
  g.restore();

  // Linhas brancas (2 cm nas bordas, 3 mm ampliada na linha central)
  g.fillStyle = COLORS.line;
  const L = 0.022;
  pathFlatQuad(g, -TABLE_HALF, TABLE_HALF, -TABLE_W_HALF, -TABLE_W_HALF + L, 0.0005); g.fill();
  pathFlatQuad(g, -TABLE_HALF, TABLE_HALF, TABLE_W_HALF - L, TABLE_W_HALF, 0.0005); g.fill();
  pathFlatQuad(g, -TABLE_HALF, -TABLE_HALF + L, -TABLE_W_HALF, TABLE_W_HALF, 0.0005); g.fill();
  pathFlatQuad(g, TABLE_HALF - L, TABLE_HALF, -TABLE_W_HALF, TABLE_W_HALF, 0.0005); g.fill();
  g.fillStyle = 'rgba(248,251,255,0.85)';
  pathFlatQuad(g, -TABLE_HALF, TABLE_HALF, -0.006, 0.006, 0.0005); g.fill();
  // aresta frontal iluminada
  projectInto(-TABLE_HALF, 0, -TABLE_W_HALF, P0);
  projectInto(-TABLE_HALF, 0, TABLE_W_HALF, P1);
  g.strokeStyle = 'rgba(255,255,255,0.5)';
  g.lineWidth = 2;
  g.beginPath();
  g.moveTo(P0.sx, P0.sy + 1);
  g.lineTo(P1.sx, P1.sy + 1);
  g.stroke();
  // sombra da rede no tampo (faixa sutil)
  pathFlatQuad(g, -0.012, 0.03, -TABLE_W_HALF, TABLE_W_HALF, 0.001);
  g.fillStyle = 'rgba(0,0,0,0.22)';
  g.fill();

  // Vinheta
  grad = g.createRadialGradient(960, 540, 380, 960, 540, 1200);
  grad.addColorStop(0, 'rgba(0,0,0,0)');
  grad.addColorStop(1, 'rgba(0,0,0,0.6)');
  g.fillStyle = grad;
  g.fillRect(0, 0, VIEW_W, VIEW_H);
}

function buildBallSprite() {
  const c = makeCanvas(64, 64);
  if (!c) return null;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(22, 20, 3, 32, 32, 31);
  grad.addColorStop(0, '#ffffff');
  grad.addColorStop(0.3, '#ffd9a6');
  grad.addColorStop(0.85, COLORS.ball);
  grad.addColorStop(1, '#c86a00');
  g.fillStyle = grad;
  g.beginPath();
  g.arc(32, 32, 31, 0, Math.PI * 2);
  g.fill();
  return c;
}

function buildGlowSprite() {
  const c = makeCanvas(64, 64);
  if (!c) return null;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(32, 32, 4, 32, 32, 32);
  grad.addColorStop(0, 'rgba(255,190,90,0.55)');
  grad.addColorStop(1, 'rgba(255,190,90,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  return c;
}

// ---------------------------------------------------------------------------
// Renderer
// ---------------------------------------------------------------------------

export function createRenderer(canvas, opts) {
  const o = opts || {};
  let ctx = null;
  try { ctx = canvas.getContext('2d', { alpha: false, desynchronized: true }); } catch (e) { ctx = null; }
  if (!ctx) ctx = canvas.getContext('2d');
  const scene = buildScene();
  const ballSprite = buildBallSprite();
  const glowSprite = buildGlowSprite();
  const rand = o.rng || Math.random;

  const view = { scale: 1, offX: 0, offY: 0, w: VIEW_W, h: VIEW_H };
  const shake = { x: 0, y: 0 };

  // Rastro da bola em coordenadas de mundo (buffer circular)
  const trailX = new Float32Array(TRAIL_LEN);
  const trailY = new Float32Array(TRAIL_LEN);
  const trailZ = new Float32Array(TRAIL_LEN);
  let trailHead = 0;
  let trailCount = 0;

  // Partículas (pool fixo, espaço de tela)
  const pX = new Float32Array(MAX_PARTICLES);
  const pY = new Float32Array(MAX_PARTICLES);
  const pVX = new Float32Array(MAX_PARTICLES);
  const pVY = new Float32Array(MAX_PARTICLES);
  const pLife = new Float32Array(MAX_PARTICLES);
  const pMax = new Float32Array(MAX_PARTICLES);
  const pSize = new Float32Array(MAX_PARTICLES);
  const pColor = new Array(MAX_PARTICLES);
  let pNext = 0;
  // Anéis (mundo): flat = no plano horizontal y=rY
  const rX = new Float32Array(MAX_RINGS);
  const rY = new Float32Array(MAX_RINGS);
  const rZ = new Float32Array(MAX_RINGS);
  const rLife = new Float32Array(MAX_RINGS);
  const rMax = new Float32Array(MAX_RINGS);
  const rSize = new Float32Array(MAX_RINGS);
  const rColor = new Array(MAX_RINGS);
  const rFlat = new Uint8Array(MAX_RINGS);
  let rNext = 0;

  const swing = [0, 0];
  const swingDir = [1, 1];
  let flash = 0;
  let lastTime = -1;
  let titleT = 0;
  const order = [0, 0, 0, 0];   // ordem de desenho (índices de objetos)
  const depthKey = [0, 0, 0, 0];
  const tmpBall = { x: 0, y: 0, z: 0 };
  const ell = { cx: 0, cy: 0, rx: 0, ry: 0 };

  function resize(cssW, cssH, dpr) {
    const ratio = Math.min(dpr || 1, 1.5);
    let w = Math.max(1, Math.round(cssW * ratio));
    let h = Math.max(1, Math.round(cssH * ratio));
    // Limita a resolução interna (TVs 4K): 1 pixel lógico <= 1.5 pixel real.
    const maxScale = 1.5;
    const s0 = Math.min(w / VIEW_W, h / VIEW_H);
    if (s0 > maxScale) { w = Math.round(w * maxScale / s0); h = Math.round(h * maxScale / s0); }
    canvas.width = w;
    canvas.height = h;
    const s = Math.min(w / VIEW_W, h / VIEW_H);
    view.scale = s;
    view.offX = (w - VIEW_W * s) / 2;
    view.offY = (h - VIEW_H * s) / 2;
  }

  // Elipse de um círculo de raio `r` (m) deitado no plano y=h, centrado em (x, z).
  function groundEllipse(x, h, z, r) {
    projectInto(x, h, z, P0);
    projectInto(x + r, h, z, P1);
    projectInto(x - r, h, z, P2);
    ell.cx = P0.sx;
    ell.cy = P0.sy;
    ell.rx = r * P0.scale;
    ell.ry = Math.max(0.5, Math.abs(P2.sy - P1.sy) / 2);
    return ell;
  }

  function fillEllipse(e, color) {
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.ellipse(e.cx, e.cy, e.rx, e.ry, 0, 0, Math.PI * 2);
    ctx.fill();
  }

  function spawnParticle(x, y, vx, vy, life, size, color) {
    const i = pNext;
    pNext = (pNext + 1) % MAX_PARTICLES;
    pX[i] = x; pY[i] = y; pVX[i] = vx; pVY[i] = vy;
    pLife[i] = life; pMax[i] = life; pSize[i] = size; pColor[i] = color;
  }

  function spawnRing(x, y, z, size, life, color, flat) {
    const i = rNext;
    rNext = (rNext + 1) % MAX_RINGS;
    rX[i] = x; rY[i] = y; rZ[i] = z; rSize[i] = size; rLife[i] = life; rMax[i] = life;
    rColor[i] = color; rFlat[i] = flat ? 1 : 0;
  }

  function consumeEffects(game) {
    const list = game.effects;
    for (let i = 0; i < list.length; i++) {
      const fx = list[i];
      const fz = fx.z || 0;
      projectInto(fx.x, fx.y, fz, P3);
      const x = P3.sx;
      const y = P3.sy;
      if (fx.type === 'hit') {
        const power = fx.power || 0.4;
        const color = fx.player === 0 ? COLORS.p1 : COLORS.p2;
        const n = 8 + Math.round(power * 16);
        for (let k = 0; k < n; k++) {
          const a = rand() * Math.PI * 2;
          const sp = 90 + rand() * 380 * (0.5 + power);
          spawnParticle(x, y, Math.cos(a) * sp, Math.sin(a) * sp, 0.22 + rand() * 0.3,
            2 + rand() * 3.5, k % 3 === 0 ? '#ffffff' : (k % 3 === 1 ? COLORS.gold : color));
        }
        spawnRing(fx.x, fx.y, fz, 0.12 + power * 0.18, 0.28, color, false);
        if (fx.player === 0 || fx.player === 1) {
          swing[fx.player] = 0.22;
          swingDir[fx.player] = fx.shot === 'chop' ? -1 : 1;
        }
        if (fx.shot === 'smash') flash = Math.max(flash, 0.45);
      } else if (fx.type === 'bounce') {
        spawnRing(fx.x, 0.002, fz, 0.09, 0.35, 'rgba(255,255,255,0.95)', true);
        for (let k = 0; k < 5; k++) {
          spawnParticle(x, y, (rand() - 0.5) * 200, -60 - rand() * 120, 0.22, 2 + rand() * 2,
            'rgba(255,255,255,0.9)');
        }
      } else if (fx.type === 'net') {
        for (let k = 0; k < 10; k++) {
          spawnParticle(x, y, (rand() - 0.5) * 260, (rand() - 0.8) * 260, 0.35, 2.5,
            k % 2 ? '#ffffff' : '#bcd6ff');
        }
        spawnRing(0, fx.y, fz, 0.14, 0.3, 'rgba(255,255,255,0.8)', false);
      } else if (fx.type === 'floor') {
        spawnRing(fx.x, FLOOR_Y + 0.002, fz, 0.12, 0.4, 'rgba(255,255,255,0.55)', true);
      }
    }
    list.length = 0;
  }

  function updateShake(game) {
    const sh = game.shake || 0;
    if (sh > 0.01) {
      shake.x = (rand() - 0.5) * 18 * sh;
      shake.y = (rand() - 0.5) * 12 * sh;
    } else {
      shake.x = 0;
      shake.y = 0;
    }
  }

  // -------------------------------------------------------------------------
  // Rede (dinâmica para ordenação de profundidade)
  // -------------------------------------------------------------------------

  function drawNet() {
    const W = NET_W_HALF;
    // malha
    pathXWall(ctx, 0, -W, W, 0, NET_H);
    ctx.fillStyle = 'rgba(225,235,255,0.20)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(225,235,255,0.30)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let i = 1; i < 5; i++) {
      const yy = NET_H * i / 5;
      projectInto(0, yy, -W, P0);
      projectInto(0, yy, W, P1);
      ctx.moveTo(P0.sx, P0.sy);
      ctx.lineTo(P1.sx, P1.sy);
    }
    for (let zz = -W + 0.1; zz < W; zz += 0.1) {
      projectInto(0, 0, zz, P0);
      projectInto(0, NET_H, zz, P1);
      ctx.moveTo(P0.sx, P0.sy);
      ctx.lineTo(P1.sx, P1.sy);
    }
    ctx.stroke();
    // fita branca superior
    projectInto(0, NET_H, -W, P0);
    projectInto(0, NET_H, W, P1);
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = Math.max(3, P0.scale * 0.016);
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(P0.sx, P0.sy);
    ctx.lineTo(P1.sx, P1.sy);
    ctx.stroke();
    // postes
    for (let s = -1; s <= 1; s += 2) {
      projectInto(0, -0.04, s * W, P0);
      projectInto(0, NET_H + 0.01, s * W, P1);
      ctx.strokeStyle = '#c3c9d4';
      ctx.lineWidth = Math.max(5, P0.scale * 0.03);
      ctx.lineCap = 'butt';
      ctx.beginPath();
      ctx.moveTo(P0.sx, P0.sy);
      ctx.lineTo(P1.sx, P1.sy);
      ctx.stroke();
      // grampo na borda da mesa
      projectInto(0, 0, s * TABLE_W_HALF, P2);
      ctx.strokeStyle = '#6a717f';
      ctx.lineWidth = Math.max(3, P0.scale * 0.018);
      ctx.beginPath();
      ctx.moveTo(P2.sx, P2.sy);
      ctx.lineTo(P0.sx, P0.sy);
      ctx.stroke();
    }
  }

  // -------------------------------------------------------------------------
  // Bola: sombra, linha de altura, rastro
  // -------------------------------------------------------------------------

  function pushTrail(game) {
    const b = game.ball;
    const moving = game.phase === 'rally' || game.phase === 'pointOver';
    if (!moving || b.dead) {
      if (trailCount > 0) trailCount--;
      return;
    }
    trailX[trailHead] = b.x;
    trailY[trailHead] = b.y;
    trailZ[trailHead] = b.z || 0;
    trailHead = (trailHead + 1) % TRAIL_LEN;
    if (trailCount < TRAIL_LEN) trailCount++;
  }

  // Superfície sob um ponto: tampo (0) se está sobre a mesa e acima dela; senão o chão.
  function groundUnder(x, y, z) {
    if (Math.abs(x) <= TABLE_HALF && Math.abs(z) <= TABLE_W_HALF && y >= -0.005) return 0;
    return FLOOR_Y;
  }

  function drawBallShadow(b) {
    const z = b.z || 0;
    const g = groundUnder(b.x, b.y, z);
    const h = Math.max(0, b.y - BALL_R - g);
    // Perto da mesa: menor, mais escura e nítida. Alta: maior e mais clara.
    const r = BALL_R * BALL_VISUAL * (0.85 + h * 0.55);
    const a = clamp(0.72 - h * 0.42, 0.2, 0.72);
    const e = groundEllipse(b.x, g + 0.001, z, r);
    if (g < 0 && hiddenByTable(e.cx, e.cy)) return;
    ctx.globalAlpha = a;
    fillEllipse(e, '#000000');
    if (h < 0.35) {
      ctx.globalAlpha = a * (1 - h / 0.35) * 0.8;
      ctx.beginPath();
      ctx.ellipse(e.cx, e.cy, e.rx * 0.55, e.ry * 0.55, 0, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  function drawHeightLine(b) {
    const z = b.z || 0;
    const g = groundUnder(b.x, b.y, z);
    const h = b.y - BALL_R - g;
    if (h < 0.025) return;
    projectInto(b.x, g + 0.001, z, P0);
    if (g < 0 && hiddenByTable(P0.sx, P0.sy)) return;
    projectInto(b.x, b.y, z, P1);
    ctx.strokeStyle = 'rgba(255,255,255,0.55)';
    ctx.lineWidth = 2;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(P0.sx, P0.sy);
    ctx.lineTo(P1.sx, P1.sy);
    ctx.stroke();
    // marca na base
    ctx.fillStyle = 'rgba(255,255,255,0.7)';
    ctx.fillRect(P0.sx - 3, P0.sy - 1, 6, 2);
  }

  function drawBallBody(b, spinAngle) {
    const z = b.z || 0;
    projectInto(b.x, b.y, z, P0);
    const r = Math.max(8, BALL_R * BALL_VISUAL * P0.scale);
    const x = P0.sx;
    const y = P0.sy;
    if (glowSprite) ctx.drawImage(glowSprite, x - r * 2.4, y - r * 2.4, r * 4.8, r * 4.8);
    if (ballSprite) ctx.drawImage(ballSprite, x - r, y - r, r * 2, r * 2);
    else {
      ctx.fillStyle = COLORS.ball;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
    }
    if (spinAngle !== null) {
      ctx.strokeStyle = 'rgba(170,70,0,0.6)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(x, y, r * 0.6, spinAngle, spinAngle + 1.4);
      ctx.stroke();
    }
  }

  function drawTrail() {
    if (trailCount < 2) return;
    for (let i = trailCount - 1; i >= 1; i--) {
      const idx = (trailHead - 1 - i + TRAIL_LEN * 2) % TRAIL_LEN;
      const t = 1 - i / trailCount;
      projectInto(trailX[idx], trailY[idx], trailZ[idx], P0);
      const r = Math.max(3, BALL_R * BALL_VISUAL * P0.scale) * (0.3 + 0.6 * t);
      ctx.globalAlpha = 0.38 * t * t;
      ctx.fillStyle = i < 3 ? '#fff3dc' : COLORS.ball;
      ctx.beginPath();
      ctx.arc(P0.sx, P0.sy, r, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  function drawBall(game) {
    const b = game.ball;
    drawTrail();
    drawHeightLine(b);
    drawBallBody(b, game.time * clamp((b.spin || 0) * 0.15, -30, 30));
  }

  function drawBounceHint(game) {
    const hint = game.bounceHint;
    if (!hint || !game.bounceHelp || game.phase !== 'rally') return;
    const remaining = hint.t - game.time;
    if (remaining < -0.1) return;
    const k = clamp(remaining / 0.8, 0, 1);
    const pulse = 0.5 + 0.5 * Math.sin(game.time * 10);
    const e = groundEllipse(hint.x, 0.002, hint.z, 0.06 + 0.05 * k);
    ctx.globalAlpha = 0.45 + 0.25 * pulse;
    ctx.strokeStyle = hint.player === 0 || hint.player === 1 ? PLAYER_COLOR[hint.player] : '#ffffff';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.ellipse(e.cx, e.cy, e.rx, e.ry, 0, 0, Math.PI * 2);
    ctx.stroke();
    ctx.globalAlpha = 0.6;
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.ellipse(e.cx, e.cy, e.rx * 0.45, e.ry * 0.45, 0, 0, Math.PI * 2);
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  // -------------------------------------------------------------------------
  // Raquetes
  // -------------------------------------------------------------------------

  function drawPaddleShadow(game, p) {
    const pad = game.paddles[p];
    const z = pad.z || 0;
    const g = groundUnder(pad.x, pad.y, z);
    const h = Math.max(0, pad.y - g);
    // marca do jogador no chão (cor do jogador)
    const ring = groundEllipse(pad.x, FLOOR_Y + 0.001, z, 0.28);
    if (!hiddenByTable(ring.cx, ring.cy)) {
      ctx.globalAlpha = 0.3;
      ctx.strokeStyle = PLAYER_COLOR[p];
      ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.ellipse(ring.cx, ring.cy, ring.rx, ring.ry, 0, 0, Math.PI * 2);
      ctx.stroke();
    }
    // sombra (mais clara que a da bola para não confundir)
    const e = groundEllipse(pad.x, g + 0.001, z, PADDLE_R * PADDLE_VISUAL * (0.9 + h * 0.25));
    if (g < 0 && hiddenByTable(e.cx, e.cy)) { ctx.globalAlpha = 1; return; }
    ctx.globalAlpha = clamp(0.3 - h * 0.12, 0.12, 0.3);
    fillEllipse(e, '#000000');
    ctx.globalAlpha = 1;
  }

  function drawPaddle(game, p, dt) {
    const pad = game.paddles[p];
    const side = game.sides[p];
    const z = pad.z || 0;
    if (swing[p] > 0) swing[p] = Math.max(0, swing[p] - dt);
    const sw = swing[p] > 0 ? Math.sin((swing[p] / 0.22) * Math.PI) : 0;

    // cabo: aponta para o jogador (para trás, em -side)
    projectInto(pad.x - side * (PADDLE_R + 0.1), pad.y - 0.03, z - side * 0.03, P1);
    projectInto(pad.x, pad.y, z, P0);
    const R = Math.max(14, PADDLE_R * PADDLE_VISUAL * P0.scale) * (1 + 0.12 * sw);
    const cx = P0.sx;
    const cy = P0.sy;
    ctx.strokeStyle = '#c99a5b';
    ctx.lineWidth = Math.max(6, R * 0.34);
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(P1.sx, P1.sy);
    ctx.stroke();

    // lâmina: face voltada para a rede, vista inclinada
    const rot = side * (0.18 * sw * swingDir[p]) + clamp((pad.vz || 0) * 0.05, -0.25, 0.25);
    const ry = R * 0.78;
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(rot);
    ctx.fillStyle = '#d9b07a';
    ctx.beginPath();
    ctx.ellipse(0, 0, R, ry, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = p === 0 ? '#e0322b' : '#15171d';
    ctx.beginPath();
    ctx.ellipse(0, side * R * 0.04, R * 0.88, ry * 0.86, 0, 0, Math.PI * 2);
    ctx.fill();
    if (p === 1) {
      ctx.strokeStyle = COLORS.p2;
      ctx.lineWidth = 3;
      ctx.stroke();
    }
    // reflexo
    ctx.fillStyle = 'rgba(255,255,255,0.18)';
    ctx.beginPath();
    ctx.ellipse(-R * 0.3, -ry * 0.3, R * 0.32, ry * 0.2, -0.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    // rótulo do jogador (acompanha a raquete e, portanto, a troca de lados)
    const label = game.ais[p] ? 'CPU' : ('J' + (p + 1));
    ctx.font = font(24, '800');
    const tw = ctx.measureText(label).width + 22;
    const ly = side < 0 ? cy + R + 26 : cy - R - 26; // fora do caminho da bola
    fillRound(ctx, cx - tw / 2, ly - 16, tw, 32, 16, PLAYER_COLOR[p]);
    ctx.fillStyle = '#ffffff';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, cx, ly + 1);
  }

  // -------------------------------------------------------------------------
  // Partículas
  // -------------------------------------------------------------------------

  function drawParticles(dt) {
    for (let i = 0; i < MAX_PARTICLES; i++) {
      if (pLife[i] <= 0) continue;
      pLife[i] -= dt;
      if (pLife[i] <= 0) continue;
      pVY[i] += 500 * dt;
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
      if (rFlat[i]) {
        const e = groundEllipse(rX[i], rY[i], rZ[i], rad);
        ctx.ellipse(e.cx, e.cy, e.rx, e.ry, 0, 0, Math.PI * 2);
      } else {
        projectInto(rX[i], rY[i], rZ[i], P0);
        ctx.arc(P0.sx, P0.sy, rad * P0.scale, 0, Math.PI * 2);
      }
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  // -------------------------------------------------------------------------
  // Cena dinâmica com ordenação de profundidade (longe -> perto)
  // -------------------------------------------------------------------------

  // objetos: 0 = raquete J1, 1 = raquete J2, 2 = bola, 3 = rede
  function drawWorld(game, dt) {
    const b = game.ball;
    drawBounceHint(game);
    drawPaddleShadow(game, 0);
    drawPaddleShadow(game, 1);
    drawBallShadow(b);
    depthKey[0] = game.paddles[0].x;
    depthKey[1] = game.paddles[1].x;
    depthKey[2] = b.x;
    depthKey[3] = 0;
    for (let i = 0; i < 4; i++) order[i] = i;
    // ordenação por inserção (4 itens), x maior (mais longe) primeiro
    for (let i = 1; i < 4; i++) {
      const v = order[i];
      let j = i - 1;
      while (j >= 0 && depthKey[order[j]] < depthKey[v]) { order[j + 1] = order[j]; j--; }
      order[j + 1] = v;
    }
    for (let i = 0; i < 4; i++) {
      const id = order[i];
      if (id === 0 || id === 1) drawPaddle(game, id, dt);
      else if (id === 2) drawBall(game);
      else drawNet();
    }
  }

  // -------------------------------------------------------------------------
  // HUD (placar na lateral esquerda, cartões dos jogadores na direita)
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

  // Jogador cujo lado está em cima da tela (side +1).
  function topPlayer(game) {
    return game.sides[0] > 0 ? 0 : 1;
  }

  function drawScoreboard(game) {
    const m = game.match;
    if (!m) return;
    const x0 = SAFE_X;
    const y0 = SAFE_Y;
    const W = 560;
    const rowH = 118;
    const headH = 62;
    const H = headH + rowH * 2 + 18;
    fillRound(ctx, x0, y0, W, H, 24, COLORS.panel);
    ctx.strokeStyle = 'rgba(255,255,255,0.10)';
    ctx.lineWidth = 2;
    roundRectPath(ctx, x0, y0, W, H, 24);
    ctx.stroke();

    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    ctx.font = font(30, '800');
    ctx.fillStyle = COLORS.text;
    ctx.fillText('GAME ' + m.gameNumber, x0 + 30, y0 + 36);
    ctx.textAlign = 'right';
    ctx.font = font(26, '600');
    ctx.fillStyle = COLORS.dim;
    ctx.fillText('Melhor de ' + m.bestOf, x0 + W - 30, y0 + 36);

    const server = game.phase === 'serve' || game.phase === 'rally' ? game.server : getServer(m);
    const needed = Math.floor(m.bestOf / 2) + 1;
    const top = topPlayer(game);
    for (let k = 0; k < 2; k++) {
      const p = k === 0 ? top : 1 - top;
      const ry = y0 + headH + k * rowH;
      ctx.fillStyle = PLAYER_COLOR[p];
      ctx.fillRect(x0 + 18, ry + 14, 10, rowH - 28);
      // nome
      ctx.textAlign = 'left';
      ctx.font = font(40, '700');
      ctx.fillStyle = COLORS.text;
      const name = game.names[p];
      ctx.fillText(name, x0 + 48, ry + 40);
      const nameW = ctx.measureText(name).width;
      if (server === p && !m.over) drawServeIcon(x0 + 48 + nameW + 24, ry + 40, 12);
      // games
      for (let gi = 0; gi < needed; gi++) {
        const gx = x0 + 60 + gi * 34;
        ctx.beginPath();
        ctx.arc(gx, ry + 88, 11, 0, Math.PI * 2);
        if (gi < m.gamesWon[p]) {
          ctx.fillStyle = COLORS.gold;
          ctx.fill();
        } else {
          ctx.strokeStyle = 'rgba(255,255,255,0.35)';
          ctx.lineWidth = 3;
          ctx.stroke();
        }
      }
      // pontos
      const bx = x0 + W - 178;
      fillRound(ctx, bx, ry + 8, 156, rowH - 16, 16, PLAYER_DARK[p]);
      ctx.font = font(84, '800');
      ctx.textAlign = 'center';
      ctx.fillStyle = '#ffffff';
      ctx.fillText(String(m.score[p]), bx + 78, ry + rowH / 2 + 5);
    }

    let yy = y0 + H + 16;
    if (game.phase === 'serve' || game.phase === 'rally') {
      let label = null;
      let color = COLORS.gold;
      const mp = isMatchPoint(m);
      const gp = isGamePoint(m);
      if (mp !== null) { label = 'MATCH POINT · ' + game.names[mp]; color = '#ff5470'; }
      else if (gp !== null) { label = 'GAME POINT · ' + game.names[gp]; }
      else if (isDeuce(m)) { label = 'DEUCE'; color = '#7fe3ff'; }
      if (label) {
        ctx.font = font(32, '800');
        const pulse = 0.85 + 0.15 * Math.sin(game.time * 6);
        ctx.globalAlpha = pulse;
        fillRound(ctx, x0, yy, W, 56, 28, color);
        ctx.globalAlpha = 1;
        ctx.fillStyle = '#0b0e18';
        ctx.textAlign = 'center';
        ctx.fillText(label, x0 + W / 2, yy + 30);
        yy += 72;
      }
    }
    if (game.mode === 'cpu') {
      ctx.font = font(28, '800');
      ctx.textAlign = 'left';
      ctx.fillStyle = 'rgba(255,210,90,0.9)';
      ctx.fillText('DEMO · CPU × CPU', x0 + 8, yy + 22);
    }
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

  // Cartões dos jogadores na direita: o de cima é de quem joga no lado de cima da mesa
  // e o de baixo de quem joga embaixo — trocam junto com os lados.
  function drawPlayerCards(game, info) {
    const players = info && info.players;
    const top = topPlayer(game);
    const W = 560;
    const x0 = VIEW_W - SAFE_X - W;
    for (let k = 0; k < 2; k++) {
      const p = k === 0 ? top : 1 - top;
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
      const serving = game.phase === 'serve' && game.server === p && !isAI && game.screen === 'playing';
      const H = serving ? 150 : 96;
      const y0 = k === 0 ? SAFE_Y : VIEW_H - SAFE_Y - H;
      fillRound(ctx, x0, y0, W, H, 24, COLORS.panel);
      ctx.fillStyle = PLAYER_COLOR[p];
      ctx.fillRect(x0 + W - 28, y0 + 16, 10, H - 32);
      drawControllerIcon(x0 + 52, y0 + 48, 50, ok ? PLAYER_COLOR[p] : '#5b6172');
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.font = font(36, '800');
      ctx.fillStyle = COLORS.text;
      ctx.fillText(game.names[p], x0 + 98, y0 + 32);
      ctx.font = font(26, '600');
      ctx.fillStyle = ok ? COLORS.dim : '#ffb4b4';
      ctx.fillText(label, x0 + 98, y0 + 68);
      if (serving) {
        const a = clamp((game.phaseTime - 0.3) / 0.3, 0, 1);
        ctx.globalAlpha = a * (0.75 + 0.25 * Math.sin(game.time * 4));
        drawButtonGlyph(x0 + 52, y0 + 116, 'A', '#3cc34a', 22);
        ctx.textAlign = 'left';
        ctx.font = font(30, '800');
        ctx.fillStyle = COLORS.gold;
        ctx.fillText('Aperte um golpe para sacar', x0 + 88, y0 + 117);
        ctx.globalAlpha = 1;
      }
    }
  }

  const LEGEND = [['', '', 'LS mover'], ['A', '#3cc34a', 'drive'], ['X', '#2f7de2', 'topspin'],
    ['B', '#e2412f', 'corte'], ['RT', '#8a6bd6', 'smash']];
  let legendW = 0;

  function drawControlsLegend(game) {
    // legenda compacta no canto inferior esquerdo (útil no sofá)
    if (game.mode === 'cpu') return;
    const x0 = SAFE_X;
    const y = VIEW_H - SAFE_Y - 26;
    ctx.font = font(24, '700');
    if (!legendW) {
      let w = 28;
      for (let i = 0; i < LEGEND.length; i++) {
        w += (LEGEND[i][0] ? 40 : 0) + ctx.measureText(LEGEND[i][2]).width + 24;
      }
      legendW = w + 8;
    }
    fillRound(ctx, x0, y - 30, legendW, 60, 30, 'rgba(8,12,24,0.72)');
    let x = x0 + 28;
    for (let i = 0; i < LEGEND.length; i++) {
      const it = LEGEND[i];
      if (it[0]) {
        if (it[0].length > 1) {
          fillRound(ctx, x - 2, y - 15, 36, 30, 10, it[1]);
          ctx.fillStyle = '#fff';
          ctx.font = font(17, '800');
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(it[0], x + 16, y + 1);
        } else {
          drawButtonGlyph(x + 15, y, it[0], it[1], 15);
        }
        x += 40;
      }
      ctx.font = font(24, '700');
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = COLORS.dim;
      ctx.fillText(it[2], x, y + 1);
      x += ctx.measureText(it[2]).width + 24;
    }
  }

  function drawBanner(title, subtitle, color, t) {
    const appear = clamp(t / 0.18, 0, 1);
    const yy = 470 - (1 - appear) * 30;
    ctx.globalAlpha = appear;
    ctx.font = font(72, '800');
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const w1 = ctx.measureText(title).width;
    ctx.font = font(42, '600');
    const w2 = subtitle ? ctx.measureText(subtitle).width : 0;
    const W = Math.max(w1, w2) + 120;
    const H = subtitle ? 180 : 116;
    fillRound(ctx, (VIEW_W - W) / 2, yy - H / 2, W, H, 26, 'rgba(8,12,24,0.9)');
    ctx.fillStyle = color;
    ctx.fillRect((VIEW_W - W) / 2 + 26, yy - H / 2, W - 52, 6);
    ctx.font = font(72, '800');
    ctx.fillStyle = color;
    ctx.fillText(title, VIEW_W / 2, subtitle ? yy - 32 : yy);
    if (subtitle) {
      ctx.font = font(42, '600');
      ctx.fillStyle = COLORS.text;
      ctx.fillText(subtitle, VIEW_W / 2, yy + 46);
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
    const y0 = 360;
    fillRound(ctx, x0, y0, W, H, 30, 'rgba(8,12,24,0.92)');
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

  function drawSwapNotice(game) {
    if (!(game.swapNotice > 0)) return;
    ctx.globalAlpha = clamp(game.swapNotice / 0.5, 0, 1);
    ctx.font = font(46, '800');
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const text = 'Troca de lados';
    const tw = ctx.measureText(text).width + 80;
    fillRound(ctx, (VIEW_W - tw) / 2, 330, tw, 80, 40, 'rgba(255,210,90,0.94)');
    ctx.fillStyle = '#121212';
    ctx.fillText(text, VIEW_W / 2, 372);
    ctx.globalAlpha = 1;
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
      const bh = rowH - 12;
      if (it.focused) {
        const pulse = 0.85 + 0.15 * Math.sin(time * 5);
        ctx.globalAlpha = pulse;
        fillRound(ctx, cx - w / 2, y, w, bh, bh / 2, COLORS.ball);
        ctx.globalAlpha = 1;
      } else {
        fillRound(ctx, cx - w / 2, y, w, bh, bh / 2, 'rgba(255,255,255,0.07)');
      }
      const textColor = it.focused ? '#141018' : (it.disabled ? 'rgba(244,246,251,0.35)' : COLORS.text);
      ctx.fillStyle = textColor;
      ctx.textBaseline = 'middle';
      ctx.font = font(40, it.focused ? '800' : '700');
      const cy = y + bh / 2 + 2;
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
    // bola de demonstração quicando de um lado ao outro, com sombra e linha de altura
    const period = 1.6;
    const ph = (t % (period * 2)) / period;
    const dir = ph < 1 ? 1 : -1;
    const u = ph < 1 ? ph : ph - 1;
    tmpBall.x = dir * (-1.25 + 2.5 * u);
    const bounceU = (u * 2) % 1;
    tmpBall.y = BALL_R + 0.38 * 4 * bounceU * (1 - bounceU);
    tmpBall.z = 0.35 * Math.sin(t * 0.9);
    drawBallShadow(tmpBall);
    drawHeightLine(tmpBall);
    drawBallBody(tmpBall, null);
  }

  function drawTitle(game) {
    ctx.fillStyle = 'rgba(4,6,14,0.5)';
    ctx.fillRect(0, 0, VIEW_W, VIEW_H);
    // Escurece a faixa do logo: as placas "PING PONG TV / TÊNIS DE MESA" do fundo da cena
    // apareciam atrás do título e poluíam a leitura.
    const topShade = ctx.createLinearGradient(0, 0, 0, 290);
    topShade.addColorStop(0, 'rgba(4,6,14,0.92)');
    topShade.addColorStop(0.7, 'rgba(4,6,14,0.8)');
    topShade.addColorStop(1, 'rgba(4,6,14,0)');
    ctx.fillStyle = topShade;
    ctx.fillRect(0, 0, VIEW_W, 290);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = font(140, '900');
    const wob = Math.sin(titleT * 1.6) * 4;
    ctx.fillStyle = 'rgba(0,0,0,0.5)';
    ctx.fillText('PING PONG', VIEW_W / 2 + 6, 150 + 8 + wob);
    const grad = ctx.createLinearGradient(0, 85, 0, 215);
    grad.addColorStop(0, '#ffffff');
    grad.addColorStop(1, '#ffc36b');
    ctx.fillStyle = grad;
    ctx.fillText('PING PONG', VIEW_W / 2, 150 + wob);
    const titleW = ctx.measureText('PING PONG').width;
    const badgeX = VIEW_W / 2 + titleW / 2 + 24;
    fillRound(ctx, badgeX, 76 + wob, 120, 70, 16, COLORS.p1);
    ctx.font = font(52, '900');
    ctx.fillStyle = '#fff';
    ctx.fillText('TV', badgeX + 60, 113 + wob);
    ctx.font = font(34, '600');
    ctx.fillStyle = COLORS.dim;
    ctx.fillText('Tênis de mesa no sofá · 1 ou 2 jogadores', VIEW_W / 2, 245);

    if (game.menu.view === 'howto') {
      drawHowTo(game);
      return;
    }
    const items = getMenuItems(game);
    const rowH = 80;
    const panelH = items.length * rowH + 44;
    fillRound(ctx, VIEW_W / 2 - 440, 290, 880, panelH, 30, 'rgba(8,12,24,0.84)');
    drawMenuList(items, VIEW_W / 2, 314, 800, rowH, game.time);

    const y = VIEW_H - SAFE_Y - 30;
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
    fillRound(ctx, cx + w * 0.2, cy - h * 0.62, w * 0.2, h * 0.16, 10 * scale, '#9aa1ad');
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
    const dx = cx - 0.14 * w;
    const dy = cy + 0.08 * h;
    ctx.fillStyle = '#2a2e38';
    ctx.fillRect(dx - 10 * scale, dy - 30 * scale, 20 * scale, 60 * scale);
    ctx.fillRect(dx - 30 * scale, dy - 10 * scale, 60 * scale, 20 * scale);
    const bx = cx + 0.3 * w;
    const by = cy - 0.12 * h;
    const off = 30 * scale;
    drawButtonGlyph(bx, by + off, 'A', '#3cc34a', 18 * scale);
    drawButtonGlyph(bx + off, by, 'B', '#e2412f', 18 * scale);
    drawButtonGlyph(bx - off, by, 'X', '#2f7de2', 18 * scale);
    drawButtonGlyph(bx, by - off, 'Y', '#e8b923', 18 * scale);
    ctx.fillStyle = '#2a2e38';
    ctx.beginPath();
    ctx.arc(cx + 0.07 * w, cy - 0.18 * h, 10 * scale, 0, Math.PI * 2);
    ctx.fill();
  }

  function drawHowTo(game) {
    const x0 = SAFE_X + 24;
    const y0 = 290;
    const W = VIEW_W - 2 * (SAFE_X + 24);
    const H = 716;
    fillRound(ctx, x0, y0, W, H, 30, 'rgba(8,12,24,0.9)');
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.font = font(52, '800');
    ctx.fillStyle = COLORS.gold;
    ctx.fillText('Como jogar', x0 + 50, y0 + 56);
    ctx.textAlign = 'right';
    ctx.font = font(28, '600');
    ctx.fillStyle = COLORS.dim;
    ctx.fillText('A / B: voltar', x0 + W - 50, y0 + 56);

    drawXboxController(x0 + 300, y0 + 270, 0.95);
    // dica visual da sombra (mini mesa)
    ctx.textAlign = 'left';
    ctx.font = font(28, '700');
    ctx.fillStyle = COLORS.gold;
    ctx.fillText('Altura da bola', x0 + 60, y0 + 470);
    ctx.font = font(28, '600');
    ctx.fillStyle = COLORS.text;
    ctx.fillText('A sombra e a linha vertical mostram', x0 + 60, y0 + 510);
    ctx.fillText('a altura. O anel mostra onde vai quicar.', x0 + 60, y0 + 546);

    const rows = [
      ['LS / D-pad', 'Mover a raquete na mesa (a altura é automática)'],
      ['RS', 'Direcionar a bola: lados e curta / funda'],
      ['LS no golpe', 'Sem RS, o stick esquerdo direciona a bola'],
      ['A', 'Drive (golpe reto)'],
      ['X', 'Topspin (efeito para frente)'],
      ['B', 'Corte / chop (efeito para trás)'],
      ['RT', 'Smash (forte; arriscado em bola baixa)'],
      ['Sem botão', 'Bloqueio automático (seguro)'],
      ['MENU', 'Pausar']
    ];
    const colX = x0 + 640;
    const descX = colX + 230;
    let y = y0 + 128;
    for (let i = 0; i < rows.length; i++) {
      const key = rows[i][0];
      let color = '#3a4152';
      if (key === 'A') color = '#3cc34a';
      else if (key === 'B') color = '#e2412f';
      else if (key === 'X') color = '#2f7de2';
      else if (key === 'RT') color = '#8a6bd6';
      ctx.font = font(28, '800');
      const kw = Math.max(64, ctx.measureText(key).width + 34);
      fillRound(ctx, colX, y - 23, kw, 46, 23, color);
      ctx.fillStyle = '#fff';
      ctx.textAlign = 'center';
      ctx.fillText(key, colX + kw / 2, y + 1);
      ctx.textAlign = 'left';
      ctx.font = font(32, '600');
      ctx.fillStyle = COLORS.text;
      ctx.fillText(rows[i][1], descX, y + 1);
      y += 52;
    }
    ctx.font = font(26, '700');
    ctx.fillStyle = COLORS.gold;
    ctx.fillText('Teclado', x0 + 60, y0 + 610);
    ctx.font = font(26, '600');
    ctx.fillStyle = COLORS.text;
    ctx.fillText('J1: WASD mover · F drive · G topspin · H corte · T smash · Esc pausa', x0 + 200, y0 + 610);
    ctx.fillText('J2: Setas mover · K drive · L topspin · J corte · I smash · P pausa', x0 + 200, y0 + 648);
    ctx.fillStyle = COLORS.dim;
    ctx.fillText('Segure o golpe antes da bola chegar. Cima = em direção à rede (para o jogador de baixo).',
      x0 + 60, y0 + 690);
  }

  function drawPause(game) {
    ctx.fillStyle = 'rgba(3,5,12,0.72)';
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
    ctx.fillStyle = 'rgba(3,5,12,0.8)';
    ctx.fillRect(0, 0, VIEW_W, VIEW_H);
    if (!m) return;
    const w = m.winner === null ? 0 : m.winner;
    const t = game.matchOverTime || 0;
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
    const uiDt = info && info.dt ? Math.min(info.dt, 0.1) : 1 / 60;
    lastTime = game.time;
    titleT += uiDt;

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.setTransform(view.scale, 0, 0, view.scale, view.offX, view.offY);

    updateShake(game);
    if (scene) ctx.drawImage(scene, shake.x, shake.y);
    else drawSceneTo(ctx);

    const inMatch = game.screen !== 'title' && game.match;
    ctx.save();
    ctx.translate(shake.x, shake.y);
    if (inMatch) {
      consumeEffects(game);
      pushTrail(game);
      drawWorld(game, dt);
      drawParticles(dt);
    } else {
      game.effects.length = 0;
      drawNet();
      drawTitleBall(titleT);
    }
    ctx.restore();

    if (flash > 0) {
      ctx.globalAlpha = flash * 0.3;
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, VIEW_W, VIEW_H);
      ctx.globalAlpha = 1;
      flash = Math.max(0, flash - uiDt * 2.5);
    }

    if (game.screen === 'title') {
      drawTitle(game);
      return;
    }
    if (game.screen !== 'matchOver') {
      drawScoreboard(game);
      drawPlayerCards(game, info);
      drawControlsLegend(game);
    }
    if (game.screen === 'playing') {
      if (game.phase === 'pointOver') drawPointBanner(game);
      if (game.phase === 'gameOver') drawGameOverPanel(game);
      drawSwapNotice(game);
    }
    if (game.screen === 'paused') drawPause(game);
    if (game.screen === 'matchOver') drawMatchOver(game);
  }

  return { render: render, resize: resize, ctx: ctx, view: view, camera: CAMERA, project: project };
}
