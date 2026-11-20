// Entrada: controles de Xbox (Gamepad API, mapeamento "standard"), teclado e
// controle remoto Samsung. Não toca o DOM no import; roda no Node para testes.

export const XBOX = {
  A: 0, B: 1, X: 2, Y: 3, LB: 4, RB: 5, LT: 6, RT: 7, VIEW: 8, MENU: 9, LS: 10, RS: 11,
  UP: 12, DOWN: 13, LEFT: 14, RIGHT: 15
};

export const DEADZONE = 0.18;
export const TRIGGER_THRESHOLD = 0.5;
export const MENU_REPEAT_DELAY = 450; // ms até começar a repetir
export const MENU_REPEAT_RATE = 150;  // ms entre repetições
const MENU_STICK_THRESHOLD = 0.5;

// Prioridade do golpe segurado/pressionado: smash > topspin > chop > drive.
const SHOT_PRIORITY = ['smash', 'topspin', 'chop', 'drive'];

// keyCode -> nome (event.code) para navegadores de TV que não preenchem event.code.
const KEYCODE_TO_CODE = {
  8: 'Backspace', 13: 'Enter', 27: 'Escape', 32: 'Space',
  37: 'ArrowLeft', 38: 'ArrowUp', 39: 'ArrowRight', 40: 'ArrowDown',
  65: 'KeyA', 68: 'KeyD', 70: 'KeyF', 71: 'KeyG', 72: 'KeyH', 73: 'KeyI',
  74: 'KeyJ', 75: 'KeyK', 76: 'KeyL', 80: 'KeyP', 83: 'KeyS', 84: 'KeyT', 87: 'KeyW',
  10009: 'TizenBack'
};

// Teclado por jogador.
const KEYMAP = [
  { up: 'KeyW', down: 'KeyS', left: 'KeyA', right: 'KeyD',
    drive: 'KeyF', topspin: 'KeyG', chop: 'KeyH', smash: 'KeyT', pause: 'Escape' },
  { up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight',
    drive: 'KeyK', topspin: 'KeyL', chop: 'KeyJ', smash: 'KeyI', pause: 'KeyP' }
];

// Teclas de menu (teclado + remoto Samsung).
const MENU_KEYS = {
  ArrowUp: 'up', KeyW: 'up',
  ArrowDown: 'down', KeyS: 'down',
  ArrowLeft: 'left', KeyA: 'left',
  ArrowRight: 'right', KeyD: 'right',
  Enter: 'confirm', NumpadEnter: 'confirm', Space: 'confirm',
  Escape: 'back', Backspace: 'back', TizenBack: 'back', BrowserBack: 'back', GoBack: 'back'
};

const MENU_DIRS = ['up', 'down', 'left', 'right'];

function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

function num(v) { return typeof v === 'number' && isFinite(v) ? v : 0; }

// Deadzone radial com reescala: magnitude < dz -> 0; senão (mag-dz)/(1-dz).
export function applyDeadzone(x, y, dz) {
  if (dz === undefined) dz = DEADZONE;
  x = num(x); y = num(y);
  const mag = Math.sqrt(x * x + y * y);
  if (mag < dz || mag === 0) return { x: 0, y: 0 };
  const m = Math.min(1, mag);
  const scale = ((m - dz) / (1 - dz)) / mag;
  return { x: clamp(x * scale, -1, 1), y: clamp(y * scale, -1, 1) };
}

function buttonPressed(pad, i) {
  const b = pad && pad.buttons ? pad.buttons[i] : null;
  if (b === null || b === undefined) return false;
  if (typeof b === 'number') return b > 0.5;
  return !!b.pressed;
}

function buttonValue(pad, i) {
  const b = pad && pad.buttons ? pad.buttons[i] : null;
  if (b === null || b === undefined) return 0;
  if (typeof b === 'number') return b;
  if (typeof b.value === 'number') return b.value;
  return b.pressed ? 1 : 0;
}

