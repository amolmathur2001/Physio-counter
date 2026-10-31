"use strict";

const $ = (id) => document.getElementById(id);

const store = {
  get(key, fallback) {
    try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage unavailable */ }
  },
};

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

// ---------- Settings ----------

const form = $("settings");
const field = (key) => form.elements[key];
const NUMBER_FIELDS = {
  reps: [1, 200], count_seconds: [0.5, 20], hold_seconds: [0, 120],
  sets: [1, 20], rest_seconds: [0, 600], rate: [0.6, 1.6],
};

function readSettings() {
  const s = { name: field("name").value.trim() || "Exercise", cues: field("cues").value, count_hold: field("count_hold").checked };
  for (const [key, [lo, hi]] of Object.entries(NUMBER_FIELDS)) {
    const n = parseFloat(field(key).value);
    s[key] = clamp(Number.isFinite(n) ? n : lo, lo, hi);
  }
  s.reps = Math.round(s.reps);
  s.sets = Math.round(s.sets);
  return s;
}

function writeSettings(s) {
  for (const key of ["name", "cues", ...Object.keys(NUMBER_FIELDS)]) {
    if (s[key] !== undefined) field(key).value = s[key];
  }
  if (s.count_hold !== undefined) field("count_hold").checked = !!s.count_hold;
  store.set("settings", readSettings());
  onSettingsChanged();
}

function parseCues(text) {
  const cues = {};
  for (const line of (text || "").split("\n")) {
    const m = line.match(/^\s*(\d+)\s*[:=-]\s*(.+)$/);
    if (m) cues[+m[1]] = m[2].trim();
  }
  return cues;
}

// ---------- Step list ----------
// The whole session is a flat list of timed steps; the engine just plays them in order.

function restSteps(seconds, set) {
  const points = [seconds, ...[10, 3, 2, 1].filter((m) => m < seconds)];
  return points.map((p, i) => ({
    kind: "rest", set, rep: 0, restLeft: p,
    say: i === 0 ? `Rest ${seconds} seconds` : p === 10 ? "10 seconds" : String(p),
    dur: (p - (points[i + 1] ?? 0)) * 1000,
  }));
}

function buildSteps(s) {
  const steps = [];
  const cues = parseCues(s.cues);
  const countMs = s.count_seconds * 1000;
  for (let set = 1; set <= s.sets; set++) {
    if (s.sets > 1) steps.push({ kind: "announce", set, rep: 0, say: `Set ${set} of ${s.sets}`, dur: 1800 });
    for (let rep = 1; rep <= s.reps; rep++) {
      steps.push({ kind: "count", set, rep, say: cues[rep] ? `${rep}. ${cues[rep]}` : String(rep), dur: countMs });
      if (s.hold_seconds > 0) {
        if (s.count_hold && s.hold_seconds >= 2) {
          const whole = Math.floor(s.hold_seconds);
          for (let h = 0; h < whole; h++) {
            const left = whole - h;
            steps.push({ kind: "hold", set, rep, say: h === 0 ? "Hold" : String(left), dur: 1000 });
          }
          const extra = (s.hold_seconds - whole) * 1000;
          if (extra > 0) steps[steps.length - 1].dur += extra;
        } else {
          steps.push({ kind: "hold", set, rep, say: "Hold", dur: s.hold_seconds * 1000 });
        }
        steps.push({ kind: "relax", set, rep, say: "And relax", dur: countMs });
      }
    }
    if (set < s.sets && s.rest_seconds > 0) steps.push(...restSteps(s.rest_seconds, set));
  }
  steps.push({ kind: "done", set: s.sets, rep: s.reps, say: "All done. Great work!", dur: 0 });
  return steps;
}

// ---------- Speech out ----------

const recentSpoken = [];

function speak(text) {
  if (!text || !("speechSynthesis" in window)) return;
  recentSpoken.push(text.toLowerCase());
  if (recentSpoken.length > 4) recentSpoken.shift();
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.rate = settings.rate;
  u.lang = navigator.language || "en-US";
  speechSynthesis.speak(u);
}

let speechUnlocked = false;
function unlockSpeech() {
  // iOS only allows speech after a user gesture; a silent utterance unlocks it.
  if (speechUnlocked || !("speechSynthesis" in window)) return;
  speechSynthesis.speak(new SpeechSynthesisUtterance(""));
  speechUnlocked = true;
}

