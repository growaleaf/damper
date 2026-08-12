import {
  DT, NIGHT_STEPS, RAIL_RANGE, MAX_CONTROL_FORCE, COMFORT_THRESHOLD_CM,
  createTower, step,
  generateForcing, NIGHTS, nightByIndex, endlessForcing,
  createComfortState, updateComfort, checkFloors, FLOORS,
  gradeNight, simulateNightLocked,
  shareText,
  createProgress, serializeProgress, deserializeProgress, recordNightResult,
} from './sway.mjs';

const STORE_KEY = 'damper_v1';

function loadProgress() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return createProgress();
    return deserializeProgress(raw) || createProgress();
  } catch { return createProgress(); }
}
function saveProgress(p) {
  try { localStorage.setItem(STORE_KEY, serializeProgress(p)); } catch { /* storage unavailable */ }
}

let progress = loadProgress();

// ------------------------------------------------------------- screens ----
const screens = {
  title: document.getElementById('screen-title'),
  howto: document.getElementById('screen-howto'),
  nights: document.getElementById('screen-nights'),
  play: document.getElementById('screen-play'),
  nightend: document.getElementById('screen-nightend'),
};
let currentScreen = 'title';
function showScreen(name) {
  currentScreen = name;
  for (const k in screens) screens[k].classList.toggle('active', k === name);
  if (name === 'nights') renderNightList();
}

document.getElementById('btn-title-begin').addEventListener('click', () => { ensureAudio(); showScreen('nights'); });
document.getElementById('btn-title-howto').addEventListener('click', () => showScreen('howto'));
document.getElementById('btn-howto-next').addEventListener('click', () => { ensureAudio(); showScreen('nights'); });

