// DAMPER — pure core. No DOM, no WebAudio, no Date.now(), no Math.random().
// You are the tower's active mass damper: a free-sliding counterweight whose
// only power over the building is a bounded actuator force reacting against
// it (Newton's third law — the force that helps you move is the same force
// that pushes back on the structure). There is no passive tuning spring
// between you and the tower; you are the whole control system. Real active
// mass dampers are built this way; Taipei 101's famous sphere is the OTHER
// kind (passive, tuned, no player) — both are named honestly in the wiki.

// ---------------------------------------------------------- tower physics --
export const TOWER_MASS = 5000;                      // abstract mass units
export const TOWER_PERIOD = 6.8;                      // seconds — Taipei 101's real modal period, borrowed honestly
export const TOWER_OMEGA = 2 * Math.PI / TOWER_PERIOD;
export const TOWER_K = TOWER_MASS * TOWER_OMEGA * TOWER_OMEGA;
export const TOWER_ZETA = 0.01;                       // 1% structural damping — real skyscrapers are this lightly damped
export const TOWER_C = 2 * TOWER_ZETA * Math.sqrt(TOWER_K * TOWER_MASS);

// ---------------------------------------------------------- damper physics --
export const DAMPER_MASS_RATIO = 0.04;                // stylized for play — real AMDs run leaner
export const DAMPER_MASS = TOWER_MASS * DAMPER_MASS_RATIO;
export const RAIL_RANGE = 3.0;                        // meters — how far you can drag yourself off center
export const RAIL_STIFFNESS = DAMPER_MASS * Math.pow(TOWER_OMEGA * 8, 2); // hard end-stop, well above the tower's own frequency
export const MAX_CONTROL_FORCE = 2600;                // the most force a body can put into the actuator

// ------------------------------------------------------------------ dt/night --
export const DT = 1 / 30;
export const NIGHT_SECONDS = 40;
export const NIGHT_STEPS = Math.round(NIGHT_SECONDS / DT);

// ------------------------------------------------------------- comfort/floors --
export const COMFORT_THRESHOLD_CM = 8;   // sway below this reads as "still" to the floors below
export const COMFORT_HOLD_SECONDS = 3;   // stillness has to hold this long before it counts as a window
export const SWAY_DANGER_CM = 90;        // grading ceiling — sway at or above this is the worst case, not a hard fail

// ---------------------------------------------------------------------- rng --
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function clamp(x, lo, hi) { return Math.max(lo, Math.min(hi, x)); }

// -------------------------------------------------------------------- state --
export function createTower() {
  return { t: 0, xt: 0, vt: 0, xd: 0, vd: 0 };
}

function railForce(xd) {
  if (xd > RAIL_RANGE) return -RAIL_STIFFNESS * (xd - RAIL_RANGE);
  if (xd < -RAIL_RANGE) return -RAIL_STIFFNESS * (xd + RAIL_RANGE);
  return 0;
}

// The coupled 2-mass step. `u` is the actuator force you command on
// yourself (the damper mass); its reaction (`-u`) is what actually pushes
// the tower. This is the entire "never-done" kernel: you are the damping
// TERM of a second-order system, not a thing balanced on top of one.
export function step(state, u, forcing, dt) {
  const uc = clamp(u, -MAX_CONTROL_FORCE, MAX_CONTROL_FORCE);
  const Ft = -TOWER_K * state.xt - TOWER_C * state.vt - uc + forcing;
  const Fd = uc + railForce(state.xd);
  const at = Ft / TOWER_MASS;
  const ad = Fd / DAMPER_MASS;
  const vt = state.vt + at * dt;
  const vd = state.vd + ad * dt;
  const xt = state.xt + vt * dt;
  const xd = state.xd + vd * dt;
  return { t: state.t + dt, xt, vt, xd, vd };
}

// The building with its damper welded still — no counterweight, no you.
// Single-mass baseline every run is graded against.
export function stepLocked(state, forcing, dt) {
  const totalMass = TOWER_MASS + DAMPER_MASS;
  const at = (-TOWER_K * state.xt - TOWER_C * state.vt + forcing) / totalMass;
  const vt = state.vt + at * dt;
  const xt = state.xt + vt * dt;
  return { t: state.t + dt, xt, vt, xd: xt, vd: vt };
}

