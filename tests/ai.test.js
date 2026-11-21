import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAI, updateAI, AI_LEVELS } from '../src/ai.js';
import { stepBall, movePaddle, trackPaddleHeight } from '../src/physics.js';
import { canHit } from '../src/shot.js';
import { PADDLE_ZONE, TABLE_HALF, TABLE_W_HALF } from '../src/constants.js';

function makeRng(seed) {
  let s = seed % 2147483647;
  if (s <= 0) s += 2147483646;
  return function () {
    s = (s * 16807) % 2147483647;
    return (s - 1) / 2147483646;
  };
}

// Aplica um PlayerInput (coordenadas de tela) à raquete: moveY -> mundo x, moveX -> mundo z.
function applyInput(paddle, side, inp, ball, dt) {
  movePaddle(paddle, side, inp.moveY, inp.moveX, dt);
  trackPaddleHeight(paddle, ball, side, dt);
}

// Simula a bola vindo para o lado da IA. Retorna { reached, minDist, bouncedOwn, shotHeld, pressed }.
function simulate(level, side, ballInit, seed) {
  const rng = makeRng(seed);
  const ai = createAI({ level, rng });
  const ball = Object.assign({ z: 0, vz: 0, spin: 0 }, ballInit);
  const paddle = { x: side * 1.7, y: 0.25, z: 0, vx: 0, vy: 0, vz: 0 };
  const dt = 1 / 60;
  const sub = 4;
  let minDist = Infinity;
  let reached = false;
  let bouncedOwn = false;
  let shotHeld = null;
  let pressed = 0;
  for (let t = 0; t < 3 && !reached; t += dt) {
    const inp = updateAI(ai, { ball, paddle, side, phase: 'rally', isServer: false, ballInPlay: true, dt });
    assert.ok(inp.moveX >= -1 && inp.moveX <= 1);
    assert.ok(inp.moveY >= -1 && inp.moveY <= 1);
    assert.ok(inp.aimX >= -1 && inp.aimX <= 1);
    assert.ok(inp.aimY >= -1 && inp.aimY <= 1);
    if (inp.shotPressed) pressed++;
    for (let k = 0; k < sub; k++) {
      applyInput(paddle, side, inp, ball, dt / sub);
      const ev = stepBall(ball, dt / sub);
      for (const e of ev) if (e.type === 'bounce' && e.side === side) bouncedOwn = true;
      const d = Math.hypot(ball.x - paddle.x, ball.y - paddle.y, ball.z - paddle.z);
      if (d < minDist) minDist = d;
      if (canHit(ball, paddle, side)) { reached = true; shotHeld = inp.shot; break; }
      if (ball.dead) break;
    }
    if (ball.dead) break;
  }
  return { reached, minDist, bouncedOwn, shotHeld, pressed };
}

// Bolas 3D variadas vindo do lado oposto: velocidades, alturas, vy, spin, z inicial e vz.
function scenarios(side) {
  const list = [];
  const speeds = [4.5, 6, 7.5];
  const heights = [0.2, 0.4];
  const vys = [-0.5, 1.0];
  const zs = [-0.5, 0, 0.5];
  const vzs = [-1.2, 0, 1.2];
  const spins = [-60, 0, 80];
  let i = 0;
  for (const vx of speeds) for (const y of heights) for (const vy of vys) for (const z of zs) {
    const vz = vzs[i % vzs.length];
    list.push({ x: -side * 1.3, y, z, vx: side * vx, vy, vz: vz - z * 0.6, spin: spins[i % spins.length] });
    i++;
  }
  return list;
}

function reachRate(level, reps) {
  let valid = 0;
  let reached = 0;
  for (const side of [1, -1]) {
    const sc = scenarios(side);
    for (let rep = 0; rep < reps; rep++) {
      for (let i = 0; i < sc.length; i++) {
        const r = simulate(level, side, sc[i], 1000 + i * 31 + rep * 1013 + (side > 0 ? 7 : 0));
        if (!r.bouncedOwn) continue; // bola fora/rede: a IA pode deixar passar
        valid++;
        if (r.reached) reached++;
      }
    }
  }
  return { valid, reached, rate: valid ? reached / valid : 0 };
}

