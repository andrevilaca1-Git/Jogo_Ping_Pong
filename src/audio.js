// Sons sintetizados com WebAudio (sem arquivos). No-op seguro no Node / sem AudioContext.

function getCtor(opts) {
  if (opts && opts.AudioContext) return opts.AudioContext;
  if (typeof window !== 'undefined' && window) {
    return window.AudioContext || window.webkitAudioContext || null;
  }
  if (typeof globalThis !== 'undefined' && globalThis.AudioContext) return globalThis.AudioContext;
  return null;
}

function clamp01(v) {
  v = typeof v === 'number' && isFinite(v) ? v : 0.5;
  return v < 0 ? 0 : (v > 1 ? 1 : v);
}

export function createAudio(opts) {
  const Ctor = getCtor(opts);
  let ctx = null;
  let master = null;
  let noiseBuf = null;
  let enabled = true;
  let failed = false;

  function ensure() {
    if (ctx || failed) return ctx;
    if (!Ctor) { failed = true; return null; }
    try {
      ctx = new Ctor();
      master = ctx.createGain();
      master.gain.value = 0.6;
      master.connect(ctx.destination);
    } catch (e) {
      failed = true;
      ctx = null;
    }
    return ctx;
  }

  function noise() {
    if (noiseBuf) return noiseBuf;
    const len = Math.floor(ctx.sampleRate * 0.25);
    noiseBuf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = noiseBuf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    return noiseBuf;
  }

  // Envelope de ganho: ataque rápido e decaimento exponencial.
  function env(t0, peak, attack, decay) {
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), t0 + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + attack + decay);
    g.connect(master);
    return g;
  }

  function tone(type, freq, t0, peak, attack, decay, freqEnd) {
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(freq, t0);
    if (freqEnd) o.frequency.exponentialRampToValueAtTime(freqEnd, t0 + attack + decay);
    o.connect(env(t0, peak, attack, decay));
    o.start(t0);
    o.stop(t0 + attack + decay + 0.05);
  }

  function burst(t0, peak, decay, filterType, freq, q) {
    const s = ctx.createBufferSource();
    s.buffer = noise();
    const f = ctx.createBiquadFilter();
    f.type = filterType;
    f.frequency.value = freq;
    f.Q.value = q || 1;
    s.connect(f);
    f.connect(env(t0, peak, 0.002, decay));
    s.start(t0);
    s.stop(t0 + decay + 0.05);
  }

  const sounds = {
    hit: function (t, o) {
      const p = clamp01(o.power);
      // Estalo de borracha/madeira: ruído filtrado + "toc" tonal.
      burst(t, 0.35 + 0.5 * p, 0.03 + 0.02 * p, 'bandpass', 1500 + 1500 * p, 1.2);
      tone('triangle', 520 + 380 * p, t, 0.3 + 0.4 * p, 0.002, 0.06, 260 + 200 * p);
      if (p > 0.75) burst(t, 0.3 * p, 0.05, 'lowpass', 900, 0.7); // smash: corpo extra
    },
    serve: function (t) {
      burst(t, 0.35, 0.03, 'bandpass', 2000, 1.2);
      tone('triangle', 640, t, 0.3, 0.002, 0.05, 380);
    },
    bounce: function (t, o) {
      const p = clamp01(o.power === undefined ? 0.6 : o.power);
      tone('sine', 2600 + 600 * p, t, 0.18 + 0.2 * p, 0.001, 0.035, 1800);
      burst(t, 0.12 + 0.12 * p, 0.015, 'highpass', 3500, 0.8);
    },
    net: function (t) {
      tone('triangle', 190, t, 0.4, 0.003, 0.12, 110);
      burst(t, 0.25, 0.08, 'lowpass', 700, 0.8);
    },
    menu: function (t) {
      tone('square', 880, t, 0.12, 0.003, 0.05, 1100);
    },
    score: function (t) {
      const notes = [659.25, 783.99, 1046.5]; // E5 G5 C6
      for (let i = 0; i < notes.length; i++) {
        tone('triangle', notes[i], t + i * 0.08, 0.25, 0.005, 0.18);
      }
    },
    win: function (t) {
      const seq = [
        [523.25, 0], [659.25, 0.12], [783.99, 0.24], [1046.5, 0.36]
      ];
      for (let i = 0; i < seq.length; i++) {
        tone('sawtooth', seq[i][0], t + seq[i][1], 0.12, 0.01, 0.16);
        tone('triangle', seq[i][0], t + seq[i][1], 0.18, 0.01, 0.2);
      }
      const chord = [523.25, 659.25, 783.99, 1046.5];
      for (let j = 0; j < chord.length; j++) {
        tone('triangle', chord[j], t + 0.52, 0.16, 0.02, 0.9);
        tone('sawtooth', chord[j] / 2, t + 0.52, 0.05, 0.02, 0.8);
      }
    }
  };

  function play(name, o) {
    if (!enabled) return;
    const fn = sounds[name];
    if (!fn) return;
    if (!ensure()) return;
    try {
      if (ctx.state === 'suspended' && typeof ctx.resume === 'function') {
        const r = ctx.resume();
        if (r && typeof r.catch === 'function') r.catch(function () {});
      }
      fn(ctx.currentTime + 0.005, o || {});
    } catch (e) { /* ignora falhas de áudio */ }
  }

  function setEnabled(v) {
    enabled = !!v;
  }

  function unlock() {
    if (!ensure()) return;
    try {
      if (typeof ctx.resume === 'function') {
        const r = ctx.resume();
        if (r && typeof r.catch === 'function') r.catch(function () {});
      }
      // Toca um buffer silencioso (necessário em alguns navegadores/TVs).
      const b = ctx.createBuffer(1, 1, ctx.sampleRate || 22050);
      const s = ctx.createBufferSource();
      s.buffer = b;
      s.connect(ctx.destination);
      s.start(0);
    } catch (e) { /* ignora */ }
  }

  return {
    play: play,
    setEnabled: setEnabled,
    unlock: unlock,
    get enabled() { return enabled; }
  };
}
