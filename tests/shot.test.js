import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stepBall } from '../src/physics.js';
import { canHit, computeShot, computeServe, normalizeAim } from '../src/shot.js';
import { HIT_RADIUS, PHYSICS_DT, TABLE_HALF, TABLE_W_HALF } from '../src/constants.js';

// rng determinístico (LCG)
function seed(s) {
  let state = s >>> 0;
  return function () {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

// Simula a bola rebatida por `side` até o primeiro quique. ok = quicou na mesa do oponente
// (eventos de quique só existem dentro do tampo, em x e z).
function shotOutcome(start, side) {
  const b = { z: 0, vz: 0, ...start };
  let t = 0;
  let net = false;
  while (t < 3 && !b.dead) {
    const ev = stepBall(b, PHYSICS_DT);
    t += PHYSICS_DT;
    for (const e of ev) {
      if (e.type === 'net') net = true;
      if (e.type === 'bounce') return { ok: e.side === -side, x: e.x, z: e.z, t, net };
      if (e.type === 'floor') return { ok: false, x: e.x, z: e.z, t, net };
    }
  }
  return { ok: false, t, net };
}

// Simula um saque: lista de quiques e se tocou a rede.
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

// Ponto aleatório na superfície de uma esfera de raio r.
function sphere(rng, r) {
  const u = rng() * 2 - 1;
  const th = rng() * Math.PI * 2;
  const k = Math.sqrt(1 - u * u);
  return { dx: k * Math.cos(th) * r, dy: k * Math.sin(th) * r, dz: u * r };
}

// Gera bolas recebidas típicas (3D) para o lado `side` e mede a taxa de acerto.
// lateral: valor fixo ou null (alterna -1, 0, 1). Retorna { rate, sideRate } onde sideRate é a
// fração (entre os acertos com lateral != 0) que caiu no lado z pedido.
function measure(shotType, side, opts = {}) {
  const { n = 210, offset = 0, yMin = 0.03, yMax = 0.48, s = 1, lateral = null, zRange = 1.2, depthAim = true } = opts;
  const rng = seed(s);
  let ok = 0;
  let sideOk = 0;
  let sideN = 0;
  for (let i = 0; i < n; i++) {
    const x = side * (1.2 + rng() * 0.8);
    const y = yMin + rng() * (yMax - yMin);
    const z = (rng() - 0.5) * 2 * zRange;
    const ball = { x, y, z, vx: side * (3 + rng() * 5), vy: -1 + rng() * 2, vz: (rng() - 0.5) * 2, spin: (rng() - 0.5) * 100 };
    const o = sphere(rng, offset * HIT_RADIUS);
    const paddle = { x: x + o.dx, y: y + o.dy, z: z + o.dz, vx: 0, vy: 0, vz: 0 };
    const lat = lateral === null ? [-1, 0, 1][i % 3] : lateral;
    const aim = { lateral: lat, depth: depthAim ? (rng() - 0.5) * 2 : 0 };
    const shot = computeShot({ ball, paddle, side, shotType, aim, rng });
    assert.equal(Math.sign(shot.vx), -side, 'bola volta na direção do oponente');
    const r = shotOutcome({ x, y, z, vx: shot.vx, vy: shot.vy, vz: shot.vz, spin: shot.spin }, side);
    if (r.ok) {
      ok++;
      if (lat !== 0) { sideN++; if (Math.sign(r.z) === lat) sideOk++; }
    }
  }
  return { rate: ok / n, sideRate: sideN ? sideOk / sideN : 1 };
}
const successRate = (type, side, opts) => measure(type, side, opts).rate;

test('canHit: distância 3D e direção', () => {
  const paddle = { x: -1.6, y: 0.2, z: 0, vx: 0, vy: 0, vz: 0 };
  assert.equal(canHit({ x: -1.55, y: 0.22, z: 0.05, vx: -4, vy: 0, vz: 0, spin: 0 }, paddle, -1), true);
  assert.equal(canHit({ x: -1.55, y: 0.22, z: 0, vx: 4, vy: 0, vz: 0, spin: 0 }, paddle, -1), false, 'indo embora');
  assert.equal(canHit({ x: -1.6 + HIT_RADIUS + 0.01, y: 0.2, z: 0, vx: -4, vy: 0, spin: 0 }, paddle, -1), false, 'longe em x');
  assert.equal(canHit({ x: -1.6, y: 0.2, z: HIT_RADIUS + 0.01, vx: -4, vy: 0, spin: 0 }, paddle, -1), false, 'longe em z');
  assert.equal(canHit({ x: -1.6, y: 0.2, z: -(HIT_RADIUS - 0.01), vx: -4, vy: 0, spin: 0 }, paddle, -1), true, 'perto em z');
  // 3D: cada eixo dentro do raio mas a distância total fora
  const k = HIT_RADIUS * 0.7;
  assert.equal(canHit({ x: -1.6 + k, y: 0.2 + k, z: k, vx: -4, vy: 0, spin: 0 }, paddle, -1), false, 'diagonal 3D');
  assert.equal(canHit({ x: -1.6, y: 0.25, z: 0, vx: 0.1, vy: 0, spin: 0 }, paddle, -1), true, 'quase parada');
  const p2 = { x: 1.6, y: 0.2, z: 0.4, vx: 0, vy: 0, vz: 0 };
  assert.equal(canHit({ x: 1.55, y: 0.22, z: 0.42, vx: 4, vy: 0, spin: 0 }, p2, 1), true);
  assert.equal(canHit({ x: 1.55, y: 0.22, z: 0.42, vx: -4, vy: 0, spin: 0 }, p2, 1), false);
  assert.equal(canHit({ x: 1.55, y: 0.22, z: 0.42, vx: 4, vy: 0, spin: 0, dead: true }, p2, 1), false);
  // raquete/bola antigas sem z = z 0
  assert.equal(canHit({ x: -1.55, y: 0.22, vx: -4, vy: 0, spin: 0 }, { x: -1.6, y: 0.2 }, -1), true);
});

test('normalizeAim: formato novo e compatibilidade com {x,y}', () => {
  assert.deepEqual(normalizeAim(undefined, 1), { lateral: 0, depth: 0 });
  assert.deepEqual(normalizeAim({ lateral: 2, depth: -0.5 }, 1), { lateral: 1, depth: -0.5 });
  assert.deepEqual(normalizeAim({ lateral: -0.3 }, -1), { lateral: -0.3, depth: 0 });
  // antigo: x em direção ao oponente = mais fundo; y ignorado
  assert.deepEqual(normalizeAim({ x: 1, y: 1 }, 1), { lateral: 0, depth: 1 });
  assert.deepEqual(normalizeAim({ x: 1, y: 0 }, -1), { lateral: 0, depth: -1 });
});

for (const type of ['block', 'drive', 'topspin', 'chop']) {
  for (const side of [-1, 1]) {
    test(`${type} centrado (lado ${side}, z e lateral variados) cai na mesa do oponente em >=95%`, () => {
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
  test(`contato a 0.9×HIT_RADIUS (3D) ainda é confiável (lado ${side})`, () => {
    for (const type of ['block', 'drive', 'topspin', 'chop']) {
      for (const s of [31, 32]) {
        const rate = successRate(type, side, { offset: 0.9, s });
        assert.ok(rate >= 0.95, `${type} a 0.9× (seed ${s}): ${rate}`);
      }
    }
    const smash = successRate('smash', side, { offset: 0.9, yMin: 0.3, yMax: 0.65, s: 31 });
    assert.ok(smash >= 0.85, `smash a 0.9×: ${smash}`);
  });
}

for (const side of [-1, 1]) {
  test(`aim.lateral escolhe o lado da mesa (lado ${side})`, () => {
    for (const type of ['block', 'drive', 'topspin', 'chop', 'smash']) {
      const opts = type === 'smash' ? { yMin: 0.3, yMax: 0.65 } : {};
      for (const lat of [-1, 1]) {
        const m = measure(type, side, { ...opts, offset: 0.9, lateral: lat, n: 90, s: 41 });
        assert.ok(m.sideRate >= 0.9, `${type} lateral ${lat}: ${m.sideRate}`);
      }
      // lateral 0 cai perto do centro em z
      const zs = [];
      const rng = seed(43);
      for (let i = 0; i < 30; i++) {
        const z = (rng() - 0.5) * 2;
        const y = type === 'smash' ? 0.45 : 0.25;
        const ball = { x: side * 1.6, y, z, vx: side * 5, vy: 0, vz: 0, spin: 0 };
        const sh = computeShot({ ball, paddle: { x: side * 1.6, y, z }, side, shotType: type, aim: { lateral: 0, depth: 0 }, rng });
        const r = shotOutcome({ ...ball, vx: sh.vx, vy: sh.vy, vz: sh.vz, spin: sh.spin }, side);
        assert.ok(r.ok);
        zs.push(Math.abs(r.z));
      }
      assert.ok(Math.max(...zs) < 0.1, `${type} lateral 0: max |z| ${Math.max(...zs)}`);
    }
  });
}

test('mira lateral sem erro: quique em z ≈ lateral*0.55 a partir de qualquer z', () => {
  for (const z0 of [-1.2, -0.5, 0, 0.7, 1.3]) {
    for (const lat of [-1, -0.5, 0, 0.5, 1]) {
      const ball = { x: -1.7, y: 0.3, z: z0, vx: -5, vy: 0, vz: 0.8, spin: 0 };
      const sh = computeShot({ ball, paddle: { x: -1.7, y: 0.3, z: z0 }, side: -1, shotType: 'drive', aim: { lateral: lat, depth: 0 }, rng: seed(3) });
      assert.equal(sh.quality, 1);
      const r = shotOutcome({ ...ball, vx: sh.vx, vy: sh.vy, vz: sh.vz, spin: sh.spin }, -1);
      assert.ok(r.ok);
      assert.ok(Math.abs(r.z - lat * 0.55) < 0.02, `z0=${z0} lat=${lat}: ${r.z}`);
      assert.ok(Math.abs(r.z) < TABLE_W_HALF);
    }
  }
});

test('qualidade: ~1 até 0.7×HIT_RADIUS, >=0.75 na borda (em qualquer eixo); cai com bola rápida/spin', () => {
  const ball = { x: -1.6, y: 0.2, z: 0.1, vx: -5, vy: 0, vz: 0, spin: 0 };
  const q = (frac, b = ball, type = 'drive', axis = 'y') => {
    const paddle = { x: -1.6, y: 0.2, z: 0.1 };
    paddle[axis] += HIT_RADIUS * frac;
    return computeShot({ ball: b, paddle, side: -1, shotType: type, rng: seed(1) }).quality;
  };
  for (const axis of ['x', 'y', 'z']) {
    assert.equal(q(0, ball, 'drive', axis), 1);
    assert.equal(q(0.7, ball, 'drive', axis), 1);
    assert.ok(q(0.9, ball, 'drive', axis) < 1 && q(0.9, ball, 'drive', axis) > 0.85, `0.9× ${axis}`);
    assert.ok(Math.abs(q(1.0, ball, 'drive', axis) - 0.75) < 0.01, `1.0× ${axis}`);
  }
  assert.ok(q(0, { ...ball, vx: -13, spin: 150 }) < 0.7, 'bola rápida com spin');
  assert.ok(q(0, { ...ball, y: 0.05 }, 'smash') < 0.7, 'smash em bola baixa');
  const c = computeShot({ ball, paddle: { x: -1.6, y: 0.2, z: 0.1 }, side: -1, shotType: 'drive', rng: seed(1) });
  assert.equal(c.type, 'drive');
  assert.equal(typeof c.vz, 'number');
});

test('velocidades e spins característicos de cada golpe', () => {
  const ball = { x: -1.6, y: 0.25, z: 0, vx: -5, vy: 0, vz: 0, spin: 0 };
  const paddle = { x: -1.6, y: 0.25, z: 0, vx: 0, vy: 0, vz: 0 };
  const sh = {};
  for (const t of ['block', 'drive', 'topspin', 'chop', 'smash']) {
    const y = t === 'smash' ? 0.45 : 0.25;
    sh[t] = computeShot({ ball: { ...ball, y }, paddle: { ...paddle, y }, side: -1, shotType: t, rng: seed(2) });
  }
  assert.ok(sh.smash.vx > 10);
  assert.ok(sh.topspin.vx > sh.drive.vx * 0.95);
  assert.ok(sh.drive.vx > sh.block.vx);
  assert.ok(sh.block.vx < 5.5 && sh.chop.vx < 5.5);
  assert.ok(sh.topspin.spin > 80);
  assert.ok(sh.chop.spin < -60);
  // tempo de travessia até o quique dá tempo de reagir (exceto smash, que é mortal)
  for (const t of ['block', 'drive', 'topspin', 'chop']) {
    const r = shotOutcome({ x: -1.6, y: 0.25, z: 0, vx: sh[t].vx, vy: sh[t].vy, vz: sh[t].vz, spin: sh[t].spin }, -1);
    assert.ok(r.ok);
    assert.ok(r.t > 0.25 && r.t < 0.8, `${t} t=${r.t}`);
  }
});

test('mira: aim.depth aprofunda o quique (e formato antigo aim.x continua funcionando)', () => {
  const ball = { x: -1.6, y: 0.25, z: 0, vx: -5, vy: 0, vz: 0, spin: 0 };
  const paddle = { x: -1.6, y: 0.25, z: 0 };
  const land = (aim) => {
    const s = computeShot({ ball, paddle, side: -1, shotType: 'drive', aim, rng: seed(1) });
    return shotOutcome({ ...ball, vx: s.vx, vy: s.vy, vz: s.vz, spin: s.spin }, -1).x;
  };
  const short = land({ lateral: 0, depth: -1 });
  const mid = land({ lateral: 0, depth: 0 });
  const deep = land({ lateral: 0, depth: 1 });
  assert.ok(short < mid && mid < deep, `${short} ${mid} ${deep}`);
  assert.ok(deep < TABLE_HALF);
  assert.ok(Math.abs(land({ x: 1, y: 0 }) - deep) < 1e-9, 'compat {x,y}');
  // lado direito: depth +1 também é mais fundo (|x| maior no lado esquerdo)
  const ballR = { x: 1.6, y: 0.25, z: 0, vx: 5, vy: 0, vz: 0, spin: 0 };
  const landR = (depth) => {
    const s = computeShot({ ball: ballR, paddle: { x: 1.6, y: 0.25, z: 0 }, side: 1, shotType: 'drive', aim: { lateral: 0, depth }, rng: seed(1) });
    return shotOutcome({ ...ballR, vx: s.vx, vy: s.vy, vz: s.vz, spin: s.spin }, 1).x;
  };
  assert.ok(landR(1) < landR(-1) - 0.2);
});

test('velocidade da raquete no contato dá mais força', () => {
  const ball = { x: -1.6, y: 0.3, z: 0, vx: -5, vy: 0, spin: 0 };
  const still = computeShot({ ball, paddle: { x: -1.6, y: 0.3, z: 0, vx: 0, vy: 0 }, side: -1, shotType: 'drive', rng: seed(1) });
  const swing = computeShot({ ball, paddle: { x: -1.6, y: 0.3, z: 0, vx: 3, vy: 0 }, side: -1, shotType: 'drive', rng: seed(1) });
  assert.ok(swing.vx > still.vx + 0.3);
});

test('golpes são simétricos entre os lados', () => {
  const rngA = seed(9);
  const rngB = seed(9);
  for (const t of ['block', 'drive', 'topspin', 'chop', 'smash']) {
    const ballL = { x: -1.7, y: 0.35, z: 0.3, vx: -5, vy: -0.5, vz: 0.2, spin: 30 };
    const ballR = { x: 1.7, y: 0.35, z: 0.3, vx: 5, vy: -0.5, vz: 0.2, spin: 30 };
    const aim = { lateral: -0.6, depth: 0.5 };
    const a = computeShot({ ball: ballL, paddle: { x: -1.7, y: 0.32, z: 0.3, vx: 0 }, side: -1, shotType: t, aim, rng: rngA });
    const b = computeShot({ ball: ballR, paddle: { x: 1.7, y: 0.32, z: 0.3, vx: 0 }, side: 1, shotType: t, aim, rng: rngB });
    assert.ok(Math.abs(a.vx + b.vx) < 1e-9, `${t} vx`);
    assert.ok(Math.abs(a.vy - b.vy) < 1e-9, `${t} vy`);
    assert.ok(Math.abs(a.vz - b.vz) < 1e-9, `${t} vz`);
    assert.ok(Math.abs(a.spin - b.spin) < 1e-9, `${t} spin`);
    assert.equal(a.quality, b.quality);
  }
});

test('computeShot é determinístico com rng injetado', () => {
  const args = () => ({ ball: { x: -1.6, y: 0.2, z: 0.4, vx: -9, vy: 0, vz: -1, spin: 120 }, paddle: { x: -1.6, y: 0.27, z: 0.35 }, side: -1, shotType: 'topspin', aim: { lateral: 1, depth: 0 }, rng: seed(77) });
  assert.deepEqual(computeShot(args()), computeShot(args()));
});

for (const side of [-1, 1]) {
  test(`computeServe gera saques válidos em >=95% com lateral variado (lado ${side})`, () => {
    const rng = seed(side === -1 ? 101 : 202);
    let ok = 0;
    let n = 0;
    for (const type of ['block', 'drive', 'topspin', 'chop', 'smash']) {
      for (let i = 0; i < 40; i++) {
        const paddle = { x: side * (1.45 + rng() * 0.5), y: 0.05 + rng() * 0.4, z: (rng() - 0.5) * 2.4, vx: 0, vy: 0, vz: 0 };
        const aim = { lateral: [-1, -0.5, 0, 0.5, 1][i % 5], depth: (rng() - 0.5) * 2 };
        const s = computeServe({ side, paddle, shotType: type, aim, rng });
        assert.ok(Math.abs(s.x) > TABLE_HALF, 'saque sai de trás da linha de fundo');
        assert.equal(Math.sign(s.x), side);
        assert.equal(Math.sign(s.vx), -side);
        assert.equal(typeof s.z, 'number');
        assert.equal(typeof s.vz, 'number');
        n++;
        if (validServe(serveOutcome(s), side)) ok++;
      }
    }
    assert.ok(ok / n >= 0.95, `saques válidos ${ok}/${n}`);
  });
}

test('computeServe: aim.lateral leva o 2º quique para o lado pedido', () => {
  const fixed = () => 0.5;
  for (const side of [-1, 1]) {
    for (const z0 of [-0.6, 0, 0.6]) {
      for (const lat of [-1, 0, 1]) {
        const s = computeServe({ side, paddle: { x: side * 1.6, y: 0.25, z: z0 }, shotType: 'drive', aim: { lateral: lat, depth: 0 }, rng: fixed });
        const r = serveOutcome(s);
        assert.ok(validServe(r, side), `side ${side} z0 ${z0} lat ${lat}`);
        assert.ok(Math.abs(r.bounces[1].z - lat * 0.55) < 0.03, `2º quique z ${r.bounces[1].z} (lat ${lat})`);
      }
    }
  }
});

test('computeServe: às vezes erra (pequena probabilidade)', () => {
  const rng = seed(5);
  let bad = 0;
  const n = 400;
  for (let i = 0; i < n; i++) {
    const s = computeServe({ side: -1, paddle: { x: -1.6, y: 0.25, z: 0 }, shotType: 'drive', rng });
    if (!validServe(serveOutcome(s), -1)) bad++;
  }
  assert.ok(bad > 0 && bad / n < 0.06, `erros ${bad}/${n}`);
});

test('computeServe: simétrico e aim.depth controla a profundidade', () => {
  const fixed = () => 0.5; // sem erro, jitter fixo
  const aim = { lateral: 0.4, depth: 0.6 };
  const a = computeServe({ side: -1, paddle: { x: -1.6, y: 0.25, z: 0.2 }, shotType: 'topspin', aim, rng: fixed });
  const b = computeServe({ side: 1, paddle: { x: 1.6, y: 0.25, z: 0.2 }, shotType: 'topspin', aim, rng: fixed });
  assert.ok(Math.abs(a.x + b.x) < 1e-9 && Math.abs(a.vx + b.vx) < 1e-9 && Math.abs(a.vy - b.vy) < 1e-9);
  assert.ok(Math.abs(a.z - b.z) < 1e-9 && Math.abs(a.vz - b.vz) < 1e-9);

  const depth = (aimArg) => {
    const s = computeServe({ side: -1, paddle: { x: -1.6, y: 0.25, z: 0 }, shotType: 'drive', aim: aimArg, rng: fixed });
    const r = serveOutcome(s);
    assert.ok(validServe(r, -1));
    return r.bounces[1].x;
  };
  assert.ok(depth({ lateral: 0, depth: -1 }) < depth({ lateral: 0, depth: 1 }) - 0.2);
  // compat formato antigo
  assert.ok(Math.abs(depth({ x: 1, y: 0 }) - depth({ lateral: 0, depth: 1 })) < 1e-9);
});