test('cenários 3D: a maioria quica no lado da IA (sanidade do teste)', () => {
  for (const side of [1, -1]) {
    const sc = scenarios(side);
    let own = 0;
    for (let i = 0; i < sc.length; i++) if (simulate('hard', side, sc[i], 3 + i).bouncedOwn) own++;
    assert.ok(own >= sc.length * 0.6, 'side ' + side + ': ' + own + '/' + sc.length);
  }
});

for (const level of ['hard', 'normal']) {
  test('IA ' + level + ' alcança a bola 3D (canHit) na maioria dos cenários, nos dois lados', () => {
    const r = reachRate(level, 2);
    assert.ok(r.valid >= 40, 'cenários válidos suficientes: ' + r.valid);
    const min = level === 'hard' ? 0.85 : 0.75;
    assert.ok(r.rate >= min, level + ': alcançou ' + r.reached + '/' + r.valid);
  });
}

test('IA easy alcança menos que a hard (mas ainda alcança algumas)', () => {
  const e = reachRate('easy', 2).rate;
  const h = reachRate('hard', 2).rate;
  assert.ok(e < h, 'easy ' + e + ' < hard ' + h);
  assert.ok(e > 0.2, 'easy ainda alcança às vezes: ' + e);
});

test('IA funciona nos dois lados separadamente (side -1 e +1)', () => {
  for (const side of [-1, 1]) {
    const sc = scenarios(side);
    let valid = 0;
    let reached = 0;
    for (let i = 0; i < sc.length; i++) {
      const r = simulate('hard', side, sc[i], 500 + i);
      if (!r.bouncedOwn) continue;
      valid++;
      if (r.reached) reached++;
    }
    assert.ok(valid > 10);
    assert.ok(reached / valid >= 0.8, 'side ' + side + ': ' + reached + '/' + valid);
  }
});

test('IA segue a bola em z: bola cruzada para a lateral leva a raquete para o mesmo lado', () => {
  for (const side of [-1, 1]) {
    for (const zs of [-1, 1]) {
      const ai = createAI({ level: 'hard', rng: makeRng(11) });
      const ball = { x: -side * 1.2, y: 0.3, z: -zs * 0.3, vx: side * 5, vy: 0.5, vz: zs * 1.6, spin: 0 };
      const paddle = { x: side * 1.7, y: 0.25, z: 0, vx: 0, vy: 0, vz: 0 };
      const dt = 1 / 60;
      let maxZ = 0;
      for (let t = 0; t < 1.2; t += dt) {
        const inp = updateAI(ai, { ball, paddle, side, phase: 'rally', isServer: false, ballInPlay: true, dt });
        applyInput(paddle, side, inp, ball, dt);
        stepBall(ball, dt);
        if (paddle.z * zs > maxZ) maxZ = paddle.z * zs;
        if (canHit(ball, paddle, side) || ball.dead) break;
      }
      assert.ok(maxZ > 0.3, 'side ' + side + ' zs ' + zs + ': maxZ ' + maxZ);
    }
  }
});

test('IA segura/aperta um golpe ao chegar na bola (no máximo uma borda por bola)', () => {
  const sc = scenarios(1);
  let checked = 0;
  let withShot = 0;
  for (let i = 0; i < sc.length; i++) {
    const r = simulate('hard', 1, sc[i], 77 + i);
    if (!r.bouncedOwn || !r.reached) continue;
    checked++;
    assert.ok(r.pressed <= 1, 'shotPressed repetido: ' + r.pressed);
    if (r.shotHeld) {
      withShot++;
      assert.ok(['drive', 'topspin', 'chop', 'smash'].indexOf(r.shotHeld) >= 0);
      assert.equal(r.pressed, 1);
    }
  }
  assert.ok(checked > 5);
  assert.ok(withShot > checked / 2, 'golpes com botão: ' + withShot + '/' + checked);
});

