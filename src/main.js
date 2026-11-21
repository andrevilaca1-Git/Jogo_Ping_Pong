// Bootstrap do navegador: canvas, input, áudio, loop principal.
import { createInputManager } from './input.js';
import { createAudio } from './audio.js';
import { createGame, updateGame, startMatch, togglePause } from './game.js';
import { createRenderer } from './render.js';

function getParams() {
  const out = {};
  const q = (window.location && window.location.search) || '';
  const parts = q.replace(/^\?/, '').split('&');
  for (let i = 0; i < parts.length; i++) {
    if (!parts[i]) continue;
    const kv = parts[i].split('=');
    out[decodeURIComponent(kv[0])] = kv.length > 1 ? decodeURIComponent(kv[1]) : '1';
  }
  return out;
}

function registerTizenKeys() {
  const t = window.tizen;
  if (!t || !t.tvinputdevice) return;
  const keys = ['MediaPlayPause', 'MediaPlay', 'MediaPause', 'MediaStop',
    'ColorF0Red', 'ColorF1Green', 'ColorF2Yellow', 'ColorF3Blue'];
  for (let i = 0; i < keys.length; i++) {
    try { t.tvinputdevice.registerKey(keys[i]); } catch (e) { /* tecla indisponível */ }
  }
}

function exitApp() {
  try {
    if (window.tizen && window.tizen.application) {
      window.tizen.application.getCurrentApplication().exit();
    }
  } catch (e) { /* fora do Tizen */ }
}

const NO_EDGES_MENU = { up: false, down: false, left: false, right: false, confirm: false, back: false, systemBack: false };

function stripEdges(p) {
  if (!p) return null;
  return {
    connected: p.connected, source: p.source, moveX: p.moveX, moveY: p.moveY,
    aimX: p.aimX, aimY: p.aimY, shot: p.shot, shotPressed: null, pausePressed: false
  };
}

function boot() {
  const params = getParams();
  const fast = Math.max(1, Math.min(50, parseInt(params.fast, 10) || 1));

  let canvas = document.getElementById('game');
  if (!canvas) {
    canvas = document.createElement('canvas');
    canvas.id = 'game';
    document.body.appendChild(canvas);
  }

  const input = createInputManager();
  const audio = createAudio();
  const game = createGame({
    audio: audio,
    rumble: function (p, s, ms) { try { input.rumble(p, s, ms); } catch (e) { /* ignore */ } }
  });
  const renderer = createRenderer(canvas);

  if (params.demo === '1' || params.demo === 'true') {
    const bo = parseInt(params.bestOf, 10);
    startMatch(game, {
      mode: 'cpu-vs-cpu',
      bestOf: bo === 3 || bo === 5 || bo === 7 ? bo : 3,
      difficulty: params.level || 'normal'
    });
  }

  function resize() {
    const w = window.innerWidth || document.documentElement.clientWidth || 1920;
    const h = window.innerHeight || document.documentElement.clientHeight || 1080;
    canvas.style.width = w + 'px';
    canvas.style.height = h + 'px';
    renderer.resize(w, h, window.devicePixelRatio || 1);
  }
  window.addEventListener('resize', resize);
  resize();

  registerTizenKeys();

  let audioUnlocked = false;
  function unlockAudio() {
    if (audioUnlocked) return;
    audioUnlocked = true;
    try { audio.unlock(); } catch (e) { /* ignore */ }
  }
  let mediaToggle = false;
  window.addEventListener('keydown', function (e) {
    unlockAudio();
    const code = e.keyCode;
    // Voltar do controle remoto Samsung: no menu principal sai do app; no resto o input trata.
    if (code === 10009) {
      try { e.preventDefault(); } catch (err) { /* ignore */ }
      if (game.screen === 'title' && game.menu.view === 'main') exitApp();
    }
    // Play/Pause do remoto (MediaPlayPause=10252, Play=415, Pause=19)
    if (code === 10252 || code === 415 || code === 19) mediaToggle = true;
  });
  window.addEventListener('pointerdown', unlockAudio);
  window.addEventListener('touchstart', unlockAudio);
  window.addEventListener('mousedown', unlockAudio);

  let last = 0;
  let polled = null;
  const info = { players: null, dt: 1 / 60 };

  function frame(ts) {
    let dt = last ? (ts - last) / 1000 : 1 / 60;
    last = ts;
    if (!(dt > 0)) dt = 1 / 60;
    if (dt > 0.1) dt = 0.1;

    polled = input.poll();
    const menu = polled.menu || NO_EDGES_MENU;
    const players = polled.players;
    if (!audioUnlocked && (menu.confirm || menu.up || menu.down ||
        (players[0] && players[0].shotPressed) || (players[1] && players[1].shotPressed))) {
      unlockAudio();
    }
    if (mediaToggle) {
      mediaToggle = false;
      togglePause(game);
    }

    updateGame(game, dt, players, menu);
    if (fast > 1) {
      // Simulação acelerada para testes: repete sem bordas de botões.
      const held = [stripEdges(players[0]), stripEdges(players[1])];
      for (let i = 1; i < fast; i++) updateGame(game, dt, held, NO_EDGES_MENU);
    }

    info.players = players;
    info.dt = dt;
    renderer.render(game, info);
    window.requestAnimationFrame(frame);
  }

  window.__pingpong = { game: game, input: input, audio: audio, renderer: renderer, params: params };
  window.requestAnimationFrame(frame);
}

if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
}