// ---------- Screen wake lock ----------

let wakeLock = null;
async function keepAwake(on) {
  try {
    if (on && !wakeLock && "wakeLock" in navigator) {
      wakeLock = await navigator.wakeLock.request("screen");
      wakeLock.addEventListener("release", () => { wakeLock = null; });
    } else if (!on && wakeLock) {
      await wakeLock.release();
      wakeLock = null;
    }
  } catch { /* not supported or denied; counting still works */ }
}
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && engine.status === "running") keepAwake(true);
});

// ---------- Counter engine ----------

let settings = readSettings();
const engine = { steps: [], i: 0, status: "idle", timer: null, nextAt: 0, stepStart: 0 };

function current() { return engine.steps[engine.i]; }

function clearTimer() { clearTimeout(engine.timer); engine.timer = null; }

function playStep() {
  const step = current();
  if (!step) return;
  speak(step.say);
  const now = performance.now();
  if (engine.nextAt < now - 250) engine.nextAt = now; // we were throttled (screen off); don't rush to catch up
  engine.stepStart = now;
  if (step.kind === "done") {
    engine.status = "done";
    keepAwake(false);
    render();
    return;
  }
  engine.nextAt += step.dur;
  engine.timer = setTimeout(() => { engine.i++; playStep(); }, Math.max(0, engine.nextAt - performance.now()));
  render();
}

function run() {
  clearTimer();
  engine.status = "running";
  engine.nextAt = performance.now();
  keepAwake(true);
  playStep();
}

function start() {
  unlockSpeech();
  if (engine.status === "paused") return resume();
  if (engine.status === "running") return;
  engine.steps = buildSteps(settings);
  engine.i = 0;
  run();
}

function pause() {
  if (engine.status !== "running") return false;
  clearTimer();
  if ("speechSynthesis" in window) speechSynthesis.cancel();
  engine.status = "paused";
  keepAwake(false);
  render();
  return true;
}

function resume() {
  if (engine.status !== "paused") return false;
  run(); // replays the current step from its beginning
  return true;
}

function restart() {
  unlockSpeech();
  engine.steps = buildSteps(settings);
  engine.i = 0;
  run();
}

function stop() {
  clearTimer();
  if ("speechSynthesis" in window) speechSynthesis.cancel();
  engine.status = "idle";
  engine.steps = [];
  engine.i = 0;
  keepAwake(false);
  render();
}

function jumpTo(predicate) {
  const idx = engine.steps.findIndex((s, k) => k > engine.i && predicate(s));
  if (idx < 0) return false;
  engine.i = idx;
  if (engine.status === "running") run();
  else render();
  return true;
}

const nextSet = () => { const cur = current(); return !!cur && jumpTo((s) => s.set > cur.set || s.kind === "done"); };
const skipRest = () => current()?.kind === "rest" && jumpTo((s) => s.kind !== "rest");

// Settings changed mid-session: rebuild the step list and keep the patient's place.
function onSettingsChanged() {
  settings = readSettings();
  store.set("settings", settings);
  if (engine.status === "running" || engine.status === "paused") {
    const cur = current();
    const steps = buildSteps(settings);
    let idx = steps.findIndex((s) => s.set === cur.set && s.rep === cur.rep && s.kind === cur.kind);
    if (idx < 0) idx = steps.findIndex((s) => s.set === cur.set && s.rep >= cur.rep && s.kind === "count");
    if (idx < 0) idx = steps.findIndex((s) => s.set > cur.set || s.kind === "done");
    engine.steps = steps;
    engine.i = idx;
    if (engine.status === "running") run();
  }
  render();
}
form.addEventListener("change", onSettingsChanged);

// ---------- Rendering ----------

