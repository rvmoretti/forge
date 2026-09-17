#!/usr/bin/env node
/**
 * forge — state CLI for the Forge plugin (v0)
 *
 * The single writer for Forge project state. Work items, verification
 * records, attempts, baseline, decisions and discoveries all change
 * through this tool so that the rules the orchestrator must follow are
 * enforced by code, not memory.
 *
 * No dependencies. Node >= 18.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

// ---------------------------------------------------------------------------
// paths & io
// ---------------------------------------------------------------------------

const PROJECT = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const FORGE = path.join(PROJECT, 'forge');
const STATE = path.join(FORGE, 'state');
const CONFIG_FILE = path.join(FORGE, 'config.json');
const WORK_FILE = path.join(STATE, 'work.json');
const PREFLIGHT_FILE = path.join(STATE, 'preflight.json');
const BASELINE_FILE = path.join(STATE, 'baseline.json');
const DECISIONS_FILE = path.join(FORGE, 'decisions.md');
const DISCOVERIES_FILE = path.join(FORGE, 'discoveries.md');
const SESSION_FILE = path.join(STATE, 'session.json');
const TRACE_FILE = path.join(STATE, 'trace.jsonl');
const PLUGIN_ROOT = path.resolve(__dirname, '..');
const LOCK_TTL_MS = 15 * 60 * 1000; // an orchestrator that hasn't written in 15min is presumed gone
const DEBUG = process.env.FORGE_DEBUG === '1';
let VERSION = '?';
try { VERSION = JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, '.claude-plugin', 'plugin.json'), 'utf8')).version; } catch (_) { }

function ts() { return new Date().toISOString(); }

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) {
    if (e.code === 'ENOENT') return fallback;
    die(`State file ${path.relative(PROJECT, file)} is unreadable or corrupt: ${e.message}\n` +
        `Do not overwrite it. Inspect it, recover from git history if needed.`);
  }
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n');
  fs.renameSync(tmp, file); // atomic-ish transaction
}

function appendMd(file, header, block) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (!fs.existsSync(file)) fs.writeFileSync(file, header + '\n');
  fs.appendFileSync(file, block + '\n');
}

function die(msg, code = 1) {
  traceEvent({ outcome: 'refused', exit: code, refusal: String(msg).split('\n')[0].slice(0, 240) });
  process.stderr.write(msg + '\n'); process.exit(code);
}

// -- trace (v0.7): always-on flight recorder; FORGE_DEBUG=1 adds payloads -----
const T0 = Date.now();
let TRACED = false;
function traceWrite(obj) {
  try {
    // never create forge/ as a side effect in an uninitialized directory
    if (!fs.existsSync(FORGE) && (process.argv[2] || '') !== 'init') return;
    fs.mkdirSync(STATE, { recursive: true });
    try { if (fs.statSync(TRACE_FILE).size > 2 * 1024 * 1024) fs.renameSync(TRACE_FILE, TRACE_FILE + '.old'); } catch (_) { }
    fs.appendFileSync(TRACE_FILE, JSON.stringify(obj) + '\n');
  } catch (_) { /* tracing never breaks the CLI */ }
}
function traceEvent(fields) {
  if (TRACED) return; TRACED = true;
  traceWrite(Object.assign(
    { ts: new Date().toISOString(), v: VERSION, cmd: process.argv.slice(2).join(' ').slice(0, 300), ms: Date.now() - T0 },
    fields));
}
process.on('exit', (code) => traceEvent({ outcome: code === 0 ? 'ok' : 'exit', exit: code }));
function out(msg) { process.stdout.write(msg + '\n'); }

function loadConfig() { return readJson(CONFIG_FILE, null); }
function loadWork() { if (MUTATING) acquireWorkLock(); return readJson(WORK_FILE, { schema: 1, items: {}, order: [] }); }
function saveWork(w) { writeJson(WORK_FILE, w); regenDashboard(); }

// -- state-write lock (v0.12): serialise load→mutate→save across processes ---
// Two concurrent forge invocations doing read-modify-write on work.json would
// silently lose one update (writeJson is atomic per write, not per transaction).
// Mutating commands take this lock at first loadWork() and hold it to exit.
const WORK_LOCK = path.join(STATE, 'work.lock');
const LOCK_WAIT_MS = parseInt(process.env.FORGE_LOCK_WAIT_MS || '', 10) || 5000;
const LOCK_STALE_MS = parseInt(process.env.FORGE_LOCK_STALE_MS || '', 10) || 10 * 60 * 1000;
let LOCK_HELD = false;
const MUTATING = (() => {
  const c = process.argv[2] || '', s = process.argv[3] || '';
  if (c === 'init') return true;
  if (c === 'task') return !['list', 'show', ''].includes(s);
  if (c === 'milestone') return ['security', 'approve', 'reopen'].includes(s);
  if (c === 'component') return ['add', 'update'].includes(s);
  return false;
})();
function pidAlive(pid) { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } }
function sleepMs(ms) {
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }
  catch (_) { const end = Date.now() + ms; while (Date.now() < end) { /* spin fallback */ } }
}
function acquireWorkLock() {
  if (LOCK_HELD) return;
  try { fs.mkdirSync(STATE, { recursive: true }); } catch (_) { }
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      fs.writeFileSync(WORK_LOCK, JSON.stringify({ pid: process.pid, ts: ts(), cmd: process.argv.slice(2).join(' ').slice(0, 160) }), { flag: 'wx' });
      LOCK_HELD = true; return;
    } catch (e) {
      if (e.code !== 'EEXIST') { LOCK_HELD = true; return; } // fs oddity — fail open; never brick the CLI on its own guard
      let holder = null; try { holder = JSON.parse(fs.readFileSync(WORK_LOCK, 'utf8')); } catch (_) { }
      const age = holder && Number.isFinite(Date.parse(holder.ts)) ? Date.now() - Date.parse(holder.ts) : Infinity;
      if (!holder || !pidAlive(holder.pid) || age > LOCK_STALE_MS) {
        try { fs.unlinkSync(WORK_LOCK); } catch (_) { }
        traceWrite({ ts: new Date().toISOString(), v: VERSION, cmd: process.argv.slice(2).join(' ').slice(0, 300),
          outcome: 'lock-break', holder: holder || 'unreadable' });
        continue;
      }
      if (Date.now() >= deadline)
        die(`Refused: forge state is write-locked by another forge process (pid ${holder.pid}: '${holder.cmd}', since ${holder.ts}).\n` +
            `Two concurrent state writes would silently lose one — this refusal is the alternative.\n` +
            `Wait for it to finish and retry. (A dead process's lock breaks automatically; stale ceiling: ${Math.round(LOCK_STALE_MS / 60000)}min.)`);
      sleepMs(100);
    }
  }
}
function releaseWorkLock() { if (LOCK_HELD) { try { fs.unlinkSync(WORK_LOCK); } catch (_) { } LOCK_HELD = false; } }
process.on('exit', releaseWorkLock);