export function systemEnergy(state) {
  const railPE = state.xd > RAIL_RANGE
    ? 0.5 * RAIL_STIFFNESS * Math.pow(state.xd - RAIL_RANGE, 2)
    : state.xd < -RAIL_RANGE
      ? 0.5 * RAIL_STIFFNESS * Math.pow(state.xd + RAIL_RANGE, 2)
      : 0;
  return 0.5 * TOWER_MASS * state.vt * state.vt
       + 0.5 * TOWER_K * state.xt * state.xt
       + 0.5 * DAMPER_MASS * state.vd * state.vd
       + railPE;
}

// ---------------------------------------------------------- forcing generators --
// Wind buffeting a tall building is not white noise — the building's own
// dynamics (and real turbulence spectra) concentrate energy near its
// fundamental sway frequency. Gust/storm are colored noise from a damped
// filter oscillator tuned near-but-not-at the tower's own omega; tremor is
// a short broadband transient; crowd is a pure sinusoid at EXACTLY the
// tower's frequency — the one forcing type built to resonate, not just push.
function filteredNoise(seed, n, dt, amplitude, omegaF, zetaF) {
  const rng = mulberry32(seed);
  let xf = 0, vf = 0;
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const noise = rng() * 2 - 1;
    const af = -omegaF * omegaF * xf - 2 * zetaF * omegaF * vf + noise;
    vf += af * dt;
    xf += vf * dt;
    out[i] = xf;
  }
  let peak = 0;
  for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(out[i]));
  const scale = peak > 0 ? amplitude / peak : 0;
  for (let i = 0; i < n; i++) out[i] *= scale;
  return out;
}

export function genGust(seed, n, dt, amplitude) {
  return filteredNoise(seed, n, dt, amplitude, TOWER_OMEGA * 0.6, 0.45);
}

export function genStorm(seed, n, dt, amplitude) {
  return filteredNoise(seed, n, dt, amplitude, TOWER_OMEGA * 0.85, 0.28);
}

export function genTremor(seed, n, dt, amplitude) {
  const rng = mulberry32(seed);
  const startFrac = 0.15 + rng() * 0.5;
  const start = Math.floor(startFrac * n);
  const freq = TOWER_OMEGA * (1.8 + rng() * 0.8); // a real tremor shakes faster than the tower's own sway
  const decay = 2.0;
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    if (i < start) { out[i] = 0; continue; }
    const t = (i - start) * dt;
    out[i] = amplitude * Math.sin(freq * t) * Math.exp(-decay * t);
  }
  return out;
}

export function genCrowd(seed, n, dt, amplitude, omega = TOWER_OMEGA) {
  const rng = mulberry32(seed);
  const phase = rng() * Math.PI * 2;
  const rampSteps = Math.max(1, Math.floor(n * 0.15)); // the crowd finds the beat over the first ~15%
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const t = i * dt;
    const ramp = Math.min(1, i / rampSteps);
    out[i] = amplitude * ramp * Math.sin(omega * t + phase);
  }
  return out;
}

const GENERATORS = { gust: genGust, storm: genStorm, tremor: genTremor, crowd: genCrowd };

export function generateForcing(kind, seed, n, dt, amplitude) {
  const gen = GENERATORS[kind];
  if (!gen) throw new Error(`unknown forcing kind: ${kind}`);
  return gen(seed, n, dt, amplitude);
}

// ------------------------------------------------------------- control policies --
// Reference operators used to prove the physics (and available as an
// in-game "ghost" comparison). Sky-hook velocity feedback: command force
// opposite the tower's own velocity. Its mirror (inverted sign) is the
// resonance mistake — matching the tower's motion instead of opposing it.
// step() applies -u (the reaction) to the tower, so commanding u = +gain*vt
// makes the reaction -gain*vt — a force opposing the tower's own velocity.
export function antiPhasePolicy(state, gain = 1800) {
  return clamp(gain * state.vt, -MAX_CONTROL_FORCE, MAX_CONTROL_FORCE);
}
export function inPhasePolicy(state, gain = 1800) {
  return clamp(-gain * state.vt, -MAX_CONTROL_FORCE, MAX_CONTROL_FORCE);
}
export function noPolicy() { return 0; }

// ----------------------------------------------------------------- phase analyzer --
// Zero-lag cross-correlation of your velocity against the tower's.
// +1 = you moved perfectly anti-phase (draining energy). -1 = perfectly
// in-phase (feeding it). 0 = no relationship.
export function phaseCorrelation(vtArray, vdArray) {
  const n = Math.min(vtArray.length, vdArray.length);
  let cross = 0, sumT2 = 0, sumD2 = 0;
  for (let i = 0; i < n; i++) {
    cross += vtArray[i] * vdArray[i];
    sumT2 += vtArray[i] * vtArray[i];
    sumD2 += vdArray[i] * vdArray[i];
  }
  const denom = Math.sqrt(sumT2 * sumD2);
  return denom === 0 ? 0 : -cross / denom;
}

