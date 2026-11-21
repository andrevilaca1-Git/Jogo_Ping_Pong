import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createInputManager, XBOX, applyDeadzone } from '../src/input.js';

function makePad(index) {
  const buttons = [];
  for (let i = 0; i < 17; i++) buttons.push({ pressed: false, value: 0 });
  return { index, connected: true, mapping: 'standard', buttons, axes: [0, 0, 0, 0] };
}
function press(pad, b, on) {
  if (on === undefined) on = true;
  pad.buttons[b] = { pressed: on, value: on ? 1 : 0 };
}

function makeKeyTarget() {
  const listeners = {};
  return {
    addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
    removeEventListener() {},
    fire(type, ev) { (listeners[type] || []).forEach((fn) => fn(Object.assign({ preventDefault() {} }, ev))); },
    down(code, keyCode, extra) { this.fire('keydown', Object.assign({ code, keyCode }, extra || {})); },
    up(code, keyCode) { this.fire('keyup', { code, keyCode }); }
  };
}

function setup(pads) {
  const list = { pads };
  const kt = makeKeyTarget();
  const mgr = createInputManager({ getGamepads: () => list.pads, keyTarget: kt });
  return { mgr, kt, list };
}

test('XBOX mapping constants', () => {
  assert.equal(XBOX.A, 0);
  assert.equal(XBOX.RT, 7);
  assert.equal(XBOX.MENU, 9);
  assert.equal(XBOX.RIGHT, 15);
});

test('deadzone radial com reescala', () => {
  assert.deepEqual(applyDeadzone(0.1, 0.1), { x: 0, y: 0 });
  const r = applyDeadzone(1, 0);
  assert.equal(r.x, 1);
  const half = applyDeadzone(0.59, 0);
  assert.ok(Math.abs(half.x - 0.5) < 0.01);
  // Diagonal abaixo da deadzone radial (0.12,0.12 -> mag 0.17)
  assert.deepEqual(applyDeadzone(0.12, 0.12), { x: 0, y: 0 });

  const pad = makePad(0);
  const { mgr } = setup([pad]);
  pad.axes = [0.14, -0.1, 0, 0];
  let p = mgr.poll(0).players[0];
  assert.equal(p.moveX, 0);
  assert.equal(p.moveY, 0);
  pad.axes = [0, -1, 0.5, 0];
  p = mgr.poll(16).players[0];
  assert.equal(p.moveY, 1, 'stick para cima = moveY +');
  assert.equal(p.moveX, 0);
  assert.ok(p.aimX > 0.3 && p.aimX < 0.5);
});

test('D-pad move', () => {
  const pad = makePad(0);
  const { mgr } = setup([pad]);
  press(pad, XBOX.LEFT);
  press(pad, XBOX.DOWN);
  const p = mgr.poll(0).players[0];
  assert.equal(p.moveX, -1);
  assert.equal(p.moveY, -1);
});

test('bordas: shotPressed só no poll em que foi pressionado', () => {
  const pad = makePad(0);
  const { mgr } = setup([pad]);
  mgr.poll(0);
  press(pad, XBOX.A);
  let p = mgr.poll(16).players[0];
  assert.equal(p.shotPressed, 'drive');
  assert.equal(p.shot, 'drive');
  p = mgr.poll(32).players[0];
  assert.equal(p.shotPressed, null);
  assert.equal(p.shot, 'drive');
  press(pad, XBOX.A, false);
  p = mgr.poll(48).players[0];
  assert.equal(p.shot, null);
  press(pad, XBOX.MENU);
  p = mgr.poll(64).players[0];
  assert.equal(p.pausePressed, true);
  p = mgr.poll(80).players[0];
  assert.equal(p.pausePressed, false);
});

test('botão segurado ao conectar não gera borda falsa', () => {
  const pad = makePad(0);
  press(pad, XBOX.A);
  const { mgr } = setup([pad]);
  const out = mgr.poll(0);
  assert.equal(out.players[0].shotPressed, null);
  assert.equal(out.menu.confirm, false);
});

test('prioridade de golpe smash > topspin > chop > drive e RT analógico', () => {
  const pad = makePad(0);
  const { mgr } = setup([pad]);
  mgr.poll(0);
  press(pad, XBOX.A); press(pad, XBOX.B);
  let p = mgr.poll(1).players[0];
  assert.equal(p.shot, 'chop');
  assert.equal(p.shotPressed, 'chop');
  press(pad, XBOX.X);
  p = mgr.poll(2).players[0];
  assert.equal(p.shot, 'topspin');
  assert.equal(p.shotPressed, 'topspin');
  pad.buttons[XBOX.RT] = { pressed: true, value: 0.3 };
  p = mgr.poll(3).players[0];
  assert.equal(p.shot, 'topspin', 'RT abaixo de 0.5 não conta');
  pad.buttons[XBOX.RT] = { pressed: true, value: 0.8 };
  p = mgr.poll(4).players[0];
  assert.equal(p.shot, 'smash');
  assert.equal(p.shotPressed, 'smash');
});

