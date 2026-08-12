import {
  DT, NIGHT_STEPS, TOWER_OMEGA, TOWER_ZETA, TOWER_MASS, DAMPER_MASS, MAX_CONTROL_FORCE,
  COMFORT_THRESHOLD_CM, COMFORT_HOLD_SECONDS,
  mulberry32, createTower, step, stepLocked, systemEnergy,
  genGust, genStorm, genTremor, genCrowd, generateForcing, NIGHTS, nightByIndex, endlessForcing,
  antiPhasePolicy, inPhasePolicy, phaseCorrelation,
  createComfortState, updateComfort, checkFloors, FLOORS,
  gradeNight, GRADE_BANDS, simulateNight, simulateNightLocked,
  shareText, encodeRunCode, decodeRunCode,
  createProgress, serializeProgress, deserializeProgress, recordNightResult,
} from './sway.mjs';

let pass = 0, fail = 0;
function check(name, cond) {
  if (cond) { pass++; }
  else { fail++; console.error(`FAIL: ${name}`); }
}
function approx(a, b, eps = 1e-6) { return Math.abs(a - b) <= eps; }

// 1. PRNG determinism + bounds
{
  const a = mulberry32(42), b = mulberry32(42);
  const seqA = Array.from({ length: 30 }, () => a());
  const seqB = Array.from({ length: 30 }, () => b());
  check('mulberry32 deterministic for same seed', seqA.every((v, i) => v === seqB[i]));
  const r = mulberry32(7);
  let inBounds = true;
  for (let i = 0; i < 1000; i++) { const v = r(); if (v < 0 || v >= 1) inBounds = false; }
  check('mulberry32 output always in [0,1)', inBounds);
}

// 2. free oscillation decays at the model rate (locked, single-DOF equivalent)
{
  const dt = DT;
  let s = { t: 0, xt: 0.5, vt: 0, xd: 0.5, vd: 0 };
  const peaks = [];
  let prevV = 0;
  for (let i = 0; i < 900; i++) {
    const prevXt = s.xt;
    s = stepLocked(s, 0, dt);
    if (prevV > 0 && s.vt <= 0) peaks.push(prevXt);
    prevV = s.vt;
  }
  const totalMass = TOWER_MASS + DAMPER_MASS;
  const K = TOWER_MASS * TOWER_OMEGA * TOWER_OMEGA;
  const C = 2 * TOWER_ZETA * Math.sqrt(K * TOWER_MASS);
  const omega = Math.sqrt(K / totalMass);
  const zeta = C / (2 * Math.sqrt(K * totalMass));
  const T = 2 * Math.PI / (omega * Math.sqrt(1 - zeta * zeta));
  const analyticRatio = Math.exp(-zeta * omega * T);
  const measuredRatio = peaks[1] / peaks[0];
  check('locked free oscillation produces at least 4 decaying peaks', peaks.length >= 4);
  check('successive-peak decay ratio matches the analytic damping model', approx(measuredRatio, analyticRatio, 1e-3));
  check('decay is monotonic (each peak smaller than the last)', peaks.every((p, i) => i === 0 || p < peaks[i - 1]));
}

// 3. step() determinism
{
  function run() {
    let s = createTower();
    for (let i = 0; i < 200; i++) s = step(s, 50 * Math.sin(i * 0.1), 30 * Math.cos(i * 0.05), DT);
    return s;
  }
  const r1 = run(), r2 = run();
  check('step() is deterministic', r1.xt === r2.xt && r1.vt === r2.vt && r1.xd === r2.xd);
}

// 4. forcing generator bounds + determinism over >=100 seeds
{
  let boundedOk = true, finiteOk = true;
  for (let seed = 0; seed < 120; seed++) {
    for (const gen of [genGust, genStorm, genTremor]) {
      const f = gen(seed, 200, DT, 500);
      for (let i = 0; i < f.length; i++) {
        if (!Number.isFinite(f[i])) finiteOk = false;
        if (Math.abs(f[i]) > 500 + 1e-6) boundedOk = false;
      }
    }
    const c = genCrowd(seed, 200, DT, 500);
    for (let i = 0; i < c.length; i++) {
      if (!Number.isFinite(c[i])) finiteOk = false;
      if (Math.abs(c[i]) > 500 + 1e-6) boundedOk = false;
    }
  }
  check('every forcing generator stays finite over 120 seeds', finiteOk);
  check('every forcing generator respects its amplitude cap over 120 seeds', boundedOk);
  const g1 = genStorm(2026, 300, DT, 1000), g2 = genStorm(2026, 300, DT, 1000);
  check('forcing generators are deterministic for a fixed seed', g1.every((v, i) => v === g2[i]));
}