// --------------------------------------------------------- night picker ----
const nightList = document.getElementById('night-list');
function renderNightList() {
  nightList.innerHTML = '';
  for (const nt of NIGHTS) {
    const locked = nt.night > progress.unlockedNight;
    const best = progress.bestGradeByNight[nt.night];
    const row = document.createElement('button');
    row.className = 'night-row' + (locked ? ' locked' : '');
    row.innerHTML = `
      <span class="num">${nt.night}</span>
      <span class="head">${escapeHtml(nt.headline)}<small>${nt.kind}</small></span>
      <span class="grade">${best || (locked ? '—' : '')}</span>`;
    if (!locked) row.addEventListener('click', () => startNight(nt.night));
    else row.disabled = true;
    nightList.appendChild(row);
  }
  if (progress.unlockedNight > NIGHTS.length) {
    const row = document.createElement('button');
    row.className = 'night-row endless';
    row.innerHTML = `
      <span class="num">∞</span>
      <span class="head">Endless storm<small>best wave: ${progress.endlessBestWave || 0}</small></span>
      <span class="grade"></span>`;
    row.addEventListener('click', () => startEndless());
    nightList.appendChild(row);
  }
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// -------------------------------------------------------------- shift ----
let shift = null;        // active night/endless-wave run state
let running = false;
let lastNow = 0;
let handleTarget = 0;    // -1..1, set by pointer drag — the force command

function startNight(nightNum) {
  const nt = nightByIndex(nightNum);
  const forcing = generateForcing(nt.kind, nt.seed, NIGHT_STEPS, DT, nt.amplitude);
  beginShift({ mode: 'night', night: nightNum, headline: nt.headline, forcing, physState: createTower() });
}

function startEndless() {
  const wave = 0;
  const forcing = endlessForcing(wave, DT, NIGHT_STEPS);
  beginShift({ mode: 'endless', wave, headline: 'Endless storm — wave 1', forcing, physState: createTower() });
}

function beginShift(base) {
  shift = {
    ...base,
    comfort: createComfortState(),
    floorsSeen: new Set(),
    peakSwayCm: 0,
    i: 0,
    toastTimer: 0,
  };
  handleTarget = 0;
  running = true;
  lastNow = 0;
  document.getElementById('play-headline').textContent = shift.headline;
  resizeCanvas();
  showScreen('play');
  requestAnimationFrame(tick);
}

function doStep(dt) {
  if (!shift || shift.i >= shift.forcing.length) return;
  const u = handleTarget * MAX_CONTROL_FORCE;
  const forcingValue = shift.forcing[shift.i];
  shift.physState = step(shift.physState, u, forcingValue, dt);
  shift.i++;
  const absCm = Math.abs(shift.physState.xt) * 100;
  if (absCm > shift.peakSwayCm) shift.peakSwayCm = absCm;
  shift.comfort = updateComfort(shift.comfort, absCm, dt);
  const floorsNow = checkFloors(shift.comfort);
  for (const f of floorsNow) {
    if (!shift.floorsSeen.has(f.id)) {
      shift.floorsSeen.add(f.id);
      showToast(f.story);
      pingChime();
    }
  }
  updateAudio(shift.physState, forcingValue);
  if (shift.toastTimer > 0) {
    shift.toastTimer -= dt;
    if (shift.toastTimer <= 0) toastEl.classList.remove('show');
  }
  if (shift.i >= shift.forcing.length) endShift();
}

function endShift() {
  running = false;
  const durationSeconds = shift.forcing.length * DT;
  const grade = gradeNight(shift.peakSwayCm, shift.comfort.totalComfortSeconds, durationSeconds);
  const floorsReached = FLOORS.filter((f) => shift.floorsSeen.has(f.id));
  const storyLine = floorsReached.length
    ? floorsReached[floorsReached.length - 1].story
    : 'the whole tower held its breath';

  if (shift.mode === 'night') {
    progress = recordNightResult(progress, shift.night, grade.grade);
    saveProgress(progress);
  } else {
    progress = { ...progress, endlessBestWave: Math.max(progress.endlessBestWave, shift.wave + 1) };
    saveProgress(progress);
  }

  document.getElementById('end-headline').textContent = shift.headline;
  document.getElementById('end-grade').textContent = grade.grade;
  document.getElementById('end-gradelabel').textContent = grade.label;
  document.getElementById('end-peak').textContent = `${Math.round(shift.peakSwayCm)}cm`;
  document.getElementById('end-comfort').textContent = `${shift.comfort.totalComfortSeconds.toFixed(1)}s of ${durationSeconds}s`;
  const floorBox = document.getElementById('end-floors');
  floorBox.innerHTML = '';
  if (floorsReached.length === 0) {
    const div = document.createElement('div');
    div.className = 'floor-item';
    div.textContent = 'Nobody below settled tonight. The tower stayed loud.';
    floorBox.appendChild(div);
  } else {
    for (const f of floorsReached) {
      const div = document.createElement('div');
      div.className = 'floor-item';
      div.innerHTML = `<span class="fl">floor ${f.floor}</span>${escapeHtml(f.story)}`;
      floorBox.appendChild(div);
    }
  }
  const text = shift.mode === 'night'
    ? shareText(shift.night, shift.peakSwayCm, storyLine)
    : `\u{1F3D9}️ DAMPER endless storm · reached wave ${shift.wave + 1} · peak sway ${Math.round(shift.peakSwayCm)}cm · http://damper.defimagic.io`;
  document.getElementById('end-sharebox').textContent = text;
  document.getElementById('end-copiednote').textContent = '';
  showScreen('nightend');
}

document.getElementById('btn-play-quit').addEventListener('click', () => {
  running = false;
  showScreen('nights');
});
document.getElementById('btn-end-continue').addEventListener('click', () => showScreen('nights'));
document.getElementById('btn-end-copy').addEventListener('click', async () => {
  const text = document.getElementById('end-sharebox').textContent;
  const note = document.getElementById('end-copiednote');
  try { await navigator.clipboard.writeText(text); note.textContent = 'Copied.'; }
  catch { note.textContent = 'Copy failed — select the text above manually.'; }
});

// ------------------------------------------------------------ toasts ----
const toastEl = document.getElementById('play-toast');
function showToast(text) {
  toastEl.textContent = text;
  toastEl.classList.add('show');
  shift.toastTimer = 3.2;
}

// ------------------------------------------------------------- clock ----
function tick(now) {
  const dt = lastNow ? Math.min(0.05, (now - lastNow) / 1000) : DT;
  lastNow = now;
  if (running && shift) {
    doStep(dt);
    render();
    updateHud();
    requestAnimationFrame(tick);
  }
}

function updateHud() {
  const elapsed = shift.i * DT;
  const total = shift.forcing.length * DT;
  const remain = Math.max(0, total - elapsed);
  const m = Math.floor(remain / 60), s = Math.floor(remain % 60);
  document.getElementById('play-clock').textContent = `${m}:${String(s).padStart(2, '0')}`;
  document.getElementById('play-progress').style.width = `${Math.min(100, (elapsed / total) * 100)}%`;
  const absCm = Math.abs(shift.physState.xt) * 100;
  const cap = document.getElementById('play-caption');
  if (absCm <= COMFORT_THRESHOLD_CM) {
    cap.textContent = shift.comfort.streak > 0.3 ? `still — ${shift.comfort.streak.toFixed(1)}s` : 'still';
    cap.classList.remove('strong');
  } else {
    cap.textContent = `${Math.round(absCm)}cm of sway`;
    cap.classList.add('strong');
  }
}

// ---------------------------------------------------------- rendering ----
const canvas = document.getElementById('canvas');
const ctx = canvas.getContext('2d');
function resizeCanvas() {
  const rect = canvas.parentElement.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.max(1, rect.width * dpr);
  canvas.height = Math.max(1, rect.height * dpr);
}
window.addEventListener('resize', resizeCanvas);

const STAR_SEED = Array.from({ length: 40 }, (_, i) => ({
  x: (i * 137.5) % 100, y: (i * 53.7) % 60, r: 0.6 + (i % 3) * 0.3,
}));

function render() {
  if (!shift) return;
  const w = canvas.width, h = canvas.height;
  ctx.clearRect(0, 0, w, h);

  // sky + stars
  const skyGrad = ctx.createLinearGradient(0, 0, 0, h);
  skyGrad.addColorStop(0, '#040914');
  skyGrad.addColorStop(1, '#0c1a2c');
  ctx.fillStyle = skyGrad;
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = 'rgba(220,233,245,0.55)';
  for (const s of STAR_SEED) {
    ctx.beginPath();
    ctx.arc((s.x / 100) * w, (s.y / 100) * h, s.r * (w / 480), 0, Math.PI * 2);
    ctx.fill();
  }

  const xt = shift.physState.xt;
  const xd = shift.physState.xd;
  const tiltFrac = Math.max(-1, Math.min(1, xt / 0.55));
  const tilt = tiltFrac * 0.26; // radians, ~15deg max

  const baseX = w * 0.5, baseY = h * 0.98;
  const towerH = h * 0.72, towerW = w * 0.30;

  ctx.save();
  ctx.translate(baseX, baseY);
  ctx.rotate(tilt);

  // tower body
  const bodyGrad = ctx.createLinearGradient(-towerW / 2, -towerH, towerW / 2, 0);
  bodyGrad.addColorStop(0, '#16283e');
  bodyGrad.addColorStop(1, '#0c1826');
  ctx.fillStyle = bodyGrad;
  ctx.fillRect(-towerW / 2, -towerH, towerW, towerH);

  // windows, warmer near the base, flicker calmer when comfort streak is high
  const calm = Math.min(1, shift.comfort.streak / 3);
  const rows = 14, cols = 4;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const wx = -towerW / 2 + towerW * ((c + 0.5) / cols);
      const wy = -towerH * (0.08 + 0.86 * (r / rows));
      const lit = ((r * 7 + c * 3 + Math.floor(shift.i / 20)) % 5) !== 0;
      if (!lit) continue;
      ctx.fillStyle = calm > 0.7 ? 'rgba(232,194,122,0.55)' : 'rgba(120,150,180,0.35)';
      ctx.fillRect(wx - towerW * 0.05, wy, towerW * 0.10, towerH * 0.02);
    }
  }

  // rail + damper at the roofline
  const railY = -towerH - h * 0.02;
  const railW = towerW * 2.1;
  ctx.strokeStyle = 'rgba(74,107,138,0.9)';
  ctx.lineWidth = Math.max(2, w * 0.006);
  ctx.beginPath();
  ctx.moveTo(-railW / 2, railY);
  ctx.lineTo(railW / 2, railY);
  ctx.stroke();

  // target ring (where the player is pulling toward)
  const targetX = handleTarget * (railW / 2);
  ctx.strokeStyle = 'rgba(232,194,122,0.55)';
  ctx.lineWidth = Math.max(1, w * 0.004);
  ctx.beginPath();
  ctx.arc(targetX, railY, w * 0.045, 0, Math.PI * 2);
  ctx.stroke();

  // the counterweight itself (physics-driven, may lag the target)
  const damperX = (xd / RAIL_RANGE) * (railW / 2);
  const swayDanger = Math.min(1, Math.abs(xt) * 100 / 90);
  const r = Math.round(140 + swayDanger * 60);
  const g = Math.round(200 - swayDanger * 140);
  const b = Math.round(180 - swayDanger * 120);
  const grad = ctx.createRadialGradient(damperX, railY, 2, damperX, railY, w * 0.06);
  grad.addColorStop(0, `rgba(${r},${g},${b},1)`);
  grad.addColorStop(1, `rgba(${r},${g},${b},0.15)`);
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.arc(damperX, railY, w * 0.05, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = `rgb(${r},${g},${b})`;
  ctx.beginPath();
  ctx.arc(damperX, railY, w * 0.028, 0, Math.PI * 2);
  ctx.fill();

  ctx.restore();

  // comfort glow across the base when still
  if (calm > 0.05) {
    ctx.fillStyle = `rgba(127,179,174,${0.10 * calm})`;
    ctx.fillRect(0, h * 0.9, w, h * 0.1);
  }
}

