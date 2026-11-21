import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAI, updateAI, AI_LEVELS } from '../src/ai.js';
import { stepBall, movePaddle } from '../src/physics.js';
import { HIT_RADIUS, PADDLE_ZONE } from '../src/constants.js';

function makeRng(seed) {
  let s = seed % 2147483647;
  if (s <= 0) s += 2147483646;
  return function () {
    s = (s * 16807) % 2147483647;
    return (s - 1) / 2147483646;
  };
}

// Simula a bola vindo para o lado da IA. Retorna { minDist, bouncedOwn }.
function simulate(level, side, ballInit, seed) {
  const rng = makeRng(seed);
  const ai = createAI({ level, rng });
  const ball = Object.assign({ spin: 0 }, ballInit);
  const paddle = { x: side * 1.7, y: 0.2, vx: 0, vy: 0 };
  const dt = 1 / 60;
  const sub = 4;
  let minDist = Infinity;
  let bouncedOwn = false;
  let shotHeld = false;
  let pressed = 0;
  for (let t = 0; t < 3; t += dt) {
    const inp = updateAI(ai, { ball, paddle, side, phase: 'rally', isServer: false, ballInPlay: true, dt });
    assert.ok(inp.moveX >= -1 && inp.moveX <= 1);
    assert.ok(inp.moveY >= -1 && inp.moveY <= 1);
    if (inp.shotPressed) pressed++;
    for (let k = 0; k < sub; k++) {
      movePaddle(paddle, side, inp.moveX, inp.moveY, dt / sub);
      const ev = stepBall(ball, dt / sub);
      for (const e of ev) if (e.type === 'bounce' && e.side === side) bouncedOwn = true;
      const d = Math.hypot(ball.x - paddle.x, ball.y - paddle.y);
      if (d < minDist) { minDist = d; shotHeld = inp.shot; }
      if (ball.dead) break;
    }
    if (ball.dead) break;
  }
  return { minDist, bouncedOwn, shotHeld, pressed };
}

function scenarios(side) {
  const list = [];
  const speeds = [4.5, 5.5, 6.5, 7.5];
  const heights = [0.2, 0.35, 0.5];
  const vys = [-0.5, 0.5, 1.5];
  const spins = [-60, 0, 80];
  let i = 0;
  for (const vx of speeds) for (const y of heights) for (const vy of vys) {
    list.push({ x: -side * 1.3, y, vx: side * vx, vy, spin: spins[i++ % spins.length] });
  }
  return list;
}

for (const level of ['hard', 'normal']) {
  test('IA ' + level + ' alcança a bola na maioria dos cenários (ambos os lados)', () => {
    let valid = 0;
    let reached = 0;
    for (const side of [1, -1]) {
      const sc = scenarios(side);
      for (let i = 0; i < sc.length; i++) {
        const r = simulate(level, side, sc[i], 1000 + i * 31 + (side > 0 ? 7 : 0));
        if (!r.bouncedOwn) continue; // bola fora/rede: a IA pode deixar passar
        valid++;
        if (r.minDist < HIT_RADIUS) reached++;
      }
    }
    assert.ok(valid >= 20, 'cenários válidos suficientes: ' + valid);
    const rate = reached / valid;
    const min = level === 'hard' ? 0.85 : 0.75;
    assert.ok(rate >= min, level + ': alcançou ' + reached + '/' + valid);
  });
}

test('IA easy erra mais que a hard (mas ainda alcança algumas)', () => {
  function rate(level) {
    let valid = 0;
    let reached = 0;
    for (const side of [1, -1]) {
      const sc = scenarios(side);
      for (let rep = 0; rep < 3; rep++) {
        for (let i = 0; i < sc.length; i++) {
          const r = simulate(level, side, sc[i], 5 + i * 17 + rep * 1013 + (side > 0 ? 3 : 0));
          if (!r.bouncedOwn) continue;
          valid++;
          if (r.minDist < HIT_RADIUS * 0.6) reached++;
        }
      }
    }
    return reached / valid;
  }
  const e = rate('easy');
  const h = rate('hard');
  assert.ok(e < h, 'easy ' + e + ' < hard ' + h);
  assert.ok(e > 0.2, 'easy ainda acerta às vezes: ' + e);
});