// 5. perfect anti-phase policy reduces peak sway vs the locked baseline, over every forcing type
{
  let allReduced = true;
  const results = [];
  for (const nt of NIGHTS) {
    const forcing = generateForcing(nt.kind, nt.seed, NIGHT_STEPS, DT, nt.amplitude);
    const locked = simulateNightLocked(forcing, DT);
    const anti = simulateNight(forcing, DT, antiPhasePolicy);
    results.push({ kind: nt.kind, locked: locked.peakSwayCm, anti: anti.peakSwayCm });
    if (!(anti.peakSwayCm < locked.peakSwayCm)) allReduced = false;
  }
  check('anti-phase policy beats the locked-damper baseline on all 10 authored nights', allReduced);
  const kinds = new Set(results.map((r) => r.kind));
  check('the win spans every forcing type (gust, storm, tremor, crowd)', kinds.size === 4);
}

// 6. in-phase policy AMPLIFIES relative to locked (resonance is real)
{
  let allAmplified = true;
  for (const nt of NIGHTS) {
    const forcing = generateForcing(nt.kind, nt.seed, NIGHT_STEPS, DT, nt.amplitude);
    const locked = simulateNightLocked(forcing, DT);
    const inph = simulateNight(forcing, DT, inPhasePolicy);
    if (!(inph.peakSwayCm > locked.peakSwayCm)) allAmplified = false;
  }
  check('in-phase (wrong-way) policy amplifies sway past the locked baseline on all 10 nights', allAmplified);
}

// 7. crowd forcing at the tower's natural frequency is the hardest night, measured at equal amplitude
{
  const amp = 1000;
  const peaks = {};
  for (const kind of ['gust', 'storm', 'tremor', 'crowd']) {
    const f = generateForcing(kind, 500, NIGHT_STEPS, DT, amp);
    peaks[kind] = simulateNightLocked(f, DT).peakSwayCm;
  }
  check('crowd (resonant) forcing produces more sway than gust at equal amplitude', peaks.crowd > peaks.gust);
  check('crowd (resonant) forcing produces more sway than storm at equal amplitude', peaks.crowd > peaks.storm);
  check('crowd (resonant) forcing produces more sway than tremor at equal amplitude', peaks.crowd > peaks.tremor);
  check('crowd is at least 2x the next-worst forcing type at equal amplitude', peaks.crowd > 2 * Math.max(peaks.gust, peaks.storm, peaks.tremor));
}

// 8. comfort windows trigger only under threshold, and only after the hold duration
{
  let cs = createComfortState();
  for (let i = 0; i < 60; i++) cs = updateComfort(cs, COMFORT_THRESHOLD_CM + 5, DT); // 2s over threshold
  check('comfort does not accumulate while sway is over threshold', cs.totalComfortSeconds === 0 && cs.windowsOpened === 0);

  let cs2 = createComfortState();
  const stepsUnderHold = Math.floor((COMFORT_HOLD_SECONDS - 0.5) / DT);
  for (let i = 0; i < stepsUnderHold; i++) cs2 = updateComfort(cs2, 2, DT);
  check('comfort window has not opened before the hold duration is reached', cs2.windowsOpened === 0 && cs2.totalComfortSeconds === 0);

  let cs3 = createComfortState();
  const stepsPastHold = Math.ceil((COMFORT_HOLD_SECONDS + 1) / DT);
  for (let i = 0; i < stepsPastHold; i++) cs3 = updateComfort(cs3, 2, DT);
  check('comfort window opens exactly once after sustained stillness past the hold duration', cs3.windowsOpened === 1 && cs3.totalComfortSeconds > 0);

  let cs4 = createComfortState();
  for (let i = 0; i < stepsPastHold; i++) cs4 = updateComfort(cs4, 2, DT);
  cs4 = updateComfort(cs4, 50, DT); // one bad tick
  check('a single tick over threshold resets the streak', cs4.streak === 0);
}

