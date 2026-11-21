import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createBall, stepBall, predictBall, clampPaddle, movePaddle
} from '../src/physics.js';
import {
  TABLE_HALF, NET_H, BALL_R, TABLE_RESTITUTION, FLOOR_Y, PHYSICS_DT,
  PADDLE_MAX_SPEED, PADDLE_ZONE
} from '../src/constants.js';

const DT = PHYSICS_DT;

// Roda até um evento do tipo pedido (ou até maxT). Retorna {event, t, ball, all}.
function runUntil(ball, type, maxT = 3, dt = DT) {
  const all = [];
  let t = 0;
  while (t < maxT && !ball.dead) {
    const ev = stepBall(ball, dt);
    t += dt;
    for (const e of ev) {
      all.push(e);
      if (e.type === type) return { event: e, t, ball, all };
    }
  }
  return { event: null, t, ball, all };
}

test('createBall usa valores padrão', () => {
  assert.deepEqual(createBall(), { x: 0, y: 0.3, vx: 0, vy: 0, spin: 0 });
  const b = createBall(-1, 0.5);
  assert.equal(b.x, -1);
  assert.equal(b.y, 0.5);
});

test('bola quica na mesa com evento e lado corretos', () => {
  const b = { x: -0.6, y: 0.3, vx: 0, vy: 0, spin: 0 };
  const r = runUntil(b, 'bounce');
  assert.ok(r.event, 'deveria quicar');
  assert.equal(r.event.side, -1);
  assert.ok(Math.abs(r.event.x + 0.6) < 1e-6);
  assert.ok(b.vy > 0, 'sobe após o quique');
  assert.ok(b.y >= BALL_R - 1e-9);

  const b2 = { x: 0.9, y: 0.3, vx: 0, vy: 0, spin: 0 };
  const r2 = runUntil(b2, 'bounce');
  assert.equal(r2.event.side, 1);
});

test('restituição: vy após o quique ≈ TABLE_RESTITUTION * vy antes', () => {
  const b = { x: 0.5, y: 0.4, vx: 0, vy: 0, spin: 0 };
  let vyBefore = 0;
  let t = 0;
  let vyAfter = null;
  while (t < 2) {
    vyBefore = b.vy;
    const ev = stepBall(b, DT);
    t += DT;
    if (ev.some((e) => e.type === 'bounce')) { vyAfter = b.vy; break; }
  }
  assert.ok(vyAfter !== null);
  const ratio = vyAfter / -vyBefore;
  assert.ok(Math.abs(ratio - TABLE_RESTITUTION) < 0.03, `razão ${ratio}`);

  // altura do pico seguinte ≈ e² * altura inicial (arrasto reduz um pouco)
  let peak = b.y;
  while (b.vy > 0) { stepBall(b, DT); peak = Math.max(peak, b.y); }
  const h0 = 0.4 - BALL_R;
  const h1 = peak - BALL_R;
  const e2 = TABLE_RESTITUTION * TABLE_RESTITUTION;
  assert.ok(h1 < h0 * e2 * 1.02 && h1 > h0 * e2 * 0.85, `pico ${h1} vs ${h0 * e2}`);
});

test('quique: topspin acelera, backspin freia, spin *= 0.7', () => {
  const top = { x: -0.8, y: 0.1, vx: 3, vy: -1, spin: 100 };
  const back = { x: -0.8, y: 0.1, vx: 3, vy: -1, spin: -100 };
  let vxTopBefore = 0;
  let spinTopBefore = 0;
  let t = 0;
  while (t < 1) {
    vxTopBefore = top.vx; spinTopBefore = top.spin;
    const ev = stepBall(top, DT); t += DT;
    if (ev.some((e) => e.type === 'bounce')) break;
  }
  assert.ok(top.vx > vxTopBefore + 0.1, 'topspin ganha vx');
  assert.ok(Math.abs(top.spin - spinTopBefore * 0.7) < 2);

  let vxBackBefore = 0;
  t = 0;
  while (t < 1) {
    vxBackBefore = back.vx;
    const ev = stepBall(back, DT); t += DT;
    if (ev.some((e) => e.type === 'bounce')) break;
  }
  assert.ok(back.vx < vxBackBefore - 0.1, 'backspin perde vx');
});