function render() {
  const s = settings;
  const step = current();
  const setLabel = s.sets > 1 ? ` · set ${step?.set ?? 1} of ${s.sets}` : "";
  let phase = "Ready", big = "0", bar = 0;

  if (engine.status === "done") {
    phase = "Done! Tap Again to repeat";
    big = String(s.reps);
    bar = 1;
  } else if (step) {
    big = String(step.rep);
    bar = (step.rep - 1 + (step.kind === "count" ? 0.4 : 0.8)) / s.reps;
    const left = Math.max(0, Math.ceil((engine.stepStart + step.dur - performance.now()) / 1000));
    phase = { count: "Count", hold: "Hold", relax: "Relax", announce: `Set ${step.set}` }[step.kind] ?? "";
    if (step.kind === "rest") {
      phase = "Rest";
      big = String(engine.status === "running" ? step.restLeft - Math.floor((performance.now() - engine.stepStart) / 1000) : step.restLeft);
      bar = 1;
    } else if (step.kind === "hold" && engine.status === "running") {
      phase = `Hold… ${left}s`;
    }
    if (engine.status === "paused") phase = `Paused · ${phase}`;
  }

  $("phase").textContent = phase;
  $("bigNumber").textContent = big;
  $("progressText").textContent = step?.kind === "rest" ? `seconds rest${setLabel}` : `of ${s.reps}${setLabel}`;
  $("barFill").style.width = `${Math.round(clamp(bar, 0, 1) * 100)}%`;
  $("routineTitle").textContent = s.name;

  $("mainBtn").textContent =
    engine.status === "running" ? "❚❚ Pause" : engine.status === "paused" ? "▶ Resume" : engine.status === "done" ? "↺ Again" : "▶ Start";
  $("nextSetBtn").hidden = !(s.sets > 1 && (engine.status === "running" || engine.status === "paused") && step?.set < s.sets);
  $("skipRestBtn").hidden = step?.kind !== "rest" || engine.status === "done";
}
setInterval(() => { if (engine.status === "running") render(); }, 250);

$("mainBtn").addEventListener("click", () => {
  if (engine.status === "running") pause();
  else if (engine.status === "done") restart();
  else start();
});
$("restartBtn").addEventListener("click", restart);
$("stopBtn").addEventListener("click", stop);
$("nextSetBtn").addEventListener("click", nextSet);
$("skipRestBtn").addEventListener("click", skipRest);

// ---------- Commands (shared by voice, local matching and AI) ----------

function counterState() {
  const step = current();
  return {
    status: engine.status, exercise: settings.name,
    current_count: step?.rep ?? 0, target_count: settings.reps,
    set: step?.set ?? 1, sets: settings.sets, phase: step?.kind ?? "idle",
    seconds_per_count: settings.count_seconds, hold_seconds: settings.hold_seconds,
  };
}

function dispatch(cmd) {
  const v = Number(cmd.value);
  let say = cmd.say || "";
  switch (cmd.action) {
    case "start":
      if (engine.status === "done") restart(); else start();
      say = ""; // the first count is confirmation enough
      break;
    case "pause": if (!pause()) say = ""; else say ||= "Paused"; break;
    case "resume": if (!resume()) { if (engine.status === "idle") start(); } say = ""; break;
    case "stop": stop(); say ||= "Stopped"; break;
    case "restart": restart(); say = ""; break;
    case "next_set": if (!nextSet()) say = ""; break;
    case "skip_rest": if (!skipRest()) say = ""; break;
    case "change_tempo":
      if (Number.isFinite(v)) { writeSettings({ count_seconds: clamp(Math.round(v * 2) / 2, 0.5, 20) }); say ||= `${settings.count_seconds} seconds per count`; }
      break;
    case "change_target":
      if (Number.isFinite(v)) { writeSettings({ reps: clamp(Math.round(v), 1, 200) }); say ||= `Target ${settings.reps}`; }
      break;
    case "repeat_count": say ||= `${counterState().current_count} of ${settings.reps}`; break;
    default: say = "";
  }
  if (say) speak(say);
}