test('atribuição estável, buracos/null e reconexão', () => {
  const a = makePad(0);
  const b = makePad(2);
  const { mgr, list } = setup([null, undefined, null]);
  let out = mgr.poll(0);
  assert.deepEqual(mgr.assignment, [null, null]);
  assert.equal(out.players[0].connected, false);
  assert.equal(out.players[0].source, 'keyboard');

  list.pads = [null, null, b]; // primeiro conectado: índice 2
  mgr.poll(1);
  assert.deepEqual(mgr.assignment, [2, null]);
  list.pads = [a, null, b];
  out = mgr.poll(2);
  assert.deepEqual(mgr.assignment, [2, 0], 'segundo conectado = Jogador 2');
  assert.equal(out.players[1].source, 'gamepad');
  assert.equal(out.players[1].gamepadIndex, 0);

  // Jogador 1 desconecta: J2 permanece; J1 volta ao teclado.
  list.pads = [a, null, { index: 2, connected: false, buttons: [], axes: [] }];
  out = mgr.poll(3);
  assert.deepEqual(mgr.assignment, [null, 0]);
  assert.equal(out.players[0].connected, false);
  assert.equal(out.players[0].source, 'keyboard');
  assert.equal(out.players[1].connected, true);

  // Reconecta em outro índice: ocupa o slot livre (J1).
  const c = makePad(1);
  list.pads = [a, c];
  mgr.poll(4);
  assert.deepEqual(mgr.assignment, [1, 0]);
  // Botões do controle 1 controlam o J1.
  press(c, XBOX.X);
  out = mgr.poll(5);
  assert.equal(out.players[0].shotPressed, 'topspin');
  assert.equal(out.players[1].shotPressed, null);
});

test('teclado J1 (WASD+FGHT+Esc) e J2 (setas+KLJI+P)', () => {
  const { mgr, kt } = setup([]);
  kt.down('KeyD', 68); kt.down('KeyW', 87);
  kt.down('KeyT', 84);
  kt.down('ArrowLeft', 37);
  kt.down('KeyL', 76);
  let out = mgr.poll(0);
  assert.equal(out.players[0].moveX, 1);
  assert.equal(out.players[0].moveY, 1);
  assert.equal(out.players[0].shotPressed, 'smash');
  assert.equal(out.players[0].connected, false);
  assert.equal(out.players[1].moveX, -1);
  assert.equal(out.players[1].shot, 'topspin');
  out = mgr.poll(16);
  assert.equal(out.players[0].shotPressed, null);
  assert.equal(out.players[0].shot, 'smash');
  kt.up('KeyT', 84); kt.up('KeyD', 68);
  // Apenas keyCode (TV sem event.code)
  kt.down('', 72); // H = chop
  kt.down(undefined, 80); // P = pausa J2
  kt.down('Escape', 27);
  out = mgr.poll(32);
  assert.equal(out.players[0].moveX, 0);
  assert.equal(out.players[0].shotPressed, 'chop');
  assert.equal(out.players[1].pausePressed, true);
  assert.equal(out.players[0].pausePressed, true);
  // keydown repetido (auto-repeat) não gera nova borda de golpe
  kt.down('KeyH', 72, { repeat: true });
  out = mgr.poll(48);
  assert.equal(out.players[0].shotPressed, null);
});

test('teclado funciona junto com gamepad e golpes não se perdem entre polls', () => {
  const pad = makePad(0);
  const { mgr, kt } = setup([pad]);
  mgr.poll(0);
  kt.down('KeyF', 70); kt.up('KeyF', 70); // apertou e soltou antes do poll
  const p = mgr.poll(16).players[0];
  assert.equal(p.source, 'gamepad');
  assert.equal(p.shotPressed, 'drive');
});