test('rede: bola que raspa (clip) continua para o outro lado mais lenta', () => {
  // cruza x=0 com o centro ~5 mm abaixo de NET_H + BALL_R
  const yAt = NET_H + BALL_R - 0.005;
  const b = { x: -0.05, y: yAt, vx: 5, vy: 0, spin: 0 };
  const r = runUntil(b, 'net', 0.5);
  assert.ok(r.event, 'evento de rede');
  assert.equal(r.event.clip, true);
  assert.ok(b.vx > 0 && b.vx < 5 * 0.7, `vx ${b.vx}`);
  const rb = runUntil(b, 'bounce', 2);
  assert.ok(rb.event, 'quica depois');
  assert.equal(rb.event.side, 1, 'cai no lado do oponente');
});

test('rede: bola baixa rebate e volta', () => {
  const b = { x: -0.3, y: 0.08, vx: 6, vy: 0, spin: 0 };
  const r = runUntil(b, 'net', 0.5);
  assert.ok(r.event);
  assert.equal(r.event.clip, false);
  assert.ok(b.vx < 0, 'volta');
  assert.ok(Math.abs(b.vx) < 6 * 0.3);
  assert.ok(b.x < 0);
  const rb = runUntil(b, 'bounce', 2);
  assert.equal(rb.event.side, -1);
});

test('bola alta passa a rede sem evento', () => {
  const b = { x: -0.5, y: 0.35, vx: 5, vy: 0, spin: 0 };
  const r = runUntil(b, 'bounce', 2);
  assert.ok(!r.all.some((e) => e.type === 'net'));
  assert.equal(r.event.side, 1);
});

test('chão: bola fora da mesa cai no chão e para', () => {
  const b = { x: -1.8, y: 0.3, vx: -1, vy: 0, spin: 0 };
  const r = runUntil(b, 'floor');
  assert.ok(r.event);
  assert.ok(r.event.x < -TABLE_HALF);
  assert.equal(b.dead, true);
  assert.equal(b.vx, 0);
  assert.equal(b.vy, 0);
  assert.ok(Math.abs(b.y - (FLOOR_Y + BALL_R)) < 1e-9);
  assert.deepEqual(stepBall(b, DT), []);
});

test('sem tunelamento na rede a 15 m/s, mesmo com dt grande', () => {
  for (const dt of [DT, 1 / 60, 1 / 20]) {
    const b = { x: -0.4, y: 0.09, vx: 15, vy: 0, spin: 0 };
    const r = runUntil(b, 'net', 1, dt);
    assert.ok(r.event, `dt=${dt}: deve bater na rede`);
    assert.equal(r.event.clip, false);
    assert.ok(b.x <= 0, `dt=${dt}: não atravessou`);
    // simétrico: vindo da direita
    const c = { x: 0.4, y: 0.09, vx: -15, vy: 0, spin: 0 };
    const rc = runUntil(c, 'net', 1, dt);
    assert.ok(rc.event);
    assert.ok(c.x >= 0);
  }
});

test('sem tunelamento no tampo a 15 m/s para baixo', () => {
  for (const dt of [DT, 1 / 30]) {
    const b = { x: 0.7, y: 0.3, vx: 0, vy: -15, spin: 0 };
    const r = runUntil(b, 'bounce', 1, dt);
    assert.ok(r.event, `dt=${dt}: deve quicar`);
    assert.equal(r.event.side, 1);
    assert.ok(b.y >= BALL_R - 1e-9);
    assert.ok(b.vy > 0);
  }
});

test('Magnus: topspin cai antes que backspin', () => {
  const launch = (spin) => {
    const b = { x: 0.05, y: 0.3, vx: 3, vy: 0.5, spin };
    return runUntil(b, 'bounce', 3).event.x;
  };
  const xTop = launch(120);
  const xFlat = launch(0);
  const xBack = launch(-120);
  assert.ok(xTop < xFlat - 0.05, `top ${xTop} flat ${xFlat}`);
  assert.ok(xFlat < xBack - 0.05, `flat ${xFlat} back ${xBack}`);
});