// Fast, offline matching for the commands people use most. Order matters: "stop and start again" restarts.
const LOCAL_COMMANDS = [
  [/\b(pain|painful|hurts?|hurting|dizzy)\b/, () => ({ action: "pause", say: "Paused. Rest, and check with your physio if it hurts." })],
  [/\b(start over|from the (start|beginning)|again|restart)\b/, () => ({ action: "restart" })],
  [/\b(stop|pause|wait)\b/, () => ({ action: "pause" })],
  [/\b(resume|continue|carry on|keep going)\b/, () => ({ action: "resume" })],
  [/\bnext set\b/, () => ({ action: "next_set" })],
  [/\bskip\b/, () => ({ action: "skip_rest" })],
  [/\b(slower|slow down)\b/, () => ({ action: "change_tempo", value: settings.count_seconds + 0.5 })],
  [/\b(faster|speed up|quicker)\b/, () => ({ action: "change_tempo", value: settings.count_seconds - 0.5 })],
  [/^(start|begin|go|let'?s go)$/, () => ({ action: "start" })],
];

const NUMBER_WORDS = new Set("zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty hold and relax rest seconds set of to too for".split(" "));

// The mic also hears the counter's own voice; drop anything that is just our own words or numbers.
function isEcho(words) {
  const spoken = new Set(recentSpoken.join(" ").split(/[^\p{L}\p{N}']+/u));
  return words.every((w) => /^\d+$/.test(w) || NUMBER_WORDS.has(w) || spoken.has(w));
}

// The server may require an access code. Ask once (only for actions the user started) and remember it.
async function apiFetch(path, options, { askForCode = false } = {}) {
  for (let attempt = 0; ; attempt++) {
    const headers = { ...(options.headers || {}), "X-Access-Code": store.get("accessCode", "") };
    const res = await fetch(path, { ...options, headers });
    if (res.status !== 401 || !askForCode || attempt > 0) return res;
    const code = window.prompt("Enter the access code to use AI features:");
    if (!code) return res;
    store.set("accessCode", code.trim());
  }
}

let aiBusy = false;

async function handleTranscript(raw) {
  const text = raw.toLowerCase().replace(/[^\p{L}\p{N}\s']/gu, " ").replace(/\s+/g, " ").trim();
  if (!text) return;
  const words = text.split(" ");
  if (isEcho(words)) return;

  for (const [pattern, make] of LOCAL_COMMANDS) {
    if (pattern.test(text)) { voiceStatus(`“${text}”`); dispatch(make()); return; }
  }
  if (words.length < 2 || aiBusy) return; // single stray words are usually noise

  aiBusy = true;
  voiceStatus(`“${text}” · thinking…`);
  try {
    const res = await apiFetch("/api/command", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ transcript: text, state: counterState() }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || "AI unavailable");
    voiceStatus(data.action === "none" ? "" : `“${text}” → ${data.action.replace("_", " ")}`);
    dispatch(data);
  } catch (e) {
    voiceStatus(`Didn't catch that (${navigator.onLine ? e.message : "offline"}). Basic commands still work.`);
  } finally {
    aiBusy = false;
  }
}

// ---------- Speech in (hands-free) ----------

const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
let recognizer = null;
let listening = false;

function voiceStatus(msg) { $("voiceStatus").textContent = msg; }

function setListening(on) {
  listening = on;
  $("micBtn").setAttribute("aria-pressed", String(on));
  if (on) {
    try { recognizer.start(); } catch { /* already started */ }
    voiceStatus("Listening… say “stop”, “continue” or “again”");
  } else {
    recognizer?.stop();
    voiceStatus("");
  }
}

if (Recognition) {
  recognizer = new Recognition();
  recognizer.continuous = true;
  recognizer.interimResults = false;
  recognizer.lang = navigator.language || "en-US";
  recognizer.onresult = (e) => {
    for (let k = e.resultIndex; k < e.results.length; k++) {
      if (e.results[k].isFinal) handleTranscript(e.results[k][0].transcript);
    }
  };
  // Browsers end recognition after silence; keep it alive while hands-free is on.
  recognizer.onend = () => { if (listening) setTimeout(() => { try { recognizer.start(); } catch {} }, 250); };
  recognizer.onerror = (e) => {
    if (e.error === "not-allowed" || e.error === "service-not-allowed") {
      setListening(false);
      voiceStatus("Microphone blocked. Allow it in browser settings (needs HTTPS on a phone).");
    }
  };
  $("micBtn").addEventListener("click", () => { unlockSpeech(); setListening(!listening); });
} else {
  $("micBtn").addEventListener("click", () => voiceStatus("Voice commands aren't supported in this browser. Try Chrome or Safari."));
}

// ---------- Saved routines ----------

function renderSaved() {
  const list = store.get("routines", []);
  const ul = $("savedList");
  ul.replaceChildren();
  $("savedEmpty").hidden = list.length > 0;
  list.forEach((r, idx) => {
    const li = document.createElement("li");
    const load = document.createElement("button");
    load.type = "button";
    load.className = "btn small load";
    load.textContent = `${r.name} · ${r.sets}×${r.reps}${r.hold_seconds ? ` · hold ${r.hold_seconds}s` : ""}`;
    load.addEventListener("click", () => { stop(); writeSettings(r); window.scrollTo({ top: 0, behavior: "smooth" }); });
    const del = document.createElement("button");
    del.type = "button";
    del.className = "btn small del";
    del.setAttribute("aria-label", `Delete ${r.name}`);
    del.textContent = "✕";
    del.addEventListener("click", () => {
      store.set("routines", store.get("routines", []).filter((_, k) => k !== idx));
      renderSaved();
    });
    li.append(load, del);
    ul.append(li);
  });
}

function saveRoutine(r) {
  const list = store.get("routines", []).filter((x) => x.name !== r.name);
  list.unshift(r);
  store.set("routines", list);
  renderSaved();
}

$("saveBtn").addEventListener("click", () => {
  saveRoutine(readSettings());
  $("saveBtn").textContent = "✓ Saved";
  setTimeout(() => { $("saveBtn").textContent = "💾 Save as routine"; }, 1500);
});

// ---------- Prescription import (AI) ----------

// Phone photos are large; shrink to a size the AI reads well and that uploads fast.
async function shrinkImage(file, maxSide = 1568) {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext("2d").drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  return new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.85));
}

function exerciseToSettings(ex) {
  return {
    name: ex.side && !["none", "both"].includes(ex.side) ? `${ex.name} (${ex.side === "each" ? "each side" : ex.side})` : ex.name,
    reps: ex.reps, sets: ex.sets, count_seconds: ex.count_seconds,
    hold_seconds: ex.hold_seconds, rest_seconds: ex.rest_seconds, cues: "",
  };
}

function renderPrescription(exercises) {
  const box = $("rxResults");
  box.replaceChildren();
  for (const ex of exercises) {
    const r = exerciseToSettings(ex);
    const card = document.createElement("div");
    card.className = "rx-card";
    const h = document.createElement("h3");
    h.textContent = r.name;
    const dose = document.createElement("div");
    dose.className = "dose";
    dose.textContent = `${r.sets} × ${r.reps} · ${r.count_seconds}s per count${r.hold_seconds ? ` · hold ${r.hold_seconds}s` : ""}${r.sets > 1 ? ` · rest ${r.rest_seconds}s` : ""}`;
    card.append(h, dose);
    if (ex.notes) {
      const notes = document.createElement("p");
      notes.className = "notes";
      notes.textContent = ex.notes;
      card.append(notes);
    }
    const use = document.createElement("button");
    use.type = "button";
    use.className = "btn small";
    use.textContent = "Use now";
    use.addEventListener("click", () => { stop(); writeSettings(r); window.scrollTo({ top: 0, behavior: "smooth" }); });
    const save = document.createElement("button");
    save.type = "button";
    save.className = "btn small";
    save.textContent = "Save";
    save.addEventListener("click", () => { saveRoutine(r); save.textContent = "✓ Saved"; save.disabled = true; });
    const row = document.createElement("div");
    row.className = "controls-2";
    row.append(use, save);
    card.append(row);
    box.append(card);
  }
}

$("rxForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const status = $("rxStatus");
  const fd = new FormData();
  const text = e.target.elements.text.value.trim();
  const file = e.target.elements.image.files[0];
  if (!text && !file) { status.textContent = "Add some text or a photo first."; return; }
  if (text) fd.append("text", text);
  status.className = "hint";
  status.textContent = "Reading prescription…";
  $("rxResults").replaceChildren();
  try {
    if (file) fd.append("image", await shrinkImage(file), "prescription.jpg");
    const res = await apiFetch("/api/prescription", { method: "POST", body: fd }, { askForCode: true });
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || "Something went wrong");
    if (!data.exercises.length) { status.textContent = "No exercises found. Try a clearer photo or type it in."; return; }
    status.textContent = `Found ${data.exercises.length} exercise${data.exercises.length > 1 ? "s" : ""}. Check them against your sheet.`;
    renderPrescription(data.exercises);
  } catch (err) {
    status.className = "hint error";
    status.textContent = navigator.onLine ? err.message : "You're offline. Import needs internet; counting works offline.";
  }
});

// ---------- Boot ----------

writeSettings(store.get("settings", {}));
renderSaved();
render();

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("sw.js").catch(() => {});
}