test('IA segura/aperta um golpe ao chegar na bola (no máximo uma borda por bola)', () => {
  const sc = scenarios(1);
  let checked = 0;
  let withShot = 0;
  for (let i = 0; i < sc.length; i++) {
    const r = simulate('hard', 1, sc[i], 77 + i);
    if (!r.bouncedOwn || r.minDist >= HIT_RADIUS) continue;
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

test('IA no saque: espera ~0.8 s e aperta shotPressed', () => {
  for (const level of ['easy', 'normal', 'hard']) {
    for (const side of [-1, 1]) {
      const ai = createAI({ level, rng: makeRng(9) });
      const paddle = { x: side * 1.6, y: 0.25, vx: 0, vy: 0 };
      const ball = { x: paddle.x, y: 0.3, vx: 0, vy: 0, spin: 0 };
      let pressedAt = -1;
      const dt = 1 / 60;
      for (let t = 0; t < 3 && pressedAt < 0; t += dt) {
        const inp = updateAI(ai, { ball, paddle, side, phase: 'serve', isServer: true, ballInPlay: false, dt });
        movePaddle(paddle, side, inp.moveX, inp.moveY, dt);
        if (inp.shotPressed) {
          pressedAt = t;
          assert.ok(['block', 'drive', 'topspin', 'chop', 'smash'].indexOf(inp.shotPressed) >= 0);
        }
      }
      assert.ok(pressedAt >= 0.6, level + ' sacou cedo demais: ' + pressedAt);
      assert.ok(pressedAt <= 1.6, level + ' demorou para sacar: ' + pressedAt);
      // Raquete atrás da linha de fundo do próprio lado
      assert.ok(paddle.x * side > 1.37);
    }
  }
});

test('IA recebedora no saque não aperta golpe e volta para a posição de espera', () => {
  const ai = createAI({ level: 'normal', rng: makeRng(3) });
  const side = -1;
  const paddle = { x: -1.0, y: 0.8, vx: 0, vy: 0 };
  const ball = { x: 1.6, y: 0.3, vx: 0, vy: 0, spin: 0 };
  const dt = 1 / 60;
  for (let t = 0; t < 2; t += dt) {
    const inp = updateAI(ai, { ball, paddle, side, phase: 'serve', isServer: false, ballInPlay: false, dt });
    assert.equal(inp.shotPressed, null);
    movePaddle(paddle, side, inp.moveX, inp.moveY, dt);
  }
  assert.ok(Math.abs(paddle.x - side * 1.75) < 0.1);
  assert.ok(paddle.x >= PADDLE_ZONE.xMin && paddle.x <= PADDLE_ZONE.xMax);
});

test('IA: formato PlayerInput e níveis', () => {
  assert.ok(AI_LEVELS.easy && AI_LEVELS.normal && AI_LEVELS.hard);
  const ai = createAI();
  assert.equal(ai.level, 'normal');
  assert.equal(createAI({ level: 'xyz' }).level, 'normal');
  const inp = updateAI(ai, {
    ball: { x: 0, y: 0.3, vx: -5, vy: 0, spin: 0 }, paddle: { x: 1.7, y: 0.2, vx: 0, vy: 0 },
    side: 1, phase: 'rally', isServer: false, ballInPlay: true, dt: 1 / 60
  });
  for (const k of ['connected', 'source', 'moveX', 'moveY', 'aimX', 'aimY', 'shot', 'shotPressed', 'pausePressed']) {
    assert.ok(k in inp, 'campo ' + k);
  }
  assert.equal(inp.pausePressed, false);
});