// Lê o estado bruto de um gamepad em um formato simples.
function readPad(pad) {
  const axes = pad.axes || [];
  const ls = applyDeadzone(axes[0], axes[1]);
  const rs = applyDeadzone(axes[2], axes[3]);
  const st = {
    lx: ls.x, ly: -ls.y, // tela: cima +
    rx: rs.x, ry: -rs.y,
    rawLx: num(axes[0]), rawLy: -num(axes[1]),
    up: buttonPressed(pad, XBOX.UP),
    down: buttonPressed(pad, XBOX.DOWN),
    left: buttonPressed(pad, XBOX.LEFT),
    right: buttonPressed(pad, XBOX.RIGHT),
    drive: buttonPressed(pad, XBOX.A),
    chop: buttonPressed(pad, XBOX.B),
    topspin: buttonPressed(pad, XBOX.X),
    smash: buttonValue(pad, XBOX.RT) > TRIGGER_THRESHOLD,
    pause: buttonPressed(pad, XBOX.MENU),
    confirm: buttonPressed(pad, XBOX.A),
    back: buttonPressed(pad, XBOX.B) || buttonPressed(pad, XBOX.VIEW)
  };
  return st;
}

function emptyPadState() {
  return { lx: 0, ly: 0, rx: 0, ry: 0, rawLx: 0, rawLy: 0, up: false, down: false, left: false,
    right: false, drive: false, chop: false, topspin: false, smash: false, pause: false,
    confirm: false, back: false };
}

function pickShot(flags) {
  for (let i = 0; i < SHOT_PRIORITY.length; i++) {
    if (flags[SHOT_PRIORITY[i]]) return SHOT_PRIORITY[i];
  }
  return null;
}

function defaultGetGamepads() {
  if (typeof navigator !== 'undefined' && navigator && typeof navigator.getGamepads === 'function') {
    try { return navigator.getGamepads(); } catch (e) { return []; }
  }
  return [];
}

function defaultKeyTarget() {
  if (typeof window !== 'undefined' && window && typeof window.addEventListener === 'function') {
    return window;
  }
  return null;
}

function defaultNow() {
  if (typeof performance !== 'undefined' && performance && typeof performance.now === 'function') {
    return performance.now();
  }
  return Date.now();
}

function keyName(e) {
  if (!e) return null;
  if (e.code && typeof e.code === 'string' && e.code !== 'Unidentified') return e.code;
  const kc = e.keyCode || e.which;
  if (kc && KEYCODE_TO_CODE[kc]) return KEYCODE_TO_CODE[kc];
  if (e.key === 'Enter') return 'Enter';
  if (e.key === 'Escape' || e.key === 'Esc') return 'Escape';
  if (e.key === 'Backspace') return 'Backspace';
  if (e.key === 'XF86Back') return 'TizenBack';
  return null;
}