// 9. floors unlock only once their required stillness has been held
{
  let cs = createComfortState();
  check('no floors reached with zero comfort streak', checkFloors(cs).length === 0);
  cs = { ...cs, streak: FLOORS[0].requiredHold };
  check('first floor reached exactly at its required hold', checkFloors(cs).length === 1 && checkFloors(cs)[0].floor === FLOORS[0].floor);
  cs = { ...cs, streak: FLOORS[FLOORS.length - 1].requiredHold };
  check('all floors reached once the longest required hold is met', checkFloors(cs).length === FLOORS.length);
}

// 10. energy stays bounded (finite) even under a sustained adversarial in-phase policy
{
  const nt = nightByIndex(10);
  const forcing = generateForcing(nt.kind, nt.seed, NIGHT_STEPS * 5, DT, nt.amplitude);
  let s = createTower();
  let finite = true, maxEnergy = 0;
  for (let i = 0; i < forcing.length; i++) {
    const u = inPhasePolicy(s);
    s = step(s, u, forcing[i], DT);
    const E = systemEnergy(s);
    if (!Number.isFinite(E) || !Number.isFinite(s.xt) || !Number.isFinite(s.vt)) { finite = false; break; }
    maxEnergy = Math.max(maxEnergy, E);
  }
  check('system energy stays finite over an extended worst-case adversarial run', finite);
  check('control force stays within its declared cap even under adversarial input', Math.abs(inPhasePolicy({ vt: 1e6 })) <= MAX_CONTROL_FORCE);
}

// 11. simulateNight determinism (same seed -> same result)
{
  const nt = nightByIndex(5);
  const f1 = generateForcing(nt.kind, nt.seed, NIGHT_STEPS, DT, nt.amplitude);
  const f2 = generateForcing(nt.kind, nt.seed, NIGHT_STEPS, DT, nt.amplitude);
  const r1 = simulateNight(f1, DT, antiPhasePolicy);
  const r2 = simulateNight(f2, DT, antiPhasePolicy);
  check('simulateNight is fully deterministic for a fixed seed + policy', r1.peakSwayCm === r2.peakSwayCm && r1.comfort.totalComfortSeconds === r2.comfort.totalComfortSeconds);
}

// 12. phase analyzer: pure unit test against synthetic signals
{
  const n = 200;
  const vt = new Float64Array(n), vdSame = new Float64Array(n), vdOpp = new Float64Array(n), vdRand = new Float64Array(n);
  const rng = mulberry32(9);
  for (let i = 0; i < n; i++) {
    const v = Math.sin(i * 0.3);
    vt[i] = v;
    vdSame[i] = v;
    vdOpp[i] = -v;
    vdRand[i] = rng() * 2 - 1;
  }
  check('phaseCorrelation is ~+1 for perfectly anti-phase motion', approx(phaseCorrelation(vt, vdOpp), 1, 1e-6));
  check('phaseCorrelation is ~-1 for perfectly in-phase motion', approx(phaseCorrelation(vt, vdSame), -1, 1e-6));
  check('phaseCorrelation is near zero for uncorrelated motion', Math.abs(phaseCorrelation(vt, vdRand)) < 0.3);
}

// 13. grade() covers every verdict path (S/A/B/C/D)
{
  check('grade S at peak 0cm, full comfort', gradeNight(0, 40, 40).grade === 'S');
  check('grade A at moderate sway, strong comfort', gradeNight(15, 35, 40).grade === 'A');
  check('grade B at mid sway, mid comfort', gradeNight(30, 25, 40).grade === 'B');
  check('grade C at rough sway, little comfort', gradeNight(50, 15, 40).grade === 'C');
  check('grade D at near-danger sway, zero comfort', gradeNight(90, 0, 40).grade === 'D');
  check('GRADE_BANDS covers exactly 5 tiers', GRADE_BANDS.length === 5);
  const grades = GRADE_BANDS.map((b) => b.grade);
  check('grade tiers are S, A, B, C, D in order', grades.join('') === 'SABCD');
}