test('menu: remoto Samsung (keyCodes) e teclado', () => {
  const { mgr, kt } = setup([]);
  kt.down(undefined, 38);
  let m = mgr.poll(0).menu;
  assert.equal(m.up, true);
  assert.equal(m.down, false);
  m = mgr.poll(16).menu;
  assert.equal(m.up, false);
  kt.up(undefined, 38);
  kt.down(undefined, 13);
  m = mgr.poll(32).menu;
  assert.equal(m.confirm, true);
  kt.up(undefined, 13);
  kt.down(undefined, 10009);
  m = mgr.poll(48).menu;
  assert.equal(m.back, true);
  kt.up(undefined, 10009);
  kt.down(undefined, 8);
  assert.equal(mgr.poll(64).menu.back, true);
  kt.up(undefined, 8);
  kt.down('Escape', 27);
  assert.equal(mgr.poll(80).menu.back, true);
  kt.up('Escape', 27);
  kt.down(undefined, 39); kt.down(undefined, 40); kt.down(undefined, 37);
  m = mgr.poll(96).menu;
  assert.equal(m.right, true);
  assert.equal(m.down, true);
  assert.equal(m.left, true);
  // repetição do remoto (keydown repetido) conta para direções
  kt.down(undefined, 40, { repeat: true });
  assert.equal(mgr.poll(112).menu.down, true);
});

test('menu: agrega todos os controles (A confirma, B volta)', () => {
  const a = makePad(0);
  const b = makePad(1);
  const { mgr } = setup([a, b]);
  mgr.poll(0);
  press(b, XBOX.A);
  let m = mgr.poll(16).menu;
  assert.equal(m.confirm, true);
  m = mgr.poll(32).menu;
  assert.equal(m.confirm, false);
  press(a, XBOX.B);
  m = mgr.poll(48).menu;
  assert.equal(m.back, true);
});

test('menu: repetição automática ao segurar direcional (0.45 s, depois 0.15 s)', () => {
  const pad = makePad(0);
  const { mgr } = setup([pad]);
  mgr.poll(0);
  press(pad, XBOX.DOWN);
  const fired = [];
  for (let t = 100; t <= 1000; t += 10) {
    if (mgr.poll(t).menu.down) fired.push(t);
  }
  assert.deepEqual(fired, [100, 550, 700, 850, 1000]);
  press(pad, XBOX.DOWN, false);
  assert.equal(mgr.poll(1010).menu.down, false);
  // Stick analógico também navega e repete
  pad.axes = [0.9, 0, 0, 0];
  const firedR = [];
  for (let t = 2000; t <= 2500; t += 10) {
    if (mgr.poll(t).menu.right) firedR.push(t);
  }
  assert.deepEqual(firedR, [2000, 2450]);
});

test('rumble usa vibrationActuator.playEffect com proteção', () => {
  const pad = makePad(0);
  const calls = [];
  pad.vibrationActuator = {
    playEffect(type, params) { calls.push([type, params]); return Promise.reject(new Error('x')); }
  };
  const bad = makePad(1);
  bad.vibrationActuator = { playEffect() { throw new Error('boom'); } };
  const { mgr } = setup([pad, bad]);
  mgr.poll(0);
  assert.equal(mgr.rumble(0, 0.7, 120), true);
  assert.equal(calls[0][0], 'dual-rumble');
  assert.equal(calls[0][1].duration, 120);
  assert.equal(calls[0][1].weakMagnitude, 0.7);
  assert.doesNotThrow(() => mgr.rumble(1, 1, 50));
  // Sem gamepad: retorna false, sem erro
  const { mgr: m2 } = setup([]);
  m2.poll(0);
  assert.equal(m2.rumble(0, 1, 100), false);
});

test('sem keyTarget e sem gamepads: não quebra', () => {
  const mgr = createInputManager({ getGamepads: () => null, keyTarget: null });
  const out = mgr.poll();
  assert.equal(out.players.length, 2);
  assert.equal(out.players[0].connected, false);
  assert.equal(out.players[0].moveX, 0);
  const mgr2 = createInputManager({ getGamepads: () => { throw new Error('x'); } });
  assert.doesNotThrow(() => mgr2.poll(0));
});

test('regressão: B do controle é back no menu mas não systemBack; VIEW e Voltar do remoto são systemBack', () => {
  const a = makePad(0);
  const { mgr, kt } = setup([a]);
  mgr.poll(0);
  press(a, XBOX.B);
  let m = mgr.poll(16).menu;
  assert.equal(m.back, true);
  assert.equal(m.systemBack, false);
  press(a, XBOX.B, false);
  mgr.poll(32);
  press(a, XBOX.VIEW);
  m = mgr.poll(48).menu;
  assert.equal(m.back, true);
  assert.equal(m.systemBack, true);
  press(a, XBOX.VIEW, false);
  mgr.poll(64);
  kt.down(undefined, 10009);
  m = mgr.poll(80).menu;
  assert.equal(m.back, true);
  assert.equal(m.systemBack, true);
});