// ------------------------------------------------------------ pointer ----
const stage = document.getElementById('stage');
function normFromEvent(e) {
  const rect = stage.getBoundingClientRect();
  const x = e.clientX - rect.left;
  const frac = (x / rect.width - 0.5) * 2.4; // slightly wider than the visual rail for reach
  return Math.max(-1, Math.min(1, frac));
}
let dragging = false;
stage.addEventListener('pointerdown', (e) => { dragging = true; handleTarget = normFromEvent(e); stage.setPointerCapture(e.pointerId); });
stage.addEventListener('pointermove', (e) => { if (dragging) handleTarget = normFromEvent(e); });
function releasePointer() { dragging = false; handleTarget = 0; }
stage.addEventListener('pointerup', releasePointer);
stage.addEventListener('pointercancel', releasePointer);

// -------------------------------------------------------------- audio ----
let actx = null, windNoise = null, windGain = null, windFilter = null;
function ensureAudio() {
  if (actx) return;
  try {
    actx = new (window.AudioContext || window.webkitAudioContext)();
    const bufSize = actx.sampleRate * 2;
    const buf = actx.createBuffer(1, bufSize, actx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < bufSize; i++) data[i] = Math.random() * 2 - 1;
    windNoise = actx.createBufferSource();
    windNoise.buffer = buf;
    windNoise.loop = true;
    windFilter = actx.createBiquadFilter();
    windFilter.type = 'lowpass';
    windFilter.frequency.value = 300;
    windGain = actx.createGain();
    windGain.gain.value = 0.0001;
    windNoise.connect(windFilter).connect(windGain).connect(actx.destination);
    windNoise.start();
  } catch { actx = null; }
}
function updateAudio(state, forcingValue) {
  if (!actx || !windGain || !windFilter) return;
  const intensity = Math.min(1, Math.abs(forcingValue) / 3000 + Math.abs(state.vt) * 2);
  const now = actx.currentTime;
  windGain.gain.setTargetAtTime(0.015 + intensity * 0.05, now, 0.15);
  windFilter.frequency.setTargetAtTime(200 + intensity * 900, now, 0.2);
}
function pingChime() {
  if (!actx) return;
  const osc = actx.createOscillator();
  const g = actx.createGain();
  osc.type = 'sine';
  osc.frequency.value = 660;
  g.gain.value = 0.0001;
  osc.connect(g).connect(actx.destination);
  const now = actx.currentTime;
  g.gain.setValueAtTime(0.0001, now);
  g.gain.exponentialRampToValueAtTime(0.06, now + 0.02);
  g.gain.exponentialRampToValueAtTime(0.0001, now + 1.1);
  osc.start(now);
  osc.stop(now + 1.2);
}