// 14. the 10 authored nights are well-formed and escalate within each forcing type
{
  check('exactly 10 authored nights', NIGHTS.length === 10);
  check('nights are numbered 1..10 in order', NIGHTS.every((n, i) => n.night === i + 1));
  const kindsInOrder = NIGHTS.map((n) => n.kind);
  check('nights progress gust -> storm -> tremor -> crowd', kindsInOrder.join(',') === 'gust,gust,gust,storm,storm,storm,tremor,tremor,crowd,crowd');
  let allValid = true;
  for (const nt of NIGHTS) {
    if (typeof nt.headline !== 'string' || nt.headline.length === 0) allValid = false;
    if (!(nt.amplitude > 0)) allValid = false;
    const f = generateForcing(nt.kind, nt.seed, NIGHT_STEPS, DT, nt.amplitude);
    if (f.length !== NIGHT_STEPS) allValid = false;
  }
  check('every night generates a valid forcing series with a real headline', allValid);
}

// 15. endless mode escalates and stays deterministic
{
  const w1a = endlessForcing(1, DT, 300), w1b = endlessForcing(1, DT, 300);
  check('endlessForcing is deterministic for a fixed wave', w1a.every((v, i) => v === w1b[i]));
  // single-wave peaks are noisy (colored-noise forcing), so compare an early
  // bucket's average against a late bucket's average rather than requiring
  // strict wave-over-wave increase.
  const early = [0, 1, 2].map((w) => simulateNightLocked(endlessForcing(w, DT, NIGHT_STEPS), DT).peakSwayCm);
  const late = [9, 10, 11].map((w) => simulateNightLocked(endlessForcing(w, DT, NIGHT_STEPS), DT).peakSwayCm);
  const avg = (arr) => arr.reduce((a, b) => a + b, 0) / arr.length;
  check('endless mode escalates: late waves average clearly higher peak sway than early waves', avg(late) > avg(early) * 1.3);
}

// 16. share text format
{
  const text = shareText(6, 31.4, 'the cake survived the vows');
  check('shareText includes rounded peak sway', text.includes('31cm'));
  check('shareText includes the storyline', text.includes('the cake survived the vows'));
  check('shareText includes the live URL', text.includes('http://damper.defimagic.io'));
  check('shareText names the night\'s forcing kind', text.includes('storm night'));
}

// 17. run-code codec round trip
{
  let allRoundTrip = true;
  for (const n of [1, 5, 10]) {
    for (const seed of [0, 300007, 4294967295]) {
      const code = encodeRunCode(n, seed);
      const decoded = decodeRunCode(code);
      if (!decoded || decoded.nightIndex !== n || decoded.seed !== (seed >>> 0)) allRoundTrip = false;
    }
  }
  check('encodeRunCode/decodeRunCode round-trips for a range of nights and seeds', allRoundTrip);
  check('decodeRunCode rejects malformed input', decodeRunCode('not-a-code') === null);
}

// 18. progress persistence: serialize/deserialize + recordNightResult ratchet
{
  let p = createProgress();
  check('fresh progress starts on night 1', p.unlockedNight === 1);
  p = recordNightResult(p, 1, 'B');
  check('recording a result unlocks the next night', p.unlockedNight === 2);
  p = recordNightResult(p, 1, 'D');
  check('a worse grade on a replay does not overwrite the best grade', p.bestGradeByNight[1] === 'B');
  p = recordNightResult(p, 1, 'S');
  check('a better grade on a replay does overwrite the best grade', p.bestGradeByNight[1] === 'S');
  const raw = serializeProgress(p);
  const restored = deserializeProgress(raw);
  check('progress round-trips through serialize/deserialize', restored.unlockedNight === p.unlockedNight && restored.bestGradeByNight[1] === 'S');
  check('deserializeProgress rejects garbage input', deserializeProgress('{"nope":1}') === null);
}

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
