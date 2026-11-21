import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stepBall } from '../src/physics.js';
import { canHit, computeShot, computeServe } from '../src/shot.js';
import { HIT_RADIUS, PHYSICS_DT, TABLE_HALF } from '../src/constants.js';

// rng determinístico (LCG)
function seed(s) {
  let state = s >>> 0;
  return function () {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

// Simula a bola rebatida por `side` até o primeiro quique. ok = quicou no lado do oponente.
function shotOutcome(start, side) {
  const b = { ...start };
  let t = 0;
  let net = false;
  while (t < 3 && !b.dead) {
    const ev = stepBall(b, PHYSICS_DT);
    t += PHYSICS_DT;
    for (const e of ev) {
      if (e.type === 'net') net = true;
      if (e.type === 'bounce') return { ok: e.side === -side, x: e.x, t, net };
      if (e.type === 'floor') return { ok: false, x: e.x, t, net };
    }
  }
  return { ok: false, t, net };
}

// Simula um saque: lista de quiques (x) e se tocou a rede.
function serveOutcome(ball) {
  const b = { ...ball };
  const bounces = [];
  let net = false;
  let t = 0;
  while (t < 3 && !b.dead && bounces.length < 2) {
    for (const e of stepBall(b, PHYSICS_DT)) {
      if (e.type === 'bounce') bounces.push(e);
      if (e.type === 'net') net = true;
    }
    t += PHYSICS_DT;
  }
  return { bounces, net };
}

function validServe(r, side) {
  return !r.net && r.bounces.length === 2 && r.bounces[0].side === side && r.bounces[1].side === -side;
}

// Gera uma bola recebida típica para o lado `side` e mede a taxa de acerto.
function successRate(shotType, side, { n = 200, offset = 0, yMin = 0.03, yMax = 0.48, s = 1 } = {}) {
  const rng = seed(s);
  let ok = 0;
  for (let i = 0; i < n; i++) {
    const x = side * (1.2 + rng() * 0.8);
    const y = yMin + rng() * (yMax - yMin);
    const ball = { x, y, vx: side * (3 + rng() * 5), vy: -1 + rng() * 2, spin: (rng() - 0.5) * 100 };
    const ang = rng() * Math.PI * 2;
    const paddle = { x: x + Math.cos(ang) * offset * HIT_RADIUS, y: y + Math.sin(ang) * offset * HIT_RADIUS, vx: 0, vy: 0 };
    const shot = computeShot({ ball, paddle, side, shotType, rng });
    assert.equal(Math.sign(shot.vx), -side, 'bola volta na direção do oponente');
    if (shotOutcome({ x, y, vx: shot.vx, vy: shot.vy, spin: shot.spin }, side).ok) ok++;
  }
  return ok / n;
}

test('canHit: distância e direção', () => {
  const paddle = { x: -1.6, y: 0.2, vx: 0, vy: 0 };
  assert.equal(canHit({ x: -1.55, y: 0.22, vx: -4, vy: 0, spin: 0 }, paddle, -1), true);
  assert.equal(canHit({ x: -1.55, y: 0.22, vx: 4, vy: 0, spin: 0 }, paddle, -1), false, 'indo embora');
  assert.equal(canHit({ x: -1.6 + HIT_RADIUS + 0.01, y: 0.2, vx: -4, vy: 0, spin: 0 }, paddle, -1), false, 'longe');
  assert.equal(canHit({ x: -1.6, y: 0.25, vx: 0.1, vy: 0, spin: 0 }, paddle, -1), true, 'quase parada');
  const p2 = { x: 1.6, y: 0.2, vx: 0, vy: 0 };
  assert.equal(canHit({ x: 1.55, y: 0.22, vx: 4, vy: 0, spin: 0 }, p2, 1), true);
  assert.equal(canHit({ x: 1.55, y: 0.22, vx: -4, vy: 0, spin: 0 }, p2, 1), false);
  assert.equal(canHit({ x: 1.55, y: 0.22, vx: 4, vy: 0, spin: 0, dead: true }, p2, 1), false);
});

for (const type of ['block', 'drive', 'topspin', 'chop']) {
  for (const side of [-1, 1]) {
    test(`${type} centrado (lado ${side}) passa a rede e quica no oponente em >=95%`, () => {
      const rate = successRate(type, side, { s: 11 });
      assert.ok(rate >= 0.95, `${type} taxa ${rate}`);
    });
  }
}

for (const side of [-1, 1]) {
  test(`smash centrado em bola alta (lado ${side}) acerta em >=95%`, () => {
    const rate = successRate('smash', side, { yMin: 0.3, yMax: 0.65, s: 5 });
    assert.ok(rate >= 0.95, `smash taxa ${rate}`);
  });
}

test('smash em bola baixa é arriscado', () => {
  const high = successRate('smash', -1, { yMin: 0.3, yMax: 0.65, s: 3 });
  const low = successRate('smash', -1, { yMin: 0.03, yMax: 0.15, s: 3 });
  assert.ok(low < 0.6, `smash baixo ${low}`);
  assert.ok(low < high - 0.3);
});

test('contato fora do centro gera mais erros', () => {
  for (const type of ['drive', 'topspin', 'smash']) {
    const opts = type === 'smash' ? { yMin: 0.3, yMax: 0.65 } : {};
    const center = successRate(type, -1, { ...opts, s: 21 });
    const edge = successRate(type, -1, { ...opts, offset: 1.0, s: 21 });
    assert.ok(edge < center - 0.03, `${type}: centro ${center} borda ${edge}`);
  }
});

// O jogo faz contato no 1º passo em que a bola entra em HIT_RADIUS (contato real a ~0.8–1.0×).
for (const side of [-1, 1]) {
  test(`contato a 0.9×HIT_RADIUS ainda é confiável (lado ${side})`, () => {
    const goals = { block: 0.97, drive: 0.9, topspin: 0.9, chop: 0.9 };
    for (const type of Object.keys(goals)) {
      const rate = successRate(type, side, { offset: 0.9, s: 31 });
      assert.ok(rate >= goals[type], `${type} a 0.9×: ${rate}`);
    }
    const smash = successRate('smash', side, { offset: 0.9, yMin: 0.3, yMax: 0.65, s: 31 });
    assert.ok(smash >= 0.85, `smash a 0.9×: ${smash}`);
  });
}

test('qualidade: ~1 até 0.7×HIT_RADIUS, >=0.75 na borda; cai com bola rápida/spin', () => {
  const ball = { x: -1.6, y: 0.2, vx: -5, vy: 0, spin: 0 };
  const q = (frac, b = ball, type = 'drive') =>
    computeShot({ ball: b, paddle: { x: -1.6, y: 0.2 + HIT_RADIUS * frac }, side: -1, shotType: type, rng: seed(1) }).quality;
  assert.equal(q(0), 1);
  assert.equal(q(0.7), 1);
  assert.ok(q(0.9) < 1 && q(0.9) > 0.85, `0.9× ${q(0.9)}`);
  assert.ok(Math.abs(q(1.0) - 0.75) < 0.01, `1.0× ${q(1.0)}`);
  assert.ok(q(0, { ...ball, vx: -13, spin: 150 }) < 0.7, 'bola rápida com spin');
  assert.ok(q(0, { ...ball, y: 0.05 }, 'smash') < 0.7, 'smash em bola baixa');
  const c = computeShot({ ball, paddle: { x: -1.6, y: 0.2 }, side: -1, shotType: 'drive', rng: seed(1) });
  assert.equal(c.type, 'drive');
});

test('velocidades e spins característicos de cada golpe', () => {
  const ball = { x: -1.6, y: 0.25, vx: -5, vy: 0, spin: 0 };
  const paddle = { x: -1.6, y: 0.25, vx: 0, vy: 0 };
  const sh = {};
  for (const t of ['block', 'drive', 'topspin', 'chop', 'smash']) {
    sh[t] = computeShot({ ball: { ...ball, y: t === 'smash' ? 0.45 : 0.25 }, paddle: { ...paddle, y: t === 'smash' ? 0.45 : 0.25 }, side: -1, shotType: t, rng: seed(2) });
  }
  assert.ok(sh.smash.vx > 10);
  assert.ok(sh.topspin.vx > sh.drive.vx * 0.95);
  assert.ok(sh.drive.vx > sh.block.vx);
  assert.ok(sh.block.vx < 5.5 && sh.chop.vx < 5.5);
  assert.ok(sh.topspin.spin > 80);
  assert.ok(sh.chop.spin < -60);
  // tempo de travessia até o quique dá tempo de reagir (exceto smash, que é mortal)
  for (const t of ['block', 'drive', 'topspin', 'chop']) {
    const r = shotOutcome({ x: -1.6, y: 0.25, vx: sh[t].vx, vy: sh[t].vy, spin: sh[t].spin }, -1);
    assert.ok(r.ok);
    assert.ok(r.t > 0.25 && r.t < 0.8, `${t} t=${r.t}`);
  }
});

test('mira: empurrar em direção ao oponente aprofunda o quique', () => {
  const ball = { x: -1.6, y: 0.25, vx: -5, vy: 0, spin: 0 };
  const paddle = { x: -1.6, y: 0.25 };
  const land = (aimX) => {
    const s = computeShot({ ball, paddle, side: -1, shotType: 'drive', aim: { x: aimX, y: 0 }, rng: seed(1) });
    return shotOutcome({ x: ball.x, y: ball.y, vx: s.vx, vy: s.vy, spin: s.spin }, -1).x;
  };
  const short = land(-1);
  const mid = land(0);
  const deep = land(1);
  assert.ok(short < mid && mid < deep, `${short} ${mid} ${deep}`);
  assert.ok(deep < TABLE_HALF);
});

test('velocidade da raquete no contato dá mais força', () => {
  const ball = { x: -1.6, y: 0.3, vx: -5, vy: 0, spin: 0 };
  const still = computeShot({ ball, paddle: { x: -1.6, y: 0.3, vx: 0, vy: 0 }, side: -1, shotType: 'drive', rng: seed(1) });
  const swing = computeShot({ ball, paddle: { x: -1.6, y: 0.3, vx: 3, vy: 0 }, side: -1, shotType: 'drive', rng: seed(1) });
  assert.ok(swing.vx > still.vx + 0.3);
});

test('golpes são simétricos entre os lados', () => {
  const rngA = seed(9);
  const rngB = seed(9);
  for (const t of ['block', 'drive', 'topspin', 'chop', 'smash']) {
    const ballL = { x: -1.7, y: 0.35, vx: -5, vy: -0.5, spin: 30 };
    const ballR = { x: 1.7, y: 0.35, vx: 5, vy: -0.5, spin: 30 };
    const a = computeShot({ ball: ballL, paddle: { x: -1.7, y: 0.32, vx: 0 }, side: -1, shotType: t, aim: { x: 0.5, y: 0 }, rng: rngA });
    const b = computeShot({ ball: ballR, paddle: { x: 1.7, y: 0.32, vx: 0 }, side: 1, shotType: t, aim: { x: -0.5, y: 0 }, rng: rngB });
    assert.ok(Math.abs(a.vx + b.vx) < 1e-9, `${t} vx`);
    assert.ok(Math.abs(a.vy - b.vy) < 1e-9, `${t} vy`);
    assert.ok(Math.abs(a.spin - b.spin) < 1e-9, `${t} spin`);
    assert.equal(a.quality, b.quality);
  }
});

test('computeShot é determinístico com rng injetado', () => {
  const args = () => ({ ball: { x: -1.6, y: 0.2, vx: -9, vy: 0, spin: 120 }, paddle: { x: -1.6, y: 0.27 }, side: -1, shotType: 'topspin', rng: seed(77) });
  assert.deepEqual(computeShot(args()), computeShot(args()));
});

for (const side of [-1, 1]) {
  test(`computeServe gera saques válidos em >=95% (lado ${side})`, () => {
    const rng = seed(side === -1 ? 101 : 202);
    let ok = 0;
    let n = 0;
    for (const type of ['block', 'drive', 'topspin', 'chop', 'smash']) {
      for (let i = 0; i < 40; i++) {
        const paddle = { x: side * (1.45 + rng() * 0.5), y: 0.05 + rng() * 0.4, vx: 0, vy: 0 };
        const aim = { x: (rng() - 0.5) * 2, y: (rng() - 0.5) * 2 };
        const s = computeServe({ side, paddle, shotType: type, aim, rng });
        assert.ok(Math.abs(s.x) > TABLE_HALF, 'saque sai de trás da linha de fundo');
        assert.equal(Math.sign(s.x), side);
        assert.equal(Math.sign(s.vx), -side);
        n++;
        if (validServe(serveOutcome(s), side)) ok++;
      }
    }
    assert.ok(ok / n >= 0.95, `saques válidos ${ok}/${n}`);
  });
}

test('computeServe: às vezes erra (pequena probabilidade)', () => {
  const rng = seed(5);
  let bad = 0;
  const n = 400;
  for (let i = 0; i < n; i++) {
    const s = computeServe({ side: -1, paddle: { x: -1.6, y: 0.25 }, shotType: 'drive', rng });
    if (!validServe(serveOutcome(s), -1)) bad++;
  }
  assert.ok(bad > 0 && bad / n < 0.06, `erros ${bad}/${n}`);
});

test('computeServe: simétrico e aim.x controla a profundidade', () => {
  const fixed = () => 0.5; // sem erro, jitter fixo
  const a = computeServe({ side: -1, paddle: { x: -1.6, y: 0.25 }, shotType: 'topspin', aim: { x: 0.6, y: 0 }, rng: fixed });
  const b = computeServe({ side: 1, paddle: { x: 1.6, y: 0.25 }, shotType: 'topspin', aim: { x: -0.6, y: 0 }, rng: fixed });
  assert.ok(Math.abs(a.x + b.x) < 1e-9 && Math.abs(a.vx + b.vx) < 1e-9 && Math.abs(a.vy - b.vy) < 1e-9);

  const depth = (aimX) => {
    const s = computeServe({ side: -1, paddle: { x: -1.6, y: 0.25 }, shotType: 'drive', aim: { x: aimX, y: 0 }, rng: fixed });
    const r = serveOutcome(s);
    assert.ok(validServe(r, -1));
    return r.bounces[1].x;
  };
  assert.ok(depth(-1) < depth(1) - 0.2);
});