// ------------------------------------------------------- dev hook (?dev=1) --
if (new URLSearchParams(location.search).get('dev') === '1') {
  window.__g = {
    getScreen: () => currentScreen,
    goTitle: () => showScreen('title'),
    goHowTo: () => showScreen('howto'),
    goNights: () => showScreen('nights'),
    startNight,
    startEndless,
    setHandle: (v) => { handleTarget = Math.max(-1, Math.min(1, v)); },
    stepFrame: (dt = DT) => { if (shift) { doStep(dt); render(); updateHud(); } },
    runFrames: (count, dt = DT) => { for (let i = 0; i < count; i++) { if (shift) doStep(dt); } render(); updateHud(); },
    getState: () => ({
      screen: currentScreen,
      progress: JSON.parse(JSON.stringify(progress)),
      shift: shift ? {
        mode: shift.mode, night: shift.night, wave: shift.wave, i: shift.i,
        total: shift.forcing.length, physState: shift.physState,
        comfort: shift.comfort, peakSwayCm: shift.peakSwayCm,
        floorsSeen: Array.from(shift.floorsSeen),
      } : null,
    }),
    getShareText: () => document.getElementById('end-sharebox').textContent,
    resetProgress: () => { progress = createProgress(); saveProgress(progress); },
    readLocalStorage: () => { try { return JSON.parse(localStorage.getItem(STORE_KEY)); } catch { return null; } },
  };
}

showScreen('title');