// -------------------------------------------------------------------- comfort --
export function createComfortState() {
  return { streak: 0, totalComfortSeconds: 0, windowsOpened: 0 };
}

export function updateComfort(cs, absSwayCm, dt) {
  if (absSwayCm <= COMFORT_THRESHOLD_CM) {
    const streak = cs.streak + dt;
    const held = streak >= COMFORT_HOLD_SECONDS;
    const justCrossed = held && cs.streak < COMFORT_HOLD_SECONDS;
    return {
      streak,
      totalComfortSeconds: cs.totalComfortSeconds + (held ? dt : 0),
      windowsOpened: cs.windowsOpened + (justCrossed ? 1 : 0),
    };
  }
  return { streak: 0, totalComfortSeconds: cs.totalComfortSeconds, windowsOpened: cs.windowsOpened };
}

// ------------------------------------------------------------------- floors --
export const FLOORS = [
  { floor: 40, id: 'surgery', requiredHold: COMFORT_HOLD_SECONDS * 1, story: 'On forty, a hand holding a scalpel doesn’t have to think about you. That’s the whole job.' },
  { floor: 61, id: 'nursery', requiredHold: COMFORT_HOLD_SECONDS * 2, story: 'A marble sits still on sixty-one. A kid you’ll never meet keeps playing.' },
  { floor: 74, id: 'strings', requiredHold: COMFORT_HOLD_SECONDS * 3, story: 'On seventy-four, a cellist finds the low note and holds it without a waver.' },
  { floor: 88, id: 'kitchen', requiredHold: COMFORT_HOLD_SECONDS * 4, story: 'On eighty-eight, a tray of glasses makes it to the table without a sound.' },
  { floor: 101, id: 'wedding', requiredHold: COMFORT_HOLD_SECONDS * 5, story: 'On the roof, the cake survives the vows.' },
];

export function checkFloors(comfortState) {
  return FLOORS.filter((f) => comfortState.streak >= f.requiredHold);
}

// --------------------------------------------------------------------- grade --
export const GRADE_BANDS = [
  { min: 90, grade: 'S', label: 'They’ll study your night in the engineering program.' },
  { min: 75, grade: 'A', label: 'Steady. The building never knew how close it came.' },
  { min: 55, grade: 'B', label: 'Held. Barely, but held.' },
  { min: 30, grade: 'C', label: 'A rough night. Nobody fell. That counts.' },
  { min: 0,  grade: 'D', label: 'The tower swayed and so did you. Tomorrow’s another storm.' },
];

export function gradeNight(peakSwayCm, comfortSeconds, nightDurationSeconds) {
  const swayScore = clamp(100 * (1 - peakSwayCm / SWAY_DANGER_CM), 0, 100);
  const comfortFrac = clamp(comfortSeconds / nightDurationSeconds, 0, 1) * 100;
  const composite = swayScore * 0.65 + comfortFrac * 0.35;
  const band = GRADE_BANDS.find((b) => composite >= b.min) || GRADE_BANDS[GRADE_BANDS.length - 1];
  return { composite: Math.round(composite), grade: band.grade, label: band.label };
}

// -------------------------------------------------------------- authored nights --
export const NIGHTS = [
  { night: 1,  kind: 'gust',   seed: 300001, amplitude: 346.4,  headline: 'A steady breeze off the harbor' },
  { night: 2,  kind: 'gust',   seed: 300002, amplitude: 383.7,  headline: 'The wind picks a direction and keeps it' },
  { night: 3,  kind: 'gust',   seed: 300003, amplitude: 374.7,  headline: 'Gusts, now, not just wind' },
  { night: 4,  kind: 'storm',  seed: 300004, amplitude: 271.7,  headline: 'The first real storm of the season' },
  { night: 5,  kind: 'storm',  seed: 300005, amplitude: 470.2,  headline: 'Rain sideways, gutters singing' },
  { night: 6,  kind: 'storm',  seed: 300006, amplitude: 367.9,  headline: 'The kind of storm that makes the news' },
  { night: 7,  kind: 'tremor', seed: 300007, amplitude: 3518.3, headline: 'A tremor, far off, arrives anyway' },
  { night: 8,  kind: 'tremor', seed: 300008, amplitude: 5760.1, headline: 'This one, you feel in your teeth' },
  { night: 9,  kind: 'crowd',  seed: 300009, amplitude: 113.6,  headline: 'A wedding finds the roof, and finds a rhythm' },
  { night: 10, kind: 'crowd',  seed: 300010, amplitude: 172.4,  headline: 'Two hundred guests, one song, one frequency' },
];

