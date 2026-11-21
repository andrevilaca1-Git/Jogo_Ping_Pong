// Mock de navigator.getGamepads injetado via page.addInitScript(mockGamepads, { count }).
// Expõe window.__mockPads para o teste controlar botões e sticks de controles de Xbox.
// Também mantém window.__frames (contador de requestAnimationFrame) para sincronizar o teste.
export function mockGamepads(opts) {
  var count = (opts && typeof opts.count === 'number') ? opts.count : 2;
  var NBUTTONS = 17;
  function now() { return (window.performance && performance.now) ? performance.now() : Date.now(); }
  function makePad(i) {
    var buttons = [];
    for (var b = 0; b < NBUTTONS; b++) buttons.push({ pressed: false, value: 0, touched: false });
    return {
      id: 'Xbox Wireless Controller (STANDARD GAMEPAD Vendor: 045e Product: 02fd)',
      index: i,
      connected: i < count,
      mapping: 'standard',
      buttons: buttons,
      axes: [0, 0, 0, 0],
      timestamp: now(),
      vibrationActuator: {
        type: 'dual-rumble',
        playEffect: function (type, params) {
          api.rumbles.push({ pad: i, type: type, params: params, t: now() });
          return Promise.resolve('complete');
        }
      }
    };
  }
  var pads = [makePad(0), makePad(1), makePad(2), makePad(3)];
  function touch(i) { pads[i].timestamp = now(); }
  var api = {
    pads: pads,
    rumbles: [],
    press: function (i, b, v) {
      var val = typeof v === 'number' ? v : 1;
      pads[i].buttons[b] = { pressed: val > 0.5 || (b !== 6 && b !== 7 && val > 0), value: val, touched: val > 0 };
      touch(i);
    },
    release: function (i, b) {
      pads[i].buttons[b] = { pressed: false, value: 0, touched: false };
      touch(i);
    },
    setAxes: function (i, a0, a1, a2, a3) {
      var ax = pads[i].axes;
      if (typeof a0 === 'number') ax[0] = a0;
      if (typeof a1 === 'number') ax[1] = a1;
      if (typeof a2 === 'number') ax[2] = a2;
      if (typeof a3 === 'number') ax[3] = a3;
      touch(i);
    },
    stick: function (i, x, y) { api.setAxes(i, x, y); },
    releaseAll: function (i) {
      for (var b = 0; b < NBUTTONS; b++) pads[i].buttons[b] = { pressed: false, value: 0, touched: false };
      pads[i].axes = [0, 0, 0, 0];
      touch(i);
    },
    connect: function (i) {
      pads[i].connected = true; touch(i);
      try { var e = new Event('gamepadconnected'); e.gamepad = pads[i]; window.dispatchEvent(e); } catch (err) { /* ok */ }
    },
    disconnect: function (i) {
      pads[i].connected = false; touch(i);
      try { var e = new Event('gamepaddisconnected'); e.gamepad = pads[i]; window.dispatchEvent(e); } catch (err) { /* ok */ }
    }
  };
  window.__mockPads = api;
  var getter = function () {
    var out = [];
    for (var i = 0; i < pads.length; i++) out.push(pads[i].connected ? pads[i] : null);
    return out;
  };
  try {
    Object.defineProperty(navigator, 'getGamepads', { value: getter, configurable: true, writable: true });
  } catch (e) {
    navigator.getGamepads = getter;
  }
  window.__frames = 0;
  function tick() { window.__frames++; window.requestAnimationFrame(tick); }
  window.requestAnimationFrame(tick);
}
