'use strict';
(() => {
  // ---------- settings ----------
  const NOTES = ['C', 'C♯', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'A♭', 'A', 'B♭', 'B'];
  const CHORDS = {
    fifth: { label: 'Fifth', iv: [0, 7, 12] },
    minor: { label: 'Minor', iv: [0, 3, 7] },
    sus:   { label: 'Sus',   iv: [0, 5, 7] },
    open:  { label: 'Open',  iv: [0, 7, 14] }
  };
  const NOISE_TYPES = { pink: 'Pink', brown: 'Brown' };
  const DIVS = { '0.5': '½ ×', '1': '1 ×', '2': '2 ×' };
  const FADERS = { drone: 'Drone', noise: 'Noise', pulse: 'Pulse', bright: 'Bright', space: 'Space', master: 'Master' };
  const DEFAULTS = {
    root: 2, chord: 'fifth', noiseType: 'pink', bpm: 90, div: 1,
    drone: 0.7, noise: 0.35, pulse: 0.4, bright: 0.45, space: 0.55, master: 0.75
  };
  const STORE = 'wild-resi-dance/v1';
  const BPM_MIN = 30, BPM_MAX = 200;

  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

  function loadSettings() {
    const s = Object.assign({}, DEFAULTS);
    try {
      const j = JSON.parse(localStorage.getItem(STORE) || '{}');
      for (const k of Object.keys(FADERS)) if (typeof j[k] === 'number' && isFinite(j[k])) s[k] = clamp(j[k], 0, 1);
      if (Number.isInteger(j.root)) s.root = ((j.root % 12) + 12) % 12;
      if (CHORDS[j.chord]) s.chord = j.chord;
      if (NOISE_TYPES[j.noiseType]) s.noiseType = j.noiseType;
      if (typeof j.bpm === 'number' && isFinite(j.bpm)) s.bpm = Math.round(clamp(j.bpm, BPM_MIN, BPM_MAX));
      if (DIVS[String(j.div)]) s.div = j.div;
    } catch (e) { /* storage unavailable */ }
    return s;
  }
  const S = loadSettings();
  let saveTimer = 0;
  function save() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      try { localStorage.setItem(STORE, JSON.stringify(S)); } catch (e) { /* ignore */ }
    }, 300);
  }

  // ---------- audio ----------
  let ctx = null;
  let A = null;              // node table
  let playing = false;
  let stopTimer = 0;
  let wakeLock = null;
  let routed = 'none';       // 'element' | 'direct'
  const outEl = document.getElementById('out');

  const midiHz = (m) => 440 * Math.pow(2, (m - 69) / 12);
  const expMap = (v, lo, hi) => lo * Math.pow(hi / lo, v);

  function ramp(param, value, tc = 0.06) {
    const t = ctx.currentTime;
    if (typeof param.cancelAndHoldAtTime === 'function') {
      param.cancelAndHoldAtTime(t);
    } else {
      param.cancelScheduledValues(t);
      param.setValueAtTime(param.value, t);
    }
    param.setTargetAtTime(value, t, tc);
  }

  function noiseBuffer(kind, seconds) {
    const len = Math.floor(ctx.sampleRate * seconds);
    const X = Math.floor(ctx.sampleRate * 0.25);   // overlap for a seamless loop
    const buf = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      const raw = new Float32Array(len + X);
      let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0, last = 0;
      for (let i = 0; i < len + X; i++) {
        const w = Math.random() * 2 - 1;
        let v;
        if (kind === 'pink') {
          b0 = 0.99886 * b0 + w * 0.0555179; b1 = 0.99332 * b1 + w * 0.0750759;
          b2 = 0.96900 * b2 + w * 0.1538520; b3 = 0.86650 * b3 + w * 0.3104856;
          b4 = 0.55000 * b4 + w * 0.5329522; b5 = -0.7616 * b5 - w * 0.0168980;
          v = b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362; b6 = w * 0.115926;
        } else {
          last = (last + 0.02 * w) / 1.02; v = last;
        }
        raw[i] = v;
      }
      // blend the tail into the head so the loop has no seam
      let peak = 0;
      for (let i = 0; i < len; i++) {
        let v = raw[i];
        if (i < X) { const g = i / X; v = Math.sqrt(g) * raw[i] + Math.sqrt(1 - g) * raw[len + i]; }
        d[i] = v;
        const a = Math.abs(v); if (a > peak) peak = a;
      }
      const k = 0.9 / (peak || 1);
      for (let i = 0; i < len; i++) d[i] *= k;
    }
    return buf;
  }

  function reverbImpulse(seconds) {
    const len = Math.floor(ctx.sampleRate * seconds);
    const buf = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      let lp = 0;
      for (let i = 0; i < len; i++) {
        const t = i / len;
        lp += 0.35 * ((Math.random() * 2 - 1) - lp); // darken
        const attack = Math.min(1, i / (ctx.sampleRate * 0.03));
        d[i] = lp * attack * Math.pow(1 - t, 2.4);
      }
    }
    return buf;
  }

  // a soft swell: quick raised-cosine rise, long gentle fall, few harmonics
  function pulseWave() {
    const H = 7, N = 2048, a = 0.14;
    const g = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      const t = i / N;
      g[i] = t < a ? 0.5 - 0.5 * Math.cos(Math.PI * t / a) : Math.exp(-(t - a) * 4.2);
    }
    const re = new Float32Array(H + 1), im = new Float32Array(H + 1);
    for (let n = 1; n <= H; n++) {
      let c = 0, s = 0;
      for (let i = 0; i < N; i++) {
        const ph = 2 * Math.PI * n * i / N;
        c += g[i] * Math.cos(ph); s += g[i] * Math.sin(ph);
      }
      re[n] = 2 * c / N; im[n] = 2 * s / N;
    }
    let lo = Infinity, hi = -Infinity;
    const shape = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      let v = 0;
      for (let n = 1; n <= H; n++) {
        const ph = 2 * Math.PI * n * i / N;
        v += re[n] * Math.cos(ph) + im[n] * Math.sin(ph);
      }
      shape[i] = v;
      if (v < lo) lo = v; if (v > hi) hi = v;
    }
    return { wave: ctx.createPeriodicWave(re, im, { disableNormalization: true }), lo, hi, shape };
  }

  function makePanner(pan) {
    if (typeof ctx.createStereoPanner === 'function') {
      const p = ctx.createStereoPanner(); p.pan.value = pan; return p;
    }
    return ctx.createGain();
  }

  function build() {
    const AC = window.AudioContext || window.webkitAudioContext;
    try { ctx = new AC({ latencyHint: 'playback' }); } catch (e) { ctx = new AC(); }
    try { if (navigator.audioSession) navigator.audioSession.type = 'playback'; } catch (e) { /* ignore */ }

    A = {};
    // output chain: master -> limiter -> soft clip -> fade -> out
    A.master = ctx.createGain();
    A.limiter = ctx.createDynamicsCompressor();
    A.limiter.threshold.value = -14; A.limiter.knee.value = 10; A.limiter.ratio.value = 12;
    A.limiter.attack.value = 0.008; A.limiter.release.value = 0.35;
    A.clip = ctx.createWaveShaper();
    const curve = new Float32Array(2049);
    for (let i = 0; i < curve.length; i++) { const x = (i / 1024) - 1; curve[i] = Math.tanh(1.2 * x) / Math.tanh(1.2); }
    A.clip.curve = curve; A.clip.oversample = '2x';
    A.fade = ctx.createGain(); A.fade.gain.value = 0;
    A.master.connect(A.limiter); A.limiter.connect(A.clip); A.clip.connect(A.fade);

    // voices sum -> pulse amp -> dry / reverb / delay
    A.voices = ctx.createGain();
    A.pulseAmp = ctx.createGain();
    A.voices.connect(A.pulseAmp);
    A.dry = ctx.createGain();
    A.pulseAmp.connect(A.dry); A.dry.connect(A.master);

    A.revSend = ctx.createGain();
    A.rev = ctx.createConvolver(); A.rev.buffer = reverbImpulse(4.5);
    A.revOut = ctx.createGain(); A.revOut.gain.value = 0.9;
    A.pulseAmp.connect(A.revSend); A.revSend.connect(A.rev); A.rev.connect(A.revOut); A.revOut.connect(A.master);

    A.dlySend = ctx.createGain();
    A.dly = ctx.createDelay(4);
    A.dlyFb = ctx.createGain(); A.dlyFb.gain.value = 0.42;
    A.dlyTone = ctx.createBiquadFilter(); A.dlyTone.type = 'lowpass'; A.dlyTone.frequency.value = 1800;
    A.pulseAmp.connect(A.dlySend); A.dlySend.connect(A.dly);
    A.dly.connect(A.dlyTone); A.dlyTone.connect(A.dlyFb); A.dlyFb.connect(A.dly);
    A.dlyTone.connect(A.revSend); // delay tails melt into the reverb
    A.dlyTone.connect(A.master);

    // drone: three chord tones, two detuned saws each, plus a sine at the root
    A.droneLP = ctx.createBiquadFilter(); A.droneLP.type = 'lowpass'; A.droneLP.Q.value = 0.8;
    A.droneLvl = ctx.createGain();
    A.droneLP.connect(A.droneLvl); A.droneLvl.connect(A.voices);
    A.droneOsc = [];
    const pans = [-0.45, 0.45, -0.2, 0.2, -0.6, 0.6];
    for (let v = 0; v < 3; v++) {
      for (let k = 0; k < 2; k++) {
        const o = ctx.createOscillator(); o.type = 'sawtooth';
        o.detune.value = (k ? 1 : -1) * (5 + v * 2);
        const g = ctx.createGain(); g.gain.value = 0.055;
        const p = makePanner(pans[v * 2 + k]);
        o.connect(g); g.connect(p); p.connect(A.droneLP);
        o.start();
        A.droneOsc.push({ o, voice: v });
      }
    }
    A.sub = ctx.createOscillator(); A.sub.type = 'sine';
    A.subGain = ctx.createGain(); A.subGain.gain.value = 0.22;
    A.sub.connect(A.subGain); A.subGain.connect(A.droneLvl); A.sub.start();

    // slow drift on the drone filter
    A.lfo1 = ctx.createOscillator(); A.lfo1.frequency.value = 0.06;
    A.lfo1Amt = ctx.createGain(); A.lfo1Amt.gain.value = 260;
    A.lfo1.connect(A.lfo1Amt); A.lfo1Amt.connect(A.droneLP.detune); A.lfo1.start();

    // noise: pink and brown loops, crossfaded, high-passed and low-passed into air
    A.noiseHP = ctx.createBiquadFilter(); A.noiseHP.type = 'highpass'; A.noiseHP.frequency.value = 140; A.noiseHP.Q.value = 0.5;
    A.noiseLP = ctx.createBiquadFilter(); A.noiseLP.type = 'lowpass'; A.noiseLP.Q.value = 0.6;
    A.noiseLvl = ctx.createGain();
    A.noiseHP.connect(A.noiseLP); A.noiseLP.connect(A.noiseLvl); A.noiseLvl.connect(A.voices);
    A.noiseGain = {};
    for (const kind of Object.keys(NOISE_TYPES)) {
      const src = ctx.createBufferSource(); src.buffer = noiseBuffer(kind, 7); src.loop = true;
      const g = ctx.createGain(); g.gain.value = 0;
      src.connect(g); g.connect(A.noiseHP); src.start();
      A.noiseGain[kind] = g;
    }
    A.lfo2 = ctx.createOscillator(); A.lfo2.frequency.value = 0.09;
    A.lfo2Amt = ctx.createGain(); A.lfo2Amt.gain.value = 500;
    A.lfo2.connect(A.lfo2Amt); A.lfo2Amt.connect(A.noiseLP.detune); A.lfo2.start();

    // pulse: a periodic swell into the amp and the drone filter
    A.pw = pulseWave();
    A.pulseDepth = ctx.createGain(); A.pulseDepth.gain.value = 0;
    A.pulseDepth.connect(A.pulseAmp.gain);
    A.pulseFilt = ctx.createGain(); A.pulseFilt.gain.value = 0;
    A.pulseFilt.connect(A.droneLP.detune);
    A.pulseOsc = null;
    A.pulseX = null;
    restartPulse(ctx.currentTime, true);

    // output route: MediaStream -> <audio> so the OS treats it as media playback
    if (typeof ctx.createMediaStreamDestination === 'function' && 'srcObject' in outEl) {
      A.stream = ctx.createMediaStreamDestination();
      A.fade.connect(A.stream);
      outEl.srcObject = A.stream.stream;
      routed = 'element';
    } else {
      A.fade.connect(ctx.destination);
      routed = 'direct';
    }

    ctx.addEventListener('statechange', showWake);
    applyAll(true);
    setupMediaSession();
  }

  function pulseHz() { return (S.bpm / 60) * S.div; }

  // start a fresh pulse cycle now (for tap), crossfading from the old one
  function restartPulse(t, first) {
    const o = ctx.createOscillator();
    o.setPeriodicWave(A.pw.wave);
    o.frequency.value = pulseHz();
    const x = ctx.createGain();
    x.gain.value = first ? 1 : 0;
    o.connect(x); x.connect(A.pulseDepth); x.connect(A.pulseFilt);
    o.start(t);
    if (!first) {
      x.gain.setTargetAtTime(1, t, 0.05);
      const oldO = A.pulseOsc, oldX = A.pulseX;
      oldX.gain.cancelScheduledValues(t);
      oldX.gain.setValueAtTime(oldX.gain.value, t);
      oldX.gain.setTargetAtTime(0, t, 0.05);
      oldO.stop(t + 0.6);
      setTimeout(() => { try { oldO.disconnect(); oldX.disconnect(); } catch (e) { /* gone */ } }, 1200);
    }
    A.pulseOsc = o; A.pulseX = x;
    A.pulsePhase = { t0: t, p0: 0, hz: pulseHz() };
  }

  function setPulseRate() {
    if (!ctx) return;
    const t = ctx.currentTime;
    const ph = A.pulsePhase;
    const p = ph.p0 + (t - ph.t0) * ph.hz;
    // an oscillator's frequency can jump without a click; the phase stays continuous
    A.pulseOsc.frequency.setValueAtTime(pulseHz(), t);
    A.pulsePhase = { t0: t, p0: p, hz: pulseHz() };
    ramp(A.dly.delayTime, (60 / S.bpm) * 0.75, 0.4);
  }

  function applyPitch(immediate) {
    const rootMidi = 36 + S.root;                 // C2..B2
    const iv = CHORDS[S.chord].iv;
    const tc = immediate ? 0 : 0.25;
    for (const { o, voice } of A.droneOsc) {
      const f = midiHz(rootMidi + 12 + iv[voice]);
      if (immediate) o.frequency.value = f; else ramp(o.frequency, f, tc);
    }
    const fs = midiHz(rootMidi);
    if (immediate) A.sub.frequency.value = fs; else ramp(A.sub.frequency, fs, tc);
  }

  function targets() {
    const sp = S.space, d = S.pulse;
    const range = A.pw.hi - A.pw.lo;
    return [
      [A.droneLvl.gain, S.drone * S.drone * 1.1],
      [A.noiseLvl.gain, S.noise * S.noise * 0.55],
      [A.noiseGain.pink.gain, S.noiseType === 'pink' ? 1 : 0, 0.3],
      [A.noiseGain.brown.gain, S.noiseType === 'brown' ? 1.3 : 0, 0.3],
      [A.pulseAmp.gain, 1 - d * 0.85 * A.pw.hi / range],
      [A.pulseDepth.gain, d * 0.85 / range],
      [A.pulseFilt.gain, d * 1100 / range],
      [A.droneLP.frequency, expMap(S.bright, 140, 2600)],
      [A.noiseLP.frequency, expMap(S.bright, 500, 9000)],
      [A.dlyTone.frequency, expMap(S.bright, 900, 3500)],
      [A.dry.gain, 1 - sp * 0.4],
      [A.revSend.gain, sp * 0.9],
      [A.dlySend.gain, sp * 0.3],
      [A.master.gain, S.master * S.master * 1.7],
      [A.dly.delayTime, (60 / S.bpm) * 0.75, 0.4]
    ];
  }

  function applyAll(immediate) {
    if (!ctx) return;
    for (const [p, v, tc] of targets()) {
      if (immediate) p.value = v; else ramp(p, v, tc || 0.06);
    }
    applyPitch(immediate);
  }

  function silentTick() {
    const b = ctx.createBuffer(1, 1, 22050);
    const s = ctx.createBufferSource();
    s.buffer = b; s.connect(ctx.destination); s.start(0);
  }

  function playElement() {
    if (routed !== 'element') return;
    const p = outEl.play();
    if (p && typeof p.catch === 'function') {
      p.catch(() => {
        // the element refused: fall back to the context's own output
        if (routed === 'element') {
          try { A.fade.disconnect(A.stream); } catch (e) { /* ignore */ }
          A.fade.connect(ctx.destination);
          routed = 'direct';
        }
      });
    }
  }

  function wake() {
    if (!ctx) return;
    if (ctx.state !== 'running') ctx.resume().catch(() => {});
    if (playing) playElement();
    showWake();
  }

  function start() {
    if (!ctx) build();
    // all of this runs inside the tap so iOS unlocks audio
    if (ctx.state !== 'running') ctx.resume().catch(() => {});
    silentTick();
    playElement();
    clearTimeout(stopTimer);
    playing = true;
    const t = ctx.currentTime;
    A.fade.gain.cancelScheduledValues(t);
    A.fade.gain.setValueAtTime(A.fade.gain.value, t);
    A.fade.gain.setTargetAtTime(1, t, 0.9);
    lockScreen();
    setSessionState();
    render();
  }

  function stop() {
    playing = false;
    if (ctx) {
      const t = ctx.currentTime;
      A.fade.gain.cancelScheduledValues(t);
      A.fade.gain.setValueAtTime(A.fade.gain.value, t);
      A.fade.gain.setTargetAtTime(0, t, 0.6);
      stopTimer = setTimeout(() => {
        if (playing) return;
        if (routed === 'element') outEl.pause();
        ctx.suspend().catch(() => {});
      }, 4500);
    }
    unlockScreen();
    setSessionState();
    render();
  }

  // ---------- keep-alive ----------
  async function lockScreen() {
    if (!('wakeLock' in navigator) || wakeLock || document.visibilityState !== 'visible') return;
    try {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    } catch (e) { wakeLock = null; }
  }
  function unlockScreen() {
    if (wakeLock) { wakeLock.release().catch(() => {}); wakeLock = null; }
  }

  function setupMediaSession() {
    if (!('mediaSession' in navigator)) return;
    try {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: 'Wild Resi-Dance',
        artist: 'Wild Residence',
        album: 'Drone',
        artwork: [
          { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' }
        ]
      });
      const on = (a, fn) => { try { navigator.mediaSession.setActionHandler(a, fn); } catch (e) { /* unsupported */ } };
      on('play', () => start());
      on('pause', () => stop());
      on('stop', () => stop());
    } catch (e) { /* ignore */ }
  }
  function setSessionState() {
    if ('mediaSession' in navigator) {
      try { navigator.mediaSession.playbackState = playing ? 'playing' : 'paused'; } catch (e) { /* ignore */ }
    }
  }

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && playing) {
      lockScreen();
      wake();
    }
  });
  window.addEventListener('pageshow', () => { if (playing) wake(); });
  // any touch while the system has paused audio brings it back
  document.addEventListener('pointerdown', () => {
    if (playing && ctx && ctx.state !== 'running') wake();
  }, true);

  // ---------- UI ----------
  const $ = (id) => document.getElementById(id);
  const playBtn = $('play');
  const wakeEl = $('wake');

  function showWake() {
    wakeEl.hidden = !(playing && ctx && ctx.state !== 'running');
  }

  function render() {
    playBtn.setAttribute('aria-pressed', String(playing));
    playBtn.querySelector('.label').textContent = playing ? 'Stop' : 'Start';
    $('rootName').textContent = NOTES[S.root];
    $('bpmVal').textContent = S.bpm;
    for (const b of document.querySelectorAll('[data-group]')) {
      b.setAttribute('aria-checked', String(String(S[b.dataset.group]) === b.dataset.value));
    }
    for (const f of document.querySelectorAll('.fader')) drawFader(f);
    showWake();
  }

  function drawFader(f) {
    const v = S[f.dataset.key];
    f.querySelector('.fill').style.width = (v * 100).toFixed(1) + '%';
    const pct = Math.round(v * 100);
    f.querySelector('.val').textContent = pct;
    f.setAttribute('aria-valuenow', String(pct));
  }

  function makeChips(holder, group, items) {
    for (const [value, label] of items) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'chip-btn';
      b.setAttribute('role', 'radio');
      b.dataset.group = group;
      b.dataset.value = value;
      b.textContent = label;
      b.addEventListener('click', () => {
        const val = group === 'div' ? Number(value) : value;
        if (S[group] === val) return;
        S[group] = val;
        if (group === 'div') setPulseRate(); else if (ctx) applyAll(false);
        save(); render();
      });
      holder.appendChild(b);
    }
  }
  makeChips($('chords'), 'chord', Object.entries(CHORDS).map(([k, c]) => [k, c.label]));
  makeChips($('noiseTypes'), 'noiseType', Object.entries(NOISE_TYPES));
  makeChips($('divs'), 'div', [['0.5', DIVS['0.5']], ['1', DIVS['1']], ['2', DIVS['2']]]);

  // faders: relative drag, so a stray touch never jumps a level
  let dragging = 0;
  for (const f of document.querySelectorAll('.fader')) {
    const key = f.dataset.key;
    f.setAttribute('role', 'slider');
    f.setAttribute('tabindex', '0');
    f.setAttribute('aria-valuemin', '0');
    f.setAttribute('aria-valuemax', '100');
    f.innerHTML = '<div class="fill"></div><span class="name"></span><span class="val"></span>';
    f.querySelector('.name').textContent = FADERS[key];
    let id = null, x0 = 0, v0 = 0;
    const set = (v) => {
      S[key] = clamp(v, 0, 1);
      if (ctx) applyAll(false);
      drawFader(f); save();
    };
    f.addEventListener('pointerdown', (e) => {
      id = e.pointerId; x0 = e.clientX; v0 = S[key];
      try { f.setPointerCapture(id); } catch (err) { /* ignore */ }
      f.classList.add('drag'); dragging++;
      e.preventDefault();
    });
    f.addEventListener('pointermove', (e) => {
      if (e.pointerId !== id) return;
      set(v0 + (e.clientX - x0) / f.clientWidth);
    });
    const end = (e) => {
      if (e.pointerId !== id) return;
      id = null; f.classList.remove('drag'); dragging = Math.max(0, dragging - 1);
    };
    f.addEventListener('pointerup', end);
    f.addEventListener('pointercancel', end);
    f.addEventListener('lostpointercapture', end);
    f.addEventListener('keydown', (e) => {
      const step = e.shiftKey ? 0.1 : 0.02;
      if (e.key === 'ArrowRight' || e.key === 'ArrowUp') { set(S[key] + step); e.preventDefault(); }
      if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') { set(S[key] - step); e.preventDefault(); }
    });
  }
  // no page scroll or bounce while a control is held
  document.addEventListener('touchmove', (e) => { if (dragging) e.preventDefault(); }, { passive: false });

  // buttons that repeat while held
  function holdRepeat(btn, fn) {
    let t1 = 0, t2 = 0;
    const clear = () => { clearTimeout(t1); clearInterval(t2); };
    btn.addEventListener('pointerdown', (e) => {
      e.preventDefault(); fn(); clear();
      t1 = setTimeout(() => { t2 = setInterval(fn, 90); }, 420);
    });
    for (const ev of ['pointerup', 'pointercancel', 'pointerleave']) btn.addEventListener(ev, clear);
    btn.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fn(); } });
  }
  const setRoot = (d) => { S.root = (S.root + d + 12) % 12; if (ctx) applyPitch(false); save(); render(); };
  const setBpm = (b) => { S.bpm = Math.round(clamp(b, BPM_MIN, BPM_MAX)); setPulseRate(); save(); render(); };
  holdRepeat($('rootDown'), () => setRoot(-1));
  holdRepeat($('rootUp'), () => setRoot(1));
  holdRepeat($('bpmDown'), () => setBpm(S.bpm - 1));
  holdRepeat($('bpmUp'), () => setBpm(S.bpm + 1));

  // tap tempo: average the last few gaps, and start the swell on the tap
  const taps = [];
  const tapBtn = $('tap');
  tapBtn.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    const now = performance.now();
    if (taps.length && now - taps[taps.length - 1] > 2200) taps.length = 0;
    taps.push(now);
    if (taps.length > 5) taps.shift();
    if (taps.length >= 2) {
      const gaps = [];
      for (let i = 1; i < taps.length; i++) gaps.push(taps[i] - taps[i - 1]);
      const avg = gaps.reduce((a, b) => a + b, 0) / gaps.length;
      S.bpm = Math.round(clamp(60000 / avg, BPM_MIN, BPM_MAX));
      save();
      if (ctx) {
        restartPulse(ctx.currentTime, false);
        ramp(A.dly.delayTime, (60 / S.bpm) * 0.75, 0.4);
      }
      render();
    }
    tapBtn.classList.add('hit');
    setTimeout(() => tapBtn.classList.remove('hit'), 120);
  });

  playBtn.addEventListener('click', () => { if (playing) stop(); else start(); });
  document.addEventListener('keydown', (e) => {
    if (e.code === 'Space' && e.target === document.body) { e.preventDefault(); playing ? stop() : start(); }
  });

  // beat light, following the pulse phase
  const beatEl = $('beat');
  const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  function frame() {
    if (ctx && playing && !reduce && A.pulsePhase) {
      const ph = A.pulsePhase;
      const p = (ph.p0 + (ctx.currentTime - ph.t0) * ph.hz) % 1;
      const sh = A.pw.shape;
      const v = (sh[Math.floor(p * sh.length)] - A.pw.lo) / (A.pw.hi - A.pw.lo);
      beatEl.style.opacity = (0.15 + 0.85 * v).toFixed(3);
    } else if (!playing) {
      beatEl.style.opacity = '0.15';
    }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  render();

  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    window.addEventListener('load', () => { navigator.serviceWorker.register('sw.js').catch(() => {}); });
  }

  // read-only handle for checks
  Object.defineProperty(window, 'wildResiDance', {
    value: Object.freeze({
      get state() { return ctx ? ctx.state : 'none'; },
      get playing() { return playing; },
      get route() { return routed; },
      get context() { return ctx; },
      get output() { return A ? A.fade : null; }
    })
  });
})();