export function nightByIndex(n) {
  return NIGHTS.find((x) => x.night === n) || null;
}

// Endless mode: storm forcing that keeps escalating, wave over wave.
export function endlessForcing(wave, dt, n) {
  const amplitude = 300 + wave * 55;
  return genStorm(900000 + wave, n, dt, amplitude);
}

// ----------------------------------------------------------------- simulation --
// Pure simulation driver: runs one full night against a control policy
// (a function of state -> commanded force, or null for hands-off) and
// returns everything the game/tests need. Used identically by test.mjs and
// by the "how would perfect play have gone" ghost comparison in-game.
export function simulateNight(forcing, dt, policyFn) {
  let state = createTower();
  let comfort = createComfortState();
  let peakSwayCm = 0;
  const vt = new Float64Array(forcing.length);
  const vd = new Float64Array(forcing.length);
  for (let i = 0; i < forcing.length; i++) {
    const u = policyFn ? policyFn(state) : 0;
    state = step(state, u, forcing[i], dt);
    vt[i] = state.vt;
    vd[i] = state.vd;
    const absCm = Math.abs(state.xt) * 100;
    if (absCm > peakSwayCm) peakSwayCm = absCm;
    comfort = updateComfort(comfort, absCm, dt);
  }
  const durationSeconds = forcing.length * dt;
  const grade = gradeNight(peakSwayCm, comfort.totalComfortSeconds, durationSeconds);
  const floors = checkFloors(comfort);
  return {
    finalState: state,
    peakSwayCm,
    comfort,
    floors,
    grade,
    phaseScore: phaseCorrelation(vt, vd),
  };
}

export function simulateNightLocked(forcing, dt) {
  let state = createTower();
  let peakSwayCm = 0;
  for (let i = 0; i < forcing.length; i++) {
    state = stepLocked(state, forcing[i], dt);
    peakSwayCm = Math.max(peakSwayCm, Math.abs(state.xt) * 100);
  }
  return { finalState: state, peakSwayCm };
}

// -------------------------------------------------------------------- share --
export function shareText(nightIndex, peakSwayCm, storyLine, url = 'http://damper.defimagic.io') {
  const nightMeta = nightByIndex(nightIndex);
  const label = nightMeta ? `${nightMeta.kind} night` : 'endless storm';
  return `\u{1F3D9}️ DAMPER ${label} · peak sway ${Math.round(peakSwayCm)}cm · ${storyLine} · ${url}`;
}

// tiny replay codec: night index + seed, round-trippable
export function encodeRunCode(nightIndex, seed) {
  return `${nightIndex.toString(36)}.${(seed >>> 0).toString(36)}`;
}
export function decodeRunCode(code) {
  const parts = String(code).split('.');
  if (parts.length !== 2) return null;
  const nightIndex = parseInt(parts[0], 36);
  const seed = parseInt(parts[1], 36);
  if (!Number.isFinite(nightIndex) || !Number.isFinite(seed)) return null;
  return { nightIndex, seed: seed >>> 0 };
}

// ---------------------------------------------------------------- persistence --
export function createProgress() {
  return { unlockedNight: 1, bestGradeByNight: {}, endlessBestWave: 0 };
}

export function serializeProgress(p) { return JSON.stringify(p); }

export function deserializeProgress(raw) {
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || typeof parsed.unlockedNight !== 'number') return null;
    return {
      unlockedNight: parsed.unlockedNight,
      bestGradeByNight: parsed.bestGradeByNight || {},
      endlessBestWave: parsed.endlessBestWave || 0,
    };
  } catch {
    return null;
  }
}

const GRADE_RANK = { S: 5, A: 4, B: 3, C: 2, D: 1 };

export function recordNightResult(progress, nightIndex, grade) {
  const prevGrade = progress.bestGradeByNight[nightIndex];
  const better = !prevGrade || GRADE_RANK[grade] > GRADE_RANK[prevGrade];
  const bestGradeByNight = better
    ? { ...progress.bestGradeByNight, [nightIndex]: grade }
    : progress.bestGradeByNight;
  const unlockedNight = Math.max(progress.unlockedNight, Math.min(NIGHTS.length, nightIndex + 1));
  return { ...progress, bestGradeByNight, unlockedNight };
}