// -- orchestrator session lock (v0.5): one active orchestrator per project ----
function loadLock() { try { return JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8')); } catch (_) { return null; } }
function saveLock(l) { try { fs.mkdirSync(STATE, { recursive: true }); fs.writeFileSync(SESSION_FILE, JSON.stringify(l, null, 2) + '\n'); } catch (_) { /* hooks never crash */ } }
function lockFresh(l) {
  if (!l || l.released) return false;
  const beat = Date.parse(l.lastBeat || 0);
  return Number.isFinite(beat) && (Date.now() - beat) < LOCK_TTL_MS;
}
function lockAge(l) {
  const beat = Date.parse((l || {}).lastBeat || 0);
  if (!Number.isFinite(beat)) return '?';
  const s = Math.round((Date.now() - beat) / 1000);
  return s < 120 ? `${s}s ago` : `${Math.round(s / 60)}min ago`;
}

function run(cmd, opts = {}) {
  const t0 = Date.now();
  const r = spawnSync(cmd, { shell: true, cwd: PROJECT, encoding: 'utf8',
    timeout: opts.timeout || 600000, maxBuffer: 16 * 1024 * 1024 });
  const outText = ((r.stdout || '') + (r.stderr || '')).trim();
  return {
    cmd,
    exit: r.status === null ? -1 : r.status,
    tail: outText.split('\n').slice(-40).join('\n'),
    ms: Date.now() - t0 // v0.13: verification time becomes observable in evidence records
  };
}

// v0.13: the first milestone with unfinished items — warnings target it, not the backlog
function activeMilestone(w) {
  for (const m of milestoneSeq(w)) if (!milestoneComplete(w, m)) return m;
  return null;
}

// ---------------------------------------------------------------------------
// dashboard (generated projection — never authoritative; state always wins)
// ---------------------------------------------------------------------------

const DASHBOARD_FILE = path.join(FORGE, 'dashboard.html');
const COMPONENTS_FILE = path.join(STATE, 'components.json');

function esc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function parseLog(file, limit) {
  try {
    const entries = fs.readFileSync(file, 'utf8').split('\n### ').slice(1)
      .map(b => { const lines = b.split('\n'); return { title: lines[0].trim(), body: lines.slice(1).filter(l => l.trim()).join('\n') }; });
    return entries.slice(-limit).reverse();
  } catch (_) { return []; }
}

function regenDashboard() {
  try { generateDashboard(); } catch (_) { /* dashboard is best-effort; never block state ops */ }
}

function generateDashboard() {
  const cfg = readJson(CONFIG_FILE, null);
  if (!cfg) return; // no project yet
  const w = readJson(WORK_FILE, { items: {}, order: [] });
  const pf = readJson(PREFLIGHT_FILE, null);
  const base = readJson(BASELINE_FILE, null);
  const decisions = parseLog(DECISIONS_FILE, 12);
  const discoveries = parseLog(DISCOVERIES_FILE, 12);

  const counts = { TODO: 0, IN_PROGRESS: 0, BLOCKED: 0, DONE: 0, CANCELLED: 0 };
  let ready = 0;
  const byMilestone = {};
  for (const id of w.order) {
    const t = w.items[id];
    counts[t.status] = (counts[t.status] || 0) + 1;
    const isReady = t.status === 'TODO' && t.deps.every(d => !w.items[d] || w.items[d].status === 'DONE') && t.criteria.length > 0 && ((t.scope || {}).allowed || []).length > 0;
    if (isReady) ready++;
    const m = t.milestone || '(no milestone)';
    (byMilestone[m] = byMilestone[m] || []).push({ t, isReady });
  }
  const total = w.order.length;
  const pct = total ? Math.round(100 * counts.DONE / total) : 0;

  const sColor = { DONE: '#15803d', IN_PROGRESS: '#3b3f8f', BLOCKED: '#b91c1c', TODO: '#57606f', CANCELLED: '#9aa0ad', READY: '#0f766e' };
  const chip = (label, color) =>
    `<span style="display:inline-block;font-size:10.5px;font-weight:700;letter-spacing:.04em;padding:1px 8px;border-radius:99px;border:1px solid ${color}44;color:${color};background:${color}12">${esc(label)}</span>`;
  // v0.13.1: components loaded early — milestone sections show which components they touch
  const comps = readJson(COMPONENTS_FILE, { schema: 1, components: {} }).components;
  const kindColor = { frontend: '#3b3f8f', backend: '#0f766e', db: '#b45309', job: '#57606f', integration: '#7c3aed' };
  const compChip = (cid) => chip(cid, kindColor[(comps[cid] || {}).kind] || '#57606f');

  // spec files
  let specRows = '';
  if (cfg.specDir && fs.existsSync(path.join(PROJECT, cfg.specDir))) {
    try {
      specRows = fs.readdirSync(path.join(PROJECT, cfg.specDir)).filter(f => !f.startsWith('.')).map(f => {
        const st = fs.statSync(path.join(PROJECT, cfg.specDir, f));
        return `<tr><td><code>${esc(f)}</code></td><td class="mut">${st.isDirectory() ? 'dir' : (st.size + ' B')}</td><td class="mut">${new Date(st.mtimeMs).toISOString().slice(0, 16).replace('T', ' ')}</td></tr>`;
      }).join('');
    } catch (_) { /* ignore */ }
  }

  const actM = activeMilestone(w);
  const milestoneBlocks = Object.entries(byMilestone).map(([m, items]) => {
    const gate = (w.gates || {})[m];
    const allClosed = items.every(x => ['DONE', 'CANCELLED'].includes(x.t.status));
    const gateChip = m === '(no milestone)' ? '' :
      gate && gate.approved ? chip('GATE APPROVED', '#15803d') :
      allClosed ? chip('AWAITING HUMAN APPROVAL', '#b45309') : chip('gate pending', '#57606f');
    // v0.13: collapsible — the milestone that needs attention opens, closed ones fold away
    const openAttr = (m === actM || m === '(no milestone)' || (allClosed && !(gate && gate.approved))) ? ' open' : '';
    const done = items.filter(x => x.t.status === 'DONE').length;
    const rows = items.map(({ t, isReady }) => {
      const fails = t.attempts.filter(a => a.outcome === 'failed').length;
      const lastV = t.verifications.length ? t.verifications[t.verifications.length - 1] : null;
      // v0.13.1: everything known about the item, one click away — plus the saved brief when it exists
      const disp = t.dispatches || [];
      const launches = disp.filter(d => d.kind !== 'message');
      const msgs = disp.length - launches.length;
      const agents = [...new Set(disp.map(d => d.agent).filter(Boolean))];
      const hasBrief = t.id && fs.existsSync(path.join(FORGE, 'briefs', `${t.id}.md`));
      const card = `<details class="icd"><summary>details${hasBrief ? ' · 📄 brief' : ''}</summary><div class="icdb">
        ${t.objective ? `<p><b>Objective</b> — ${esc(t.objective)}</p>` : ''}
        <p><b>Acceptance criteria</b></p><ol>${t.criteria.length ? t.criteria.map(c => `<li>${esc(c.desc)}${c.check ? ` — <code>${esc(c.check)}</code>` : ' <span class="mut">(no machine check)</span>'}</li>`).join('') : '<li class="mut">none yet (thin item — added when its milestone approaches)</li>'}</ol>
        <p><b>Scope</b> — ${((t.scope || {}).allowed || []).length ? `<code>${esc(t.scope.allowed.join(', '))}</code>` : '<span class="mut">not set</span>'}${((t.scope || {}).forbidden || []).length ? ` · forbidden: <code>${esc(t.scope.forbidden.join(', '))}</code>` : ''}${t.component ? ` · component: ${compChip(t.component)}` : ''}</p>
        ${disp.length ? `<p><b>Dispatches</b> — ${launches.length} launch(es)${msgs ? `, ${msgs} mid-flight message(s)` : ''}${agents.length ? ` · ${agents.map(esc).join(', ')}` : ''}</p>` : ''}
        ${lastV ? `<p><b>Last verification</b> — ${lastV.passed ? 'passed' : 'failed'} ${esc(lastV.ts.slice(0, 16).replace('T', ' '))}${lastV.durationMs ? ` · ran ${Math.round(lastV.durationMs / 1000)}s` : ''}${(lastV.artifacts || []).length ? ` · evidence: ${lastV.artifacts.map(a => `<a href="../${esc(a)}">${esc(a)}</a>`).join(' · ')}` : ''}</p>` : ''}
        ${hasBrief ? `<p>📄 <a href="briefs/${esc(t.id)}.md"><b>Read the full brief</b></a></p>` : ''}
      </div></details>`;
      return `<tr>
        <td>${chip(isReady ? 'READY' : t.status, sColor[isReady ? 'READY' : t.status] || '#57606f')}</td>
        <td><b>${esc(t.id || '')}</b> ${esc(t.title)}${t.status === 'BLOCKED' ? `<div class="mut">⛔ ${esc(t.blockReason)}</div>` : ''}${t.status === 'CANCELLED' ? `<div class="mut">✕ ${esc(t.cancelReason)}</div>` : ''}${!((t.scope || {}).allowed || []).length && !['DONE', 'CANCELLED'].includes(t.status) && (m === actM || m === '(no milestone)') ? `<div class="mut" style="color:#b45309">⚠ no file scope — start will refuse (task update --allowed)</div>` : ''}${card}</td>
        <td class="mut">${t.deps.length ? t.deps.map(esc).join(', ') : '—'}</td>
        <td class="mut">${t.criteria.length}${t.criteria.some(c => c.check) ? ' ✓' : ''}</td>
        <td>${fails ? chip(fails + ' failed', '#b45309') : '<span class="mut">—</span>'}</td>
        <td>${lastV ? chip(lastV.passed ? 'passed' : 'failed', lastV.passed ? '#15803d' : '#b91c1c') + `<span class="mut" style="margin-left:6px">${esc(lastV.ts.slice(0, 16).replace('T', ' '))}</span>` : '<span class="mut">never</span>'}</td>
      </tr>`;
    }).join('');
    // v0.13.1: which components this milestone touches — "what gets touched when" at a glance
    const mComps = [...new Set(items.map(x => x.t.component).filter(Boolean))];
    return `<details class="sec sub"${openAttr}><summary>${esc(m)} <span class="mut">${done}/${items.length} done</span> ${gateChip}${mComps.length ? ` <span class="mchips">${mComps.map(compChip).join(' ')}</span>` : ''}</summary>
      <div class="tblwrap" style="margin-top:8px"><table><thead><tr><th>Status</th><th>Item</th><th>Deps</th><th>Criteria</th><th>Attempts</th><th>Last verification</th></tr></thead><tbody>${rows}</tbody></table></div></details>`;
  }).join('');

  // v0.10: project map — one box per registered component
  let mapBlock = '';
  if (Object.keys(comps).length) {
    const boxes = Object.values(comps).map(c => {
      const items = w.order.map(id => w.items[id]).filter(t => t.component === c.id);
      // v0.13.1: when is this component touched next?
      let nextM = null;
      for (const m2 of milestoneSeq(w)) {
        if (w.order.some(id => { const t2 = w.items[id]; return t2.component === c.id && t2.milestone === m2 && !['DONE', 'CANCELLED'].includes(t2.status); })) { nextM = m2; break; }
      }
      const done = items.filter(t => t.status === 'DONE').length;
      const inProg = items.filter(t => t.status === 'IN_PROGRESS');
      const blocked = items.filter(t => t.status === 'BLOCKED');
      const fails = items.reduce((a, t) => a + t.attempts.filter(x => x.outcome === 'failed').length, 0);
      // latest image evidence: the component's mock, else the newest screenshot artifact
      let img = c.mock || null;
      for (const t of items) for (const v of t.verifications) for (const a of (v.artifacts || []))
        if (/\.(png|jpe?g|webp|gif)$/i.test(a)) img = a;
      const imgTag = img && fs.existsSync(path.join(PROJECT, img))
        ? `<a href="../${esc(img)}"><img src="../${esc(img)}" alt="${esc(c.name)}" style="width:100%;max-height:110px;object-fit:cover;object-position:top;border-radius:8px;border:1px solid #e6e4de;margin-top:8px"></a>` : '';
      const pctC = items.length ? Math.round(100 * done / items.length) : 0;
      return `<div class="card" style="min-width:220px;max-width:280px;flex:1">
        <div style="display:flex;justify-content:space-between;gap:8px;align-items:baseline">
          <b style="font-size:14px">${esc(c.name)}</b>${chip(c.kind, kindColor[c.kind] || '#57606f')}
        </div>
        ${c.route ? `<div class="mut"><code>${esc(c.route)}</code></div>` : ''}
        <div class="bar" style="margin:8px 0 4px"><div style="width:${pctC}%"></div></div>
        <div class="mut">${done}/${items.length} done${inProg.length ? ` · <b style="color:#3b3f8f">${inProg.map(t => esc(t.id)).join(',')} in progress</b>` : ''}${blocked.length ? ` · <b style="color:#b91c1c">${blocked.length} blocked</b>` : ''}${fails ? ` · ${fails} failed attempt(s)` : ''}${nextM ? ` · next touched: <b>${esc(nextM)}</b>` : (items.length ? ' · no open work' : '')}</div>
        ${c.doc ? `<div class="mut">📄 <code>${esc(c.doc)}</code></div>` : ''}
        ${imgTag}
      </div>`;
    }).join('');
    const untagged = w.order.filter(id => !w.items[id].component).length;
    mapBlock = `<details class="sec" open><summary>Project map <span class="mut">(components — forge component add/update · items tagged via --component)</span></summary>
      <div class="cards" style="align-items:stretch">${boxes}</div>
      ${untagged ? `<p class="mut">${untagged} work item(s) not tagged to any component.</p>` : ''}</details>`;
  }

  // v0.12.1: telemetry — development time LIVE from state timestamps; tokens
  // from the last `forge usage --write` snapshot (never parsed live: log
  // parsing on every regen would slow every state operation).
  let telemetryBlock = '';
  {
    const med = arr => { if (!arr.length) return null; const s2 = [...arr].sort((a, b) => a - b); return s2[Math.floor(s2.length / 2)]; };
    const fmtDur = ms2 => ms2 == null ? '—' : (ms2 < 90000 ? Math.round(ms2 / 1000) + 's' : (ms2 < 5400000 ? Math.round(ms2 / 60000) + 'm' : (ms2 / 3600000).toFixed(1) + 'h'));
    const TRIM = 2 * 60 * 60 * 1000; // windows over 2h = session break / human idle, excluded
    const perAgent = {}; const itemSpans = []; const verifDurs = [];
    // v0.13 time taxonomy: verification runtime (from evidence records) + human gate wait
    for (const id of w.order) for (const v3 of (w.items[id].verifications || [])) if (v3.durationMs) verifDurs.push(v3.durationMs);
    const gateWaits = [];
    for (const m3 of milestoneSeq(w)) {
      const g3 = (w.gates || {})[m3];
      if (!g3 || !g3.approved || !g3.ts) continue;
      let lastPass = null;
      for (const id of w.order) {
        const t3 = w.items[id];
        if (t3.milestone !== m3) continue;
        for (const a3 of (t3.attempts || [])) if (a3.outcome === 'passed') {
          const x = Date.parse(a3.ts); if (Number.isFinite(x) && (!lastPass || x > lastPass)) lastPass = x;
        }
      }
      if (lastPass) { const wm = Date.parse(g3.ts) - lastPass; if (wm > 0) gateWaits.push(`${esc(m3)} ${fmtDur(wm)}`); }
    }
    for (const id of w.order) {
      const t = w.items[id];
      const startedTs = (t.attempts || []).filter(a => a.outcome === 'started').map(a => Date.parse(a.ts)).filter(Number.isFinite);
      const passedTs = (t.attempts || []).filter(a => a.outcome === 'passed').map(a => Date.parse(a.ts)).filter(Number.isFinite);
      if (startedTs.length && passedTs.length) {
        const span = Math.max(...passedTs) - Math.min(...startedTs);
        if (span > 0 && span < TRIM) itemSpans.push(span);
      }
      for (const d of (t.dispatches || [])) {
        const a = d.agent || '(agent not named)';
        const rec = perAgent[a] = perAgent[a] || { launches: 0, msgs: 0, prep: [], exec: [] };
        if (d.kind === 'message') { rec.msgs++; continue; }
        rec.launches++;
        const dts = Date.parse(d.ts); if (!Number.isFinite(dts)) continue;
        const prevStart = startedTs.filter(x => x <= dts).sort((x, y) => x - y).pop();
        if (prevStart != null) { const p = dts - prevStart; if (p >= 0 && p < TRIM) rec.prep.push(p); }
        const nextVer = (t.verifications || []).map(v2 => Date.parse(v2.ts)).filter(x => Number.isFinite(x) && x >= dts).sort((x, y) => x - y)[0];
        if (nextVer != null) { const e = nextVer - dts; if (e >= 0 && e < TRIM) rec.exec.push(e); }
      }
    }
    const agentRows = Object.entries(perAgent).map(([a, r]) =>
      `<tr><td><code>${esc(a)}</code></td><td class="mut">${r.launches}${r.msgs ? ` (+${r.msgs} msg)` : ''}</td><td>${fmtDur(med(r.prep))}</td><td>${fmtDur(med(r.exec))}</td></tr>`).join('');
    const timePanel =
      `<div><h3>Development time <span class="mut" style="font-weight:400">(live from state — wall-clock, not agent runtime)</span></h3>
      <div class="tblwrap"><table><thead><tr><th>Agent</th><th>Dispatches</th><th>Median prep (start→dispatch)</th><th>Median execution (dispatch→verify)</th></tr></thead>
      <tbody>${agentRows || `<tr><td colspan="4" class="mut">No dispatch records yet — they accumulate as items run under v0.12+ (forge task dispatch).</td></tr>`}</tbody></table></div>
      <p class="mut" style="margin-top:6px">Median item start→done: <b>${fmtDur(med(itemSpans))}</b>${itemSpans.length ? ` (${itemSpans.length} item(s))` : ''} · median verification run: <b>${fmtDur(med(verifDurs))}</b>${gateWaits.length ? ` · human gate wait: <b>${gateWaits.join(' · ')}</b>` : ''} · trimmed medians — windows over 2h excluded as session breaks. Execution is the window the worker ran in, bracketed by CLI events; the worker's exact runtime lives only in transcripts (see forge usage).</p></div>`;
    const usageSnap = readJson(path.join(STATE, 'usage.json'), null);
    let tokenPanel;
    if (usageSnap) {
      let tokenRows = '';
      for (const [model, threads] of Object.entries(usageSnap.models || {}))
        for (const [thread, t2] of Object.entries(threads))
          tokenRows += `<tr><td><code>${esc(model)}</code> <span class="mut">[${thread === 'main' ? 'orchestrator' : 'workers'}]</span></td><td class="mut">${t2.calls || 0}</td><td>${(t2.out || 0).toLocaleString()}</td><td class="mut">${(t2.in || 0).toLocaleString()}</td></tr>`;
      const byType = Object.entries(usageSnap.byType || {}).map(([k, v2]) => `${esc(k)}×${v2}`).join(' · ');
      const totOut = (usageSnap.mainOut || 0) + (usageSnap.sideOut || 0);
      tokenPanel =
        `<div><h3>Tokens <span class="mut" style="font-weight:400">(observed — snapshot as of ${esc(String(usageSnap.ts || '?').slice(0, 16).replace('T', ' '))})</span></h3>
        <div class="tblwrap"><table><thead><tr><th>Model [thread]</th><th>Calls</th><th>Output</th><th>Input</th></tr></thead><tbody>${tokenRows || '<tr><td colspan="4" class="mut">empty snapshot</td></tr>'}</tbody></table></div>
        <p class="mut" style="margin-top:6px">Output — orchestrator: <b>${(usageSnap.mainOut || 0).toLocaleString()}</b> · workers: <b>${(usageSnap.sideOut || 0).toLocaleString()}</b>${totOut ? ` (${Math.round(100 * (usageSnap.sideOut || 0) / totOut)}% delegated)` : ''}${byType ? ` · dispatches: ${byType}` : ''}.
        Per-agent token attribution inside worker threads is not exposed by the logs — absent data is absent, never estimated. Refresh: <code>forge usage --write</code>.</p></div>`;
    } else {
      tokenPanel = `<div><h3>Tokens</h3><p class="mut">No usage snapshot yet — run <code>forge usage --write</code> (zero tokens, any terminal) and this panel fills in.</p></div>`;
    }
    telemetryBlock = `<details class="sec" open><summary>Telemetry <span class="mut">(time live from state · tokens from the last usage snapshot)</span></summary><div class="grid2" style="margin-top:8px">${timePanel}${tokenPanel}</div></details>`;
  }

  const logBlock = (entries, empty) => entries.length
    ? entries.map(e => `<div class="log"><b>${esc(e.title)}</b><pre>${esc(e.body)}</pre></div>`).join('')
    : `<p class="mut">${empty}</p>`;

  const pfBlock = pf
    ? pf.results.map(r => `<tr><td>${chip(r.ok ? 'OK' : r.severity.toUpperCase(), r.ok ? '#15803d' : (r.severity === 'mandatory' ? '#b91c1c' : '#b45309'))}</td><td>${esc(r.name)}</td><td class="mut">${esc(r.note)}</td></tr>`).join('')
    : '<tr><td colspan="3" class="mut">never run</td></tr>';

  const baseBlock = base
    ? base.results.map(r => `<tr><td>${chip(r.exit === 0 ? 'GREEN' : 'RED (pre-existing)', r.exit === 0 ? '#15803d' : '#b45309')}</td><td>${esc(r.kind)}</td><td class="mut"><code>${esc(r.cmd)}</code></td></tr>`).join('')
    : '<tr><td colspan="3" class="mut">not captured (greenfield, or run: forge baseline capture)</td></tr>';

  const html = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Forge — ${esc(cfg.project)}</title>
<link rel="icon" type="image/png" href="data:image/png;base64,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">
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;background:#faf9f6;color:#1a1d27;line-height:1.5;padding:36px 20px 70px}
.wrap{max-width:1100px;margin:0 auto}
h1{font-size:24px;letter-spacing:-.02em} h2{font-size:17px;margin:28px 0 10px} h3{font-size:14.5px;margin:16px 0 8px}
.mut{color:#6b7080;font-size:12.5px}
code{font-family:ui-monospace,Menlo,monospace;font-size:.9em;background:#f0efe9;border-radius:4px;padding:1px 4px}
.head{display:flex;justify-content:space-between;align-items:flex-end;gap:16px;flex-wrap:wrap;margin-bottom:6px}
.bar{height:8px;background:#e6e4de;border-radius:99px;overflow:hidden;margin:10px 0 4px}
.bar div{height:100%;background:#15803d;border-radius:99px}
.cards{display:flex;gap:12px;flex-wrap:wrap;margin:14px 0}
.card{background:#fff;border:1px solid #e6e4de;border-radius:12px;padding:10px 16px;min-width:96px}
.card b{font-size:20px;font-variant-numeric:tabular-nums} .card span{display:block;font-size:11px;color:#6b7080;text-transform:uppercase;letter-spacing:.05em}
.tblwrap{overflow-x:auto;background:#fff;border:1px solid #e6e4de;border-radius:12px}
table{width:100%;border-collapse:collapse;font-size:13px}
th{font-size:10.5px;text-transform:uppercase;letter-spacing:.06em;color:#6b7080;text-align:left;padding:8px 12px;border-bottom:1px solid #e6e4de}
td{padding:8px 12px;border-bottom:1px solid #f0efe9;vertical-align:top} tr:last-child td{border-bottom:none}
.log{background:#fff;border:1px solid #e6e4de;border-radius:10px;padding:10px 14px;margin-bottom:8px;font-size:13px}
.log pre{font-family:inherit;white-space:pre-wrap;color:#464b58;font-size:12.5px;margin-top:2px}
.grid2{display:grid;grid-template-columns:1fr 1fr;gap:20px}@media(max-width:840px){.grid2{grid-template-columns:1fr}}
.stamp{font-size:11.5px;color:#9aa0ad}
details.sec{margin:20px 0 6px}
details.sec>summary{cursor:pointer;user-select:none;font-weight:650;font-size:17px;padding:8px 10px;letter-spacing:-.01em;border-radius:10px;transition:background .12s}
details.sec>summary:hover{background:#f0efe9;color:#3b3f8f}
details.sec>summary .mut{font-weight:400}
details.sec.sub{margin:10px 0}
details.sec.sub>summary{font-size:14.5px;padding:6px 10px}
details.sec>summary::marker{color:#9aa0ad}
.mchips{margin-left:8px}
details.icd{margin-top:5px}
details.icd>summary{cursor:pointer;font-size:11.5px;color:#6b7080;user-select:none;width:max-content;padding:1px 6px;border:1px solid #e6e4de;border-radius:6px;background:#faf9f6}
details.icd>summary:hover{color:#3b3f8f;border-color:#3b3f8f55}
details.icd[open]>summary{color:#3b3f8f}
.icdb{background:#faf9f6;border:1px solid #e6e4de;border-radius:10px;padding:10px 14px;margin-top:6px;font-size:12.5px;color:#464b58}
.icdb p{margin:4px 0}
.icdb ol{margin:2px 0 6px 18px;padding:0}
.icdb li{margin:2px 0}
.tblwrap,.card,.log{box-shadow:0 1px 2px rgba(26,29,39,.04)}
tbody tr{transition:background .1s}
tbody tr:hover{background:#faf9f2}
.filter{width:100%;max-width:380px;font:inherit;font-size:13px;padding:8px 12px;border:1px solid #e6e4de;border-radius:10px;background:#fff;margin:2px 0 4px;outline:none}
.filter:focus{border-color:#3b3f8f88;box-shadow:0 0 0 3px #3b3f8f14}
.bar{height:10px}
.bar div{background:linear-gradient(90deg,#15803d,#1da24f)}
</style></head><body><div class="wrap">
<div class="head">
  <div><h1>⚙️ Forge — ${esc(cfg.project)}</h1>
  <div class="mut">Phase: <b>${esc(cfg.phase)}</b> · Verify: ${Object.keys(cfg.verify || {}).length ? Object.keys(cfg.verify).map(esc).join(', ') : 'not set'} · Graphify: ${esc((cfg.options || {}).graphify || 'unset')}</div></div>
  <div class="stamp">GENERATED PROJECTION — state wins, never edit this file.<br>Generated ${new Date().toISOString().slice(0, 19).replace('T', ' ')} UTC · refresh: <code>forge dashboard</code></div>
</div>
<div class="bar"><div style="width:${pct}%"></div></div>
<div class="mut">${counts.DONE}/${total} work items done (${pct}%)</div>
<div class="cards">
  <div class="card"><b>${counts.DONE}</b><span>done</span></div>
  <div class="card"><b>${counts.IN_PROGRESS}</b><span>in progress</span></div>
  <div class="card"><b>${ready}</b><span>ready</span></div>
  <div class="card"><b>${counts.TODO - ready}</b><span>todo</span></div>
  <div class="card"><b style="color:${counts.BLOCKED ? '#b91c1c' : 'inherit'}">${counts.BLOCKED}</b><span>blocked</span></div>
  <div class="card"><b>${counts.CANCELLED}</b><span>cancelled</span></div>
</div>
${mapBlock}
${telemetryBlock}
<details class="sec" open><summary>Work graph <span class="mut">(the whole project — closed milestones fold away)</span></summary>
<input class="filter" id="wgfilter" type="search" placeholder="Filter items… (id, title, component, status)" aria-label="Filter work items">
${milestoneBlocks || '<p class="mut">No work items yet.</p>'}</details>
<details class="sec" open><summary>Decisions &amp; discoveries <span class="mut">(latest first · forge/decisions.md · forge/discoveries.md)</span></summary>
<div class="grid2" style="margin-top:8px">
<div><h3>Decisions</h3>${logBlock(decisions, 'None recorded yet.')}</div>
<div><h3>Discoveries</h3>${logBlock(discoveries, 'None recorded yet.')}</div>
</div></details>
<details class="sec"><summary>Preflight &amp; baseline ${pf ? `<span class="mut">preflight ${esc(pf.ts.slice(0, 16).replace('T', ' '))}</span>` : ''}</summary>
<div class="grid2" style="margin-top:8px">
<div><h3>Preflight</h3>
<div class="tblwrap"><table><tbody>${pfBlock}</tbody></table></div></div>
<div><h3>Baseline ${base ? `<span class="mut" style="font-weight:400">${esc(base.ts.slice(0, 16).replace('T', ' '))}</span>` : ''}</h3>
<div class="tblwrap"><table><tbody>${baseBlock}</tbody></table></div></div>
</div></details>
${specRows ? `<details class="sec"><summary>Specification <span class="mut">(${esc(cfg.specDir)}/ — the source of intent)</span></summary>
<div class="tblwrap" style="margin-top:8px"><table><thead><tr><th>File</th><th>Size</th><th>Modified</th></tr></thead><tbody>${specRows}</tbody></table></div></details>` : ''}
</div>
<script>
(function(){
  var i=document.getElementById('wgfilter'); if(!i) return;
  i.addEventListener('input',function(){
    var q=i.value.toLowerCase();
    document.querySelectorAll('details.sec.sub').forEach(function(d){
      var any=false;
      d.querySelectorAll('tbody tr').forEach(function(r){
        var hit=!q||r.textContent.toLowerCase().indexOf(q)>=0;
        r.style.display=hit?'':'none'; if(hit)any=true;
      });
      if(q){ if(d.dataset.wasOpen===undefined){ d.dataset.wasOpen=d.open?'1':'0'; } d.open=any; d.style.display=any?'':'none'; }
      else { d.style.display=''; if(d.dataset.wasOpen!==undefined){ d.open=d.dataset.wasOpen==='1'; delete d.dataset.wasOpen; } }
    });
  });
})();
</script>
</body></html>`;

  fs.mkdirSync(FORGE, { recursive: true });
  fs.writeFileSync(DASHBOARD_FILE, html);
}

// ---------------------------------------------------------------------------
// argv helpers
// ---------------------------------------------------------------------------

const argv = process.argv.slice(2);
function flag(name) { return argv.includes('--' + name); }
function opt(name) {
  const i = argv.indexOf('--' + name);
  if (i < 0 || argv[i + 1] === undefined) return null;
  // 2.3: never swallow the next flag as a value
  if (String(argv[i + 1]).startsWith('--')) return null;
  return argv[i + 1];
}
function optAll(name) {
  const vals = [];
  argv.forEach((a, i) => {
    if (a === '--' + name && argv[i + 1] !== undefined && !String(argv[i + 1]).startsWith('--')) vals.push(argv[i + 1]);
  });
  return vals;
}

// 3.1/F7: bind evidence to the actual tree state (HEAD + working-tree status hash)
function treeState() {
  const head = run('git rev-parse HEAD', { timeout: 10000 });
  const st = run('git status --porcelain', { timeout: 20000 });
  if (st.exit !== 0) return null; // not a git repo — preflight makes this mandatory anyway
  return ((head.exit === 0 ? head.tail : 'NOHEAD') + '|' +
          crypto.createHash('sha1').update(st.tail).digest('hex')).slice(0, 80);
}

// F4/3.4: baseline comparison as data — used by `task verify` and `baseline check`
function baselineCompare(cfg) {
  const base = readJson(BASELINE_FILE, null);
  if (!base) return [];
  const results = [];
  for (const b of base.results) {
    const currentCmd = (cfg.verify || {})[b.kind];
    if (currentCmd && currentCmd !== b.cmd) {
      // 3.4: command changed since capture — comparison would be meaningless
      results.push({ kind: `baseline:${b.kind}`, cmd: currentCmd, exit: 1,
        tail: `verify.${b.kind} changed since the baseline was captured ('${b.cmd}' → '${currentCmd}').`,
        note: `recapture required: forge baseline capture` });
      continue;
    }
    const now = run(currentCmd || b.cmd);
    const was = b.exit === 0;
    const is = now.exit === 0;
    if (was && !is) results.push({ kind: `baseline:${b.kind}`, cmd: b.cmd, exit: 1, tail: now.tail, note: 'REGRESSION — was GREEN at baseline' });
    else results.push({ kind: `baseline:${b.kind}`, cmd: b.cmd, exit: 0, tail: '', note: was ? 'GREEN → GREEN' : (is ? 'pre-existing RED now GREEN' : 'pre-existing RED (not made worse)') });
  }
  return results;
}

// ---------------------------------------------------------------------------
// work item model
// ---------------------------------------------------------------------------

const STATUSES = ['TODO', 'IN_PROGRESS', 'BLOCKED', 'DONE', 'CANCELLED'];

function getItem(w, id) {
  const item = w.items[id];
  if (!item) die(`No work item '${id}'. Use: forge task list`);
  return item;
}

function failedAttempts(item) {
  return item.attempts.filter(a => a.outcome === 'failed').length;
}

function lastVerification(item) {
  return item.verifications.length ? item.verifications[item.verifications.length - 1] : null;
}

// v0.12: conservative glob-overlap test — two scopes overlap when either's
// literal prefix (up to the first '*') contains the other's. '**' overlaps all,
// so deliberately whole-tree items are serial by construction.
function scopesOverlap(a, b) {
  const root = g => String(g).replace(/\\/g, '/').replace(/^\.\//, '').split('*')[0];
  for (const ga of a || []) for (const gb of b || []) {
    const ra = root(ga), rb = root(gb);
    if (ra.startsWith(rb) || rb.startsWith(ra)) return `'${ga}' vs '${gb}'`;
  }
  return null;
}

function depsSatisfied(w, item) {
  return item.deps.filter(d => {
    const dep = w.items[d];
    return !dep || dep.status !== 'DONE';
  });
}

// F9: milestone sequence = order of first appearance; gates live in w.gates
function milestoneSeq(w) {
  const seq = [];
  for (const id of w.order) {
    const m = w.items[id].milestone;
    if (m && !seq.includes(m)) seq.push(m);
  }
  return seq;
}

function milestoneComplete(w, m) {
  return w.order.every(id => {
    const t = w.items[id];
    return t.milestone !== m || ['DONE', 'CANCELLED'].includes(t.status);
  });
}

// Returns a refusal string when starting an item of `m` is gated, else null.
function milestoneGateBlock(w, cfg, m) {
  if (!m) return null;
  if (((cfg || {}).options || {}).gates === 'end-only') return null;
  const seq = milestoneSeq(w);
  for (const prev of seq) {
    if (prev === m) break;
    if (!milestoneComplete(w, prev)) {
      return `milestone '${prev}' still has unfinished items — earlier milestones complete (and get approved) before '${m}' starts.`;
    }
    const gate = (w.gates || {})[prev];
    if (!gate || !gate.approved) {
      return `milestone '${prev}' is complete but awaits HUMAN approval. Demo it to the user, then record their approval:\n  forge milestone approve ${prev} --note "<their verdict>"\n(Or switch gating off for this project: forge config set options.gates end-only)`;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// commands
// ---------------------------------------------------------------------------

const commands = {

  // -- init -----------------------------------------------------------------
  init() {
    fs.mkdirSync(STATE, { recursive: true });
    if (!loadConfig()) {
      writeJson(CONFIG_FILE, {
        project: opt('project') || path.basename(PROJECT),
        phase: 'spec',                       // 'spec' until METHOD Step 7 sets verify commands
        specDir: opt('spec-dir') || null,    // discovered/declared later
        verify: {},                          // e.g. { test: "npm test", lint: "...", typecheck: "..." }
        options: { graphify: 'unset', web: 'unset' }
      });
      out('Initialized forge/config.json (phase: spec).');
    } else out('forge/config.json already exists — left untouched (init is idempotent).');
    if (!fs.existsSync(WORK_FILE)) { saveWork(loadWork()); out('Initialized forge/state/work.json.'); }
    appendMd(DECISIONS_FILE, '# Decisions log (append-only, via forge CLI)', '');
    appendMd(DISCOVERIES_FILE, '# Discoveries log (append-only, via forge CLI)', '');
    out('Forge project state ready.');
    out('📊 Tip for the user: forge/dashboard.html (open it in any browser) is the visual picture of the whole project — it updates itself on every change.');
  },

  // -- config ---------------------------------------------------------------
  config() {
    const action = argv[1];
    const cfg = loadConfig();
    if (!cfg) die('No forge/config.json. Run: forge init');
    if (action === 'get') {
      out(JSON.stringify(argv[2] ? argv[2].split('.').reduce((o, k) => (o || {})[k], cfg) : cfg, null, 2));
    } else if (action === 'set') {
      const [keyPath, value] = [argv[2], argv[3]];
      if (!keyPath || value === undefined) die('Usage: forge config set <dot.path> <value>');
      const keys = keyPath.split('.');
      let node = cfg;
      keys.slice(0, -1).forEach(k => { node[k] = node[k] || {}; node = node[k]; });
      node[keys[keys.length - 1]] = value === 'true' ? true : value === 'false' ? false : value;
      writeJson(CONFIG_FILE, cfg);
      regenDashboard();
      out(`Set ${keyPath} = ${value}`);
    } else die('Usage: forge config get [path] | forge config set <path> <value>');
  },

  // -- preflight --------------------------------------------------------------
  preflight() {
    const cfg = loadConfig();
    const full = flag('full');
    const results = [];
    const check = (name, ok, note, severity = 'mandatory') =>
      results.push({ name, ok, note, severity });

    // node version — README requires >= 18
    const major = parseInt(process.version.slice(1), 10);
    check('node', major >= 18, `${process.version}${major >= 18 ? '' : ' — Forge requires Node >= 18'}`);

    // git — mandatory always
    const git = run('git rev-parse --is-inside-work-tree', { timeout: 10000 });
    check('git', git.exit === 0, git.exit === 0 ? 'repo ok' : 'not a git repository — Forge requires git for recovery and baselines');

    // config / phase
    if (!cfg) {
      check('forge config', false, "no forge/config.json — run 'forge init' (fine if you are only exploring)", 'optional');
    } else {
      check('forge config', true, `phase: ${cfg.phase}`);
      // verification commands — mandatory in build phase
      const cmds = Object.entries(cfg.verify || {});
      if (cfg.phase === 'build') {
        check('verification commands', cmds.length > 0,
          cmds.length ? cmds.map(([k, v]) => `${k}: ${v}`).join(' | ')
                      : 'build phase requires at least one verify command (set via: forge config set verify.test "<cmd>")');
        if (full && cmds.length) {
          for (const [k, cmd] of cmds) {
            const r = run(cmd);
            check(`verify.${k} runs`, r.exit === 0, r.exit === 0 ? 'green' : `exit ${r.exit} — record as pre-existing failure or fix before relying on this gate`, 'warning');
          }
        }
        // v0.13: the project map is only honest when items are tagged
        {
          const wPf = readJson(WORK_FILE, { items: {}, order: [] });
          const untaggedPf = wPf.order.filter(id => !wPf.items[id].component && wPf.items[id].status !== 'CANCELLED').length;
          if (wPf.order.length)
            check('component map', untaggedPf === 0,
              untaggedPf ? `${untaggedPf} work item(s) not tagged to a component — the project map is incomplete (forge task update <id> --component <c>)` : 'all items tagged', 'warning');
        }
        // v0.8: deterministic security scanning belongs in the verify path
        if ((cfg.options || {}).security !== 'off')
          check('security check', !!(cfg.verify || {}).security,
            (cfg.verify || {}).security ? `security: ${cfg.verify.security}` :
            'no verify.security command — add a scanner (e.g. gitleaks/semgrep/npm audit): forge config set verify.security "<cmd>". It runs inside every task verify. (Disable: forge config set options.security off)',
            'warning');
      } else {
        check('verification commands', true, 'spec phase — not required yet', 'optional');
      }

      // graphify — optional enhancer with recorded user choice
      const g = run('graphify --version', { timeout: 15000 });
      const choice = (cfg.options || {}).graphify || 'unset';
      if (g.exit === 0) check('graphify', true, `available (${g.tail.split('\n')[0]})`, 'optional');
      else if (choice === 'skip') check('graphify', true, 'not installed — user chose to proceed without (degraded orientation: Explorer agents)', 'optional');
      else if (choice === 'use') check('graphify', false, 'configured for use but not installed — install it, or run: forge config set options.graphify skip', 'warning');
      else check('graphify', false, 'ASK_USER: not installed and no choice recorded. Ask the user: install Graphify (recommended) or proceed without? Record with: forge config set options.graphify use|skip', 'decision');

      // playwright — only if project declares a web surface
      if ((cfg.options || {}).web === true) {
        const p = run('npx --no-install playwright --version', { timeout: 30000 });
        check('playwright', p.exit === 0,
          p.exit === 0 ? 'available' : 'web project without Playwright — E2E acceptance criteria cannot be machine-verified (degraded: manual milestone checks)', 'warning');
      }
    }

    writeJson(PREFLIGHT_FILE, { ts: ts(), results });
    regenDashboard();
    const mandatoryFailed = results.filter(r => !r.ok && r.severity === 'mandatory');
    const decisions = results.filter(r => !r.ok && r.severity === 'decision');
    for (const r of results) out(`${r.ok ? 'OK  ' : (r.severity === 'mandatory' ? 'FAIL' : 'WARN')}  ${r.name}: ${r.note}`);
    if (decisions.length) out('\nUser decision needed before build phase — see ASK_USER items above.');
    if (mandatoryFailed.length) die('\nPreflight failed on mandatory checks. Build work is blocked until resolved.');
    out('\nPreflight passed' + (results.some(r => !r.ok) ? ' (with warnings/decisions recorded).' : '.'));
  },

  // -- task -----------------------------------------------------------------
  task() {
    const sub = argv[1];
    const w = loadWork();

    if (sub === 'add') {
      let item;
      if (opt('json')) item = JSON.parse(opt('json'));
      else {
        item = {
          id: opt('id'), title: opt('title') || '', objective: opt('objective') || '',
          milestone: opt('milestone') || null,
          deps: (opt('deps') || '').split(',').map(s => s.trim()).filter(Boolean),
          criteria: optAll('criterion').map(c => {
            const [desc, check] = c.split('::');
            return { desc: desc.trim(), check: (check || '').trim() || null };
          }),
          scope: { allowed: (opt('allowed') || '').split(',').map(s => s.trim()).filter(Boolean),
                   forbidden: (opt('forbidden') || '').split(',').map(s => s.trim()).filter(Boolean) }
        };
      }
      if (!item.id) die('Work item needs an --id');
      if (w.items[item.id]) die(`Work item '${item.id}' already exists (add is not an update).`);
      w.items[item.id] = Object.assign({
        title: '', objective: '', milestone: null, deps: [], criteria: [],
        scope: { allowed: [], forbidden: [] },
        component: opt('component') || null,
        status: 'TODO', attempts: [], verifications: [], history: [],
        preState: null, startTree: null,
        blockReason: null, cancelReason: null, created: ts(), updated: ts()
      }, item, { status: 'TODO' });
      w.order.push(item.id);
      saveWork(w);
      // v0.10: auto-register unknown components so the map never lies by omission
      if (w.items[item.id].component) {
        const comps = readJson(COMPONENTS_FILE, { schema: 1, components: {} });
        if (!comps.components[w.items[item.id].component]) {
          comps.components[w.items[item.id].component] = { id: w.items[item.id].component, name: w.items[item.id].component, kind: 'unspecified', created: ts() };
          writeJson(COMPONENTS_FILE, comps);
          regenDashboard();
        }
      }
      out(`Created ${item.id}: ${item.title}`);
      if (!w.items[item.id].component)
        out(`WARNING: '${item.id}' has no --component tag — the dashboard project map cannot place it. Tag it: forge task update ${item.id} --component <id>`);

    } else if (sub === 'list') {
      const filter = opt('status');
      for (const id of w.order) {
        const t = w.items[id];
        if (filter && t.status !== filter) continue;
        const noScope = !((t.scope || {}).allowed || []).length;
        const ready = t.status === 'TODO' && depsSatisfied(w, t).length === 0 && t.criteria.length > 0 && !noScope;
        // v0.13: thin backlog items are legitimate — warn only where the work is live (active milestone or unmilestoned)
        const actM = activeMilestone(w);
        const warnScope = noScope && !['DONE', 'CANCELLED'].includes(t.status) && (!t.milestone || t.milestone === actM);
        out(`${t.status.padEnd(11)} ${id.padEnd(8)} ${t.title}${ready ? '  [READY]' : ''}` +
            (warnScope ? '  [NO SCOPE — start will refuse]' : '') +
            (t.deps.length ? `  deps: ${t.deps.join(',')}` : '') +
            (failedAttempts(t) ? `  failed-attempts: ${failedAttempts(t)}` : ''));
      }

    } else if (sub === 'show') {
      out(JSON.stringify(getItem(w, argv[2]), null, 2));

    } else if (sub === 'start') {
      const item = getItem(w, argv[2]);
      // 1.1/F3: an in-flight item must be resolved before any re-start — no silent re-dispatch
      if (item.status === 'IN_PROGRESS')
        die(`Refused: '${item.id}' is already IN_PROGRESS. Resolve the current attempt first:\n` +
            `  forge task fail ${item.id} --note "<root-cause diagnosis>"   (counts toward escalation)\n` +
            `  forge task block ${item.id} --reason "..."\n` +
            `  forge task verify ${item.id} && forge task done ${item.id}`);
      if (!['TODO', 'BLOCKED'].includes(item.status))
        die(`Cannot start '${item.id}' from status ${item.status}.`);
      if (item.criteria.length === 0)
        die(`Refused: '${item.id}' has no acceptance criteria. A work item without criteria cannot be verified, so it cannot be started.\n` +
            `Add criteria first (task update ${item.id} --criterion-add "desc::check-command").`);
      const missing = depsSatisfied(w, item);
      if (missing.length)
        die(`Refused: '${item.id}' has unfinished dependencies: ${missing.join(', ')}.\n` +
            `(A CANCELLED dependency must be dropped or re-pointed: forge task update ${item.id} --deps ...)`);
      const gateMsg = milestoneGateBlock(w, loadConfig(), item.milestone);
      if (gateMsg) die(`Refused: ${gateMsg}`);
      // v0.12: scope is part of the item's definition — no declared file scope, no start.
      // Field evidence (project-b, 87 items): scope derived only into brief prose is unenforceable.
      if (!(item.scope.allowed || []).length) {
        if (flag('whole-tree')) {
          if (!opt('reason')) die(`--whole-tree requires --reason "..." — a deliberately unbounded item is recorded, and it is serial by nature (its scope overlaps everything).`);
          item.scope.allowed = ['**'];
          (item.history = item.history || []).push({ ts: ts(), change: `scope.allowed = ['**'] (whole tree, at start)`, reason: opt('reason') });
        } else {
          die(`Refused: '${item.id}' has no allowed file scope (scope.allowed is empty).\n` +
              `Scope is what bounds the work and makes the guard (and any parallelism) real — derive it from the\n` +
              `dependency closure and record it BEFORE starting:\n` +
              `  forge task update ${item.id} --allowed "src/feature/,src/shared/types.ts"\n` +
              `Genuinely whole-tree work (rare): forge task start ${item.id} --whole-tree --reason "..."`);
        }
      }
      // v0.12: concurrency cap (options.concurrency, default 1 = serial) + disjoint-scope check.
      // What used to be convention ("one item in flight") is now a gate.
      {
        const cfgC = loadConfig() || {};
        const cap = parseInt((cfgC.options || {}).concurrency, 10) || 1;
        const others = w.order.filter(id2 => id2 !== item.id && w.items[id2].status === 'IN_PROGRESS');
        if (others.length >= cap)
          die(`Refused: concurrency cap reached — ${others.length} item(s) already IN_PROGRESS (options.concurrency=${cap}): ${others.join(', ')}.\n` +
              `Resolve one first (done / fail / block), or raise the cap deliberately:\n` +
              `  forge config set options.concurrency ${cap + 1}\n` +
              `(Parallel dispatch is only safe with disjoint scopes and the OPERATING.md parallel-dispatch rules.)`);
        for (const id2 of others) {
          const clash = scopesOverlap(item.scope.allowed, (w.items[id2].scope || {}).allowed || []);
          if (clash)
            die(`Refused: '${item.id}' overlaps the scope of in-progress item '${id2}' (${clash}).\n` +
                `Two concurrent workers writing the same territory race each other and contaminate each other's evidence.\n` +
                `Serialize them, or narrow one scope: forge task update ${item.id} --allowed "..."`);
        }
      }
      const fails = failedAttempts(item);
      if (fails >= 2 && !opt('escalate'))
        die(`Refused: '${item.id}' has failed ${fails} attempts. A third identical attempt is not allowed.\n` +
            `Escalate explicitly: forge task start ${item.id} --escalate <stronger-model|decompose|self|revisit-criteria> --note "what changes this time"`);
      // 1.2/F5: red-first — record each criterion check's pre-work result
      item.preState = item.criteria.map(c => c.check ? { desc: c.desc, exit: run(c.check).exit } : null);
      item.startTree = treeState();
      const alreadyGreen = item.preState.filter(p => p && p.exit === 0);
      item.status = 'IN_PROGRESS';
      item.blockReason = null;
      item.attempts.push({ ts: ts(), outcome: 'started', escalation: opt('escalate') || null, note: opt('note') || null, agent: opt('agent') || null });
      item.updated = ts();
      saveWork(w);
      out(`${item.id} → IN_PROGRESS${opt('escalate') ? ` (escalation: ${opt('escalate')})` : ''}`);
      if (alreadyGreen.length)
        out(`WARNING: ${alreadyGreen.length} criterion check(s) ALREADY PASS before any work:\n` +
            alreadyGreen.map(p => `  - ${p.desc}`).join('\n') +
            `\nEither the item is already satisfied (cancel it with a reason) or these checks are vacuous (fix them: forge task update). 'done' will refuse if nothing changes.`);

    } else if (sub === 'verify') {
      const item = getItem(w, argv[2]);
      const cfg = loadConfig() || { verify: {} };
      const results = [];
      for (const [k, cmd] of Object.entries(cfg.verify || {})) results.push(Object.assign({ kind: `project:${k}` }, run(cmd)));
      for (const c of item.criteria) if (c.check) results.push(Object.assign({ kind: `criterion: ${c.desc}` }, run(c.check)));
      if (results.length === 0)
        die(`Nothing executable to verify for '${item.id}': no project verify commands and no criterion checks.\n` +
            `This item cannot be machine-verified. Either add a check, or record a human verification decision in the decisions log and cancel/redefine the item.`);
      // 1.3/F4: the baseline guard is part of verification, not prose
      let skippedBaseline = null;
      if (fs.existsSync(BASELINE_FILE)) {
        if (flag('skip-baseline')) {
          if (!opt('reason')) die('--skip-baseline requires --reason "..." (the reason is recorded in the verification evidence).');
          skippedBaseline = opt('reason');
        } else {
          for (const r of baselineCompare(cfg)) results.push(r);
        }
      }
      const passed = results.every(r => r.exit === 0);
      // v0.9: attach evidence artifacts (screenshots, reports) to the record
      const artifacts = optAll('artifact').filter(a => {
        if (fs.existsSync(path.resolve(PROJECT, a))) return true;
        out(`WARNING: --artifact ${a} does not exist — not recorded.`); return false;
      });
      item.verifications.push({ ts: ts(), passed, results, tree: treeState(), skippedBaseline, artifacts: artifacts.length ? artifacts : undefined,
        durationMs: results.reduce((a, r) => a + (r.ms || 0), 0) });
      item.updated = ts();
      saveWork(w);
      for (const r of results) out(`${r.exit === 0 ? 'PASS' : 'FAIL'}  [${r.kind}] ${r.cmd}${r.note ? `  (${r.note})` : ''}${r.exit !== 0 ? '\n' + r.tail : ''}`);
      if (skippedBaseline) out(`NOTE: baseline check SKIPPED — reason recorded: ${skippedBaseline}`);
      out(passed ? `\n${item.id}: verification PASSED` : `\n${item.id}: verification FAILED`);
      if (!passed) process.exit(1);

    } else if (sub === 'done') {
      const item = getItem(w, argv[2]);
      if (item.status !== 'IN_PROGRESS') die(`Cannot complete '${item.id}' from status ${item.status}.`);
      const v = lastVerification(item);
      if (!v || !v.passed)
        die(`Refused: '${item.id}' has no passing verification record.\n` +
            `Run: forge task verify ${item.id} — DONE is granted by evidence, not by claim.`);
      // 3.1/F7: evidence must describe the CURRENT tree
      const now = treeState();
      if (v.tree && now && v.tree !== now)
        die(`Refused: the tree changed since the passing verification (${v.ts}).\n` +
            `Stale evidence proves nothing — re-verify: forge task verify ${item.id}`);
      // 1.2/F5: red-first — green-before, green-after, nothing changed ⇒ the checks proved nothing
      const checked = (item.preState || []).filter(Boolean);
      if (checked.length && checked.every(p => p.exit === 0) && item.startTree && now && item.startTree === now)
        die(`Refused: every criterion check already passed BEFORE work started, and the tree is unchanged since start.\n` +
            `These checks prove nothing about this item. Either the item was already satisfied (forge task cancel ${item.id} --reason "already satisfied")\n` +
            `or the checks are vacuous (forge task update ${item.id} --criterion-remove/--criterion-add --reason "...").`);
      item.status = 'DONE';
      item.attempts.push({ ts: ts(), outcome: 'passed', note: opt('note') || null });
      item.updated = ts();
      saveWork(w);
      out(`${item.id} → DONE (verified ${v.ts})`);
      // v0.5: the spec is the living source of truth on EVERY project
      out(`Spec sync: if this item established, changed, or contradicted product behavior, update the affected ` +
          `spec layer file(s) NOW, citing the decision/discovery that drove it — the spec must always describe ` +
          `the product as built and intended.`);
      // F9: surface the gate the moment a milestone completes
      if (item.milestone && milestoneComplete(w, item.milestone) && !((w.gates || {})[item.milestone] || {}).approved
          && ((loadConfig() || {}).options || {}).gates !== 'end-only')
        out(`\nMILESTONE '${item.milestone}' IS COMPLETE and now awaits human review.\n` +
            `Demo it to the user, collect their verdict, AND ask: "anything you want to change or add before the next milestone?"\n` +
            `— their answer becomes decisions + work-graph updates. Then: forge milestone approve ${item.milestone} --note "..."\n` +
            `Items in later milestones will refuse to start until then.\n` +
            `📊 Point the user at forge/dashboard.html for the visual state of the project.`);

    } else if (sub === 'fail') {
      const item = getItem(w, argv[2]);
      if (item.status !== 'IN_PROGRESS') die(`'${item.id}' is not IN_PROGRESS.`);
      item.attempts.push({ ts: ts(), outcome: 'failed', note: opt('note') || '(no diagnosis recorded)' });
      item.status = 'TODO';
      item.updated = ts();
      saveWork(w);
      const fails = failedAttempts(item);
      out(`${item.id} attempt recorded as failed (${fails} total). ` +
          (fails >= 2 ? 'Next start REQUIRES --escalate.' : 'Diagnose before retrying — retry in a fresh worker context with the diagnosis in the brief.'));

    } else if (sub === 'block') {
      const item = getItem(w, argv[2]);
      item.status = 'BLOCKED';
      item.blockReason = opt('reason') || 'unspecified';
      item.updated = ts();
      saveWork(w);
      out(`${item.id} → BLOCKED: ${item.blockReason}`);

    } else if (sub === 'cancel') {
      const item = getItem(w, argv[2]);
      if (item.status === 'DONE') die(`'${item.id}' is DONE; completed work is not cancelled, it is superseded (create a new item).`);
      if (!opt('reason')) die('Cancellation must be explicit: --reason "..."');
      // 2.2/F6: a cancelled dependency must not silently brick its dependents
      const dependents = w.order.filter(id2 =>
        w.items[id2].deps.includes(item.id) && !['DONE', 'CANCELLED'].includes(w.items[id2].status));
      const mode = opt('dependents');
      if (dependents.length && !mode)
        die(`Refused: cancelling '${item.id}' would strand dependent item(s): ${dependents.join(', ')}.\n` +
            `Decide their fate explicitly:\n` +
            `  --dependents drop     remove '${item.id}' from their deps (recorded in each item's history)\n` +
            `  --dependents cancel   cascade-cancel them with the same reason\n` +
            `  or re-point them first: forge task update <id> --deps ... --reason "..."`);
      item.status = 'CANCELLED';
      item.cancelReason = opt('reason');
      item.updated = ts();
      if (mode === 'drop') {
        for (const id2 of dependents) {
          const d = w.items[id2];
          d.deps = d.deps.filter(x => x !== item.id);
          (d.history = d.history || []).push({ ts: ts(), change: `dep '${item.id}' dropped (dependency cancelled)`, reason: item.cancelReason });
          d.updated = ts();
        }
      } else if (mode === 'cancel') {
        const cascade = [...dependents];
        while (cascade.length) {
          const id2 = cascade.shift();
          const d = w.items[id2];
          if (d.status === 'CANCELLED') continue;
          d.status = 'CANCELLED';
          d.cancelReason = `cascade from ${item.id}: ${item.cancelReason}`;
          d.updated = ts();
          cascade.push(...w.order.filter(id3 =>
            w.items[id3].deps.includes(id2) && !['DONE', 'CANCELLED'].includes(w.items[id3].status)));
        }
      }
      saveWork(w);
      out(`${item.id} → CANCELLED: ${item.cancelReason}` +
          (dependents.length ? `\nDependents ${mode === 'cancel' ? 'cascade-cancelled' : 'updated (dep dropped)'}: ${dependents.join(', ')}` : ''));

    } else if (sub === 'update') {
      // 2.1/F6: makes '--escalate revisit-criteria' executable; every mutation is recorded
      const item = getItem(w, argv[2]);
      if (['DONE', 'CANCELLED'].includes(item.status))
        die(`'${item.id}' is ${item.status} — closed items are not edited; create a new item that supersedes it.`);
      const changes = [];
      const touchingCriteria = optAll('criterion-add').length > 0 || optAll('criterion-remove').length > 0;
      if (touchingCriteria && item.attempts.some(a => a.outcome === 'failed') && !opt('reason'))
        die(`Refused: this item has failed attempts — changing its criteria moves the goalposts.\n` +
            `That can be right, but it must be auditable: add --reason "why the criteria change".`);
      for (const k of ['title', 'objective', 'milestone']) {
        const v = opt(k);
        if (v !== null) { changes.push(`${k}: '${item[k]}' → '${v}'`); item[k] = v; }
      }
      if (opt('deps') !== null) {
        const nd = opt('deps').split(',').map(s => s.trim()).filter(Boolean);
        changes.push(`deps: [${item.deps}] → [${nd}]`); item.deps = nd;
      }
      if (opt('allowed') !== null) { item.scope.allowed = opt('allowed').split(',').map(s => s.trim()).filter(Boolean); changes.push('scope.allowed updated'); }
      if (opt('forbidden') !== null) { item.scope.forbidden = opt('forbidden').split(',').map(s => s.trim()).filter(Boolean); changes.push('scope.forbidden updated'); }
      if (opt('component') !== null) { item.component = opt('component') || null; changes.push('component = ' + item.component); }
      for (const idx of optAll('criterion-remove').map(Number).sort((a, b) => b - a)) {
        if (!item.criteria[idx]) die(`No criterion at index ${idx} (use: forge task show ${item.id}).`);
        changes.push(`criterion removed: '${item.criteria[idx].desc}'`);
        item.criteria.splice(idx, 1);
      }
      for (const c of optAll('criterion-add')) {
        const [desc, check] = c.split('::');
        item.criteria.push({ desc: desc.trim(), check: (check || '').trim() || null });
        changes.push(`criterion added: '${desc.trim()}'`);
      }
      if (!changes.length) die('Nothing to update. See: forge help');
      (item.history = item.history || []).push({ ts: ts(), change: changes.join('; '), reason: opt('reason') || null });
      item.updated = ts();
      saveWork(w);
      out(`${item.id} updated:\n` + changes.map(c => `  - ${c}`).join('\n'));

    } else if (sub === 'dispatch') {
      // v0.12: the handoff to a worker is a state event, not transcript archaeology.
      // Called immediately before launching a worker (kind=launch), and again for any
      // mid-flight message to a running worker (kind=message) — clarification is fine,
      // an unchanged-brief retry through chat is not, and both must be auditable.
      const item = getItem(w, argv[2]);
      if (item.status !== 'IN_PROGRESS')
        die(`Refused: '${item.id}' is not IN_PROGRESS — dispatch records a handoff to a worker; start the item first.`);
      const kind = opt('kind') || 'launch';
      if (!['launch', 'message'].includes(kind))
        die(`--kind must be 'launch' (handing the brief to a worker) or 'message' (mid-flight message to a running worker).`);
      item.dispatches = item.dispatches || [];
      item.dispatches.push({ ts: ts(), agent: opt('agent') || null, kind, note: opt('note') || null });
      item.updated = ts();
      saveWork(w);
      out(`${item.id} dispatch recorded${opt('agent') ? ` → ${opt('agent')}` : ''}${kind === 'message' ? ' (mid-flight message)' : ''} (${item.dispatches.length} total on this item)`);

    } else die('Usage: forge task add|list|show|start|dispatch|verify|done|fail|block|cancel|update ...');
  },

  // -- brief ------------------------------------------------------------------
  brief() {
    const w = loadWork();
    const item = getItem(w, argv[1]);
    const cfg = loadConfig() || {};
    const lines = [];
    lines.push(`# Work brief — ${item.id}: ${item.title}`);
    lines.push('', `## Objective`, item.objective || '(fill in)');
    lines.push('', `## Acceptance criteria (your work is verified against these — they are the definition of done)`);
    item.criteria.forEach((c, i) => lines.push(`${i + 1}. ${c.desc}${c.check ? `  — machine check: \`${c.check}\`` : '  — (no machine check; explain how you validated it)'}`));
    lines.push('', `## Scope`);
    lines.push(`Allowed to modify: ${item.scope.allowed.length ? item.scope.allowed.join(', ') : '(orchestrator: derive from the dependency closure — use Graphify if available)'}`);
    lines.push(`Must NOT touch: ${item.scope.forbidden.length ? item.scope.forbidden.join(', ') : '(orchestrator: fill in)'}`);
    lines.push('', `## Project verification commands (will be run on your result)`);
    Object.entries(cfg.verify || {}).forEach(([k, v]) => lines.push(`- ${k}: \`${v}\``));
    const fails = item.attempts.filter(a => a.outcome === 'failed');
    if (fails.length) {
      lines.push('', `## Previous failed attempts — do not repeat these approaches`);
      fails.forEach(a => lines.push(`- ${a.ts}: ${a.note}`));
    }
    lines.push('', `## Rules`,
      `- Stay inside the allowed scope. If correctness requires touching excluded areas, STOP and report — do not expand scope yourself.`,
      `- If the spec does not answer a question you need answered, STOP and report the hole — never invent product behavior.`,
      `- Report back: summary, files changed, tests run and results, discoveries, open questions.`);
    lines.push('', `_Orchestrator: prepend relevant spec excerpts, decisions, and the applicable domain pack before dispatching._`);
    // v0.13.1: briefs become readable artifacts — saved briefs are linked from the dashboard
    if (flag('save')) {
      const bdir = path.join(FORGE, 'briefs');
      fs.mkdirSync(bdir, { recursive: true });
      fs.writeFileSync(path.join(bdir, `${item.id}.md`), lines.join('\n') + '\n');
      regenDashboard();
      out(`Saved skeleton to forge/briefs/${item.id}.md — COMPLETE IT IN PLACE (spec excerpts, decisions, domain pack) before dispatch.\n` +
          `The dashboard links it on the item's card, and dispatch prompts can reference the file path.`);
    } else out(lines.join('\n'));
  },

  // -- decisions / discoveries -------------------------------------------------
  // v0.5: a bare positional argument after 'add' is accepted as the title;
  // an entry with NO title at all is refused instead of silently logged as (untitled).
  decision() {
    if (argv[1] !== 'add') die('Usage: forge decision add --title t --decision d --why w [--authority human|forge]');
    const posTitle = argv[2] && !argv[2].startsWith('--') ? argv[2] : null;
    const title = opt('title') || posTitle;
    if (!title) die('Refused: a decision needs a title — nothing was recorded.\nUsage: forge decision add --title "..." --decision "..." --why "..." [--authority human|forge]');
    appendMd(DECISIONS_FILE, '# Decisions log (append-only, via forge CLI)',
      `\n### ${ts()} — ${title}\n- Authority: ${opt('authority') || 'forge'}\n- Decision: ${opt('decision') || ''}\n- Why: ${opt('why') || ''}\n`);
    regenDashboard();
    out('Decision recorded.');
  },

  discovery() {
    if (argv[1] !== 'add') die('Usage: forge discovery add --title t --evidence e --impact i [--affects T1,T2]');
    const posTitle = argv[2] && !argv[2].startsWith('--') ? argv[2] : null;
    const title = opt('title') || posTitle;
    if (!title) die('Refused: a discovery needs a title — nothing was recorded.\nUsage: forge discovery add --title "..." --evidence "..." --impact "..." [--affects T1,T2]');
    appendMd(DISCOVERIES_FILE, '# Discoveries log (append-only, via forge CLI)',
      `\n### ${ts()} — ${title}\n- Evidence: ${opt('evidence') || ''}\n- Impact: ${opt('impact') || ''}\n- Affects: ${opt('affects') || '-'}\n`);
    regenDashboard();
    out('Discovery recorded. If it invalidates planned work, update the work graph now (block/cancel/add items) — a logged discovery with unhandled consequences is a failure.');
  },

  // -- components (v0.10) — the registry behind the dashboard's project map -----
  component() {
    const sub = argv[1];
    const comps = readJson(COMPONENTS_FILE, { schema: 1, components: {} });
    if (sub === 'add' || sub === 'update') {
      const id = argv[2];
      if (!id || id.startsWith('--')) die('Usage: forge component add|update <id> [--name "..."] [--kind frontend|backend|db|job|integration|...] [--route /path] [--mock spec/mocks/x.png] [--doc spec/02-experience.md#...]');
      if (sub === 'add' && comps.components[id]) die(`Component '${id}' exists — use: forge component update ${id}`);
      if (sub === 'update' && !comps.components[id]) die(`Unknown component '${id}'. See: forge component list`);
      const c = comps.components[id] = Object.assign({ id, name: id, kind: 'unspecified', created: ts() }, comps.components[id]);
      for (const k of ['name', 'kind', 'route', 'mock', 'doc']) if (opt(k) !== null) c[k] = opt(k);
      c.updated = ts();
      writeJson(COMPONENTS_FILE, comps);
      regenDashboard();
      out(`Component '${id}' ${sub === 'add' ? 'registered' : 'updated'} (${c.kind}${c.route ? ` · ${c.route}` : ''}). Tag work: forge task add ... --component ${id}`);
    } else if (sub === 'list') {
      const ids = Object.keys(comps.components);
      if (!ids.length) { out('No components registered. forge component add <id> --kind ... — or tag items with --component (auto-registers).'); return; }
      const w = loadWork();
      for (const id of ids) {
        const c = comps.components[id];
        const items = w.order.filter(i => w.items[i].component === id);
        const done = items.filter(i => w.items[i].status === 'DONE').length;
        out(`  ${id} (${c.kind}${c.route ? ` · ${c.route}` : ''}) — ${done}/${items.length} items done${c.mock ? ' · mock ✓' : ''}`);
      }
    } else die('Usage: forge component add|update <id> [flags] | list');
  },

  // -- session lock (v0.5) ------------------------------------------------------
  session() {
    const sub = argv[1];
    const l = loadLock();
    if (sub === 'status') {
      if (!l) out('No orchestrator session lock recorded.');
      else out(`Lock: session ${l.sessionId} · started ${l.startedAt} · last beat ${l.lastBeat} (${lockAge(l)}) · ` +
               (l.released ? 'RELEASED' : (lockFresh(l) ? 'ACTIVE' : 'STALE')));
    } else if (sub === 'takeover') {
      if (!l) { out('No lock to take over — the next session to write in this project claims orchestration.'); return; }
      if (lockFresh(l) && !argv.includes('--force'))
        die(`Refused: the lock is ACTIVE (session ${String(l.sessionId).slice(0, 8)}…, last beat ${lockAge(l)}).\n` +
            `If you are certain that session is dead or must stand down, re-run: forge session takeover --force`);
      saveLock(Object.assign({}, l, { released: true, lastBeat: ts(), takenOver: ts() }));
      out('Lock released. The next session to write in this project claims orchestration.\n' +
          'If the previous session left items IN_PROGRESS, audit them before dispatching new work.');
    } else die('Usage: forge session status|takeover [--force]');
  },

  // -- baseline -----------------------------------------------------------------
  baseline() {
    const cfg = loadConfig();
    if (!cfg || !Object.keys(cfg.verify || {}).length) die('Baseline needs verify commands in forge/config.json.');
    const sub = argv[1];
    if (sub === 'capture') {
      const results = Object.entries(cfg.verify).map(([k, cmd]) => Object.assign({ kind: k }, run(cmd)));
      writeJson(BASELINE_FILE, { ts: ts(), results });
      // P3: brownfield projects that skip the spec phase must still get build-phase gates
      if (cfg.phase === 'spec') {
        cfg.phase = 'build';
        writeJson(CONFIG_FILE, cfg);
        out("Phase advanced spec → build (baseline captured implies build work is starting).");
      }
      regenDashboard();
      results.forEach(r => out(`${r.exit === 0 ? 'GREEN' : 'RED  '}  ${r.kind}: ${r.cmd}`));
      out('Baseline captured. RED items are recorded as PRE-EXISTING failures — new work must not make them worse and is not required to fix them.\n' +
          'From now on, `forge task verify` includes this baseline automatically.');
    } else if (sub === 'check') {
      if (!fs.existsSync(BASELINE_FILE)) die('No baseline captured. Run: forge baseline capture');
      const results = baselineCompare(cfg);
      let regressed = false;
      for (const r of results) {
        if (r.exit !== 0) { regressed = true; out(`FAIL  ${r.kind}: ${r.note}\n${r.tail}`); }
        else out(`OK  ${r.kind}: ${r.note}`);
      }
      if (regressed) die('\nBaseline check failed (regression or changed verify command — see above).');
      out('\nNo baseline regressions.');
    } else die('Usage: forge baseline capture|check');
  },

  // -- status ---------------------------------------------------------------------
  status() {
    const cfg = loadConfig();
    const w = loadWork();
    const pf = readJson(PREFLIGHT_FILE, null);
    out(`# Forge status — ${cfg ? cfg.project : path.basename(PROJECT)}`);
    out(`Phase: ${cfg ? cfg.phase : 'not initialized (run: forge init)'}`);
    if (pf) {
      const bad = pf.results.filter(r => !r.ok);
      out(`Preflight (${pf.ts}): ${bad.length ? bad.map(r => `${r.name} [${r.severity}]`).join(', ') + ' need attention' : 'all green'}`);
    } else out('Preflight: never run (run: forge preflight)');
    const counts = {};
    STATUSES.forEach(s => counts[s] = 0);
    let ready = 0;
    for (const id of w.order) {
      const t = w.items[id];
      counts[t.status]++;
      if (t.status === 'TODO' && depsSatisfied(w, t).length === 0 && t.criteria.length > 0) ready++;
    }
    out(`\nWork: ${w.order.length} items — DONE ${counts.DONE} · IN_PROGRESS ${counts.IN_PROGRESS} · READY ${ready} · TODO ${counts.TODO - ready} · BLOCKED ${counts.BLOCKED} · CANCELLED ${counts.CANCELLED}`);
    for (const id of w.order) {
      const t = w.items[id];
      if (t.status === 'IN_PROGRESS') out(`  ▶ ${id} ${t.title}${failedAttempts(t) ? ` (failed attempts: ${failedAttempts(t)})` : ''}`);
      if (t.status === 'BLOCKED') out(`  ✖ ${id} ${t.title} — ${t.blockReason}`);
    }
    if (fs.existsSync(DISCOVERIES_FILE)) {
      const lastDisc = fs.readFileSync(DISCOVERIES_FILE, 'utf8').split('### ').slice(-1)[0];
      if (lastDisc && lastDisc.trim() && !lastDisc.startsWith('#')) out(`\nLatest discovery: ${lastDisc.split('\n')[0]}`);
    }
    out(`\nLogs: forge/decisions.md · forge/discoveries.md`);
  },

  // -- trace / doctor (v0.7) — the flight recorder and the install self-check ---
  trace() {
    const lines = [];
    for (const f of [TRACE_FILE + '.old', TRACE_FILE]) {
      try { lines.push(...fs.readFileSync(f, 'utf8').split('\n').filter(Boolean)); } catch (_) { }
    }
    if (!lines.length) die('No trace recorded yet (forge/state/trace.jsonl appears after the first traced command).');
    let evs = lines.map(l => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean);
    if (flag('refusals')) evs = evs.filter(e => e.outcome === 'refused' || e.outcome === 'block');
    if (flag('hooks')) evs = evs.filter(e => e.hook || /^hook /.test(e.cmd || ''));
    const n = parseInt(opt('last') || '30', 10) || 30;
    const shown = evs.slice(-n);
    for (const e of shown)
      out(`${e.ts}  v${e.v}  [${e.outcome}${e.exit !== undefined && e.outcome !== 'ok' ? ':' + e.exit : ''}]` +
          `${e.reason ? ` (${e.reason}${e.item ? ' ' + e.item : ''})` : ''}  ${e.cmd}` +
          `${e.refusal ? `  — ${e.refusal}` : ''}${e.path ? `  — ${e.path}` : ''}`);
    out(`\n${shown.length} of ${evs.length} matching event(s) · forge/state/trace.jsonl · filters: --refusals --hooks --last N` +
        (DEBUG ? '' : ' · FORGE_DEBUG=1 records verbose payloads'));
  },

  doctor() {
    const rows = [];
    const check = (name, ok, note, warn) => rows.push({ name, ok, note, warn: !!warn });
    // runtime
    const major = parseInt(process.version.slice(1), 10);
    check('node', major >= 18, process.version);
    check('git', run('git rev-parse --is-inside-work-tree', { timeout: 10000 }).exit === 0, 'work tree');
    // which forge is actually running
    check('running version', VERSION !== '?', `v${VERSION} — ${__filename}`);
    try {
      const cacheRoot = path.join(os.homedir(), '.claude', 'plugins', 'cache');
      const found = [];
      for (const mp of fs.readdirSync(cacheRoot)) {
        const pdir = path.join(cacheRoot, mp, 'forge');
        if (fs.existsSync(pdir)) for (const v of fs.readdirSync(pdir)) found.push(`${mp}/forge/${v}`);
      }
      if (found.length) {
        const stale = found.length > 1;
        check('plugin cache', !stale, found.join(' · ') + (stale ? ' — multiple cached versions; uninstall/reinstall if the wrong one loads' : ''), stale);
        const cached = found.some(f => f.endsWith('/' + VERSION));
        if (!__filename.includes('plugins/cache') && found.length)
          check('cache vs repo', cached, cached ? 'cache includes this version' : `cache has ${found.map(f => f.split('/').pop()).join(',')} but this repo is v${VERSION} — installed plugin is behind`, !cached);
      }
    } catch (_) { /* no cache dir — fine (running from repo without install) */ }
    // duplicate-hooks regression (v0.4.1 incident)
    try {
      const man = JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, '.claude-plugin', 'plugin.json'), 'utf8'));
      check('manifest hooks field', !('hooks' in man), 'hooks' in man ? 'present — causes duplicate-hooks load error on Claude Code ≥2.1' : 'absent (correct — hooks/hooks.json auto-loads)');
      JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, 'hooks', 'hooks.json'), 'utf8'));
      check('hooks/hooks.json', true, 'parses');
    } catch (e) { check('hooks/hooks.json', false, e.message); }
    // project state
    if (fs.existsSync(CONFIG_FILE)) {
      try { const c = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); check('config.json', true, `phase: ${c.phase}`); }
      catch (e) { check('config.json', false, 'CORRUPT: ' + e.message); }
      try {
        const w = JSON.parse(fs.readFileSync(WORK_FILE, 'utf8'));
        const inProg = w.order.filter(id => w.items[id].status === 'IN_PROGRESS');
        check('work.json', true, `${w.order.length} items · ${inProg.length} IN_PROGRESS`);
        const l = loadLock();
        if (inProg.length && (!l || l.released || !lockFresh(l)))
          check('orphaned work', false, `${inProg.join(', ')} IN_PROGRESS but no active orchestrator lock — a session likely died mid-item; audit before dispatching`, true);
        if (l) check('session lock', true, `${String(l.sessionId).slice(0, 8)}… ${l.released ? 'RELEASED' : lockFresh(l) ? 'ACTIVE' : 'STALE'} (${lockAge(l)})`);
      } catch (e) { check('work.json', false, fs.existsSync(WORK_FILE) ? 'CORRUPT: ' + e.message : 'absent (run forge init)'); }
      try { fs.accessSync(path.dirname(TRACE_FILE), fs.constants.W_OK); check('trace writable', true, 'forge/state/'); }
      catch (_) { check('trace writable', false, 'state dir not writable'); }
    } else check('config.json', true, 'no forge project here (fine if exploring)');
    let bad = 0;
    for (const r of rows) { if (!r.ok) bad += r.warn ? 0 : 1; out(`${r.ok ? 'PASS' : r.warn ? 'WARN' : 'FAIL'}  ${r.name}: ${r.note}`); }
    out(bad ? `\n${bad} check(s) FAILED — fix before trusting any other symptom.` : `\nInstall and state look sane.`);
    if (bad) process.exit(1);
  },

  // -- stats (v0.6) — process metrics derived from the work graph on disk --------
  stats() {
    const w = loadWork();
    if (!w.order.length) die('No work items yet — nothing to measure.');
    const items = w.order.map(id => w.items[id]);
    const by = {};
    items.forEach(i => { by[i.status] = (by[i.status] || 0) + 1; });
    out(`# Forge stats — derived from forge/state/work.json (zero tokens, no estimates)`);
    out(`Items: ${items.length} — ` + Object.entries(by).map(([k, v]) => `${k}:${v}`).join(' · '));

    const done = items.filter(i => i.status === 'DONE');
    const failsOf = i => i.attempts.filter(a => a.outcome === 'failed').length;
    if (done.length) {
      const firstPass = done.filter(i => failsOf(i) === 0).length;
      const totalFails = done.reduce((a, i) => a + failsOf(i), 0);
      out(`\n## Outcomes (${done.length} DONE)`);
      out(`  First-pass rate: ${firstPass}/${done.length} (${Math.round(100 * firstPass / done.length)}%) — done with zero failed attempts`);
      out(`  Failed attempts absorbed: ${totalFails} · avg ${(totalFails / done.length).toFixed(2)} per completed item`);
      const retried = done.filter(i => failsOf(i) > 0).sort((a, b) => failsOf(b) - failsOf(a)).slice(0, 8);
      if (retried.length) out(`  Most retried: ` + retried.map(i => `${i.id}×${failsOf(i)}`).join(' · '));
      const esc = items.reduce((a, i) => a + i.attempts.filter(x => x.outcome === 'started' && x.escalation).length, 0);
      out(`  Escalations invoked: ${esc}`);
      // start → done wall-clock (includes human time: reviews, gates, nights — this is elapsed, not effort)
      const spans = done.map(i => {
        const s = i.attempts.find(a => a.outcome === 'started');
        const p = [...i.attempts].reverse().find(a => a.outcome === 'passed');
        return s && p ? (Date.parse(p.ts) - Date.parse(s.ts)) / 3600000 : null;
      }).filter(v => v !== null && v >= 0).sort((a, b) => a - b);
      if (spans.length) {
        const med = spans[Math.floor(spans.length / 2)];
        out(`  First-start → done elapsed: median ${med < 1 ? Math.round(med * 60) + 'min' : med.toFixed(1) + 'h'} · ` +
            `p90 ${(spans[Math.floor(spans.length * 0.9)]).toFixed(1)}h  (wall-clock — includes review/gate/idle time)`);
      }
    }

    // milestones
    const ms = [];
    items.forEach(i => { if (i.milestone && !ms.includes(i.milestone)) ms.push(i.milestone); });
    if (ms.length) {
      out(`\n## Milestones`);
      for (const m of ms) {
        const mi = items.filter(i => i.milestone === m);
        const mdone = mi.filter(i => i.status === 'DONE').length;
        const mfails = mi.reduce((a, i) => a + failsOf(i), 0);
        const g = (w.gates || {})[m];
        out(`  ${m}: ${mdone}/${mi.length} done · ${mfails} failed attempt(s) · gate: ` +
            (g && g.approved ? `approved ${g.ts.slice(0, 10)}` : (mdone === mi.length ? 'COMPLETE — awaiting human review' : 'pending')));
      }
    }
    out(`\nCaveat: elapsed times are wall-clock spans between recorded state transitions, not effort. ` +
        `Token/dispatch telemetry lives in 'forge usage'.`);
  },

  // -- usage (v0.4) — OBSERVED telemetry from local Claude Code session logs ------
  usage() {
    const projectsRoot = process.env.FORGE_CLAUDE_PROJECTS || path.join(os.homedir(), '.claude', 'projects');
    if (!fs.existsSync(projectsRoot)) die(`UNAVAILABLE: no Claude Code session logs found at ${projectsRoot}.`);
    // locate this project's transcript folder: sanitized-cwd name, else scan for matching cwd
    const sanitized = PROJECT.replace(/[^a-zA-Z0-9]/g, '-');
    let dirCandidates = [path.join(projectsRoot, sanitized)].filter(fs.existsSync);
    if (!dirCandidates.length) {
      for (const d of fs.readdirSync(projectsRoot)) {
        const full = path.join(projectsRoot, d);
        try {
          const f = fs.readdirSync(full).find(x => x.endsWith('.jsonl'));
          if (!f) continue;
          const head = fs.readFileSync(path.join(full, f), 'utf8').split('\n').slice(0, 20).join('\n');
          if (head.includes(`"cwd":${JSON.stringify(PROJECT)}`)) { dirCandidates.push(full); break; }
        } catch (_) { /* skip */ }
      }
    }
    if (!dirCandidates.length)
      die(`UNAVAILABLE: no session logs for this project under ${projectsRoot}.\n` +
          `(Logs appear after Claude Code sessions run in ${PROJECT}.)`);

    const agg = {
      sessions: 0, firstTs: null, lastTs: null,
      models: {},          // model → {thread: main|side} → {calls,in,out,cacheCreate,cacheRead}
      dispatches: [],      // {ts, type, itemId|null}
      byDay: {},           // yyyy-mm-dd → out tokens
    };
    // Known work-item ids, for tying dispatches whose prompt names an item
    // without an inline brief header (e.g. brief passed by file path).
    let knownIdRe = null;
    try {
      const ids = Object.keys(loadWork().items || {})
        .filter(id => /^[A-Za-z0-9][\w.-]*$/.test(id))
        .sort((a, b) => b.length - a.length); // longest first: T20f before T20
      if (ids.length) knownIdRe = new RegExp(`\\b(${ids.map(id => id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})\\b`);
    } catch (_) { /* no work graph → inline/path matching only */ }
    const bump = (model, thread, u) => {
      const m = (agg.models[model] = agg.models[model] || {});
      const t = (m[thread] = m[thread] || { calls: 0, in: 0, out: 0, cacheCreate: 0, cacheRead: 0 });
      t.calls++; t.in += u.input_tokens || 0; t.out += u.output_tokens || 0;
      t.cacheCreate += u.cache_creation_input_tokens || 0; t.cacheRead += u.cache_read_input_tokens || 0;
    };
    // main-session transcripts sit in the project dir; worker transcripts sit in
    // <session-uuid>/subagents/agent-*.jsonl subdirectories (Claude Code >= 2.1)
    const files = [];
    for (const dir2 of dirCandidates) {
      for (const entry of fs.readdirSync(dir2)) {
        const full = path.join(dir2, entry);
        if (entry.endsWith('.jsonl')) { files.push({ f: full, forcedSide: false, isSession: true }); continue; }
        const sub = path.join(full, 'subagents');
        try {
          if (fs.statSync(full).isDirectory() && fs.existsSync(sub))
            for (const wf of fs.readdirSync(sub).filter(x => x.endsWith('.jsonl')))
              files.push({ f: path.join(sub, wf), forcedSide: true, isSession: false });
        } catch (_) { /* skip */ }
      }
    }
    {
      for (const { f, forcedSide, isSession } of files) {
        if (isSession) agg.sessions++;
        for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
          if (!line.trim()) continue;
          let d; try { d = JSON.parse(line); } catch (_) { continue; }
          const tsv = d.timestamp;
          if (tsv) {
            if (!agg.firstTs || tsv < agg.firstTs) agg.firstTs = tsv;
            if (!agg.lastTs || tsv > agg.lastTs) agg.lastTs = tsv;
          }
          if (d.type !== 'assistant' || !d.message) continue;
          const model = d.message.model || 'unknown';
          if (model === '<synthetic>') continue;
          const u = d.message.usage || {};
          bump(model, (forcedSide || d.isSidechain) ? 'side' : 'main', u);
          if (tsv) agg.byDay[tsv.slice(0, 10)] = (agg.byDay[tsv.slice(0, 10)] || 0) + (u.output_tokens || 0);
          for (const c of (Array.isArray(d.message.content) ? d.message.content : [])) {
            if (c && c.type === 'tool_use' && (c.name === 'Task' || c.name === 'Agent')) {
              const p = (c.input || {}).prompt || '';
              // Tie dispatch → work item. In order of confidence:
              // 1. inline brief header; 2. brief file path; 3. first known work-item id in the prompt.
              let itemId = null;
              const m2 = p.match(/Work brief — (\S+?):/);
              if (m2) itemId = m2[1];
              if (!itemId) { const m3 = p.match(/[Bb]riefs?\/([A-Za-z0-9][\w.-]*?)\.md\b/); if (m3) itemId = m3[1]; }
              if (!itemId && knownIdRe) { const m4 = p.match(knownIdRe); if (m4) itemId = m4[1]; }
              agg.dispatches.push({ ts: tsv || null, type: (c.input || {}).subagent_type || 'unknown', itemId });
            }
          }
        }
      }
    }

    // ---- report ----
    out(`# Forge usage — OBSERVED from local session logs (never estimated)`);
    out(`Source: ${dirCandidates.join(', ')}`);
    out(`Sessions: ${agg.sessions} · window: ${agg.firstTs ? agg.firstTs.slice(0, 16) : '?'} → ${agg.lastTs ? agg.lastTs.slice(0, 16) : '?'}`);
    out(`\n## Tokens by model and thread (main = orchestrator, side = dispatched subagents)`);
    let mainOut = 0, sideOut = 0;
    for (const [model, threads] of Object.entries(agg.models)) {
      for (const [thread, t] of Object.entries(threads)) {
        if (thread === 'main') mainOut += t.out; else sideOut += t.out;
        out(`  ${model} [${thread}]: ${t.calls} calls · in ${t.in.toLocaleString()} · out ${t.out.toLocaleString()} · cache write ${t.cacheCreate.toLocaleString()} / read ${t.cacheRead.toLocaleString()}`);
      }
    }
    const totOut = mainOut + sideOut;
    out(`\n## Delegation`);
    if (sideOut === 0 && agg.dispatches.length > 0)
      out(`  Output tokens — orchestrator: ${mainOut.toLocaleString()} · subagents: UNAVAILABLE\n` +
          `  (dispatches exist but no subagent-thread usage appears in these logs — this Claude Code version\n` +
          `   likely stores worker transcripts elsewhere; token split by thread cannot be observed here)`);
    else
      out(`  Output tokens — orchestrator: ${mainOut.toLocaleString()} · subagents: ${sideOut.toLocaleString()}` +
          (totOut ? ` · ${Math.round(100 * sideOut / totOut)}% delegated` : ''));
    const byType = {};
    for (const disp of agg.dispatches) byType[disp.type] = (byType[disp.type] || 0) + 1;
    // plugin agents report as "forge:forge-implementer"; bare "forge-implementer" also counts
    const forgeCount = Object.entries(byType).filter(([k]) => k.includes('forge-')).reduce((a, [, v]) => a + v, 0);
    out(`  Dispatches: ${agg.dispatches.length} total — ` +
        (Object.keys(byType).length ? Object.entries(byType).map(([k, v]) => `${k}×${v}`).join(' · ') : 'NONE'));
    if (agg.dispatches.length)
      out(`  Through forge roster: ${forgeCount}/${agg.dispatches.length}` +
          (forgeCount < agg.dispatches.length ? '  ← work is bypassing the forge agents (built-in/other types above)' : ''));
    else
      out(`  ← ZERO dispatches: the orchestrator is doing all work itself in the main thread.`);
    const tied = agg.dispatches.filter(d2 => d2.itemId);
    const perItem = {};
    for (const d2 of tied) perItem[d2.itemId] = (perItem[d2.itemId] || 0) + 1;
    out(`  Tied to work items (inline brief, brief file path, or known item id in prompt): ` +
        (tied.length ? Object.entries(perItem).map(([k, v]) => `${k}×${v}`).join(' · ') : 'none') +
        (agg.dispatches.length - tied.length ? ` · ${agg.dispatches.length - tied.length} dispatch(es) could not be tied to any work item` : ''));

    // v0.12: dispatch records from state (forge task dispatch) — authoritative
    // when present; the transcript inference above remains the fallback for old logs.
    try {
      const wU = readJson(WORK_FILE, { items: {}, order: [] });
      const dByAgent = {}; let dTotal = 0, dMsg = 0, dItems = 0;
      for (const id of wU.order) {
        const ds = wU.items[id].dispatches || [];
        if (ds.length) dItems++;
        for (const d3 of ds) {
          dTotal++; if (d3.kind === 'message') dMsg++;
          const a = d3.agent || '(agent not named)';
          dByAgent[a] = (dByAgent[a] || 0) + 1;
        }
      }
      if (dTotal)
        out(`  Dispatch records in state (forge task dispatch — authoritative): ${dTotal} across ${dItems} item(s)` +
            (dMsg ? ` · ${dMsg} mid-flight message(s)` : '') + ` — ` +
            Object.entries(dByAgent).map(([k, v]) => `${k}×${v}`).join(' · '));
    } catch (_) { /* no work file */ }

    // drift: tokens spent after the last forge state change
    try {
      const stateM = fs.statSync(WORK_FILE).mtime.toISOString();
      let after = 0;
      for (const dir2 of dirCandidates)
        for (const f of fs.readdirSync(dir2).filter(x => x.endsWith('.jsonl')))
          for (const line of fs.readFileSync(path.join(dir2, f), 'utf8').split('\n')) {
            if (!line.includes('"assistant"')) continue;
            let d2; try { d2 = JSON.parse(line); } catch (_) { continue; }
            if (d2.type === 'assistant' && d2.timestamp > stateM && d2.message && d2.message.usage)
              after += d2.message.usage.output_tokens || 0;
          }
      out(`\n## Progress vs spend`);
      out(`  Last forge state change: ${stateM.slice(0, 16)} · output tokens spent SINCE then: ${after.toLocaleString()}`);
      if (after > 20000) out(`  ← significant spend with no state movement: work may be happening outside the forge loop. Check what the session is doing.`);
    } catch (_) { /* no work file */ }

    out(`\n## Activity by day (output tokens)`);
    for (const [day, v] of Object.entries(agg.byDay).sort())
      out(`  ${day}: ${'█'.repeat(Math.min(40, Math.ceil(v / 2000)))} ${v.toLocaleString()}`);
    out(`\nCaveats: per-agent-type token attribution inside subagent threads is not exposed by the logs (reported in aggregate as [side]); ` +
        `milestone-level token attribution is not reliably derivable and is therefore not shown. Absent data is absent, never estimated.`);
    if (flag('write')) {
      writeJson(path.join(STATE, 'usage.json'), { ts: ts(), models: agg.models, dispatches: agg.dispatches.length, byType, mainOut, sideOut });
      out('\nSaved snapshot: forge/state/usage.json');
    }
  },

  // -- milestone gates (F9) -------------------------------------------------------
  milestone() {
    const sub = argv[1];
    const w = loadWork();
    w.gates = w.gates || {};
    if (sub === 'list') {
      const cfg = loadConfig() || {};
      out(`Gating mode: ${(cfg.options || {}).gates || 'per-milestone'}`);
      for (const m of milestoneSeq(w)) {
        const items = w.order.filter(id => w.items[id].milestone === m);
        const done = items.filter(id => ['DONE', 'CANCELLED'].includes(w.items[id].status)).length;
        const g = w.gates[m];
        const state = g && g.approved ? `APPROVED ${g.ts}${g.note ? ` — ${g.note}` : ''}`
          : (milestoneComplete(w, m) ? 'COMPLETE — AWAITING HUMAN APPROVAL' : 'in progress');
        out(`  ${m}: ${done}/${items.length} items · ${state}`);
      }
    } else if (sub === 'security') {
      // v0.8: record the milestone security review (fresh-context reviewer over the slice's diff)
      const m = argv[2];
      if (!m || !milestoneSeq(w).includes(m)) die(`Unknown milestone '${m || ''}'. See: forge milestone list`);
      if (!opt('note')) die('Usage: forge milestone security <M> --note "<who reviewed, what was covered, findings summary>"');
      w.gates[m] = Object.assign({}, w.gates[m], { security: { ts: ts(), note: opt('note') } });
      saveWork(w);
      out(`Security review recorded for milestone '${m}'. Findings become work items BEFORE the gate is approved.`);
    } else if (sub === 'approve') {
      const m = argv[2];
      if (!m || !milestoneSeq(w).includes(m)) die(`Unknown milestone '${m || ''}'. See: forge milestone list`);
      if (!milestoneComplete(w, m))
        die(`Refused: milestone '${m}' still has unfinished items — approval is for a testable, finished slice.`);
      // v0.8: security is part of the gate, not an afterthought
      const secMode = ((loadConfig() || {}).options || {}).security;
      const hasSec = ((w.gates[m] || {}).security || {}).ts;
      let secSkip = null;
      if (secMode !== 'off' && !hasSec) {
        if (flag('skip-security')) {
          if (!opt('reason')) die('--skip-security requires --reason "..." (recorded in the decisions log).');
          secSkip = opt('reason');
        } else {
          die(`Refused: milestone '${m}' has no recorded security review.\n` +
              `Run the pass first (fresh-context forge-reviewer + security domain pack over the milestone's diff), then:\n` +
              `  forge milestone security ${m} --note "<findings summary>"\n` +
              `Or skip deliberately: forge milestone approve ${m} --skip-security --reason "..." — or disable for this project: forge config set options.security off`);
        }
      }
      w.gates[m] = Object.assign({}, w.gates[m], { approved: true, ts: ts(), note: opt('note') || null, securitySkipped: secSkip });
      saveWork(w);
      appendMd(DECISIONS_FILE, '# Decisions log (append-only, via forge CLI)',
        `\n### ${ts()} — Milestone '${m}' approved\n- Authority: human\n- Decision: milestone gate approved after human review${secSkip ? ` (SECURITY REVIEW SKIPPED: ${secSkip})` : ''}\n- Why: ${opt('note') || '(no note recorded)'}\n`);
      out(`Milestone '${m}' approved — later milestones may now start.`);
      out(`📊 forge/dashboard.html now shows this milestone closed — worth a look for the user.`);
    } else if (sub === 'reopen') {
      const m = argv[2];
      if (!opt('reason')) die('Reopening a gate must be explicit: --reason "..."');
      if (!w.gates[m] || !w.gates[m].approved) die(`Milestone '${m}' is not approved; nothing to reopen.`);
      w.gates[m] = { approved: false, ts: ts(), note: `REOPENED: ${opt('reason')}` };
      saveWork(w);
      out(`Milestone '${m}' gate reopened: ${opt('reason')} — items in later milestones are blocked again.`);
    } else die('Usage: forge milestone list | security <name> --note "..." | approve <name> [--note "..."] [--skip-security --reason "..."] | reopen <name> --reason "..."');
  },

  // -- dashboard ----------------------------------------------------------------
  dashboard() {
    if (!loadConfig()) die('No forge project here (run: forge init).');
    generateDashboard();
    out(`Dashboard regenerated: ${path.relative(PROJECT, DASHBOARD_FILE)}`);
    out('Open it in a browser. It also auto-regenerates after every state change — just reload the tab.');
  },

  // -- hooks ------------------------------------------------------------------
  hook() {
    const which = argv[1];
    const stdin = fs.readFileSync(0, 'utf8');
    let input = {};
    try { input = JSON.parse(stdin || '{}'); } catch (_) { /* tolerate */ }

    if (which === 'session-start') {
      const parts = [];
      const operating = path.join(PLUGIN_ROOT, 'core', 'OPERATING.md');
      if (fs.existsSync(operating)) parts.push(fs.readFileSync(operating, 'utf8'));
      // 2.4: imperative — there is no installed `forge` binary
      parts.push(`\n---\nIMPORTANT — command form: there is NO installed 'forge' binary. Wherever this contract, a skill, or a doc says 'forge X', the actual command is:\n` +
        `    node "${path.join(PLUGIN_ROOT, 'bin', 'forge.js')}" X\n` +
        `run from the project root. This applies to every forge command, every time.\n`);
      if (fs.existsSync(CONFIG_FILE)) {
        const digest = spawnSync(process.execPath, [__filename, 'status'], { cwd: PROJECT, encoding: 'utf8' });
        parts.push('## Current project state\n```\n' + (digest.stdout || '') + '```');
        parts.push('Run `forge preflight` if state above shows it was never run or is stale.');
        // v0.13: deterministic "next step" — the user is guided by the hand, every session.
        try {
          const wNS = JSON.parse(fs.readFileSync(WORK_FILE, 'utf8'));
          const cfgNS = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
          const items = wNS.order.map(id => wNS.items[id]);
          const inProg = wNS.order.filter(id => wNS.items[id].status === 'IN_PROGRESS');
          const blocked = wNS.order.filter(id => wNS.items[id].status === 'BLOCKED');
          const ready = wNS.order.filter(id => {
            const t = wNS.items[id];
            return t.status === 'TODO' && (t.deps || []).every(d => !wNS.items[d] || wNS.items[d].status === 'DONE') && (t.criteria || []).length > 0;
          });
          const awaiting = [];
          for (const m of milestoneSeq(wNS)) {
            if (milestoneComplete(wNS, m) && !(((wNS.gates || {})[m]) || {}).approved) awaiting.push(m);
          }
          const allDone = items.length > 0 && items.every(t => ['DONE', 'CANCELLED'].includes(t.status));
          let ns;
          if (cfgNS.phase === 'spec') {
            ns = 'This project is in the SPEC PHASE. Tell the user in plain words: "We\'re still designing — I\'ll pick the interview up where we left off." Resume the forge-method interview at the first ungated layer. If they have feature lists, notes, or sketches they haven\'t shared yet, ask for them NOW.';
          } else if (inProg.length) {
            ns = `Open work is IN_PROGRESS (${inProg.join(', ')}). Tell the user: "Picking up where we left off." Settle each in-flight item first (verify+done / fail with diagnosis / block with reason), then continue the build loop.`;
          } else if (awaiting.length) {
            ns = `Milestone '${awaiting[0]}' is COMPLETE and waiting for the USER's review. Tell them plainly: "Your turn — try the running slice" (say exactly how to run/see it), collect their verdict, ask what they'd like to change before the next milestone, then record: forge milestone approve ${awaiting[0]} --note "...".`;
          } else if (ready.length) {
            ns = `${ready.length} item(s) are READY. Tell the user: "Ready to keep building — say 'continue' and I'll take the next item (${ready[0]})." If they'd rather change direction first, take their feedback into decisions and the work graph before dispatching.`;
          } else if (blocked.length) {
            ns = `Everything runnable is BLOCKED (${blocked.join(', ')}). Surface each block reason to the user and resolve together — most blocks need a product answer only they can give.`;
          } else if (allDone) {
            ns = 'All planned work is DONE. Tell the user, then offer the two ways forward: (a) a bounded change, or (b) a new destination/feature set — the forge-brownfield entry fork. This is also the moment to share any new feature list or mockups.';
          } else {
            ns = 'The work graph is empty or nothing is startable. Review the spec/plan with the user and create or unblock work items (forge task add / update).';
          }
          parts.push('## YOUR NEXT STEP (tell the user this in plain language, first thing)\n' + ns +
            '\n\n📊 Remind the user when useful: `forge/dashboard.html` (open in a browser) is the visual picture of the whole project — progress, milestones, components, telemetry. It updates itself.');
        } catch (_) { /* guidance is best-effort; never break session start */ }
      } else {
        parts.push('## Current project state\nForge is installed but this project has no forge/config.json yet.\n\n' +
          '## GUIDE THE USER IN (they may be non-technical — hold their hand)\n' +
          'Greet them, explain in one sentence what happens next, and ask which door fits:\n' +
          '- **A new product from scratch** → forge-method skill: a layered interview (vision → domain → experience → API → logic → foundation). Tell them: "I\'ll ask you questions in plain language, one topic at a time — no tech knowledge needed."\n' +
          '- **An existing codebase, one bounded change** → forge-brownfield skill, mode A.\n' +
          '- **An existing codebase with a destination** (a feature list / roadmap / redesign) → forge-brownfield skill, mode B.\n' +
          'THE FEATURE DUMP MOMENT IS NOW: explicitly invite them — "If you have feature lists, notes, sketches, or documents describing what you want, paste or attach them now; they shape everything I ask next." Never make them guess when to share.\n' +
          'Then run `forge init` and begin. Mention once: forge/dashboard.html will be their visual progress page.');
      }
      // v0.5: one orchestrator per project — surface the lock at session start
      {
        const sid = input.session_id || null;
        const l = loadLock();
        if (l && lockFresh(l) && l.sessionId !== sid) {
          parts.push(`\n## ⚠ ANOTHER ORCHESTRATOR IS ACTIVE\n` +
            `Session ${String(l.sessionId).slice(0, 8)}… last wrote ${lockAge(l)} in this project. ` +
            `Do NOT orchestrate, dispatch workers, or edit files — your writes will be blocked by the edit-war guard. ` +
            `Tell the user immediately: either close the other session, or (if it is dead) run \`forge session takeover --force\`. ` +
            `Until then, operate read-only.`);
        } else if (sid && (!l || !lockFresh(l) || l.sessionId === sid)) {
          saveLock({ sessionId: sid, startedAt: (l && l.sessionId === sid && l.startedAt) || ts(), lastBeat: ts(), released: false });
          if (l && !l.released && !lockFresh(l) && l.sessionId !== sid)
            parts.push(`\nNote: took over a stale orchestrator lock (session ${String(l.sessionId).slice(0, 8)}…, last active ${lockAge(l)}). ` +
              `If that session left items IN_PROGRESS, audit them before dispatching new work.`);
        }
      }
      out(parts.join('\n'));
      process.exit(0);

    } else if (which === 'pretooluse') {
      const tool = input.tool_name || '';
      if (!['Write', 'Edit', 'MultiEdit', 'NotebookEdit'].includes(tool)) process.exit(0);
      const fp = (input.tool_input || {}).file_path || (input.tool_input || {}).notebook_path || '';
      if (!fp) process.exit(0);
      const abs = path.resolve(PROJECT, fp);
      const protectedPaths = [STATE + path.sep, CONFIG_FILE];
      const isProtected = protectedPaths.some(p => p.endsWith(path.sep) ? abs.startsWith(p) : abs === p);
      if (isProtected) {
        traceEvent({ outcome: 'block', hook: 'pretooluse', reason: 'state-guard', path: fp, input: DEBUG ? JSON.stringify(input).slice(0, 2000) : undefined });
        process.stderr.write(
          `Forge state files are managed exclusively by the forge CLI — direct edits are blocked.\n` +
          `Use: forge task ... | forge config set ... | forge decision add ... | forge discovery add ...\n`);
        process.exit(2);
      }
      // v0.5 edit-war guard: refuse writes while a DIFFERENT orchestrator session is actively writing
      {
        const sid = input.session_id || null;
        if (sid) {
          const l = loadLock();
          if (l && l.sessionId !== sid && lockFresh(l)) {
            traceEvent({ outcome: 'block', hook: 'pretooluse', reason: 'edit-war', path: fp, holder: String(l.sessionId).slice(0, 8), input: DEBUG ? JSON.stringify(input).slice(0, 2000) : undefined });
            process.stderr.write(
              `EDIT-WAR GUARD: another orchestrator session (${String(l.sessionId).slice(0, 8)}…, last active ${lockAge(l)}) ` +
              `is writing to this project. Two orchestrators editing one tree caused data loss before; this write is blocked.\n` +
              `Tell the user: close one of the two sessions — or, if the other one is dead, run: forge session takeover --force\n`);
            process.exit(2);
          }
          saveLock({ sessionId: sid, startedAt: (l && l.sessionId === sid && l.startedAt) || ts(), lastBeat: ts(), released: false });
        }
      }
      // v0.6 scope guard: config-protected paths and the forbidden scope of
      // IN_PROGRESS items are refusals, not advice. Never crash the hook.
      try {
        const rel = path.relative(PROJECT, path.resolve(PROJECT, fp)).replace(/\\/g, '/');
        const matches = (pattern) => {
          const pat = String(pattern).replace(/\\/g, '/').replace(/^\.\//, '');
          if (!pat) return false;
          if (pat.endsWith('/')) return rel === pat.slice(0, -1) || rel.startsWith(pat);
          if (pat.includes('*')) {
            const re = new RegExp('^' + pat.split('*').map(s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[^]*') + '$');
            return re.test(rel);
          }
          return rel === pat || rel.startsWith(pat + '/');
        };
        let cfg = null; try { cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch (_) { }
        const prot = String(((cfg || {}).options || {}).protect || '').split(',').map(s => s.trim()).filter(Boolean);
        const hitProt = prot.find(p => matches(p));
        if (hitProt) {
          traceEvent({ outcome: 'block', hook: 'pretooluse', reason: 'protect', path: fp, pattern: hitProt });
          process.stderr.write(
            `PROTECTED PATH: '${rel}' is frozen by config (options.protect: '${hitProt}') — the edit is blocked.\n` +
            `If this change is genuinely intended, the human updates the protection first:\n` +
            `forge config set options.protect "<new comma-separated list>"\n`);
          process.exit(2);
        }
        let w = null; try { w = JSON.parse(fs.readFileSync(WORK_FILE, 'utf8')); } catch (_) { }
        for (const id of (w && w.order) || []) {
          const it = w.items[id];
          if (!it || it.status !== 'IN_PROGRESS') continue;
          const hit = ((it.scope || {}).forbidden || []).find(p => matches(p));
          if (hit) {
            traceEvent({ outcome: 'block', hook: 'pretooluse', reason: 'scope', path: fp, item: id, pattern: hit });
            process.stderr.write(
              `SCOPE GUARD: '${rel}' is in the FORBIDDEN scope of in-progress item ${id} ('${hit}') — the edit is blocked.\n` +
              `Per the brief: if correctness requires touching excluded areas, STOP and report — never expand scope silently.\n` +
              `If the scope itself is wrong, revise it deliberately first: forge task update ${id} --forbidden "..." --reason "..."\n`);
            process.exit(2);
          }
        }
        // v0.12: scope.allowed enforced as a WHITELIST (union across in-progress items).
        // Only active when every in-progress item declares a scope (pre-v0.12 state stays
        // blacklist-only). Exempt: forge/, the spec dir, docs/, and *.md (briefs, CLAUDE.md,
        // PLAN.md — orchestrator housekeeping); options.scopeExempt overrides the dir list.
        {
          const inProg2 = [];
          for (const id of (w && w.order) || []) {
            const it = w.items[id];
            if (it && it.status === 'IN_PROGRESS') inProg2.push({ id, it });
          }
          if (inProg2.length && inProg2.every(x => ((x.it.scope || {}).allowed || []).length)) {
            const exempt = String((((cfg || {}).options || {}).scopeExempt) || 'forge/,spec/,docs/')
              .split(',').map(s => s.trim()).filter(Boolean);
            if (cfg && cfg.specDir) exempt.push(String(cfg.specDir).replace(/\/?$/, '/'));
            const isExempt = /\.md$/i.test(rel) || exempt.some(p => matches(p));
            if (!isExempt) {
              const union = [];
              for (const x of inProg2) union.push(...x.it.scope.allowed);
              if (!union.some(p => matches(p))) {
                traceEvent({ outcome: 'block', hook: 'pretooluse', reason: 'scope-allowed', path: fp, items: inProg2.map(x => x.id) });
                process.stderr.write(
                  `SCOPE GUARD: '${rel}' is OUTSIDE the allowed scope of every in-progress item (${inProg2.map(x => x.id).join(', ')}) — the edit is blocked.\n` +
                  `Work stays inside its declared territory. If this path genuinely belongs to the work, widen the scope\n` +
                  `deliberately first: forge task update <id> --allowed "..." — never work around the guard.\n`);
                process.exit(2);
              }
            }
          }
        }
      } catch (_) { /* hooks never crash */ }
      process.exit(0);

    } else if (which === 'stop') {
      // v0.5: release the orchestrator lock on clean finish (kept on exit 2 — session continues)
      const releaseLock = () => {
        const sid = input.session_id || null;
        const l = loadLock();
        if (sid && l && l.sessionId === sid && !l.released) saveLock(Object.assign({}, l, { released: true, lastBeat: ts() }));
      };
      if (input.stop_hook_active) { releaseLock(); process.exit(0); } // never loop
      let w = null;
      try { w = JSON.parse(fs.readFileSync(WORK_FILE, 'utf8')); } catch (_) { releaseLock(); process.exit(0); } // P4: never crash a hook on bad state
      if (!w) { releaseLock(); process.exit(0); }
      const inProg = w.order.filter(id => w.items[id].status === 'IN_PROGRESS');
      // 3.2: twice-failed TODO items are dangling work too — surface them
      const failedTodo = w.order.filter(id => {
        const t = w.items[id];
        return t.status === 'TODO' && t.attempts.some(a => a.outcome === 'failed');
      });
      if (!inProg.length && !failedTodo.length) { releaseLock(); process.exit(0); }
      let msg = '';
      if (inProg.length) msg +=
        `Open work items are still IN_PROGRESS: ${inProg.join(', ')}.\n` +
        `Before finishing: verify and complete them (forge task verify/done), mark them blocked with a reason (forge task block --reason), ` +
        `or record a failed attempt with a diagnosis (forge task fail --note). If the user asked to pause, block with reason "user paused".\n`;
      if (failedTodo.length) msg +=
        `Items with recorded failed attempts are sitting in TODO: ${failedTodo.join(', ')}. ` +
        `State their disposition in your closing summary (queued for escalation / superseded / awaiting decision) so nothing dangles silently.\n`;
      traceEvent({ outcome: 'block', hook: 'stop', reason: 'dangling-work', inProgress: inProg, failedTodo });
      process.stderr.write(msg + `Then give the user a short status summary.\n`);
      process.exit(2);

    } else die('Usage: forge hook session-start|pretooluse|stop');
  },

  help() {
    out(`forge — Forge v0 state CLI
  init [--project name]                  create forge/ state (idempotent)
  preflight [--full]                     check git, verify commands, graphify, playwright
  config get [path] | set <path> <val>   read/write forge config
  task add --id T1 --title .. --objective .. [--milestone M1] [--deps A,B]
           [--criterion "desc::check-cmd"]... [--allowed glob,..] [--forbidden glob,..]
           (or: task add --json '{...}')
  task list [--status S] | show <id>
  task start <id> [--agent forge-implementer] [--escalate strategy --note why] [--whole-tree --reason r]
                                         refuses: no criteria, unmet deps, unapproved earlier milestone,
                                         already IN_PROGRESS, 3rd attempt w/o --escalate, EMPTY scope.allowed
                                         (set it: task update --allowed; deliberate: --whole-tree --reason),
                                         concurrency cap reached (options.concurrency, default 1 = serial),
                                         scope overlap with an in-progress item; records pre-work check state
  task dispatch <id> [--agent name] [--kind launch|message] [--note n]
                                         record the handoff to a worker (state, not transcript inference);
                                         kind=message audits a mid-flight message to a running worker
  task verify <id> [--skip-baseline --reason r]
                                         project checks + criterion checks + baseline (when captured); records evidence + tree state
  task done <id>                         refuses: no passing verification, tree changed since verification,
                                         checks that were green before work with an unchanged tree
  task fail <id> --note "diagnosis"      record failed attempt (2 failures ⇒ escalation required)
  task update <id> [--title|--objective|--milestone|--deps|--allowed|--forbidden]
                   [--criterion-add "d::cmd"]... [--criterion-remove i]... [--reason r]
                                         audited edits; criteria changes after failures require --reason
  task block <id> --reason | cancel <id> --reason [--dependents drop|cancel]
  milestone list | approve <m> [--note] | reopen <m> --reason
                                         human gates between milestones (config: options.gates per-milestone|end-only)
  brief <id>                             print the brief skeleton for a work item
  decision add --title --decision --why [--authority human|forge]
  discovery add --title --evidence --impact [--affects T1,T2]
  baseline capture | check               brownfield: record and guard pre-existing state
  status                                 project overview
  dashboard                              (re)generate forge/dashboard.html — also auto-regens on every state change
  usage [--write]                        OBSERVED token/dispatch report from local session logs:
                                         by model, orchestrator vs subagents, dispatches by agent type,
                                         per-item dispatch counts, spend since last state change
  component add|update <id> ... | list   project-map registry (kind/route/mock/doc); items tag via task --component
  trace [--refusals|--hooks|--last N]    flight recorder: every CLI call and hook decision (FORGE_DEBUG=1 = verbose)
  doctor                                 install/state self-check: versions, cache, hooks, lock, orphaned work
  stats                                  process metrics from the work graph: first-pass rate, retries,
                                         escalations, elapsed times, per-milestone health
  session status | takeover [--force]    orchestrator lock: who is allowed to write; takeover clears a dead session's lock
  hook session-start|pretooluse|stop     (used by plugin hooks)

  config keys: verify.* · options.gates per-milestone|end-only · options.security off · options.protect "p1/,p2/"
               options.concurrency N     max items IN_PROGRESS at once (default 1 = serial; raise only with
                                         disjoint scopes — see OPERATING.md parallel dispatch)
               options.scopeExempt "a/,b/"  dirs exempt from the scope whitelist (default forge/,spec/,docs/; *.md always exempt)
  state writes are serialised by forge/state/work.lock (concurrent forge processes wait, then refuse;
  a dead process's lock breaks automatically and is recorded in trace.jsonl)`);
  }
};

// ---------------------------------------------------------------------------

const cmd = argv[0] || 'help';
if (!commands[cmd]) die(`Unknown command '${cmd}'. Try: forge help`);
commands[cmd]();