test('predictBall não muta a bola original e retorna amostras', () => {
  const b = { x: -1.2, y: 0.3, vx: 5, vy: 1, spin: 50 };
  const snap = { ...b };
  const samples = predictBall(b, 1.0);
  assert.deepEqual(b, snap);
  assert.ok(samples.length > 100);
  for (let i = 1; i < samples.length; i++) assert.ok(samples[i].t > samples[i - 1].t);
  const bounce = samples.find((s) => s.events.some((e) => e.type === 'bounce'));
  assert.ok(bounce, 'previsão contém quique');
  // consistente com stepBall
  const c = { ...b };
  let t = 0;
  let hit = null;
  while (t < 1 && !hit) {
    const ev = stepBall(c, PHYSICS_DT); t += PHYSICS_DT;
    hit = ev.find((e) => e.type === 'bounce') || null;
  }
  const pe = bounce.events.find((e) => e.type === 'bounce');
  assert.ok(Math.abs(pe.x - hit.x) < 1e-9);
});

test('predictBall para quando a bola morre no chão', () => {
  const b = { x: -2, y: 0.2, vx: -1, vy: 0, spin: 0 };
  const s = predictBall(b, 5, 1 / 60);
  assert.ok(s.length < 5 * 60);
  assert.ok(s[s.length - 1].events.some((e) => e.type === 'floor'));
});

test('clampPaddle: zona do lado esquerdo e espelhada para o direito', () => {
  const p = clampPaddle({ x: 0, y: 5, vx: 1, vy: 1 }, -1);
  assert.equal(p.x, PADDLE_ZONE.xMax);
  assert.equal(p.y, PADDLE_ZONE.yMax);
  const q = clampPaddle({ x: -10, y: -5, vx: -1, vy: -1 }, -1);
  assert.equal(q.x, PADDLE_ZONE.xMin);
  assert.equal(q.y, PADDLE_ZONE.yMin);
  assert.equal(q.vx, 0);

  const r = clampPaddle({ x: 0, y: 0.2, vx: 0, vy: 0 }, 1);
  assert.equal(r.x, -PADDLE_ZONE.xMax);
  const s = clampPaddle({ x: 10, y: 0.2, vx: 0, vy: 0 }, 1);
  assert.equal(s.x, -PADDLE_ZONE.xMin);
  const inside = clampPaddle({ x: 1.5, y: 0.2, vx: 0, vy: 0 }, 1);
  assert.equal(inside.x, 1.5);
});

test('movePaddle: aceleração suave até a velocidade máxima, dentro da zona', () => {
  for (const side of [-1, 1]) {
    const p = { x: side * 1.8, y: 0.3, vx: 0, vy: 0 };
    movePaddle(p, side, 1, 0, DT);
    assert.ok(p.vx > 0 && p.vx < PADDLE_MAX_SPEED * 0.5, 'começa devagar');
    for (let i = 0; i < 60; i++) movePaddle(p, side, 1, 0, DT);
    assert.ok(p.vx <= PADDLE_MAX_SPEED + 1e-9);
    // anda para a direita até o limite da zona
    for (let i = 0; i < 600; i++) movePaddle(p, side, 1, 1, DT);
    const xMax = side === -1 ? PADDLE_ZONE.xMax : -PADDLE_ZONE.xMin;
    assert.ok(Math.abs(p.x - xMax) < 1e-9);
    assert.ok(Math.abs(p.y - PADDLE_ZONE.yMax) < 1e-9);
    // diagonal não excede a velocidade máxima
    const d = { x: side * 1.8, y: 0.3, vx: 0, vy: 0 };
    for (let i = 0; i < 40; i++) {
      movePaddle(d, side, -1, -1, DT);
      assert.ok(Math.hypot(d.vx, d.vy) <= PADDLE_MAX_SPEED + 1e-9);
    }
    // soltar o stick freia
    const sp = Math.abs(d.vx);
    assert.ok(sp > 1, 'estava em movimento');
    for (let i = 0; i < 30; i++) movePaddle(d, side, 0, 0, DT);
    assert.ok(Math.abs(d.vx) < sp * 0.2);
  }
});