// Coleta as miras (lateral, profundidade) que a IA usa ao chegar na bola.
function collectAims(level, side, n) {
  const aims = [];
  const rng = makeRng(level.length * 97 + (side > 0 ? 1 : 2));
  for (let k = 0; k < n; k++) {
    const ai = createAI({ level, rng });
    const ball = { x: -side * 1.2, y: 0.35, z: (rng() - 0.5) * 0.8, vx: side * 5.5, vy: 0.6, vz: 0, spin: 0 };
    const paddle = { x: side * 1.7, y: 0.25, z: 0, vx: 0, vy: 0, vz: 0 };
    const dt = 1 / 60;
    for (let t = 0; t < 1.5; t += dt) {
      const inp = updateAI(ai, { ball, paddle, side, phase: 'rally', isServer: false, ballInPlay: true, dt });
      if (ai.plan && !ai.plan.letGo) {
        // Contrato: lateral = aimX ; profundidade = aimY * -side
        aims.push({ lateral: inp.aimX, depth: inp.aimY * -side });
        break;
      }
      applyInput(paddle, side, inp, ball, dt);
      stepBall(ball, dt);
    }
  }
  return aims;
}

test('mira: hard busca os cantos às vezes; easy é mais previsível; profundidade espelhada por lado', () => {
  function stats(level) {
    const a = collectAims(level, 1, 60).concat(collectAims(level, -1, 60));
    let corner = 0;
    let sumAbs = 0;
    let deep = 0;
    for (const x of a) {
      if (Math.abs(x.lateral) >= 0.75) corner++;
      sumAbs += Math.abs(x.lateral);
      if (x.depth > 0.25) deep++;
    }
    return { n: a.length, corner: corner / a.length, meanAbs: sumAbs / a.length, deep: deep / a.length };
  }
  const e = stats('easy');
  const n = stats('normal');
  const h = stats('hard');
  assert.ok(e.n > 80 && h.n > 80);
  assert.ok(h.corner >= 0.2, 'hard cantos: ' + h.corner);
  assert.ok(e.corner < 0.05, 'easy cantos: ' + e.corner);
  assert.ok(e.meanAbs < n.meanAbs && n.meanAbs < h.meanAbs, 'variação lateral cresce com o nível');
  assert.ok(h.deep > e.deep, 'hard joga mais fundo');
  // Hard mira dos dois lados da mesa
  const hs = collectAims('hard', 1, 60);
  assert.ok(hs.some((x) => x.lateral > 0.5) && hs.some((x) => x.lateral < -0.5));
});

test('IA hard mira longe do oponente quando sabe onde ele está (canto oposto)', () => {
  const side = 1;
  let corner = 0;
  let away = 0;
  const rng = makeRng(42);
  for (let k = 0; k < 60; k++) {
    const ai = createAI({ level: 'hard', rng });
    const oppZ = k % 2 ? 0.5 : -0.5;
    const ball = { x: -1.2, y: 0.35, z: 0, vx: 5.5, vy: 0.6, vz: 0, spin: 0 };
    const paddle = { x: 1.7, y: 0.25, z: 0, vx: 0, vy: 0, vz: 0 };
    const opponent = { x: -1.7, y: 0.25, z: oppZ };
    const dt = 1 / 60;
    for (let t = 0; t < 1.5; t += dt) {
      const inp = updateAI(ai, { ball, paddle, side, phase: 'rally', isServer: false, ballInPlay: true, dt, opponent });
      if (ai.plan && !ai.plan.letGo) {
        if (Math.abs(inp.aimX) >= 0.8) {
          corner++;
          if (inp.aimX * oppZ < 0) away++;
        }
        break;
      }
      applyInput(paddle, side, inp, ball, dt);
      stepBall(ball, dt);
    }
  }
  assert.ok(corner > 5);
  assert.equal(away, corner);
});