export function createInputManager(opts) {
  opts = opts || {};
  const getGamepads = opts.getGamepads || defaultGetGamepads;
  const keyTarget = opts.keyTarget !== undefined ? opts.keyTarget : defaultKeyTarget();

  // assignment[slot] = índice do gamepad ou null.
  const assignment = [null, null];
  const prevPad = {};      // índice -> estado anterior (para bordas)
  const padObjects = {};   // índice -> último objeto Gamepad visto
  const menuRepeat = {};   // índice -> { up:{next}, ... }

  const keysDown = {};
  let keyEdges = {};       // teclas pressionadas desde o último poll
  let menuKeyEdges = { up: false, down: false, left: false, right: false, confirm: false, back: false };

  function onKeyDown(e) {
    const k = keyName(e);
    if (!k) return;
    const wasDown = !!keysDown[k];
    keysDown[k] = true;
    if (!wasDown && !e.repeat) keyEdges[k] = true;
    const m = MENU_KEYS[k];
    // No menu, a repetição automática do SO/remoto também conta para as direções.
    if (m && (!wasDown || MENU_DIRS.indexOf(m) >= 0)) menuKeyEdges[m] = true;
    if (m || k.indexOf('Arrow') === 0 || k === 'Space' || k === 'Backspace' || k === 'TizenBack') {
      // Evita rolagem da página / saída do app em TVs.
      if (typeof e.preventDefault === 'function') {
        try { e.preventDefault(); } catch (err) { /* ignora */ }
      }
    }
  }

  function onKeyUp(e) {
    const k = keyName(e);
    if (!k) return;
    keysDown[k] = false;
  }

  function onBlur() {
    for (const k in keysDown) keysDown[k] = false;
  }

  if (keyTarget && typeof keyTarget.addEventListener === 'function') {
    keyTarget.addEventListener('keydown', onKeyDown);
    keyTarget.addEventListener('keyup', onKeyUp);
    try { keyTarget.addEventListener('blur', onBlur); } catch (e) { /* ignora */ }
  }

  function listPads() {
    let list;
    try { list = getGamepads(); } catch (e) { list = null; }
    const out = [];
    if (!list) return out;
    const n = list.length || 0;
    for (let i = 0; i < n; i++) {
      const p = list[i];
      if (!p || p.connected === false) continue;
      const idx = typeof p.index === 'number' ? p.index : i;
      out.push({ index: idx, pad: p });
    }
    out.sort(function (a, b) { return a.index - b.index; });
    return out;
  }

  function updateAssignment(pads) {
    const present = {};
    for (let i = 0; i < pads.length; i++) present[pads[i].index] = true;
    // Remove desconectados.
    for (let s = 0; s < assignment.length; s++) {
      if (assignment[s] !== null && !present[assignment[s]]) {
        delete prevPad[assignment[s]];
        delete menuRepeat[assignment[s]];
        assignment[s] = null;
      }
    }
    // Novos controles preenchem o primeiro slot livre (ordem de conexão).
    for (let i = 0; i < pads.length; i++) {
      const idx = pads[i].index;
      if (assignment.indexOf(idx) >= 0) continue;
      const free = assignment.indexOf(null);
      if (free < 0) break;
      assignment[free] = idx;
    }
  }

  function keyboardPlayer(p) {
    const km = KEYMAP[p];
    const held = {};
    const edge = {};
    for (let i = 0; i < SHOT_PRIORITY.length; i++) {
      const t = SHOT_PRIORITY[i];
      held[t] = !!keysDown[km[t]];
      edge[t] = !!keyEdges[km[t]];
    }
    return {
      moveX: (keysDown[km.right] ? 1 : 0) - (keysDown[km.left] ? 1 : 0),
      moveY: (keysDown[km.up] ? 1 : 0) - (keysDown[km.down] ? 1 : 0),
      shot: pickShot(held),
      shotPressed: pickShot(edge),
      pausePressed: !!keyEdges[km.pause]
    };
  }

  function processMenuDir(idx, dir, held, now, out) {
    let r = menuRepeat[idx];
    if (!r) { r = {}; menuRepeat[idx] = r; }
    if (!held) { r[dir] = null; return; }
    if (!r[dir]) {
      r[dir] = { next: now + MENU_REPEAT_DELAY };
      out[dir] = true;
    } else if (now >= r[dir].next) {
      out[dir] = true;
      r[dir].next = now + MENU_REPEAT_RATE;
    }
  }

  function poll(nowMs) {
    const now = typeof nowMs === 'number' ? nowMs : defaultNow();
    const pads = listPads();
    updateAssignment(pads);

    const states = {};
    for (let i = 0; i < pads.length; i++) {
      padObjects[pads[i].index] = pads[i].pad;
      states[pads[i].index] = readPad(pads[i].pad);
    }

    const menu = { up: false, down: false, left: false, right: false, confirm: false, back: false };

    // Agrega todos os gamepads conectados no menu.
    for (let i = 0; i < pads.length; i++) {
      const idx = pads[i].index;
      const st = states[idx];
      const prev = prevPad[idx] || st; // 1ª leitura: sem borda falsa
      if (st.confirm && !prev.confirm) menu.confirm = true;
      if (st.back && !prev.back) menu.back = true;
      processMenuDir(idx, 'up', st.up || st.rawLy > MENU_STICK_THRESHOLD, now, menu);
      processMenuDir(idx, 'down', st.down || st.rawLy < -MENU_STICK_THRESHOLD, now, menu);
      processMenuDir(idx, 'left', st.left || st.rawLx < -MENU_STICK_THRESHOLD, now, menu);
      processMenuDir(idx, 'right', st.right || st.rawLx > MENU_STICK_THRESHOLD, now, menu);
    }
    for (const k in menuKeyEdges) if (menuKeyEdges[k]) menu[k] = true;

    const players = [];
    for (let p = 0; p < 2; p++) {
      const idx = assignment[p];
      const kb = keyboardPlayer(p);
      const hasPad = idx !== null && states[idx] !== undefined;
      const st = hasPad ? states[idx] : emptyPadState();
      const prev = hasPad ? (prevPad[idx] || st) : st;

      let mx = st.lx + (st.right ? 1 : 0) - (st.left ? 1 : 0) + kb.moveX;
      let my = st.ly + (st.up ? 1 : 0) - (st.down ? 1 : 0) + kb.moveY;
      mx = clamp(mx, -1, 1);
      my = clamp(my, -1, 1);

      const held = {};
      const edge = {};
      for (let i = 0; i < SHOT_PRIORITY.length; i++) {
        const t = SHOT_PRIORITY[i];
        held[t] = st[t];
        edge[t] = st[t] && !prev[t];
      }
      const padShot = pickShot(held);
      const padPressed = pickShot(edge);
      const shot = pickShot({
        smash: padShot === 'smash' || kb.shot === 'smash',
        topspin: padShot === 'topspin' || kb.shot === 'topspin',
        chop: padShot === 'chop' || kb.shot === 'chop',
        drive: padShot === 'drive' || kb.shot === 'drive'
      });
      const shotPressed = pickShot({
        smash: padPressed === 'smash' || kb.shotPressed === 'smash',
        topspin: padPressed === 'topspin' || kb.shotPressed === 'topspin',
        chop: padPressed === 'chop' || kb.shotPressed === 'chop',
        drive: padPressed === 'drive' || kb.shotPressed === 'drive'
      });

      players.push({
        connected: hasPad,
        source: hasPad ? 'gamepad' : (keyTarget ? 'keyboard' : 'none'),
        gamepadIndex: hasPad ? idx : null,
        moveX: mx,
        moveY: my,
        aimX: st.rx,
        aimY: st.ry,
        shot: shot,
        shotPressed: shotPressed,
        pausePressed: (st.pause && !prev.pause) || kb.pausePressed
      });
    }

    // Guarda estado anterior.
    for (const k in prevPad) if (states[k] === undefined) delete prevPad[k];
    for (const k in states) prevPad[k] = states[k];
    keyEdges = {};
    menuKeyEdges = { up: false, down: false, left: false, right: false, confirm: false, back: false };

    return { players: players, menu: menu };
  }

  function rumble(playerIndex, strength, ms) {
    const idx = assignment[playerIndex];
    if (idx === null || idx === undefined) return false;
    const pad = padObjects[idx];
    if (!pad) return false;
    const s = clamp(num(strength), 0, 1);
    const dur = Math.max(0, num(ms)) || 100;
    try {
      const act = pad.vibrationActuator;
      if (act && typeof act.playEffect === 'function') {
        const r = act.playEffect('dual-rumble', {
          startDelay: 0, duration: dur, weakMagnitude: s, strongMagnitude: s * 0.8
        });
        if (r && typeof r.catch === 'function') r.catch(function () {});
        return true;
      }
      const h = pad.hapticActuators && pad.hapticActuators[0];
      if (h && typeof h.pulse === 'function') {
        const r2 = h.pulse(s, dur);
        if (r2 && typeof r2.catch === 'function') r2.catch(function () {});
        return true;
      }
    } catch (e) { /* ignora */ }
    return false;
  }

  function destroy() {
    if (keyTarget && typeof keyTarget.removeEventListener === 'function') {
      keyTarget.removeEventListener('keydown', onKeyDown);
      keyTarget.removeEventListener('keyup', onKeyUp);
      try { keyTarget.removeEventListener('blur', onBlur); } catch (e) { /* ignora */ }
    }
  }

  const manager = { poll: poll, rumble: rumble, destroy: destroy };
  Object.defineProperty(manager, 'assignment', {
    enumerable: true,
    get: function () { return assignment.slice(); }
  });
  return manager;
}
