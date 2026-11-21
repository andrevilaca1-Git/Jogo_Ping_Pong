import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createBall, stepBall, predictBall, clampPaddle, movePaddle, trackPaddleHeight, PADDLE_WAIT_Y
} from '../src/physics.js';
import {
  TABLE_HALF, TABLE_W_HALF, NET_W_HALF, NET_H, BALL_R, TABLE_RESTITUTION, FLOOR_Y, PHYSICS_DT,
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
  assert.deepEqual(createBall(), { x: 0, y: 0.3, z: 0, vx: 0, vy: 0, vz: 0, spin: 0 });
  const b = createBall(-1, 0.5, 0.2);
  assert.equal(b.x, -1);
  assert.equal(b.y, 0.5);
  assert.equal(b.z, 0.2);
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

test('3D: z integra com arrasto e eventos têm z', () => {
  const b = { x: -0.6, y: 0.3, z: 0.1, vx: 0, vy: 0, vz: 0.5, spin: 0 };
  const r = runUntil(b, 'bounce');
  assert.ok(r.event);
  assert.ok(r.event.z > 0.1 && r.event.z < 0.1 + 0.5 * r.t + 1e-9, `z ${r.event.z}`);
  assert.ok(Math.abs(b.z - r.event.z) < 0.01);
  const f = { x: -1.8, y: 0.3, z: -0.2, vx: -1, vy: 0, vz: -0.4, spin: 0 };
  const rf = runUntil(f, 'floor');
  assert.ok(rf.event.z < -0.2);
  assert.equal(f.vz, 0);
});

test('3D: quique fora da largura da mesa não gera bounce e a bola cai no chão', () => {
  for (const z of [TABLE_W_HALF + 0.02, -(TABLE_W_HALF + 0.05), 1.2]) {
    const b = { x: 0.6, y: 0.3, z, vx: 0, vy: 0, vz: 0, spin: 0 };
    const r = runUntil(b, 'floor');
    assert.ok(r.event, `z=${z}: deve cair no chão`);
    assert.ok(!r.all.some((e) => e.type === 'bounce'), `z=${z}: sem quique`);
    assert.ok(Math.abs(r.event.z - z) < 1e-9);
  }
  // bola que sai pela lateral durante o voo
  const s = { x: -0.8, y: 0.3, z: 0.5, vx: 2, vy: 0, vz: 3, spin: 0 };
  const rs = runUntil(s, 'floor');
  assert.ok(!rs.all.some((e) => e.type === 'bounce'));
  assert.ok(rs.event.z > TABLE_W_HALF);
  // na borda exata ainda quica
  const e = { x: 0.6, y: 0.3, z: TABLE_W_HALF - 0.001, vx: 0, vy: 0, vz: 0, spin: 0 };
  assert.ok(runUntil(e, 'bounce').event);
});

test('3D: bola que passa ao lado da rede (|z| > NET_W_HALF) não gera evento net', () => {
  for (const z of [NET_W_HALF + 0.03, -(NET_W_HALF + 0.1)]) {
    const b = { x: -0.3, y: 0.08, z, vx: 6, vy: 0, vz: 0, spin: 0 };
    const r = runUntil(b, 'floor', 2);
    assert.ok(!r.all.some((e) => e.type === 'net'), `z=${z}`);
    assert.ok(r.event.x > 0, 'passou para o outro lado');
  }
  // dentro dos postes (mas fora da mesa) bate na rede
  const c = { x: -0.3, y: 0.08, z: NET_W_HALF - 0.05, vx: 6, vy: 0, vz: 0, spin: 0 };
  const rc = runUntil(c, 'net', 0.5);
  assert.ok(rc.event);
  assert.equal(rc.event.clip, false);
  // cruzamento oblíquo: z no instante do cruzamento é o que conta
  const o = { x: -0.3, y: 0.08, z: 0.6, vx: 6, vy: 0, vz: 8, spin: 0 };
  const ro = runUntil(o, 'floor', 2);
  assert.ok(!ro.all.some((e) => e.type === 'net'), 'cruza x=0 em z≈1.0');
});

test('3D: bounce com topspin acelera ao longo da direção horizontal', () => {
  const b = { x: -0.8, y: 0.1, z: 0, vx: 3, vy: -1, vz: 3, spin: 100 };
  let before = null;
  let t = 0;
  while (t < 1) {
    before = { vx: b.vx, vz: b.vz };
    const ev = stepBall(b, DT); t += DT;
    if (ev.some((e) => e.type === 'bounce')) break;
  }
  assert.ok(Math.hypot(b.vx, b.vz) > Math.hypot(before.vx, before.vz) + 0.1);
  assert.ok(Math.abs(b.vx / b.vz - before.vx / before.vz) < 1e-6, 'mantém a direção');
});

test('predictBall não muta a bola original e retorna amostras', () => {
  const b = { x: -1.2, y: 0.3, z: 0.2, vx: 5, vy: 1, vz: -0.3, spin: 50 };
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
  assert.ok(Math.abs(pe.z - hit.z) < 1e-9);
  assert.ok('z' in samples[0] && 'vz' in samples[0]);
});

test('predictBall para quando a bola morre no chão', () => {
  const b = { x: -2, y: 0.2, vx: -1, vy: 0, spin: 0 };
  const s = predictBall(b, 5, 1 / 60);
  assert.ok(s.length < 5 * 60);
  assert.ok(s[s.length - 1].events.some((e) => e.type === 'floor'));
});

test('clampPaddle: zona do lado esquerdo e espelhada para o direito (x, y e z)', () => {
  const p = clampPaddle({ x: 0, y: 5, z: 9, vx: 1, vy: 1, vz: 1 }, -1);
  assert.equal(p.x, PADDLE_ZONE.xMax);
  assert.equal(p.y, PADDLE_ZONE.yMax);
  assert.equal(p.z, PADDLE_ZONE.zMax);
  assert.equal(p.vz, 0);
  const q = clampPaddle({ x: -10, y: -5, z: -9, vx: -1, vy: -1, vz: -1 }, -1);
  assert.equal(q.x, PADDLE_ZONE.xMin);
  assert.equal(q.y, PADDLE_ZONE.yMin);
  assert.equal(q.z, PADDLE_ZONE.zMin);
  assert.equal(q.vx, 0);
  assert.equal(q.vz, 0);

  const r = clampPaddle({ x: 0, y: 0.2, z: 0, vx: 0, vy: 0, vz: 0 }, 1);
  assert.equal(r.x, -PADDLE_ZONE.xMax);
  const s = clampPaddle({ x: 10, y: 0.2, z: 5, vx: 0, vy: 0, vz: 0 }, 1);
  assert.equal(s.x, -PADDLE_ZONE.xMin);
  assert.equal(s.z, PADDLE_ZONE.zMax);
  const inside = clampPaddle({ x: 1.5, y: 0.2, z: -0.4, vx: 0, vy: 0, vz: 0 }, 1);
  assert.equal(inside.x, 1.5);
  assert.equal(inside.z, -0.4);
  // raquete antiga sem z ganha z=0
  assert.equal(clampPaddle({ x: -1.5, y: 0.2, vx: 0, vy: 0 }, -1).z, 0);
});

test('movePaddle: coordenadas de mundo (x, z), aceleração suave, não mexe em y', () => {
  for (const side of [-1, 1]) {
    const p = { x: side * 1.8, y: 0.3, z: 0, vx: 0, vy: 0, vz: 0 };
    movePaddle(p, side, 1, 0, DT);
    assert.ok(p.vx > 0 && p.vx < PADDLE_MAX_SPEED * 0.5, 'começa devagar');
    assert.equal(p.vz, 0);
    for (let i = 0; i < 60; i++) movePaddle(p, side, 1, 0, DT);
    assert.ok(p.vx <= PADDLE_MAX_SPEED + 1e-9);
    assert.equal(p.y, 0.3, 'y intacto');
    // anda para +x e +z até o limite da zona
    for (let i = 0; i < 600; i++) movePaddle(p, side, 1, 1, DT);
    const xMax = side === -1 ? PADDLE_ZONE.xMax : -PADDLE_ZONE.xMin;
    assert.ok(Math.abs(p.x - xMax) < 1e-9);
    assert.ok(Math.abs(p.z - PADDLE_ZONE.zMax) < 1e-9);
    assert.equal(p.y, 0.3, 'y intacto');
    // -z
    const m = { x: side * 1.8, y: 0.3, z: 0, vx: 0, vy: 0, vz: 0 };
    for (let i = 0; i < 30; i++) movePaddle(m, side, 0, -1, DT);
    assert.ok(m.z < -0.1 && m.vz < 0);
    assert.ok(Math.abs(m.x - side * 1.8) < 1e-9);
    // diagonal não excede a velocidade máxima
    const d = { x: side * 1.8, y: 0.3, z: 0, vx: 0, vy: 0, vz: 0 };
    for (let i = 0; i < 40; i++) {
      movePaddle(d, side, -1, -1, DT);
      assert.ok(Math.hypot(d.vx, d.vz) <= PADDLE_MAX_SPEED + 1e-9);
    }
    // soltar o stick freia
    const sp = Math.abs(d.vx);
    assert.ok(sp > 1, 'estava em movimento');
    for (let i = 0; i < 30; i++) movePaddle(d, side, 0, 0, DT);
    assert.ok(Math.abs(d.vx) < sp * 0.2);
    assert.ok(Math.abs(d.vz) < sp * 0.2);
  }
});

test('trackPaddleHeight converge para a altura da bola que se aproxima', () => {
  for (const side of [-1, 1]) {
    // bola parada no ar (lançamento do saque)
    const p = { x: side * 1.6, y: 0.25, z: 0, vx: 0, vy: 0, vz: 0 };
    const still = { x: side * 1.6, y: 0.6, z: 0, vx: 0, vy: 0, vz: 0, spin: 0 };
    for (let i = 0; i < 120; i++) trackPaddleHeight(p, still, side, DT);
    assert.ok(Math.abs(p.y - 0.6) < 0.005, `parada: ${p.y}`);

    // bola em voo vindo para o lado: acompanha y durante o voo
    const b = { x: -side * 1.2, y: 0.3, z: 0, vx: side * 6, vy: 1.5, vz: 0, spin: 0 };
    const q = { x: side * 1.6, y: 0.25, z: 0, vx: 0, vy: 0, vz: 0 };
    let maxErr = 0;
    for (let i = 0; i < 100; i++) {
      stepBall(b, DT);
      trackPaddleHeight(q, b, side, DT);
      if (i > 40) maxErr = Math.max(maxErr, Math.abs(q.y - b.y));
    }
    assert.ok(b.vx * side > 0);
    assert.ok(maxErr < 0.03, `erro de rastreamento ${maxErr}`);

    // limitada à zona
    const high = { x: 0, y: 3, z: 0, vx: side * 3, vy: 0, vz: 0, spin: 0 };
    for (let i = 0; i < 240; i++) trackPaddleHeight(q, high, side, DT);
    assert.ok(Math.abs(q.y - PADDLE_ZONE.yMax) < 1e-9);

    // bola indo embora: volta para a altura de espera
    const away = { x: 0, y: 0.8, z: 0, vx: -side * 5, vy: 0, vz: 0, spin: 0 };
    for (let i = 0; i < 480; i++) trackPaddleHeight(q, away, side, DT);
    assert.ok(Math.abs(q.y - PADDLE_WAIT_Y) < 0.01, `espera ${q.y}`);
    // sem bola / bola morta também volta para a espera, sem mexer em x/z
    const r = { x: side * 1.6, y: 0.9, z: 0.3, vx: 0, vy: 0, vz: 0 };
    for (let i = 0; i < 480; i++) trackPaddleHeight(r, { x: 0, y: 0, vx: 0, vy: 0, dead: true }, side, DT);
    assert.ok(Math.abs(r.y - PADDLE_WAIT_Y) < 0.01);
    assert.equal(r.x, side * 1.6);
    assert.equal(r.z, 0.3);
  }
});