test('IA no saque: espera ~0.8 s e aperta shotPressed (todos os níveis, os dois lados)', () => {
  for (const level of ['easy', 'normal', 'hard']) {
    for (const side of [-1, 1]) {
      const ai = createAI({ level, rng: makeRng(9) });
      const paddle = { x: side * 1.6, y: 0.25, z: 0, vx: 0, vy: 0, vz: 0 };
      const ball = { x: paddle.x, y: 0.3, z: 0, vx: 0, vy: 0, vz: 0, spin: 0 };
      let pressedAt = -1;
      const dt = 1 / 60;
      for (let t = 0; t < 3 && pressedAt < 0; t += dt) {
        const inp = updateAI(ai, { ball, paddle, side, phase: 'serve', isServer: true, ballInPlay: false, dt });
        applyInput(paddle, side, inp, ball, dt);
        assert.ok(inp.aimX >= -1 && inp.aimX <= 1 && inp.aimY >= -1 && inp.aimY <= 1);
        if (inp.shotPressed) {
          pressedAt = t;
          assert.ok(['block', 'drive', 'topspin', 'chop', 'smash'].indexOf(inp.shotPressed) >= 0);
        }
      }
      assert.ok(pressedAt >= 0.6, level + ' sacou cedo demais: ' + pressedAt);
      assert.ok(pressedAt <= 1.6, level + ' demorou para sacar: ' + pressedAt);
      // Raquete atrás da linha de fundo do próprio lado e dentro da largura útil
      assert.ok(paddle.x * side > TABLE_HALF);
      assert.ok(Math.abs(paddle.z) <= TABLE_W_HALF);
    }
  }
});

test('IA recebedora no saque não aperta golpe e volta para a posição de espera (x e z)', () => {
  for (const side of [-1, 1]) {
    const ai = createAI({ level: 'normal', rng: makeRng(3) });
    const paddle = { x: side * 1.0, y: 0.8, z: 1.0, vx: 0, vy: 0, vz: 0 };
    const ball = { x: -side * 1.6, y: 0.3, z: 0, vx: 0, vy: 0, vz: 0, spin: 0 };
    const dt = 1 / 60;
    for (let t = 0; t < 2; t += dt) {
      const inp = updateAI(ai, { ball, paddle, side, phase: 'serve', isServer: false, ballInPlay: false, dt });
      assert.equal(inp.shotPressed, null);
      applyInput(paddle, side, inp, ball, dt);
    }
    assert.ok(Math.abs(paddle.x - side * 1.75) < 0.1, 'x ' + paddle.x);
    assert.ok(Math.abs(paddle.z) < 0.1, 'z ' + paddle.z);
    assert.ok(paddle.x * side >= -PADDLE_ZONE.xMax && paddle.x * side <= -PADDLE_ZONE.xMin);
  }
});

test('IA: formato PlayerInput e níveis', () => {
  assert.ok(AI_LEVELS.easy && AI_LEVELS.normal && AI_LEVELS.hard);
  const ai = createAI();
  assert.equal(ai.level, 'normal');
  assert.equal(createAI({ level: 'xyz' }).level, 'normal');
  const inp = updateAI(ai, {
    ball: { x: 0, y: 0.3, z: 0, vx: -5, vy: 0, vz: 0, spin: 0 },
    paddle: { x: 1.7, y: 0.2, z: 0, vx: 0, vy: 0, vz: 0 },
    side: 1, phase: 'rally', isServer: false, ballInPlay: true, dt: 1 / 60
  });
  for (const k of ['connected', 'source', 'moveX', 'moveY', 'aimX', 'aimY', 'shot', 'shotPressed', 'pausePressed']) {
    assert.ok(k in inp, 'campo ' + k);
  }
  assert.equal(inp.pausePressed, false);
  // Bola 2D antiga (sem z) não quebra
  const inp2 = updateAI(createAI(), {
    ball: { x: -1, y: 0.3, vx: 5, vy: 0, spin: 0 }, paddle: { x: 1.7, y: 0.2 },
    side: 1, phase: 'rally', isServer: false, ballInPlay: true, dt: 1 / 60
  });
  assert.ok(isFinite(inp2.moveX) && isFinite(inp2.moveY));
});
