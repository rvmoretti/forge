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
// v0.19: piping into head/less and quitting early is normal, not a crash
process.stdout.on('error', e => { if (e && e.code === 'EPIPE') process.exit(0); });

function loadConfig() { return readJson(CONFIG_FILE, null); }
function loadWork() { if (MUTATING) acquireWorkLock(); return readJson(WORK_FILE, { schema: 1, items: {}, order: [] }); }
function saveWork(w) { ensureMilestones(w); writeJson(WORK_FILE, w); regenDashboard(); }

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
  if (c === 'task') return !['list', 'show', 'next', ''].includes(s);
  if (c === 'milestone') return ['security', 'approve', 'reopen', 'add', 'update', 'move', 'remove', 'ship'].includes(s) && !(s === 'security' && process.argv.includes('--brief'));
  if (c === 'dispatch') return true;
  if (c === 'release') return ['add', 'update', 'move', 'remove', 'freeze', 'tag'].includes(s);
  if (c === 'component') return ['add', 'update'].includes(s);
  if (c === 'arch') return ['add', 'update', 'link', 'unlink', 'confirm', 'remove', 'lanes'].includes(s) || (s === 'scan' && process.argv.includes('--write'));
  if (c === 'screen') return ['add', 'update', 'assign'].includes(s);
  if (c === 'upgrade') return ['apply', 'accept'].includes(s);
  if (c === 'autopilot') return ['on', 'off'].includes(s);
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
      if (!holder || holder.released || !pidAlive(holder.pid) || age > LOCK_STALE_MS) {
        if (!holder || !holder.released) traceWrite({ ts: new Date().toISOString(), v: VERSION, cmd: process.argv.slice(2).join(' ').slice(0, 300),
          outcome: 'lock-break', holder: holder || 'unreadable' });
        try { fs.unlinkSync(WORK_LOCK); continue; } catch (u) {
          if (u.code === 'ENOENT') continue;
          // v0.19.1: a filesystem that refuses deletes (some sandboxes / mounted folders) must not
          // spin here forever — claim the free lock in place and confirm the claim is ours
          const mine = { pid: process.pid, ts: ts(), cmd: process.argv.slice(2).join(' ').slice(0, 160), nonce: crypto.randomBytes(6).toString('hex') };
          try {
            fs.writeFileSync(WORK_LOCK, JSON.stringify(mine));
            const back = JSON.parse(fs.readFileSync(WORK_LOCK, 'utf8'));
            if (back.nonce === mine.nonce) { LOCK_HELD = true; LOCK_INPLACE = true; return; }
          } catch (_) { }
          die(`Refused: the state lock ${path.relative(PROJECT, WORK_LOCK)} is stale (holder pid ${(holder || {}).pid || '?'}) but cannot be removed or claimed (${u.code}).\nRemove the file by hand, then retry.`);
        }
      }
      if (Date.now() >= deadline)
        die(`Refused: forge state is write-locked by another forge process (pid ${holder.pid}: '${holder.cmd}', since ${holder.ts}).\n` +
            `Two concurrent state writes would silently lose one — this refusal is the alternative.\n` +
            `Wait for it to finish and retry. (A dead process's lock breaks automatically; stale ceiling: ${Math.round(LOCK_STALE_MS / 60000)}min.)`);
      sleepMs(100);
    }
  }
}
let LOCK_INPLACE = false;
function releaseWorkLock() {
  if (!LOCK_HELD) return;
  try { fs.unlinkSync(WORK_LOCK); }
  catch (_) { try { fs.writeFileSync(WORK_LOCK, JSON.stringify({ released: true, pid: process.pid, ts: ts() })); } catch (_) { } } // v0.19.1: no-delete filesystems
  LOCK_HELD = false;
}
process.on('exit', releaseWorkLock);
// v0.21 (C6): verifies run one at a time. They share the project's local database, auth
// server and ports, so two at once corrupt each other's results. Unlike the state lock
// (held for milliseconds) a verify can run for minutes: a second verify WAITS, visibly,
// and the state lock is NOT held while checks run, so parallel workers can still record
// starts and dispatches. Same no-delete-filesystem fallbacks as the state lock.
const VERIFY_LOCK = path.join(STATE, 'verify.lock');
const VERIFY_WAIT_MS = parseInt(process.env.FORGE_VERIFY_WAIT_MS || '', 10) || 30 * 60 * 1000;
const VERIFY_STALE_MS = parseInt(process.env.FORGE_VERIFY_STALE_MS || '', 10) || 2 * 60 * 60 * 1000;
let VERIFY_HELD = false;
function acquireVerifyLock(itemId, noWait) {
  if (VERIFY_HELD) return;
  const deadline = Date.now() + VERIFY_WAIT_MS;
  let told = false;
  for (;;) {
    const mine = { pid: process.pid, ts: ts(), item: itemId, nonce: crypto.randomBytes(6).toString('hex') };
    try { fs.writeFileSync(VERIFY_LOCK, JSON.stringify(mine), { flag: 'wx' }); VERIFY_HELD = true; return; }
    catch (e) {
      if (e.code !== 'EEXIST') { VERIFY_HELD = true; return; } // fs oddity — fail open, like the state lock
      let h = null; try { h = JSON.parse(fs.readFileSync(VERIFY_LOCK, 'utf8')); } catch (_) { }
      const age = h && Number.isFinite(Date.parse(h.ts)) ? Date.now() - Date.parse(h.ts) : Infinity;
      if (!h || h.released || !pidAlive(h.pid) || age > VERIFY_STALE_MS) {
        try { fs.unlinkSync(VERIFY_LOCK); continue; } catch (u) {
          if (u.code === 'ENOENT') continue;
          try { fs.writeFileSync(VERIFY_LOCK, JSON.stringify(mine)); if (JSON.parse(fs.readFileSync(VERIFY_LOCK, 'utf8')).nonce === mine.nonce) { VERIFY_HELD = true; return; } } catch (_) { }
          die(`Refused: the verify lock is stale but cannot be removed or claimed (${u.code}). Remove ${path.relative(PROJECT, VERIFY_LOCK)} by hand, then retry.`);
        }
      }
      if (noWait) die(`Refused: another verify is running (${h.item || '?'}, pid ${h.pid}, since ${h.ts}). Verifies run one at a time — they share the local database and servers. Retry when it finishes, or drop --no-wait to queue behind it.`);
      if (!told) { out(`Waiting for the verify of ${h.item || '?'} to finish (pid ${h.pid}, since ${String(h.ts).slice(11, 19)}) — verifies run one at a time because they share the local database and servers.`); told = true; }
      if (Date.now() >= deadline) die(`Refused: waited ${Math.round(VERIFY_WAIT_MS / 60000)}min for the verify of ${h.item || '?'} (pid ${h.pid}). If it is hung, stop it; a dead process's lock breaks by itself.`);
      sleepMs(250);
    }
  }
}
function releaseVerifyLock() {
  if (!VERIFY_HELD) return;
  try { fs.unlinkSync(VERIFY_LOCK); } catch (_) { try { fs.writeFileSync(VERIFY_LOCK, JSON.stringify({ released: true, pid: process.pid, ts: ts() })); } catch (_) { } }
  VERIFY_HELD = false;
}
process.on('exit', releaseVerifyLock);


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
// v0.14: Forge wordmark for the dashboard sidebar (white, embedded — the generated file stays self-contained)
const LOGO_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAGUAAAA4CAYAAADkbDbmAAAP7UlEQVR42u1ce7BdVXn/vrXOOfdFDEEkJIHII0QLKETK4KiYIgyPIhUqNBYsUJRiCh0QanUglNoCRaftCDLoEOVhKGCUWK0d5ZEGBKGUV+Q9aCrvCIFwyb3nsff6fuvXP87a9+6c3NzcSxLAy90ze86956zz7b2/x+/7fd9a64hspYOkkqx0vOdl8nhrjrLy165tzM6y7PinnnqqK33mSLpJLb15xhhSOMmamZ0FYJAkzeyxEMLhpbEVkjqpta0LVUPREUL4FIDHSBLAw2a2iEBIxvlhq7Xu/ZOQ9ibljSzL9jWz/2L7yMzsdJJzSR5GcjbJxekzmtkikr2TkLaV8gbJ9wC4tFA4gH8juSvJ0wHcQ3I5gJ/keb5fnuf7Abgvjfs/M1tQljkJaZufNypmdhqAtUnJPyP5QYZwOMnbAFxDcraIiJktIPkAgEvr9fpOZnZykW8A/CTL+IHiGitWrKhMavoN5A2Sh5rZwyk4fh1COIzkPAA/AnBbnucfLif14hXAPwJ4nOTnBgYGpgP4RhFhIYSLSG5Tut4kpI0Fqlqt1p4AbkoenpnZwlartQfJfwXwIMlTSt+rFnDUIWMPADcBWJ7n+QFZlu1N8o4k82mz7IRJSBtb3tg2hPDPpbxxRaPRmE3yrwA8QvIikj0lRfqNyKyUWRrJ+0leQXI6yeNIvpaIwG0k955kaevnDV/AiJmdAuB3bWtwRZ7n+4cQDgNwO4Hvk9xtPJ5dlr906VJPchHBlWb2+UQaLipB2qWDg4M7vmMhrZPi5nk+H8C9ST8vhhCOzrJsL5LXAbgzBB68OcVg2YDNZnM3kssSjB1Acg+SN5MkDGvN7OR3HKR1QNVuCLi+VFN8qdls7k7yH0g+QPJzm6Og8vhORwghHAHgPgDXDg4Ozkg1zvMJMn/JnAe8oyCN5LvM7HwASEr4Hsm5NJ5I8h4AXyc5ZWtASZndJXhbRHKlmZ3R39+/nZmdX8pnlw8ODs6Y8FTXzE40s+fSc99N8g/zPJ9P4BYAPyS5x5b00HRdHYkIlBjbzgCuB3A3yQObzeYuAH6aDLMuz/OvrF69um9jsn6vjzzPr07GWGNmx5OcC2AxgF+QPHwkirulHGIsuY3kwQDuILm4Xq/PDCEcDuB5ALeQnJYia2IZJeThEQAv1ev1mSRPA/CgmZ3V4b1uMw3gxyujs2A1sy8BeCKEcOzq1av7JnQuMbOHzOxRknPMbBXJ7UvYvtVa7GOV29Ha2YXk/iIiF1xwwcRtZFoIv0pG2RfAD94IVG2MhRXeDuBaM1tYLi47ZybHyRAnLCVuK0VVRYTprKUHhqpyrN6uqhhJiaoKkvs6506MMQ6kj5yqhpKi41iulWS59HecqEYpQp9tu4gIaUlBOhZYUVWqKkMIR5Kc1eHF7dcYjxYRArghvY88zz9O8vBkTL+pZF3qAmipE+BGOLWcwzZ1lul9cY1NjR+jfL8R+aNdQ9fLKQAeZZbtA+DGsdDeUk1RA/DtVGSeU6a1xQngCQAvk+wqbtQMP0+Mb2HHQ76psPR2hMFKcudI0uUivlKKnlEepKKqxgFOF5F/d84dHGO8cmBg4LtJ6WgjjEaS71PV95O8SlUzkjWSJiKnxRiXOOeuADBHVc8RFWGkT9/vhMAjReSMGGOeIpxCqqh6UqgqlqD32kqlcqOZLVLV+SSzYfRTEZEoFCcqPsb4dVX9bzM7QVVPJJm39aEUEdcWq5FC51U1AF+t1Wr3kqyEEM7z3n9MRFqFfJKiWryIOucuUdU7zexMVT1CKG3IFlJEnIqSMgTfzszO7erqWllEygNpTn1eKdG70SIky7J5JFclb1/U6XlFEjezs1Nj8ZOd9JpkL8Efp2LwxnKXubOrXMjZ1GFm55rZZ8c4ttHf3z/NzC4Y23i8SrLXzM4Yo/x1JKcCWDyW8fV6/ajhSFEdDmOOGiFOVUHjAvGyJLaPo6vV6o9HSNgxyf50jLF/7dq1txfvpwjyItIUJ8eIyGXOudNjjDuT/LSq/i5dK5ZyW1NEEBEDhU+r6rrk8VHakU7vfTfJpyqusreIRBhaovIbVW2IiBMKnXeIMe4klJnOuZ6pU6f2iMigiACGoKq/obAuIr7t9RQVnUXhdBWdKiJdqjpDRCKAlqquItlSURUdiuAdRXRH7/0UEdlGRF4VEQDIRGSViLRUJCVuLZ6wVq1WXyrnlAfSbOC8Uk5xnQZJY88kGYvxnXMk5bGNRmNngjZSniqocik3nZ0iZhWbzV1LybGIlL8uOdVHR8NkhHAJSVoIAyTfu0EUG/8udZ9bg4ODM8zsnDQ+ZFn2gc7CFcCF6d4GSU41s/NK/+9WGl8titz2x2iQ3AEhfC1FTj/J6WOjxMPeqCLiR6C7Q2xMVfdM+PmUqj6UxsSO73gRiT09PX8sIp7gsvR+Z1JlwQDN7OlKpRJEZKZ0d/d13NfQ3wmwdyD57nQdExEZGBhwU6ZMEVV9RZxzQ0y/JUX95ETEpXxWSIx9fX0lKq+s1WqxxEyL/GjpbtulQxQOa0nKOgoiIt77b4rIDc45LyJrxLmuIqnleT6DZD4wIJUpU4ZQyYlIS1XXDRmlUH6e51LxvlqqC1hiJzFFwBdijHXv/RdJ3iYif6aqa1esWFE56KCDrAxdMcZPiUjw3t+eZMVOJauqmdl53vsLReQpM1vQ1dX16BBUDkchRUQiYlDVq0Qko1BUNIpI7Ovrq8UYfy0iHy2USIq2pCU92kOSBfWnman3vriHYfqv65UJukHpoEmJLv3flllE+nyJ8e+jiEVERyFU1Dnvjiv0QbK74iu3RsS8t5caY9vPnHPdZnaziBxP0g3llFRvqHQUcUWOSK8kqd77s83sFe/9RTHG20gepaovJKMxKXNajPGPhHKXqr5cyhFCsmBmHgHXOu9OjDHe4Zxb0NXV9VLBuEasqVSi827bEeM+Rp8GpnwmIImSUXU9ZplgFgC990JSIuJNAOoAnIo6GEhyekSkqHS3ZfhkRB0yHoBdvfefGIEd9cYYYxG8zrvtRywY1e22Hny1o0GlShLDDyGboMQXm9la7/23Yoy/SIZ5nGQthfF851yPiNxQgo+YDEKS74kxXucq7tAY49XOuYWJMo9kEPHex0RXKxFxWWT8rROn4iQ45zTGWCX5cvsJXaF5VdVKirYCvgSA64jYIQhy3u2xoa2jOOcEwJo2zMSqiCsipch7z4nI8ojYEpU5IrJ7ioKhG1IRmNn1zrmXRaSanAPOuRqFTyY9sTIcBVSp1URjjJtodVBELBnm22b2mvf+xhjjQ41GY266OcYYFzjnoojcXEBXiS5PiTHe75ybLSKLvPcXFYl9JIOUvdt550MIl9Rqtfs2do+FEkVEuru7X1NV62jANpJADgwIe3uHjCIAlovIayLSI+QR6jQmorTOe3+wqmZEO6Gzbei1Sf7ydAppZ4j4b8IQxAlFYmwP1axWrZ48CsGVMiWOIsJ2Thlbj1BVC8N8n+RrIvJZM6snWJoaY/xkjPFe7/2zBXSVoiSPMd5C8o5KpXJdWnyH0fpZAFzKA1KtVqck71yv0BSRiqq20nNFEakAONXMXkyR4kXEVPXAIr+0k61vJ5xI8eY/rz36dDLen4voElWtxBi3IXkMySeixeici9qWeQqNz4uIEy8VAIhRP1Ggvoioc64oGivRwpfRpsjRe08A3osXCCp5nv+st7f3mfWSaK1Wk5iyzzgM41T1FhG5peSJB1Yqlb6iEC2gq5SfMhE5tUSTx9T8TIoumqXGtpXL1X/xZ1e6pnrvL9mIkaP3vltEXMopFBVKt2yT7qmiqjeEEAadc1eT3C6RkUtTdnNs6+3iEhOTwnEiEP2wh7vCScT7S7xsON6LF5LHisgzbmMUdRyGiaUmW7UN6e5IEVEz+3mZjY3Q6veqOiaDxBiHFG1mGwvnmJZEfTfG+NtUTI440HvvzOx7qbDbJjHWrlLHO5CsVavV/xSRZd57hSETkW1DCEsAPOO9794A7dPlnPcuWlwsIi/HGKe11dKmxiM4SDsovM+HmYPZgxTp8d6fEBEX+Yr/0zJbGkdzz6lqzPN8f+fcB733V5UZ3FgbhOXxxf/1en1Wb2/vnBBCGBwcfGzatGnrRpJdGj+zVqvNJZlXq9X1Z1pDUBFBrVb7HxER1rlTqIadJYRY7e19JHUApFRb7SIiO4VGaK3pX/PorFmzGoODgzP6+vrmhBBM1u8XxqJOq9Vq94iINJvNOd77HduqNl+pVNjBBqOIaLVafVxV+wu4WQngSZIfArBstN7X261ru5GJNbeV73GrynelDmccvfM1vpse76xiZ120sRnMzhnOkcYXpKI0fsSzc65mlKW2jqRfunSp31z5mzi13GZhquhZqVT85npCgr0tOjNY6gj4cRgX47jfcX2+JeWPNvNIVa2ISEhC3lZLQxMpoKpaMtCE3TPpCvRKiaZfRD5Ech9VDarKt3oDTwEDqoq0GO+KZrM5pzDORJ2nl5CHxwG8SnL3EMIRaYnq5QMDAzuMtJLkzTjS8iFfos9fBfCYmX2h1WrtaWZfzuv1/SbkQrxEEa9I2xyyNMM308zOA7DSzP62c7HA1mZfHQu+jyVxL8nLms3mrjQ7CUCxh+UHL7zwQu+EM0yh5FardYyZFdusnwshHEpyVwBXA7g7hHBEuSG5NZTQwVjmAvgpgJvZ3sD64bTin2b2TJZln5nQ2yFKjcKamS0EsCYZ53aS80h+BMDNAH5Ecs8tDWkdy316AHwDwP+a2XGNRmM2gKtK897nFyv/J/xRVvDrr7/+7pCmMNNxZdqfclLagv0vJKeW4MZtCagi+RcA7id5caPRmG1mpwOw5CBLW63WH7xVOe4tjZgy2yI5BxjePETynKSs8wHcb2ZffKP5pqzUPM/3R3vLxbIsy/ZJW/dWJWP8iuQhWxs6fy+M06G0+SlCCODFEMLRzLg3gCUA7iJ52FiV1rGKcXsA3wFwL0P4kyzL9gLwH8X+E7P8zNIP7fjJLdyy/oZRERHLsr8c2pBK3kVyXgjhEAC3Alg6Wr4ZYVvDmYndnUvyvQD+qbRT61v1en3mOw6qxptvCu/u7+/fLoRwcQnSFrPFuSRPAbASwGUkt00F3wbbt0MIh5C8i+BVJN9nZp8huabYpp3n+cfe8VD1RslAq9Wai4Abh5cD8qxUcX8tRcDflL87MDAwneS1AO5i4KHpN1ruTMZYbWYnjeQEk8cbYEx5nn8cwC/T4rZn0w8W7AngyrTd+yiSZxF4iMaFzWZzFwKXl6Dqwv7+/mkjQdzksZn5JsuyUwGsLuqbPM/3Izmf5K0AvkNyLzOeklYNMjGtyV+U2Nr55hW+8q6OhH1N+tGCjwB4OL33ZAjhyEmoegvyTQhhSXlFOYDM8vwrzz77bE9nFT95vIn1DZkfAGA5Qrim0WjMnoSqt1G+maS44zv+H2wwnOCik0PKAAAAAElFTkSuQmCC';
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


// ---------------------------------------------------------------------------
// v0.15.2: incremental usage aggregation.
// Session transcripts are append-only JSONL, so we remember a byte offset per
// file and parse only the tail since last time. That turns a full re-scan
// (hundreds of MB on a long project) into milliseconds, which is what makes it
// safe to refresh the token panel automatically on every dashboard regen
// instead of waiting for the user to remember `forge usage --write`.
// Work is bounded by a time/chunk budget and RESUMES on the next call, so no
// single CLI command can ever hang on a large backlog.
// ---------------------------------------------------------------------------
const USAGE_FILE = path.join(STATE, 'usage.json');
const USAGE_CACHE = path.join(STATE, 'usage-cache.json');
const USAGE_AUTO_MS = 2 * 60 * 1000;   // at most one background scan every 2 minutes
const USAGE_CHUNK = 8 * 1024 * 1024;   // bytes read from one file per pass

function readHead(file, bytes) {
  const fd = fs.openSync(file, 'r');
  try {
    const len = Math.min(fs.fstatSync(fd).size, bytes);
    const buf = Buffer.allocUnsafe(len);
    fs.readSync(fd, buf, 0, len, 0);
    return buf.toString('utf8');
  } finally { fs.closeSync(fd); }
}

function usageDirs(cached) {
  const projectsRoot = process.env.FORGE_CLAUDE_PROJECTS || path.join(os.homedir(), '.claude', 'projects');
  if (!fs.existsSync(projectsRoot)) return null;
  // a previously resolved folder is reused — the fallback scan below is the
  // expensive path and must not run on every dashboard regen
  if (cached && cached.length && cached.every(d => fs.existsSync(d))) return cached;
  const sanitized = PROJECT.replace(/[^a-zA-Z0-9]/g, '-');
  const dirs = [path.join(projectsRoot, sanitized)].filter(fs.existsSync);
  if (dirs.length) return dirs;
  try {
    for (const d of fs.readdirSync(projectsRoot)) {
      const full = path.join(projectsRoot, d);
      try {
        const f = fs.readdirSync(full).find(x => x.endsWith('.jsonl'));
        if (!f) continue;
        if (readHead(path.join(full, f), 64 * 1024).includes(`"cwd":${JSON.stringify(PROJECT)}`)) return [full];
      } catch (_) { /* skip */ }
    }
  } catch (_) { /* unreadable root */ }
  return null;
}

function usageFiles(dirs) {
  const files = [];
  for (const dir2 of dirs) {
    let entries = []; try { entries = fs.readdirSync(dir2); } catch (_) { continue; }
    for (const entry of entries) {
      const full = path.join(dir2, entry);
      if (entry.endsWith('.jsonl')) { files.push({ f: full, side: false, session: true }); continue; }
      const sub = path.join(full, 'subagents');
      try {
        if (fs.statSync(full).isDirectory() && fs.existsSync(sub))
          for (const wf of fs.readdirSync(sub).filter(x => x.endsWith('.jsonl')))
            files.push({ f: path.join(sub, wf), side: true, session: false });
      } catch (_) { /* skip */ }
    }
  }
  return files;
}

function emptyUsageCache() {
  return { v: 5, files: {}, models: {}, byType: {}, perItem: {}, byDay: {},
           dispatches: 0, tied: 0, firstTs: null, lastTs: null, bytes: 0, total: 0, complete: false };
}

// Reads the complete lines available after `off`, at most USAGE_CHUNK bytes.
function readTail(file, off) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    if (size <= off) return { text: '', next: off, size };
    const len = Math.min(size - off, USAGE_CHUNK);
    const buf = Buffer.allocUnsafe(len);
    fs.readSync(fd, buf, 0, len, off);
    let text = buf.toString('utf8');
    const cut = text.lastIndexOf('\n');            // never consume a half-written line
    if (cut < 0) return { text: '', next: off, size };
    text = text.slice(0, cut + 1);
    return { text, next: off + Buffer.byteLength(text, 'utf8'), size };
  } finally { fs.closeSync(fd); }
}

// Folds one chunk of JSONL into an aggregate. Pure accumulation, so the same
// function serves the persistent cache and the throwaway tail view.
function consumeUsage(agg, text, side, knownIdRe, rec) {
  // v0.21 (C0): Claude Code writes one JSONL line per content block (thinking, text,
  // tool_use …), each repeating the SAME message.id and usage. Counting lines counted one
  // API call 2–7 times (measured: 497 lines for 229 calls in one transcript). A repeated id
  // replaces the previous line's usage (the last line wins) and is not a new call.
  const holder = rec || {};
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let d; try { d = JSON.parse(line); } catch (_) { continue; }
    const tsv = d.timestamp;
    if (tsv) {
      if (!agg.firstTs || tsv < agg.firstTs) agg.firstTs = tsv;
      if (!agg.lastTs || tsv > agg.lastTs) agg.lastTs = tsv;
    }
    // v0.16: tie a worker transcript to its work item. The dispatch prompt's first
    // line is the brief header, so the item id is in the worker's own file.
    if (rec && !rec.item) {
      const mh = line.match(/Work brief (?:—|\\u2014) ([A-Za-z0-9][\w.-]*):/) || line.match(/briefs?\\?\/([A-Za-z0-9][\w.-]*?)\.md/i);
      if (mh) rec.item = mh[1];
    }
    // v0.17: a TOP-LEVEL transcript whose first user message is a Forge brief is a
    // worker, not the orchestrator. Field evidence: 48 reviewer runs stored as top-level
    // files were counted as orchestrator calls, hiding that they ran on an old model.
    // v0.17.1: sessions started by a program through the Agent SDK (entrypoint sdk-*)
    // are neither the orchestrator nor Forge's workers. Field evidence: 48 SDK-driven
    // security-review sessions from a separate tool were counted as orchestrator calls.
    if (rec && !side && rec.entrypoint === undefined && d.entrypoint) {
      rec.entrypoint = String(d.entrypoint);
      if (/^sdk/i.test(rec.entrypoint)) rec.external = true;
    }
    if (rec && !side && rec.firstUser === undefined && d.type === 'user' && d.message) {
      const c0 = d.message.content;
      const txt = typeof c0 === 'string' ? c0 : (Array.isArray(c0) ? c0.filter(x => x && x.type === 'text').map(x => x.text).join('\n') : '');
      rec.firstUser = true;
      if (/^\s*#\s*(Work|Review|Security|Explore|Test|Design) brief (—|-)/.test(txt)) rec.workerTop = true;
    }
    if (d.type !== 'assistant' || !d.message) continue;
    const model = d.message.model || 'unknown';
    if (model === '<synthetic>') continue;
    const u = d.message.usage || {};
    const cur = { in: u.input_tokens || 0, out: u.output_tokens || 0, cc: u.cache_creation_input_tokens || 0, cr: u.cache_read_input_tokens || 0 };
    const mid = d.message.id || null;
    const prev = holder.lastMsg;
    if (mid && prev && prev.id === mid && agg.models[prev.model] && agg.models[prev.model][prev.thread]) {
      const tp = agg.models[prev.model][prev.thread];
      tp.in += cur.in - prev.in; tp.out += cur.out - prev.out; tp.cacheCreate += cur.cc - prev.cc; tp.cacheRead += cur.cr - prev.cr;
      if (prev.day) agg.byDay[prev.day] = (agg.byDay[prev.day] || 0) + cur.out - prev.out;
      holder.lastMsg = Object.assign({}, prev, cur);
    } else {
    if (rec) { rec.calls = (rec.calls || 0) + 1; rec.model = model; }
    const external = rec ? !!rec.external : (/^sdk/i.test(String(d.entrypoint || '')) && !side);
    const thread = external ? 'external' : (side || d.isSidechain || (rec && rec.workerTop)) ? 'side' : 'main';
    const m = (agg.models[model] = agg.models[model] || {});
    const t = (m[thread] = m[thread] || { calls: 0, in: 0, out: 0, cacheCreate: 0, cacheRead: 0 });
    t.calls++; t.in += cur.in; t.out += cur.out; t.cacheCreate += cur.cc; t.cacheRead += cur.cr;
    const day = tsv ? tsv.slice(0, 10) : null;
    if (day) agg.byDay[day] = (agg.byDay[day] || 0) + cur.out;
    holder.lastMsg = mid ? Object.assign({ id: mid, model, thread, day }, cur) : null;
    }
    for (const ct of (Array.isArray(d.message.content) ? d.message.content : [])) {
      if (!ct || ct.type !== 'tool_use' || (ct.name !== 'Task' && ct.name !== 'Agent')) continue;
      const pr = (ct.input || {}).prompt || '';
      // tie dispatch → work item, most confident signal first
      let itemId = null;
      const m2 = pr.match(/Work brief — (\S+?):/); if (m2) itemId = m2[1];
      if (!itemId) { const m3 = pr.match(/[Bb]riefs?\/([A-Za-z0-9][\w.-]*?)\.md\b/); if (m3) itemId = m3[1]; }
      if (!itemId && knownIdRe) { const m4 = pr.match(knownIdRe); if (m4) itemId = m4[1]; }
      const ty = (ct.input || {}).subagent_type || 'unknown';
      agg.dispatches++; agg.byType[ty] = (agg.byType[ty] || 0) + 1;
      if (itemId) { agg.tied++; agg.perItem[itemId] = (agg.perItem[itemId] || 0) + 1; }
    }
  }
}

function collectUsage(opts = {}) {
  const budgetMs = opts.budgetMs || 0;
  const t0 = Date.now();
  let c = opts.rescan ? null : readJson(USAGE_CACHE, null);
  if (!c || c.v !== 5) c = emptyUsageCache(); // v0.17.1: v4 separates external sessions · v0.21: v5 counts one call per message id
  const dirs = usageDirs(opts.rescan ? null : c.dirs);
  if (!dirs) return null;
  c.dirs = dirs;
  let knownIdRe = null;
  try {
    const ids = Object.keys(readJson(WORK_FILE, { items: {} }).items || {})
      .filter(id => /^[A-Za-z0-9][\w.-]*$/.test(id))
      .sort((a, b) => b.length - a.length);   // longest first: T20f before T20
    if (ids.length) knownIdRe = new RegExp(`\\b(${ids.map(id => id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})\\b`);
  } catch (_) { /* no work graph → inline/path matching only */ }

  const files = usageFiles(dirs);
  // The running aggregate is a single total, so one rotated or rewritten file
  // poisons all of it — there is no way to subtract just that file's old
  // contribution. Detect the shrink and rebuild from scratch instead.
  for (const { f } of files) {
    const rec = c.files[f];
    if (!rec) continue;
    let size = 0; try { size = fs.statSync(f).size; } catch (_) { continue; }
    if (size < rec.off) { c = emptyUsageCache(); c.dirs = dirs; break; }
  }
  let total = 0, pending = false;
  for (const { f, side, session } of files) {
    let size = 0; try { size = fs.statSync(f).size; } catch (_) { continue; }
    total += size;
    let rec = c.files[f];
    if (!rec) rec = c.files[f] = { off: 0, size, side, session };
    rec.size = size; rec.side = side; rec.session = session;
    while (rec.off < size) {
      if (budgetMs && Date.now() - t0 > budgetMs) { pending = true; break; }
      const { text, next } = readTail(f, rec.off);
      if (next === rec.off) break;              // only an incomplete line is left
      consumeUsage(c, text, side, knownIdRe, rec);
      if (rec.workerTop) rec.side = true;
      rec.off = next;
    }
    if (pending) break;
  }
  let scanned = 0;
  for (const k of Object.keys(c.files)) scanned += c.files[k].off;
  c.bytes = scanned; c.total = Math.max(total, scanned);
  c.complete = !pending;
  c.sessions = Object.values(c.files).filter(x => x.session).length;
  try { writeJson(USAGE_CACHE, c); } catch (_) { /* cache is an optimisation, not state */ }

  // A file's last line may have no trailing newline — either it is still being
  // written, or the writer simply never emits one. The persistent aggregate
  // stays newline-aligned; that remainder is re-read on every pass and merged
  // into the RETURNED view only, so it is never counted twice.
  let view = c;
  let cloned = false;
  for (const { f, side } of files) {
    const rec = c.files[f];
    if (!rec || rec.off >= rec.size) continue;
    let tail = '';
    try {
      const fd = fs.openSync(f, 'r');
      try {
        const len = Math.min(rec.size - rec.off, USAGE_CHUNK);
        const buf = Buffer.allocUnsafe(len);
        fs.readSync(fd, buf, 0, len, rec.off);
        tail = buf.toString('utf8');
      } finally { fs.closeSync(fd); }
    } catch (_) { continue; }
    if (!tail.trim()) continue;
    if (!cloned) { view = JSON.parse(JSON.stringify(c)); cloned = true; }
    consumeUsage(view, tail, side || !!(rec && rec.workerTop), knownIdRe, null);
    view.bytes += Buffer.byteLength(tail, 'utf8');
  }
  view.dirs = dirs;
  view.total = Math.max(view.total, view.bytes);
  return view;
}

const USAGE_BASELINE = path.join(STATE, 'usage-baseline.json');

// v0.16: the numbers that actually track cost and speed.
// Field finding (a 21-item project): 1.33 BILLION cache-read tokens against 3.94M
// generated — a 339:1 ratio. Output tokens are noise for quota; context re-read
// per call is the bill. So the headline metrics are per-item context and per-item
// model calls, not token share by model.
// v0.17: model family (opus / sonnet / haiku / …) and a sortable version key, so an
// OLDER version running beside a newer one is visible instead of blending in.
function modelFamily(name) { const m = String(name).match(/claude-([a-z]+)/); return m ? m[1] : null; }
function modelVersionKey(name) {
  const m = String(name).match(/claude-[a-z]+-(\d+)(?:-(\d+))?(?:-(\d{8}))?/);
  return m ? [parseInt(m[1], 10), m[2] && m[2].length < 3 ? parseInt(m[2], 10) : 0] : [0, 0];
}
function olderVersions(names) {
  const byFam = {};
  for (const n of names) { const f = modelFamily(n); if (f) (byFam[f] = byFam[f] || []).push(n); }
  const res = [];
  for (const [f, ns] of Object.entries(byFam)) {
    if (ns.length < 2) continue;
    const sorted = ns.slice().sort((a, b) => { const x = modelVersionKey(a), y = modelVersionKey(b); return y[0] - x[0] || y[1] - x[1]; });
    res.push({ family: f, newest: sorted[0], older: sorted.slice(1) });
  }
  return res;
}

function usageMetrics(c, doneCount) {
  let calls = 0, cacheRead = 0, cacheCreate = 0, inTok = 0, outTok = 0, mainCalls = 0, sideCalls = 0;
  const external = { calls: 0, context: 0, out: 0, byModel: {} };
  for (const [name0, threads] of Object.entries(c.models || {}))
    for (const [th, t] of Object.entries(threads)) {
      if (th === 'external') { // v0.17.1: not Forge's loop — reported, never counted in its cost
        const cx = (t.cacheRead || 0) + (t.cacheCreate || 0) + (t.in || 0);
        external.calls += t.calls || 0; external.context += cx; external.out += t.out || 0;
        external.byModel[name0] = (external.byModel[name0] || 0) + (t.calls || 0);
        continue;
      }
      calls += t.calls || 0; cacheRead += t.cacheRead || 0; cacheCreate += t.cacheCreate || 0;
      inTok += t.in || 0; outTok += t.out || 0;
      if (th === 'main') mainCalls += t.calls || 0; else sideCalls += t.calls || 0;
    }
  const context = cacheRead + cacheCreate + inTok;
  // v0.16.1: per-model totals, so a segment that spans a model change can still
  // be attributed. Cost lives in context re-read, so that is carried per model.
  const byModel = {};
  for (const [name, threads] of Object.entries(c.models || {})) {
    const b = { calls: 0, context: 0, out: 0, mainCalls: 0, sideCalls: 0 };
    for (const [th, t] of Object.entries(threads)) {
      if (th === 'external') continue;
      b.calls += t.calls || 0;
      b.context += (t.cacheRead || 0) + (t.cacheCreate || 0) + (t.in || 0);
      b.out += t.out || 0;
      if (th === 'main') b.mainCalls += t.calls || 0; else b.sideCalls += t.calls || 0;
    }
    if (b.calls) byModel[name] = b;
  }
  // one worker transcript ≈ one dispatch
  const wf = Object.values(c.files || {}).filter(f => f.side && (f.calls || 0) > 0);
  const per = wf.map(f => f.calls).sort((a, b) => a - b);
  const q = (arr, p2) => arr.length ? arr[Math.min(arr.length - 1, Math.floor(arr.length * p2))] : null;
  const worst = wf.slice().sort((a, b) => b.calls - a.calls).slice(0, 5)
    .map(f => `${f.item || '(untied)'}×${f.calls}`);
  return {
    calls, mainCalls, sideCalls, cacheRead, cacheCreate, inTok, outTok, context,
    dispatches: wf.length,
    callsPerDispatch: { median: q(per, 0.5), p90: q(per, 0.9), max: per.length ? per[per.length - 1] : null },
    worstDispatches: worst,
    done: doneCount,
    byModel,
    external,
    defs: 3, // v0.17.1: external sessions excluded · v0.21: one call per message id (C0)
    perItem: doneCount ? { calls: calls / doneCount, context: context / doneCount, out: outTok / doneCount } : null
  };
}

function fmtBig(n) {
  if (n == null) return '—';
  if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return Math.round(n / 1e3) + 'k';
  return String(Math.round(n));
}

// Work done SINCE a recorded baseline — this is what makes a change measurable
// on one project: totals are cumulative, so the delta is the new regime alone.
function usageSince(m, base) {
  if (!base) return null;
  const done = (m.done || 0) - (base.done || 0);
  if (done <= 0) return null;
  const d = {
    done,
    calls: (m.calls - (base.calls || 0)) / done,
    context: (m.context - (base.context || 0)) / done,
    out: (m.outTok - (base.outTok || 0)) / done,
    label: base.label || null, ts: base.ts
  };
  // A baseline recorded before v0.16.1 carries no per-model counters. Diffing
  // against absent data would report the whole project as this segment, so the
  // breakdown is withheld rather than guessed.
  if (m.external) {
    const be = base.external || { calls: 0, context: 0, out: 0 };
    d.external = { calls: m.external.calls - (be.calls || 0), context: m.external.context - (be.context || 0), out: m.external.out - (be.out || 0) };
  }
  if ((base.defs || 1) !== (m.defs || 1)) d.defsChanged = true;
  if (!base.byModel) d.byModelUnavailable = true;
  else {
    const bm = {};
    for (const n of new Set([...Object.keys(m.byModel || {}), ...Object.keys(base.byModel || {})])) {
      const z = { calls: 0, context: 0, out: 0, mainCalls: 0, sideCalls: 0 };
      const cur = (m.byModel || {})[n] || z, was = (base.byModel || {})[n] || z;
      const e = { calls: cur.calls - was.calls, context: cur.context - was.context,
                  out: cur.out - was.out, mainCalls: cur.mainCalls - was.mainCalls,
                  sideCalls: cur.sideCalls - was.sideCalls };
      if (e.calls > 0 || e.context > 0 || e.out > 0) bm[n] = e;
    }
    if (Object.keys(bm).length) {
      d.byModel = bm;
      // Two orchestrator models in one segment means a code change and a model
      // change are entangled: the delta above cannot be credited to either.
      d.mixedMain = Object.values(bm).filter(e => e.mainCalls > 0).length > 1;
    }
  }
  if (base.perItem) {
    d.vs = {
      calls: base.perItem.calls ? Math.round(100 * (d.calls / base.perItem.calls - 1)) : null,
      context: base.perItem.context ? Math.round(100 * (d.context / base.perItem.context - 1)) : null,
      out: base.perItem.out ? Math.round(100 * (d.out / base.perItem.out - 1)) : null
    };
  }
  return d;
}

function M0ext(c) { return Object.values(c.models || {}).some(th => th.external); }
function usageSnapshot(c) {
  let mainOut = 0, sideOut = 0;
  for (const threads of Object.values(c.models || {}))
    for (const [th, t] of Object.entries(threads)) { if (th === 'main') mainOut += t.out; else if (th === 'side') sideOut += t.out; }
  const doneCount = (() => {
    try { const w2 = readJson(WORK_FILE, { items: {}, order: [] });
      return w2.order.filter(id => w2.items[id].status === 'DONE').length; } catch (_) { return 0; }
  })();
  const metrics = usageMetrics(c, doneCount);
  return { ts: ts(), models: c.models, dispatches: c.dispatches, byType: c.byType,
           mainOut, sideOut, complete: !!c.complete,
           scanPct: c.total ? Math.round(100 * c.bytes / c.total) : 100,
           metrics, since: usageSince(metrics, readJson(USAGE_BASELINE, null)) };
}

// Called from the dashboard generator: keeps the token panel current without
// the user ever running a command. Bounded, resumable, and never fatal.
function usageAutoRefresh(cfg) {
  try {
    if ((((cfg || {}).options) || {}).usageAuto === false) return;
    const snap = readJson(USAGE_FILE, null);
    if (snap && snap.complete && Date.now() - Date.parse(snap.ts) < USAGE_AUTO_MS) return;
    if (snap && !snap.complete && Date.now() - Date.parse(snap.ts) < 5000) return;
    const c = collectUsage({ budgetMs: parseInt(process.env.FORGE_USAGE_BUDGET_MS || '', 10) || 700 });
    if (!c) return;
    writeJson(USAGE_FILE, usageSnapshot(c));
  } catch (_) { /* telemetry must never block a state operation */ }
}

// ============================================================================
// v0.19: architecture, screens and tags — components.json schema 2
// ----------------------------------------------------------------------------
// Until v0.18 one registry held everything an item could be tagged with: screens
// (with mocks), runtime parts, and plain topic tags. Field state: 131 entries, 114
// of them screens, none of them able to say what talks to what. Schema 2 splits it:
//   components  — the runtime parts the system is made of (the architecture)
//   edges       — who talks to whom, labelled, optionally planned
//   screens     — UI screens and their mocks, each belonging to an app component
//   tags        — everything else an item can be tagged with (Security, Harness…)
// Items keep ONE tag field (item.component) that may point at any of the three;
// work tagged to a screen rolls up to the screen's app in the architecture view.
// ============================================================================
const ARCH_KIND_RANK = { frontend: 0, hosting: 1, auth: 2, backend: 2, job: 3, queue: 3, db: 4, storage: 4, cache: 4, integration: 6 };
const ARCH_KINDS = Object.keys(ARCH_KIND_RANK);
const EXTERNAL_LANE = 'External services';
function emptyComps() { return { schema: 2, components: {}, edges: [], screens: {}, tags: {}, lanes: null }; }
// Pure: schema-1 registry → schema-2 split. Never loses an entry.
function migrateComps(c1) {
  const c = emptyComps();
  const moved = { screens: [], components: [], tags: [] };
  for (const [id, e0] of Object.entries((c1 && c1.components) || {})) {
    const e = Object.assign({}, e0, { id });
    const kind = String(e.kind || 'unspecified');
    if (e.mock || e.route || kind === 'frontend' || kind === 'screen') {
      c.screens[id] = { id, name: e.name || id, app: null, mock: e.mock || null, route: e.route || null, doc: e.doc || null,
        created: e.created || ts(), updated: ts(), legacyKind: kind };
      moved.screens.push(id);
    } else if (ARCH_KINDS.includes(kind)) {
      c.components[id] = { id, name: e.name || id, kind, runsOn: null, summary: null, evidence: [], confirmed: false,
        source: 'legacy', doc: e.doc || null, created: e.created || ts(), updated: ts() };
      moved.components.push(id);
    } else {
      c.tags[id] = { id, name: e.name || id, kind, doc: e.doc || null, created: e.created || ts() };
      moved.tags.push(id);
    }
  }
  return { comps: c, moved };
}
function normalizeComps(raw) {
  let c = raw;
  if (!c || (c.schema || 1) < 2) c = migrateComps(c || {}).comps;
  for (const k of ['components', 'screens', 'tags']) if (!c[k] || typeof c[k] !== 'object') c[k] = {};
  if (!Array.isArray(c.edges)) c.edges = [];
  if (!Array.isArray(c.lanes)) c.lanes = null;
  return c;
}
function loadComps() { return normalizeComps(readJson(COMPONENTS_FILE, null)); }
function saveComps(c) { c.schema = 2; writeJson(COMPONENTS_FILE, c); }
function compsFileSchema() { const r = readJson(COMPONENTS_FILE, null); return r ? (r.schema || 1) : 0; }
// what an item tag points at
function tagRef(c, id) {
  if (!id) return null;
  if (c.components[id]) return { type: 'component', rec: c.components[id] };
  if (c.screens[id]) return { type: 'screen', rec: c.screens[id] };
  if (c.tags[id]) return { type: 'tag', rec: c.tags[id] };
  return null;
}
// the architecture component an item tag rolls up to (null for tags / unassigned screens)
function archOfTag(c, id) {
  const r = tagRef(c, id);
  if (!r) return null;
  if (r.type === 'component') return id;
  if (r.type === 'screen') return r.rec.app && c.components[r.rec.app] ? r.rec.app : null;
  return null;
}
function laneOrder(c) {
  const lanes = [...new Set(Object.values(c.components).map(x => x.runsOn || 'Unplaced'))];
  if (c.lanes && c.lanes.length) {
    const pinned = c.lanes.filter(l => lanes.includes(l));
    return [...pinned, ...lanes.filter(l => !pinned.includes(l))];
  }
  const rank = l => {
    if (l === 'Browser') return -1;
    if (l === EXTERNAL_LANE) return 99;
    if (l === 'Unplaced') return 100;
    const ks = Object.values(c.components).filter(x => (x.runsOn || 'Unplaced') === l).map(x => ARCH_KIND_RANK[x.kind] == null ? 5 : ARCH_KIND_RANK[x.kind]);
    return Math.min(...ks);
  };
  return lanes.map((l, i) => ({ l, r: rank(l), i })).sort((a, b) => a.r - b.r || a.i - b.i).map(x => x.l);
}
function slugId(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'x'; }
function titleCase(s) { return String(s).toLowerCase().replace(/(^|[\s_-])([a-z])/g, (m, a, b) => (a === '_' || a === '-' ? ' ' : a) + b.toUpperCase()); }

// ----------------------------------------------------------------------------
// forge arch scan — deterministic architecture evidence from the repo. Zero
// tokens: reads manifests, platform config, function folders, env var NAMES
// (never values) and known SDK imports. It proposes; it never confirms. Naming
// and splitting (e.g. three apps in one src/) is the agent's job, confirmation
// is the human's.
// ----------------------------------------------------------------------------
const SCAN_SKIP = new Set(['node_modules', '.git', 'dist', 'build', 'out', '.next', '.nuxt', '.svelte-kit', 'coverage', 'forge',
  'vendor', '.venv', 'venv', '__pycache__', 'test-results', 'playwright-report', '.turbo', '.cache', 'graphify-out', 'target', '.vercel', '.wrangler', 'tmp']);
// [match against a dependency / import specifier, id, display name, kind]
const SDK_TABLE = [
  [/^(stripe|@stripe\/)/, 'stripe', 'Stripe', 'integration'],
  [/^(@sendgrid\/)/, 'sendgrid', 'SendGrid', 'integration'],
  [/^resend$/, 'resend', 'Resend', 'integration'],
  [/^(postmark)$/, 'postmark', 'Postmark', 'integration'],
  [/^(mailgun(\.js)?|mailgun-js)$/, 'mailgun', 'Mailgun', 'integration'],
  [/^nodemailer$/, 'smtp', 'SMTP email', 'integration'],
  [/^twilio$/, 'twilio', 'Twilio', 'integration'],
  [/^(openai)$/, 'openai', 'OpenAI', 'integration'],
  [/^(@anthropic-ai\/sdk|anthropic)$/, 'anthropic', 'Anthropic', 'integration'],
  [/^(@sentry\/)/, 'sentry', 'Sentry', 'integration'],
  [/^(posthog-js|posthog-node|posthog)$/, 'posthog', 'PostHog', 'integration'],
  [/^(mixpanel|mixpanel-browser)$/, 'mixpanel', 'Mixpanel', 'integration'],
  [/^(algoliasearch)$/, 'algolia', 'Algolia', 'integration'],
  [/^(mapbox-gl|@mapbox\/)/, 'mapbox', 'Mapbox', 'integration'],
  [/^(@googlemaps\/|@react-google-maps\/)/, 'google-maps', 'Google Maps', 'integration'],
  [/^(googleapis|google-spreadsheet)$/, 'google-apis', 'Google APIs', 'integration'],
  [/^(@aws-sdk\/client-s3|aws-sdk|boto3)$/, 'aws', 'AWS', 'integration'],
  [/^(cloudinary)$/, 'cloudinary', 'Cloudinary', 'integration'],
  [/^(pusher|pusher-js|ably)$/, 'realtime', 'Realtime service', 'integration'],
  [/^(@clerk\/)/, 'clerk', 'Clerk', 'auth'],
  [/^(auth0|@auth0\/)/, 'auth0', 'Auth0', 'auth'],
  [/^(firebase|firebase-admin)$/, 'firebase', 'Firebase', 'integration'],
  [/^(paypal-rest-sdk|@paypal\/)/, 'paypal', 'PayPal', 'integration'],
  [/^(mollie|@mollie\/)/, 'mollie', 'Mollie', 'integration'],
  [/^(@upstash\/)/, 'upstash', 'Upstash', 'cache'],
];
const FRONTEND_DEPS = /^(react|react-dom|vue|svelte|@sveltejs\/kit|next|nuxt|@angular\/core|solid-js|astro|preact|@remix-run\/react)$/;
const SERVER_DEPS = /^(express|fastify|koa|@nestjs\/core|hono|@hapi\/hapi|restify)$/;
const PY_SERVER = /^(fastapi|django|flask|starlette|sanic|aiohttp)$/i;
const GENERIC_ENV_PREFIX = new Set(['SUPABASE', 'VITE', 'NEXT', 'PUBLIC', 'DATABASE', 'DB', 'APP', 'NODE', 'PORT', 'JWT', 'SITE', 'BASE', 'API', 'SERVICE',
  'SECRET', 'PG', 'POSTGRES', 'REDIS', 'HOST', 'URL', 'LOG', 'DEBUG', 'ENV', 'CI', 'GITHUB', 'TEST', 'E2E', 'PLAYWRIGHT', 'VERCEL', 'NETLIFY', 'CF', 'CLOUDFLARE',
  'DENO', 'EXPO', 'REACT', 'SENTRY', 'AUTH', 'SESSION', 'COOKIE', 'CORS', 'ALLOWED', 'DEFAULT', 'MAX', 'MIN', 'ENABLE', 'DISABLE', 'FEATURE', 'ADMIN', 'FRONTEND', 'BACKEND', 'WEB']);

// example env files: .env.example, .env.provider.example, .env.sample, .dev.vars.example, env.example …
const ENV_EXAMPLE_RE = /^\.?(env|dev\.vars)(\.[\w-]+)*\.(example|sample|template)$|^\.env\.example\.[\w-]+$/;
function scanWalk(root, maxFiles = 6000) {
  const files = [];
  const walk = (dir, depth) => {
    if (depth > 7 || files.length >= maxFiles) return;
    let ents; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
    for (const e of ents) {
      if (files.length >= maxFiles) return;
      if (e.name.startsWith('.') && e.name !== '.github' && !ENV_EXAMPLE_RE.test(e.name)) continue;
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) { if (!SCAN_SKIP.has(e.name)) walk(abs, depth + 1); }
      else if (e.isFile()) files.push(path.relative(root, abs).split(path.sep).join('/'));
    }
  };
  walk(root, 0);
  return files;
}
function readSmall(root, rel, max = 256 * 1024) {
  try { const abs = path.join(root, rel); if (fs.statSync(abs).size > max) return ''; return fs.readFileSync(abs, 'utf8'); } catch (_) { return ''; }
}
function archScan(root) {
  const files = scanWalk(root);
  const fileSet = new Set(files);
  const comps = {};   // id → {id,name,kind,runsOn,evidence:[{path,why}],confidence}
  const edges = [];   // {from,to,label,confidence}
  const notes = [];
  const envNames = new Set(); // 'NAME\u0000where' — names only, never values
  const add = (id, name, kind, runsOn, ev, confidence = 'high') => {
    const c = comps[id] = comps[id] || { id, name, kind, runsOn, evidence: [], confidence };
    if (ev && !c.evidence.some(x => x.path === ev.path && x.why === ev.why)) c.evidence.push(ev);
    if (confidence === 'high') c.confidence = 'high';
    return c;
  };
  const edge = (from, to, label, confidence = 'high') => {
    if (!from || !to || from === to) return;
    if (!edges.some(e => e.from === from && e.to === to)) edges.push({ from, to, label, confidence });
  };
  const usedBy = {}; // provider id → Set(component ids using it)
  const use = (prov, by) => { (usedBy[prov] = usedBy[prov] || new Set()).add(by); };

  // -- hosting / platform config ---------------------------------------------
  let host = null; // {lane, id}
  const wr = files.find(f => /(^|\/)wrangler\.(toml|json|jsonc)$/.test(f));
  if (wr) {
    const t = readSmall(root, wr);
    if (/pages_build_output_dir/.test(t) || !/^\s*main\s*=|"main"\s*:/m.test(t)) {
      add('frontend-hosting', 'Frontend hosting', 'hosting', 'Cloudflare', { path: wr, why: 'Cloudflare Pages config' });
      host = { lane: 'Cloudflare', id: 'frontend-hosting' };
    } else {
      add('worker', 'Worker', 'backend', 'Cloudflare', { path: wr, why: 'Cloudflare Worker (main entry)' });
    }
  }
  for (const [file, lane, why] of [['vercel.json', 'Vercel', 'Vercel project config'], ['netlify.toml', 'Netlify', 'Netlify config'],
    ['firebase.json', 'Firebase', 'Firebase hosting config'], ['amplify.yml', 'AWS Amplify', 'Amplify build config'], ['render.yaml', 'Render', 'Render blueprint']]) {
    if (fileSet.has(file) && !host) { add('frontend-hosting', 'Frontend hosting', 'hosting', lane, { path: file, why }); host = { lane, id: 'frontend-hosting' }; }
  }
  const redirects = ['_redirects', 'public/_redirects', 'static/_redirects'].find(f => fileSet.has(f));
  if (redirects && host) comps[host.id].evidence.push({ path: redirects, why: 'static-host redirects file' });
  else if (redirects && !host) {
    // a _redirects file is the Cloudflare Pages / Netlify convention; docs usually name which one
    const txt = files.filter(f => ENV_EXAMPLE_RE.test(path.posix.basename(f)) || /^(README|CLAUDE|CONTRIBUTING)\.md$/i.test(f)).map(f => readSmall(root, f)).join('\n');
    const cnt = { Cloudflare: (txt.match(/cloudflare pages|\bpages (preview|production)|wrangler/gi) || []).length, Netlify: (txt.match(/netlify/gi) || []).length };
    const lane = cnt.Cloudflare > cnt.Netlify ? 'Cloudflare' : cnt.Netlify ? 'Netlify' : 'Static hosting';
    add('frontend-hosting', 'Frontend hosting', 'hosting', lane, { path: redirects, why: `static-host redirects file${lane !== 'Static hosting' ? ` · docs mention ${lane} ${cnt[lane]}×` : ''}` }, lane === 'Static hosting' ? 'low' : 'medium');
    host = { lane, id: 'frontend-hosting' };
  }
  // deploy steps in CI name the target even when the config file is elsewhere
  for (const f of files.filter(x => /^\.github\/workflows\/.+\.ya?ml$/.test(x))) {
    const t = readSmall(root, f);
    const hit = [[/wrangler(-action)?[\s\S]{0,80}pages|pages deploy/i, 'Cloudflare'], [/vercel (deploy|--prod)|amondnet\/vercel-action/i, 'Vercel'],
      [/netlify deploy/i, 'Netlify'], [/flyctl deploy|fly deploy/i, 'Fly.io'], [/az webapp|azure\/webapps-deploy/i, 'Azure'], [/gcloud (run|app) deploy/i, 'Google Cloud']]
      .find(([re]) => re.test(t));
    if (hit) {
      if (!host) { add('frontend-hosting', 'Frontend hosting', 'hosting', hit[1], { path: f, why: 'deploy step in CI' }, 'medium'); host = { lane: hit[1], id: 'frontend-hosting' }; }
      else if (host.lane === hit[1]) comps[host.id].evidence.push({ path: f, why: 'deploy step in CI' });
    }
    if (/supabase functions deploy/i.test(t)) notes.push(`${f}: deploys Supabase edge functions`);
  }
  if (fileSet.has('fly.toml')) add('app-server', 'App server', 'backend', 'Fly.io', { path: 'fly.toml', why: 'Fly app config' });

  // -- docker compose: every service is a part --------------------------------
  const compose = files.find(f => /^(docker-)?compose(\.[\w-]+)?\.ya?ml$/.test(f));
  if (compose) {
    const t = readSmall(root, compose);
    const svc = t.split('\n');
    let inServices = false, cur = null;
    for (const line of svc) {
      if (/^services:\s*$/.test(line)) { inServices = true; continue; }
      if (inServices && /^\S/.test(line)) inServices = false;
      if (!inServices) continue;
      const m = line.match(/^ {2}([A-Za-z0-9_.-]+):\s*$/);
      if (m) { cur = m[1]; add(slugId(cur), cur, 'backend', 'Docker Compose', { path: compose, why: `compose service '${cur}'` }); continue; }
      const im = cur && line.match(/^\s+image:\s*["']?([^\s"':]+)/);
      if (im) {
        const img = im[1].split('/').pop();
        const k = /postgres|mysql|mariadb|mongo/.test(img) ? 'db' : /redis|memcached|valkey/.test(img) ? 'cache' : /nginx|caddy|traefik/.test(img) ? 'hosting' : /rabbitmq|kafka|nats/.test(img) ? 'queue' : null;
        if (k) comps[slugId(cur)].kind = k;
      }
    }
  }

  // -- Supabase ----------------------------------------------------------------
  const sbCfg = fileSet.has('supabase/config.toml');
  const sbFns = [...new Set(files.filter(f => /^supabase\/functions\/[^/_][^/]*\/index\.(ts|js|tsx)$/.test(f)).map(f => f.split('/')[2]))];
  const sbMig = files.filter(f => /^supabase\/migrations\/.+\.sql$/.test(f)).length;
  const srcText = (() => { // bounded sample of app source for SDK usage
    let t = ''; let n = 0;
    for (const f of files) {
      if (!/^(src|app|apps|packages|lib|pages|components)\//.test(f) || !/\.(ts|tsx|js|jsx|vue|svelte|mjs)$/.test(f)) continue;
      if (/\.(test|spec)\./.test(f)) continue;
      t += readSmall(root, f, 64 * 1024) + '\n'; if (++n >= 400 || t.length > 4e6) break;
    }
    return t;
  })();
  if (sbCfg || sbMig || sbFns.length) {
    const cfgT = sbCfg ? readSmall(root, 'supabase/config.toml') : '';
    add('postgres', 'Postgres', 'db', 'Supabase', sbMig ? { path: 'supabase/migrations/', why: `${sbMig} migration(s)` } : { path: 'supabase/config.toml', why: 'Supabase project' });
    if (/supabase\.auth\.|\.auth\.(signIn|signUp|getUser|getSession|onAuthStateChange)/.test(srcText) || /^\[auth\]/m.test(cfgT))
      add('auth', 'Auth', 'auth', 'Supabase', { path: sbCfg ? 'supabase/config.toml' : 'src/', why: 'Supabase Auth in use' });
    if (/\.storage\s*\.from\(/.test(srcText)) add('storage', 'Storage', 'storage', 'Supabase', { path: 'src/', why: 'supabase.storage.from(...) in app code' });
    if (sbFns.length) add('edge-functions', 'Edge functions', 'backend', 'Supabase', { path: 'supabase/functions/', why: `${sbFns.length} function(s): ${sbFns.slice(0, 6).join(', ')}${sbFns.length > 6 ? '…' : ''}` });
    if (sbFns.length && comps.postgres) edge('edge-functions', 'postgres', 'service role');
    // deno imports inside functions name the providers they talk to
    for (const fn of sbFns) {
      const dirFiles = files.filter(f => f.startsWith(`supabase/functions/${fn}/`) && /\.(ts|js|tsx)$/.test(f));
      const txt = dirFiles.map(f => readSmall(root, f)).join('\n');
      for (const m of txt.matchAll(/from\s+["'](?:npm:|https:\/\/esm\.sh\/|jsr:)?(@?[\w.-]+(?:\/[\w.-]+)?)/g)) {
        const spec = m[1].replace(/@[\d^~.x-]+$/, '');
        for (const [re, id, name, kind] of SDK_TABLE) if (re.test(spec)) { add(id, name, kind, EXTERNAL_LANE, { path: `supabase/functions/${fn}/`, why: `imports ${spec}` }); use(id, 'edge-functions'); }
      }
      for (const m of txt.matchAll(/Deno\.env\.get\(\s*["']([A-Z0-9_]+)["']/g)) envNames.add(m[1] + '\u0000' + `supabase/functions/${fn}/`);
    }
    // webhook functions: the provider calls in
    for (const fn of sbFns.filter(f => /webhook|callback|hook$/i.test(f))) notes.push(`webhook function: supabase/functions/${fn}`);
  }

  // -- manifests: apps, servers, SDKs --------------------------------------------
  const pkgs = files.filter(f => /(^|\/)package\.json$/.test(f));
  for (const p of pkgs) {
    let j; try { j = JSON.parse(readSmall(root, p)); } catch (_) { continue; }
    const deps = Object.assign({}, j.dependencies || {}, j.devDependencies || {});
    const names = Object.keys(deps);
    const dir = path.posix.dirname(p);
    const isRoot = dir === '.';
    const fe = names.filter(n => FRONTEND_DEPS.test(n));
    const sv = names.filter(n => SERVER_DEPS.test(n));
    let appId = null;
    if (fe.length && (names.includes('react-dom') || !names.includes('react') || names.some(n => /^(vite|next|nuxt|@sveltejs\/kit|astro)$/.test(n)))) {
      appId = isRoot ? 'web-app' : slugId(path.posix.basename(dir)) + '-app';
      add(appId, isRoot ? 'Web app' : titleCase(path.posix.basename(dir)) + ' app', 'frontend', 'Browser', { path: p, why: `depends on ${fe.slice(0, 3).join(', ')}` });
      if (names.includes('next') || names.includes('nuxt') || names.includes('@sveltejs/kit') || names.includes('@remix-run/react'))
        notes.push(`${p}: a full-stack framework (${fe.join(', ')}) — part of this app also runs on the server`);
      if (host) edge(host.id, appId, 'serves the app');
    }
    if (sv.length) {
      const sid = isRoot ? 'api-server' : slugId(path.posix.basename(dir)) + '-server';
      add(sid, isRoot ? 'API server' : titleCase(path.posix.basename(dir)) + ' server', 'backend', host && host.lane === 'Fly.io' ? 'Fly.io' : 'Server', { path: p, why: `depends on ${sv.join(', ')}` });
      if (appId) edge(appId, sid, 'HTTP', 'medium');
      appId = appId || sid;
    }
    if (names.includes('@supabase/supabase-js') && appId && comps.postgres) {
      edge(appId, 'postgres', 'supabase-js');
      if (comps.auth) edge(appId, 'auth', 'sign-in');
      if (comps.storage) edge(appId, 'storage', 'files');
      if (comps['edge-functions']) edge(appId, 'edge-functions', 'invoke', 'medium');
    }
    if (names.some(n => /^(@prisma\/client|prisma|pg|postgres|mysql2|mongodb|mongoose|drizzle-orm|knex|typeorm|sequelize)$/.test(n)) && !comps.postgres) {
      const dbn = names.find(n => /^(mysql2)$/.test(n)) ? 'MySQL' : names.find(n => /^(mongodb|mongoose)$/.test(n)) ? 'MongoDB' : 'Database';
      add('database', dbn, 'db', 'Server', { path: p, why: `depends on ${names.filter(n => /prisma|pg|postgres|mysql|mongo|drizzle|knex|typeorm|sequelize/.test(n)).join(', ')}` }, 'medium');
      if (appId) edge(appId, 'database', 'queries');
    }
    if (names.some(n => /^(bullmq|bull|bee-queue|agenda|node-cron)$/.test(n))) add('jobs', 'Background jobs', 'job', 'Server', { path: p, why: 'queue / scheduler dependency' }, 'medium');
    for (const n of names) for (const [re, id, name, kind] of SDK_TABLE) if (re.test(n)) {
      add(id, name, kind, EXTERNAL_LANE, { path: p, why: `depends on ${n}` });
      if (appId) use(id, appId);
    }
  }
  // Python services
  for (const f of files.filter(x => /(^|\/)(requirements[\w-]*\.txt|pyproject\.toml)$/.test(x))) {
    const t = readSmall(root, f);
    const deps = [...t.matchAll(/^\s*["']?([A-Za-z0-9_.-]+)/gm)].map(m => m[1].toLowerCase());
    const dir = path.posix.dirname(f);
    const sid = dir === '.' ? 'api-server' : slugId(path.posix.basename(dir)) + '-server';
    const srv = deps.find(d => PY_SERVER.test(d));
    if (srv) add(sid, dir === '.' ? 'API server' : titleCase(path.posix.basename(dir)) + ' server', 'backend', 'Server', { path: f, why: `depends on ${srv}` });
    if (deps.includes('celery') || deps.includes('rq')) add('jobs', 'Background jobs', 'job', 'Server', { path: f, why: 'celery / rq' });
    if (deps.some(d => /^(psycopg2?|psycopg2-binary|asyncpg|sqlalchemy)$/.test(d)) && !comps.postgres && !comps.database) {
      add('database', 'Postgres', 'db', 'Server', { path: f, why: 'Postgres driver / SQLAlchemy' }, 'medium');
      if (srv) edge(sid, 'database', 'queries');
    }
    for (const d of deps) for (const [re, id, name, kind] of SDK_TABLE) if (re.test(d)) { add(id, name, kind, EXTERNAL_LANE, { path: f, why: `depends on ${d}` }); if (srv) use(id, sid); }
  }
  // -- env var NAMES: known providers, and unknown ones as low-confidence hints -
  for (const f of files.filter(x => ENV_EXAMPLE_RE.test(path.posix.basename(x)))) {
    for (const m of readSmall(root, f).matchAll(/^\s*(?:export\s+)?([A-Z][A-Z0-9_]+)\s*=/gm)) envNames.add(m[1] + '\u0000' + f);
  }
  for (const m of srcText.matchAll(/(?:import\.meta\.env|process\.env)\.([A-Z][A-Z0-9_]+)/g)) envNames.add(m[1] + '\u0000src/');
  const envByPrefix = {};
  for (const e of envNames) {
    const [name, where] = e.split('\u0000');
    const bare = name.replace(/^(VITE_|NEXT_PUBLIC_|PUBLIC_|REACT_APP_|EXPO_PUBLIC_|NUXT_PUBLIC_)/, '');
    const prefix = bare.split('_')[0];
    if (!prefix || prefix.length < 3) continue;
    (envByPrefix[prefix] = envByPrefix[prefix] || { names: new Set(), where: new Set() }).names.add(name);
    envByPrefix[prefix].where.add(where);
  }
  for (const [prefix, v] of Object.entries(envByPrefix)) {
    const known = SDK_TABLE.find(([re, id]) => id.toUpperCase().replace(/-/g, '_') === prefix || id.toUpperCase() === prefix);
    const names = [...v.names];
    if (known) { const c = comps[known[1]]; if (c) c.evidence.push({ path: [...v.where][0], why: `env ${names.slice(0, 3).join(', ')}` }); else add(known[1], known[2], known[3], EXTERNAL_LANE, { path: [...v.where][0], why: `env ${names.slice(0, 3).join(', ')}` }, 'medium'); continue; }
    if (GENERIC_ENV_PREFIX.has(prefix)) continue;
    if (!names.some(n => /(KEY|SECRET|TOKEN|API|WEBHOOK|CLIENT_ID|MERCHANT)/.test(n))) continue;
    const id = slugId(prefix);
    if (comps[id]) { comps[id].evidence.push({ path: [...v.where][0], why: `env ${names.slice(0, 3).join(', ')}` }); continue; }
    add(id, titleCase(prefix), 'integration', EXTERNAL_LANE, { path: [...v.where][0], why: `credentials in env: ${names.slice(0, 3).join(', ')}` }, 'low');
    for (const w2 of v.where) if (String(w2).startsWith('supabase/functions/')) use(id, 'edge-functions');
  }
  // webhooks: provider → the function that receives it
  for (const fn of sbFns.filter(f => /webhook|callback/i.test(f))) {
    const prov = Object.keys(comps).find(id => comps[id].runsOn === EXTERNAL_LANE && fn.toLowerCase().includes(id.replace(/-/g, '')));
    if (prov) edge(prov, 'edge-functions', 'webhook');
  }
  // provider usage edges (caller → provider), unless the provider only calls in
  for (const [prov, by] of Object.entries(usedBy)) for (const b of by) if (comps[b] && comps[prov] && !edges.some(e => e.from === prov && e.to === b)) edge(b, prov, 'API', 'medium');
  return { components: Object.values(comps), edges, notes, scanned: files.length };
}

// ============================================================================
// v0.19: forge upgrade — bring an existing plan to the installed Forge's standards
// ----------------------------------------------------------------------------
// Two kinds of step. AUTOMATIC steps are mechanical and deterministic (a data
// shape a newer Forge expects); 'upgrade apply' runs them with a backup first.
// JUDGEMENT steps (milestones named after features, releases, the architecture)
// cannot be scripted generically: an agent writes a reviewable change script in
// forge/changes/, 'upgrade dry-run' runs it on a throwaway copy and shows the
// before/after, and 'upgrade run' applies it with a backup ('upgrade revert'
// restores). Every change goes through the normal CLI, so the plan's own rules —
// dependencies, frozen labels, started work — hold during an upgrade too.
// Steps are DETECTED from state, never trusted from a stored level.
// ============================================================================
const UPGRADE_FILE = path.join(STATE, 'upgrade.json');     // dry-run records (generated)
const BACKUP_DIR = path.join(STATE, 'backups');
const VERSION_PREFIX_RE = /^V\d+(\.\d+)*\s*[·:\-–—|]\s*/;
function sha(s) { return crypto.createHash('sha256').update(s).digest('hex').slice(0, 16); }
function fileSha(f) { try { return sha(fs.readFileSync(f)); } catch (_) { return 'absent'; } }
// the plan's content hash — the upgrade bookkeeping itself is excluded, so recording an upgrade does not change it
function stateSha() { const w = readJson(WORK_FILE, null); if (w) delete w.upgrade; return sha(JSON.stringify(w) + '|' + fileSha(COMPONENTS_FILE)); }
function normalizeWorkForShape(w) { ensureMilestones(w); return w; }
const UPGRADE_STEPS = [
  { id: 'milestone-records', since: '0.16.2', kind: 'auto', title: 'Milestones have their own records (name, demo) and an explicit order',
    check(ctx) { const w = ctx.raw; return { done: !!w.milestones && Array.isArray(w.milestoneOrder) && (w.order || []).every(id => !w.items[id].milestone || w.milestones[w.items[id].milestone]), findings: [] }; },
    apply(ctx) { ensureMilestones(ctx.w); } },
  { id: 'plan-order', since: '0.18.0', kind: 'auto', title: 'Releases above milestones and an explicit task order inside each milestone',
    check(ctx) { const w = ctx.raw; const ms = Object.values(w.milestones || {}); return { done: !!w.releases && Array.isArray(w.releaseOrder) && ms.every(m => Array.isArray(m.taskOrder)), findings: [] }; },
    apply(ctx) { ensureMilestones(ctx.w); } },
  { id: 'components-split', since: '0.19.0', kind: 'auto', title: 'The component registry is split into architecture parts, screens and tags',
    check() {
      const s = compsFileSchema();
      if (s !== 1) return { done: true, findings: [] };
      const m = migrateComps(readJson(COMPONENTS_FILE, {})).moved;
      return { done: false, findings: [`${m.screens.length} screen(s), ${m.components.length} architecture part(s), ${m.tags.length} tag(s) — item tags are unchanged`] };
    },
    apply() { if (compsFileSchema() === 1) saveComps(migrateComps(readJson(COMPONENTS_FILE, {})).comps); } },
  { id: 'feature-milestones', since: '0.18.0', kind: 'review', title: 'Milestones are named after the feature they enable and grouped into releases',
    how: 'forge-roadmap-review skill, upgrade mode: re-name/re-cut unstarted milestones, create releases and assign every milestone',
    check(ctx) {
      const w = ctx.raw, f = [];
      const seq = w.milestoneOrder || Object.keys(w.milestones || {});
      const open = m => (w.order || []).some(id => w.items[id].milestone === m && !['DONE', 'CANCELLED'].includes(w.items[id].status));
      for (const m of seq) {
        const r = (w.milestones || {})[m] || {};
        if (!r.name && open(m)) f.push(`${m}: unnamed — name it after the feature it enables`);
        else if (r.name && LAYER_NAME_RE.test(String(r.name).trim()) && open(m)) f.push(`${m}: "${r.name}" names a layer, not a feature`);
        if (r.name && VERSION_PREFIX_RE.test(r.name)) f.push(`${m}: "${r.name}" carries a version prefix — the release carries that now`);
      }
      const rels = w.releaseOrder || [];
      if (!rels.length && seq.length > 1) f.push(`no releases — group the ${seq.length} milestones into releases (MVP, V1, …)`);
      else { const loose = seq.filter(m => !((w.milestones || {})[m] || {}).release); if (rels.length && loose.length) f.push(`${loose.length} milestone(s) in no release: ${loose.slice(0, 6).join(', ')}${loose.length > 6 ? '…' : ''}`); }
      return { done: !f.length, findings: f };
    } },
  { id: 'architecture', since: '0.19.0', kind: 'review', title: 'The architecture is drafted from the repo, screens belong to their app, and you confirmed it',
    how: 'forge-brownfield skill, "Architecture draft": forge arch scan --write, a forge-explorer pass to name/split/link parts and assign screens, then your confirmation',
    check() {
      const c = loadComps(), f = [];
      const parts = Object.values(c.components);
      if (!parts.length) f.push('no architecture recorded — forge arch scan');
      const draft = parts.filter(x => !x.confirmed).length + c.edges.filter(e => !e.confirmed).length;
      if (draft) f.push(`${draft} draft part(s)/link(s) not confirmed yet`);
      const unplaced = parts.filter(x => !x.runsOn).length;
      if (unplaced) f.push(`${unplaced} part(s) with no 'runs on'`);
      const loose = Object.values(c.screens).filter(s => !s.app && !s.standalone).length;
      if (parts.length && loose) f.push(`${loose} screen(s) not assigned to an app (forge screen assign <app> …, or 'none' for standalone pages)`);
      return { done: !f.length, findings: f };
    } },
];
function upgradeStatus() {
  const raw = readJson(WORK_FILE, { items: {}, order: [] });
  const accepted = (raw.upgrade || {}).accepted || {};
  return UPGRADE_STEPS.map(s => {
    const r = s.check({ raw });
    const acc = accepted[s.id];
    return { id: s.id, since: s.since, kind: s.kind, title: s.title, how: s.how || null,
      done: r.done || !!acc, accepted: acc || null, findings: r.done ? [] : r.findings };
  });
}
function backupState(label) {
  const d = path.join(BACKUP_DIR, `${ts().replace(/[:.]/g, '-')}-${slugId(label)}`);
  fs.mkdirSync(d, { recursive: true });
  for (const f of [WORK_FILE, COMPONENTS_FILE, CONFIG_FILE]) if (fs.existsSync(f)) fs.copyFileSync(f, path.join(d, path.basename(f)));
  return path.relative(PROJECT, d).split(path.sep).join('/');
}
// the plan as a comparable shape: labels, names, releases, statuses
function planShape(w, c) {
  const L = computeLabels(w);
  const ms = {}; for (const m of (w.milestoneOrder || [])) ms[m] = { label: L.milestone[m] || null, name: ((w.milestones || {})[m] || {}).name || null, release: ((w.milestones || {})[m] || {}).release || null };
  const it = {}; for (const id of w.order) { const t = w.items[id]; it[id] = { label: L.item[id] || null, status: t.status, milestone: t.milestone || null, attempts: (t.attempts || []).length, title: t.title }; }
  const rel = {}; for (const r of (w.releaseOrder || [])) rel[r] = { label: L.releaseLabel[r], name: (w.releases[r] || {}).name };
  return { ms, it, rel, arch: c ? Object.keys(c.components).length : 0, edges: c ? c.edges.length : 0, screensAssigned: c ? Object.values(c.screens).filter(s => s.app).length : 0 };
}
function diffShape(a, b) {
  const lines = [], danger = [];
  for (const r of Object.keys(b.rel)) if (!a.rel[r]) lines.push(`+ release ${b.rel[r].label} ${r} "${b.rel[r].name}"`);
  for (const r of Object.keys(a.rel)) if (!b.rel[r]) lines.push(`- release ${r}`);
  for (const m of new Set([...Object.keys(a.ms), ...Object.keys(b.ms)])) {
    const x = a.ms[m], y = b.ms[m];
    if (!x) { lines.push(`+ milestone ${y.label || ''} ${m} "${y.name || ''}"`); continue; }
    if (!y) { lines.push(`- milestone ${m}`); continue; }
    const ch = [];
    if (x.label !== y.label) ch.push(`${x.label || '—'} → ${y.label || '—'}`);
    if (x.name !== y.name) ch.push(`"${x.name || ''}" → "${y.name || ''}"`);
    if (x.release !== y.release) ch.push(`release ${x.release || 'none'} → ${y.release || 'none'}`);
    if (ch.length) lines.push(`~ ${m}: ${ch.join(' · ')}`);
  }
  let relabel = 0; const moved = [];
  for (const id of Object.keys(a.it)) {
    const x = a.it[id], y = b.it[id];
    if (!y) { danger.push(`${id} disappeared`); continue; }
    if (x.status !== y.status && !(x.status === 'TODO' && y.status === 'CANCELLED')) danger.push(`${id} status ${x.status} → ${y.status}`);
    if (x.attempts !== y.attempts) danger.push(`${id} attempt history changed`);
    if (x.label !== y.label) relabel++;
    if (x.milestone !== y.milestone) moved.push(`${id} ${x.milestone || '—'} → ${y.milestone || '—'}`);
  }
  const added = Object.keys(b.it).filter(id => !a.it[id]);
  if (added.length) lines.push(`+ ${added.length} task(s): ${added.slice(0, 8).join(', ')}${added.length > 8 ? '…' : ''}`);
  if (moved.length) lines.push(`~ ${moved.length} task(s) re-homed: ${moved.slice(0, 6).join(' · ')}${moved.length > 6 ? '…' : ''}`);
  if (relabel) lines.push(`~ ${relabel} task label(s) change`);
  if (a.arch !== b.arch || a.edges !== b.edges) lines.push(`~ architecture: ${a.arch} → ${b.arch} part(s), ${a.edges} → ${b.edges} link(s)`);
  if (a.screensAssigned !== b.screensAssigned) lines.push(`~ screens assigned to an app: ${a.screensAssigned} → ${b.screensAssigned}`);
  return { lines, danger };
}
function runChangeScript(script, cwd) {
  const r = spawnSync('bash', [script], { cwd, encoding: 'utf8', timeout: 10 * 60 * 1000,
    env: Object.assign({}, process.env, { FORGE_JS: __filename, CLAUDE_PROJECT_DIR: cwd, FORGE_UPGRADE: '1', FORGE_SCAN_ROOT: PROJECT, FORGE_DEFER_REGEN: '1' }) });
  return { code: r.status, out: ((r.stdout || '') + (r.stderr || '')).trim() };
}

// ============================================================================
// v0.20: autopilot — keep building between tasks of a milestone, stop only for a human
// ----------------------------------------------------------------------------
// A session cannot clear its own context (no hook or model action triggers /clear),
// and it does not need to: every task already runs in fresh worker contexts, the
// orchestrator's thread is compacted by Claude Code when it fills, and Forge's state
// lives on disk. What stops the loop today is the turn ending after each task. With
// autopilot on, the Stop hook refuses that ending while the next task of the SAME
// milestone is ready, and lets the turn end only for a human: the milestone is ready
// for testing, a task is blocked on a question, a task needs escalation, nothing is
// startable, a run limit is reached, or no progress was made since the last nudge.
// ============================================================================
const AUTOPILOT_FILE = path.join(STATE, 'autopilot.json'); // run state (generated, not committed)
function autopilotCfg(cfg) {
  const o = ((cfg || {}).options) || {};
  return { on: o.autopilot === 'on', maxItems: parseInt(o.autopilotMaxItems, 10) || 0, maxHours: parseFloat(o.autopilotMaxHours) || 0 };
}
function progressKey(w) {
  return sha(w.order.map(id => { const t = w.items[id]; return `${id}:${t.status}:${(t.attempts || []).length}:${(t.verifications || []).length}`; }).join('|'));
}
function doneCount(w) { return w.order.filter(id => w.items[id].status === 'DONE').length; }
// what autopilot does now: { go:true, next } or { go:false, kind, reason, ask }
function autopilotDecision(w, cfg, run) {
  const ap = autopilotCfg(cfg);
  const L = (() => { try { return computeLabels(w); } catch (_) { return { item: {}, milestone: {} }; } })();
  const lab = id => `${L.item[id] ? L.item[id] + ' ' : ''}${id}`;
  const blocked = w.order.filter(id => w.items[id].status === 'BLOCKED');
  if (blocked.length) {
    const t = w.items[blocked[0]];
    return { go: false, kind: 'question', reason: `${lab(t.id)} is blocked: ${t.blockReason || 'no reason recorded'}`,
      ask: `Ask the user the exact question behind ${t.id} (one question, the options you see, your recommendation). When they answer: forge task unblock / update, then continue.` };
  }
  const esc = w.order.filter(id => { const t = w.items[id]; return t.status === 'TODO' && (t.attempts || []).filter(a => a.outcome === 'failed').length >= 2; });
  if (esc.length) return { go: false, kind: 'escalation', reason: `${lab(esc[0])} failed twice — a third attempt needs an escalation decision`,
    ask: `Tell the user what failed twice and the escalation you propose (stronger model, split the item, change the approach); wait for their go.` };
  // a finished milestone whose gate is not approved yet is where the human comes in — check it before looking ahead
  for (const m of milestoneSeq(w)) {
    if ((((w.gates || {})[m]) || {}).approved) continue;
    if (milestoneComplete(w, m)) return { go: false, kind: 'gate', reason: `milestone ${L.milestone[m] ? L.milestone[m] + ' ' : ''}${m} is complete and waiting for your testing`,
      ask: `Tell the user the milestone is ready to test: how to run or see it, what to try, and what you need back (approve / change requests). Do not start the next milestone.` };
    break;
  }
  const actM = activeMilestone(w);
  if (!actM) return { go: false, kind: 'done', reason: 'every planned milestone is complete', ask: 'Tell the user all planned work is done and offer the next step (a bounded change or a new destination).' };
  if (milestoneComplete(w, actM)) {
    return { go: false, kind: 'gate', reason: `milestone ${L.milestone[actM] ? L.milestone[actM] + ' ' : ''}${actM} is complete and waiting for your testing`,
      ask: `Tell the user the milestone is ready to test: how to run or see it, what to try, and what you need back (approve / change requests). Do not start the next milestone.` };
  }
  if (run && run.since) {
    const did = doneCount(w) - (run.startDone || 0);
    if (ap.maxItems && did >= ap.maxItems) return { go: false, kind: 'limit', reason: `run limit reached: ${did} task(s) done this run (max ${ap.maxItems})`, ask: 'Report what this run finished and what is next; the user restarts autopilot when they are ready.' };
    if (ap.maxHours && Date.now() - Date.parse(run.since) >= ap.maxHours * 3600000) return { go: false, kind: 'limit', reason: `run limit reached: ${ap.maxHours}h since autopilot started`, ask: 'Report what this run finished and what is next; the user restarts autopilot when they are ready.' };
  }
  const nx = nextReady(w, cfg);
  // a thin task (no criteria or file scope yet) whose dependencies are done is the next piece of
  // work, not a dead end: the orchestrator fleshes it out from the spec, then starts it
  if (!nx) {
    const thin = milestoneDisplayOrder(w, actM).map(id => w.items[id]).find(t => t && t.status === 'TODO' &&
      (t.deps || []).every(d => !w.items[d] || w.items[d].status === 'DONE') &&
      (!(t.criteria || []).length || !((t.scope || {}).allowed || []).length));
    if (thin) return { go: true, next: thin, label: lab(thin.id), prepare: true };
    const waiting = w.order.filter(id => w.items[id].status === 'IN_PROGRESS');
    if (waiting.length) return { go: false, kind: 'waiting', reason: `the rest of ${actM} waits on ${waiting.join(', ')}`, ask: 'Report what is in flight.' };
  }
  if (!nx) return { go: false, kind: 'stuck', reason: `nothing in ${actM} is startable (unmet dependencies, or tasks without criteria / file scope)`,
    ask: 'Say which tasks are not startable and why, and what you need (criteria, scope, a dependency decision).' };
  if ((nx.milestone || null) !== actM) return { go: false, kind: 'boundary', reason: `the next task ${lab(nx.id)} belongs to another milestone`, ask: 'Report the milestone boundary and wait for the user.' };
  return { go: true, next: nx, label: lab(nx.id) };
}

// ============================================================================
// v0.20.1: Graphify status — "use" means a built, current, ignored graph the agents are told about
// ----------------------------------------------------------------------------
// Field finding: two projects had options.graphify "use" and the CLI installed, but no graph was
// ever built, so every "query Graphify first" fell through to grep. The CLI's presence proves
// nothing; the graph file, its age, and the Claude Code integration are what make it used.
// ============================================================================
function graphifyStatus(cfg) {
  const choice = (((cfg || {}).options) || {}).graphify || 'unset';
  const gj = path.join(PROJECT, 'graphify-out', 'graph.json');
  let st = null; try { st = fs.statSync(gj); } catch (_) { }
  let lastCommitMs = null;
  try { const r = spawnSync('git', ['log', '-1', '--format=%ct'], { cwd: PROJECT, encoding: 'utf8', timeout: 5000 }); if (r.status === 0 && r.stdout.trim()) lastCommitMs = parseInt(r.stdout.trim(), 10) * 1000; } catch (_) { }
  let ignored = null;
  try { const r = spawnSync('git', ['check-ignore', '-q', 'graphify-out/graph.json'], { cwd: PROJECT, timeout: 5000 }); ignored = r.status === 0 ? true : r.status === 1 ? false : null; } catch (_) { }
  const read = f => { try { return fs.readFileSync(path.join(PROJECT, f), 'utf8'); } catch (_) { return ''; } };
  const claudeMd = /^##\s+graphify\b/m.test(read('CLAUDE.md'));
  const claudeHook = /graphify/.test(read('.claude/settings.json'));
  // --git-path hooks honours core.hooksPath (e.g. a tracked .githooks/), not only .git/hooks
  let gitHook = false; try { const hd = spawnSync('git', ['rev-parse', '--git-path', 'hooks'], { cwd: PROJECT, encoding: 'utf8', timeout: 5000 }).stdout.trim(); gitHook = !!hd && /graphify-hook-start/.test(fs.readFileSync(path.resolve(PROJECT, hd, 'post-commit'), 'utf8')); } catch (_) { }
  return { choice, built: !!st, builtMs: st ? st.mtimeMs : null, sizeKB: st ? Math.round(st.size / 1024) : null,
    stale: !!(st && lastCommitMs && lastCommitMs > st.mtimeMs + 60000), ignored, claudeMd, claudeHook, gitHook };
}
function graphifyProblems(g) {
  if (g.choice !== 'use') return [];
  const p = [];
  if (!g.built) p.push({ what: 'no graph built — agents fall back to grep', fix: 'graphify update .' });
  else if (g.stale) p.push({ what: 'graph is older than the last commit', fix: 'graphify update .   (and graphify hook install to keep it current)' });
  if (g.ignored === false) p.push({ what: 'graphify-out/ is not git-ignored — the rebuild after each commit leaves the tree dirty and collides with task commits', fix: "printf 'graphify-out/\\n' >> .gitignore" });
  if (!g.claudeMd || !g.claudeHook) p.push({ what: 'Claude Code is not told to use the graph (no CLAUDE.md section / PreToolUse hooks)', fix: 'graphify claude install' });
  if (!g.gitHook) p.push({ what: 'graph is not rebuilt after commits', fix: 'graphify hook install' });
  return p;
}

// ============================================================================
// v0.20.1: what every setting means and how to change it — one registry feeds the dashboard
// ============================================================================
const CONFIG_DOCS = [
  { key: 'options.itemShape', def: 'warn', group: 'Delegation', what: 'refuse: task start refuses a task with more than 6 criteria unless --reason (oversized tasks rarely pass first time). warn: only warns.', change: 'forge config set options.itemShape refuse', why: 'Big tasks are where first-pass collapses; refusing them forces a side-by-side split before a worker burns an attempt.', risk: 'test first' },
  { key: 'options.workerExplore', def: 'off', group: 'Delegation', what: 'bounded: workers investigate inside their scope (plus a small read budget outside it) and decide HOW; the brief says WHAT. off: the brief pre-solves and forbids exploring.', change: 'forge config set options.workerExplore bounded', why: 'The CTO stops pre-solving: briefs get shorter and the worker, closest to the code, picks the approach.', risk: 'test first' },
  { key: 'options.workerReadBudget', def: '10', group: 'Delegation', what: 'With workerExplore=bounded: how many files outside its scope a worker may read (it lists them).', change: 'forge config set options.workerReadBudget 10', why: 'Raise it when bounded workers report they ran out of reads on legitimate cross-cutting work.', risk: 'low' },
  { key: 'options.contextPack', def: 'false', group: 'Delegation', what: 'true: a cheap explorer assembles each task\'s context (files, patterns, invariants, spec, decisions, rules) into forge/context/<id>.md instead of the CTO reading it.', change: 'forge config set options.contextPack true', why: 'Moves context gathering off the expensive session model to a cheap explorer; pairs with workerExplore.', risk: 'test first' },
  { key: 'options.briefLimit', def: 'off', group: 'Delegation', what: 'on: briefs warn above 12 KB and are refused above 20 KB — split the task or move detail into the context pack.', change: 'forge config set options.briefLimit on', why: 'Keeps briefs from growing into fix lists; a brief over the limit usually means the task should be split.', risk: 'low' },
  { key: 'options.retryFromReview', def: 'false', group: 'Delegation', what: 'true: a retry brief is the original brief plus only the latest review findings (task fail --from-review) — never stacked passes.', change: 'forge config set options.retryFromReview true', why: 'Retries stop accumulating stale instructions; the worker sees one clear set of findings.', risk: 'low' },
  { key: 'options.requireDispatch', def: 'false', group: 'Delegation', what: 'true: task done refuses without a recorded implementer/tester launch; trivial self-closes need --self --reason and are counted.', change: 'forge config set options.requireDispatch true', why: 'Keeps the CTO from quietly doing the work itself, and makes every worker run visible in the record.', risk: 'low' },
  { key: 'options.requireTester', def: 'false', group: 'Delegation', what: 'high-risk: auth/data/payments/migrations/security tasks get a tester in parallel; done refuses without one. warn: warns when most criteria are tests.', change: 'forge config set options.requireTester high-risk', why: 'Independent tests written from the criteria catch what the implementer\'s own tests miss on risky code.', risk: 'test first' },
  { key: 'options.architectPrepass', def: 'false', group: 'Delegation', what: 'high-risk: before the first worker on a high-risk task, the architect (Opus) writes a short design note the brief carries.', change: 'forge config set options.architectPrepass high-risk', why: 'Gets the strongest model\'s thinking on failure classes before the first attempt, not after two failures.', risk: 'test first' },
  { key: 'options.delegateSpecSync', def: 'false', group: 'Delegation', what: 'true: at close the CTO decides what changed in the spec; a Haiku worker makes the edit.', change: 'forge config set options.delegateSpecSync true', why: 'Spec edits are mechanical once decided; a cheap worker makes them while the CTO decides what changed.', risk: 'low' },
  { key: 'phase', def: 'spec', group: 'Project', what: 'Where the project is: spec (shaping the product, no building) or build (the build loop runs).', change: 'forge config set phase build', why: 'Move to build once the spec has gated and the plan is cut.', risk: 'none' },
  { key: 'specDir', def: '—', group: 'Project', what: 'Folder holding the spec layers; the Specs page lists it and briefs cite it.', change: 'forge config set specDir spec', why: 'Point it at the folder holding the application spec, so briefs and the Specs page find it.', risk: 'none' },
  { key: 'verify.*', def: '—', group: 'Verification', what: 'Commands every task verification runs (test, lint, typecheck, security, build, e2e …). A task is DONE only when all pass on the current tree.', change: 'forge config set verify.test "npm test"', why: 'Without them nothing is machine-checked; set at least test and lint before building.', risk: 'none' },
  { key: 'options.verifyVerbose', def: 'false', group: 'Verification', what: 'Print every check\'s full output on verify (default: one line per passing check; the full tail is always kept in state).', change: 'forge config set options.verifyVerbose true', why: 'When you are debugging a check and want its full output on screen.', risk: 'none' },
  { key: 'options.security', def: 'on', group: 'Verification', what: 'Security gate before a milestone is approved and a preflight warning when no verify.security scanner is set. "off" disables both.', change: 'forge config set options.security off', why: 'Leave on; turn off only for throwaway prototypes.', risk: 'none' },
  { key: 'options.gates', def: 'per-milestone', group: 'Gates', what: 'per-milestone: each milestone waits for your approval before the next starts. end-only: one review at the end.', change: 'forge config set options.gates end-only', why: 'end-only for short or low-stakes projects where a review per milestone is overhead.', risk: 'low' },
  { key: 'options.protect', def: '—', group: 'Gates', what: 'Comma-separated paths no task may edit (generated code, migrations …). Edits there are blocked by the hook.', change: 'forge config set options.protect "src/generated/,supabase/migrations/"', why: 'Paths a worker must never touch: generated code, applied migrations, vendored files.', risk: 'none' },
  { key: 'options.scopeExempt', def: 'forge/,spec/,docs/', group: 'Gates', what: 'Folders exempt from a task\'s file-scope guard (orchestrator housekeeping). *.md is always exempt.', change: 'forge config set options.scopeExempt "forge/,spec/,docs/"', why: 'Add folders the orchestrator edits as housekeeping, outside any task\'s scope.', risk: 'low' },
  { key: 'options.concurrency', def: '4 (new) · 1 (unset)', group: 'Build loop', what: 'Most tasks in progress at once. Parallel tasks must have disjoint file scopes; start refuses an overlap.', change: 'forge config set options.concurrency 4', why: 'More than one worker at a time when tasks have disjoint scopes; verifies still run one at a time.', risk: 'test first' },
  { key: 'options.autopilot', def: 'off', group: 'Build loop', what: 'on: keep taking the next task of the milestone; stop only for you (milestone ready to test, a question, an escalation, nothing startable, a run limit).', change: 'forge autopilot on   ·   forge autopilot off', why: 'Leave a milestone running unattended; it still stops for you at every human decision.', risk: 'low' },
  { key: 'options.autopilotMaxItems', def: '0 (no limit)', group: 'Build loop', what: 'Autopilot stops after this many tasks in one run.', change: 'forge autopilot on --max-items 8', why: 'Cap an unattended run so you review in batches.', risk: 'none' },
  { key: 'options.autopilotMaxHours', def: '0 (no limit)', group: 'Build loop', what: 'Autopilot stops after this many hours in one run.', change: 'forge autopilot on --hours 6', why: 'Cap an unattended run by time.', risk: 'none' },
  { key: 'options.graphify', def: 'unset', group: 'Build loop', what: 'use: agents orient with the code graph (graphify-out/) instead of grep — needs a built graph and the Claude Code integration (see the Graphify card). skip: proceed without.', change: 'forge config set options.graphify use', why: 'Agents answer structural questions from the graph instead of reading files — fewer tokens per task.', risk: 'low' },
  { key: 'options.web', def: 'false', group: 'Build loop', what: 'The project has a web UI: preflight checks Playwright so E2E criteria can be machine-verified.', change: 'forge config set options.web true', why: 'The application has a browser UI and criteria that need E2E checks.', risk: 'none' },
  { key: 'options.integration', def: 'per-milestone', group: 'Git flow', what: 'per-milestone: one branch per milestone, one commit per task (task done), one PR per milestone (milestone ship). manual: Forge runs no git (needs a recorded reason).', change: 'forge config set options.integration manual --reason "…"', why: 'Keep per-milestone; manual only when another tool owns git.', risk: 'low' },
  { key: 'options.baseBranch', def: '—', group: 'Git flow', what: 'Integration branch milestone branches start from and merge into (staging, develop). Production branches are refused.', change: 'forge config set options.baseBranch staging', why: 'Set it to the branch milestones should merge into.', risk: 'none' },
  { key: 'options.branchPattern', def: 'milestone/<id>', group: 'Git flow', what: 'Name of each milestone branch.', change: 'forge config set options.branchPattern "milestone/<id>"', why: 'Match your team\'s branch naming.', risk: 'none' },
  { key: 'options.mergeMethod', def: 'merge', group: 'Git flow', what: 'How a milestone PR is merged (merge, squash, rebase).', change: 'forge config set options.mergeMethod squash', why: 'Match how your repository merges PRs.', risk: 'none' },
  { key: 'options.remote', def: 'origin', group: 'Git flow', what: 'Git remote that task commits are pushed to.', change: 'forge config set options.remote origin', why: 'When pushes go somewhere other than origin.', risk: 'none' },
  { key: 'options.gateSteps', def: '—', group: 'Git flow', what: 'Manual steps shown at milestone ship and confirmed with --steps-done ("step one || step two").', change: 'forge config set options.gateSteps "db push || deploy staging"', why: 'Manual release steps you want confirmed at every ship.', risk: 'none' },
  { key: 'options.versionStart', def: '0', group: 'Versions', what: 'Number of the first release: V0 = MVP; an existing product may start at 2.', change: 'forge config set options.versionStart 0', why: 'An existing product that already shipped versions.', risk: 'none' },
  { key: 'options.usageAuto', def: 'true', group: 'Telemetry', what: 'Refresh the token snapshot from session logs on every state change. false: only when you run forge usage.', change: 'forge config set options.usageAuto false', why: 'Turn off if refreshing usage on every command is slow on a large log.', risk: 'none' },
  { key: 'providers.*', def: '—', group: 'Telemetry', what: 'API workers (forge worker run): model, url (default OpenRouter), keyEnv, maxTurns.', change: 'forge config set providers.model "<id>"', why: 'Run some workers on an API model outside the session.', risk: 'test first' },
];
const COMMAND_DOCS = [
  { group: 'Start and status', items: [
    ['forge init', 'Create forge/ state in a project (idempotent).'],
    ['forge status', 'Phase, counts, what is in progress or blocked, what needs you.'],
    ['forge dashboard', 'Regenerate this page (it also refreshes on every change).'],
    ['forge preflight [--full]', 'Check git, verify commands, Graphify, Playwright before building.'],
    ['forge doctor', 'Self-check of the install and the project state.'] ] },
  { group: 'Tasks', items: [
    ['forge task next', 'The next task in plan order.'],
    ['forge task start [<id>]', 'Start the next task (or a named one); refuses unmet criteria, scope, deps, concurrency.'],
    ['forge task add --id … --title … --milestone …', 'Add a task (criteria and scope can come later).'],
    ['forge task update <id> --criterion-add "d::cmd" --allowed …', 'Flesh out a task: criteria, scope, deps.'],
    ['forge task verify <id>', 'Run the project and criterion checks; records evidence.'],
    ['forge task done <id>', 'Close a verified task (commits it under the git flow).'],
    ['forge task block <id> --reason "question: …"', 'Park a task on a question for you.'],
    ['forge task unblock <id> [--note "answer"]', 'Resume a blocked task; one blocked mid-work keeps its attempt and verification.'],
    ['forge task fail <id> --note …', 'Record a failed attempt with its diagnosis.'],
    ['forge task move <id> --before|--after <id>', 'Reorder unstarted tasks (dependency-checked).'],
    ['forge brief <id> --save', 'Write the worker brief for a task.'],
    ['forge brief <id> --context', 'Print the explorer prompt that assembles the task\'s context pack (contextPack).'],
    ['forge context save <id> [--section design-note]', 'Record a context pack or design note (explorer / architect, from stdin).'],
    ['forge task add|update <id> --domain api,auth', 'Tag domains: the brief carries their rules; auth/data/payments/migrations/security are high-risk.'],
    ['forge task fail <id> --from-review <file>', 'Fail with the reviewer\'s findings; the retry brief carries only the latest.'],
    ['forge task done <id> --self --reason …', 'Close a trivial task without a worker (requireDispatch), counted in stats.'],
    ['forge task verify <id> [--no-wait]', 'Verifies run one at a time; a second waits (or refuses with --no-wait).'] ] },
  { group: 'Milestones and releases', items: [
    ['forge milestone list', 'Milestones in order with labels and gates.'],
    ['forge milestone add <id> --name … --release <R>', 'Add a milestone named after the feature it enables.'],
    ['forge milestone move <id> --before|--after <M> --reason …', 'Reorder (refuses breaking dependencies or started work).'],
    ['forge milestone approve <id>', 'Your approval at the gate.'],
    ['forge milestone ship <id>', 'Open the milestone PR (git flow).'],
    ['forge milestone security <id> --brief', 'Print the security-pass prompt for a fresh reviewer.'],
    ['forge release list | add | move | tag', 'Releases (V0 = MVP, V1 …) above milestones.'] ] },
  { group: 'Architecture and screens', items: [
    ['forge arch scan [--write]', 'Draft the architecture from the repo (zero tokens).'],
    ['forge arch list | add | update | link | confirm', 'Runtime parts and who talks to whom.'],
    ['forge screen list | add | assign <app> --match …', 'Screens and mocks, per app.'] ] },
  { group: 'Running unattended', items: [
    ['forge autopilot on [--max-items N] [--hours H]', 'Keep building; stop only for you.'],
    ['forge autopilot status | off', 'See the run; turn it off.'] ] },
  { group: 'Keeping the plan current', items: [
    ['forge upgrade', 'Which standards of the installed Forge this plan meets.'],
    ['forge upgrade apply', 'Automatic steps, with a backup.'],
    ['forge upgrade dry-run|run <script>', 'Reviewed change scripts for judgement steps.'],
    ['forge upgrade revert', 'Restore the last upgrade\'s backup.'] ] },
  { group: 'Journal and settings', items: [
    ['forge decision add "title" --decision … --why …', 'Record a product or process decision.'],
    ['forge discovery add "title" --evidence … --impact …', 'Record something the plan did not know.'],
    ['forge config get [path] | set <path> <value>', 'Read or change a setting (see the Configuration page).'] ] },
  { group: 'Measuring', items: [
    ['forge stats', 'Outcomes: first-pass, clean-run, per-milestone health.'],
    ['forge usage [--baseline --label …]', 'Observed tokens and calls; baseline to measure a change.'],
    ['forge trace [--refusals]', 'Flight recorder of every command and hook decision.'] ] },
];

// ============================================================================
// v0.21: team-delegation switches (docs/IMPL-team-delegation.md). Every behaviour change
// sits behind one options.* switch: ON for projects created by this version (forge init
// writes them), OFF — today's behaviour — when the key is absent, so existing projects
// change nothing until the user turns a switch on (one per measured segment).
// ============================================================================
const SWITCH_ON = { itemShape: 'refuse', workerExplore: 'bounded', contextPack: true, briefLimit: 'on', retryFromReview: true,
  requireDispatch: true, requireTester: 'high-risk', architectPrepass: 'high-risk', delegateSpecSync: true };
const SWITCH_OFF = { itemShape: 'warn', workerExplore: 'off', contextPack: false, briefLimit: 'off', retryFromReview: false,
  requireDispatch: false, requireTester: false, architectPrepass: false, delegateSpecSync: false };
function sw(cfg, k) {
  const v = (((cfg || {}).options) || {})[k];
  if (v === undefined || v === null || v === '') return SWITCH_OFF[k];
  if (v === 'false' || v === false) return false;
  if (v === 'true' || v === true) return true;
  return v;
}
// Task domains (--domain): which domain packs a brief carries, and whether the task is high-risk.
const HIGH_RISK_DOMAINS = ['auth', 'data', 'payments', 'migrations', 'security'];
const DOMAIN_PACKS = { api: 'backend.md', backend: 'backend.md', data: 'backend.md', migrations: 'backend.md',
  auth: 'security.md', security: 'security.md', payments: 'security.md', secrets: 'security.md',
  frontend: 'frontend.md', ui: 'frontend.md', ux: 'design-ux.md', tests: 'testing.md' };
function itemDomains(item) { return (item.domains || []).map(d => String(d).toLowerCase()); }
function isHighRisk(item) { return itemDomains(item).some(d => HIGH_RISK_DOMAINS.includes(d)); }
function packsFor(item) {
  const set = [];
  for (const d of itemDomains(item)) { const p = DOMAIN_PACKS[d]; if (p && !set.includes(p)) set.push(p); }
  if (itemDomains(item).some(d => ['auth', 'security', 'payments', 'secrets', 'data'].includes(d)) && !set.includes('security.md')) set.push('security.md');
  return set;
}
const PACKS_DIR = path.join(PLUGIN_ROOT, 'skills', 'forge-domain-packs', 'references');
const CONTEXT_DIR = path.join(FORGE, 'context');
function launchesOf(item, agentRe) { return (item.dispatches || []).filter(d => d.kind !== 'message' && agentRe.test(String(d.agent || ''))); }

// v0.21 (C2): the forge-explorer prompt that assembles a task's context pack (writes nothing itself)
function contextPackPrompt(item, cfg) {
  const L = [];
  L.push(`# Explore brief — ${item.id}: context pack`);
  L.push('', `Assemble the context a worker needs for this task and RECORD it — do not implement anything. You are read-only on the code.`);
  L.push('', `## The task`, `${item.title}${item.objective ? ` — ${item.objective}` : ''}`);
  if ((item.criteria || []).length) { L.push('', `Acceptance criteria:`); item.criteria.forEach((c, i) => L.push(`${i + 1}. ${c.desc}`)); }
  L.push(`Allowed scope: ${((item.scope || {}).allowed || []).join(', ') || '(not set yet)'}`);
  if (item.component) L.push(`Tagged: ${item.component}`);
  if ((item.domains || []).length) L.push(`Domains: ${item.domains.join(', ')}${isHighRisk(item) ? ' (high-risk)' : ''}`);
  L.push('', `## Sources to read`);
  if (cfg.specDir) L.push(`- the spec: \`${cfg.specDir}/\` — only the sections this task touches`);
  L.push(`- decisions and discoveries: \`forge/decisions.md\`, \`forge/discoveries.md\` — only the entries that bind this task`);
  for (const p of packsFor(item)) L.push(`- domain pack: \`${path.relative(PROJECT, path.join(PACKS_DIR, p)).split(path.sep).join('/')}\``);
  L.push(`- the code under the allowed scope and what it calls${(((cfg.options || {}).graphify === 'use') && fs.existsSync(path.join(PROJECT, 'graphify-out', 'graph.json'))) ? ' — use `graphify query` / `graphify affected` first' : ''}`);
  L.push('', `## Write the pack with exactly these sections`,
    `## Relevant files — path and one line on why`,
    `## Patterns to follow — existing code the change should look like (paths)`,
    `## Invariants — what must stay true after the change`,
    `## Spec — the sections that apply, quoted briefly with file references`,
    `## Decisions and discoveries — the entries that bind this task`,
    `## Domain rules — the pack lines that apply`,
    '', `Keep it under 6 KB. Facts with file references; mark inferences as such.`,
    '', `## Record it`,
    `Pipe the pack into Forge (it writes forge/context/${item.id}.md; nothing else may):`,
    `  node "${__filename}" context save ${item.id} <<'PACK'`, `  …the pack…`, `  PACK`,
    `Then reply with one line: the path and its size.`);
  L.push('', `_Orchestrator: dispatch this to forge-explorer (haiku) and record it: forge dispatch --agent forge-explorer --purpose explore --item ${item.id} --model haiku._`);
  return L;
}

// the commit a milestone's work started from: the previous gate's head, else its first task's start
function milestoneBase(w, m) {
  const seqA = milestoneSeq(w);
  for (const p of seqA.slice(0, seqA.indexOf(m)).reverse()) { const pc = ((w.gates || {})[p] || {}).commits; if (pc && pc.head) return pc.head; }
  const starts = w.order.map(id => w.items[id]).filter(t => t.milestone === m && t.commitBase)
    .map(t => ({ b: t.commitBase, at: Date.parse((t.attempts.find(a => a.outcome === 'started') || {}).ts || 0) }))
    .sort((a, b) => a.at - b.at);
  return starts.length ? starts[0].b : null;
}

function regenDashboard() {
  if (process.env.FORGE_DEFER_REGEN === '1') return; // v0.19.1: a change script regenerates once, at its end
  try { usageAutoRefresh(readJson(CONFIG_FILE, null)); } catch (_) { /* never block state ops */ }
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
    `<span class="pill" style="border:1px solid ${color}33;color:${color};background:${color}12">${esc(label)}</span>`;
  // v0.13.1: components loaded early — milestone sections show which components they touch
  // v0.19: the registry is split — architecture parts, screens (belonging to an app), plain tags
  const C = loadComps();
  const kindColor = { frontend: '#3b3f8f', backend: '#0f766e', db: '#b45309', job: '#0f766e', integration: '#7c3aed',
    auth: '#0f766e', hosting: '#3b3f8f', storage: '#b45309', cache: '#b45309', queue: '#0f766e' };
  const tagKind = id => { const r = tagRef(C, id); return !r ? null : r.type === 'component' ? r.rec.kind : r.type === 'screen' ? 'frontend' : null; };
  const comps = { length: Object.keys(C.components).length }; // retained name for the rail's kind dots below
  for (const [id] of [...Object.entries(C.tags), ...Object.entries(C.screens), ...Object.entries(C.components)]) comps[id] = { kind: tagKind(id) };
  // v0.15.1: component chips carry a kind swatch instead of being coloured pills —
  // quieter beside a status pill, and the colour still says which kind it is.
  const compChip = (cid) => `<span class="cchip" title="${esc((tagRef(C, cid) || { type: 'tag' }).type)}"><i style="background:${kindColor[tagKind(cid)] || '#9aa0ad'}"></i>${esc(cid)}</span>`;
  const fmtD = ms2 => ms2 == null ? '\u2014' : (ms2 < 90000 ? Math.round(ms2 / 1000) + 's' : (ms2 < 5400000 ? Math.round(ms2 / 60000) + 'm' : (ms2 / 3600000).toFixed(1) + 'h'));

  // v0.15.3: readable documents — briefs and spec files are embedded so the
  // dashboard can show them rendered, in place, without a fetch (a file:// page
  // cannot read its siblings). Bounded so a big project can't bloat the file:
  // oversized or overflowing documents fall back to a plain link.
  const DOC_MAX = 48 * 1024, DOC_BUDGET = 2 * 1024 * 1024;
  const docs = {};
  let docBytes = 0;
  const addDoc = (key, abs, rel, title, kind) => {
    let st; try { st = fs.statSync(abs); } catch (_) { return false; }
    if (!st.isFile()) return false;
    if (st.size > DOC_MAX || docBytes + st.size > DOC_BUDGET) { docs[key] = { title, rel, kind, size: st.size, text: null }; return true; }
    try {
      docs[key] = { title, rel, kind, size: st.size, text: fs.readFileSync(abs, 'utf8'),
                    mtime: new Date(st.mtimeMs).toISOString() };
      docBytes += st.size;
      return true;
    } catch (_) { return false; }
  };

  // spec files
  let specRows = '';
  if (cfg.specDir && fs.existsSync(path.join(PROJECT, cfg.specDir))) {
    try {
      specRows = fs.readdirSync(path.join(PROJECT, cfg.specDir)).filter(f => !f.startsWith('.')).map(f => {
        const abs = path.join(PROJECT, cfg.specDir, f);
        const st = fs.statSync(abs);
        const key = 'spec:' + f;
        const readable = !st.isDirectory() && /\.(md|markdown|txt)$/i.test(f) && addDoc(key, abs, `${cfg.specDir}/${f}`, f, 'spec');
        const name = readable
          ? `<a href="#" class="docopen" data-doc="${esc(key)}"><code>${esc(f)}</code></a>`
          : `<code>${esc(f)}</code>`;
        return `<tr><td>${name}</td><td class="mut">${st.isDirectory() ? 'dir' : (st.size + ' B')}</td><td class="mut">${new Date(st.mtimeMs).toISOString().slice(0, 16).replace('T', ' ')}</td></tr>`;
      }).join('');
    } catch (_) { /* ignore */ }
  }

  const actM = activeMilestone(w);
  // v0.16.2: blocks follow the explicit milestone order, not item insertion order
  const mOrder = ensureMilestones(w);
  // v0.18: version labels (computed, frozen once started) and items in plan order
  const VL = computeLabels(w);
  const NEXT_ID = (() => { try { const nx = nextReady(w, cfg); return nx ? nx.id : null; } catch (_) { return null; } })();
  for (const m of mOrder) if (byMilestone[m]) {
    const pos = new Map(milestoneDisplayOrder(w, m).map((id, i) => [id, i]));
    byMilestone[m].sort((a, b) => (pos.has(a.t.id) ? pos.get(a.t.id) : 1e9) - (pos.has(b.t.id) ? pos.get(b.t.id) : 1e9));
  }
  const byMilestoneOrdered = [...mOrder.filter(m => byMilestone[m]).map(m => [m, byMilestone[m]]),
    ...Object.entries(byMilestone).filter(([m]) => !mOrder.includes(m))];
  let lastRel = undefined;
  const relHeader = (m) => {
    if (!(w.releaseOrder || []).length || m === '(no milestone)') return '';
    const r = releaseOf(w, m) || null;
    if (r === lastRel) return '';
    lastRel = r;
    if (!r) return `<div class="relh"><span class="vtag">—</span>Not in a release <span class="mut">assign: forge milestone update &lt;m&gt; --release &lt;R&gt;</span></div>`;
    const ms = mOrder.filter(x => releaseOf(w, x) === r);
    const appr = ms.filter(x => ((w.gates || {})[x] || {}).approved).length;
    return `<div class="relh"><span class="vtag rel">${esc(VL.releaseLabel[r])}</span>${esc((w.releases[r] || {}).name || r)} <span class="mut">${appr}/${ms.length} milestones approved${(w.releases[r] || {}).tag ? ` · tagged ${esc(w.releases[r].tag)}` : ''}</span></div>`;
  };
  const milestoneBlocks = byMilestoneOrdered.map(([m, items]) => relHeader(m) + (() => {
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
      const disp = t.dispatches || [];
      const briefKey = `brief:${t.id}`;
      const hasBrief = !!(t.id && fs.existsSync(path.join(FORGE, 'briefs', `${t.id}.md`))
        && addDoc(briefKey, path.join(FORGE, 'briefs', `${t.id}.md`), `forge/briefs/${t.id}.md`, `${t.id} — work brief`, 'brief'));
      const stat = isReady ? 'READY' : t.status;
      const sCls = { DONE: 's-done', IN_PROGRESS: 's-prog', READY: 's-ready', BLOCKED: 's-block', TODO: 's-todo', CANCELLED: 's-cancel' }[stat] || 's-todo';
      const sVar = { DONE: 'var(--done)', IN_PROGRESS: 'var(--progc)', READY: 'var(--readyc)', BLOCKED: 'var(--blockc)', TODO: 'var(--line)', CANCELLED: 'var(--line2)' }[stat] || 'var(--line)';
      // v0.14: design strip — the approved mock beside the latest build capture (intent vs built)
      let designStrip = '';
      {
        let mockP = t.mock || ((C.screens[t.component] || {}).mock) || null;
        if (!mockP) { const mm = t.criteria.map(c => (c.desc || '') + ' ' + (c.check || '')).join(' ').match(/spec\/mocks\/[\w./-]+/); if (mm) mockP = mm[0]; }
        let capP = null;
        for (const v of (t.verifications || [])) for (const a of (v.artifacts || [])) if (/\.(png|jpe?g|webp|gif|svg)$/i.test(a)) capP = a;
        const mockOk = mockP && fs.existsSync(path.join(PROJECT, mockP));
        const capOk = capP && fs.existsSync(path.join(PROJECT, capP));
        if (mockOk || capOk) designStrip = `<div class="design"><h4>Design — intended vs built</h4><div class="dpair">
          ${mockOk ? `<a href="../${esc(mockP)}"><img src="../${esc(mockP)}" alt="approved mock"><span>approved mock · <code>${esc(mockP)}</code></span></a>` : `<div class="dmiss">no mock recorded for this screen</div>`}
          ${capOk ? `<a href="../${esc(capP)}"><img src="../${esc(capP)}" alt="latest build capture"><span>latest capture · <code>${esc(capP)}</code></span></a>` : `<div class="dmiss">no screen capture yet — <code>task verify --artifact</code></div>`}
        </div></div>`;
      }
      // v0.15.1: per-criterion pass/fail read from the latest verification record — the
      // drawer shows which checks are green, not just how many exist.
      const critRes = {};
      if (lastV) for (const r of (lastV.results || [])) {
        const k = String(r.kind || '');
        if (k.indexOf('criterion: ') === 0) critRes[k.slice(11)] = r.exit === 0;
      }
      const critList = t.criteria.length
        ? `<ul class="crit">${t.criteria.map(c => {
            const v = critRes[c.desc];
            const ck = v === true ? '<span class="ck ok">✓</span>' : v === false ? '<span class="ck no">✕</span>' : '<span class="ck un">·</span>';
            return `<li>${ck}<span>${esc(c.desc)}${c.check ? ` — <code>${esc(c.check)}</code>` : ' <span class="mut">(no machine check)</span>'}</span></li>`;
          }).join('')}</ul>`
        : `<p class="mut">none yet — thin item; criteria and scope are added when its milestone approaches</p>`;
      const evid = lastV && (lastV.artifacts || []).length
        ? `<div class="row"><span class="k">Evidence</span><span class="vl">${lastV.artifacts.map(a => `<a href="../${esc(a)}">${esc(a)}</a>`).join(' · ')}</span></div>` : '';
      const kv = `<div class="kv">
        <div class="row"><span class="k">Allowed</span><span class="vl">${((t.scope || {}).allowed || []).length ? `<code>${esc(t.scope.allowed.join(', '))}</code>` : '<span class="mut">not set</span>'}</span></div>
        ${((t.scope || {}).forbidden || []).length ? `<div class="row"><span class="k">Forbidden</span><span class="vl"><code>${esc(t.scope.forbidden.join(', '))}</code></span></div>` : ''}
        ${t.deps.length ? `<div class="row"><span class="k">Depends on</span><span class="vl">${t.deps.map(esc).join(', ')}</span></div>` : ''}
        ${t.component ? `<div class="row"><span class="k">Component</span><span class="vl">${compChip(t.component)}</span></div>` : ''}
        <div class="row"><span class="k">Verification</span><span class="vl">${lastV
          ? `${lastV.passed ? 'passed' : 'failed'} · ${esc(lastV.ts.slice(0, 16).replace('T', ' '))}${lastV.durationMs ? ` · ran ${fmtD(lastV.durationMs)}` : ''}${lastV.tree ? ' · tree-bound ✓' : ''}`
          : '<span class="mut">never run</span>'}</span></div>
        ${t.commit ? `<div class="row"><span class="k">Commit</span><span class="vl"><code>${esc(t.commit.sha.slice(0, 10))}</code> on <code>${esc(t.commit.branch)}</code>${t.commit.pushed ? ' · pushed' : ' · <span class="warnv">not pushed</span>'}</span></div>` : ''}
        ${t.commits ? `<div class="row"><span class="k">Commits</span><span class="vl"><code title="git log ${esc(t.commits.base)}..${esc(t.commits.head)}">${esc(t.commits.base.slice(0, 7))}..${esc(t.commits.head.slice(0, 7))}</code> · ${t.commits.count === null ? '?' : t.commits.count} landed while in flight${t.commits.uncommitted ? ' · <span class="mut">work was uncommitted at DONE</span>' : ''}</span></div>` : ''}
        ${fails ? `<div class="row"><span class="k">Attempts</span><span class="vl">${fails} failed — a third identical retry is refused</span></div>` : ''}
        ${evid}
      </div>`;
      const dspList = disp.length ? `<h4>Dispatches</h4><ul class="dsp">${disp.slice(-6).map(d =>
        `<li><span class="t">${esc(String(d.ts || '').slice(5, 16).replace('T', ' '))}</span><span>${d.kind === 'message'
          ? `mid-flight message${d.agent ? ` → ${esc(d.agent)}` : ''}`
          : `→ ${esc(d.agent || 'worker')}${d.kind === 'api' ? ' <span class="mut">(api worker)</span>' : ''}`}${d.note
          ? ` <span class="mut">— ${esc(String(d.note).slice(0, 120))}</span>` : ''}</span></li>`).join('')}</ul>` : '';
      // the one fact that matters for this state, right-aligned on the row
      let meta = '';
      if (stat === 'DONE') {
        const tries = t.attempts.filter(a => a.outcome === 'started').length;
        meta = `${lastV && lastV.durationMs ? `verified ${fmtD(lastV.durationMs)}` : 'verified'}${tries > 1 ? ` · ${tries} attempts` : ''}`;
      } else if (stat === 'IN_PROGRESS') {
        const st0 = t.attempts.filter(a => a.outcome === 'started').map(a => Date.parse(a.ts)).filter(Number.isFinite).pop();
        const agent = (disp.filter(d => d.kind !== 'message').pop() || {}).agent;
        meta = `${st0 ? `<span data-since="${new Date(st0).toISOString()}">${fmtD(Date.now() - st0)}</span>` : ''}${agent ? ` · ${esc(agent)}` : ''}`;
      } else if (stat === 'READY') meta = fails ? `${fails} failed attempt(s)` : (t.id === NEXT_ID ? 'next up' : 'ready');
      else if (stat === 'BLOCKED') meta = 'needs your answer';
      else if (stat === 'CANCELLED') meta = 'superseded';
      else meta = t.criteria.length ? 'planned' : 'thin item';
      const noScope = !((t.scope || {}).allowed || []).length && !['DONE', 'CANCELLED'].includes(t.status) && (m === actM || m === '(no milestone)');
      const subline = t.status === 'BLOCKED' ? `<span class="sub">⛔ ${esc(t.blockReason || '')}</span>`
        : t.status === 'CANCELLED' ? `<span class="sub">✕ ${esc(t.cancelReason || '')}</span>`
        : noScope ? `<span class="warnv">⚠ no file scope — start will refuse (task update --allowed)</span>` : '';
      return `<details class="icd" id="it-${esc(t.id)}" data-id="${esc(t.id)}" data-comp="${esc(t.component || '')}" data-arch="${esc(archOfTag(C, t.component) || '')}" data-s="${stat}" data-act="${m === actM || m === '(no milestone)' ? '1' : '0'}"><summary class="irow">
        <span class="stripe" style="background:${sVar}"></span>
        <span class="iid">${VL.item[t.id] ? `<b class="vlab" title="version label — ${t.label ? 'frozen when work started' : 'provisional: renumbers if the plan is reordered'}">${esc(VL.item[t.id])}${t.label ? '' : '<i>·</i>'}</b>` : ''}${esc(t.id || '')}</span>
        <span class="itt">${stat === 'IN_PROGRESS' ? '<span class="dot-open"></span>' : ''}${esc(t.title)}${t.component ? compChip(t.component) : ''}${designStrip ? '<span class="cchip">🎨 mock</span>' : ''}${hasBrief ? `<button type="button" class="cchip docopen" data-doc="${esc(briefKey)}" title="Read the brief">📄 brief</button>` : ''}${subline}</span>
        <span class="imeta"><span class="st ${sCls}">${stat === 'IN_PROGRESS' ? 'IN PROGRESS' : stat}</span>${meta ? `<span>${meta}</span>` : ''}</span>
      </summary><div class="icdb">
        ${designStrip}
        <div class="dgrid">
          <div><h4>Acceptance criteria</h4>${critList}${dspList}</div>
          <div><h4>Scope &amp; evidence</h4>${kv}${hasBrief ? `<button type="button" class="briefbtn docopen" data-doc="${esc(briefKey)}">📄 Read the full brief — exactly what the worker was told</button>` : ''}</div>
        </div>
        ${t.objective ? `<p style="margin-top:14px"><b>Objective</b> — ${esc(t.objective)}</p>` : ''}
      </div></details>`;
    }).join('');
    // v0.15: component chips removed from milestone headers (user feedback: pure noise at
    // real-project density — components remain on item cards, the map, and the rail dots)
    const gateState = m === '(no milestone)' ? 'none' : (gate && gate.approved ? 'approved' : allClosed ? 'awaiting' : 'pending');
    const mName = milestoneName(w, m);
    const mc = (gate || {}).commits;
    return `<details class="sec sub"${openAttr} data-gate="${gateState}" data-m="${esc(m)}"><summary>${VL.milestone[m] ? `<span class="vtag">${esc(VL.milestone[m])}</span>` : ''}${esc(m)}${mName ? ` <b>${esc(mName)}</b>` : (m === '(no milestone)' ? '' : ' <span class="mut">(unnamed)</span>')} <span class="mut">${done}/${items.length} done</span> ${gateChip}${mc ? ` <span class="mut" title="git log ${esc(mc.base)}..${esc(mc.head)}">· ${esc(mc.base.slice(0, 7))}..${esc(mc.head.slice(0, 7))} (${mc.count})</span>` : ''}${(gate || {}).ship ? ` <a class="mut" href="${esc(gate.ship.pr)}">· PR</a>` : ''}<span class="mcount"></span></summary>
      <div class="mgb">${rows}</div></details>`;
  })()).join('');

  // ---- v0.19: architecture — lanes of parts, arrows for who talks to whom ----------
  // Layout is decided here (deterministic, zero tokens): lanes in order, parts in
  // columns chosen by a barycenter sweep so most arrows run straight. The browser
  // only measures the cards and draws the arrows between them.
  const itemsOfArch = id => w.order.map(x => w.items[x]).filter(t => archOfTag(C, t.component) === id);
  const itemsOfTag = id => w.order.map(x => w.items[x]).filter(t => t.component === id);
  const progressOf = its => {
    const done = its.filter(t => t.status === 'DONE').length;
    const live = its.filter(t => !['CANCELLED'].includes(t.status)).length;
    const run = its.filter(t => t.status === 'IN_PROGRESS').length;
    const next = its.find(t => t.id === NEXT_ID) || its.find(t => t.status === 'TODO' && t.deps.every(d => !w.items[d] || w.items[d].status === 'DONE') && t.criteria.length) || null;
    return { done, live, run, next: next ? next.id : null };
  };
  let archBlock = '', archCount = Object.keys(C.components).length, archDraft = 0;
  {
    const parts = Object.values(C.components);
    archDraft = parts.filter(x => !x.confirmed).length;
    if (!parts.length) {
      archBlock = `<div class="empty"><h3>No architecture recorded yet</h3>
        <p>Forge can draft it from the repo: <code>forge arch scan</code> reads the manifests, platform config, function folders and env var names (zero tokens) and proposes the parts and who talks to whom. <code>forge arch scan --write</code> records them as drafts; an agent pass names and splits them; you confirm.</p>
        <p class="mut">Existing projects: <code>forge upgrade</code> lists this as the <b>architecture</b> step.</p></div>`;
    } else {
      const lanes = laneOrder(C);
      const laneOf = x => x.runsOn || 'Unplaced';
      const rows = lanes.map(l => parts.filter(x => laneOf(x) === l).map(x => x.id));
      const nb = {}; for (const e of C.edges) { (nb[e.from] = nb[e.from] || []).push(e.to); (nb[e.to] = nb[e.to] || []).push(e.from); }
      const pos = () => { const p = {}; rows.forEach(r => r.forEach((id, i) => { p[id] = (i + 0.5) / r.length; })); return p; };
      for (let sweep = 0; sweep < 6; sweep++) {
        const order = sweep % 2 ? [...rows.keys()].reverse() : [...rows.keys()];
        for (const li of order) {
          const p = pos();
          const bc = id => { const ns = (nb[id] || []).filter(n => p[n] != null && !rows[li].includes(n)); return ns.length ? ns.reduce((a, n) => a + p[n], 0) / ns.length : p[id]; };
          rows[li] = rows[li].map((id, i) => ({ id, b: bc(id), i })).sort((a, b) => a.b - b.b || a.i - b.i).map(x => x.id);
        }
      }
      // columns: enough for the widest lane up to 5; a busier lane (often external services) wraps
      const K = Math.min(6, Math.max(3, ...rows.map(r => r.length)));
      // a lane that wraps keeps its connected parts in the first row, so arrows never cross a card
      rows.forEach((r, i) => { if (r.length > K) rows[i] = [...r.filter(id => nb[id]), ...r.filter(id => !nb[id])]; });
      const p = pos();
      const col = {};
      for (const r of rows) {
        if (r.length > K) continue; // wraps: auto-placed in barycenter order
        let prev = -1;
        r.forEach((id, i) => {
          let c = Math.round(p[id] * K - 0.5);
          const nbs = (nb[id] || []).filter(n => p[n] != null);
          if (nbs.length) c = Math.round(nbs.reduce((a, n) => a + p[n], 0) / nbs.length * K - 0.5);
          c = Math.max(prev + 1, Math.min(c, K - (r.length - i)));
          col[id] = c; prev = c;
        });
      }
      const laneNote = l => {
        const xs = parts.filter(x => laneOf(x) === l);
        const src = [...new Set(xs.flatMap(x => (x.evidence || []).map(e => String(e.path).split('/')[0] + (String(e.path).includes('/') ? '/' : ''))))].slice(0, 2);
        const conf = xs.every(x => x.confirmed);
        return `${src.length ? `from ${src.map(esc).join(', ')} · ` : ''}${conf ? '✓ confirmed' : `${xs.filter(x => !x.confirmed).length} draft`}`;
      };
      const card = x => {
        const pr = progressOf(itemsOfArch(x.id));
        const scr = Object.values(C.screens).filter(s => s.app === x.id).length;
        const sub = x.summary || (x.evidence && x.evidence[0] && x.evidence[0].why) || '';
        const kc = kindColor[x.kind] || '#57606f';
        return `<button type="button" class="acard${x.confirmed ? '' : ' draft'}" data-c="${esc(x.id)}" style="--kc:${kc}${col[x.id] != null ? `;grid-column:${col[x.id] + 1}` : ''}">
          <b>${esc(x.name)}</b>${sub ? `<span class="as">${esc(sub)}</span>` : ''}
          <span class="ap">${pr.live ? `${pr.done}/${pr.live} done` : 'no items'}${pr.run ? ` · <em>${pr.run} running</em>` : ''}${scr ? ` · ${scr} screen${scr > 1 ? 's' : ''}` : ''}${x.confirmed ? '' : ' · <i>draft</i>'}</span></button>`;
      };
      // every arrow gets its own horizontal track in the gap it leaves its lane by; size the gaps to fit
      const laneIdx = {}; lanes.forEach((l, i) => parts.filter(x => laneOf(x) === l).forEach(x => { laneIdx[x.id] = i; }));
      const gapOf = e => { const a = laneIdx[e.from], b = laneIdx[e.to]; return a == null || b == null || a === b ? null : a < b ? a : a - 1; };
      const gapN = {}; for (const e of C.edges) { const g = gapOf(e); if (g != null) gapN[g] = (gapN[g] || 0) + 1; }
      const sameLane = new Set(C.edges.filter(e => laneIdx[e.from] != null && laneIdx[e.from] === laneIdx[e.to]).map(e => laneIdx[e.from]));
      const laneStyle = li => { const st = []; if (li && gapN[li - 1]) st.push(`margin-top:${Math.max(0, 13 * gapN[li - 1] + 22 - 34)}px`); if (sameLane.has(li)) st.push('padding-bottom:34px'); return st.length ? ` style="${st.join(';')}"` : ''; };
      const laneHtml = lanes.map((l, li) => `<div class="lane${l === EXTERNAL_LANE ? ' ext' : ''}" data-li="${li}"${laneStyle(li)}>
          <div class="lanehead"><b>${esc(l.toUpperCase())}</b><span>${laneNote(l)}</span></div>
          <div class="lanebody" style="grid-template-columns:repeat(${K},minmax(0,1fr))">${rows[li].map(id => card(C.components[id])).join('')}</div></div>`).join('');
      const listRows = lanes.map(l => parts.filter(x => laneOf(x) === l).map(x => {
        const pr = progressOf(itemsOfArch(x.id));
        const outE = C.edges.filter(e => e.from === x.id).map(e => `${esc((C.components[e.to] || {}).name || e.to)}${e.label ? ` <span class="mut">(${esc(e.label)})</span>` : ''}${e.planned ? ' <span class="mut">· planned</span>' : ''}`);
        return `<tr><td><button type="button" class="alink" data-c="${esc(x.id)}"><i style="background:${kindColor[x.kind] || '#57606f'}"></i>${esc(x.name)}</button><div class="mut"><code>${esc(x.id)}</code></div></td><td>${esc(x.kind)}</td><td>${esc(l)}</td><td>${outE.join('<br>') || '<span class="mut">—</span>'}</td><td class="num">${pr.done}/${pr.live}</td><td>${x.confirmed ? '<span class="ok">✓ confirmed</span>' : '<span class="warn">draft</span>'}</td></tr>`;
      }).join('')).join('');
      const data = { parts: Object.fromEntries(parts.map(x => {
        const pr = progressOf(itemsOfArch(x.id));
        return [x.id, { name: x.name, kind: x.kind, runsOn: laneOf(x), summary: x.summary || null, confirmed: !!x.confirmed, doc: x.doc || null,
          evidence: (x.evidence || []).slice(0, 6), done: pr.done, live: pr.live, run: pr.run, next: pr.next,
          screens: Object.values(C.screens).filter(s => s.app === x.id).length }];
      })), edges: C.edges.map(e => ({ from: e.from, to: e.to, label: e.label || '', planned: !!e.planned, confirmed: !!e.confirmed, g: gapOf(e) })) };
      const kinds = [...new Set(parts.map(x => x.kind))];
      archBlock = `${archDraft ? `<div class="draftnote">✎ ${archDraft} of ${parts.length} part(s) are drafts${parts.some(x => x.source === 'scan') ? ' from <code>forge arch scan</code>' : ''} — check the drawing against reality, then <code>forge arch confirm --all</code> (or fix with <code>forge arch update / link / remove</code>).</div>` : ''}
      <div class="archwrap" id="archdiagram"><div class="archcard" id="archbox"><svg class="archsvg" id="archsvg" aria-hidden="true"></svg>${laneHtml}</div></div>
      <div class="tblwrap" id="archlist" hidden><table><thead><tr><th>Part</th><th>Kind</th><th>Runs on</th><th>Talks to</th><th>Items</th><th></th></tr></thead><tbody>${listRows}</tbody></table></div>
      <div class="archfoot">
        <div class="panel"><h4>Legend</h4><div class="alegend">${kinds.map(k => `<span><i style="background:${kindColor[k] || '#57606f'}"></i>${esc(k)}</span>`).join('')}</div>
          <p class="footnote">Colour is the part's kind. Lanes are where it runs — one per distinct "runs on", browser first, external services last${C.lanes ? ' (order pinned with forge arch lanes)' : ''}. Dashed arrows are planned; a dashed card is a draft you have not confirmed.</p></div>
        <div class="panel" id="archsel"><h4>Selected</h4><p class="mut">Click a part.</p></div>
        <div class="panel"><h4>Screens</h4><p>${Object.keys(C.screens).length} screen(s) and their mocks live on their own page — <a href="#/screens">Screens &amp; mockups</a>. Each app here links to its screens.</p>
          ${Object.values(C.screens).filter(s => !s.app && !s.standalone).length ? `<p class="mut">${Object.values(C.screens).filter(s => !s.app && !s.standalone).length} not assigned to an app yet (<code>forge screen assign &lt;app&gt; …</code>).</p>` : ''}</div>
      </div>
      <script type="application/json" id="archdata">${JSON.stringify(data).replace(/</g, '\\u003c')}</script>`;
    }
  }

  // ---- v0.19: screens & mockups — their own page, grouped by the app they belong to --
  let screensBlock = '';
  const screenCount = Object.keys(C.screens).length;
  {
    const all = Object.values(C.screens);
    if (!all.length) screensBlock = `<div class="empty"><h3>No screens registered</h3><p>Register a screen with its mock: <code>forge screen add &lt;id&gt; --mock spec/mocks/x.png --app &lt;app&gt;</code>. Items tagged with it (<code>--component &lt;id&gt;</code>) show intended-vs-built on their card.</p></div>`;
    else {
      const groups = {};
      for (const s of all) { const k = s.app || (s.standalone ? '~standalone' : ''); (groups[k] = groups[k] || []).push(s); }
      const order = [...Object.keys(groups).filter(a => a && a !== '~standalone').sort((a, b) => (C.components[a] ? 0 : 1) - (C.components[b] ? 0 : 1)), ...(groups['~standalone'] ? ['~standalone'] : []), ...(groups[''] ? [''] : [])];
      const cardS = s => {
        const its = itemsOfTag(s.id);
        const pr = progressOf(its);
        const ok = s.mock && fs.existsSync(path.join(PROJECT, s.mock));
        return `<div class="scard" data-q="${esc((s.id + ' ' + (s.name || '') + ' ' + (s.route || '')).toLowerCase())}">
          ${ok ? `<a class="sthumb" href="../${esc(s.mock)}" target="_blank" rel="noopener"><img loading="lazy" src="../${esc(s.mock)}" alt="${esc(s.name || s.id)} mock"></a>` : `<div class="sthumb none">${s.mock ? 'mock file missing' : 'no mock'}</div>`}
          <div class="sb"><b>${esc(s.name || s.id)}</b><span class="mut"><code>${esc(s.id)}</code>${s.route ? ` · ${esc(s.route)}` : ''}</span>
          <span class="sp">${its.length ? `<a href="#/plan/c:${encodeURIComponent(s.id)}">${pr.done}/${pr.live} items done${pr.run ? ` · ${pr.run} running` : ''}</a>` : '<span class="mut">no items tagged</span>'}</span></div></div>`;
      };
      screensBlock = `<div class="workbar"><input class="filter" id="scrfilter" type="search" placeholder="Filter screens… (name, id, route)" aria-label="Filter screens">
        <span class="mut">${all.length} screen(s) · ${all.filter(s => s.mock).length} with a mock${groups[''] ? ` · ${groups[''].length} not assigned to an app yet` : ''}</span></div>` +
        order.map(a => `<section class="sgroup" id="scr-${esc(a === '~standalone' ? 'standalone' : a || 'none')}"><h3>${a === '~standalone' ? 'Standalone pages <span class="mut">— maps, journeys and other pages that belong to no app</span>' : a ? `<i style="background:${kindColor[(C.components[a] || {}).kind] || '#57606f'}"></i>${esc((C.components[a] || {}).name || a)} <a class="mut" href="#/architecture/${encodeURIComponent(a)}">in the architecture →</a>` : 'Not assigned to an app'} <span class="mut">${groups[a].length}</span></h3>
          <div class="sgrid">${groups[a].map(cardS).join('')}</div></section>`).join('');
    }
  }

  // v0.12.1: telemetry — development time LIVE from state timestamps; tokens
  // from the last `forge usage --write` snapshot (never parsed live: log
  // parsing on every regen would slow every state operation).
  const pace = {}; // v0.14: pace & forecast data escapes the telemetry block
  let telemetryBlock = '';
  let timePanelOut = '', usagePanelOut = ''; // v0.19: time goes to Plan, tokens to Usage
  {
    const med = arr => { if (!arr.length) return null; const s2 = [...arr].sort((a, b) => a - b); return s2[Math.floor(s2.length / 2)]; };
    const quant = (arr, q) => { if (!arr.length) return null; const s2 = [...arr].sort((a, b) => a - b); return s2[Math.min(s2.length - 1, Math.floor(s2.length * q))]; };
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
      if (lastPass) { const wm = Date.parse(g3.ts) - lastPass; if (wm > 0) { gateWaits.push(`${esc(m3)} ${fmtDur(wm)}`); (pace.gateMs = pace.gateMs || []).push(wm); } }
    }
    for (const id of w.order) {
      const t = w.items[id];
      const startedTs = (t.attempts || []).filter(a => a.outcome === 'started').map(a => Date.parse(a.ts)).filter(Number.isFinite);
      const passedTs = (t.attempts || []).filter(a => a.outcome === 'passed').map(a => Date.parse(a.ts)).filter(Number.isFinite);
      if (startedTs.length && passedTs.length) {
        const span = Math.max(...passedTs) - Math.min(...startedTs);
        if (span > 0 && span < TRIM) itemSpans.push(span);
      }
      // v0.15.2: older records may carry a message with no agent — attribute it
      // to the launch it followed rather than inventing an agent row for it.
      let lastAgent = null;
      for (const d of (t.dispatches || [])) {
        if (d.kind !== 'message' && d.agent) lastAgent = d.agent;
        const a = d.agent || (d.kind === 'message' ? lastAgent : null);
        if (!a) continue;                      // unattributable legacy record
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
    pace.med = med; pace.quant = quant; pace.fmtDur = fmtDur; pace.itemSpans = itemSpans;
    // v0.15.1: agent timings as stacked bars — prep and execution are comparable at a glance
    const agentStats = Object.entries(perAgent).map(([a, r]) =>
      ({ a, launches: r.launches, msgs: r.msgs, prep: med(r.prep) || 0, exec: med(r.exec) || 0 }))
      .sort((x, y) => (y.prep + y.exec) - (x.prep + x.exec));
    const maxT = Math.max(1, ...agentStats.map(x => x.prep + x.exec));
    const agentRows = agentStats.map(x => {
      const pw = Math.round(100 * x.prep / maxT), ew = Math.round(100 * x.exec / maxT);
      return `<div class="hbar"><span class="lab" title="${esc(x.a)} — ${x.launches} launch(es)${x.msgs ? `, ${x.msgs} message(s)` : ''}">${esc(x.a)}</span>
        <span class="tr"><i style="left:0;width:${pw}%;background:#a9b1e8"></i><i style="left:${pw}%;width:${ew}%;background:var(--progc)"></i></span>
        <span class="vv">${fmtDur(x.prep)} + ${fmtDur(x.exec)}</span></div>`;
    }).join('');
    const timePanel =
      `<div class="panel"><h3>Development time <span class="mut">— trimmed medians, wall-clock (not agent runtime)</span></h3>
      ${agentRows ? `<div class="legend"><span><i style="background:#a9b1e8"></i>Prep (start→dispatch)</span><span><i style="background:var(--progc)"></i>Execution (dispatch→verify)</span></div>
      <div style="display:flex;flex-direction:column;gap:9px">${agentRows}</div>`
      : `<p class="mut">No dispatch records yet — they accumulate as items run under v0.12+ (<code>forge task dispatch</code>).</p>`}
      <div class="footnote">Median item start→done <b>${fmtDur(med(itemSpans))}</b>${itemSpans.length ? ` (${itemSpans.length} item(s))` : ''} · median verification run <b>${fmtDur(med(verifDurs))}</b>${gateWaits.length ? ` · your gate wait — ${gateWaits.join(', ')}` : ''}. Windows over 2h are excluded as session breaks; execution is bracketed by CLI events, so it is the window the worker ran in, not its exact runtime (see <code>forge usage</code>).</div></div>`;
    const usageSnap = readJson(USAGE_FILE, null);
    let tokenPanel;
    if (usageSnap) {
      let tokenRows = '';
      for (const [model, threads] of Object.entries(usageSnap.models || {}))
        for (const [thread, t2] of Object.entries(threads))
          tokenRows += `<div class="tokrow"><span class="m"><i style="background:${thread === 'main' ? 'var(--progc)' : 'var(--readyc)'}"></i><code>${esc(model)}</code> <span class="mut">${thread === 'main' ? 'orchestrator' : 'workers'} · ${t2.calls || 0} call(s)</span></span><b>${(t2.out || 0).toLocaleString()}</b><span class="n">out · ${(t2.in || 0).toLocaleString()} in</span></div>`;
      const byType = Object.entries(usageSnap.byType || {}).map(([k, v2]) => `${esc(k)}×${v2}`).join(' · ');
      const totOut = (usageSnap.mainOut || 0) + (usageSnap.sideOut || 0);
      const delPct = totOut ? Math.round(100 * (usageSnap.sideOut || 0) / totOut) : 0;
      const C = 226; const sideDash = Math.round(C * delPct / 100);
      tokenPanel =
        `<div class="panel"><h3>Tokens <span class="mut">— observed, snapshot as of ${esc(String(usageSnap.ts || '?').slice(0, 16).replace('T', ' '))}${usageSnap.ts ? ` (<span data-since="${esc(usageSnap.ts)}" data-post=" ago"></span>)` : ''}</span></h3>
        ${usageSnap.complete === false ? `<p class="mut">Still reading the transcript backlog — ${usageSnap.scanPct || 0}% scanned. It continues on its own each time state changes; <code>forge usage</code> finishes it in one go.</p>` : ''}
        <div class="donutwrap">
          <svg width="92" height="92" viewBox="0 0 92 92" role="img" aria-label="${delPct} percent of output tokens delegated to workers">
            <circle cx="46" cy="46" r="36" fill="none" stroke="#0c8a70" stroke-width="13" stroke-dasharray="${sideDash} ${C}" transform="rotate(-90 46 46)"/>
            <circle cx="46" cy="46" r="36" fill="none" stroke="#4553c4" stroke-width="13" stroke-dasharray="${C - sideDash} ${C}" stroke-dashoffset="${-sideDash}" transform="rotate(-90 46 46)"/>
            <text x="46" y="44" text-anchor="middle" font-size="15" font-weight="700" fill="#1b1d24">${delPct}%</text>
            <text x="46" y="58" text-anchor="middle" font-size="9" fill="#8a8e9a">delegated</text></svg>
          <div style="flex:1;min-width:170px">
            <div class="tokrow"><span class="m"><i style="background:var(--readyc)"></i>Workers</span><b>${(usageSnap.sideOut || 0).toLocaleString()}</b><span class="n">out</span></div>
            <div class="tokrow"><span class="m"><i style="background:var(--progc)"></i>Orchestrator</span><b>${(usageSnap.mainOut || 0).toLocaleString()}</b><span class="n">out</span></div>
          </div>
        </div>
        <div>${tokenRows || '<p class="mut">empty snapshot</p>'}</div>
        <div class="footnote">${delPct}% delegated${byType ? ` · dispatches: ${byType}` : ''}. Per-agent token attribution inside worker threads is not exposed by the logs — absent data is shown as absent, never estimated. This refreshes itself on every state change; <code>forge usage</code> prints the full report.</div></div>`;
    } else {
      tokenPanel = `<div class="panel"><h3>Tokens</h3><p class="mut">No usage snapshot yet — this fills in by itself once Claude Code session logs exist for this project (or run <code>forge usage</code> now; zero tokens, any terminal).</p></div>`;
    }
    // v0.16: the cost/speed headline — context re-read per item and model calls per
    // item. Field finding: context:output ran 339:1, so token *share* by model says
    // almost nothing about the bill.
    let effPanel = '';
    {
      const M = (usageSnap && usageSnap.metrics) || null;
      if (M && M.perItem) {
        const sinceD = usageSnap.since;
        const arrow = v => v == null ? '' : `<b style="color:${v < 0 ? 'var(--done)' : v > 0 ? 'var(--blockc)' : 'var(--ink3)'}">${v > 0 ? '+' : ''}${v}%</b>`;
        effPanel = `<div class="pacestrip" style="margin-top:12px">
          <div><div class="pk">CONTEXT RE-READ PER DONE ITEM</div><div class="pv">${esc(fmtBig(M.perItem.context))} <small>${M.outTok ? Math.round(M.context / M.outTok) : '—'}:1 vs generated</small></div></div>
          <div class="pdiv"></div>
          <div><div class="pk">MODEL CALLS PER DONE ITEM</div><div class="pv">${Math.round(M.perItem.calls)} <small>${M.mainCalls.toLocaleString()} orch · ${M.sideCalls.toLocaleString()} workers</small></div></div>
          <div class="pdiv"></div>
          <div><div class="pk">CALLS PER WORKER DISPATCH</div><div class="pv">${M.callsPerDispatch.median == null ? '—' : M.callsPerDispatch.median} <small>median · p90 ${M.callsPerDispatch.p90 == null ? '—' : M.callsPerDispatch.p90} · max ${M.callsPerDispatch.max == null ? '—' : M.callsPerDispatch.max}</small></div></div>
          ${sinceD ? `<div class="pdiv"></div><div><div class="pk" style="color:var(--accent)">SINCE BASELINE${sinceD.label ? ` · ${esc(sinceD.label)}` : ''}</div>
            <div class="pv" style="font-size:14px">${sinceD.done} item(s) — calls ${arrow(sinceD.vs && sinceD.vs.calls)} · context ${arrow(sinceD.vs && sinceD.vs.context)} · output ${arrow(sinceD.vs && sinceD.vs.out)}</div></div>` : ''}
          <div class="pnote">Context re-read is what a subscription quota actually spends — every turn re-sends the window. A worker dispatch running far past the median is exploring, not building.${sinceD ? '' : ' Record a baseline with <code>forge usage --baseline</code> to measure a change.'}</div>
        </div>`;
      }
    }
    timePanelOut = timePanel; usagePanelOut = `<div class="telgrid one">${tokenPanel}</div>${effPanel}`;
    telemetryBlock = `<details class="sec" open><summary>Telemetry <span class="mut">(time live from state · tokens re-read from session logs on every change)</span></summary><div class="telgrid">${timePanel}${tokenPanel}</div>${effPanel}</details>`;
  }

  // ---- v0.14: needs-you banner (deterministic, same priority as session guidance) ----
  // v0.21.2: an autopilot stop is current while the plan has not moved since it
  const apRun = readJson(AUTOPILOT_FILE, {});
  const apStop = autopilotCfg(cfg).on && apRun.stopped && apRun.stopped.key && apRun.stopped.key === progressKey(w) && apRun.stopped.kind !== 'user' ? apRun.stopped : null;
  let bannerBlock = '';
  {
    const seqB = milestoneSeq(w);
    const awaiting = seqB.filter(m => milestoneComplete(w, m) && !(((w.gates || {})[m]) || {}).approved);
    const inProgIds = w.order.filter(id => w.items[id].status === 'IN_PROGRESS');
    const blockedIds = w.order.filter(id => w.items[id].status === 'BLOCKED');
    let g = '🔥', h = '', p = '';
    if (cfg.phase === 'spec') { g = '🎨'; h = 'Spec phase — the product is still being shaped'; p = 'Resume the interview in your Claude session; share any feature lists, notes, or mockups you have — they shape everything that follows.'; }
    else if (awaiting.length) { g = '👋'; h = `Milestone ${esc(awaiting[0])} is finished — your review is the next step`; p = 'Try the running slice, give your verdict, and say anything you want to change or add before the next milestone starts. Then Forge records the approval.'; }
    else if (apStop) { g = '⏸️'; h = `Autopilot stopped — your session is waiting for you`; p = `${esc(apStop.reason)}. Answer in the Claude session; autopilot carries on by itself once work moves again.`; }
    else if (blockedIds.length) { g = '⛔'; h = `${blockedIds.length} item(s) are blocked and need your answer`; p = blockedIds.map(id => `<code>${esc(id)}</code> — ${esc(w.items[id].blockReason || '')}`).join(' · '); }
    else if (inProgIds.length) { g = '⚙️'; h = `Building — ${inProgIds.map(esc).join(', ')} in progress`; p = 'Nothing needs you right now. Forge stops for exactly three things: a product decision, a high-risk approval, a milestone review.'; }
    else if (ready > 0) { g = '▶️'; h = `${ready} item(s) ready — say “continue” in your Claude session`; p = 'The next item is briefed, dispatched, verified, and reviewed automatically; you\'ll be interrupted only if a product question surfaces.'; }
    else if (total > 0 && counts.DONE + counts.CANCELLED === total) { g = '🏁'; h = 'All planned work is done'; p = 'Start the next thing: a bounded change or a new destination — Forge asks which door when you open a session.'; }
    if (h) bannerBlock = `<div class="needsyou"><div class="glyph">${g}</div><div><h3>${h}</h3><p>${p}</p></div></div>`;
  }

  // ---- v0.14: KPI row ----
  const doneItems = w.order.map(id => w.items[id]).filter(t => t.status === 'DONE');
  const fpRate = doneItems.length ? Math.round(100 * doneItems.filter(t => !t.attempts.some(a => a.outcome === 'failed')).length / doneItems.length) : null;
  const ringDash = Math.round(188 * pct / 100);
  const kpiBlock = `<div class="kpis">
    <div class="kpi hero"><svg width="72" height="72" viewBox="0 0 74 74" role="img" aria-label="${pct} percent complete">
      <circle cx="37" cy="37" r="30" fill="none" stroke="#edebe4" stroke-width="9"/>
      <circle cx="37" cy="37" r="30" fill="none" stroke="#178744" stroke-width="9" stroke-dasharray="${ringDash} 188" stroke-linecap="round" transform="rotate(-90 37 37)"/>
      <text x="37" y="42" text-anchor="middle" font-size="15" font-weight="700" fill="#1b1d24">${pct}%</text></svg>
      <div><div class="v">${counts.DONE}<small> / ${total}</small></div><div class="l">ITEMS DONE · WHOLE PROJECT</div>
      <div class="d">${milestoneSeq(w).filter(m => (((w.gates || {})[m]) || {}).approved).length} of ${milestoneSeq(w).length || '—'} milestones approved</div></div></div>
    <div class="kpi"><div class="v" style="color:#0f766e">${ready}</div><div class="l">READY TO BUILD</div><div class="d">${counts.TODO - ready} more planned</div></div>
    <div class="kpi"><div class="v" style="color:#3b3f8f">${counts.IN_PROGRESS}</div><div class="l">IN PROGRESS</div><div class="d">${counts.CANCELLED ? counts.CANCELLED + ' cancelled' : '&nbsp;'}</div></div>
    <div class="kpi"><div class="v" style="color:${counts.BLOCKED ? '#b91c1c' : '#8a8e9a'}">${counts.BLOCKED}</div><div class="l">BLOCKED · NEEDS YOU</div><div class="d">&nbsp;</div></div>
    <div class="kpi"><div class="v">${fpRate == null ? '—' : fpRate + '%'}</div><div class="l">FIRST-PASS RATE</div><div class="d">${pace.itemSpans && pace.itemSpans.length ? 'median item ' + pace.fmtDur(pace.med(pace.itemSpans)) : '&nbsp;'}</div></div>
  </div>`;

  // ---- v0.14: pace & forecast strip — a PROJECTION from observed pace, never a promise ----
  let paceBlock = '';
  {
    let minStart = null;
    for (const id of w.order) for (const a of (w.items[id].attempts || [])) if (a.outcome === 'started') {
      const x = Date.parse(a.ts); if (Number.isFinite(x) && (!minStart || x < minStart)) minStart = x;
    }
    const remaining = w.order.filter(id => !['DONE', 'CANCELLED'].includes(w.items[id].status)).length;
    const spans = pace.itemSpans || [];
    if (minStart && spans.length >= 3) {
      const calMs = Date.now() - minStart;
      const calStr = calMs < 86400000 ? Math.round(calMs / 3600000) + 'h' : (calMs / 86400000).toFixed(calMs < 10 * 86400000 ? 1 : 0) + ' days';
      const activeMs = spans.reduce((a, b) => a + b, 0);
      const lo = pace.quant(spans, 0.25) * remaining, hi = pace.quant(spans, 0.75) * remaining;
      const gatesLeft = milestoneSeq(w).filter(m => !(((w.gates || {})[m]) || {}).approved).length;
      const medGate = pace.gateMs && pace.gateMs.length ? pace.med(pace.gateMs) : null;
      paceBlock = `<div class="pacestrip">
        <div><div class="pk">ELAPSED</div><div class="pv"><span data-since="${new Date(minStart).toISOString()}">${calStr}</span> <small>calendar</small> · ${pace.fmtDur(activeMs)} <small>active build</small></div></div>
        <div class="pdiv"></div>
        <div><div class="pk" style="color:#b3660a">PROJECTED REMAINING — BUILD</div><div class="pv">${remaining ? `≈ ${pace.fmtDur(lo)}–${pace.fmtDur(hi)} <small>active · ${remaining} item(s) at your pace</small>` : 'nothing left to build'}</div></div>
        <div class="pdiv"></div>
        <div><div class="pk">THE REST DEPENDS ON YOU</div><div class="pv">${gatesLeft} gate(s)${medGate ? ` <small>· your median review wait: ${pace.fmtDur(medGate)}</small>` : ''}</div></div>
        <div class="pnote">Projection from YOUR observed pace (p25–p75 of item times; thin items assumed median-sized) — recomputed on every change, never a promise.</div>
      </div>`;
    } else if (minStart) {
      paceBlock = `<div class="pacestrip"><div class="pnote" style="margin-left:0;max-width:none">Pace &amp; forecast appear once a few items complete — Forge projects only from observed data.</div></div>`;
    }
  }

  // ---- v0.14: milestone rail — the whole journey at a glance ----
  let railBlock = '';
  {
    const seqR = milestoneSeq(w);
    if (seqR.length) {
      const VLr = computeLabels(w);
      let lastR = undefined;
      const nodes = seqR.map((m, i) => {
        const r0 = releaseOf(w, m) || null;
        const sep = (w.releaseOrder || []).length && r0 !== lastR ? `<div class="rsep"><span>${esc(r0 ? VLr.releaseLabel[r0] : '—')}</span><em>${esc(r0 ? ((w.releases[r0] || {}).name || r0) : 'no release')}</em></div>` : '';
        lastR = r0;
        return sep + (() => {
        const ids = w.order.filter(id => w.items[id].milestone === m);
        const doneN = ids.filter(id => ['DONE', 'CANCELLED'].includes(w.items[id].status)).length;
        const g2 = (w.gates || {})[m]; const complete = milestoneComplete(w, m);
        const cls = g2 && g2.approved ? 'done' : complete ? 'awaitg' : m === actM ? 'activeg' : 'futureg';
        const sym = g2 && g2.approved ? '✓' : complete ? '!' : String((VLr.milestone[m] || '').split('.')[1] || (i + 1));
        const label = cls === 'awaitg' ? 'your review' : cls === 'done' ? `${doneN}/${ids.length} · gate ✓` : `${doneN}/${ids.length} items`;
        const mc = [...new Set(ids.map(id => w.items[id].component).filter(Boolean))].slice(0, 4);
        return `<a class="mnode ${cls}" href="#/plan/${encodeURIComponent(m)}"><span class="mdot">${sym}</span><span class="mv">${esc(VLr.milestone[m] || '')}</span><span class="mn">${esc(m)}</span>${milestoneName(w, m) ? `<span class="mi">${esc(milestoneName(w, m))}</span>` : ''}<span class="mi">${label}</span>${mc.length ? `<span class="cdots">${mc.map(c => `<i style="background:${kindColor[(comps[c] || {}).kind] || '#57606f'}"></i>`).join('')}</span>` : ''}</a>`;
        })();
      }).join('');
      railBlock = `<details class="sec" open id="milestones"><summary>Milestones <span class="mut">(the whole journey — click one to open it in the plan)</span></summary>
        <div class="railcard"><div class="railwrap"><div class="rail">${nodes}</div></div></div></details>`;
    }
  }

  // v0.15.1: journal entries render as a timeline — the authority of a decision
  // (you vs Forge) is the thing worth seeing first, so it becomes a marker + tag.
  const logBlock = (entries, empty) => entries.length
    ? entries.map(e => {
        const parts = String(e.title).split(' — ');
        const when = parts.length > 1 ? parts.shift() : '';
        const label = parts.join(' — ');
        const auth = (String(e.body).match(/^-\s*Authority:\s*(\w+)/im) || [])[1];
        const human = auth && auth.toLowerCase() === 'human';
        const body = String(e.body).split('\n')
          .filter(l => l.trim() && !/^-\s*Authority:/i.test(l))
          .map(l => l.replace(/^-\s*/, '').replace(/^(Decision|Why|Evidence|Impact|Affects):\s*/i, (x) => x))
          .join(' · ');
        return `<div class="jitem${human ? ' human' : ''}"><b>${esc(label)}${auth ? `<span class="tag ${human ? 'h' : 'f'}">${human ? 'you' : 'forge'}</span>` : ''}</b>${body ? `<p>${esc(body)}</p>` : ''}<span class="ts">${esc(when.slice(0, 16).replace('T', ' '))}</span></div>`;
      }).join('')
    : `<p class="mut">${empty}</p>`;

  const pfBlock = pf
    ? pf.results.map(r => `<div class="sysrow"><span class="bdg ${r.ok ? 'ok' : (r.severity === 'mandatory' ? 'bad' : 'warn')}">${r.ok ? 'OK' : (r.severity === 'mandatory' ? 'FAIL' : 'WARN')}</span><span class="n">${esc(r.name)}</span><span class="d">${esc(r.note)}</span></div>`).join('')
    : '<div class="sysrow"><span class="bdg warn">—</span><span class="n">Preflight</span><span class="d">never run — <code>forge preflight</code></span></div>';

  const baseBlock = base
    ? base.results.map(r => `<div class="sysrow"><span class="bdg ${r.exit === 0 ? 'ok' : 'warn'}">${r.exit === 0 ? 'GREEN' : 'RED'}</span><span class="n">${esc(r.kind)}</span><span class="d">${r.exit === 0 ? '' : 'pre-existing failure — recorded, not blamed on new work · '}<code>${esc(r.cmd)}</code></span></div>`).join('')
    : '<div class="sysrow"><span class="bdg warn">—</span><span class="n">Baseline</span><span class="d">not captured (greenfield, or run <code>forge baseline capture</code>)</span></div>';

  // ---- v0.19: blocks for the paged dashboard -------------------------------------
  // Plan: outcomes beside the work they describe
  let outcomesBlock = '';
  {
    const dn = w.order.map(id => w.items[id]).filter(t => t.status === 'DONE');
    if (dn.length) {
      const failsOf = t => t.attempts.filter(a => a.outcome === 'failed').length;
      const fp = dn.filter(t => failsOf(t) === 0).length;
      const cr = dn.filter(t => t.attempts.filter(a => a.outcome === 'started').length === 1 && failsOf(t) === 0 && !(t.verifications || []).some(v => v.passed === false)).length;
      const tf = dn.reduce((a, t) => a + failsOf(t), 0);
      outcomesBlock = `<div class="pacestrip">
        <div><div class="pk">FIRST-PASS</div><div class="pv">${Math.round(100 * fp / dn.length)}% <small>${fp}/${dn.length} done with no failed attempt</small></div></div>
        <div class="pdiv"></div>
        <div><div class="pk">CLEAN RUN</div><div class="pv">${Math.round(100 * cr / dn.length)}% <small>one start, nothing failed</small></div></div>
        <div class="pdiv"></div>
        <div><div class="pk">REWORK ABSORBED</div><div class="pv">${tf} <small>failed attempt(s) · ${(tf / dn.length).toFixed(2)} per item</small></div></div>
        ${pace.itemSpans && pace.itemSpans.length ? `<div class="pdiv"></div><div><div class="pk">MEDIAN ITEM</div><div class="pv">${pace.fmtDur(pace.med(pace.itemSpans))} <small>start → done</small></div></div>` : ''}
        <div class="pnote">The gap between first-pass and clean-run is rework the plan did not show. <code>forge stats</code> prints the per-milestone table.</div>
      </div>`;
    }
  }
  // Overview: releases as progress bars, and what is happening right now
  let releaseBlock = '';
  {
    const VLo = computeLabels(w);
    const rels = w.releaseOrder || [];
    const rowsR = (rels.length ? rels : [null]).map(r => {
      const ms = milestoneSeq(w).filter(m => (releaseOf(w, m) || null) === r);
      if (!ms.length) return '';
      const ids = w.order.filter(id => ms.includes(w.items[id].milestone));
      const d = ids.filter(id => w.items[id].status === 'DONE').length, live = ids.filter(id => w.items[id].status !== 'CANCELLED').length;
      const appr = ms.filter(m => (((w.gates || {})[m]) || {}).approved).length;
      const pctR = live ? Math.round(100 * d / live) : 0;
      return `<a class="relrow" href="#/plan/${encodeURIComponent(ms.find(m => !(((w.gates || {})[m]) || {}).approved) || ms[0])}">
        <span class="vtag rel">${esc(r ? VLo.releaseLabel[r] : '—')}</span><span class="rn">${esc(r ? ((w.releases[r] || {}).name || r) : 'All milestones')}</span>
        <span class="pbar"><i style="width:${pctR}%"></i></span><span class="rm">${appr}/${ms.length} milestones · ${d}/${live} items${r && (w.releases[r] || {}).tag ? ` · ${esc(w.releases[r].tag)}` : ''}</span></a>`;
    }).join('');
    if (rowsR) releaseBlock = `<div class="panel"><h3>Releases</h3><div class="rels">${rowsR}</div></div>`;
  }
  let nowBlock = '';
  {
    const VLn = computeLabels(w);
    const inP = w.order.filter(id => w.items[id].status === 'IN_PROGRESS');
    const blk = w.order.filter(id => w.items[id].status === 'BLOCKED');
    const li = id => `<li><a href="#/plan/${encodeURIComponent(id)}"><b class="vlab">${esc(VLn.item[id] || '')}</b>${esc(id)}</a> <span>${esc(w.items[id].title)}</span></li>`;
    const mIds = actM ? w.order.filter(id => w.items[id].milestone === actM) : [];
    const mDone = mIds.filter(id => w.items[id].status === 'DONE').length;
    nowBlock = `<div class="panel"><h3>Now${actM ? ` <span class="mut">— <span class="vtag">${esc(VLn.milestone[actM] || '')}</span>${esc(milestoneName(w, actM) || actM)}</span>` : ''}</h3>
      ${actM ? `<div class="nowbar"><span class="pbar"><i style="width:${mIds.length ? Math.round(100 * mDone / mIds.length) : 0}%"></i></span><span class="mut">${mDone}/${mIds.length} items in this milestone</span></div>` : ''}
      ${inP.length ? `<h4>In progress</h4><ul class="nowl">${inP.map(li).join('')}</ul>` : ''}
      ${blk.length ? `<h4>Blocked — needs you</h4><ul class="nowl">${blk.map(li).join('')}</ul>` : ''}
      ${NEXT_ID ? `<h4>Next up</h4><ul class="nowl">${li(NEXT_ID)}</ul>` : ''}
      ${!inP.length && !blk.length && !NEXT_ID ? '<p class="mut">Nothing in flight.</p>' : ''}</div>`;
  }
  // System: plan standards (forge upgrade) and the git/verify settings in force
  let standardsBlock = '', standardsMet = 0, standardsAll = 0;
  try {
    const st = upgradeStatus();
    standardsAll = st.length; standardsMet = st.filter(x => x.done).length;
    standardsBlock = st.map(x => `<div class="sysrow"><span class="bdg ${x.done ? 'ok' : x.kind === 'auto' ? 'bad' : 'warn'}">${x.done ? 'MET' : x.kind === 'auto' ? 'AUTO' : 'REVIEW'}</span><span class="n">${esc(x.id)} <span class="mut">${esc(x.since)}</span></span><span class="d">${esc(x.title)}${x.accepted ? ` · kept as-is: ${esc(x.accepted.reason)}` : ''}${x.findings.length ? `<br>${x.findings.slice(0, 3).map(esc).join('<br>')}` : ''}</span></div>`).join('');
  } catch (_) { /* never block the dashboard */ }
  const gcD = (() => { try { return gitCfg(cfg); } catch (_) { return null; } })();
  // ---- v0.20.1: Configuration and Commands pages ------------------------------------
  const cfgVal = key => {
    if (key === 'verify.*') { const v = cfg.verify || {}; return Object.keys(v).length ? Object.entries(v).map(([k, x]) => `<div><b>${esc(k)}</b> <code>${esc(String(x))}</code></div>`).join('') : null; }
    if (key === 'providers.*') { const v = cfg.providers || {}; return Object.keys(v).length ? Object.entries(v).filter(([k]) => !/key$/i.test(k) || k === 'keyEnv').map(([k, x]) => `<div><b>${esc(k)}</b> <code>${esc(String(x))}</code></div>`).join('') : null; }
    const v = key.split('.').reduce((o, k) => (o == null ? undefined : o[k]), cfg);
    if (v === undefined || v === null || v === '') return null;
    const sv = String(v);
    // comma / || lists read better one per line
    const parts = sv.includes('||') ? sv.split('||') : (sv.length > 40 && sv.includes(',') ? sv.split(',') : [sv]);
    return parts.map(x => `<code>${esc(x.trim())}</code>`).join('<br>');
  };
  const gsD = graphifyStatus(cfg);
  const gpD = graphifyProblems(gsD);
  const graphCard = `<div class="panel gcard"><h3>Graphify <span class="mut">— the code graph agents orient with instead of grep</span></h3>
    <div class="kv">
      <div class="row"><span class="k">Setting</span><span class="vl"><code>options.graphify = ${esc(gsD.choice)}</code></span></div>
      <div class="row"><span class="k">Graph</span><span class="vl">${gsD.built ? `built <span data-since="${new Date(gsD.builtMs).toISOString()}" data-post=" ago"></span> · ${gsD.sizeKB} KB${gsD.stale ? ' · <span class="warn">older than the last commit</span>' : ''}` : '<span class="warn">not built</span>'}</span></div>
      <div class="row"><span class="k">Kept current</span><span class="vl">${gsD.gitHook ? 'rebuilt after every commit (git hook)' : '<span class="mut">no git hook</span>'}</span></div>
      <div class="row"><span class="k">Claude Code</span><span class="vl">${gsD.claudeMd && gsD.claudeHook ? 'told to use it (CLAUDE.md section + hooks)' : '<span class="mut">not told to use it</span>'}</span></div>
      <div class="row"><span class="k">Git</span><span class="vl">${gsD.ignored === true ? 'graphify-out/ ignored' : gsD.ignored === false ? '<span class="warn">graphify-out/ not ignored</span>' : '<span class="mut">—</span>'}</span></div>
    </div>
    ${gsD.choice === 'use' ? (gpD.length ? `<p class="gfix"><b>To make it actually used</b>, run in the project folder:</p><pre><code>${gpD.map(x => esc(x.fix)).join('\n')}</code></pre><p class="footnote">${gpD.map(x => esc(x.what)).join(' · ')}. Restart the Claude session afterwards so it loads the hooks. Measure the effect: <code>forge usage --baseline --label graphify</code> before, compare after a few tasks.</p>` : '<p class="ok">In use: built, current, rebuilt on commit, and Claude Code is told to query it.</p>')
      : gsD.choice === 'skip' ? '<p class="mut">Skipped by choice. Agents orient with explorer runs and grep.</p>' : '<p class="mut">No choice recorded. <code>forge config set options.graphify use</code> after installing it, or <code>skip</code>.</p>'}
  </div>`;
  const cfgGroups = [...new Set(CONFIG_DOCS.map(d => d.group))];
  const configPage = `<div class="cfgintro panel"><p><b>This page is how Forge and the development setup are configured</b> — verify commands, gates, git flow, the build loop, delegation. It says nothing about the application itself: what the application must do lives in <a href="#/specs">Specs</a>.</p>
    <p><b>Delegation switches are reversible.</b> Turn on one per milestone, record a baseline first (<code>forge usage --baseline --label &lt;switch&gt;</code>), and watch first-pass and the orchestrator's share of calls on <a href="#/plan">Plan</a> and <a href="#/usage">Usage</a>. If first-pass drops by more than one task, turn it back off. Risk: <b>none</b> — no effect on how work is done · <b>low</b> — changes the process, easy to see if it misbehaves · <b>test first</b> — try it on one milestone before keeping it.</p>
    <p><b>How to change a setting:</b> run the command in the last column in a terminal, from the project folder — or ask the Claude session to run it. The CLI validates the value and records the decisions it needs (opting out of the git flow asks for a reason). Settings live in <code>forge/config.json</code>; change them through the CLI, not by editing the file. The dashboard refreshes on the next command. Click a command to copy it.</p></div>
    ${graphCard}
    ${cfgGroups.map(gname => `<h3 class="h3s">${esc(gname)}</h3><div class="tblwrap"><table class="cfgt"><colgroup><col style="width:19%"><col style="width:6%"><col style="width:7%"><col style="width:26%"><col style="width:21%"><col style="width:6%"><col style="width:15%"></colgroup><thead><tr><th>Setting</th><th>Now</th><th>Default</th><th>What it does</th><th>Why you'd change it</th><th>Risk</th><th>How to change</th></tr></thead><tbody>${
      CONFIG_DOCS.filter(d => d.group === gname).map(d => { const v = cfgVal(d.key); return `<tr><td><code>${esc(d.key)}</code></td><td>${v || '<span class="mut">default</span>'}</td><td class="mut">${esc(d.def)}</td><td>${esc(d.what)}</td><td>${esc(d.why)}</td><td><span class="risk risk-${d.risk.replace(/\s+/g, '')}">${esc(d.risk)}</span></td><td><code class="cmd copyable" title="Click to copy">${esc(d.change)}</code></td></tr>`; }).join('')
    }</tbody></table></div>`).join('')}`;
  const commandsPage = `<div class="workbar"><input class="filter" id="cmdfilter" type="search" placeholder="Filter commands… (e.g. milestone, verify, autopilot)" aria-label="Filter commands"><span class="mut">every command is <code>node &lt;forge&gt;/bin/forge.js …</code> — in a Claude session just say what you want; <code>forge help</code> prints the full reference</span></div>
    ${COMMAND_DOCS.map(g => `<section class="cmdgroup"><h3 class="h3s">${esc(g.group)}</h3><div class="tblwrap"><table class="cmdt"><tbody>${g.items.map(([c, wtxt]) => `<tr data-q="${esc((c + ' ' + wtxt).toLowerCase())}"><td><code class="cmd">${esc(c)}</code></td><td>${esc(wtxt)}</td></tr>`).join('')}</tbody></table></div></section>`).join('')}`;

  const configBlock = [
    ['Verify', Object.keys(cfg.verify || {}).length ? Object.entries(cfg.verify).map(([k, v]) => `${esc(k)}: <code>${esc(String(v))}</code>`).join('<br>') : 'not set'],
    ['Git flow', gcD ? (gcD.integration === 'per-milestone' ? `per-milestone · base <code>${esc(gcD.base || '?')}</code> · branch <code>${esc(gcD.pattern || '')}</code>` : 'manual (recorded opt-out)') : '—'],
    ['Versions', `labels start at V${versionStart()} (<code>options.versionStart</code>)`],
    ['Graphify', esc((cfg.options || {}).graphify || 'unset')],
  ].map(([k, v]) => `<div class="sysrow"><span class="n">${k}</span><span class="d">${v}</span></div>`).join('');
  // Change scripts (re-cuts, upgrades) are Forge plumbing: listed on System, not Specs (Specs = the application)
  let changeRows = '';
  try {
    const cd = path.join(FORGE, 'changes');
    if (fs.existsSync(cd)) changeRows = fs.readdirSync(cd).filter(f => !f.startsWith('.')).sort().reverse().slice(0, 40).map(f => {
      const abs = path.join(cd, f); const st = fs.statSync(abs); const key = 'change:' + f;
      const readable = /\.(md|sh)$/i.test(f) && addDoc(key, abs, `forge/changes/${f}`, f, 'change');
      return `<tr><td>${readable ? `<a href="#" class="docopen" data-doc="${esc(key)}"><code>${esc(f)}</code></a>` : `<code>${esc(f)}</code>`}</td><td class="mut">${st.size} B</td><td class="mut">${new Date(st.mtimeMs).toISOString().slice(0, 16).replace('T', ' ')}</td></tr>`;
    }).join('');
  } catch (_) { }
  const specCount = (specRows.match(/<tr>/g) || []).length;

  const html = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Forge — ${esc(cfg.project)}</title>
<link rel="icon" type="image/png" href="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAYAAACqaXHeAAAUQ0lEQVR42r1ba3RV1bX+5to7CeQhEAwEggkYxIgChgCiCNEAJkHNLeZCwShKoDAQGQOq4FUqqFgV8WJF26iBcIMUexEqBcrDPJDHDZQQMEmRCLHtGFGoUhg1ekvCOWuu+2M/zj4n+zwCeE/GHjln770ec65vPtaccxH8PwRAmd+vA3A/gFwAtwHoRYQYpaCZ78HxLjnaKpff1ocD7zkG9AKQALoA0M3vBEBztKWA74IAUuZ9ArGCYgDtBPxdAScBfAJgB4DvXGj0+wjHC08AOE2+ydqX271rcdGP298ZAE86aBTBiE8CUOFo6AFw2fzvdaxS4MUAmMj1WbDLG+QKfC6v8HLO3WLIPgC9ApkgzFVPAnDCJLzNbGgTF/D9WlxBGRnw/Ir6J0cfRPCYNCkAxwH0tkQIpowJU1Ys4p2DW53wNWYAa5omNU1jImPC1JEBwQjrNLPJ6M9iwn5Tz9gomO0gPthKRTx4OGYJIVgI4YcCoWnyR0CZG9LaTHGYbxEfB+C0+bInTCdXNRkiYk3T7N95eXnyZz+bbU9O0zRpMqazUA/LAIdIeIiIiXDapB3/Zq6+14KKqcyugtCO93QH4RkZGXLjxo1SKSWVUrJ63z4eN26cDXtd15mIrpbwUAzxmjTfDwBvmg8uB9Xu7p1ENBEhNJuYHt178PLly/n71u+lUkp++eWXsqbmsFRKsVKK33v/PR4wYIBTR1wNoXZbF91y2WTAahCw22HyZARwd33uMIHGbyH84P7oo4/y6S9Os1KKpVRy2bJlskePHhwbG8uPPPIIf/PNN6yU4n/84x/886d+zl26xATqi6u+TEUryTKNhD0A8D8BDOi0UvO3FiSdcB83bhxXVlaytcqbN2/m9PR0OXLECFlRUcnHj9dxQUEBJyUl8dtvv22/d/ToUX7wwQcdIhRaLCgyRcgOH0EBOAwAxwIZQFcmb1JzaPK01FQuLS21CWpoaOTs7Gzu1asXv//++7K+vl5OmzZNjh49WlZXV/PHH3/MN998M992661cVVVlt/voo818yy23+I1BVy77gQw4CgD1FgOIyLXz8HIuWAghAcguXbrIRQsX2ZC+cOECP/HEPE5MTOQFCxZwY2OjfGnFChnTJcZP3xQXF3N9fT2/8cYq7tWrF0+bNk3+9a9/ZaUUt37Xyi+++CL36NHDQhlrmuisMvTzEk1TeAwAGhwI6BThgWZtypQpfOLECXv1Vq9ezddffz3fd18u19XV8ZYtW/jGGwcEmj2pGczjhIQEfvPNN7m+vp6nT5/O3bpdxy+/vMLu74svvuCioiI/JdlJ/SADrEADADSG0wHhCB82bBhv/f3v7YlWV1fzsKHD+OabB/GWLVv50KFDcsKECbZ4REXpkoikw8uUuq7ZYw+57TbetWsXV1dX86hRozgjI4O3btlq979nzx4efedon37QNUYYsxnEDH7hZIDX4TKGcl9tpZicnMwrV67kS5faWCnFTU1NPHnyZO7Z83p+9dVXuampiRctWuS34qYis8ax/1vQ1nXdHquw8CE+cuQIl5SUcEpKCufl5fGpU6dYKcWeyx5+6623OCUlxUarc1HCXBYDmgNFQAZuJJxyrplw0zSN582bxy0tLayU4kuX2njx4sUc2zWWH364iOvrG3jNmjW2zAohLOUVEcIcY0lN0+TS55bKEydO8JNPPsndu3fnhQsX8g8//MBKKT579iwvWLDAZpzTbFJ4BpxxZUAoszZx4kQ+dPAgm14cl/9XOffr149HjBjBVVVV/Mknn8jMzEy/VY/Qv3DdLFntUlJS+IMPNvDBgwc5JyeHU9NSuby83BaLgwcP8MSJE31tdS2U2YyIAX7mY9CgQbxhwwfWgPLIkSPyzjvvlCkpKbx27Vo+evQoP/TQQzbjdD1AzkMzQYbwQfz0Q05ODh84cIA3btzI6ek38siRI7mm5rDNiPLyck5PTw+3hfcTgT87dYBT0RERd+vWTT7//PP83XffsVKKv/32W545c6ZMSLhOLl68WJ48eZKXLl1qQVAKIaRlEkOYoc4wgN30w/z58/n48Tp+4YUXuGfPnlxcXMwXL1xgpRSfP39ePv/88zIlJUUSkQxAglMJ/iWYFZC6rksAcubMmVIpxW1tbVxaWsq9e/fm/Px8efRorfzggw+kpYQCIRvh1tRpWcIFR2wZtxRpz56Jcu3atbK2tlbe/8D9sm/fvvzuu+9a4ikfefQRSURS8zeVMhABPkfIhQHFxcXS6/Xy6tWrOS4ujj/88HdcWVkpx4wZIwN2b5HKeKRMCBkcMcVCApBZWVly9+7dctu2bTx8+HD5YMGDctSoUbYOC+EHfKE7I8LKF3W1o75ejxeapuGbb75Bbm4uevbsoSZMmAAA0DQNzAyv1+ts4xpiDvFRACgxMREXL14EEaAiaOT1ShARNCFQV1eH/Px8zJ41S91+++0oKyszxieC8nWmXOZHIvzsFAAoTdPQfvkyGhoaQUSIjo6GlNI5gCtlmqZBE+7D6JoR8X7xhRfR1NSEu8feTUrZ95UQQgkhVBACSCkFr5QQQkAIgbXr1qGsrAyapkEIEZJ486bQ3ULEbpMkAgQRYmJioJQCM7uusvO3EAJSysD7RARFRGBmxMfFYcZjM5CUlIReSb18kADsMYQmwJID8xC+ZAOzkUAw52qNGQqR5nchIkMpIKVUBkcVORIfpNzwTARNE2BmlZMzXg3PylIKBtEAoBQIILBSGDJkKFJTU/HV11+hurragJsycJeRkYERI0aAJUPTNFjtrQUJmAdJKYMSHwgD5QiJa25cte5JcxWUAogENE0PyShhwl1KxtNPL0ZVVSW2b/sDYmNj/WYuhCAANH78eBJC4MjhI+qf//wnYqJ1AArx8QmorKzE4cOHMXv2LEhpyLzwMdF9lSno4rt9WDhEQLmksmw5IiIigtI0TZk9dnhX1w2lqGka3nnnHaxa9ToBoP/e/DtcvnwZQhDI7I+ZoWs6Jkw0FGpVVRWICKwM4trb26iqqgq6rqO0dC1WrHgJzAxWCpoWVGoJykaFEyFBge30A6S/mTGcjhmPPspKKX722We5oKCAS0pKpNNMOiM2ADgpKYl37dplhr4kP/30036OFQH2nuKmgTdx63et3Nrayhk3Z9j7BiJiIYz3X375l3bwdNOmTTI+PsG3A7zy8LhlBj8PawXIhLQQwlghlhQAORUTpSuv9KohQ4agsrIK+fn5uHjxIqZOnYo33ngDUboBa0u2yexr7NixSLguAcePH8eZ5jNm/0zGu0b/v/jFUsyZMwdtl9owffp07NmzG6mpqfB6pS1uEQPeTWIdOsD1ownNhqxSyh7UkjUigXaPF5MmTcKn+z5VQ4cOQXNzM+67L1dt3bpV6bquvF6vKTbGn1JGX/fcey8AYP/+/ZBS2lpcKZ/oRUdFobS0FJPun4SzZ89izJgx2LdvH+644w5T3ERobRfCDFoM8IZ6iZW/GbZ1AoAoU+YnT34I27ZtQ2LPROzcsQM5OTmoqztG0VE6vF6voSwUFKCUIENBdu/WHdnZ4wAAFRUVNpMD9I/yeL3Qdd0muu7YMdx4442qoqJCDR06FMzGorhqcAoLBSlM+QjhCbGNK8vhMBjj08SpqakUFRVFUko609yMlpYWaJoGKZkosJjAbH/XXXchNTUVTU1NqKursx0bt+W02vft2xdx8fG2rWfLETNFq0PLEE6aBWARzhGyutA0DUopEBmmnwiWF0ZvvfUrLH1uKTRNw6JFi7Bp0ybDU2RWwnKkfKuiAKjxpjtdUVGBS5cuGfA3HARfjp8Mpnu8XkybNg1VVVXIyMhQp06dwvjx4/HnkyeVEMKB0sjF32yhh2WA0+Aq5YCp8nlhggivvPoK5syZC4/Hg+nTp2PnH3eiV1ISpJQQmmYzUkqJrl27YnxOjgKAyspKPy/NZrjpykrJWLbsBXz44YcUHx9P27dvx7hx43D8+HEIITqKTQTEO5ikhTWDjz32GCul+LnnnuOCggJ+t6SEA80gEXF0VBQD4EmTJvG3355npRTXHTvGAwem27syK06QmTlctre387lzZ7lPn2Q7HmiZKyGMXWFCfLzc9NvfWmaQV61aZWeVtc5lkx1z9QuI/MWpA9h9x0RumyPnXaWUUpc9Hui6jl27dmHChPH4/PPPMTwrCxUVlcjMHA4A6BITBQCUc++9FB0djcOHj+Dcub9D0wRsP5sISgH90/pj9+49mP7ww/jX//4LxcXFavHixQCUEkJAGv4/RbjStioKUAteESg21GEP4PXbdDCroFDzmhq7oaEBeXl5qqamRvXv3x+FhQ8ZcDbhOnHiRADA7t27fGwmQ2tH6YaumTVrFsbcPQZnzpxB/qR8rF+/nqJ0HUqBmJmgFKnQRCvVsXaow5ZAD2cwlfL3sQWFHld6jfhBS0sL8vPzUVhYiJ07d4KI0N7uQVpaGu4acxfa29txYP8BW1sb4xjbWwAo31AOVozS0vfx1VdfQ9d1eLzeSJVbh/1BMIOghwtcWISbK6/cTIvfAGTsHIkIra2tWL9+vb2t9kqJnHtzVEJCAvbv34/mL78ECYLyKTKyxmlubsby5cvJVIiWM0UhaCbb7geYxYApk5kZhlIQVp1d4MbBARlSlisshEB0TIy5NXUfwPKTTJMJXdchBEGYHtvQYcNM+O82vD+huTGfhCDSdR2CCJLZJi2ox2qaaWVsW8PqBz8EhIgdKD1KN6MzhK5dY0FEhmkTUbYZ6oAg4wYppZQZLoPXY0D71++8g7+fO4u169aFDF4wKzB7ncvsClTf9luquPh4Sr3hBpw6dcrecrOltHw7WMszNV5RIdAPgLweDwCgra0dtbVHMXbsWMyZOwcej8fc0mqhXE47YMGmR9n8ZTNWvv46Lly4ENZbCyXmBro0UzEzpk6dioP7DyBnfA66dOliKW3lmBspFw6KcM6T1VlRURFSU1ORn5+P/Lx8HDp0ENnZ2fBKCVZKWRuZEEAlACSISNd18glsZ503QNc0ZaBLqqysLOzYsQPTpk3H4zMfx+mm0zh27JiqqalRWVlZAcqhw1jkzAzJwPwcEXFmZqZsbGy09+QlJSUyuU+yfOCBB/hPR//E68rKOLl3bwmAhZk1pqsrZwtWk2TFCiQAmZjYU7733nuy9mitLCwslDfddJNct26doyCjQd5zzz1SEAWm0GVgauyEIzPEbnH62NhYuWTJEuksepg7dy4nJibyU089xSdPnpTPPPOMjCBvHy4zJN0Km4jIL8f45Pwn5ZEjR+SSJUtknz595MKFC2VbW5tUSnFLSws/8cQTNqMC8gJWjZDFgFMg4DMidwZYXLcGTk29gX/zm1/bXG5sbOTc3Fzun5bG69ev55qaGr4v9z4/d9olLRWYJQ6VKLFS3hKAzM3NlQcOHJDr1pXJAQMGyAcefEB+fuqUVErJtrY2uWrV6zI5Odkew5miczDWRgABTQDwWTAE2GWmRoZYOgufnHU8mz7cxGn90zg7O5v3799vFEINTPerKQhSrBSUeGeuPz09nTdv/oirKqvk2LFj5eBbB8udO3faYrl9+3Z5++23S19iVpMECpeLtEWg3skACgFPYUDRfjZjxgxuampiK3e4eMkSTkpK4nnz5vHJkyd55cqV3LVrV7fy2KDi4Mzvx3aN5ddee40bGhq4uLiY+/TpK1/55SvSKedTpkxxEB6+wNLJAALOgIBG0z56Iy2IdiQouXv3brx82TL+/vtWVkrx3/72Ny4sLOR+/frx22vWcF1dHU/96U8DKkzItezGmf0tKiri2tpaXrVqFffr149nzJjB586dM2sJL/Az//EMx8XFySusJfQxwFki09mKcCcaBg++hTdv3uxXxzN48GAeNmwY7927l3ft3sWZmZmubZ3fs7Ky+JO9n/DOP/6RhwwZwiNGjORP931q97tx40YeOHCgjaROlMUEFYEGNx1AkVZeEvmFqAsKCvhY7TFHpdh/ckpKChcVFfFnn9XzmjVruFu3bj64m2hISkrikpISrqk5zD+ZPJnTBw7ktWvX2v0cOnSIJ0yYwL7stdZBw3eiaFuSgwHHTTg40+Nu9fuRlsBzl5gYXrhwIZ8/f94qWODHHn+ck5KS+OUVK/jEZyd41uzZdtunfv4U19fX87PPPsu9e/XmBQsW2DVALS0tPH/+fI4yAy6mib2ikpsAU6jIOFOEg84CCbr6QxD297S0NC4r8zknNTU1PPrO0XzLLRm8fft2rqqq4srKKi4vL+dBgwZxbm4u19c32EmVNWvWcHJysmvfnagMdat9NM0g/QkAtgQygK7xuYB7srO5urraZkRZWRmnpqbylH+fwnl5eXzbrbfxxx9/bD/fvmMH3zHqDr/KE0txUudrmDvMjUCWH/AHEPCSKQ+Xr/WJDSEEC7OkVQgh582bx19//bVR/traynPnzuXXXnvNadZ4ypQpYS3GNTjHYNUKvwAA9/6IZ4OcBZISAKf07ctvvrmavV6vXXF24cIFXrJkCcfFx/kQdI1K5MNUi94NANGmJWCQr17YTRTcmEOdqAfSHN7kyJEjee/evbxhwwbZ4ZAEhVZwFNn4ztI8R4IWl802tc54yGRTDNpNRvxoR+NEgFsdYt9wxYeyAqpdA++3m7T+xC85AGCDqRjaIjWDFH4yQQ82aprhTVrmMwKiOnVyLcjVbtK40Um7dYAwFsBe8lkET8CAHXdrnRSBKy2ZDXNUJ5K2Hofi22nSKgCQMzXuAbAVQAqA4Y6UmUTw+Hqws7p8lWeBEckz8sX+2eU96551MFQQ8CsAxabFg1so0/oUADjgiJz8vx58vsb9X4JxHnq8G60UJIhpBervAjAWQIZ53jY6MI5I/pVizraBVWnOLKZbGs4ZtxOO9s7QvRW6C4wVOledzIVrgeHqHjSjXpbM+439fx/jcjxbW9s+AAAAAElFTkSuQmCC">
<style>
:root{--ink:#1b1d24;--ink2:#565b68;--ink3:#8a8e9a;--ground:#f4f3ef;--surface:#fff;--line:#e6e4dd;--line2:#efede8;
--side:#15171e;--sideink:#c6c9d3;--sidemut:#787d8b;--sideline:#262a35;--accent:#d4551a;--accsoft:#d4551a14;
--done:#178744;--readyc:#0c8a70;--progc:#4553c4;--blockc:#bb2d2d;--awaitc:#b3660a;--todoc:#8a8e9a;
--mono:ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,monospace;
--shadow:0 1px 2px rgba(27,29,36,.05),0 10px 30px -18px rgba(27,29,36,.18);--r:12px}
*{box-sizing:border-box;margin:0;padding:0}
html{scroll-behavior:smooth}
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Inter,Roboto,Helvetica,Arial,sans-serif;background:var(--ground);color:var(--ink);line-height:1.55;font-size:14px;-webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility}
h1,h2,h3,h4{letter-spacing:-.015em}
h1{font-size:24px;font-weight:700} h2{font-size:17px;font-weight:700} h3{font-size:14px;font-weight:700;margin:0}
.mut{color:var(--ink3);font-size:12.5px;font-weight:400}
.num{font-variant-numeric:tabular-nums}
code{font-family:var(--mono);font-size:.88em;background:var(--line2);border-radius:5px;padding:1px 5px}
a{color:var(--accent);text-decoration:none} a:hover{text-decoration:underline}
/* ---- shell ---- */
.shell{display:flex;min-height:100vh}
aside{width:228px;flex:none;background:var(--side);color:var(--sideink);display:flex;flex-direction:column;position:sticky;top:0;height:100vh;padding:22px 0 16px}
.brand{padding:0 20px 18px;border-bottom:1px solid var(--sideline)}
.brand img{height:29px;display:block;margin-bottom:12px}
.proj{font-size:12.5px;color:var(--sidemut)} .proj b{display:block;color:var(--sideink);font-size:13.5px;font-weight:600}
.phase{display:inline-block;margin-top:7px;font-size:9.5px;font-weight:700;letter-spacing:.09em;text-transform:uppercase;color:#e9b98a;border:1px solid #6b4a2b;background:#d4551a1f;border-radius:99px;padding:2px 9px}
#snav{padding:14px 10px;display:flex;flex-direction:column;gap:2px;flex:1;overflow-y:auto}
#snav a{display:flex;justify-content:space-between;align-items:center;color:var(--sidemut);font-size:13px;font-weight:500;padding:8px 12px;border-radius:8px}
#snav a:hover{color:var(--sideink);background:#ffffff0a;text-decoration:none}
#snav a.on{color:#fff;background:#ffffff12}
#snav a .k{font-size:11px;color:var(--sidemut);font-variant-numeric:tabular-nums}
.sidefoot{padding:14px 20px 0;border-top:1px solid var(--sideline);font-size:10.5px;color:var(--sidemut);line-height:1.5}
.sidefoot b{color:var(--sideink)}
main{flex:1;min-width:0;padding:26px clamp(16px,3.5vw,44px) 80px}
.wrap{max-width:1140px;margin:0 auto}
/* ---- overview ---- */
.tophead{display:flex;flex-wrap:wrap;align-items:flex-end;justify-content:space-between;gap:12px;margin-bottom:14px}
.stamp{font-size:11px;color:var(--ink3);text-align:right;line-height:1.5}
.stamp code{background:#fff}
.needsyou{border:1px solid var(--line);border-left:4px solid var(--awaitc);border-radius:var(--r);display:flex;gap:16px;align-items:flex-start;padding:16px 20px;background:linear-gradient(0deg,#b3660a08,#b3660a08),var(--surface);margin-bottom:14px;box-shadow:var(--shadow)}
.needsyou .glyph{width:38px;height:38px;flex:none;border-radius:10px;background:#b3660a1a;display:grid;place-items:center;font-size:18px}
.needsyou h3{font-size:15px} .needsyou p{font-size:13px;color:var(--ink2);margin-top:3px;max-width:78ch}
.kpis{display:grid;grid-template-columns:minmax(0,1.35fr) repeat(4,minmax(0,1fr));gap:12px}
@media (max-width:1240px) and (min-width:941px){.kpis{grid-template-columns:repeat(4,minmax(0,1fr))} .kpi.hero{grid-column:1/-1}}
.kpi{background:var(--surface);border:1px solid var(--line);border-radius:var(--r);padding:16px 18px;display:flex;flex-direction:column;gap:1px;justify-content:center;box-shadow:var(--shadow)}
.kpi.hero{flex-direction:row;align-items:center;justify-content:flex-start;gap:16px}
.kpi .v{font-weight:700;font-size:26px;letter-spacing:-.025em;font-variant-numeric:tabular-nums;line-height:1.15}
.kpi .v small{font-size:14px;color:var(--ink3);font-weight:500;letter-spacing:0}
.kpi .l{font-size:10.5px;color:var(--ink3);font-weight:600;letter-spacing:.05em;margin-top:2px}
.kpi .d{font-size:11.5px;color:var(--ink2)}
.pacestrip{background:var(--surface);border:1px solid var(--line);border-radius:var(--r);margin-top:12px;padding:14px 20px;display:flex;flex-wrap:wrap;gap:8px 34px;align-items:center;box-shadow:var(--shadow)}
.pk{font-size:10px;font-weight:700;letter-spacing:.08em;color:var(--ink3)}
.pv{font-weight:700;font-size:17px;letter-spacing:-.02em;font-variant-numeric:tabular-nums}
.pv small{font-size:12px;color:var(--ink3);font-weight:500;letter-spacing:0}
.pdiv{width:1px;height:34px;background:var(--line)}
.pnote{font-size:11px;color:var(--ink3);max-width:280px;line-height:1.45;margin-left:auto}
/* ---- sections ---- */
details.sec{margin:32px 0 0;scroll-margin-top:16px}
details.sec>summary{cursor:pointer;user-select:none;list-style:none;display:flex;align-items:baseline;gap:9px;padding:0 0 12px;font-size:17px;font-weight:700;letter-spacing:-.015em}
details.sec>summary::-webkit-details-marker{display:none}
details.sec>summary::before{content:"";flex:none;width:0;height:0;border:5px solid transparent;border-left-color:var(--ink3);transform:translateY(-1px);transition:transform .15s ease}
details.sec[open]>summary::before{transform:rotate(90deg) translateY(0)}
details.sec>summary:hover{color:var(--accent)}
details.sec>summary:hover::before{border-left-color:var(--accent)}
details.sec>summary .mut{font-weight:400;font-size:12.5px}
/* ---- milestone groups ---- */
details.sec.sub{margin:12px 0 0;background:var(--surface);border:1px solid var(--line);border-radius:var(--r);box-shadow:var(--shadow);overflow:hidden}
details.sec.sub>summary{padding:13px 18px;font-size:14.5px;align-items:center;flex-wrap:wrap;gap:10px}
details.sec.sub>summary:hover{background:var(--line2);color:inherit}
details.sec.sub>summary:hover::before{border-left-color:var(--ink3)}
details.sec.sub>summary .mut{font-variant-numeric:tabular-nums}
.mgb{border-top:1px solid var(--line)}
/* ---- item rows + drawer ---- */
details.icd{border-bottom:1px solid var(--line2)}
details.icd:last-child{border-bottom:0}
summary.irow{display:grid;grid-template-columns:4px 168px minmax(0,1fr) auto;gap:0 14px;align-items:center;padding-right:18px;cursor:pointer;user-select:none;list-style:none;font-size:13px}
summary.irow::-webkit-details-marker{display:none}
summary.irow:hover{background:#faf9f5}
details.icd[open]>summary.irow{background:#faf9f5}
.stripe{align-self:stretch;min-height:44px}
.iid{font-family:var(--mono);font-size:11.5px;color:var(--ink2);padding:12px 0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.itt{padding:12px 0;display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-weight:500;min-width:0}
.itt .sub{font-size:11.5px;color:var(--ink3);font-weight:400;flex-basis:100%}
.itt .warnv{font-size:11.5px;color:var(--awaitc);font-weight:500;flex-basis:100%}
.imeta{display:flex;align-items:center;gap:12px;font-size:11.5px;color:var(--ink3);padding:12px 0;justify-content:flex-end;font-variant-numeric:tabular-nums;white-space:nowrap}
.st{font-size:9.5px;font-weight:700;letter-spacing:.06em;border-radius:6px;padding:3px 7px;white-space:nowrap}
.st.s-done{color:var(--done);background:#17874414}
.st.s-prog{color:var(--progc);background:#4553c414}
.st.s-ready{color:var(--readyc);background:#0c8a7014}
.st.s-block{color:var(--blockc);background:#bb2d2d12}
.st.s-todo{color:var(--ink3);background:var(--line2)}
.st.s-cancel{color:var(--ink3);background:var(--line2);text-decoration:line-through}
.dot-open{display:inline-block;width:6px;height:6px;border-radius:50%;background:var(--progc);margin-right:2px;vertical-align:1px}
.icdb{background:#faf9f5;border-top:1px dashed var(--line);padding:16px 22px 18px 36px;font-size:12.5px;color:#464b58}
.icdb h4{font-size:10.5px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--ink3);margin:0 0 8px}
.icdb h4+h4,.dgrid h4:not(:first-child){margin-top:16px}
.dgrid{display:grid;grid-template-columns:1.25fr 1fr;gap:24px}
.crit{list-style:none;display:flex;flex-direction:column;gap:7px;font-size:12.5px}
.crit li{display:flex;gap:9px;align-items:baseline}
.crit .ck{flex:none;width:16px;height:16px;border-radius:5px;display:grid;place-items:center;font-size:10px;font-weight:800;transform:translateY(3px)}
.ck.ok{background:#17874418;color:var(--done)} .ck.no{background:#bb2d2d14;color:var(--blockc)} .ck.un{background:var(--line2);color:var(--ink3)}
.kv{display:flex;flex-direction:column;gap:8px;font-size:12.5px}
.kv .row{display:flex;gap:10px}
.kv .k{flex:none;width:92px;color:var(--ink3);font-size:11.5px;padding-top:1px}
.kv .vl{min-width:0;word-break:break-word}
.dsp{list-style:none;display:flex;flex-direction:column;gap:6px;font-size:12px}
.dsp li{display:flex;gap:9px;align-items:baseline}
.dsp .t{color:var(--ink3);font-size:11px;flex:none;width:82px;font-family:var(--mono)}
.briefbtn{display:inline-flex;align-items:center;gap:7px;margin-top:14px;font:inherit;font-weight:600;font-size:12.5px;color:var(--accent);border:1px solid #d4551a3d;background:var(--accsoft);border-radius:9px;padding:7px 13px;cursor:pointer;text-align:left}
.briefbtn:hover{text-decoration:none;background:#d4551a22}
button.cchip{font:inherit;font-size:10.5px;font-weight:600;border:0;cursor:pointer}
button.cchip:hover{background:var(--accsoft);color:var(--accent)}
.docopen{cursor:pointer}
.mcount{font-size:10.5px;color:var(--accent);font-weight:600}
.segwrap{display:flex;flex-direction:column;gap:2px}
.seg button .n{font-size:10px;opacity:.75;margin-left:5px;font-variant-numeric:tabular-nums}
.noresult{color:var(--ink3);font-size:13px;padding:14px 2px}
/* ---- document reader ---- */
.docscrim{position:fixed;inset:0;background:#1b1d2455;opacity:0;pointer-events:none;transition:opacity .15s;z-index:40}
.docscrim.on{opacity:1;pointer-events:auto}
.docpanel{position:fixed;top:0;right:0;bottom:0;width:min(760px,94vw);background:var(--surface);border-left:1px solid var(--line);
  box-shadow:-24px 0 60px -30px rgba(27,29,36,.5);transform:translateX(102%);transition:transform .18s ease;z-index:41;display:flex;flex-direction:column}
.docpanel.on{transform:none}
.dochead{flex:none;padding:16px 22px;border-bottom:1px solid var(--line);display:flex;align-items:flex-start;gap:12px;flex-wrap:wrap}
.dochead h3{font-size:15px;letter-spacing:-.015em;color:var(--ink)}
.dochead .p{font-family:var(--mono);font-size:11px;color:var(--ink3);margin-top:3px;word-break:break-all}
.docacts{margin-left:auto;display:flex;gap:7px;align-items:center}
.docbtn{font:inherit;font-size:11.5px;font-weight:600;color:var(--ink2);background:var(--surface);border:1px solid var(--line);border-radius:8px;padding:6px 11px;cursor:pointer;text-decoration:none;white-space:nowrap}
.docbtn:hover{border-color:var(--ink3);color:var(--ink);text-decoration:none}
.docbtn.x{padding:6px 10px;font-size:14px;line-height:1}
.docbody{flex:1;overflow-y:auto;padding:22px 26px 60px;font-size:13.5px;line-height:1.62;color:#33373f}
.docbody h1{font-size:20px;margin:0 0 12px}
.docbody h2{font-size:16px;margin:24px 0 8px;padding-bottom:5px;border-bottom:1px solid var(--line2)}
.docbody h3{font-size:14px;margin:18px 0 6px}
.docbody h4{font-size:12.5px;margin:14px 0 5px;color:var(--ink2)}
.docbody p{margin:9px 0}
.docbody ul,.docbody ol{margin:9px 0 9px 22px}
.docbody li{margin:4px 0}
.docbody code{font-size:12px}
.docbody pre{background:#f4f3ef;border:1px solid var(--line);border-radius:9px;padding:12px 14px;overflow-x:auto;margin:11px 0}
.docbody pre code{background:none;padding:0;font-size:12px;line-height:1.5}
.docbody blockquote{border-left:3px solid var(--line);margin:11px 0;padding:2px 0 2px 14px;color:var(--ink2)}
.docbody hr{border:0;border-top:1px solid var(--line);margin:18px 0}
.docbody table{margin:11px 0;font-size:12.5px}
.docbody a{word-break:break-word}
.docmiss{color:var(--ink3);font-size:13px}
@media (max-width:940px){.docpanel{width:100vw}}
.cchip{display:inline-flex;align-items:center;gap:5px;font-size:10.5px;font-weight:600;border-radius:7px;padding:2px 8px;background:var(--line2);color:var(--ink2);white-space:nowrap}
.cchip i{width:7px;height:7px;border-radius:2px;display:block;flex:none}
.pill{display:inline-block;font-size:9.5px;font-weight:700;letter-spacing:.07em;text-transform:uppercase;border-radius:99px;padding:3px 9px;white-space:nowrap}
/* ---- workbar ---- */
.workbar{display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin:0 0 4px}
.filter{flex:1;min-width:220px;max-width:420px;font:inherit;font-size:13px;padding:9px 14px;border:1px solid var(--line);border-radius:10px;background:var(--surface);outline:none}
.filter:focus{border-color:var(--accent);box-shadow:0 0 0 3px var(--accsoft)}
.seg{display:flex;border:1px solid var(--line);border-radius:10px;overflow:hidden;background:var(--surface)}
.seg button{font:inherit;font-size:12px;font-weight:600;padding:8px 13px;border:0;border-right:1px solid var(--line);background:none;color:var(--ink3);cursor:pointer}
.seg button:last-child{border-right:0}
.seg button:hover{color:var(--ink)}
.seg button.on{background:var(--ink);color:#fff}
/* ---- milestone rail ---- */
.railcard{background:var(--surface);border:1px solid var(--line);border-radius:var(--r);box-shadow:var(--shadow);padding:16px 8px 8px}
.railwrap{overflow-x:auto;padding:4px 2px 8px}
.rail{display:flex;min-width:max-content}
.mnode{position:relative;width:112px;flex:none;display:flex;flex-direction:column;align-items:center;gap:6px;padding-top:4px;color:inherit}
.mnode:hover{text-decoration:none} .mnode:hover .mn{color:var(--accent)}
.mnode::before{content:"";position:absolute;top:16px;left:-50%;width:100%;height:2px;background:var(--line)}
.mnode:first-child::before{display:none}
.mnode.done::before{background:var(--done)}
.mdot{width:26px;height:26px;border-radius:50%;display:grid;place-items:center;font-size:11.5px;font-weight:700;z-index:1;background:var(--surface);border:2px solid var(--line);color:var(--ink3)}
.mnode.done .mdot{background:var(--done);border-color:var(--done);color:#fff}
.mnode.awaitg .mdot{border-color:var(--awaitc);color:var(--awaitc);box-shadow:0 0 0 4px #b3660a1f}
.mnode.activeg .mdot{border-color:var(--accent);color:var(--accent);box-shadow:0 0 0 4px var(--accsoft)}
.mn{font-size:10.5px;font-weight:600;text-align:center;line-height:1.22;max-width:102px;color:var(--ink)}
.mnode.futureg .mn{color:var(--ink3);font-weight:500}
.mi{font-size:10px;color:var(--ink3);font-variant-numeric:tabular-nums}
/* ---- v0.18 version labels ---- */
.mv{font-size:10.5px;font-weight:700;color:var(--accent);font-variant-numeric:tabular-nums;letter-spacing:.02em}
.mnode.futureg .mv{color:var(--ink3)}
.rsep{flex:none;width:74px;display:flex;flex-direction:column;align-items:center;justify-content:flex-start;gap:3px;padding-top:2px;border-left:1px dashed var(--line);margin-left:6px}
.rsep span{font-size:12px;font-weight:800;color:var(--ink);letter-spacing:.03em}
.rsep em{font-style:normal;font-size:9.5px;color:var(--ink3);text-align:center;line-height:1.2;max-width:68px}
.vtag{display:inline-block;font-size:11px;font-weight:700;font-variant-numeric:tabular-nums;color:var(--accent);background:var(--accsoft);border-radius:5px;padding:1px 6px;margin-right:8px;vertical-align:1px}
.vtag.rel{font-size:12.5px;padding:2px 8px;color:#fff;background:var(--accent)}
.relh{margin:18px 0 8px;font-size:14px;font-weight:700;color:var(--ink);display:flex;align-items:center;gap:6px}
.relh .mut{font-weight:500;font-size:12px}
.vlab{font-weight:700;color:var(--accent);margin-right:6px;font-variant-numeric:tabular-nums}
.vlab i{font-style:normal;color:var(--ink3);margin-left:1px}
.cdots{display:flex;gap:3px} .cdots i{width:6px;height:6px;border-radius:50%;display:block}
/* ---- v0.20.1 configuration & commands ---- */
.cfgintro p{font-size:13px;color:var(--ink2)}
.gcard{margin:12px 0 18px} .gcard pre{background:#f4f3ef;border:1px solid var(--line);border-radius:9px;padding:10px 12px;overflow-x:auto} .gcard pre code{background:none;padding:0;font-size:12px}
.gfix{font-size:13px}
table.cfgt{table-layout:fixed} table.cfgt th:nth-child(1){width:19%} table.cfgt th:nth-child(2){width:20%} table.cfgt th:nth-child(3){width:10%} table.cfgt th:nth-child(5){width:21%}
table.cfgt td{overflow-wrap:anywhere} table.cfgt td code{white-space:normal;word-break:break-word} table.cfgt td:nth-child(4){color:var(--ink2)} table.cfgt td div{margin:1px 0}
code.cmd{white-space:pre-wrap;word-break:break-word}
.risk{display:inline-block;font-size:11.5px;font-weight:600;padding:1px 7px;border-radius:999px;white-space:nowrap;background:var(--line2);color:var(--ink2)}
.risk-low{background:#0c8a7014;color:var(--readyc)}
.risk-testfirst{background:#b3660a14;color:var(--awaitc)}
code.copyable{cursor:copy}
table.cfgt{table-layout:fixed;width:100%}
table.cfgt td{overflow-wrap:anywhere}
code.copyable.copied{outline:1px solid var(--done)}
table.cmdt td:first-child{width:44%}
.cmdgroup{margin-top:14px}
/* ---- v0.19 pages ---- */
.phase.ap{color:#9be3c4;border-color:#2b6b55;background:#0c8a7026}
.phase.apstop{color:#f3c98f;border-color:#8a5a14;background:#b3660a26}
.pbar{height:6px;border-radius:99px;background:var(--line2);overflow:hidden;display:block}
.pbar i{display:block;height:100%;border-radius:99px;background:var(--done)}
section.page[hidden]{display:none}
.phead{display:flex;align-items:baseline;gap:12px;flex-wrap:wrap;margin:2px 0 16px}
.phead h2{font-size:22px;letter-spacing:-.02em}
.h3s{margin:4px 0 9px}
.warnk{color:#e9b98a!important}
.ovgrid{display:grid;grid-template-columns:minmax(0,1.7fr) minmax(0,1fr);gap:12px;margin-top:12px;align-items:start}
.ovgrid>*,.panel{min-width:0}
.ovgrid .panel h4,.archfoot h4{font-size:10.5px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--ink3);margin:4px 0 -4px}
.nowl{list-style:none;display:flex;flex-direction:column;gap:6px;font-size:12.5px}
.nowl li{display:flex;gap:8px;align-items:baseline;min-width:0}
.nowl li>span{flex:1;min-width:0;color:var(--ink2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.nowl a{font-family:var(--mono);font-size:11.5px;white-space:nowrap}
.nowbar{display:flex;align-items:center;gap:12px} .nowbar .pbar{flex:1}
.rels{display:flex;flex-direction:column;gap:10px}
.relrow{display:grid;grid-template-columns:auto minmax(0,1fr);grid-template-areas:"t n" "b b" "m m";gap:4px 8px;color:inherit;align-items:center}
.relrow:hover{text-decoration:none} .relrow:hover .rn{color:var(--accent)}
.relrow .vtag{grid-area:t;margin:0} .relrow .rn{grid-area:n;font-weight:600;font-size:13px}
.relrow .pbar{grid-area:b} .relrow .rm{grid-area:m;font-size:11.5px;color:var(--ink3);font-variant-numeric:tabular-nums}
.telgrid.one{grid-template-columns:1fr}
.compfilter[hidden]{display:none}
.compfilter{display:inline-flex;align-items:center;gap:6px;font-size:12px;background:var(--accsoft);color:var(--accent);border-radius:9px;padding:6px 6px 6px 11px}
.compfilter button{border:0;background:none;color:inherit;cursor:pointer;font-size:12px;padding:0 5px}
details.icd.flash>summary,details.sec.sub.flash>summary{animation:flash 1.6s ease}
@keyframes flash{0%,40%{background:#d4551a22}100%{background:transparent}}
.empty{background:var(--surface);border:1px dashed var(--line);border-radius:var(--r);padding:22px 24px;max-width:760px}
.empty h3{margin-bottom:8px} .empty p{font-size:13px;color:var(--ink2);margin-top:6px}
/* ---- v0.19 architecture ---- */
.draftnote{font-size:12.5px;color:#7a4a0c;background:#b3660a12;border:1px solid #b3660a33;border-radius:10px;padding:9px 14px;margin-bottom:12px}
.archwrap{overflow-x:auto;border-radius:var(--r)}
.archcard{position:relative;background:var(--surface);border:1px solid var(--line);border-radius:var(--r);box-shadow:var(--shadow);padding:18px;display:flex;flex-direction:column;gap:34px;min-width:760px}
.archsvg{position:absolute;left:0;top:0;pointer-events:none;z-index:2;overflow:visible}
.lane{display:grid;grid-template-columns:118px minmax(0,1fr);gap:14px;align-items:center;background:#f7f6f2;border:1px solid var(--line2);border-radius:12px;padding:16px 14px}
.lane.ext{background:#f4f3fb}
.lanehead b{display:block;font-size:10.5px;letter-spacing:.09em;color:var(--ink2)}
.lanehead span{display:block;font-size:10.5px;color:var(--ink3);line-height:1.4;margin-top:3px}
.lanebody{display:grid;gap:18px 22px;align-items:stretch}
.acard{position:relative;z-index:3;text-align:left;font:inherit;background:var(--surface);border:1px solid var(--line);border-left:4px solid var(--kc);border-radius:10px;padding:10px 13px;display:flex;flex-direction:column;gap:3px;cursor:pointer;box-shadow:0 1px 2px rgba(27,29,36,.06);width:100%;max-width:240px;justify-self:center;min-width:0}
.acard:hover{border-color:var(--ink3);border-left-color:var(--kc)}
.acard.sel{box-shadow:0 0 0 3px var(--accsoft);border-color:var(--accent);border-left-color:var(--kc)}
.acard.draft{border-style:dashed;border-left-style:solid}
.acard b{font-size:13px;letter-spacing:-.01em;color:var(--ink)}
.acard .as{font-size:11.5px;color:var(--ink2);line-height:1.35;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;overflow-wrap:anywhere}
.acard .ap{font-size:11px;color:var(--ink3);font-variant-numeric:tabular-nums}
.acard .ap em{font-style:normal;color:var(--progc);font-weight:600} .acard .ap i{font-style:normal;color:var(--awaitc)}
.aedge path{stroke:#6b7080;stroke-width:1.4}
.aedge.planned path{stroke-dasharray:5 4}
.aedge.draft path{stroke:#a5a9b5}
.aedge.hl path{stroke:var(--accent);stroke-width:2}
.aedge text{font-size:10.5px;fill:#565b68;font-family:inherit}
.aedge.hl text{fill:var(--accent);font-weight:600}
.aedge .lbg{fill:#fff;opacity:.92}
.archfoot{display:grid;grid-template-columns:1fr 1.25fr 1fr;gap:12px;margin-top:12px;align-items:start}
.archfoot p{font-size:12.5px;color:var(--ink2)}
.alegend{display:flex;flex-wrap:wrap;gap:6px 14px;font-size:12px;color:var(--ink2)}
.alegend i,.alink i,.sgroup h3 i{display:inline-block;width:10px;height:10px;border-radius:3px;margin-right:6px;vertical-align:-1px}
.alink{font:inherit;font-weight:600;border:0;background:none;cursor:pointer;color:var(--ink);padding:0;text-align:left}
.alink:hover{color:var(--accent)}
.selbtn{display:inline-block;margin-top:12px}
/* ---- v0.19 screens ---- */
.sgroup{margin-top:20px}
.sgroup h3{display:flex;align-items:center;gap:8px;margin-bottom:10px;font-size:15px}
.sgroup h3 a{font-weight:400;font-size:12px}
.sgrid{display:grid;grid-template-columns:repeat(auto-fill,minmax(196px,1fr));gap:12px}
.scard{background:var(--surface);border:1px solid var(--line);border-radius:var(--r);box-shadow:var(--shadow);overflow:hidden;display:flex;flex-direction:column}
.sthumb{display:block;height:150px;background:#f1efe9;border-bottom:1px solid var(--line2);overflow:hidden}
.sthumb img{width:100%;height:100%;object-fit:cover;object-position:top;display:block}
.sthumb.none{display:grid;place-items:center;font-size:11px;color:var(--ink3);background:repeating-linear-gradient(45deg,#f1efe9 0 8px,#eceae3 8px 16px)}
.sb{padding:10px 12px 12px;display:flex;flex-direction:column;gap:2px;min-width:0}
.sb b{font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.sb .mut{font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.sp{font-size:11.5px;margin-top:3px}
/* ---- telemetry ---- */
.telgrid{display:grid;grid-template-columns:1.15fr 1fr;gap:12px;align-items:start}
.panel{background:var(--surface);border:1px solid var(--line);border-radius:var(--r);box-shadow:var(--shadow);padding:18px 20px;display:flex;flex-direction:column;gap:13px}
.panel h3 .mut{font-weight:400;font-size:11.5px}
.hbar{display:grid;grid-template-columns:118px 1fr 78px;gap:10px;align-items:center}
.hbar .lab{font-family:var(--mono);font-size:11px;color:var(--ink2);text-align:right;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.hbar .tr{height:16px;border-radius:5px;background:var(--line2);position:relative;overflow:hidden}
.hbar .tr i{position:absolute;top:0;bottom:0;border-radius:5px}
.hbar .vv{font-size:11.5px;color:var(--ink2);text-align:right;font-variant-numeric:tabular-nums}
.legend{display:flex;gap:16px;font-size:11.5px;color:var(--ink2);flex-wrap:wrap}
.legend i{width:10px;height:10px;border-radius:3px;display:inline-block;margin-right:5px;vertical-align:-1px}
.tokrow{display:grid;grid-template-columns:minmax(0,1fr) auto auto;gap:10px;font-size:12.5px;padding:7px 0;border-bottom:1px solid var(--line2);align-items:baseline}
.tokrow:last-child{border-bottom:0}
.tokrow b{font-variant-numeric:tabular-nums} .tokrow .n{color:var(--ink3);font-size:11px}
.tokrow .m{color:var(--ink2);overflow:hidden;text-overflow:ellipsis}
.tokrow .m i{display:inline-block;width:9px;height:9px;border-radius:3px;margin-right:6px}
.donutwrap{display:flex;gap:18px;align-items:center;flex-wrap:wrap}
.footnote{font-size:11px;color:var(--ink3);line-height:1.5}
/* ---- journal ---- */
.jgrid{display:grid;grid-template-columns:1fr 1fr;gap:12px}
.jcol{background:var(--surface);border:1px solid var(--line);border-radius:var(--r);box-shadow:var(--shadow);padding:18px 20px}
.jcol h3{margin-bottom:13px}
.jitem{position:relative;padding:0 0 15px 20px;border-left:2px solid var(--line);margin-left:5px}
.jitem:last-child{padding-bottom:2px;border-left-color:transparent}
.jitem::before{content:"";position:absolute;left:-6px;top:4px;width:10px;height:10px;border-radius:50%;background:var(--surface);border:2.5px solid var(--ink3)}
.jitem.human::before{border-color:var(--accent)}
.jitem b{font-size:13px;display:block;font-weight:600;letter-spacing:-.01em}
.jitem p{font-size:12.5px;color:var(--ink2);margin-top:3px}
.jitem .ts{font-size:10.5px;color:var(--ink3);font-variant-numeric:tabular-nums}
.tag{font-size:9px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;border-radius:5px;padding:2px 6px;margin-left:7px;vertical-align:1px}
.tag.h{color:var(--accent);background:var(--accsoft)} .tag.f{color:var(--ink3);background:var(--line2)}
/* ---- system ---- */
.syscard{background:var(--surface);border:1px solid var(--line);border-radius:var(--r);box-shadow:var(--shadow);overflow:hidden}
.sysrow{display:flex;align-items:baseline;gap:12px;padding:10px 18px;border-bottom:1px solid var(--line2);font-size:13px}
.sysrow:last-child{border-bottom:0}
.sysrow .bdg{font-size:9.5px;font-weight:700;letter-spacing:.06em;width:46px;flex:none}
.sysrow .n{width:168px;flex:none;font-weight:500}
.sysrow .d{color:var(--ink3);font-size:12.5px;min-width:0;overflow-wrap:anywhere}
.ok{color:var(--done)} .warn{color:var(--awaitc)} .bad{color:var(--blockc)}
/* ---- shared ---- */
.tblwrap{overflow-x:auto;background:var(--surface);border:1px solid var(--line);border-radius:var(--r);box-shadow:var(--shadow)}
table{width:100%;border-collapse:collapse;font-size:12.5px}
th{font-size:10px;text-transform:uppercase;letter-spacing:.07em;color:var(--ink3);text-align:left;padding:9px 14px;border-bottom:1px solid var(--line);font-weight:600}
td{padding:9px 14px;border-bottom:1px solid var(--line2);vertical-align:top} tr:last-child td{border-bottom:none}
tbody tr:hover{background:#faf9f5}
.design{margin-bottom:14px} .design>h4{margin-bottom:8px}
.dpair{display:grid;grid-template-columns:1fr 1fr;gap:12px;max-width:640px}
.dpair a{display:block} .dpair img{width:100%;max-height:170px;object-fit:cover;object-position:top;border-radius:8px;border:1px solid var(--line);background:#fff;display:block}
.dpair span{display:block;font-size:10.5px;color:var(--ink3);margin-top:4px}
.dmiss{border:1px dashed var(--line);border-radius:8px;display:grid;place-items:center;min-height:80px;font-size:11px;color:var(--ink3);padding:10px;text-align:center;background:repeating-linear-gradient(45deg,#f1efe9 0 8px,#eceae3 8px 16px)}
@media (max-width:940px){
  .shell{flex-direction:column}
  aside{position:static;width:100%;height:auto;flex-direction:row;align-items:center;flex-wrap:wrap;gap:10px;padding:12px 16px}
  .brand{border:0;padding:0} .brand img{margin:0 10px 0 0;display:inline-block;vertical-align:middle}
  #snav{flex-direction:row;flex-wrap:wrap;padding:0;overflow:visible} #snav a .k{display:none}
  .sidefoot{display:none}
  .kpis{grid-template-columns:1fr 1fr} .kpi.hero{grid-column:1/-1}
  .telgrid,.jgrid,.dgrid,.dpair,.ovgrid,.archfoot{grid-template-columns:minmax(0,1fr)}
  .lane{grid-template-columns:1fr}
  summary.irow{grid-template-columns:4px minmax(0,1fr) auto} .iid{display:none}
  .icdb{padding-left:22px}
  .pnote{margin-left:0}
}
@media (max-width:640px){
  #snav{flex:1 1 100%;flex-wrap:nowrap;overflow-x:auto;width:100%;scrollbar-width:none;-webkit-overflow-scrolling:touch} #snav::-webkit-scrollbar{display:none}
  #snav a{flex:none}
  .pdiv{display:none}
}
@media (prefers-reduced-motion:reduce){html{scroll-behavior:auto}*{transition:none!important}}
</style></head><body>
<div class="shell">
<aside>
  <div class="brand">
    <img src="data:image/png;base64,${LOGO_B64}" alt="FORGE">
    <div class="proj"><b>${esc(cfg.project)}</b>${esc(cfg.phase)} phase · v${VERSION}</div>
    ${actM ? `<span class="phase">${esc(actM)} active</span>` : ''}${autopilotCfg(cfg).on ? (apStop ? ` <span class="phase apstop" title="${esc(apStop.reason)}">autopilot stopped</span>` : ` <span class="phase ap" title="forge autopilot status">autopilot on</span>`) : ''}
  </div>
  <nav id="snav">
    <a href="#/overview" data-p="overview">Overview</a>
    <a href="#/plan" data-p="plan">Plan <span class="k">${counts.DONE}/${total}</span></a>
    <a href="#/architecture" data-p="architecture">Architecture <span class="k">${archCount ? (archDraft ? `${archCount} · ${archDraft} draft` : archCount) : '—'}</span></a>
    <a href="#/screens" data-p="screens">Screens &amp; mockups <span class="k">${screenCount || '—'}</span></a>
    <a href="#/usage" data-p="usage">Usage</a>
    <a href="#/journal" data-p="journal">Journal <span class="k">${decisions.length + discoveries.length}</span></a>
    <a href="#/specs" data-p="specs">Specs <span class="k">${specCount || ''}</span></a>
    <a href="#/configuration" data-p="configuration">Configuration${gpD.length ? ' <span class="k warnk">graphify</span>' : ''}</a>
    <a href="#/commands" data-p="commands">Commands</a>
    <a href="#/system" data-p="system">System${standardsAll && standardsMet < standardsAll ? ` <span class="k warnk">upgrade ${standardsMet}/${standardsAll}</span>` : ''}</a>
  </nav>
  <div class="sidefoot"><b>Generated projection.</b><br>State wins — never edit this file.<br>regenerated <span data-since="${new Date().toISOString()}" data-post=" ago">just now</span> · ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC</div>
</aside>
<main><div class="wrap">

<section class="page" data-page="overview" id="overview">
  <div class="tophead">
    <h1>${esc(cfg.project)} — where things stand</h1>
    <div class="stamp">auto-updates on every change · refresh: <code>forge dashboard</code><br>Verify: ${Object.keys(cfg.verify || {}).length ? Object.keys(cfg.verify).map(esc).join(', ') : 'not set'} · Graphify: ${esc((cfg.options || {}).graphify || 'unset')}</div>
  </div>
  ${bannerBlock}
  ${kpiBlock}
  <div class="ovgrid">${nowBlock}${releaseBlock}</div>
  ${railBlock}
</section>

<section class="page" data-page="plan" id="plan" hidden>
  <div class="phead"><h2>Plan</h2><span class="mut">releases → milestones → tasks, in the order they are built · click any task for its full story</span></div>
  ${outcomesBlock}
  ${paceBlock}
  <div class="telgrid one" style="margin-top:12px">${timePanelOut}</div>
  <div class="workbar" style="margin-top:22px">
  <input class="filter" id="wgfilter" type="search" placeholder="Filter items… (id, title, component, status)" aria-label="Filter work items">
  <div class="seg" id="wgseg" role="group" aria-label="Quick filters"><button class="on" data-f="all">All<span class="n"></span></button><button data-f="needs">Needs me<span class="n"></span></button><button data-f="active">Active<span class="n"></span></button><button data-f="done">Done<span class="n"></span></button></div>
  <span class="compfilter" id="wgcomp" hidden>Showing work for <b></b> <button type="button" aria-label="Clear">✕</button></span>
  </div>
  <p class="noresult" id="wgnone" hidden></p>
  <div id="work">${milestoneBlocks || '<p class="mut">No work items yet.</p>'}</div>
</section>

<section class="page" data-page="architecture" id="architecture" hidden>
  <div class="phead"><h2>Architecture</h2><span class="mut">what the system is made of, where each part runs, who talks to whom</span>
    ${archCount ? `<div class="seg" id="archseg" style="margin-left:auto"><button class="on" data-v="diagram">Diagram</button><button data-v="list">List</button></div>` : ''}</div>
  ${archBlock}
</section>

<section class="page" data-page="screens" id="screens" hidden>
  <div class="phead"><h2>Screens &amp; mockups</h2><span class="mut">the screens of each app and their approved mocks — tasks tagged with a screen show intended vs built</span></div>
  ${screensBlock}
</section>

<section class="page" data-page="usage" id="usage" hidden>
  <div class="phead"><h2>Usage</h2><span class="mut">tokens and model calls, observed from session logs — never estimated</span></div>
  ${usagePanelOut}
</section>

<section class="page" data-page="journal" id="journal" hidden>
  <div class="phead"><h2>Journal</h2><span class="mut">decisions bind the product · discoveries change the plan — latest first</span></div>
  <div class="jgrid">
  <div class="jcol"><h3>Decisions</h3>${logBlock(decisions, 'None recorded yet.')}</div>
  <div class="jcol"><h3>Discoveries</h3>${logBlock(discoveries, 'None recorded yet.')}</div>
  </div>
</section>

<section class="page" data-page="specs" id="specs" hidden>
  <div class="phead"><h2>Specs</h2><span class="mut">what the application must do — the source of intent the plan is cut from. How Forge and the development setup are configured is under <a href="#/configuration">Configuration</a>.</span></div>
  ${specRows ? `<h3 class="h3s">Specification <span class="mut">(${esc(cfg.specDir)}/)</span></h3>
  <div class="tblwrap"><table><thead><tr><th>File</th><th>Size</th><th>Modified</th></tr></thead><tbody>${specRows}</tbody></table></div>` : `<p class="mut">No spec folder configured${cfg.specDir ? ` (${esc(cfg.specDir)}/ not found)` : ''}.</p>`}
</section>

<section class="page" data-page="configuration" id="configuration" hidden>
  <div class="phead"><h2>Configuration</h2><span class="mut">how Forge and the development setup are configured for this project — not the application</span></div>
  ${configPage}
</section>

<section class="page" data-page="commands" id="commands" hidden>
  <div class="phead"><h2>Commands</h2><span class="mut">Forge's commands and what each is for</span></div>
  ${commandsPage}
</section>

<section class="page" data-page="system" id="system" hidden>
  <div class="phead"><h2>System</h2><span class="mut">plan standards · preflight · baseline · change scripts — the plumbing</span></div>
  ${standardsBlock ? `<h3 class="h3s">Plan standards <span class="mut">— ${standardsMet}/${standardsAll} met for Forge v${VERSION}${standardsMet < standardsAll ? ' · <code>forge upgrade</code> shows how to close the rest' : ''}</span></h3><div class="syscard">${standardsBlock}</div>` : ''}
  <div class="jgrid" style="margin-top:18px">
  <div><h3 class="h3s">Preflight ${pf ? `<span class="mut">${esc(pf.ts.slice(0, 16).replace('T', ' '))} · <span data-since="${esc(pf.ts)}" data-post=" ago"></span> — rerun with <code>forge preflight</code></span>` : ''}</h3>
  <div class="syscard">${pfBlock}</div></div>
  <div><h3 class="h3s">Baseline ${base ? `<span class="mut">${esc(base.ts.slice(0, 16).replace('T', ' '))} · a recorded moment, not a live check</span>` : ''}</h3>
  <div class="syscard">${baseBlock}</div></div>
  </div>
  ${changeRows ? `<h3 class="h3s" style="margin-top:18px">Plan change scripts <span class="mut">(forge/changes/ — re-cuts and Forge upgrades, newest first)</span></h3>
  <div class="tblwrap"><table><thead><tr><th>File</th><th>Size</th><th>Modified</th></tr></thead><tbody>${changeRows}</tbody></table></div>` : ''}
  <p class="mut" style="margin-top:18px">Settings and what they do: <a href="#/configuration">Configuration</a> · commands: <a href="#/commands">Commands</a></p>
</section>

</div></main>
</div>
<div class="docscrim" id="docscrim"></div>
<aside class="docpanel" id="docpanel" role="dialog" aria-modal="true" aria-labelledby="doctitle" aria-hidden="true">
  <div class="dochead">
    <div><h3 id="doctitle">Document</h3><div class="p" id="docpath"></div></div>
    <div class="docacts">
      <a class="docbtn" id="docopenfile" href="#" target="_blank" rel="noopener">Open file</a>
      <a class="docbtn" id="docdownload" href="#" download>Download</a>
      <a class="docbtn" id="docfolder" href="#" target="_blank" rel="noopener">Open folder</a>
      <button class="docbtn x" id="docclose" aria-label="Close">✕</button>
    </div>
  </div>
  <div class="docbody" id="docbody" tabindex="-1"></div>
</aside>
<script type="application/json" id="docdata">${JSON.stringify(docs).replace(/</g, '\\u003c')}</script>
<script>
/* v0.15.2: durations are computed in the browser from embedded ISO timestamps,
   so an open dashboard keeps telling the truth between CLI calls. */
(function(){
  function human(ms){
    if(ms<0)ms=0; var s=ms/1000;
    if(s<90)return Math.round(s)+'s';
    var m=s/60; if(m<90)return Math.round(m)+'m';
    var h=m/60; if(h<36)return (h<10?h.toFixed(1):Math.round(h))+'h';
    var d=h/24; return (d<10?d.toFixed(1):Math.round(d))+' days';
  }
  function tick(){
    var now=Date.now();
    document.querySelectorAll('[data-since]').forEach(function(el){
      var t=Date.parse(el.getAttribute('data-since'));
      if(!isFinite(t))return;
      el.textContent=(el.getAttribute('data-pre')||'')+human(now-t)+(el.getAttribute('data-post')||'');
    });
  }
  tick(); setInterval(tick,30000);
})();
(function(){
  var i=document.getElementById('wgfilter'), seg=document.getElementById('wgseg'),
      none=document.getElementById('wgnone');
  if(!i) return;
  var mode='all', comp=null, chip=document.getElementById('wgcomp');
  var groups=[].slice.call(document.querySelectorAll('details.sec.sub'));
  /* "Needs me" is the human's queue: an item blocked on your answer, and every
     item of a milestone whose gate is waiting for your review — the gate IS the
     thing that needs you. "Active" is work in flight plus what is still open in
     the milestone currently being built. */
  function matches(r, gate){
    var s=r.getAttribute('data-s')||'';
    if(mode==='all') return true;
    if(mode==='needs') return s==='BLOCKED'||gate==='awaiting';
    if(mode==='active') return s==='IN_PROGRESS'||s==='READY'||
      (r.getAttribute('data-act')==='1'&&s!=='DONE'&&s!=='CANCELLED');
    if(mode==='done') return s==='DONE';
    return true;
  }
  var EMPTY={
    needs:'Nothing needs you right now — no item is blocked and no milestone is waiting for your review.',
    active:'No work is in flight — nothing is in progress and nothing is open in the current milestone.',
    done:'Nothing is finished yet.',
    all:'No work items yet.'
  };
  function apply(){
    var q=i.value.toLowerCase(), narrowed=!!q||mode!=='all'||!!comp, total=0;
    groups.forEach(function(d){
      var gate=d.getAttribute('data-gate')||'', n=0;
      d.querySelectorAll('details.icd').forEach(function(r){
        var hit=matches(r,gate)&&(!q||r.textContent.toLowerCase().indexOf(q)>=0)&&
          (!comp||r.getAttribute('data-comp')===comp||r.getAttribute('data-arch')===comp);
        r.style.display=hit?'':'none'; if(hit)n++;
      });
      total+=n;
      var c=d.querySelector('.mcount');
      if(c) c.textContent=narrowed&&n?('· '+n+' shown'):'';
      if(narrowed){ if(d.dataset.wasOpen===undefined){ d.dataset.wasOpen=d.open?'1':'0'; } d.open=n>0; d.style.display=n?'':'none'; }
      else { d.style.display=''; if(d.dataset.wasOpen!==undefined){ d.open=d.dataset.wasOpen==='1'; delete d.dataset.wasOpen; } }
    });
    if(none){
      var show=narrowed&&!total;
      none.hidden=!show;
      none.textContent=show?(q?('Nothing matches “'+i.value+'”.'):comp?('No work is tagged to '+comp+'.'):EMPTY[mode]):'';
    }
  }
  /* v0.19: #/plan/c:<id> narrows the plan to one architecture part (its screens' work
     included) or one screen/tag */
  window.forgePlan={setComp:function(id){
    comp=id||null;
    if(chip){ chip.hidden=!comp; var b=chip.querySelector('b'); if(b) b.textContent=comp||''; }
    apply();
  }};
  if(chip) chip.querySelector('button').addEventListener('click',function(){ location.hash='#/plan'; });
  /* counts use the same predicate the filter uses, so a button can never promise
     items the filter would not show */
  function counts(){
    if(!seg) return;
    var saved=mode;
    [].forEach.call(seg.children,function(b){
      mode=b.getAttribute('data-f');
      var n=0;
      groups.forEach(function(d){
        var gate=d.getAttribute('data-gate')||'';
        d.querySelectorAll('details.icd').forEach(function(r){ if(matches(r,gate)) n++; });
      });
      var sp=b.querySelector('.n'); if(sp) sp.textContent=n;
    });
    mode=saved;
  }
  i.addEventListener('input',apply);
  if(seg) seg.addEventListener('click',function(e){
    var b=e.target&&e.target.closest?e.target.closest('button'):null; if(!b)return;
    mode=b.getAttribute('data-f');
    [].forEach.call(seg.children,function(x){ x.classList.toggle('on',x===b); });
    apply();
  });
  counts();
})();

/* v0.15.3: read a brief or a spec file in place. The text is embedded (a file://
   page cannot fetch its siblings), rendered with a small Markdown pass, and the
   original file stays one click away. */
(function(){
  var el=document.getElementById('docdata'); if(!el) return;
  var DOCS={}; try{ DOCS=JSON.parse(el.textContent||'{}'); }catch(e){}
  var panel=document.getElementById('docpanel'), scrim=document.getElementById('docscrim'),
      body=document.getElementById('docbody'), title=document.getElementById('doctitle'),
      pathEl=document.getElementById('docpath'), openF=document.getElementById('docopenfile'),
      dl=document.getElementById('docdownload'), folder=document.getElementById('docfolder'),
      closeB=document.getElementById('docclose'), lastFocus=null;
  function esc(t){ return t.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
  function inline(t){
    return t
      .replace(/\`([^\`]+)\`/g,function(m,c){ return '<code>'+c+'</code>'; })
      .replace(/\\*\\*([^*]+)\\*\\*/g,'<b>$1</b>')
      .replace(/(^|[\\s(])\\*([^*\\n]+)\\*/g,'$1<i>$2</i>')
      .replace(/(^|[\\s(])_([^_\\n]+)_/g,'$1<i>$2</i>')
      .replace(/\\[([^\\]]+)\\]\\(([^)\\s]+)\\)/g,'<a href="$2">$1</a>');
  }
  function md(src){
    var lines=esc(src).split('\\n'), out=[], k=0, fence=null, list=null;
    function endList(){ if(list){ out.push('</'+list+'>'); list=null; } }
    for(;k<lines.length;k++){
      var l=lines[k];
      if(/^\\s*\`\`\`/.test(l)){
        if(fence===null){ endList(); fence=''; out.push('<pre><code>'); } else { out.push('</code></pre>'); fence=null; }
        continue;
      }
      if(fence!==null){ out.push(l+'\\n'); continue; }
      if(/^\\s*$/.test(l)){ endList(); continue; }
      if(/^\\s*(---+|\\*\\*\\*+|___+)\\s*$/.test(l)){ endList(); out.push('<hr>'); continue; }
      var h=l.match(/^(#{1,6})\\s+(.*)$/);
      if(h){ endList(); var n=Math.min(h[1].length,4); out.push('<h'+n+'>'+inline(h[2])+'</h'+n+'>'); continue; }
      var q=l.match(/^\\s*&gt;\\s?(.*)$/);
      if(q){ endList(); out.push('<blockquote>'+inline(q[1])+'</blockquote>'); continue; }
      var ul=l.match(/^\\s*[-*+]\\s+(.*)$/);
      if(ul){ if(list!=='ul'){ endList(); out.push('<ul>'); list='ul'; } out.push('<li>'+inline(ul[1])+'</li>'); continue; }
      var ol=l.match(/^\\s*\\d+[.)]\\s+(.*)$/);
      if(ol){ if(list!=='ol'){ endList(); out.push('<ol>'); list='ol'; } out.push('<li>'+inline(ol[1])+'</li>'); continue; }
      endList(); out.push('<p>'+inline(l)+'</p>');
    }
    if(fence!==null) out.push('</code></pre>');
    endList();
    return out.join('');
  }
  function openDoc(key, fileHref){
    var d=DOCS[key]; if(!d) return;
    lastFocus=document.activeElement;
    title.textContent=d.title||key;
    pathEl.textContent=d.rel||'';
    var href=fileHref||('../'+d.rel);
    openF.href=href; dl.href=href;
    dl.setAttribute('download',(d.rel||'document').split('/').pop());
    folder.href=href.replace(/[^/]+$/,'');
    body.innerHTML=d.text==null
      ? '<p class="docmiss">This file is '+Math.round((d.size||0)/1024)+' KB — too large to embed in the dashboard. Open it directly with the buttons above.</p>'
      : md(d.text);
    body.scrollTop=0;
    panel.classList.add('on'); scrim.classList.add('on');
    panel.setAttribute('aria-hidden','false');
    body.focus();
  }
  function closeDoc(){
    panel.classList.remove('on'); scrim.classList.remove('on');
    panel.setAttribute('aria-hidden','true');
    if(lastFocus&&lastFocus.focus) lastFocus.focus();
  }
  document.addEventListener('click',function(e){
    var t=e.target&&e.target.closest?e.target.closest('.docopen'):null;
    if(!t) return;
    e.preventDefault(); e.stopPropagation();
    openDoc(t.getAttribute('data-doc'), t.getAttribute('data-file')||null);
  });
  closeB.addEventListener('click',closeDoc);
  scrim.addEventListener('click',closeDoc);
  document.addEventListener('keydown',function(e){ if(e.key==='Escape'&&panel.classList.contains('on')) closeDoc(); });
})();
/* v0.21: click a configuration command to copy it (works opened from disk; falls back to a selection copy) */
(function(){
  document.addEventListener('click',function(e){
    var c=e.target&&e.target.closest?e.target.closest('code.copyable'):null; if(!c) return;
    var txt=c.textContent, done=function(){ c.classList.add('copied'); setTimeout(function(){ c.classList.remove('copied'); },900); };
    var fallback=function(){ try{ var r=document.createRange(); r.selectNodeContents(c); var sel=window.getSelection(); sel.removeAllRanges(); sel.addRange(r); document.execCommand('copy'); sel.removeAllRanges(); done(); }catch(_){} };
    if(navigator.clipboard&&navigator.clipboard.writeText) navigator.clipboard.writeText(txt).then(done,fallback); else fallback();
  });
})();
/* v0.19: one page at a time. The side menu switches pages; the hash is the address
   (#/plan/<item or milestone>, #/plan/c:<part or screen>, #/architecture/<part>),
   so links, the back button and bookmarks work. Old #anchors still land. */
(function(){
  var LEGACY={overview:'overview',milestones:'overview',work:'plan',map:'architecture',telemetry:'usage',journal:'journal',system:'system'};
  var pages=[].slice.call(document.querySelectorAll('section.page'));
  var links=[].slice.call(document.querySelectorAll('#snav a'));
  function show(name){
    var hit=false;
    pages.forEach(function(p){ var on=p.getAttribute('data-page')===name; p.hidden=!on; if(on)hit=true; });
    if(!hit){ name='overview'; pages.forEach(function(p){ p.hidden=p.getAttribute('data-page')!=='overview'; }); }
    links.forEach(function(a){ a.classList.toggle('on', a.getAttribute('data-p')===name); });
    var nav=document.getElementById('snav'), on=nav&&nav.querySelector('a.on');
    if(on&&nav.scrollWidth>nav.clientWidth+1) nav.scrollLeft=Math.max(0,on.offsetLeft-(nav.clientWidth-on.offsetWidth)/2);
    return name;
  }
  function focusEl(el){
    if(!el) return;
    var d=el; while(d){ if(d.tagName==='DETAILS') d.open=true; d=d.parentElement; }
    el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash');
    setTimeout(function(){ el.scrollIntoView({block:'start'}); window.scrollBy(0,-12); }, 30);
  }
  function route(){
    var h=location.hash||'';
    var m=h.match(/^#\\/([\\w-]+)(?:\\/(.*))?$/);
    var page, arg=null;
    if(m){ page=m[1]; arg=m[2]?decodeURIComponent(m[2]):null; }
    else { page=LEGACY[h.replace(/^#/,'')]||'overview'; }
    page=show(page);
    if(page==='plan'){
      if(window.forgePlan) window.forgePlan.setComp(arg&&arg.indexOf('c:')===0?arg.slice(2):null);
      if(arg&&arg.indexOf('c:')!==0){
        var el=document.getElementById('it-'+arg)||document.querySelector('details.sec.sub[data-m="'+(window.CSS&&CSS.escape?CSS.escape(arg):arg)+'"]');
        focusEl(el); return;
      }
    }
    if(page==='architecture'&&window.forgeArch){ window.forgeArch.draw(); if(arg) window.forgeArch.select(arg); }
    window.scrollTo(0,0);
  }
  window.addEventListener('hashchange',route);
  /* run after every script on the page has defined its hooks */
  if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',route); else setTimeout(route,0);
  window.addEventListener('load',function(){ if(window.forgeArch) window.forgeArch.draw(); });
})();

/* v0.19: the architecture drawing — cards are laid out by the generator; here we only
   measure them and draw orthogonal arrows between them. */
(function(){
  var el=document.getElementById('archdata'); if(!el) return;
  var D={}; try{ D=JSON.parse(el.textContent||'{}'); }catch(e){ return; }
  var wrapEl=document.getElementById('archdiagram'), box=document.getElementById('archbox'), svg=document.getElementById('archsvg'), sel=document.getElementById('archsel');
  var list=document.getElementById('archlist'), seg=document.getElementById('archseg');
  var NS='http://www.w3.org/2000/svg';
  function card(id){ return box.querySelector('.acard[data-c="'+id+'"]'); }
  function esc(t){ return String(t==null?'':t).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
  function mk(tag,attrs){ var n=document.createElementNS(NS,tag); for(var k in attrs) n.setAttribute(k,attrs[k]); return n; }
  function draw(){
    if(!box||box.offsetParent===null) return;
    var B=box.getBoundingClientRect();
    svg.setAttribute('width',B.width); svg.setAttribute('height',B.height);
    svg.innerHTML='';
    var defs=mk('defs',{});
    defs.appendChild((function(){ var m=mk('marker',{id:'ah',viewBox:'0 0 10 10',refX:'9',refY:'5',markerWidth:'7',markerHeight:'7',orient:'auto-start-reverse'}); m.appendChild(mk('path',{d:'M0,0 L10,5 L0,10 z',fill:'#6b7080'})); return m; })());
    svg.appendChild(defs);
    var R={}; [].forEach.call(box.querySelectorAll('.acard'),function(c){ var r=c.getBoundingClientRect(); R[c.getAttribute('data-c')]={x:r.left-B.left,y:r.top-B.top,w:r.width,h:r.height}; });
    // spread arrow ports along each side so parallel arrows do not overlap
    var ports={};
    (D.edges||[]).forEach(function(e,i){
      var a=R[e.from], b=R[e.to]; if(!a||!b) return;
      var down=b.y>a.y+a.h/2, up=b.y+b.h<a.y+a.h/2;
      e._sa=down?'b':up?'t':'b'; e._sb=down?'t':up?'b':'b'; e._same=!down&&!up;
      (ports[e.from+e._sa]=ports[e.from+e._sa]||[]).push({e:e,end:'a',o:b});
      (ports[e.to+e._sb]=ports[e.to+e._sb]||[]).push({e:e,end:'b',o:a});
    });
    Object.keys(ports).forEach(function(k){
      var ps=ports[k]; ps.sort(function(p,q){ return (p.o.x+p.o.w/2)-(q.o.x+q.o.w/2) || (p.o.y-q.o.y); });
      ps.forEach(function(p,i){ p.e['_f'+p.end]=(i+1)/(ps.length+1); });
    });
    // lane rects give each gap's top and bottom; arrows in a gap get evenly spaced tracks
    var L={}; [].forEach.call(box.querySelectorAll('.lane'),function(l){ var r=l.getBoundingClientRect(); L[l.getAttribute('data-li')]={top:r.top-B.top,bottom:r.bottom-B.top}; });
    function pt(r,side,f){ f=f==null?.5:(.3+.4*f);
      if(side==='b') return [r.x+r.w*f, r.y+r.h]; if(side==='t') return [r.x+r.w*f, r.y];
      if(side==='r') return [r.x+r.w, r.y+r.h*f]; return [r.x, r.y+r.h*f]; }
    var byGap={};
    (D.edges||[]).forEach(function(e){ var a=R[e.from], b=R[e.to]; if(!a||!b) return; e._s=pt(a,e._sa,e._fa); e._t=pt(b,e._sb,e._fb); if(e.g!=null)(byGap[e.g]=byGap[e.g]||[]).push(e); });
    Object.keys(byGap).forEach(function(g){
      var es=byGap[g], top=(L[g]||{}).bottom, bot=(L[+g+1]||{}).top; if(top==null||bot==null) return;
      es.sort(function(p,q){ return Math.min(p._s[0],p._t[0])-Math.min(q._s[0],q._t[0]); });
      var step=es.length>1?(bot-top-20)/(es.length-1):0;
      es.forEach(function(e,i){ e._y=es.length>1?top+10+i*step:(top+bot)/2; });
    });
    var seen={};
    (D.edges||[]).forEach(function(e){
      if(!e._s) return;
      var s=e._s, t=e._t, d, lx, ly, anchor='middle';
      if(e._y!=null){
        if(Math.abs(s[0]-t[0])<3){ d='M'+s[0]+','+s[1]+' L'+t[0]+','+t[1]; lx=s[0]+5; ly=e._y+4; anchor='start'; }
        else { d='M'+s[0]+','+s[1]+' L'+s[0]+','+e._y+' L'+t[0]+','+e._y+' L'+t[0]+','+t[1]; lx=(s[0]+t[0])/2; ly=e._y-3; }
      } else { /* same lane: under the cards, in the lane's bottom padding */ var yy=Math.max(s[1],t[1])+16; d='M'+s[0]+','+s[1]+' L'+s[0]+','+yy+' L'+t[0]+','+yy+' L'+t[0]+','+t[1]; lx=(s[0]+t[0])/2; ly=yy-3; }
      var g=mk('g',{'class':'aedge'+(e.planned?' planned':'')+(e.confirmed?'':' draft'),'data-from':e.from,'data-to':e.to});
      g.appendChild(mk('path',{d:d,fill:'none','marker-end':'url(#ah)'}));
      /* one label per meaning: the same label into the same part, or out of the same part, is said once */
      var k1=e.to+'|'+e.label, k2=e.from+'|'+e.label;
      if(e.label&&!seen[k1]&&!seen[k2]){
        seen[k1]=seen[k2]=1;
        var tx=mk('text',{x:lx,y:ly,'text-anchor':anchor}); tx.textContent=e.label;
        g.appendChild(tx);
      }
      svg.appendChild(g);
    });
    // label halos after layout so text stays readable over lines
    [].forEach.call(svg.querySelectorAll('text'),function(tx){ try{ var bb=tx.getBBox(); var r=mk('rect',{x:bb.x-4,y:bb.y-1,width:bb.width+8,height:bb.height+2,rx:4,'class':'lbg'}); tx.parentNode.insertBefore(r,tx); }catch(e){} });
  }
  function select(id){
    var p=D.parts[id]; if(!p) return;
    [].forEach.call(box.querySelectorAll('.acard'),function(c){ c.classList.toggle('sel',c.getAttribute('data-c')===id); });
    [].forEach.call(svg.querySelectorAll('.aedge'),function(g){ var on=g.getAttribute('data-from')===id||g.getAttribute('data-to')===id; g.classList.toggle('hl',on); });
    var outs=(D.edges||[]).filter(function(e){return e.from===id;}).map(function(e){ return esc((D.parts[e.to]||{}).name||e.to)+(e.label?' <span class="mut">('+esc(e.label)+')</span>':'')+(e.planned?' <span class="mut">· planned</span>':''); });
    var ins=(D.edges||[]).filter(function(e){return e.to===id;}).map(function(e){ return esc((D.parts[e.from]||{}).name||e.from)+(e.label?' <span class="mut">('+esc(e.label)+')</span>':''); });
    var ev=(p.evidence||[]).map(function(v){ return '<code>'+esc(v.path)+'</code>'+(v.why?' <span class="mut">'+esc(v.why)+'</span>':''); });
    sel.innerHTML='<h4>Selected · '+esc(p.name)+(p.confirmed?'':' <span class="warn">draft</span>')+'</h4>'+
      '<div class="kv">'+
      '<div class="row"><span class="k">Runs on</span><span class="vl">'+esc(p.runsOn)+' · '+esc(p.kind)+'</span></div>'+
      (p.summary?'<div class="row"><span class="k">What</span><span class="vl">'+esc(p.summary)+'</span></div>':'')+
      '<div class="row"><span class="k">Talks to</span><span class="vl">'+(outs.join(', ')||'<span class="mut">—</span>')+'</span></div>'+
      '<div class="row"><span class="k">Called by</span><span class="vl">'+(ins.join(', ')||'<span class="mut">—</span>')+'</span></div>'+
      '<div class="row"><span class="k">Items</span><span class="vl">'+p.done+'/'+p.live+' done'+(p.run?' · '+p.run+' running':'')+'</span></div>'+
      (p.next?'<div class="row"><span class="k">Next</span><span class="vl"><a href="#/plan/'+encodeURIComponent(p.next)+'">'+esc(p.next)+'</a></span></div>':'')+
      (p.screens?'<div class="row"><span class="k">Screens</span><span class="vl"><a href="#/screens" data-scr="'+esc(id)+'">'+p.screens+' screen(s)</a></span></div>':'')+
      (ev.length?'<div class="row"><span class="k">Evidence</span><span class="vl">'+ev.join('<br>')+'</span></div>':'')+
      '</div>'+(p.live?'<a class="docbtn selbtn" href="#/plan/c:'+encodeURIComponent(id)+'">Show its work items</a>':'');
  }
  document.addEventListener('click',function(e){
    var c=e.target&&e.target.closest?e.target.closest('.acard,.alink'):null;
    if(c){ var id=c.getAttribute('data-c'); if(location.hash!=='#/architecture/'+id) history.replaceState(null,'','#/architecture/'+encodeURIComponent(id)); select(id); return; }
    var s=e.target&&e.target.closest?e.target.closest('a[data-scr]'):null;
    if(s){ e.preventDefault(); location.hash='#/screens'; setTimeout(function(){ var g=document.getElementById('scr-'+s.getAttribute('data-scr')); if(g) g.scrollIntoView({block:'start'}); },40); }
  });
  if(seg) seg.addEventListener('click',function(e){
    var b=e.target&&e.target.closest?e.target.closest('button'):null; if(!b) return;
    var v=b.getAttribute('data-v');
    [].forEach.call(seg.children,function(x){ x.classList.toggle('on',x===b); });
    wrapEl.hidden=v!=='diagram'; list.hidden=v!=='list'; if(v==='diagram') draw();
  });
  var t=null; window.addEventListener('resize',function(){ clearTimeout(t); t=setTimeout(draw,120); });
  window.forgeArch={draw:draw,select:select};
  var fc=box.querySelector('.acard'); if(fc) select(fc.getAttribute('data-c'));
})();

(function(){
  var f=document.getElementById('cmdfilter'); if(!f) return;
  f.addEventListener('input',function(){
    var q=f.value.toLowerCase();
    [].forEach.call(document.querySelectorAll('.cmdgroup'),function(g){
      var n=0; [].forEach.call(g.querySelectorAll('tr[data-q]'),function(r){ var hit=!q||r.getAttribute('data-q').indexOf(q)>=0; r.style.display=hit?'':'none'; if(hit)n++; });
      g.style.display=n?'':'none';
    });
  });
})();
(function(){
  var f=document.getElementById('scrfilter'); if(!f) return;
  f.addEventListener('input',function(){
    var q=f.value.toLowerCase();
    [].forEach.call(document.querySelectorAll('.sgroup'),function(g){
      var n=0; [].forEach.call(g.querySelectorAll('.scard'),function(c){ var hit=!q||c.getAttribute('data-q').indexOf(q)>=0; c.style.display=hit?'':'none'; if(hit)n++; });
      g.style.display=n?'':'none';
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
  // v0.21: Forge's own lock files come and go around a verify — they are not the work
  const porcelain = st.tail.split('\n').filter(l => !/forge\/state\/(verify|work)\.lock$/.test(l)).join('\n');
  return ((head.exit === 0 ? head.tail : 'NOHEAD') + '|' +
          crypto.createHash('sha1').update(porcelain).digest('hex')).slice(0, 80);
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
  // v0.15: provider failures (rate limit, outage, timeout) are the platform's
  // fault, not the approach's — they never count toward the escalation ladder.
  return item.attempts.filter(a => a.outcome === 'failed' && a.kind !== 'provider').length;
}

// v0.15: item-shape guard — field evidence: a 17-glob mega-item stalls
// workers, and a decision smuggled into criteria stalls the whole loop.
// Warnings, not refusals: brownfield graphs legitimately vary in shape.
function itemShapeWarnings(item) {
  const warns = [];
  const globs = ((item.scope || {}).allowed || []).length;
  if (globs > 8)
    warns.push(`scope has ${globs} allowed globs — items this wide stall workers (field evidence: a 17-glob item hit the watchdog). Prefer one item per surface.`);
  if ((item.criteria || []).length > 6)
    warns.push(`${item.criteria.length} acceptance criteria — a brief this heavy usually hides several items. Prefer decomposing before start.`);
  for (const c of (item.criteria || []))
    if (/\b(owner|user|human|product)\b[^.]*\b(decid\w+|choos\w+|choice)\b|\bdecide whether\b/i.test(c.desc || ''))
      warns.push(`criterion reads like a PRODUCT DECISION, not acceptance: "${c.desc}" — resolve it with the owner (forge decision add) BEFORE work starts; never delegate a decision to a worker.`);
  return warns;
}

// v0.15: same matcher semantics as the PreToolUse scope guard, for API workers.
function globMatch(rel, pattern) {
  const pat = String(pattern).replace(/\\/g, '/').replace(/^\.\//, '');
  if (!pat) return false;
  if (pat.endsWith('/')) return rel === pat.slice(0, -1) || rel.startsWith(pat);
  if (pat.includes('*')) {
    const re = new RegExp('^' + pat.split('*').map(s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[^]*') + '$');
    return re.test(rel);
  }
  return rel === pat || rel.startsWith(pat + '/');
}

// v0.16: resolve an item's allowed-scope globs into the actual files a worker
// will touch. Measured cause of waste: an implementer dispatch averaged 218 model
// calls, most of them re-discovering a file set the orchestrator already knew.
// Handing over the list turns exploration into reading.
function resolveScopeFiles(allowed, limit = 80) {
  const out2 = [];
  const skip = /(^|\/)(\.git|node_modules|dist|build|coverage|\.next|vendor)(\/|$)/;
  const walk = (rel, depth) => {
    if (out2.length >= limit || depth > 8) return;
    let ents = [];
    try { ents = fs.readdirSync(path.join(PROJECT, rel || '.'), { withFileTypes: true }); } catch (_) { return; }
    for (const e of ents) {
      if (out2.length >= limit) return;
      const r = (rel ? rel + '/' : '') + e.name;
      if (skip.test(r) || e.name.startsWith('.')) continue;
      if (e.isDirectory()) walk(r, depth + 1);
      else {
        let sz = 0; try { sz = fs.statSync(path.join(PROJECT, r)).size; } catch (_) { }
        out2.push({ rel: r, size: sz });
      }
    }
  };
  for (const g of (allowed || [])) {
    if (g === '**') return { files: [], truncated: false, wholeTree: true };
    const root = String(g).replace(/\\/g, '/').split('*')[0].replace(/\/$/, '');
    let st = null; try { st = fs.statSync(path.join(PROJECT, root)); } catch (_) { continue; }
    if (st.isDirectory()) walk(root, 0);
    else { out2.push({ rel: root, size: st.size }); }
  }
  const seen = new Set(); const files = [];
  for (const f of out2) if (!seen.has(f.rel)) { seen.add(f.rel); files.push(f); }
  return { files, truncated: files.length >= limit, wholeTree: false };
}

// v0.15: brief text factored out — 'forge brief' prints/saves it and API
// workers ('forge worker run') consume it directly.
function briefLines(item, cfg) {
  const lines = [];
  const bounded = sw(cfg, 'workerExplore') === 'bounded'; // v0.21 (C2)
  const readBudget = parseInt(((cfg || {}).options || {}).workerReadBudget, 10) || 10;
  lines.push(`# Work brief — ${item.id}: ${item.title}`);
  lines.push('', `## Objective`, item.objective || '(fill in)');
  lines.push('', `## Acceptance criteria (your work is verified against these — they are the definition of done)`);
  item.criteria.forEach((c, i) => lines.push(`${i + 1}. ${c.desc}${c.check ? `  — machine check: \`${c.check}\`` : '  — (no machine check; explain how you validated it)'}`));
  lines.push('', `## Scope`);
  lines.push(`Allowed to modify: ${item.scope.allowed.length ? item.scope.allowed.join(', ') : '(orchestrator: derive from the dependency closure — graphify affected "<symbol>" / graphify query when the graph is built)'}`);
  lines.push(`Must NOT touch: ${item.scope.forbidden.length ? item.scope.forbidden.join(', ') : '(orchestrator: fill in)'}`);
  // v0.16: the file list, resolved now, so the worker reads instead of searching
  {
    const sc = resolveScopeFiles(item.scope.allowed || []);
    if (sc.wholeTree) {
      lines.push('', `## Files in scope`, `This item is deliberately whole-tree — no file list can be given. Ask before reading widely.`);
    } else if (sc.files.length) {
      lines.push('', bounded
        ? `## Files in scope (${sc.files.length}${sc.truncated ? '+, truncated' : ''}) — start here`
        : `## Files in scope (${sc.files.length}${sc.truncated ? '+, truncated' : ''}) — this is the set; do not go looking for more`);
      for (const f of sc.files) lines.push(`- \`${f.rel}\`${f.size ? ` (${f.size < 1024 ? f.size + ' B' : Math.round(f.size / 1024) + ' KB'})` : ''}`);
      if (sc.truncated) lines.push(`- …the scope resolves to more files than listed. If the item genuinely needs all of them it is probably too big — say so.`);
    } else {
      lines.push('', `## Files in scope`, `The allowed scope resolves to no existing files — this is new-file work. Create only inside the allowed paths.`);
    }
  }
  // v0.21 (C2): context pack + design note, when the switches are on and the files exist
  const ctxFile = path.join(CONTEXT_DIR, `${item.id}.md`);
  if (sw(cfg, 'contextPack') && fs.existsSync(ctxFile))
    lines.push('', `## Context pack`, `Read \`forge/context/${item.id}.md\` first — the relevant files, patterns to follow, invariants this change must keep, the spec sections, decisions and domain rules, assembled for this task.`);
  if (sw(cfg, 'architectPrepass') && fs.existsSync(ctxFile)) {
    const note = (fs.readFileSync(ctxFile, 'utf8').match(/^## Design note[\s\S]*?(?=^## |(?![\s\S]))/m) || [])[0];
    if (note) lines.push('', note.trim());
  }
  if (bounded) {
    lines.push('', `## How to work`,
      `- Read freely inside the allowed scope — the files above and anything else under the allowed paths.`,
      `- You may read up to ${readBudget} files OUTSIDE the allowed scope when you need context (callers, types, conventions). List every out-of-scope file you read in your report.`,
      ...(((cfg.options || {}).graphify === 'use' && fs.existsSync(path.join(PROJECT, 'graphify-out', 'graph.json')))
        ? [`- For a question about code outside the scope (who calls this, what does that depend on), ask the code graph first: \`graphify query "<question>"\`, \`graphify explain "<symbol>"\`, \`graphify path "<A>" "<B>"\`.`] : []),
      `- You decide HOW: the brief says what must be true and how it is checked, not how to write it.`,
      `- Make the change, then run the verification commands below. Iterate on failures.`,
      `- STOP and report only for a scope change (you need to MODIFY a file outside the allowed scope) or a product question the spec does not answer.`);
  } else {
    lines.push('', `## How to work (this is what keeps the item cheap and fast)`,
      `- Read the files listed above FIRST. They are the working set.`,
      `- Do not search or scan the repository. If you believe you need a file that is not listed, STOP and report which one and why — that is a scope question for the orchestrator, not something to resolve by exploring.`,
      ...(((cfg.options || {}).graphify === 'use' && fs.existsSync(path.join(PROJECT, 'graphify-out', 'graph.json')))
        ? [`- The files above are your working set — read them directly. For a question about code OUTSIDE that set (who calls this, what does that depend on), ask the code graph instead of searching: \`graphify query "<question>"\`, \`graphify explain "<symbol>"\`, \`graphify path "<A>" "<B>"\`. Each answer is a small scoped subgraph.`] : []),
      `- Make the change, then run the verification commands below. Iterate on failures; do not re-read files you have already read.`,
      `- If you find yourself unsure what to do next, STOP and report. A question costs one message; guessing costs an hour.`);
  }
  lines.push('', `## Project verification commands (will be run on your result)`);
  Object.entries(cfg.verify || {}).forEach(([k, v]) => lines.push(`- ${k}: \`${v}\``));
  // provider failures carry no approach diagnosis — only real failed attempts inform the retry
  const fails = item.attempts.filter(a => a.outcome === 'failed' && a.kind !== 'provider');
  if (fails.length) {
    lines.push('', `## Previous failed attempts — do not repeat these approaches`);
    fails.forEach(a => lines.push(`- ${a.ts}: ${a.note}`));
  }
  lines.push('', `## Rules`,
    `- Stay inside the allowed scope. If correctness requires touching excluded areas, STOP and report — do not expand scope yourself.`,
    `- If the spec does not answer a question you need answered, STOP and report the hole — never invent product behavior.`,
    `- Report back: summary, files changed, tests run and results, discoveries, open questions.`);
  // v0.21 (C4): tasks tagged with --domain carry their domain packs' rules
  const packs = packsFor(item);
  if (packs.length) {
    lines.push('', `## Domain rules (${packs.map(p => p.replace(/\.md$/, '')).join(', ')})`);
    for (const p of packs) {
      let t = ''; try { t = fs.readFileSync(path.join(PACKS_DIR, p), 'utf8'); } catch (_) { continue; }
      lines.push('', t.replace(/^# .*\n+/, '').replace(/^(Include in|Include in ANY)[^\n]*\n(?:[^\n#][^\n]*\n)*/m, '').trim().replace(/^## /gm, '### '));
    }
  }
  lines.push('', sw(cfg, 'contextPack')
    ? `_Orchestrator: say WHAT must be true and how it is checked. Investigation goes in the context pack (forge brief ${item.id} --context); no line numbers or code-level fix lists here._`
    : `_Orchestrator: prepend relevant spec excerpts, decisions, and the applicable domain pack before dispatching._`);
  return lines;
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

// v0.16.2: milestones are records, not just labels. w.milestones holds one record
// per milestone (id, name = the feature it enables, demo) and w.milestoneOrder is
// the explicit sequence — so milestones can be reordered for business reasons
// without re-adding items. Projects from before v0.16.2 carry only labels: they
// are migrated lazily, in their old first-appearance order, as UNNAMED records.
// Readers migrate in memory; the first mutating command persists it.
function ensureMilestones(w) {
  if (!w.milestones) w.milestones = {};
  if (!Array.isArray(w.milestoneOrder)) w.milestoneOrder = [];
  for (const id of w.order || []) {
    const m = (w.items[id] || {}).milestone;
    if (m && !w.milestones[m]) w.milestones[m] = { id: m, name: null, demo: null, unnamed: true, created: ts(), history: [] };
    if (m && !w.milestoneOrder.includes(m)) w.milestoneOrder.push(m);
  }
  for (const m of Object.keys(w.milestones)) if (!w.milestoneOrder.includes(m)) w.milestoneOrder.push(m);
  // v0.18: releases group milestones; the milestone sequence is always grouped by
  // release (release order first, then milestone order inside it; unassigned last)
  if (!w.releases) w.releases = {};
  if (!Array.isArray(w.releaseOrder)) w.releaseOrder = [];
  for (const r of Object.keys(w.releases)) if (!w.releaseOrder.includes(r)) w.releaseOrder.push(r);
  if (w.releaseOrder.length) {
    const ri = r => { const i = w.releaseOrder.indexOf(r); return i < 0 ? 1e6 : i; };
    const pos = new Map(w.milestoneOrder.map((m, i) => [m, i]));
    w.milestoneOrder.sort((a, b) => ri((w.milestones[a] || {}).release) - ri((w.milestones[b] || {}).release) || pos.get(a) - pos.get(b));
  }
  // v0.18: an explicit task order per milestone — initialised in dependency order
  for (const m of w.milestoneOrder) ensureTaskOrder(w, m);
  return w.milestoneOrder;
}
// Per-milestone task order. New items are placed after every in-milestone item they
// depend on (dependency-first), otherwise at the end; removed/moved items drop out.
function ensureTaskOrder(w, m) {
  const rec = w.milestones[m]; if (!rec) return [];
  const mine = (w.order || []).filter(id => w.items[id].milestone === m);
  const set = new Set(mine);
  let order = Array.isArray(rec.taskOrder) ? rec.taskOrder.filter(id => set.has(id)) : [];
  const missing = mine.filter(id => !order.includes(id));
  if (missing.length) {
    // topological insertion for the missing ones, stable on their original order
    const placed = new Set(order);
    let guard = 0;
    while (missing.length && guard++ < 10000) {
      const i = missing.findIndex(id => (w.items[id].deps || []).every(d => !set.has(d) || placed.has(d) || !missing.includes(d)));
      const id = missing.splice(i < 0 ? 0 : i, 1)[0];
      order.push(id); placed.add(id);
    }
  }
  rec.taskOrder = order;
  return order;
}
function releaseOf(w, m) { return ((w.milestones || {})[m] || {}).release || null; }

// v0.18: VERSION LABELS — computed from position, never identity. An item's id stays
// fixed (commits, deps, briefs and decisions cite it); its label (V0.3.2) is derived
// from release / milestone / task order and FREEZES once work starts, so history
// never renumbers. Everything not yet started renumbers when the plan is reordered.
function versionStart() {
  const v = parseInt((((readJson(CONFIG_FILE, {}) || {}).options) || {}).versionStart, 10);
  return Number.isFinite(v) ? v : 0;
}
function itemStarted(t) { return !!t && (['IN_PROGRESS', 'DONE'].includes(t.status) || (t.attempts || []).some(a => a.outcome === 'started')); }
function firstStartTs(t) { const a = (t.attempts || []).find(x => x.outcome === 'started'); return a ? Date.parse(a.ts) || 0 : Infinity; }
// Freeze what has started but carries no label yet. Runs at explicit moments only —
// 'task start', 'milestone approve' and 'release freeze' — never on a plain read, so a
// project can assign its releases BEFORE anything is frozen.
function freezeLabels(w) {
  ensureMilestones(w);
  const start = versionStart();
  const labels = computeLabels(w);
  for (const r of w.releaseOrder) {
    const rr = w.releases[r];
    if (rr && rr.num == null && w.milestoneOrder.some(m => releaseOf(w, m) === r && milestoneStarted(w, m))) rr.num = labels.release[r];
  }
  for (const m of w.milestoneOrder) {
    const mr = w.milestones[m];
    if (mr && !mr.label && milestoneStarted(w, m)) mr.label = labels.milestone[m];
    if (!mr || !mr.label) continue;
    // tasks that started without a label get the next numbers, in the order they started
    const started = (mr.taskOrder || []).map(id => w.items[id]).filter(t => itemStarted(t) && !t.label)
      .sort((a, b) => firstStartTs(a) - firstStartTs(b));
    for (const t of started) { mr.taskSeq = (mr.taskSeq || 0) + 1; t.label = `${mr.label}.${mr.taskSeq}`; }
  }
  void start;
}
// labels: { release: {id: number}, milestone: {id: 'V0.3'}, item: {id: 'V0.3.2'} }
function computeLabels(w) {
  ensureMilestones(w);
  const start = versionStart();
  const out = { release: {}, milestone: {}, item: {}, releaseLabel: {} };
  // releases: frozen numbers are kept; the rest count on from the highest used so far
  let nextNum = start;
  for (const r of w.releaseOrder) {
    const rr = w.releases[r] || {};
    const num = rr.num != null ? rr.num : nextNum;
    out.release[r] = num; out.releaseLabel[r] = `V${num}`;
    nextNum = Math.max(nextNum, num + 1);
  }
  // milestones: numbered inside their release (unassigned ones inside an implicit
  // release that follows the last defined one)
  const implicit = w.releaseOrder.length ? nextNum : start;
  const perRel = {};
  for (const m of w.milestoneOrder) {
    const mr = w.milestones[m] || {};
    const r = mr.release || null;
    const key = r || '__none';
    const num = r ? out.release[r] : implicit;
    perRel[key] = perRel[key] || { n: 0 };
    if (mr.label) {
      out.milestone[m] = mr.label;
      const k = parseInt(String(mr.label).split('.')[1], 10);
      if (Number.isFinite(k)) perRel[key].n = Math.max(perRel[key].n, k);
    } else {
      perRel[key].n += 1;
      out.milestone[m] = `V${num}.${perRel[key].n}`;
    }
  }
  // tasks: frozen labels kept; unstarted ones numbered after the highest frozen seq,
  // in the milestone's task order
  for (const m of w.milestoneOrder) {
    const mr = w.milestones[m] || {};
    const ml = out.milestone[m];
    let seq = mr.taskSeq || 0;
    for (const id of milestoneDisplayOrder(w, m)) {
      const t = w.items[id]; if (!t) continue;
      if (t.label) { out.item[id] = t.label; continue; }
      if (t.status === 'CANCELLED') continue;
      seq += 1; out.item[id] = `${ml}.${seq}`;
    }
  }
  return out;
}
// the order work is shown and picked: started work by its frozen number, then the
// milestone's task order for everything not started yet
function milestoneDisplayOrder(w, m) {
  const mr = w.milestones[m] || {};
  const ord = mr.taskOrder || [];
  const seqOf = t => { const x = String(t.label || '').split('.').pop(); return parseInt(x, 10) || 0; };
  const frozen = ord.filter(id => w.items[id] && w.items[id].label).sort((a, b) => seqOf(w.items[a]) - seqOf(w.items[b]));
  const startedOpen = ord.filter(id => w.items[id] && !w.items[id].label && itemStarted(w.items[id])).sort((a, b) => firstStartTs(w.items[a]) - firstStartTs(w.items[b]));
  const rest = ord.filter(id => w.items[id] && !w.items[id].label && !itemStarted(w.items[id]));
  return [...frozen, ...startedOpen, ...rest];
}
function isReady(w, t) {
  return t.status === 'TODO' && depsSatisfied(w, t).length === 0 && (t.criteria || []).length > 0 && ((t.scope || {}).allowed || []).length > 0;
}
// the next READY task in plan order: gated milestone sequence, then task order
function nextReady(w, cfg) {
  for (const m of milestoneSeq(w)) {
    if (milestoneGateBlock(w, cfg, m)) break;
    for (const id of milestoneDisplayOrder(w, m)) {
      const t = w.items[id];
      if (t && isReady(w, t)) return t;
    }
  }
  for (const id of w.order) { const t = w.items[id]; if (!t.milestone && isReady(w, t)) return t; }
  return null;
}
function milestoneName(w, m) {
  const r = ((w || {}).milestones || {})[m];
  return r && r.name ? r.name : null;
}
function milestoneLabel(w, m) {
  const n = milestoneName(w, m);
  return n ? `${m} — ${n}` : m;
}
function versionOf(w, m) { try { return computeLabels(w).milestone[m] || null; } catch (_) { return null; } }
// A milestone is named after what it lets a user DO. Layer-shaped names are the
// smell this release exists to remove; advisory only — names are a human call.
const LAYER_NAME_RE = /^(foundation|foundations|setup|set-up|scaffold(ing)?|infra(structure)?|backend|frontend|database|db|schema|core|plumbing|misc(ellaneous)?|polish|cleanup|clean-up|refactor(ing)?|tech(nical)? debt|base|groundwork|bootstrap)\b/i;
function milestoneNameWarning(name) {
  if (!name) return null;
  if (LAYER_NAME_RE.test(String(name).trim()))
    return `'${name}' names a layer, not a feature. Name the milestone after what a user can do when it ships ` +
      `(e.g. "Customers can reorder a past box"); put shared groundwork inside the first feature that needs it.`;
  return null;
}

// F9: milestone sequence — the explicit order (v0.16.2), limited to milestones that
// carry items, so an empty planned milestone never gates anything.
function milestoneSeq(w) {
  return ensureMilestones(w).filter(m => (w.order || []).some(id => w.items[id].milestone === m));
}

// v0.16.2: dependency edges that a given milestone order would break — an item
// placed in an earlier milestone than something it depends on.
function milestoneOrderViolations(w, order) {
  const pos = new Map(order.map((m, i) => [m, i]));
  const bad = [];
  for (const id of w.order) {
    const t = w.items[id];
    if (!t.milestone || ['CANCELLED'].includes(t.status)) continue;
    for (const d of t.deps || []) {
      const dep = w.items[d];
      if (!dep || !dep.milestone || dep.status === 'CANCELLED' || dep.status === 'DONE') continue;
      if (pos.get(dep.milestone) > pos.get(t.milestone)) bad.push({ item: id, itemM: t.milestone, dep: d, depM: dep.milestone });
    }
  }
  return bad;
}
function milestoneStarted(w, m) {
  return w.order.some(id => w.items[id].milestone === m && ['IN_PROGRESS', 'DONE'].includes(w.items[id].status));
}

// ---------------------------------------------------------------------------
// v0.17: per-milestone git flow — Forge's own rule, enforced in the CLI
// ---------------------------------------------------------------------------
// A milestone is built on one branch (options.branchPattern, default milestone/<id>)
// cut from options.baseBranch. `task done` makes exactly one commit per item — the
// item's files plus Forge's authoritative state — and pushes it; no PR per item, so
// no CI per item (task verify already ran the full suite locally). `milestone ship`
// opens one PR per milestone at the gate, merged with a merge commit so the per-item
// commits survive. Forge never pushes to main/production, never force-pushes, never
// passes --no-verify. options.integration 'manual' opts out (recorded human decision).
function gitCfg(cfg) {
  const o = ((cfg || {}).options) || {};
  return {
    integration: o.integration || 'per-milestone',
    base: o.baseBranch || null,
    pattern: o.branchPattern || 'milestone/<id>',
    merge: o.mergeMethod || 'merge',
    remote: o.remote || 'origin',
    gateSteps: Array.isArray(o.gateSteps) ? o.gateSteps
      : String(o.gateSteps || '').split('||').map(x => x.trim()).filter(Boolean)
  };
}
function perMilestone(cfg) { return gitCfg(cfg).integration === 'per-milestone'; }
function milestoneBranch(cfg, m) { return gitCfg(cfg).pattern.replace('<id>', m); }
function itemBranch(item) { return `item/${item.id}`; }
function git(args, opts = {}) {
  const r = spawnSync('git', args, { cwd: PROJECT, encoding: opts.buffer ? null : 'utf8', timeout: opts.timeout || 120000, maxBuffer: 64 * 1024 * 1024 });
  return { code: r.status === null ? -1 : r.status, out: opts.buffer ? r.stdout : (r.stdout || '').trim(), err: opts.buffer ? String(r.stderr || '') : (r.stderr || '').trim() };
}
// alias for scopes that shadow `git` with a local (preflight has `const git = run(...)`)
function gitx(args, opts) { return git(args, opts); }
function currentBranch() { const r = git(['rev-parse', '--abbrev-ref', 'HEAD']); return r.code === 0 ? r.out : null; }
function hasRemote(cfg) { return git(['remote', 'get-url', gitCfg(cfg).remote]).code === 0; }
function branchExists(b) { return git(['rev-parse', '--verify', '--quiet', `refs/heads/${b}`]).code === 0; }
// Forge's authoritative files are committed with the work; generated ones never are.
const FORGE_AUTHORITATIVE = ['forge/config.json', 'forge/state/work.json', 'forge/state/components.json',
  'forge/state/trace.jsonl', 'forge/state/baseline.json', 'forge/state/usage-baseline.json',
  'forge/decisions.md', 'forge/discoveries.md', 'forge/briefs/', 'forge/changes/', 'forge/evidence/'];
const FORGE_GENERATED = ['forge/dashboard.html', 'forge/state/usage.json', 'forge/state/usage-cache.json',
  'forge/state/preflight.json', 'forge/state/session.json', 'forge/state/work.lock', 'forge/state/trace.jsonl.old',
  'forge/state/upgrade.json', 'forge/state/backups/', 'forge/state/autopilot.json', 'forge/state/verify.lock'];
function isAuthoritative(rel) { return FORGE_AUTHORITATIVE.some(p => p.endsWith('/') ? rel.startsWith(p) : rel === p); }
function isForgePath(rel) { return rel === 'forge' || rel.startsWith('forge/'); }
// Append-only files must start with exactly what HEAD holds. Field incident: a working
// tree held trace.jsonl / discoveries.md a week BEHIND HEAD — committing "everything"
// would have erased that history silently.
const APPEND_ONLY = ['forge/state/trace.jsonl', 'forge/decisions.md', 'forge/discoveries.md'];
function staleStateProblems() {
  const bad = [];
  for (const rel of APPEND_ONLY) {
    const head = git(['show', `HEAD:${rel}`], { buffer: true });
    if (head.code !== 0) continue; // not tracked at HEAD — nothing to be behind
    let wt = null;
    try { wt = fs.readFileSync(path.join(PROJECT, rel)); } catch (_) { wt = Buffer.alloc(0); }
    const h = Buffer.from(head.out || '');
    if (wt.length < h.length || !wt.subarray(0, h.length).equals(h)) {
      // trace.jsonl rotates at 2MB: a rotated file is legitimately not a prefix of HEAD
      if (rel === 'forge/state/trace.jsonl' && fs.existsSync(path.join(PROJECT, rel + '.old'))) {
        try { const old = fs.readFileSync(path.join(PROJECT, rel + '.old')); if (Buffer.concat([old, wt]).subarray(0, h.length).equals(h) || old.subarray(0, h.length).equals(h)) continue; } catch (_) { }
      }
      bad.push(`${rel}: working tree ${wt.length} bytes, HEAD ${h.length} bytes — the working copy does not extend HEAD's content`);
    }
  }
  return bad;
}
function staleStateMessage(bad) {
  return `Refused: Forge's append-only history in the working tree is BEHIND or diverged from HEAD:\n` +
    bad.map(b => `  - ${b}`).join('\n') +
    `\nCommitting now would erase recorded history. Typical cause: switching branches with uncommitted Forge files ` +
    `carries the older copy onto a HEAD that already holds newer content.\n` +
    `Recover the HEAD content first (then re-append anything newer by hand):  git show HEAD:<file> > /tmp/head && diff /tmp/head <file>`;
}
// Porcelain -z parser: every changed path (tracked and untracked), rename targets included.
function changedPaths() {
  // raw output: trimming would eat the leading status column of the first entry
  const r = spawnSync('git', ['status', '--porcelain', '-z', '-uall'], { cwd: PROJECT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) return [];
  const parts = String(r.stdout || '').split('\0').filter(Boolean);
  const res = [];
  for (let i = 0; i < parts.length; i++) {
    const code = parts[i].slice(0, 2), p = parts[i].slice(3);
    res.push({ code, path: p });
    if (code[0] === 'R' || code[0] === 'C') i++; // skip the rename source
  }
  return res;
}
function pathMatchesAny(rel, patterns) {
  return (patterns || []).some(pt => {
    if (pt === '**') return true;
    if (pt.endsWith('/')) return rel.startsWith(pt);
    return globMatch(rel, pt) || rel === pt;
  });
}

// v0.16.2: the commit range a milestone or item spans. Forge does not commit; it
// records what HEAD was, so plan and history can be joined afterwards.
function gitHead() {
  const r = run('git rev-parse HEAD', { timeout: 10000 });
  return r.exit === 0 ? r.tail.trim() : null;
}
function commitRange(base, head) {
  if (!base || !head) return null;
  const c = run(`git rev-list --count ${base}..${head}`, { timeout: 20000 });
  return { base, head, count: c.exit === 0 ? parseInt(c.tail, 10) || 0 : null };
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
        options: Object.assign({ graphify: 'unset', web: 'unset', concurrency: 4 }, SWITCH_ON) // v0.20: 4 in parallel · v0.21: delegation switches on for new projects
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
      // v0.17: leaving the per-milestone git flow is a recorded human decision
      if (keyPath === 'options.integration') {
        if (!['per-milestone', 'manual'].includes(value)) die(`options.integration must be 'per-milestone' (default) or 'manual' (Forge runs no git; the orchestrator follows a project convention).`);
        if (value !== 'per-milestone') {
          if (!opt('reason')) die(`Refused: opting out of the per-milestone git flow needs a recorded reason:\n  forge config set options.integration ${value} --reason "..."`);
          appendMd(DECISIONS_FILE, '# Decisions log (append-only, via forge CLI)',
            `\n### ${ts()} — Git flow: options.integration = ${value}\n- Authority: human\n- Decision: opt out of Forge's per-milestone git flow\n- Why: ${opt('reason')}\n`);
        }
      }
      if (keyPath === 'options.baseBranch' && /^(main|master|prod|production)$/i.test(value))
        die(`Refused: '${value}' looks like a production branch. Milestone branches merge into an integration branch (staging, develop); production is released from it, never built on directly.`);
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
        // v0.13: the architecture / screens views are only honest when items are tagged
        {
          const wPf = readJson(WORK_FILE, { items: {}, order: [] });
          const untaggedPf = wPf.order.filter(id => !wPf.items[id].component && wPf.items[id].status !== 'CANCELLED').length;
          if (wPf.order.length)
            check('component map', untaggedPf === 0,
              untaggedPf ? `${untaggedPf} work item(s) not tagged to a screen, architecture part or tag — the dashboard cannot place them (forge task update <id> --component <c>)` : 'all items tagged', 'warning');
        }
        // v0.16.2: a milestone is named after the feature it enables
        {
          const wPf2 = readJson(WORK_FILE, { items: {}, order: [] });
          const seqPf = milestoneSeq(wPf2);
          const unnamedPf = seqPf.filter(m => !milestoneName(wPf2, m));
          if (seqPf.length)
            check('milestone names', unnamedPf.length === 0,
              unnamedPf.length ? `${unnamedPf.length} milestone(s) unnamed (${unnamedPf.slice(0, 6).join(', ')}${unnamedPf.length > 6 ? ', …' : ''}) — name each after the feature it enables: forge milestone update <id> --name "..."` : 'all milestones named', 'warning');
        }
        // v0.17: per-milestone git flow readiness
        if (perMilestone(cfg)) {
          const gc = gitCfg(cfg);
          check('git flow: base branch', !!gc.base,
            gc.base ? `per-milestone · base ${gc.base} · branches ${gc.pattern}` : `Forge's default flow since v0.17 is one branch + one PR per milestone. Confirm the base branch: forge config set options.baseBranch <branch> (opt out: forge config set options.integration manual --reason "...")`, 'decision');
          check('git flow: remote', hasRemote(cfg), hasRemote(cfg) ? `${gc.remote}` : `no '${gc.remote}' remote — item commits stay local and ship cannot open a PR`, 'warning');
          const ghOk = spawnSync(process.env.FORGE_GH || 'gh', ['--version'], { encoding: 'utf8' }).status === 0;
          check('git flow: gh', ghOk, ghOk ? 'available' : `GitHub CLI not found — 'forge milestone ship' needs it (gh auth login)`, 'warning');
          const tracked = gitx(['ls-files', '--', ...FORGE_GENERATED]).out.split('\n').filter(Boolean);
          check('git flow: generated files', tracked.length === 0,
            tracked.length ? `${tracked.length} generated Forge file(s) are tracked (${tracked.join(', ')}) — they change on every command and conflict on every merge. Untrack them (git rm --cached <files>) and add them to .gitignore` : 'none tracked', 'warning');
          const staleP = staleStateProblems();
          check('git flow: append-only history', staleP.length === 0, staleP.length ? staleP.join(' | ') + ' — task done will refuse to commit' : 'working tree extends HEAD', 'warning');
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
      if (g.exit === 0) {
        check('graphify', true, `available (${g.tail.split('\n')[0]})`, 'optional');
        // v0.20.1: installed is not used — the graph must exist, be current, ignored, and wired into Claude Code
        if (choice === 'use') {
          const gs = graphifyStatus(cfg);
          const gp = graphifyProblems(gs);
          check('graphify graph', !gp.length, gp.length ? gp.map(x => `${x.what} → ${x.fix}`).join(' | ') : `built ${new Date(gs.builtMs).toISOString().slice(0, 16).replace('T', ' ')} · ${gs.sizeKB} KB · rebuilt on commit · Claude Code integration in place`, 'warning');
        }
      }
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
        domains: opt('domain') ? String(opt('domain')).split(',').map(x => x.trim().toLowerCase()).filter(Boolean) : undefined, // v0.21: packs + high-risk
        mock: opt('mock') || null, // v0.14: the approved mock this screen item is bound to (spec/mocks/...)
        status: 'TODO', attempts: [], verifications: [], history: [],
        preState: null, startTree: null,
        blockReason: null, cancelReason: null, created: ts(), updated: ts()
      }, item, { status: 'TODO' });
      w.order.push(item.id);
      saveWork(w);
      // v0.10: auto-register unknown components so the map never lies by omission
      // v0.19: an unknown tag becomes a plain tag — screens and architecture parts are declared on purpose
      if (w.items[item.id].component) {
        const comps = loadComps();
        if (!tagRef(comps, w.items[item.id].component)) {
          comps.tags[w.items[item.id].component] = { id: w.items[item.id].component, name: w.items[item.id].component, kind: 'unspecified', created: ts() };
          saveComps(comps);
          regenDashboard();
        }
      }
      out(`Created ${item.id}: ${item.title}`);
      {
        const mr = (w.milestones || {})[w.items[item.id].milestone];
        if (mr && mr.unnamed && !w.order.some(id2 => id2 !== item.id && w.items[id2].milestone === mr.id))
          out(`NOTE: milestone '${mr.id}' was not registered — created UNNAMED. Name it after the feature it enables:\n` +
              `  forge milestone update ${mr.id} --name "<what a user can do when it ships>" --demo "<how to try it>"`);
        for (const v of milestoneOrderViolations(w, ensureMilestones(w)).filter(v => v.item === item.id))
          out(`MILESTONE-ORDER WARNING: '${item.id}' (${v.itemM}) depends on '${v.dep}', which sits in a LATER milestone (${v.depM}) — it cannot start until that gate. Move one of them.`);
      }
      if (!w.items[item.id].component)
        out(`WARNING: '${item.id}' has no --component tag — the dashboard cannot place it on a screen or architecture part. Tag it: forge task update ${item.id} --component <id>`);
      for (const wmsg of itemShapeWarnings(w.items[item.id])) out(`ITEM-SHAPE WARNING: ${wmsg}`);

    } else if (sub === 'list') {
      const filter = opt('status');
      // v0.18: plan order — milestone sequence, then each milestone's task order — with labels
      ensureMilestones(w);
      const labs = computeLabels(w);
      const planOrder = [...w.milestoneOrder.flatMap(m => milestoneDisplayOrder(w, m)), ...w.order.filter(id => !w.items[id].milestone)];
      for (const id of planOrder) {
        const t = w.items[id];
        if (filter && t.status !== filter) continue;
        const noScope = !((t.scope || {}).allowed || []).length;
        const ready = t.status === 'TODO' && depsSatisfied(w, t).length === 0 && t.criteria.length > 0 && !noScope;
        // v0.13: thin backlog items are legitimate — warn only where the work is live (active milestone or unmilestoned)
        const actM = activeMilestone(w);
        const warnScope = noScope && !['DONE', 'CANCELLED'].includes(t.status) && (!t.milestone || t.milestone === actM);
        out(`${t.status.padEnd(11)} ${(labs.item[id] || '').padEnd(9)} ${id.padEnd(8)} ${t.title}${ready ? '  [READY]' : ''}` +
            (warnScope ? '  [NO SCOPE — start will refuse]' : '') +
            (t.deps.length ? `  deps: ${t.deps.join(',')}` : '') +
            (failedAttempts(t) ? `  failed-attempts: ${failedAttempts(t)}` : ''));
      }

    } else if (sub === 'show') {
      out(JSON.stringify(getItem(w, argv[2]), null, 2));

    } else if (sub === 'start') {
      // v0.18: no id → the next READY task in plan order (milestone sequence, then task order)
      let pickedNext = false;
      if (!argv[2] || String(argv[2]).startsWith('--')) {
        const nx = nextReady(w, loadConfig() || {});
        if (!nx) die(`Nothing READY in plan order. See: forge task list`);
        argv.splice(2, 0, nx.id); pickedNext = true;
      }
      const item = getItem(w, argv[2]);
      if (!pickedNext && item.milestone && isReady(w, item) && !opt('reason')) {
        const ord = milestoneDisplayOrder(w, item.milestone);
        const earlier = ord.slice(0, ord.indexOf(item.id)).filter(id => isReady(w, w.items[id]));
        if (earlier.length)
          die(`Refused: '${item.id}' is not next in plan order — READY before it in '${item.milestone}': ${earlier.slice(0, 6).join(', ')}.\n` +
              `Work follows the plan's order. Start the next one (forge task start), reorder deliberately\n` +
              `(forge task move ${item.id} --before ${earlier[0]} --reason "..."), or record why: forge task start ${item.id} --reason "..."`);
      }
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
      // v0.17: per-milestone git flow — work happens on the milestone's branch
      let ownBranchStart = null;
      {
        const cfgG = loadConfig() || {};
        if (perMilestone(cfgG) && item.milestone) {
          const gc = gitCfg(cfgG);
          if (!gc.base)
            die(`Refused: the per-milestone git flow needs a base branch (Forge's default flow since v0.17).\n` +
                `  forge config set options.baseBranch <branch>     (e.g. staging or develop — never production)\n` +
                `Opting out is a human decision: forge config set options.integration manual --reason "..."`);
          const mb = milestoneBranch(cfgG, item.milestone);
          const cur = currentBranch();
          if (flag('own-branch')) {
            if (!opt('reason')) die(`--own-branch requires --reason "..." — an item off the milestone branch is a recorded human decision.`);
            const others = w.order.filter(id2 => id2 !== item.id && w.items[id2].status === 'IN_PROGRESS');
            if (others.length) die(`Refused: --own-branch switches the working tree; finish the in-progress item(s) first: ${others.join(', ')}.`);
            if (cur !== mb) die(`Refused: an own-branch item is cut from its milestone branch '${mb}' — you are on '${cur}'.\n  forge milestone branch ${item.milestone}`);
            const ib = itemBranch(item);
            const sw = git(branchExists(ib) ? ['switch', ib] : ['switch', '-c', ib]);
            if (sw.code !== 0) die(`Refused: could not switch to '${ib}': ${sw.err}`);
            ownBranchStart = { branch: ib, from: mb, reason: opt('reason'), ts: ts() };
          } else {
            const expected = (item.ownBranch && item.ownBranch.branch) || mb;
            if (cur !== expected)
              die(`Refused: '${item.id}' belongs to milestone '${item.milestone}', built on branch '${expected}' — you are on '${cur}'.\n` +
                  (expected === mb ? `  forge milestone branch ${item.milestone}     (creates it from '${gc.base}' or switches to it)` : `  git switch ${expected}`));
          }
        }
      }
      // v0.12: scope is part of the item's definition — no declared file scope, no start.
      // Field evidence (an 87-item project): scope derived only into brief prose is unenforceable.
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
      // v0.21 (C1): oversized tasks are refused, not warned. Field evidence: the six 4wines items with
      // 8–12 criteria went 1/6 first-pass; items with 1–3 criteria went 94%. The warning was overridden every time.
      const shapeReason = (sw(loadConfig(), 'itemShape') === 'refuse' && (item.criteria || []).length > 6) ? opt('reason') : null;
      if (sw(loadConfig(), 'itemShape') === 'refuse' && (item.criteria || []).length > 6 && !opt('reason'))
        die(`Refused: '${item.id}' has ${item.criteria.length} acceptance criteria (limit 6, options.itemShape=refuse).\n` +
            `Oversized tasks fail far more often (8–12 criteria: 1 in 6 passed first time; 1–3 criteria: 94%). Split it SIDE BY SIDE —\n` +
            `sibling tasks that can run in parallel, each with its own criteria and scope — not into a chain:\n` +
            `  forge task add --id ${item.id}b --title "…" --milestone ${item.milestone || '<m>'} --criterion "…::check" --allowed "…"\n` +
            `If it genuinely cannot split: forge task start ${item.id} --reason "<why it cannot split>" (recorded on the attempt).`);
      const fails = failedAttempts(item);
      if (fails >= 2 && !opt('escalate'))
        die(`Refused: '${item.id}' has failed ${fails} attempts. A third identical attempt is not allowed.\n` +
            `Escalate explicitly: forge task start ${item.id} --escalate <stronger-model|decompose|self|revisit-criteria> --note "what changes this time"`);
      // 1.2/F5: red-first — record each criterion check's pre-work result
      if (ownBranchStart) {
        item.ownBranch = ownBranchStart;
        appendMd(DECISIONS_FILE, '# Decisions log (append-only, via forge CLI)',
          `\n### ${ts()} — '${item.id}' built on its own branch\n- Authority: human\n- Decision: ${ownBranchStart.branch}, cut from ${ownBranchStart.from}; merges back into ${ownBranchStart.from} (never straight into the base branch)\n- Why: ${ownBranchStart.reason}\n`);
      }
      item.preState = item.criteria.map(c => c.check ? { desc: c.desc, exit: run(c.check).exit } : null);
      item.startTree = treeState();
      // v0.16.2: HEAD at the first start — the lower bound of this item's commit range
      if (!item.commitBase) item.commitBase = gitHead();
      const alreadyGreen = item.preState.filter(p => p && p.exit === 0);
      item.status = 'IN_PROGRESS';
      item.blockReason = null;
      item.attempts.push({ ts: ts(), outcome: 'started', escalation: opt('escalate') || null, note: opt('note') || null, agent: opt('agent') || null, outOfOrder: (!pickedNext && opt('reason')) ? opt('reason') : undefined, shapeReason: shapeReason || undefined });
      item.updated = ts();
      if (item.milestone) freezeLabels(w); // v0.18: the version label freezes when work starts
      saveWork(w);
      out(`${item.id}${item.label ? ` (${item.label})` : ''} → IN_PROGRESS${opt('escalate') ? ` (escalation: ${opt('escalate')})` : ''}`);
      // v0.21 (C9): a high-risk task gets an architect's design note BEFORE its first worker dispatch
      if (sw(loadConfig(), 'architectPrepass') === 'high-risk' && isHighRisk(item)
          && !launchesOf(item, /architect/i).length && !(w.dispatchLog || []).some(d => d.item === item.id && /architect/i.test(d.agent || ''))) {
        out(`\nHIGH-RISK TASK (${itemDomains(item).filter(d => HIGH_RISK_DOMAINS.includes(d)).join(', ')}) — options.architectPrepass: dispatch forge-architect (opus) for a design note BEFORE the implementer. Prompt:\n`);
        out([`# Design brief — ${item.id}: ${item.title}`, '',
          `Write a SHORT design note for the implementer (Sonnet) of this high-risk task. Advise; do not implement.`,
          `Objective: ${item.objective || '(see criteria)'}`, `Criteria:`, ...item.criteria.map((c, i) => `${i + 1}. ${c.desc}`),
          `Scope: ${((item.scope || {}).allowed || []).join(', ')}`, '',
          `Cover, in at most a page: the failure classes of every external call and transaction and the distinct handling of each (an unknown outcome is never a known failure); transaction boundaries; the invariants that must hold; what NOT to do.`, '',
          `Record it (Forge writes it into the task's context pack; the next brief includes it):`,
          `  node "${__filename}" context save ${item.id} --section design-note <<'NOTE'`, `  …the note…`, `  NOTE`,
          `Reply with one line: saved.`].join('\n'));
        out(`\nRecord the dispatch: forge task dispatch ${item.id} --agent forge-architect --model opus`);
      }
      for (const wmsg of itemShapeWarnings(item)) out(`ITEM-SHAPE WARNING: ${wmsg}`);
      if (alreadyGreen.length)
        out(`WARNING: ${alreadyGreen.length} criterion check(s) ALREADY PASS before any work:\n` +
            alreadyGreen.map(p => `  - ${p.desc}`).join('\n') +
            `\nEither the item is already satisfied (cancel it with a reason) or these checks are vacuous (fix them: forge task update). 'done' will refuse if nothing changes.`);

    } else if (sub === 'verify') {
      let item = getItem(w, argv[2]);
      const cfg = loadConfig() || { verify: {} };
      // C6: checks run under the verify lock, NOT the state lock
      releaseWorkLock();
      acquireVerifyLock(item.id, flag('no-wait'));
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
      const tree = treeState();
      releaseVerifyLock();
      // re-read state under the state lock: other workers may have written while checks ran
      acquireWorkLock();
      const wNow = readJson(WORK_FILE, w);
      item = wNow.items[item.id] || item;
      item.verifications.push({ ts: ts(), passed, results, tree, skippedBaseline, artifacts: artifacts.length ? artifacts : undefined,
        durationMs: results.reduce((a, r) => a + (r.ms || 0), 0) });
      item.updated = ts();
      saveWork(wNow);
      // v0.16: passing checks print one line. Field measurement: tool results were
      // 29–47% of the orchestrator's context window, and a passing test's output is
      // never read by anyone. The FULL tail still goes to work.json below, so the
      // evidence record is unchanged — this is a stdout change only.
      const verbose = ((cfg.options || {}).verifyVerbose) === true;
      const failed = results.filter(r => r.exit !== 0);
      if (verbose) {
        for (const r of results) out(`${r.exit === 0 ? 'PASS' : 'FAIL'}  [${r.kind}] ${r.cmd}${r.note ? `  (${r.note})` : ''}${r.exit !== 0 ? '\n' + r.tail : ''}`);
      } else {
        out(`VERIFY ${item.id} — ${passed ? 'PASS' : 'FAIL'} ${results.length - failed.length}/${results.length}`);
        for (const r of results) {
          if (r.exit === 0) { out(`  ✓ ${r.kind}${r.note ? ` (${r.note})` : ''}`); continue; }
          out(`  ✗ ${r.kind} — exit ${r.exit}${r.note ? ` (${r.note})` : ''}\n${String(r.tail || '').split('\n').slice(-20).map(l => '    ' + l).join('\n')}`);
        }
        if (!failed.length) out(`  (full output of every check is recorded in work.json — options.verifyVerbose true prints it here)`);
      }
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
      // v0.21 (C5): delegation is enforced — a task closes on a worker's launch, or on a recorded self-close
      const cfgSw = loadConfig() || {};
      let selfClosed = null, testerWaived = null;
      if (sw(cfgSw, 'requireDispatch') && !launchesOf(item, /implementer|tester|^api$|worker/i).length && !(item.dispatches || []).some(d => d.kind === 'api')) {
        if (!(flag('self') && opt('reason')))
          die(`Refused: '${item.id}' has no implementer or tester dispatch recorded (options.requireDispatch).\n` +
              `If a worker did the work, record its launch (this also fixes the record for workers that ran unrecorded):\n` +
              `  forge task dispatch ${item.id} --agent forge-implementer --model sonnet\n` +
              `If you did it yourself because it was trivial: forge task done ${item.id} --self --reason "<why trivial>"  (counted in forge stats)`);
        selfClosed = { ts: ts(), reason: opt('reason') };
      }
      // v0.21 (C8): high-risk tasks get a tester in parallel with the implementer
      const testerRule = sw(cfgSw, 'requireTester');
      const hasTester = launchesOf(item, /tester/i).length > 0;
      if (testerRule === 'high-risk' && isHighRisk(item) && !hasTester) {
        if (!opt('reason'))
          die(`Refused: '${item.id}' is high-risk (${itemDomains(item).filter(d => HIGH_RISK_DOMAINS.includes(d)).join(', ')}) and no forge-tester was dispatched (options.requireTester=high-risk).\n` +
              `Dispatch forge-tester alongside the implementer — it writes the tests from the criteria, red first — and record it:\n` +
              `  forge task dispatch ${item.id} --agent forge-tester --model sonnet\n` +
              `Or close without one, recorded: forge task done ${item.id} --reason "<why no tester>"`);
        testerWaived = opt('reason');
      }
      const testLane = (item.criteria || []).filter(c => /\b(test|vitest|jest|pytest|playwright|e2e|spec)\b/i.test(c.check || '')).length;
      if ((testerRule === 'warn' || testerRule === 'high-risk') && !hasTester && !testerWaived && (item.criteria || []).length && testLane * 2 > item.criteria.length)
        out(`TESTER WARNING: most of '${item.id}''s criteria are tests, and no forge-tester was dispatched (options.requireTester=${testerRule}). Turn off: forge config set options.requireTester false`);
      // 1.2/F5: red-first — green-before, green-after, nothing changed ⇒ the checks proved nothing
      const checked = (item.preState || []).filter(Boolean);
      if (checked.length && checked.every(p => p.exit === 0) && item.startTree && now && item.startTree === now)
        die(`Refused: every criterion check already passed BEFORE work started, and the tree is unchanged since start.\n` +
            `These checks prove nothing about this item. Either the item was already satisfied (forge task cancel ${item.id} --reason "already satisfied")\n` +
            `or the checks are vacuous (forge task update ${item.id} --criterion-remove/--criterion-add --reason "...").`);
      // v0.17: per-milestone git flow — the pre-commit checks run BEFORE anything changes
      const cfgD = loadConfig() || {};
      const gitFlow = perMilestone(cfgD) && item.milestone;
      let commitPlan = null;
      if (gitFlow) {
        const expected = (item.ownBranch && item.ownBranch.branch) || milestoneBranch(cfgD, item.milestone);
        const cur = currentBranch();
        if (cur !== expected)
          die(`Refused: '${item.id}' is committed on '${expected}' — the working tree is on '${cur}'.\n  git switch ${expected}`);
        const bad = staleStateProblems();
        if (bad.length) die(staleStateMessage(bad));
        const staged = git(['diff', '--cached', '--name-only']).out;
        if (staged) die(`Refused: the index already holds staged changes (${staged.split('\n').slice(0, 6).join(', ')}).\n` +
                        `Forge stages exactly the item's files itself. Unstage first: git restore --staged <paths>`);
        const others = w.order.filter(id2 => id2 !== item.id && w.items[id2].status === 'IN_PROGRESS').map(id2 => w.items[id2]);
        const exempt = String(((cfgD.options || {}).scopeExempt) || 'forge/,spec/,docs/').split(',').map(x => x.trim()).filter(x => x && x !== 'forge/');
        if (cfgD.specDir) exempt.push(String(cfgD.specDir).replace(/\/?$/, '/'));
        const mine = [], outside = [], deferred = [];
        for (const c of changedPaths()) {
          const rel = c.path;
          if (isForgePath(rel)) continue; // Forge files are added below, authoritative ones only
          if (pathMatchesAny(rel, item.scope.allowed) || pathMatchesAny(rel, exempt) || /\.md$/i.test(rel)) mine.push(rel);
          else if (others.some(o => pathMatchesAny(rel, (o.scope || {}).allowed))) deferred.push(rel);
          else outside.push(rel);
        }
        if (outside.length)
          die(`Refused: the working tree holds changes outside '${item.id}''s scope and outside every in-progress item's scope:\n` +
              outside.slice(0, 20).map(x => `  - ${x}`).join('\n') + (outside.length > 20 ? `\n  … and ${outside.length - 20} more` : '') +
              `\nOne commit per item means exactly the item's files. Revert the stray changes, or widen the scope deliberately:\n` +
              `  forge task update ${item.id} --allowed "..." --reason "..."\n` +
              `If these are the user's own changes (they belong to no task), only the user can commit or revert them — ask:\n` +
              `  forge task block ${item.id} --reason "question: commit or revert ${outside.slice(0, 3).join(', ')}${outside.length > 3 ? ' …' : ''} so ${item.id} can close?"\n` +
              `  then, after they have: forge task unblock ${item.id} && forge task done ${item.id}`);
        commitPlan = { branch: cur, mine, deferred };
      }
      if (selfClosed) item.selfClosed = selfClosed; // v0.21 (C5)
      if (testerWaived) item.testerWaived = { ts: ts(), reason: testerWaived }; // v0.21 (C8)
      item.status = 'DONE';
      item.attempts.push({ ts: ts(), outcome: 'passed', note: opt('note') || null });
      // v0.16.2: the commits that landed while this item was in flight. Forge does not
      // commit; if the work is still uncommitted at DONE the range is empty and the
      // item's changes will surface in the milestone range instead.
      {
        const r = commitRange(item.commitBase, gitHead());
        // Forge's own state churns on every command, so it is excluded from "uncommitted".
        if (r) { r.uncommitted = !!run(`git status --porcelain -- . ':(exclude)forge'`, { timeout: 20000 }).tail.trim(); item.commits = r; }
      }
      item.updated = ts();
      saveWork(w);
      if (commitPlan) {
        const forgeFiles = changedPaths().map(c => c.path).filter(isAuthoritative);
        const files = [...new Set([...commitPlan.mine, ...forgeFiles])];
        const title = String(item.title || '').split('\n')[0].slice(0, 120);
        const add = git(['add', '-A', '--', ...files]);
        const commit = add.code === 0 ? git(['commit', '-m', `${item.id}${item.label ? ` (${item.label})` : ''}: ${title}`]) : add;
        if (commit.code !== 0) {
          git(['reset', '-q', '--', ...files]);
          item.status = 'IN_PROGRESS';
          item.attempts.pop();
          delete item.commits;
          saveWork(w);
          die(`Refused: the commit for '${item.id}' failed — the item stays IN_PROGRESS (a project hook may have rejected it):\n${(commit.err || commit.out).split('\n').slice(-20).join('\n')}\n` +
              `Fix the cause and run 'forge task done ${item.id}' again. Never --no-verify.`);
        }
        const sha = git(['rev-parse', 'HEAD']).out;
        let pushed = false, pushErr = null;
        if (hasRemote(cfgD)) {
          const pr = git(['push', '-u', gitCfg(cfgD).remote, commitPlan.branch]);
          pushed = pr.code === 0; if (!pushed) pushErr = (pr.err || pr.out).split('\n').slice(-6).join('\n');
        }
        item.commit = { sha, branch: commitPlan.branch, pushed, ts: ts(), files: files.length };
        saveWork(w);
        out(`${item.id}: committed ${sha.slice(0, 10)} on ${commitPlan.branch} (${files.length} file(s))` +
            (pushed ? ' and pushed.' : hasRemote(cfgD) ? ` — PUSH FAILED, the commit is local only:\n${pushErr}\nPush before 'milestone ship': git push -u ${gitCfg(cfgD).remote} ${commitPlan.branch}` : ' — no remote configured, local only.'));
        if (commitPlan.deferred.length) out(`  ${commitPlan.deferred.length} changed file(s) belong to other in-progress items and were left for their own commits.`);
        if (item.ownBranch) out(`  Own-branch item: open a PR ${item.ownBranch.branch} → ${item.ownBranch.from} (merge commit), merge it, then: forge milestone branch ${item.milestone}`);
      }
      out(`${item.id} → DONE (verified ${v.ts})`);
      // v0.5: the spec is the living source of truth on EVERY project
      out(`Spec sync: if this item established, changed, or contradicted product behavior, update the affected ` +
          `spec layer file(s) NOW, citing the decision/discovery that drove it — the spec must always describe ` +
          `the product as built and intended.`);
      // F9: surface the gate the moment a milestone completes
      if (item.milestone && milestoneComplete(w, item.milestone) && !((w.gates || {})[item.milestone] || {}).approved
          && ((loadConfig() || {}).options || {}).gates !== 'end-only')
        out(`\nMILESTONE '${milestoneLabel(w, item.milestone)}' IS COMPLETE and now awaits human review.\n` +
            `Demo it to the user, collect their verdict, AND ask: "anything you want to change or add before the next milestone?"\n` +
            `— their answer becomes decisions + work-graph updates. Then: forge milestone approve ${item.milestone} --note "..."\n` +
            `Items in later milestones will refuse to start until then.\n` +
            `📊 Point the user at forge/dashboard.html for the visual state of the project.`);

    } else if (sub === 'fail') {
      const item = getItem(w, argv[2]);
      if (item.status !== 'IN_PROGRESS') die(`'${item.id}' is not IN_PROGRESS.`);
      // v0.15: provider-failure taxonomy — a rate limit / outage / timeout is not
      // a failed approach and must not burn the escalation ladder.
      const fkind = opt('kind') || null;
      if (fkind && !['provider', 'worker'].includes(fkind))
        die(`--kind must be 'provider' (rate limit / outage / timeout — does not count toward escalation) or 'worker' (the approach failed — counts).`);
      // v0.21 (C3): --from-review stores the reviewer's findings; a retry brief carries only the latest ones
      let review;
      if (opt('from-review')) {
        const rf = path.resolve(PROJECT, opt('from-review'));
        if (!fs.existsSync(rf)) die(`No such review file: ${opt('from-review')}`);
        review = fs.readFileSync(rf, 'utf8').slice(0, 16 * 1024);
      }
      item.attempts.push({ ts: ts(), outcome: 'failed', kind: fkind, note: opt('note') || (review ? '(see review findings)' : '(no diagnosis recorded)'), review, reviewFile: review ? opt('from-review') : undefined });
      item.status = 'TODO';
      item.updated = ts();
      saveWork(w);
      const fails = failedAttempts(item);
      if (fkind === 'provider')
        out(`${item.id} attempt recorded as PROVIDER failure (escalation counter unchanged: ${fails}). Retry when the provider recovers, switch models, or fall back to a Claude worker.`);
      else
        out(`${item.id} attempt recorded as failed (${fails} total). ` +
            (fails >= 2 ? 'Next start REQUIRES --escalate.' : 'Diagnose before retrying — retry in a fresh worker context with the diagnosis in the brief. A stall usually narrows (diagnose → shrink the brief); decompose when it cannot.'));

    } else if (sub === 'block') {
      const item = getItem(w, argv[2]);
      if (['DONE', 'CANCELLED'].includes(item.status)) die(`'${item.id}' is ${item.status}; it cannot be blocked.`);
      if (item.status !== 'BLOCKED') item.blockedFrom = item.status;
      item.status = 'BLOCKED';
      item.blockReason = opt('reason') || 'unspecified';
      item.updated = ts();
      saveWork(w);
      out(`${item.id} → BLOCKED: ${item.blockReason}`);
      out(`When the user has answered: forge task unblock ${item.id} --note "<their answer>"${item.blockedFrom === 'IN_PROGRESS' ? ' (resumes the attempt; its verification stays valid)' : ''}`);

    } else if (sub === 'unblock') {
      // v0.21.2: the way back from a question. An item blocked mid-attempt resumes that attempt —
      // no new start, no re-run of the before-work checks, its verification untouched.
      const item = getItem(w, argv[2]);
      if (item.status !== 'BLOCKED') die(`'${item.id}' is ${item.status}, not BLOCKED.`);
      const back = item.blockedFrom === 'IN_PROGRESS' ? 'IN_PROGRESS' : 'TODO';
      if (back === 'IN_PROGRESS') {
        const cfgU = loadConfig() || {};
        const conc = parseInt(((cfgU.options || {}).concurrency), 10) || 1;
        const running = w.order.filter(id2 => w.items[id2].status === 'IN_PROGRESS').length;
        if (running >= conc) die(`Refused: ${running} task(s) already IN_PROGRESS (options.concurrency ${conc}). Settle one first.`);
      }
      (item.unblocks = item.unblocks || []).push({ ts: ts(), reason: item.blockReason, answer: opt('note') || null, to: back });
      item.status = back;
      delete item.blockReason; delete item.blockedFrom;
      item.updated = ts();
      saveWork(w);
      out(`${item.id} → ${back}${back === 'IN_PROGRESS' ? ' — the same attempt continues; verify/done as before' : ' — start it when it is next (forge task start)'}`);

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
      if (['DONE', 'CANCELLED'].includes(item.status)) {
        // v0.16.3: a component tag is a label for the map, not part of the work — it may be
        // set on a closed item (audited). Everything else on a closed item stays frozen.
        const flagsUsed = argv.slice(3).filter(a => a.startsWith('--')).map(a => a.slice(2));
        if (flagsUsed.length && flagsUsed.every(f => ['component', 'reason'].includes(f)) && opt('component') !== null) {
          const was = item.component || null;
          item.component = opt('component') || null;
          (item.history = item.history || []).push({ ts: ts(), change: `component = ${item.component} (was ${was}; item ${item.status})`, reason: opt('reason') || null });
          saveWork(w);
          out(`${item.id} (${item.status}) component → ${item.component}`);
          return;
        }
        die(`'${item.id}' is ${item.status} — closed items are not edited; create a new item that supersedes it.\n` +
            `(Only a component tag may be set on a closed item: forge task update ${item.id} --component <c> [--reason ".."])`);
      }
      const changes = [];
      const touchingCriteria = optAll('criterion-add').length > 0 || optAll('criterion-remove').length > 0;
      if (touchingCriteria && item.attempts.some(a => a.outcome === 'failed') && !opt('reason'))
        die(`Refused: this item has failed attempts — changing its criteria moves the goalposts.\n` +
            `That can be right, but it must be auditable: add --reason "why the criteria change".`);
      if (opt('milestone') !== null && item.label && opt('milestone') !== item.milestone)
        die(`Refused: '${item.id}' has started and carries version ${item.label} — started work keeps its milestone.`);
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
      if (opt('domain') !== null) { item.domains = String(opt('domain')).split(',').map(x => x.trim().toLowerCase()).filter(Boolean); changes.push('domains = ' + item.domains.join(',')); }
      if (opt('mock') !== null) { item.mock = opt('mock') || null; changes.push('mock = ' + item.mock); }
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
      if (opt('milestone') !== null || opt('deps') !== null)
        for (const v of milestoneOrderViolations(w, ensureMilestones(w)).filter(v => v.item === item.id || v.dep === item.id))
          out(`MILESTONE-ORDER WARNING: '${v.item}' (${v.itemM}) depends on '${v.dep}', which sits in a LATER milestone (${v.depM}).`);
      for (const wmsg of itemShapeWarnings(item)) out(`ITEM-SHAPE WARNING: ${wmsg}`);

    } else if (sub === 'next') {
      // v0.18: what the plan says comes next (read-only)
      const nx = nextReady(w, loadConfig() || {});
      if (!nx) { out('Nothing READY in plan order.'); return; }
      const lab = computeLabels(w).item[nx.id];
      out(`${lab ? lab + '  ' : ''}${nx.id}  ${nx.title}${nx.milestone ? `  [${nx.milestone}]` : ''}`);
      out(`Start it: forge task start   (no id = next in plan order)`);

    } else if (sub === 'move') {
      // v0.18: reorder unstarted work inside its milestone — dependency-checked
      const item = getItem(w, argv[2]);
      const anchorId = opt('before') || opt('after');
      if (!anchorId || (opt('before') && opt('after'))) die('Usage: forge task move <id> --before|--after <id> [--reason "..."]');
      const anchor = getItem(w, anchorId);
      if (!item.milestone || item.milestone !== anchor.milestone) die(`Refused: tasks are ordered inside their milestone — '${item.id}' (${item.milestone || 'none'}) and '${anchor.id}' (${anchor.milestone || 'none'}) differ. Change milestone with: forge task update ${item.id} --milestone <m>`);
      if (itemStarted(item) || item.status === 'CANCELLED') die(`Refused: '${item.id}' has started (or is closed) — its version number is frozen.`);
      if (itemStarted(anchor)) die(`Refused: '${anchor.id}' has started — reorder relative to work that has not started.`);
      ensureMilestones(w);
      const mr = w.milestones[item.milestone];
      const next = mr.taskOrder.filter(x => x !== item.id);
      next.splice(opt('before') ? next.indexOf(anchor.id) : next.indexOf(anchor.id) + 1, 0, item.id);
      const pos = new Map(next.map((x, i) => [x, i]));
      const bad = [];
      for (const id2 of next) {
        const t = w.items[id2]; if (itemStarted(t) || t.status === 'CANCELLED') continue;
        for (const d of t.deps || []) {
          const dep = w.items[d];
          if (!dep || dep.milestone !== item.milestone || ['DONE', 'CANCELLED'].includes(dep.status) || itemStarted(dep)) continue;
          if (pos.get(d) > pos.get(id2)) bad.push(`${id2} depends on ${d}`);
        }
      }
      if (bad.length) die(`Refused: that order puts work before what it depends on:\n` + bad.map(b => `  - ${b}`).join('\n'));
      const before = computeLabels(w).item[item.id];
      mr.taskOrder = next;
      (item.history = item.history || []).push({ ts: ts(), change: `task order: ${opt('before') ? 'before' : 'after'} ${anchor.id}`, reason: opt('reason') || null });
      item.updated = ts();
      saveWork(w);
      out(`${item.id} moved ${opt('before') ? 'before' : 'after'} ${anchor.id} — ${before} → ${computeLabels(w).item[item.id]}`);

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
      // v0.21 (C2): the brief a worker actually receives is the completed file — its size is checked at launch too
      if (kind === 'launch' && sw(loadConfig(), 'briefLimit') === 'on' && /implementer|tester/i.test(opt('agent') || '')) {
        const bf = path.join(FORGE, 'briefs', `${item.id}.md`);
        const kb = fs.existsSync(bf) ? fs.statSync(bf).size / 1024 : 0;
        if (kb > 20 && !opt('reason'))
          die(`Refused: forge/briefs/${item.id}.md is ${kb.toFixed(1)} KB (limit 20 KB, options.briefLimit=on) — the brief is doing the worker's job. Split the task, or move investigation into the context pack (forge brief ${item.id} --context). Override: --reason "…".`);
        if (kb > 12) out(`BRIEF SIZE WARNING: forge/briefs/${item.id}.md is ${kb.toFixed(1)} KB (warn above 12 KB). Say WHAT and how it is checked; leave HOW to the worker.`);
      }
      item.dispatches = item.dispatches || [];
      // v0.15.2: a launch record without an agent is worthless — it cannot be
      // attributed, costed, or compared, and it used to surface as a phantom
      // '(agent not named)' row in telemetry. A mid-flight message inherits the
      // agent of the launch it follows: it is a message TO that worker.
      const lastLaunch = item.dispatches.filter(d => d.kind !== 'message').pop();
      let agent = opt('agent');
      let inherited = false;
      if (!agent && kind === 'message' && lastLaunch && lastLaunch.agent) { agent = lastLaunch.agent; inherited = true; }
      if (!agent)
        die(kind === 'launch'
          ? `Refused: dispatch needs --agent "<worker>" — an unattributed launch cannot be costed or compared.\n` +
            `  forge task dispatch ${item.id} --agent forge-implementer --note "<what it was handed>"`
          : `Refused: no launch on '${item.id}' to attach this message to (and no --agent given).\n` +
            `Record the launch first, or name the worker: forge task dispatch ${item.id} --kind message --agent <worker> --note "..."`);
      item.dispatches.push({ ts: ts(), agent, kind, inherited: inherited || undefined, model: opt('model') || undefined, note: opt('note') || null });
      item.updated = ts();
      saveWork(w);
      if (kind === 'launch' && !opt('model')) out(`NOTE: no --model recorded. Record the model the worker runs on (e.g. --model sonnet) — "which model did this item" is otherwise unanswerable.`);
      out(`${item.id} dispatch recorded → ${agent}${opt('model') ? ` [${opt('model')}]` : ''}${inherited ? ' (inherited from the last launch)' : ''}${kind === 'message' ? ' (mid-flight message)' : ''} (${item.dispatches.length} total on this item)`);

    } else die('Usage: forge task add|list|show|next|start|move|dispatch|verify|done|fail|block|cancel|update ...');
  },

  // -- brief ------------------------------------------------------------------
  brief() {
    const w = loadWork();
    const item = getItem(w, argv[1]);
    const cfg = loadConfig() || {};
    // v0.21 (C2): --context emits the forge-explorer prompt that assembles this task's context pack
    if (flag('context')) {
      if (!sw(cfg, 'contextPack')) { out(`Context packs are off for this project (options.contextPack). Turn them on: forge config set options.contextPack true`); return; }
      out(contextPackPrompt(item, cfg).join('\n'));
      return;
    }
    let lines = briefLines(item, cfg);
    // v0.21 (C3): a retry brief is the ORIGINAL brief plus the LATEST review findings — earlier passes are replaced, not stacked
    const bdir = path.join(FORGE, 'briefs');
    const bfile = path.join(bdir, `${item.id}.md`), ofile = path.join(bdir, `${item.id}.original.md`);
    const lastFail = [...(item.attempts || [])].reverse().find(a => a.outcome === 'failed' && a.kind !== 'provider');
    let text = lines.join('\n') + '\n';
    if (flag('save') && sw(cfg, 'retryFromReview') && lastFail) {
      if (!fs.existsSync(ofile) && fs.existsSync(bfile)) fs.writeFileSync(ofile, fs.readFileSync(bfile, 'utf8').replace(/\n## Fix these review findings[\s\S]*$/m, '\n'));
      const base = fs.existsSync(ofile) ? fs.readFileSync(ofile, 'utf8') : text;
      const fn = (item.attempts || []).filter(a => a.outcome === 'failed' && a.kind !== 'provider').length;
      text = base.replace(/\s*$/, '\n') + `\n## Fix these review findings (attempt ${fn + 1} — they replace any earlier retry notes)\n` +
        (lastFail.review ? lastFail.review.trim() : `- ${lastFail.note}`) + '\n';
    }
    if (flag('save')) {
      // v0.21 (C2): a brief that big is doing the worker's job — split, or move detail to the context pack
      const kb = Buffer.byteLength(text, 'utf8') / 1024;
      if (sw(cfg, 'briefLimit') === 'on' && kb > 20 && !opt('reason'))
        die(`Refused: the brief for '${item.id}' is ${kb.toFixed(1)} KB (limit 20 KB, options.briefLimit=on). Split the task, or move investigation into the context pack (forge brief ${item.id} --context). Override: --reason "…".`);
      fs.mkdirSync(bdir, { recursive: true });
      fs.writeFileSync(bfile, text);
      regenDashboard();
      out(`Saved skeleton to forge/briefs/${item.id}.md — COMPLETE IT IN PLACE (spec excerpts, decisions, domain pack) before dispatch.\n` +
          `The dashboard links it on the item's card, and dispatch prompts can reference the file path.`);
      if (sw(cfg, 'briefLimit') === 'on' && kb > 12) out(`BRIEF SIZE WARNING: ${kb.toFixed(1)} KB (warn above 12 KB, refused above 20 KB). Say what must be true and how it is checked; leave HOW to the worker.`);
    } else out(text.replace(/\n$/, ''));
  },

  // -- context (v0.21, C2/C9) — the context pack an explorer or architect records ---------
  // Explorers and architects are read-only on the codebase; they record their output here,
  // through the CLI, like every other Forge state write. Nothing else writes forge/context/.
  context() {
    const sub = argv[1], id = argv[2];
    if (sub !== 'save' || !id) die('Usage: forge context save <id> [--section design-note] < pack.md   (reads the pack from stdin)');
    const w = loadWork(); getItem(w, id);
    let body = ''; try { body = fs.readFileSync(0, 'utf8'); } catch (_) { }
    if (!body.trim()) die('Refused: empty context — pipe the pack on stdin.');
    fs.mkdirSync(CONTEXT_DIR, { recursive: true });
    const f = path.join(CONTEXT_DIR, `${id}.md`);
    if (opt('section') === 'design-note') {
      let cur = fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : `# Context pack — ${id}\n`;
      cur = cur.replace(/\n## Design note[\s\S]*?(?=\n## |$)/, '');
      const note = body.trim().replace(/^## Design note[^\n]*\n?/, '');
      fs.writeFileSync(f, cur.replace(/\s*$/, '\n') + `\n## Design note (forge-architect)\n${note}\n`);
    } else {
      const keep = fs.existsSync(f) ? ((fs.readFileSync(f, 'utf8').match(/\n## Design note[\s\S]*?(?=\n## |$)/) || [])[0] || '') : '';
      fs.writeFileSync(f, body.replace(/\s*$/, '\n') + keep);
    }
    out(`Saved forge/context/${id}.md (${Math.round(fs.statSync(f).size / 1024 * 10) / 10} KB). The next 'forge brief ${id} --save' references it.`);
  },

  // -- worker (v0.15, providers phase A) --------------------------------------
  // An API worker: executes ONE already-started item against an OpenAI-compatible
  // provider (default OpenRouter). The model runs in a tightly mediated loop —
  // it can read the repo, write ONLY inside the item's allowed scope, and run
  // ONLY the configured verify commands. Enforcement is in this code, not in
  // the prompt. The orchestrator stays in its own harness; this is how cheap
  // fast models take small, well-briefed items. Verification stays independent:
  // the worker cannot mark the item done.
  async worker() {
    const sub = argv[1];
    if (sub !== 'run') die('Usage: forge worker run <id> [--model <provider-model-id>] [--max-turns N]');
    const w = loadWork();
    const item = getItem(w, argv[2]);
    if (item.status !== 'IN_PROGRESS')
      die(`Refused: '${item.id}' is not IN_PROGRESS — every gate (criteria, deps, scope, concurrency, escalation) lives in 'task start'. Start it first.`);
    const cfg = loadConfig() || {};
    const prov = cfg.providers || {};
    const baseUrl = String(opt('url') || prov.url || 'https://openrouter.ai/api/v1').replace(/\/+$/, '');
    const model = opt('model') || prov.model;
    if (!model)
      die(`No worker model configured.\n  forge config set providers.model "<model-id>"   (any OpenRouter/OpenAI-compatible id)\nor pass --model. The orchestrator model is untouched by this — API workers are additive.`);
    const keyEnv = prov.keyEnv || 'OPENROUTER_API_KEY';
    const apiKey = process.env[keyEnv];
    if (!apiKey)
      die(`No API key: environment variable ${keyEnv} is not set. Keys are read from the environment and never stored on disk.\n  export ${keyEnv}=sk-...        (or name another variable: forge config set providers.keyEnv MY_VAR)`);
    const maxTurns = parseInt(opt('max-turns') || prov.maxTurns, 10) || 24;
    const reqTimeoutMs = parseInt(prov.requestTimeoutMs, 10) || 180000;
    const verifyCmds = cfg.verify || {};

    // The brief: the completed saved brief when it exists, else the generated skeleton.
    const briefFile = path.join(FORGE, 'briefs', `${item.id}.md`);
    const briefText = fs.existsSync(briefFile) ? fs.readFileSync(briefFile, 'utf8') : briefLines(item, cfg).join('\n');

    const ROOT = path.resolve(PROJECT);
    const relOf = (p) => {
      const rel = path.relative(ROOT, path.resolve(ROOT, String(p))).replace(/\\/g, '/');
      return (!rel || rel.startsWith('..') || path.isAbsolute(rel)) ? null : rel;
    };
    const SENSITIVE = /(^|\/)(\.env[^/]*|\.git|node_modules)(\/|$)/;
    const written = [];

    const tools = [
      { type: 'function', function: { name: 'read_file', description: 'Read a repository file (UTF-8; truncated beyond 48KB).', parameters: { type: 'object', properties: { path: { type: 'string', description: 'path relative to the project root' } }, required: ['path'] } } },
      { type: 'function', function: { name: 'list_dir', description: 'List a repository directory (directories end with /).', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } } },
      { type: 'function', function: { name: 'write_file', description: 'Create or overwrite ONE file. Writes are machine-refused outside the item\'s allowed scope — do not attempt them.', parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] } } },
      { type: 'function', function: { name: 'run_verify', description: `Run a configured project verification command. which: one of ${JSON.stringify(Object.keys(verifyCmds))} or "all". No other commands can be run.`, parameters: { type: 'object', properties: { which: { type: 'string' } }, required: ['which'] } } },
      { type: 'function', function: { name: 'done', description: 'Finish the attempt. Call with an honest summary when the criteria are satisfied — or with blocked=true and the exact blocker (spec hole, scope too narrow) if you cannot proceed.', parameters: { type: 'object', properties: { summary: { type: 'string' }, blocked: { type: 'boolean' } }, required: ['summary'] } } }
    ];

    const execTool = (name, args) => {
      if (name === 'read_file') {
        const rel = relOf(args.path);
        if (!rel) return `ERROR: path escapes the project root.`;
        if (SENSITIVE.test(rel)) return `ERROR: refused — sensitive path (${rel}).`;
        try {
          const buf = fs.readFileSync(path.join(ROOT, rel), 'utf8');
          return buf.length > 48 * 1024 ? buf.slice(0, 48 * 1024) + `\n...[truncated: file is ${buf.length} chars]` : buf;
        } catch (e) { return `ERROR: ${e.code || e.message}`; }
      }
      if (name === 'list_dir') {
        const rel = relOf(args.path || '.');
        if (rel === null) return `ERROR: path escapes the project root.`;
        try {
          const ents = fs.readdirSync(path.join(ROOT, rel || '.'), { withFileTypes: true })
            .filter(d => !SENSITIVE.test((rel ? rel + '/' : '') + d.name))
            .slice(0, 200).map(d => d.isDirectory() ? d.name + '/' : d.name);
          return ents.join('\n') || '(empty)';
        } catch (e) { return `ERROR: ${e.code || e.message}`; }
      }
      if (name === 'write_file') {
        const rel = relOf(args.path);
        if (!rel) return `ERROR: path escapes the project root.`;
        if (rel === 'forge' || rel.startsWith('forge/')) return `SCOPE GUARD: forge/ is orchestrator territory — workers never write Forge state.`;
        const hitF = ((item.scope || {}).forbidden || []).find(p => globMatch(rel, p));
        if (hitF) return `SCOPE GUARD: '${rel}' is in the FORBIDDEN scope of this item ('${hitF}') — the write is refused. If correctness requires it, call done with blocked=true and report.`;
        if (!(item.scope.allowed || []).some(p => globMatch(rel, p)))
          return `SCOPE GUARD: '${rel}' is OUTSIDE the allowed scope of this item (${item.scope.allowed.join(', ')}) — the write is refused. If correctness requires it, call done with blocked=true and report.`;
        try {
          fs.mkdirSync(path.dirname(path.join(ROOT, rel)), { recursive: true });
          fs.writeFileSync(path.join(ROOT, rel), String(args.content));
          if (!written.includes(rel)) written.push(rel);
          return `OK: wrote ${rel} (${String(args.content).length} chars)`;
        } catch (e) { return `ERROR: ${e.code || e.message}`; }
      }
      if (name === 'run_verify') {
        const keys = args.which === 'all' ? Object.keys(verifyCmds) : [args.which];
        if (!keys.length) return 'ERROR: no verification commands configured.';
        return keys.map(k => {
          if (!verifyCmds[k]) return `ERROR: '${k}' is not a configured verify command (${Object.keys(verifyCmds).join(', ') || 'none'}).`;
          const r = run(verifyCmds[k], { timeout: 300000 });
          return `[${k}] exit=${r.exit}\n${(r.tail || '').slice(-6000)}`;
        }).join('\n\n');
      }
      return `ERROR: unknown tool '${name}'.`;
    };

    const sys = [
      `You are a Forge API worker executing ONE work item in an existing codebase. You are not the architect and not the product owner.`,
      `Machine-enforced rules (not suggestions — the harness refuses violations):`,
      `- write_file works ONLY inside the item's allowed scope; forge/ and forbidden paths are refused.`,
      `- run_verify runs ONLY the project's configured verification commands.`,
      `- You cannot mark the item done; the orchestrator verifies your work independently afterwards.`,
      `Method: read what you need first; make focused changes; run_verify; iterate until the acceptance criteria pass; then call done with an honest summary (files changed, checks run, open questions).`,
      `If the brief has a hole or the scope is too narrow to do the work correctly: STOP and call done with blocked=true and the exact question — never invent product behavior, never work around the scope.`
    ].join('\n');

    const messages = [{ role: 'system', content: sys }, { role: 'user', content: briefText }];
    let tokIn = 0, tokOut = 0, turns = 0, finish = null;

    const providerDie = (detail) => {
      traceEvent({ outcome: 'provider-failure', item: item.id, model, detail: String(detail).slice(0, 200) });
      process.stderr.write(
        `PROVIDER FAILURE: ${detail}\nThis is the platform's fault, not the approach's. Record it WITHOUT burning the escalation ladder:\n` +
        `  forge task fail ${item.id} --kind provider --note "${String(detail).replace(/"/g, "'").slice(0, 120)}"\n` +
        `Then retry later, switch models (--model), or fall back to a Claude worker.\n`);
      process.exit(3);
    };

    const chat = async () => {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), reqTimeoutMs);
      let res;
      try {
        res = await fetch(baseUrl + '/chat/completions', {
          method: 'POST', signal: ctl.signal,
          headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
          body: JSON.stringify({ model, messages, tools, tool_choice: 'auto' })
        });
      } catch (e) {
        providerDie(`network/timeout error calling ${baseUrl}: ${e.name === 'AbortError' ? `no response within ${reqTimeoutMs}ms` : e.message}`);
      } finally { clearTimeout(timer); }
      if (res.status === 429 || res.status >= 500) providerDie(`HTTP ${res.status} from ${baseUrl}: ${(await res.text().catch(() => '')).slice(0, 300)}`);
      if (res.status === 401 || res.status === 403) die(`Provider auth error (HTTP ${res.status}): check ${keyEnv}. Keys are never stored by Forge — re-export and retry.`);
      if (!res.ok) die(`Provider rejected the request (HTTP ${res.status}): ${(await res.text().catch(() => '')).slice(0, 500)}`);
      const data = await res.json().catch(() => providerDie('unparseable JSON response'));
      if (data.usage) { tokIn += data.usage.prompt_tokens || 0; tokOut += data.usage.completion_tokens || 0; }
      return (data.choices && data.choices[0] && data.choices[0].message) || providerDie('response has no choices[0].message');
    };

    out(`API worker → ${item.id} via ${model} (${baseUrl}) — max ${maxTurns} turns, brief: ${fs.existsSync(briefFile) ? `forge/briefs/${item.id}.md` : 'generated skeleton'}`);
    while (turns < maxTurns && !finish) {
      turns++;
      const msg = await chat();
      messages.push(msg);
      const calls = msg.tool_calls || [];
      if (!calls.length) {
        messages.push({ role: 'user', content: 'Use the tools to act. When the work is complete (or blocked), call done.' });
        continue;
      }
      for (const c of calls) {
        let args = {}; try { args = JSON.parse(c.function.arguments || '{}'); } catch (_) { }
        if (c.function.name === 'done') {
          finish = { summary: String(args.summary || ''), blocked: !!args.blocked };
          messages.push({ role: 'tool', tool_call_id: c.id, content: 'acknowledged' });
          out(`[turn ${turns}] done${finish.blocked ? ' (BLOCKED)' : ''}`);
          break;
        }
        const result = execTool(c.function.name, args);
        out(`[turn ${turns}] ${c.function.name} ${String(args.path || args.which || '').slice(0, 80)}${String(result).startsWith('SCOPE GUARD') ? '  ← REFUSED (scope)' : ''}`);
        messages.push({ role: 'tool', tool_call_id: c.id, content: String(result) });
      }
    }

    // Record the dispatch in state (explicit lock — 'worker' loads read-only so the
    // lock is not held across minutes of API calls).
    acquireWorkLock();
    try {
      const w2 = readJson(WORK_FILE, { schema: 1, items: {}, order: [] });
      const it2 = w2.items[item.id];
      if (it2) {
        it2.dispatches = it2.dispatches || [];
        it2.dispatches.push({
          ts: ts(), agent: model, kind: 'api', turns, tokensIn: tokIn, tokensOut: tokOut,
          blocked: !!(finish && finish.blocked), filesWritten: written.slice(0, 50),
          note: finish ? finish.summary.slice(0, 500) : `turn cap (${maxTurns}) hit without done`
        });
        it2.updated = ts();
        writeJson(WORK_FILE, w2);
      }
    } finally { releaseWorkLock(); }
    regenDashboard();

    if (!finish)
      die(`Worker hit the turn cap (${maxTurns}) without calling done — that is a worker failure, not a provider failure.\n` +
          `  forge task fail ${item.id} --kind worker --note "turn cap: <what it was doing>"\n` +
          `Diagnose and narrow the brief before retrying; decompose if it cannot be narrowed.`);
    out(`\nWorker finished in ${turns} turn(s) — tokens in/out: ${tokIn.toLocaleString()}/${tokOut.toLocaleString()} — files written: ${written.length ? written.join(', ') : 'none'}`);
    out(`Worker summary: ${finish.summary || '(none given)'}`);
    if (finish.blocked)
      out(`\nWorker reports BLOCKED — resolve the blocker (spec/decision/scope), then re-dispatch or fall back to a Claude worker.\n  forge task fail ${item.id} --kind worker --note "blocked: ..."   or   forge task block ${item.id} --reason "..."`);
    else
      out(`\nThe worker's word proves nothing — verification stays independent:\n  forge task verify ${item.id}\n  forge task done ${item.id}   (only after verify passes)`);
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

  // -- components (v0.10; v0.19 routes into architecture / screens / tags) --------
  component() {
    const sub = argv[1];
    if (MUTATING) acquireWorkLock(); // v0.19.1: components.json writes are state writes
    const c = loadComps();
    if (sub === 'add' || sub === 'update') {
      const id = argv[2];
      if (!id || id.startsWith('--')) die('Usage: forge component add|update <id> [--name "..."] [--kind ...] [--route /path] [--mock spec/mocks/x.png] [--doc ...]\n(v0.19: prefer forge arch … for runtime parts and forge screen … for screens)');
      const cur = tagRef(c, id);
      if (sub === 'add' && cur) die(`'${id}' exists (${cur.type}) — use: forge component update ${id}`);
      if (sub === 'update' && !cur) die(`Unknown '${id}'. See: forge arch list · forge screen list`);
      const kind = opt('kind');
      // where does it belong? an existing entry stays where it is; a new one is routed by what it describes
      const type = cur ? cur.type
        : (opt('mock') || opt('route') || kind === 'frontend' || kind === 'screen') ? 'screen'
        : (kind && ARCH_KINDS.includes(kind)) ? 'component' : 'tag';
      const table = type === 'screen' ? c.screens : type === 'component' ? c.components : c.tags;
      const base = type === 'screen' ? { id, name: id, app: null, mock: null, route: null, doc: null, created: ts() }
        : type === 'component' ? { id, name: id, kind: kind || 'backend', runsOn: null, summary: null, evidence: [], confirmed: false, source: 'human', created: ts() }
        : { id, name: id, kind: kind || 'unspecified', created: ts() };
      const r = table[id] = Object.assign(base, table[id]);
      for (const k of ['name', 'route', 'mock', 'doc']) if (opt(k) !== null && (type === 'screen' || k === 'name' || k === 'doc')) r[k] = opt(k);
      if (kind !== null && type !== 'screen') r.kind = kind;
      r.updated = ts();
      saveComps(c);
      regenDashboard();
      out(`'${id}' ${sub === 'add' ? 'registered' : 'updated'} as ${type === 'component' ? 'an architecture part' : type === 'screen' ? 'a screen' : 'a tag'}. Tag work: forge task add ... --component ${id}` +
        (type === 'screen' && !r.app ? `\nAssign it to its app: forge screen update ${id} --app <architecture part>` : ''));
    } else if (sub === 'list') {
      const w = loadWork();
      const cnt = id => { const its = w.order.filter(i => w.items[i].component === id); return `${its.filter(i => w.items[i].status === 'DONE').length}/${its.length}`; };
      out(`Architecture parts (${Object.keys(c.components).length}) — forge arch list for detail`);
      for (const x of Object.values(c.components)) out(`  ${x.id} (${x.kind}${x.runsOn ? ` · ${x.runsOn}` : ''})${x.confirmed ? '' : ' · draft'} — ${cnt(x.id)} items`);
      out(`Screens (${Object.keys(c.screens).length}) — forge screen list for detail`);
      out(`Tags (${Object.keys(c.tags).length}): ${Object.values(c.tags).map(x => `${x.id} ${cnt(x.id)}`).join(' · ') || '—'}`);
    } else die('Usage: forge component add|update <id> [flags] | list   (v0.19: forge arch … · forge screen …)');
  },

  // -- architecture (v0.19) — runtime parts, where they run, who talks to whom ----
  arch() {
    const sub = argv[1];
    if (MUTATING) acquireWorkLock(); // v0.19.1: components.json writes are state writes
    const c = loadComps();
    const need = id => { if (!c.components[id]) die(`Unknown architecture part '${id}'. See: forge arch list`); return c.components[id]; };
    const setFields = (x) => {
      for (const [flagName, key] of [['name', 'name'], ['kind', 'kind'], ['runs-on', 'runsOn'], ['summary', 'summary'], ['doc', 'doc']])
        if (opt(flagName) !== null) x[key] = opt(flagName) || null;
      for (const e of optAll('evidence')) {
        const [p, ...why] = String(e).split('::');
        if (!x.evidence.some(v => v.path === p)) x.evidence.push({ path: p, why: why.join('::') || null });
      }
      if (flag('confirm')) { x.confirmed = true; x.confirmedTs = ts(); }
      x.updated = ts();
    };
    if (sub === 'add' || sub === 'update') {
      const id = argv[2];
      if (!id || id.startsWith('--')) die('Usage: forge arch add|update <id> --name "Member app" --kind frontend|backend|db|auth|job|storage|hosting|integration --runs-on "Browser" [--summary "..."] [--evidence path::why]... [--confirm]');
      if (sub === 'add' && tagRef(c, id)) die(`'${id}' already exists (${tagRef(c, id).type}). Use: forge arch update ${id}`);
      if (sub === 'update') need(id);
      const x = c.components[id] = c.components[id] || { id, name: id, kind: 'backend', runsOn: null, summary: null, evidence: [], confirmed: false, source: process.env.FORGE_UPGRADE ? 'agent' : 'human', created: ts() };
      setFields(x);
      if (x.kind && !ARCH_KINDS.includes(x.kind)) out(`Note: kind '${x.kind}' is not one of ${ARCH_KINDS.join(', ')} — it is drawn in the neutral colour.`);
      saveComps(c); regenDashboard();
      out(`Architecture part '${id}' ${sub === 'add' ? 'added' : 'updated'} — ${x.name} (${x.kind}${x.runsOn ? ` · runs on ${x.runsOn}` : ' · runs on: not set'})${x.confirmed ? ' · confirmed' : ' · draft'}`);
    } else if (sub === 'link' || sub === 'unlink') {
      const from = argv[2], to = argv[3];
      if (!from || !to || from.startsWith('--') || to.startsWith('--')) die(`Usage: forge arch ${sub} <from> <to>${sub === 'link' ? ' --label "supabase-js · sign-in" [--planned] [--confirm]' : ''}`);
      need(from); need(to);
      const i = c.edges.findIndex(e => e.from === from && e.to === to);
      if (sub === 'unlink') { if (i < 0) die(`No link ${from} → ${to}.`); c.edges.splice(i, 1); saveComps(c); regenDashboard(); out(`Unlinked ${from} → ${to}.`); return; }
      const e = i >= 0 ? c.edges[i] : { from, to, label: null, planned: false, confirmed: false, source: process.env.FORGE_UPGRADE ? 'agent' : 'human', created: ts() };
      if (opt('label') !== null) e.label = opt('label') || null;
      if (flag('planned')) e.planned = true;
      if (flag('built')) e.planned = false;
      if (flag('confirm')) e.confirmed = true;
      if (i < 0) c.edges.push(e);
      saveComps(c); regenDashboard();
      out(`${i < 0 ? 'Linked' : 'Updated'} ${from} → ${to}${e.label ? ` (${e.label})` : ''}${e.planned ? ' · planned' : ''}.`);
    } else if (sub === 'confirm') {
      const ids = flag('all') ? Object.keys(c.components) : argv.slice(2).filter(a => !a.startsWith('--'));
      if (!ids.length) die('Usage: forge arch confirm <id>... | --all   (records that YOU checked the drawing against reality)');
      for (const id of ids) { const x = need(id); x.confirmed = true; x.confirmedTs = ts(); }
      for (const e of c.edges) if (ids.includes(e.from) && ids.includes(e.to)) e.confirmed = true;
      saveComps(c); regenDashboard();
      out(`Confirmed ${ids.length} part(s)${flag('all') ? ' and every link between them' : ' and the links among them'}.`);
    } else if (sub === 'remove') {
      const id = argv[2]; need(id);
      const w = loadWork();
      const tagged = w.order.filter(i => w.items[i].component === id);
      if (tagged.length && !opt('reason')) die(`Refused: ${tagged.length} item(s) are tagged '${id}' (${tagged.slice(0, 4).join(', ')}…). Re-tag them first, or pass --reason to keep the tags as plain tags.`);
      if (tagged.length) c.tags[id] = { id, name: c.components[id].name, kind: c.components[id].kind, created: ts() };
      delete c.components[id];
      c.edges = c.edges.filter(e => e.from !== id && e.to !== id);
      for (const s of Object.values(c.screens)) if (s.app === id) s.app = null;
      saveComps(c); regenDashboard();
      out(`Removed architecture part '${id}' and its links.${tagged.length ? ' Its items keep the tag (now a plain tag).' : ''}`);
    } else if (sub === 'lanes') {
      const v = argv[2];
      if (!v || v.startsWith('--')) { out(`Lane order: ${laneOrder(c).join(' → ') || '—'}${c.lanes ? ' (pinned)' : ' (derived: Browser first, external services last)'}`); return; }
      c.lanes = v === 'auto' ? null : v.split(',').map(s => s.trim()).filter(Boolean);
      saveComps(c); regenDashboard();
      out(`Lane order ${c.lanes ? 'pinned' : 'derived'}: ${laneOrder(c).join(' → ')}`);
    } else if (sub === 'scan') {
      // in a dry run the state is a throwaway copy but the code to read is the real repo (read-only)
      const res = archScan(process.env.FORGE_SCAN_ROOT || PROJECT);
      if (flag('json')) { out(JSON.stringify(res, null, 2)); return; }
      out(`# Architecture scan — evidence from the repo (${res.scanned} files read, zero tokens)`);
      out(`A proposal, not a finding: names and splits are for the agent pass; confirmation is yours.\n`);
      const byLane = {};
      for (const x of res.components) (byLane[x.runsOn] = byLane[x.runsOn] || []).push(x);
      const tmp = emptyComps(); for (const x of res.components) tmp.components[x.id] = x;
      for (const lane of laneOrder(tmp)) {
        out(`${lane}`);
        for (const x of byLane[lane] || []) out(`  ${x.id} — ${x.name} (${x.kind})${x.confidence !== 'high' ? ` · ${x.confidence} confidence` : ''}\n      ${x.evidence.slice(0, 3).map(e => `${e.path}${e.why ? ` — ${e.why}` : ''}`).join('\n      ')}`);
      }
      if (res.edges.length) { out('\nLinks'); for (const e of res.edges) out(`  ${e.from} → ${e.to}${e.label ? ` (${e.label})` : ''}${e.confidence !== 'high' ? ` · ${e.confidence}` : ''}`); }
      if (res.notes.length) { out('\nNotes'); for (const n of res.notes) out(`  ${n}`); }
      if (!flag('write')) { out(`\nNothing written. Record as drafts: forge arch scan --write`); return; }
      let added = 0, merged = 0;
      for (const x of res.components) {
        const ex = c.components[x.id];
        if (ex) { for (const ev of x.evidence) if (!ex.evidence.some(v => v.path === ev.path && v.why === ev.why)) { ex.evidence.push(ev); merged++; } if (!ex.runsOn) ex.runsOn = x.runsOn; continue; }
        if (c.screens[x.id] || c.tags[x.id]) continue; // never shadow an existing screen/tag id
        c.components[x.id] = { id: x.id, name: x.name, kind: x.kind, runsOn: x.runsOn, summary: null, evidence: x.evidence, confirmed: false, source: 'scan', confidence: x.confidence, created: ts(), updated: ts() };
        added++;
      }
      let linked = 0;
      for (const e of res.edges) if (c.components[e.from] && c.components[e.to] && !c.edges.some(y => y.from === e.from && y.to === e.to)) { c.edges.push({ from: e.from, to: e.to, label: e.label, planned: false, confirmed: false, source: 'scan', created: ts() }); linked++; }
      saveComps(c); regenDashboard();
      out(`\nWritten as drafts: ${added} new part(s), ${linked} link(s), ${merged} evidence line(s) merged into existing parts. Confirmed parts were not changed.` +
        `\nNext: name, split and link them (forge arch update/link), assign screens (forge screen assign <app> …), then: forge arch confirm --all`);
    } else if (sub === 'list' || !sub) {
      const w = loadWork();
      if (flag('json')) { out(JSON.stringify(c, null, 2)); return; }
      const parts = Object.values(c.components);
      if (!parts.length) { out('No architecture recorded. Draft it from the repo: forge arch scan (then --write).'); return; }
      const cnt = id => { const its = w.order.filter(i => archOfTag(c, w.items[i].component) === id); return `${its.filter(i => w.items[i].status === 'DONE').length}/${its.length}`; };
      for (const lane of laneOrder(c)) {
        out(lane);
        for (const x of parts.filter(p => (p.runsOn || 'Unplaced') === lane)) {
          const outE = c.edges.filter(e => e.from === x.id).map(e => `${e.to}${e.label ? ` (${e.label})` : ''}${e.planned ? ' planned' : ''}`);
          const scr = Object.values(c.screens).filter(s => s.app === x.id).length;
          out(`  ${x.confirmed ? '✓' : '·'} ${x.id} — ${x.name} (${x.kind}) · ${cnt(x.id)} items${scr ? ` · ${scr} screen(s)` : ''}${outE.length ? `\n      → ${outE.join(', ')}` : ''}`);
        }
      }
      out(`\n✓ confirmed · draft. ${parts.filter(x => !x.confirmed).length} draft part(s).`);
    } else die('Usage: forge arch scan [--write|--json] | list [--json] | add|update <id> [flags] | link|unlink <from> <to> | confirm <id>…|--all | remove <id> | lanes [a,b,…|auto]');
  },

  // -- screens (v0.19) — UI screens and their mocks, each belonging to an app -----
  screen() {
    const sub = argv[1];
    if (MUTATING) acquireWorkLock(); // v0.19.1: components.json writes are state writes
    const c = loadComps();
    if (sub === 'add' || sub === 'update') {
      const id = argv[2];
      if (!id || id.startsWith('--')) die('Usage: forge screen add|update <id> [--name "..."] [--app <architecture part>] [--mock spec/mocks/x.png] [--route /path] [--doc ...]');
      if (sub === 'add' && tagRef(c, id)) die(`'${id}' already exists (${tagRef(c, id).type}). Use: forge screen update ${id}`);
      if (sub === 'update' && !c.screens[id]) die(`Unknown screen '${id}'. See: forge screen list`);
      const s = c.screens[id] = c.screens[id] || { id, name: id, app: null, mock: null, route: null, doc: null, created: ts() };
      for (const k of ['name', 'mock', 'route', 'doc']) if (opt(k) !== null) s[k] = opt(k) || null;
      if (opt('app') !== null) {
        const a = opt('app') === 'none' ? null : (opt('app') || null);
        if (a && !c.components[a]) die(`Unknown app '${a}' — screens belong to an architecture part (or --app none for a standalone page such as a journey map). See: forge arch list`);
        s.app = a; s.standalone = opt('app') === 'none';
      }
      s.updated = ts();
      saveComps(c); regenDashboard();
      out(`Screen '${id}' ${sub === 'add' ? 'added' : 'updated'}${s.app ? ` — in ${c.components[s.app].name}` : ' — not assigned to an app yet'}.`);
    } else if (sub === 'assign') {
      const app = argv[2];
      if (!app || app.startsWith('--')) die('Usage: forge screen assign <app> <screen>... | --match "<regex on id or name>"');
      if (app !== 'none' && !c.components[app]) die(`Unknown app '${app}'. See: forge arch list`);
      let ids = argv.slice(3).filter(a => !a.startsWith('--') && a !== opt('match'));
      if (opt('match')) { let re; try { re = new RegExp(opt('match'), 'i'); } catch (e) { die(`Bad --match: ${e.message}`); } ids = ids.concat(Object.values(c.screens).filter(s => re.test(s.id) || re.test(s.name || '')).map(s => s.id)); }
      ids = [...new Set(ids)];
      const unknown = ids.filter(i => !c.screens[i]);
      if (unknown.length) die(`Unknown screen(s): ${unknown.join(', ')} — nothing assigned.`);
      if (!ids.length) die('No screens matched — nothing assigned.');
      for (const i of ids) { c.screens[i].app = app === 'none' ? null : app; c.screens[i].standalone = app === 'none'; c.screens[i].updated = ts(); }
      saveComps(c); regenDashboard();
      out(`${ids.length} screen(s) → ${app === 'none' ? 'standalone (in no app, on purpose)' : c.components[app].name}: ${ids.slice(0, 10).join(', ')}${ids.length > 10 ? '…' : ''}`);
    } else if (sub === 'list' || !sub) {
      const w = loadWork();
      const all = Object.values(c.screens);
      if (!all.length) { out('No screens registered.'); return; }
      const groups = {};
      for (const s of all) (groups[s.app || ''] = groups[s.app || ''] || []).push(s);
      for (const [app, ss] of Object.entries(groups).sort((a, b) => (a[0] ? 0 : 1) - (b[0] ? 0 : 1))) {
        out(`${app ? `${c.components[app] ? c.components[app].name : app} (${app})` : 'Not assigned to an app'} — ${ss.length}`);
        for (const s of ss) { const its = w.order.filter(i => w.items[i].component === s.id); out(`  ${s.id}${s.name && s.name !== s.id ? ` — ${s.name}` : ''}${s.route ? ` · ${s.route}` : ''}${s.mock ? ' · mock' : ''} · ${its.filter(i => w.items[i].status === 'DONE').length}/${its.length} items`); }
      }
    } else die('Usage: forge screen add|update <id> [flags] | assign <app> <id>…|--match re | list');
  },

  // -- autopilot (v0.20) — keep building between tasks; stop only for a human -------
  autopilot() {
    const sub = argv[1] || 'status';
    const cfg = loadConfig();
    if (!cfg) die('No forge/config.json. Run: forge init');
    const w = loadWork(); ensureMilestones(w);
    if (sub === 'on') {
      cfg.options = cfg.options || {};
      cfg.options.autopilot = 'on';
      if (opt('max-items') !== null) cfg.options.autopilotMaxItems = parseInt(opt('max-items'), 10) || 0;
      if (opt('hours') !== null) cfg.options.autopilotMaxHours = parseFloat(opt('hours')) || 0;
      writeJson(CONFIG_FILE, cfg);
      writeJson(AUTOPILOT_FILE, { since: ts(), startDone: doneCount(w), continues: 0, nudges: 0 });
      traceEvent({ outcome: 'autopilot-on', maxItems: cfg.options.autopilotMaxItems || 0, maxHours: cfg.options.autopilotMaxHours || 0 });
      regenDashboard();
      const ap = autopilotCfg(cfg);
      const d = autopilotDecision(w, cfg, readJson(AUTOPILOT_FILE, {}));
      out(`Autopilot ON${ap.maxItems ? ` · stops after ${ap.maxItems} task(s)` : ''}${ap.maxHours ? ` · stops after ${ap.maxHours}h` : ''}.`);
      out(`It keeps taking the next task of the current milestone and stops only for you: milestone ready to test, a question, an escalation, nothing startable, a run limit, or no progress.`);
      out(d.go ? `Next: ${d.label} — ${d.next.title}` : `Right now it would stop: ${d.reason}`);
      out(`\nTo follow it from your phone:\n  1. run the session with Remote Control:  claude --remote-control   (or /remote-control inside a session)\n  2. in /config enable "Push when actions required" and "Push when Claude decides"\n  3. keep the Mac awake while it runs:      caffeinate -i\n  4. make sure the build loop's commands are allowed without prompts — any permission prompt pauses the run until you answer it\nThen say "continue" in the session. Turn it off with: forge autopilot off`);
    } else if (sub === 'off') {
      cfg.options = cfg.options || {};
      cfg.options.autopilot = 'off';
      writeJson(CONFIG_FILE, cfg);
      const run = readJson(AUTOPILOT_FILE, {});
      writeJson(AUTOPILOT_FILE, Object.assign(run, { stopped: { kind: 'user', reason: opt('reason') || 'turned off', ts: ts() } }));
      traceEvent({ outcome: 'autopilot-off', reason: opt('reason') || null });
      regenDashboard();
      out('Autopilot OFF — the session stops after each task again.');
    } else if (sub === 'status') {
      const ap = autopilotCfg(cfg); const run = readJson(AUTOPILOT_FILE, {});
      out(`Autopilot: ${ap.on ? 'ON' : 'off'}${ap.maxItems ? ` · max ${ap.maxItems} task(s)` : ''}${ap.maxHours ? ` · max ${ap.maxHours}h` : ''}`);
      if (run.since) out(`  run since ${run.since.slice(0, 16).replace('T', ' ')} · ${doneCount(w) - (run.startDone || 0)} task(s) done · ${run.continues || 0} continue(s)`);
      if (run.stopped) out(`  last stop: ${run.stopped.kind} — ${run.stopped.reason} (${String(run.stopped.ts).slice(0, 16).replace('T', ' ')})`);
      const d = autopilotDecision(w, cfg, run);
      out(d.go ? `  now: would continue with ${d.label} — ${d.next.title}` : `  now: would stop — ${d.reason}`);
    } else die('Usage: forge autopilot on [--max-items N] [--hours H] | off [--reason ..] | status');
  },

  // -- upgrade (v0.19) — bring this plan to the installed Forge's standards --------
  upgrade() {
    const sub = argv[1] && !argv[1].startsWith('--') ? argv[1] : 'status';
    const scriptArg = () => {
      const s = argv[2];
      if (!s || s.startsWith('--')) die(`Usage: forge upgrade ${sub} forge/changes/<date>-upgrade-<step>.sh`);
      const abs = path.resolve(PROJECT, s);
      if (!fs.existsSync(abs)) die(`No such script: ${s}`);
      return { abs, rel: path.relative(PROJECT, abs).split(path.sep).join('/'), text: fs.readFileSync(abs, 'utf8') };
    };
    if (sub === 'status') {
      const st = upgradeStatus();
      if (flag('json')) { out(JSON.stringify({ forge: VERSION, steps: st }, null, 2)); return; }
      const met = st.filter(s => s.done).length;
      out(`# Forge upgrade — plan standards of Forge v${VERSION}: ${met}/${st.length} met`);
      for (const s of st) {
        out(`  ${s.done ? '✓' : s.kind === 'auto' ? '✗' : '!'} ${s.id} (since ${s.since}, ${s.kind === 'auto' ? 'automatic' : 'needs judgement'}) — ${s.title}${s.accepted ? ` · accepted as-is: ${s.accepted.reason}` : ''}`);
        for (const f of s.findings) out(`      - ${f}`);
      }
      const autoLeft = st.filter(s => !s.done && s.kind === 'auto');
      const revLeft = st.filter(s => !s.done && s.kind === 'review');
      if (!autoLeft.length && !revLeft.length) { out('\nThis plan meets every standard of the installed Forge.'); return; }
      out('\nNext:');
      if (autoLeft.length) out(`  forge upgrade apply   — ${autoLeft.length} automatic step(s); state is backed up first`);
      for (const s of revLeft) out(`  ${s.id}: ${s.how}\n     → the agent writes forge/changes/<date>-upgrade-${s.id}.sh; you review it with: forge upgrade dry-run <script>; then: forge upgrade run <script>\n     → or keep the plan as it is: forge upgrade accept ${s.id} --reason "..."`);
      return;
    }
    if (sub === 'apply') {
      const st = upgradeStatus().filter(s => !s.done && s.kind === 'auto');
      if (!st.length) { out('No automatic steps pending. forge upgrade shows what is left.'); return; }
      const backup = backupState('apply');
      const w = loadWork();
      for (const s of st) UPGRADE_STEPS.find(x => x.id === s.id).apply({ w });
      (w.upgrade = w.upgrade || { history: [], accepted: {} }).history = (w.upgrade.history || []).concat([{ ts: ts(), kind: 'apply', steps: st.map(s => s.id), backup, forge: VERSION }]);
      saveWork(w);
      w.upgrade.history[w.upgrade.history.length - 1].postState = stateSha();
      writeJson(WORK_FILE, w);
      traceEvent({ outcome: 'upgrade-apply', steps: st.map(s => s.id), backup });
      out(`Applied ${st.length} automatic step(s): ${st.map(s => s.id).join(', ')}. Backup: ${backup} (forge upgrade revert restores it).`);
      const left = upgradeStatus().filter(s => !s.done);
      if (left.length) out(`Still open (needs judgement): ${left.map(s => s.id).join(', ')} — forge upgrade shows how.`);
      return;
    }
    if (sub === 'accept') {
      const id = argv[2]; const s = UPGRADE_STEPS.find(x => x.id === id);
      if (!s) die(`Unknown step '${id}'. Steps: ${UPGRADE_STEPS.map(x => x.id).join(', ')}`);
      if (s.kind === 'auto') die(`'${id}' is automatic — apply it (forge upgrade apply); there is nothing to judge.`);
      if (!opt('reason')) die('Refused: accepting a step as-is needs --reason "..." — it is recorded as your decision.');
      const w = loadWork();
      w.upgrade = w.upgrade || { history: [], accepted: {} };
      w.upgrade.accepted = Object.assign({}, w.upgrade.accepted, { [id]: { ts: ts(), reason: opt('reason'), forge: VERSION } });
      saveWork(w);
      appendMd(DECISIONS_FILE, '# Decisions log (append-only, via forge CLI)', `\n### ${ts()} — upgrade: keep '${id}' as it is\n- Authority: human\n- Decision: the plan stays as it is for the '${id}' standard\n- Why: ${opt('reason')}\n`);
      out(`Recorded: '${id}' accepted as-is.`);
      return;
    }
    if (sub === 'dry-run') {
      const s = scriptArg();
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-upgrade-'));
      try {
        fs.mkdirSync(path.join(tmp, 'forge', 'state'), { recursive: true });
        for (const f of [CONFIG_FILE, WORK_FILE, COMPONENTS_FILE, DECISIONS_FILE, DISCOVERIES_FILE])
          if (fs.existsSync(f)) fs.copyFileSync(f, path.join(tmp, path.relative(PROJECT, f)));
        const before = planShape(normalizeWorkForShape(readJson(WORK_FILE, { items: {}, order: [] })), loadComps());
        const r = runChangeScript(s.abs, tmp);
        const wAfter = readJson(path.join(tmp, 'forge', 'state', 'work.json'), { items: {}, order: [] });
        const cAfter = normalizeComps(readJson(path.join(tmp, 'forge', 'state', 'components.json'), null));
        const after = planShape(normalizeWorkForShape(wAfter), cAfter);
        const d = diffShape(before, after);
        out(`# Dry run of ${s.rel} on a throwaway copy of this project's state`);
        out(`Script exit: ${r.code}${r.code === 0 ? ' (ok)' : ' — FAILED'}`);
        if (r.out) out('\n--- script output ---\n' + r.out.split('\n').slice(-60).join('\n') + '\n---------------------');
        out('\nWhat would change:');
        out(d.lines.length ? d.lines.map(l => '  ' + l).join('\n') : '  nothing');
        if (d.danger.length) out('\n⚠ Touches work history (never expected from an upgrade):\n' + d.danger.map(l => '  ' + l).join('\n'));
        const ok = r.code === 0 && !d.danger.length;
        const rec = readJson(UPGRADE_FILE, { dryRuns: [] });
        rec.dryRuns = (rec.dryRuns || []).filter(x => x.script !== s.rel).concat([{ script: s.rel, scriptSha: sha(s.text), stateSha: stateSha(), ok, ts: ts() }]).slice(-20);
        writeJson(UPGRADE_FILE, rec);
        out(ok ? `\nLooks safe. Apply it for real: forge upgrade run ${s.rel}` : `\nNot applicable as it stands — fix the script and dry-run again.`);
        if (!ok) process.exitCode = 1;
      } finally { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) { } }
      return;
    }
    if (sub === 'run') {
      const s = scriptArg();
      const rec = readJson(UPGRADE_FILE, { dryRuns: [] });
      const dr = (rec.dryRuns || []).find(x => x.script === s.rel);
      if (!dr || dr.scriptSha !== sha(s.text)) die(`Refused: dry-run this exact script first — forge upgrade dry-run ${s.rel}`);
      if (!dr.ok) die(`Refused: the last dry-run of this script failed or touched work history. Fix it and dry-run again.`);
      if (dr.stateSha !== stateSha() && !flag('force')) die(`Refused: the plan changed since the dry-run (${dr.ts}). Dry-run again so what you reviewed is what runs.`);
      const backup = backupState(path.basename(s.rel, '.sh'));
      const step = (s.text.match(/^#\s*forge-upgrade-step:\s*([\w-]+)/m) || [])[1] || null;
      // v0.19.1: the run is recorded BEFORE it starts, so a run that is killed part-way can still be reverted
      const record = patch => {
        acquireWorkLock();
        const w0 = readJson(WORK_FILE, { items: {}, order: [] });
        w0.upgrade = w0.upgrade || { history: [], accepted: {} };
        const h = w0.upgrade.history = w0.upgrade.history || [];
        const i = h.findIndex(x => x.kind === 'run' && x.backup === backup);
        if (i < 0) h.push(Object.assign({ ts: ts(), kind: 'run', script: s.rel, step, ok: null, backup, forge: VERSION }, patch));
        else Object.assign(h[i], patch);
        writeJson(WORK_FILE, w0);
        releaseWorkLock();
      };
      record({});
      const r = runChangeScript(s.abs, PROJECT);
      out(r.out);
      record({ ok: r.code === 0 });
      record({ postState: stateSha() });
      regenDashboard();
      traceEvent({ outcome: r.code === 0 ? 'upgrade-run' : 'upgrade-run-failed', script: s.rel, step, backup });
      appendMd(DECISIONS_FILE, '# Decisions log (append-only, via forge CLI)', `\n### ${ts()} — upgrade${step ? ` '${step}'` : ''}: ${s.rel}\n- Authority: human\n- Decision: applied the reviewed change script ${s.rel}${r.code === 0 ? '' : ' (it FAILED part-way)'}\n- Why: bring the plan to the standards of Forge v${VERSION}; backup ${backup}\n`);
      if (r.code !== 0) die(`\nThe script failed part-way (exit ${r.code}). State is partly changed. Restore it: forge upgrade revert`);
      out(`\nApplied. Backup: ${backup} — forge upgrade revert restores it while nothing else has changed.`);
      const left = upgradeStatus().filter(x => !x.done);
      out(left.length ? `Still open: ${left.map(x => x.id).join(', ')} — forge upgrade` : 'This plan now meets every standard of the installed Forge.');
      return;
    }
    if (sub === 'revert') {
      const w = readJson(WORK_FILE, { items: {}, order: [] });
      const hist = ((w.upgrade || {}).history || []).filter(h => h.backup && h.kind !== 'revert');
      const last = hist[hist.length - 1];
      if (!last) die('Nothing to revert — no upgrade with a backup is recorded.');
      if (last.postState && last.postState !== stateSha() && !flag('force'))
        die(`Refused: the plan changed after that upgrade (${last.ts}); reverting would silently drop those changes too.\nInspect with forge upgrade, or pass --force to restore ${last.backup} anyway.`);
      acquireWorkLock();
      const bdir = path.join(PROJECT, last.backup);
      for (const f of [WORK_FILE, COMPONENTS_FILE, CONFIG_FILE]) {
        const b = path.join(bdir, path.basename(f));
        if (fs.existsSync(b)) fs.copyFileSync(b, f);
        else if (f === COMPONENTS_FILE && fs.existsSync(f)) fs.unlinkSync(f); // it did not exist before
      }
      const w2 = readJson(WORK_FILE, { items: {}, order: [] });
      w2.upgrade = w2.upgrade || { history: [], accepted: {} };
      w2.upgrade.history = (w2.upgrade.history || []).concat([{ ts: ts(), kind: 'revert', of: last.script || last.steps, backup: last.backup, forge: VERSION }]);
      writeJson(WORK_FILE, w2);
      regenDashboard();
      traceEvent({ outcome: 'upgrade-revert', backup: last.backup });
      out(`Restored ${last.backup} (the state before ${last.script || 'upgrade apply'}).`);
      return;
    }
    die('Usage: forge upgrade [status] [--json] | apply | accept <step> --reason "..." | dry-run <script> | run <script> | revert [--force]');
  },

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
    // v0.17: where the milestone's work lives in git
    if (cfg && perMilestone(cfg)) {
      const gc = gitCfg(cfg);
      const am = activeMilestone(w);
      const cur = currentBranch();
      let line = `\nGit flow: per-milestone · base ${gc.base || 'NOT SET (forge config set options.baseBranch <branch>)'} · on ${cur || '?'}`;
      if (am && gc.base) {
        const b = milestoneBranch(cfg, am);
        const ahead = git(['rev-list', '--count', `${gc.base}..${b}`]);
        line += ` · active milestone ${versionOf(w, am) || ''} ${am} → ${b}${cur === b ? '' : ' (NOT checked out)'}${ahead.code === 0 ? ` · ${ahead.out} commit(s) ahead of ${gc.base}` : ''}`;
      }
      out(line);
      for (const m of milestoneSeq(w)) { const sh = ((w.gates || {})[m] || {}).ship; if (sh) out(`  ${m}: PR ${sh.pr}`); }
    } else if (cfg) out(`\nGit flow: manual (Forge runs no git — recorded opt-out)`);
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
      // v0.21 (C10): one line per delegation switch — absent means off (today's behaviour)
      try {
        const c = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
        for (const k of Object.keys(SWITCH_ON)) {
          const raw = ((c.options || {})[k]);
          check(`switch ${k}`, true, `${JSON.stringify(sw(c, k))}${raw === undefined ? ' (not set — off; new projects start with ' + JSON.stringify(SWITCH_ON[k]) + ': forge config set options.' + k + ' ' + SWITCH_ON[k] + ')' : ''}`);
        }
      } catch (_) { }
      // v0.21 (C6): parallel tasks + a shared local database: verifies are serialised by the verify lock
      try {
        const c = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
        const conc = parseInt((c.options || {}).concurrency, 10) || 1;
        const shared = !!((c.verify || {}).db || (c.verify || {}).e2e) || fs.existsSync(path.join(PROJECT, 'supabase'));
        if (conc > 1 && shared) check('parallel verify', false, `concurrency ${conc} with a shared local database/servers — verifies run one at a time under forge/state/verify.lock (a second one waits); tests must still isolate their own data, because implementers run in parallel`, true);
      } catch (_) { }
      try {
        const w = JSON.parse(fs.readFileSync(WORK_FILE, 'utf8'));
        const inProg = w.order.filter(id => w.items[id].status === 'IN_PROGRESS');
        check('work.json', true, `${w.order.length} items · ${inProg.length} IN_PROGRESS`);
        // v0.17: git flow — the default changed; existing projects are told what to confirm
        try {
          const c2 = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
          const gc2 = gitCfg(c2);
          if (gc2.integration === 'per-milestone' && !gc2.base)
            check('git flow', false, `v0.17 makes the per-milestone git flow Forge's default (one branch per milestone, one commit per item by 'task done', one PR per milestone by 'milestone ship'). Confirm the base branch: forge config set options.baseBranch <branch> — or opt out: forge config set options.integration manual --reason "..."`, true);
          else check('git flow', true, gc2.integration === 'per-milestone' ? `per-milestone · base ${gc2.base}` : 'manual (recorded opt-out)');
          const st2 = staleStateProblems();
          if (st2.length) check('append-only history', false, st2.join(' | '), true);
        } catch (_) { }
        // v0.19: plan standards of this Forge version
        try { const us = upgradeStatus(); const open = us.filter(x => !x.done);
          check('plan standards', !open.length, open.length ? `${us.length - open.length}/${us.length} met — open: ${open.map(x => x.id).join(', ')} (forge upgrade)` : `${us.length}/${us.length} met`, true); } catch (_) { }
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
      // v0.16: first-pass forgives a re-start or a failed verify run; clean-run does not.
      // The spread between them is rework the process was not recording.
      const cleanRun = done.filter(i =>
        i.attempts.filter(a => a.outcome === 'started').length === 1 &&
        failsOf(i) === 0 &&
        !(i.verifications || []).some(v => v.passed === false)).length;
      out(`  Clean-run rate:  ${cleanRun}/${done.length} (${Math.round(100 * cleanRun / done.length)}%) — one start, zero failed attempts, zero failed verify runs`);
      out(`  Failed attempts absorbed: ${totalFails} · avg ${(totalFails / done.length).toFixed(2)} per completed item`);
      { const sc = done.filter(i => i.selfClosed).length; if (sc || sw(loadConfig(), 'requireDispatch')) out(`  Closed by the CTO (--self): ${sc}/${done.length}${sc ? ' — ' + done.filter(i => i.selfClosed).slice(0, 6).map(i => i.id).join(', ') : ''}`); }
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

    // v0.16: cost and speed, from the usage cache (no transcript parsing here)
    {
      const c2 = readJson(USAGE_CACHE, null);
      if (c2 && c2.models) {
        const M = usageMetrics(c2, done.length);
        out(`\n## Efficiency (from the last usage scan)`);
        out(`  Context re-read per DONE item: ${fmtBig(M.perItem ? M.perItem.context : null)} · model calls per item: ${M.perItem ? Math.round(M.perItem.calls) : '—'} · output per item: ${fmtBig(M.perItem ? M.perItem.out : null)}`);
        if (M.dispatches) out(`  Calls per worker dispatch: median ${M.callsPerDispatch.median} · p90 ${M.callsPerDispatch.p90} · max ${M.callsPerDispatch.max}`);
        const sinceS = usageSince(M, readJson(USAGE_BASELINE, null));
        if (sinceS && sinceS.vs)
          out(`  Since baseline${sinceS.label ? ` '${sinceS.label}'` : ''} (${sinceS.done} item(s)): calls ${sinceS.vs.calls > 0 ? '+' : ''}${sinceS.vs.calls}% · context ${sinceS.vs.context > 0 ? '+' : ''}${sinceS.vs.context}% · output ${sinceS.vs.out > 0 ? '+' : ''}${sinceS.vs.out}%`);
        out(`  Full detail: forge usage`);
      }
    }

    // milestones
    // v0.17: the explicit milestone order (v0.16.2), not first appearance
    const ms = milestoneSeq(w);
    if (ms.length) {
      out(`\n## Milestones`);
      for (const m of ms) {
        const mi = items.filter(i => i.milestone === m);
        const mdone = mi.filter(i => i.status === 'DONE').length;
        const mfails = mi.reduce((a, i) => a + failsOf(i), 0);
        const g = (w.gates || {})[m];
        out(`  ${versionOf(w, m) ? versionOf(w, m) + ' ' : ''}${milestoneLabel(w, m)}: ${mdone}/${mi.length} done · ${mfails} failed attempt(s) · gate: ` +
            (g && g.approved ? `approved ${g.ts.slice(0, 10)}` : (mdone === mi.length ? 'COMPLETE — awaiting human review' : 'pending')));
      }
    }
    out(`\nCaveat: elapsed times are wall-clock spans between recorded state transitions, not effort. ` +
        `Token/dispatch telemetry lives in 'forge usage'.`);
  },

  // -- usage (v0.4) — OBSERVED telemetry from local Claude Code session logs ------
  usage() {
    // v0.15.2: shares the incremental engine with the dashboard's auto-refresh.
    // Run manually for the full report; --rescan rebuilds from scratch (also
    // re-ties dispatches to work items added since the last scan).
    const c = collectUsage({ budgetMs: 0, rescan: flag('rescan') });
    if (!c) die(`UNAVAILABLE: no Claude Code session logs for this project.\n` +
                `(Logs appear under ~/.claude/projects after Claude Code sessions run in ${PROJECT}.)`);

    out(`# Forge usage — OBSERVED from local session logs (never estimated)`);
    out(`Source: ${(c.dirs || []).join(', ')}`);
    out(`Sessions: ${c.sessions || 0} · window: ${c.firstTs ? c.firstTs.slice(0, 16) : '?'} → ${c.lastTs ? c.lastTs.slice(0, 16) : '?'}`);
    out(`\n## Tokens by model and thread (main = orchestrator, side = dispatched subagents)`);
    let mainOut = 0, sideOut = 0;
    for (const [model, threads] of Object.entries(c.models)) {
      for (const [thread, t] of Object.entries(threads)) {
        if (thread === 'main') mainOut += t.out; else if (thread === 'side') sideOut += t.out;
        out(`  ${model} [${thread}]: ${t.calls} calls · in ${t.in.toLocaleString()} · out ${t.out.toLocaleString()} · cache write ${t.cacheCreate.toLocaleString()} / read ${t.cacheRead.toLocaleString()}`);
      }
    }
    if (M0ext(c)) out(`  [external] = sessions started by another program through the Agent SDK (entrypoint sdk-*) in this project folder — not Forge's orchestrator or workers, and not in any cost-per-item figure.`);
    for (const ov of olderVersions(Object.keys(c.models).filter(n => Object.keys(c.models[n]).some(th => th !== 'external'))))
      out(`  Versions seen (${ov.family}): newest ${ov.newest} · older ${ov.older.join(', ')} — see the segment block below for whether an older one is still running`);
    const totOut = mainOut + sideOut;
    out(`\n## Delegation`);
    if (sideOut === 0 && c.dispatches > 0)
      out(`  Output tokens — orchestrator: ${mainOut.toLocaleString()} · subagents: UNAVAILABLE\n` +
          `  (dispatches exist but no subagent-thread usage appears in these logs — this Claude Code version\n` +
          `   likely stores worker transcripts elsewhere; token split by thread cannot be observed here)`);
    else
      out(`  Output tokens — orchestrator: ${mainOut.toLocaleString()} · subagents: ${sideOut.toLocaleString()}` +
          (totOut ? ` · ${Math.round(100 * sideOut / totOut)}% delegated` : ''));
    const byType = c.byType || {};
    const forgeCount = Object.entries(byType).filter(([k]) => k.includes('forge-')).reduce((a, [, v]) => a + v, 0);
    out(`  Dispatches: ${c.dispatches} total — ` +
        (Object.keys(byType).length ? Object.entries(byType).map(([k, v]) => `${k}×${v}`).join(' · ') : 'NONE'));
    if (c.dispatches)
      out(`  Through forge roster: ${forgeCount}/${c.dispatches}` +
          (forgeCount < c.dispatches ? '  ← work is bypassing the forge agents (built-in/other types above)' : ''));
    else
      out(`  ← ZERO dispatches: the orchestrator is doing all work itself in the main thread.`);
    out(`  Tied to work items (inline brief, brief file path, or known item id in prompt): ` +
        (c.tied ? Object.entries(c.perItem).map(([k, v]) => `${k}×${v}`).join(' · ') : 'none') +
        (c.dispatches - c.tied ? ` · ${c.dispatches - c.tied} dispatch(es) could not be tied to any work item` : '') +
        (c.tied ? ` · ties are resolved when a transcript is first scanned — forge usage --rescan re-ties everything` : ''));

    // v0.12: dispatch records from state (forge task dispatch) — authoritative
    // when present; the transcript inference above remains the fallback for old logs.
    try {
      const wU = readJson(WORK_FILE, { items: {}, order: [] });
      const dByAgent = {}; let dTotal = 0, dMsg = 0, dItems = 0;
      for (const id of wU.order) {
        const ds = wU.items[id].dispatches || [];
        if (ds.length) dItems++;
        let lastAgent = null;
        for (const d3 of ds) {
          dTotal++; if (d3.kind === 'message') dMsg++;
          // v0.15.2: a mid-flight message inherits the agent of the launch it
          // followed — it is a message TO that worker, not a new participant.
          if (d3.kind !== 'message' && d3.agent) lastAgent = d3.agent;
          const a = d3.agent || (d3.kind === 'message' ? lastAgent : null) || '(agent not named)';
          dByAgent[a] = (dByAgent[a] || 0) + 1;
        }
      }
      // v0.17: item-less dispatches (explore / review / security / advise) and models
      const dByModel = {}; const dByPurpose = {};
      for (const id of wU.order) for (const d3 of (wU.items[id].dispatches || [])) if (d3.kind !== 'message') dByModel[d3.model || '(model not recorded)'] = (dByModel[d3.model || '(model not recorded)'] || 0) + 1;
      for (const d4 of (wU.dispatchLog || [])) {
        dTotal++; dByAgent[d4.agent] = (dByAgent[d4.agent] || 0) + 1;
        dByPurpose[d4.purpose] = (dByPurpose[d4.purpose] || 0) + 1;
        dByModel[d4.model || '(model not recorded)'] = (dByModel[d4.model || '(model not recorded)'] || 0) + 1;
      }
      if (Object.keys(dByPurpose).length) out(`  Item-less dispatches (forge dispatch): ${Object.entries(dByPurpose).map(([k, v]) => `${k}×${v}`).join(' · ')}`);
      if (Object.keys(dByModel).length) out(`  Dispatches by recorded model: ${Object.entries(dByModel).map(([k, v]) => `${k}×${v}`).join(' · ')}`);
      if (dTotal)
        out(`  Dispatch records in state (forge task dispatch — authoritative): ${dTotal} across ${dItems} item(s)` +
            (dMsg ? ` · ${dMsg} mid-flight message(s)` : '') + ` — ` +
            Object.entries(dByAgent).map(([k, v]) => `${k}×${v}`).join(' · '));
    } catch (_) { /* no work file */ }

    // drift: tokens spent after the last forge state change. Only files touched
    // since that moment can contain later entries, so the rest are skipped.
    try {
      const stateM = fs.statSync(WORK_FILE).mtime.toISOString();
      const stateMs = Date.parse(stateM);
      let after = 0;
      for (const { f } of usageFiles(c.dirs || [])) {
        let st; try { st = fs.statSync(f); } catch (_) { continue; }
        if (st.mtimeMs < stateMs) continue;
        for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
          if (!line.includes('"assistant"')) continue;
          let d2; try { d2 = JSON.parse(line); } catch (_) { continue; }
          if (d2.type === 'assistant' && d2.timestamp > stateM && d2.message && d2.message.usage)
            after += d2.message.usage.output_tokens || 0;
        }
      }
      out(`\n## Progress vs spend`);
      out(`  Last forge state change: ${stateM.slice(0, 16)} · output tokens spent SINCE then: ${after.toLocaleString()}`);
      if (after > 20000) out(`  ← significant spend with no state movement: work may be happening outside the forge loop. Check what the session is doing.`);
    } catch (_) { /* no work file */ }

    // v0.16: the numbers that track cost and speed
    const doneNow = (() => { try { const w2 = readJson(WORK_FILE, { items: {}, order: [] });
      return w2.order.filter(id => w2.items[id].status === 'DONE').length; } catch (_) { return 0; } })();
    const M = usageMetrics(c, doneNow);
    out(`\n## Efficiency — what actually drives quota and wall-clock`);
    out(`  Context re-read: ${fmtBig(M.cacheRead)} cache-read + ${fmtBig(M.cacheCreate)} cache-write + ${fmtBig(M.inTok)} fresh input`);
    out(`  Generated: ${fmtBig(M.outTok)} output tokens — ratio context:output = ${M.outTok ? Math.round(M.context / M.outTok) : '—'}:1`);
    out(`  Model calls: ${M.calls.toLocaleString()} (${M.mainCalls.toLocaleString()} orchestrator · ${M.sideCalls.toLocaleString()} workers)`);
    if (M.perItem)
      out(`  PER DONE ITEM (${M.done} done): ${Math.round(M.perItem.calls)} calls · ${fmtBig(M.perItem.context)} context · ${fmtBig(M.perItem.out)} output`);
    if (M.dispatches)
      out(`  Calls per worker dispatch (${M.dispatches} worker transcripts): median ${M.callsPerDispatch.median} · p90 ${M.callsPerDispatch.p90} · max ${M.callsPerDispatch.max}` +
          (M.worstDispatches.length ? `\n    heaviest: ${M.worstDispatches.join(' · ')}` : '') +
          `\n    A worker running far past its median is exploring, not building — the brief did not tell it where to look.`);
    const base0 = readJson(USAGE_BASELINE, null);
    const since = usageSince(M, base0);
    if (since) {
      out(`\n## Since baseline${since.label ? ` '${since.label}'` : ''} (${String(since.ts).slice(0, 16).replace('T', ' ')})`);
      out(`  ${since.done} item(s) completed since — per item: ${Math.round(since.calls)} calls · ${fmtBig(since.context)} context · ${fmtBig(since.out)} output`);
      if (since.vs)
        out(`  vs baseline: calls ${since.vs.calls > 0 ? '+' : ''}${since.vs.calls}% · context ${since.vs.context > 0 ? '+' : ''}${since.vs.context}% · output ${since.vs.out > 0 ? '+' : ''}${since.vs.out}%`);
      if (since.defsChanged)
        out(`  ⚠ This baseline was recorded with an older way of counting (before v0.17.1 it counted external SDK sessions as Forge's cost; before v0.21 it counted every transcript line as a call — 2–7 lines per real call). The delta above mixes two definitions — re-record: forge usage --baseline --label <name>`);
      if (since.external && since.external.calls > 0)
        out(`  External sessions in this segment (not Forge — started through the Agent SDK by another tool): ${since.external.calls.toLocaleString()} calls · ${fmtBig(since.external.context)} context — excluded from the per-item cost above`);
      if (since.byModelUnavailable)
        out(`  (per-model split unavailable: this baseline predates v0.16.1 — re-run 'forge usage --baseline' to enable it)`);
      if (since.byModel) {
        const rows = Object.entries(since.byModel).sort((a, b) => b[1].context - a[1].context);
        const tC = rows.reduce((n, [, e]) => n + e.calls, 0) || 1;
        const tX = rows.reduce((n, [, e]) => n + e.context, 0) || 1;
        out(`  By model in this segment — context re-read is what the quota actually buys:`);
        for (const [name, e] of rows) {
          const role = e.mainCalls && e.sideCalls ? 'both' : (e.mainCalls ? 'orchestrator' : 'workers');
          out(`    ${name.padEnd(22)}${String(e.calls.toLocaleString()).padStart(7)} calls ${String(Math.round(100 * e.calls / tC)).padStart(3)}%` +
              ` · ${fmtBig(e.context).padStart(7)} ctx ${String(Math.round(100 * e.context / tX)).padStart(3)}%` +
              ` · ${fmtBig(e.out).padStart(6)} out · ${fmtBig(e.calls ? e.context / e.calls : 0).padStart(6)}/call · ${role}`);
        }
        // v0.17: an older version of a family ran beside a newer one in this segment
        for (const ov of olderVersions(rows.filter(([, e]) => e.calls > 0).map(([n]) => n)))
          out(`  ⚠ OLDER ${ov.family.toUpperCase()} VERSION IN THIS SEGMENT: ${ov.older.map(n => `${n} (${since.byModel[n].calls} calls, ${since.byModel[n].mainCalls ? 'incl. orchestrator' : 'workers'})`).join(', ')} ran beside ${ov.newest}.\n` +
              `    Something resolved to an old model: an agent's 'model:' alias, a session /model, or an ANTHROPIC_DEFAULT_*_MODEL variable.`);
        if (since.mixedMain)
          out(`  ⚠ More than one orchestrator model ran in this segment. A code change and a model change are entangled here:\n` +
              `    the per-item delta above cannot be credited to either one. Re-baseline at the next gate and change one thing at a time.`);
      }
    } else if (base0) {
      out(`\n## Since baseline${base0.label ? ` '${base0.label}'` : ''}: no items completed yet — the comparison appears after the first DONE.`);
    }

    if (flag('baseline')) {
      const snap = Object.assign({ ts: ts(), label: opt('label') || null }, M);
      writeJson(USAGE_BASELINE, snap);
      out(`\nBASELINE RECORDED${opt('label') ? ` as '${opt('label')}'` : ''} — forge/state/usage-baseline.json`);
      out(`Everything from here is measured against it: run 'forge usage' after the next milestone to see per-item calls, context and output for the new regime.`);
    }

    out(`\n## Activity by day (output tokens)`);
    for (const [day, v] of Object.entries(c.byDay).sort())
      out(`  ${day}: ${'█'.repeat(Math.min(40, Math.ceil(v / 2000)))} ${v.toLocaleString()}`);
    out(`\nCaveats: per-agent-type token attribution inside subagent threads is not exposed by the logs (reported in aggregate as [side]); ` +
        `milestone-level token attribution is not reliably derivable and is therefore not shown. Absent data is absent, never estimated.`);
    // v0.15.2: the snapshot the dashboard reads is refreshed automatically on
    // every regen — writing it here just makes the manual run authoritative too.
    writeJson(USAGE_FILE, usageSnapshot(c));
    out(`\nSnapshot updated: forge/state/usage.json (the dashboard also refreshes this by itself — ${flag('write') ? '--write is no longer required' : 'no --write needed'}).`);
  },

  // -- dispatch (v0.17) — a dispatch with no work item is still a dispatch ---------
  // Measured: ~30 explorer/reviewer/architect dispatches per project were invisible to
  // state because 'task dispatch' requires an IN_PROGRESS item.
  dispatch() {
    const w = loadWork();
    const agent = opt('agent'), purpose = opt('purpose');
    const PURPOSES = ['explore', 'review', 'security', 'advise', 'test', 'other'];
    if (!agent || !purpose || !PURPOSES.includes(purpose))
      die(`Usage: forge dispatch --agent <worker> --purpose ${PURPOSES.join('|')} [--model <m>] [--item <id>] [--milestone <m>] [--note "..."]\n` +
          `(A launch that implements a work item is 'forge task dispatch <id>' instead.)`);
    if (opt('item') && !w.items[opt('item')]) die(`No work item '${opt('item')}'.`);
    w.dispatchLog = w.dispatchLog || [];
    w.dispatchLog.push({ ts: ts(), agent, purpose, model: opt('model') || undefined, item: opt('item') || undefined, milestone: opt('milestone') || undefined, note: opt('note') || null });
    saveWork(w);
    out(`Dispatch recorded → ${agent}${opt('model') ? ` [${opt('model')}]` : ''} (${purpose})${opt('item') ? ` about ${opt('item')}` : ''} — ${w.dispatchLog.length} item-less dispatch(es) in this project.`);
  },

  // -- releases (v0.18) — the version level above milestones: V0 (MVP), V1, V2 … ---
  release() {
    const sub = argv[1];
    const w = loadWork();
    ensureMilestones(w);
    const order = w.releaseOrder;
    const L = () => computeLabels(w);
    if (!sub || sub === 'list') {
      const lab = L();
      out(`Version start: V${versionStart()} (options.versionStart)`);
      if (!order.length) out('No releases yet: forge release add <id> --name "MVP"');
      for (const r of order) {
        const ms = w.milestoneOrder.filter(m => releaseOf(w, m) === r);
        const appr = ms.filter(m => ((w.gates || {})[m] || {}).approved).length;
        out(`  ${lab.releaseLabel[r].padEnd(5)} ${r}: ${w.releases[r].name || '(unnamed)'} — ${ms.length} milestone(s), ${appr} approved${w.releases[r].num != null ? ' · number frozen' : ''}${w.releases[r].tag ? ` · tagged ${w.releases[r].tag}` : ''}`);
        for (const m of ms) out(`        ${lab.milestone[m].padEnd(7)} ${m}: ${milestoneName(w, m) || '(unnamed)'}`);
      }
      const loose = w.milestoneOrder.filter(m => !releaseOf(w, m));
      if (order.length && loose.length) out(`  (no release) ${loose.join(', ')} — assign: forge milestone update <m> --release <R>`);
      return;
    }
    if (sub === 'add') {
      const r = argv[2];
      if (!r || r.startsWith('--')) die('Usage: forge release add <id> --name "..." [--before|--after <R>]');
      if (w.releases[r]) die(`Release '${r}' already exists.`);
      const anchor = opt('before') || opt('after');
      if (anchor && !w.releases[anchor]) die(`Unknown release '${anchor}'.`);
      const at = opt('before') ? order.indexOf(anchor) : anchor ? order.indexOf(anchor) + 1 : order.length;
      const lastLocked = order.reduce((acc, x, i) => w.releases[x].num != null ? i : acc, -1);
      if (at <= lastLocked) die(`Refused: a new release cannot go before one whose number is already frozen ('${order[lastLocked]}').`);
      w.releases[r] = { id: r, name: opt('name') || null, created: ts(), history: [] };
      order.splice(at, 0, r);
      saveWork(w);
      out(`Release ${L().releaseLabel[r]} added: ${r}${opt('name') ? ` — ${opt('name')}` : ''}`);
      return;
    }
    if (!w.releases[argv[2]] && sub !== 'freeze') die(`Unknown release '${argv[2] || ''}'. See: forge release list`);
    const r = argv[2];
    if (sub === 'update') {
      if (opt('name') === null) die('Usage: forge release update <id> --name "..."');
      w.releases[r].history = w.releases[r].history || [];
      w.releases[r].history.push({ ts: ts(), change: `name: '${w.releases[r].name || ''}' → '${opt('name')}'`, reason: opt('reason') || null });
      w.releases[r].name = opt('name');
      saveWork(w); out(`Release ${r} renamed: ${opt('name')}`);
    } else if (sub === 'move') {
      const target = opt('before') || opt('after');
      if (!target || !w.releases[target] || target === r) die('Usage: forge release move <id> --before|--after <R> --reason "..."');
      if (!opt('reason')) die('A reorder is a product decision — record why: --reason "..."');
      if (w.releases[r].num != null) die(`Refused: release '${r}' has started — its number is frozen.`);
      const was = order.slice();
      const next = order.filter(x => x !== r);
      next.splice(opt('before') ? next.indexOf(target) : next.indexOf(target) + 1, 0, r);
      const lastLocked = next.reduce((acc, x, i) => (x !== r && w.releases[x].num != null) ? i : acc, -1);
      if (next.indexOf(r) <= lastLocked) die(`Refused: '${r}' would move ahead of release '${next[lastLocked]}', which has started.`);
      const labBefore = L();
      w.releaseOrder = next;
      const trial = ensureMilestones(w).slice();
      const bad = milestoneOrderViolations(w, trial);
      if (bad.length) { w.releaseOrder = was; ensureMilestones(w);
        die(`Refused: moving release '${r}' breaks ${bad.length} dependenc${bad.length === 1 ? 'y' : 'ies'}:\n` + bad.slice(0, 12).map(v => `  - ${v.item} (${v.itemM}) depends on ${v.dep} (${v.depM})`).join('\n')); }
      w.releases[r].history = w.releases[r].history || [];
      w.releases[r].history.push({ ts: ts(), change: `moved ${opt('before') ? 'before' : 'after'} ${target}`, reason: opt('reason') });
      saveWork(w);
      appendMd(DECISIONS_FILE, '# Decisions log (append-only, via forge CLI)',
        `\n### ${ts()} — Release '${r}' reordered\n- Authority: human\n- Decision: moved ${opt('before') ? 'before' : 'after'} '${target}' (${labBefore.releaseLabel[r]} → ${L().releaseLabel[r]})\n- Why: ${opt('reason')}\n`);
      out(`Release ${r}: ${labBefore.releaseLabel[r]} → ${L().releaseLabel[r]}; every unstarted milestone and task after it renumbered.`);
    } else if (sub === 'remove') {
      if (!opt('reason')) die('Removing a release must be explicit: --reason "..."');
      const ms = w.milestoneOrder.filter(m => releaseOf(w, m) === r);
      if (ms.length) die(`Refused: release '${r}' still holds milestone(s): ${ms.join(', ')}.`);
      if (w.releases[r].num != null) die(`Refused: release '${r}' has a frozen number — it is history.`);
      delete w.releases[r]; w.releaseOrder = order.filter(x => x !== r);
      saveWork(w); out(`Release ${r} removed.`);
    } else if (sub === 'freeze') {
      // migration of an existing project: assign releases FIRST, then freeze started work
      freezeLabels(w); saveWork(w);
      const lab = L();
      const frozenM = w.milestoneOrder.filter(m => w.milestones[m].label);
      out(`Frozen: ${frozenM.length} started milestone(s) (${frozenM.map(m => `${m}=${lab.milestone[m]}`).join(', ') || 'none'}), ` +
          `${Object.values(w.items).filter(t => t.label).length} started task(s).`);
    } else if (sub === 'tag') {
      const cfgT = loadConfig() || {};
      const gc = gitCfg(cfgT);
      const ms = milestoneSeq(w).filter(m => releaseOf(w, m) === r);
      const pending = ms.filter(m => !((w.gates || {})[m] || {}).approved);
      if (!ms.length || pending.length) die(`Refused: release '${r}' is not complete${pending.length ? ` — unapproved: ${pending.join(', ')}` : ' (no milestones)'}.`);
      const num = L().release[r];
      const tag = `v${num}.0.0`;
      if (!perMilestone(cfgT) || !gc.base) { out(`Tag it (Forge runs no git in this project):\n  git tag -a ${tag} -m "Release V${num} — ${w.releases[r].name || r}" <commit> && git push origin ${tag}`); return; }
      const remote = hasRemote(cfgT) ? gc.remote : null;
      if (remote) git(['fetch', remote, gc.base]);
      const ref = remote ? `${remote}/${gc.base}` : gc.base;
      const unmerged = ms.filter(m => { const sh = (w.gates[m] || {}).ship; return !sh || git(['merge-base', '--is-ancestor', sh.head, ref]).code !== 0; });
      if (unmerged.length) die(`Refused: not every milestone of '${r}' is merged into '${gc.base}': ${unmerged.join(', ')} (ship and merge their PRs first).`);
      if (git(['rev-parse', '--verify', '--quiet', `refs/tags/${tag}`]).code === 0) die(`Refused: tag ${tag} already exists.`);
      const tg = git(['tag', '-a', tag, ref, '-m', `Release V${num} — ${w.releases[r].name || r}`]);
      if (tg.code !== 0) die(`Refused: git tag failed: ${tg.err}`);
      if (remote) { const pt = git(['push', remote, tag]); if (pt.code !== 0) die(`Tag ${tag} created locally but the push failed: ${pt.err}`); }
      w.releases[r].tag = tag; saveWork(w);
      out(`Release V${num} tagged ${tag} on ${ref}${remote ? ' and pushed' : ''}.`);
    } else die('Usage: forge release list | add <id> --name ".." [--before|--after <R>] | update <id> --name ".." | move <id> --before|--after <R> --reason ".." | remove <id> --reason ".." | freeze | tag <id>');
  },

  // -- milestone gates (F9) -------------------------------------------------------
  milestone() {
    const sub = argv[1];
    const w = loadWork();
    w.gates = w.gates || {};
    const order = ensureMilestones(w);
    if (sub === 'list') {
      const cfg = loadConfig() || {};
      out(`Gating mode: ${(cfg.options || {}).gates || 'per-milestone'}`);
      order.forEach((m, i) => {
        const r = w.milestones[m];
        const items = w.order.filter(id => w.items[id].milestone === m);
        const done = items.filter(id => ['DONE', 'CANCELLED'].includes(w.items[id].status)).length;
        const g = w.gates[m];
        const state = !items.length ? 'no items yet'
          : g && g.approved ? `APPROVED ${g.ts}${g.note ? ` — ${g.note}` : ''}`
          : (milestoneComplete(w, m) ? 'COMPLETE — AWAITING HUMAN APPROVAL' : milestoneStarted(w, m) ? 'in progress' : 'not started');
        out(`  ${String(computeLabels(w).milestone[m]).padEnd(7)} ${m}${r.release ? ` [${r.release}]` : ''}: ${r.name ? r.name : '(UNNAMED — forge milestone update ' + m + ' --name "...")'}`);
        out(`      ${done}/${items.length} items · ${state}${g && g.commits ? ` · commits ${g.commits.base.slice(0, 7)}..${g.commits.head.slice(0, 7)} (${g.commits.count})` : ''}`);
        if (r.demo) out(`      demo: ${r.demo}`);
      });
      const unnamed = order.filter(m => !w.milestones[m].name);
      if (unnamed.length) out(`\n${unnamed.length} milestone(s) unnamed. A milestone is named after the feature it enables.`);
    } else if (sub === 'add') {
      const m = argv[2];
      if (!m || m.startsWith('--')) die('Usage: forge milestone add <id> --name "<feature it enables>" [--demo "<how to try it>"] [--before <M> | --after <M>]');
      if (w.milestones[m]) die(`Milestone '${m}' already exists (add is not an update): forge milestone update ${m} ...`);
      if (!opt('name')) die(`Refused: a milestone needs --name — the feature it enables, in the user's terms ("Customers can reorder a past box").`);
      const anchor = opt('before') || opt('after');
      if (anchor && !w.milestones[anchor]) die(`Unknown milestone '${anchor}'. See: forge milestone list`);
      if (opt('release') && !(w.releases || {})[opt('release')]) die(`Unknown release '${opt('release')}'. See: forge release list`);
      w.milestones[m] = { id: m, name: opt('name'), demo: opt('demo') || null, release: opt('release') || null, created: ts(), history: [] };
      const at = opt('before') ? order.indexOf(opt('before')) : opt('after') ? order.indexOf(opt('after')) + 1 : order.length;
      if (anchor && at <= order.findLastIndex(x => milestoneStarted(w, x) || ((w.gates[x] || {}).approved)))
        die(`Refused: '${m}' would sit before a milestone that has already started or been approved. New milestones go after the work in flight.`);
      order.splice(at, 0, m);
      saveWork(w);
      out(`Milestone ${m} added at position ${at + 1}: ${opt('name')}`);
      const nw = milestoneNameWarning(opt('name')); if (nw) out(`NAME WARNING: ${nw}`);
      if (!opt('demo')) out(`Add its demo criterion — the command to run it and what to try: forge milestone update ${m} --demo "..."`);
    } else if (sub === 'update') {
      const m = argv[2];
      const r = w.milestones[m];
      if (!r) die(`Unknown milestone '${m || ''}'. See: forge milestone list`);
      const changes = [];
      if (opt('name') !== null) { changes.push(`name: '${r.name || ''}' → '${opt('name')}'`); r.name = opt('name'); delete r.unnamed; }
      if (opt('demo') !== null) { changes.push(`demo updated`); r.demo = opt('demo'); }
      if (opt('release') !== null) {
        const nr = opt('release') === 'none' ? null : opt('release');
        if (nr && !(w.releases || {})[nr]) die(`Unknown release '${nr}'. See: forge release list`);
        if (r.label && nr !== (r.release || null)) die(`Refused: '${m}' has started and carries version ${r.label} — it stays in its release.`);
        const was = r.release || null;
        r.release = nr;
        const trial = ensureMilestones(w).slice();
        const bad = milestoneOrderViolations(w, trial);
        if (bad.length) { r.release = was; ensureMilestones(w);
          die(`Refused: putting '${m}' in ${nr || 'no release'} breaks ${bad.length} dependenc${bad.length === 1 ? 'y' : 'ies'}:\n` + bad.slice(0, 12).map(v => `  - ${v.item} (${v.itemM}) depends on ${v.dep} (${v.depM})`).join('\n')); }
        const lockedIdx = trial.reduce((acc, x, i) => (x !== m && (milestoneStarted(w, x) || ((w.gates || {})[x] || {}).approved)) ? i : acc, -1);
        if (trial.indexOf(m) < lockedIdx && !milestoneStarted(w, m)) { r.release = was; ensureMilestones(w);
          die(`Refused: that release sits before work that has already started ('${trial[lockedIdx]}') — '${m}' would jump ahead of it.`); }
        changes.push(`release: ${was || 'none'} → ${nr || 'none'}`);
      }
      if (!changes.length) die('Nothing to update: forge milestone update <id> --name "..." [--demo "..."] [--reason "..."]');
      (r.history = r.history || []).push({ ts: ts(), change: changes.join('; '), reason: opt('reason') || null });
      saveWork(w);
      out(`Milestone ${m} updated:\n` + changes.map(c => `  - ${c}`).join('\n'));
      const nw = milestoneNameWarning(r.name); if (nw && opt('name') !== null) out(`NAME WARNING: ${nw}`);
    } else if (sub === 'branch') {
      // v0.17: create or switch to a milestone's branch, safely
      const cfgB = loadConfig() || {};
      const gc = gitCfg(cfgB);
      const m = argv[2];
      if (!w.milestones[m]) die(`Unknown milestone '${m || ''}'. See: forge milestone list`);
      if (!perMilestone(cfgB)) die(`options.integration is '${gc.integration}' — Forge runs no git in this project.`);
      if (!gc.base) die(`Set the base branch first: forge config set options.baseBranch <branch>`);
      const b = milestoneBranch(cfgB, m);
      const cur = currentBranch();
      if (cur !== b) {
        const dirty = changedPaths().filter(c => !isForgePath(c.path));
        if (dirty.length) die(`Refused: uncommitted changes outside forge/ would travel to '${b}':\n` + dirty.slice(0, 12).map(c => `  - ${c.path}`).join('\n') + `\nCommit them with their item, or stash them, first.`);
        const remote = hasRemote(cfgB) ? gc.remote : null;
        if (remote) git(['fetch', remote]);
        let sw;
        if (branchExists(b)) sw = git(['switch', b]);
        else if (remote && git(['rev-parse', '--verify', '--quiet', `refs/remotes/${remote}/${b}`]).code === 0) sw = git(['switch', '-c', b, '--track', `${remote}/${b}`]);
        else {
          const start = remote && git(['rev-parse', '--verify', '--quiet', `refs/remotes/${remote}/${gc.base}`]).code === 0 ? `${remote}/${gc.base}` : gc.base;
          sw = git(['switch', '--no-track', '-c', b, start]);
        }
        if (sw.code !== 0) die(`Refused: git could not switch to '${b}':\n${sw.err}\n(Forge files modified in the working tree differ from the target — commit them on the current branch first.)`);
        out(`On ${b}${branchExists(b) ? '' : ''} (base: ${gc.base}).`);
      } else out(`Already on ${b}.`);
      const bad = staleStateProblems();
      if (bad.length) out(`\n⚠ ${staleStateMessage(bad).replace(/^Refused: /, '')}`);
      return;
    } else if (sub === 'ship') {
      // v0.17: one PR per milestone, opened at the gate, merged with a merge commit
      const cfgS = loadConfig() || {};
      const gc = gitCfg(cfgS);
      const m = argv[2];
      if (!w.milestones[m]) die(`Unknown milestone '${m || ''}'. See: forge milestone list`);
      if (!perMilestone(cfgS)) die(`options.integration is '${gc.integration}' — ship is part of the per-milestone git flow.`);
      if (!gc.base) die(`Set the base branch first: forge config set options.baseBranch <branch>`);
      if (/^(main|master|prod|production)$/i.test(gc.base)) die(`Refused: base branch '${gc.base}' is a production branch — Forge never ships straight to production.`);
      const g = w.gates[m] || {};
      if (!g.approved) die(`Refused: milestone '${m}' is not approved. ship comes after the human gate: forge milestone approve ${m} --note "..."`);
      const b = milestoneBranch(cfgS, m);
      if (currentBranch() !== b) die(`Refused: switch to the milestone branch first: git switch ${b}`);
      const bad = staleStateProblems();
      if (bad.length) die(staleStateMessage(bad));
      // commit the gate record (approval, security note) that the approve step left in forge/
      {
        const stray = changedPaths().filter(c => !isForgePath(c.path));
        if (stray.length) die(`Refused: uncommitted changes outside forge/ on '${b}':\n` + stray.slice(0, 12).map(c => `  - ${c.path}`).join('\n') + `\nEvery change ships inside an item commit.`);
        const ff = changedPaths().map(c => c.path).filter(isAuthoritative);
        if (ff.length) {
          const a = git(['add', '-A', '--', ...ff]);
          const c = a.code === 0 ? git(['commit', '-m', `milestone ${m}: gate record`]) : a;
          if (c.code !== 0) die(`Refused: committing the gate record failed:\n${c.err || c.out}`);
        }
      }
      const remote = hasRemote(cfgS) ? gc.remote : null;
      if (!remote) die(`Refused: no '${gc.remote}' remote — a milestone PR needs a pushed branch.`);
      const push = git(['push', '-u', remote, b]);
      if (push.code !== 0) die(`Refused: pushing '${b}' failed:\n${push.err}`);
      git(['fetch', remote, gc.base]);
      const range = `${remote}/${gc.base}..${b}`;
      const log = git(['log', '--no-merges', '--format=%H%x09%s', range]);
      if (log.code !== 0) die(`Refused: cannot read ${range}: ${log.err}`);
      const commits = log.out ? log.out.split('\n').map(l => { const [sha, ...rest] = l.split('\t'); return { sha, subject: rest.join('\t') }; }) : [];
      const mItems = w.order.map(id => w.items[id]).filter(t => t.milestone === m && t.status === 'DONE');
      const ids = new Set(mItems.map(t => t.id));
      const missing = mItems.filter(t => t.commit && t.commit.sha && git(['merge-base', '--is-ancestor', t.commit.sha, b]).code !== 0).map(t => t.id);
      const extra = commits.filter(c => !(c.subject.startsWith(`milestone ${m}:`) || [...ids].some(id => c.subject.startsWith(`${id}: `) || c.subject.startsWith(`${id} (`))));
      if (missing.length) die(`Refused: item commit(s) are not on '${b}': ${missing.join(', ')}` + (mItems.some(t => t.ownBranch) ? `\n(Own-branch items are merged into '${b}' before the milestone ships.)` : ''));
      if (extra.length && !opt('reason'))
        die(`Refused: '${b}' carries commits that are not this milestone's items:\n` + extra.slice(0, 12).map(c => `  - ${c.sha.slice(0, 10)} ${c.subject}`).join('\n') +
            `\nA milestone PR contains exactly its item commits. If these belong, ship with --reason "..." (recorded).`);
      const noCommit = mItems.filter(t => !t.commit).map(t => t.id);
      if (gc.gateSteps.length && !flag('steps-done')) {
        out(`Gate steps for this project (options.gateSteps) — do them, then re-run with --steps-done:`);
        gc.gateSteps.forEach((st, i) => out(`  ${i + 1}. ${st}`));
        die(`Refused: gate steps not confirmed.`);
      }
      const GH = process.env.FORGE_GH || 'gh';
      const gh = (args) => { const r = spawnSync(GH, args, { cwd: PROJECT, encoding: 'utf8', timeout: 120000 }); return { code: r.status === null ? -1 : r.status, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() || (r.error ? String(r.error.message) : '') }; };
      if (gh(['--version']).code !== 0) die(`Refused: the GitHub CLI ('gh') is not available — install it and run 'gh auth login'.`);
      const lastV = t => (t.verifications || []).filter(x => x.passed).pop();
      const body = [`Milestone **${m}** — ${milestoneName(w, m) || '(unnamed)'}`, '',
        `Gate approved ${g.ts}${g.note ? ` — ${String(g.note).slice(0, 300)}` : ''}`, '', '| Item | Commit | Verified |', '|---|---|---|',
        ...mItems.map(t => { const lv = lastV(t); return `| ${t.id} ${String(t.title).replace(/\|/g, '/').slice(0, 90)} | ${t.commit ? t.commit.sha.slice(0, 10) : '—'} | ${lv ? `${lv.ts.slice(0, 16)} · ${lv.results.length} checks` : '—'} |`; }),
        '', `Merge with a **merge commit** (never squash) so the per-item commits survive.`, '', `Opened by forge milestone ship.`].join('\n');
      const bodyFile = path.join(STATE, `ship-${m}.md`);
      fs.writeFileSync(bodyFile, body + '\n');
      const mLab = computeLabels(w).milestone[m];
      const pr = gh(['pr', 'create', '--base', gc.base, '--head', b, '--title', `${mLab} — ${milestoneName(w, m) || m} (${m})`, '--body-file', bodyFile]);
      try { fs.unlinkSync(bodyFile); } catch (_) { }
      if (pr.code !== 0) die(`Refused: gh pr create failed:\n${pr.err || pr.out}`);
      const url = pr.out.split('\n').filter(Boolean).pop();
      const allow = gh(['api', 'repos/{owner}/{repo}', '--jq', '.allow_merge_commit']);
      if (allow.code === 0 && allow.out === 'false') out(`⚠ This repository does not allow merge commits — enable them (Settings → General → Pull Requests) or the per-item commits will be squashed away.`);
      const prot = gh(['api', `repos/{owner}/{repo}/branches/${gc.base}/protection/required_status_checks`, '--jq', '((.contexts // []) + ((.checks // []) | map(.context))) | length']);
      const requiredChecks = prot.code === 0 ? (parseInt(prot.out, 10) || 0) > 0 : null;
      let autoMerge = false;
      if (flag('auto-merge')) {
        if (requiredChecks === true) { const am = gh(['pr', 'merge', url, '--auto', `--${gc.merge === 'merge' ? 'merge' : gc.merge}`]); autoMerge = am.code === 0; if (!autoMerge) out(`⚠ auto-merge could not be enabled: ${am.err}`); }
        else out(`⚠ NOT enabling auto-merge: '${gc.base}' has ${requiredChecks === false ? 'NO required status checks' : 'unknown protection (no admin rights to read it)'} — auto-merge would merge before CI finishes.`);
      }
      w.gates[m] = Object.assign({}, w.gates[m], { ship: { pr: url, branch: b, head: git(['rev-parse', 'HEAD']).out, ts: ts(), requiredChecks, autoMerge, extraReason: extra.length ? opt('reason') : undefined } });
      saveWork(w);
      out(`Milestone ${m} shipped for review: ${url}`);
      if (noCommit.length) out(`  Note: ${noCommit.length} DONE item(s) have no Forge commit (done before the git flow, or nothing to commit): ${noCommit.slice(0, 8).join(', ')}`);
      if (requiredChecks === false) out(`⚠ '${gc.base}' has NO required status checks: merging is only gated by you waiting for CI. Merge with a merge commit once CI is green:\n  gh pr merge ${url} --merge`);
      else if (requiredChecks === null) out(`⚠ Could not read '${gc.base}' branch protection (needs admin). Wait for CI, then: gh pr merge ${url} --merge`);
      else if (!autoMerge) out(`Merge with a merge commit once CI is green: gh pr merge ${url} --merge   (or re-run with --auto-merge)`);
      const checks = gh(['pr', 'checks', url]);
      if (checks.out) out(`CI:\n${checks.out.split('\n').slice(0, 15).map(l => '  ' + l).join('\n')}`);
      return;
    } else if (sub === 'remove') {
      // v0.16.2: a re-cut empties old milestones; only an empty, never-gated one can go
      const m = argv[2];
      if (!w.milestones[m]) die(`Unknown milestone '${m || ''}'. See: forge milestone list`);
      if (!opt('reason')) die('Removing a milestone must be explicit: --reason "..."');
      const held = w.order.filter(id => w.items[id].milestone === m);
      if (held.length) die(`Refused: '${m}' still holds ${held.length} item(s) (${held.slice(0, 8).join(', ')}${held.length > 8 ? ', …' : ''}), including closed ones — closed work keeps its milestone as history.`);
      if (w.gates[m]) die(`Refused: '${m}' has a gate record (security review or approval) — it is history, not plan.`);
      delete w.milestones[m];
      w.milestoneOrder = w.milestoneOrder.filter(x => x !== m);
      saveWork(w);
      appendMd(DECISIONS_FILE, '# Decisions log (append-only, via forge CLI)',
        `\n### ${ts()} — Milestone '${m}' removed\n- Authority: human\n- Decision: empty milestone removed from the plan\n- Why: ${opt('reason')}\n`);
      out(`Milestone ${m} removed.`);
    } else if (sub === 'move') {
      // v0.16.2: reorder for business reasons — refused when it would break the work graph
      const m = argv[2];
      if (!w.milestones[m]) die(`Unknown milestone '${m || ''}'. See: forge milestone list`);
      const target = opt('before') || opt('after');
      if (!target || (opt('before') && opt('after'))) die(`Usage: forge milestone move <id> --before <M> | --after <M> [--pull-deps] --reason "..."`);
      if (!w.milestones[target] || target === m) die(`Unknown or identical target milestone '${target}'.`);
      if (!opt('reason')) die('A reorder is a product decision — record why: --reason "..."');
      if ((w.gates[m] || {}).approved) die(`Refused: '${m}' is approved — shipped milestones are history, not plan.`);
      if (milestoneStarted(w, m)) die(`Refused: '${m}' already has work in progress or done. Finish or split it before reordering.`);
      if ((releaseOf(w, m) || null) !== (releaseOf(w, target) || null))
        die(`Refused: '${m}' (${releaseOf(w, m) || 'no release'}) and '${target}' (${releaseOf(w, target) || 'no release'}) are in different releases. Milestones move inside their release; change release with: forge milestone update ${m} --release <R>`);
      const next = order.filter(x => x !== m);
      const at = opt('before') ? next.indexOf(target) : next.indexOf(target) + 1;
      next.splice(at, 0, m);
      const lastLocked = next.reduce((acc, x, i) => (x !== m && (milestoneStarted(w, x) || (w.gates[x] || {}).approved)) ? i : acc, -1);
      if (next.indexOf(m) <= lastLocked)
        die(`Refused: '${m}' would move ahead of '${next[lastLocked]}', which has already started or been approved.\n` +
            `Gates run in order — this would block work already in flight. Move it after '${next[lastLocked]}' instead.`);
      let bad = milestoneOrderViolations(w, next);
      const pulled = [];
      if (bad.length && flag('pull-deps')) {
        // pull every blocking dependency (transitively) into the moved milestone
        const newPos = new Map(next.map((x, i) => [x, i]));
        const queue = bad.filter(v => v.itemM === m).map(v => v.dep);
        while (queue.length) {
          const d = queue.shift();
          const dep = w.items[d];
          if (!dep || dep.milestone === m || ['DONE', 'CANCELLED'].includes(dep.status)) continue;
          if (newPos.get(dep.milestone) <= newPos.get(m)) continue;
          if (dep.status === 'IN_PROGRESS') die(`Refused: dependency '${d}' is IN_PROGRESS in '${dep.milestone}' — it cannot be pulled mid-flight.`);
          pulled.push({ id: d, from: dep.milestone });
          dep.milestone = m;
          (dep.history = dep.history || []).push({ ts: ts(), change: `milestone: '${pulled[pulled.length - 1].from}' → '${m}' (pulled forward with ${m})`, reason: opt('reason') });
          dep.updated = ts();
          queue.push(...(dep.deps || []));
        }
        bad = milestoneOrderViolations(w, next);
        if (bad.length) for (const p of pulled) { w.items[p.id].milestone = p.from; w.items[p.id].history.pop(); } // roll back (nothing is saved on refusal anyway)
      }
      if (bad.length)
        die(`Refused: moving '${m}' ${opt('before') ? 'before' : 'after'} '${target}' breaks ${bad.length} dependenc${bad.length === 1 ? 'y' : 'ies'}:\n` +
            bad.slice(0, 20).map(v => `  - ${v.item} (${v.itemM}) depends on ${v.dep} (${v.depM})`).join('\n') +
            (bad.length > 20 ? `\n  … and ${bad.length - 20} more` : '') +
            (bad.some(v => v.itemM === m) && !flag('pull-deps')
              ? `\nRe-run with --pull-deps to move the blocking items into '${m}' with it (recorded in each item's history),\nor re-point the dependencies first: forge task update <id> --deps ... --reason "..."`
              : `\nThese items depend on '${m}' — move them along, or re-point their dependencies first.`));
      w.milestoneOrder = next;
      (w.milestones[m].history = w.milestones[m].history || []).push({ ts: ts(), change: `moved ${opt('before') ? 'before' : 'after'} ${target} (position ${next.indexOf(m) + 1})`, reason: opt('reason') });
      saveWork(w);
      appendMd(DECISIONS_FILE, '# Decisions log (append-only, via forge CLI)',
        `\n### ${ts()} — Milestone '${milestoneLabel(w, m)}' reordered\n- Authority: human\n- Decision: moved ${opt('before') ? 'before' : 'after'} '${target}'${pulled.length ? `; pulled forward: ${pulled.map(p => `${p.id} (from ${p.from})`).join(', ')}` : ''}\n- Why: ${opt('reason')}\n`);
      out(`Milestone ${m} moved to position ${next.indexOf(m) + 1}.` + (pulled.length ? `\nPulled into ${m}: ${pulled.map(p => `${p.id} (from ${p.from})`).join(', ')}` : ''));
    } else if (sub === 'security') {
      // v0.8: record the milestone security review (fresh-context reviewer over the slice's diff)
      const m = argv[2];
      if (!m || !milestoneSeq(w).includes(m)) die(`Unknown milestone '${m || ''}'. See: forge milestone list`);
      // v0.21 (C11): a ready-to-dispatch prompt for the security pass; writes nothing
      if (flag('brief')) {
        const base = milestoneBase(w, m), head = gitHead();
        const ids = w.order.filter(id => w.items[id].milestone === m);
        const pack = path.relative(PROJECT, path.join(PACKS_DIR, 'security.md')).split(path.sep).join('/');
        out([`# Security brief — milestone ${m}${milestoneName(w, m) ? ` (${milestoneName(w, m)})` : ''}`, '',
          `Review the milestone's cumulative change for security defects, with fresh eyes. You did not write it.`, '',
          `## The change`, base && head ? `\`git diff ${base.slice(0, 12)}..${head.slice(0, 12)}\`  (and \`git log --oneline ${base.slice(0, 12)}..${head.slice(0, 12)}\` for the task-by-task story)` : `The milestone's diff against its base branch (no recorded commit range yet).`,
          `Tasks in this milestone: ${ids.join(', ') || '—'}`, '',
          `## Review against`, `\`${pack}\` — every section: secrets, authorization, input, honesty. Check RLS policies and storage rules against the domain spec, not against their presence.`, '',
          `## Output — exactly this shape`,
          `For each finding: severity (critical/high/medium/low) · file:line · what is wrong · the exploit or failure in one sentence · the fix.`,
          `Then a verdict: every finding is either a NEW WORK ITEM (title + acceptance criterion) or an ACCEPTED RISK (why it is acceptable now). Nothing is left unassigned.`,
          `Report what you checked AND what you did not.`, '',
          `_Orchestrator: dispatch to forge-reviewer (opus — it inherits your model), then record: forge milestone security ${m} --agent forge-reviewer --note "<coverage + findings>"; findings become work items before approval._`].join('\n'));
        return;
      }
      if (!opt('note')) die('Usage: forge milestone security <M> --agent <worker|self> --note "<who reviewed, what was covered, findings summary>"');
      // v0.16: the contract has always said the security pass is DISPATCHED to a
      // fresh-context reviewer. Field measurement: it was absorbed in-session
      // 22 times for 21 items — ~694k orchestrator tokens, and at item granularity
      // rather than per milestone. A sentence in the contract did not hold, so the
      // record now has to name who did it.
      const secAgent = opt('agent');
      if (!secAgent)
        die(`Refused: record WHO ran the security pass — it is dispatched to a fresh-context reviewer, not absorbed.\n` +
            `  forge milestone security ${m} --agent forge-reviewer --note "<coverage + findings>"\n` +
            `If you deliberately ran it in this session instead, say so and it is recorded as absorbed:\n` +
            `  forge milestone security ${m} --agent self --note "..."`);
      w.gates[m] = Object.assign({}, w.gates[m], { security: { ts: ts(), agent: secAgent, note: opt('note') } });
      saveWork(w);
      out(`Security review recorded for milestone '${m}' (${secAgent === 'self' ? 'ABSORBED in-session — this is the expensive path; a fresh reviewer is cheaper and less biased' : `dispatched → ${secAgent}`}).`);
      out(`Findings become work items BEFORE the gate is approved.`);
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
      // v0.16.2: the milestone's commit range — from the previous approved gate's head
      // (contiguous ranges), else from the earliest recorded item start, to HEAD now.
      let mBase = null;
      { const seqA = milestoneSeq(w); for (const p of seqA.slice(0, seqA.indexOf(m)).reverse()) { const pc = (w.gates[p] || {}).commits; if (pc && pc.head) { mBase = pc.head; break; } } }
      if (!mBase) {
        const starts = w.order.map(id => w.items[id]).filter(t => t.milestone === m && t.commitBase)
          .map(t => ({ b: t.commitBase, at: Date.parse((t.attempts.find(a => a.outcome === 'started') || {}).ts || 0) }))
          .sort((a, b) => a.at - b.at);
        if (starts.length) mBase = starts[0].b;
      }
      const mCommits = commitRange(mBase, gitHead());
      w.gates[m] = Object.assign({}, w.gates[m], { approved: true, ts: ts(), note: opt('note') || null, securitySkipped: secSkip, commits: mCommits || undefined });
      saveWork(w);
      appendMd(DECISIONS_FILE, '# Decisions log (append-only, via forge CLI)',
        `\n### ${ts()} — Milestone '${m}' approved\n- Authority: human\n- Decision: milestone gate approved after human review${secSkip ? ` (SECURITY REVIEW SKIPPED: ${secSkip})` : ''}\n- Why: ${opt('note') || '(no note recorded)'}\n`);
      freezeLabels(w); saveWork(w);
      out(`Milestone ${computeLabels(w).milestone[m]} '${milestoneLabel(w, m)}' approved — later milestones may now start.`);
      {
        const rel = releaseOf(w, m);
        if (rel && milestoneSeq(w).filter(x => releaseOf(w, x) === rel).every(x => ((w.gates || {})[x] || {}).approved))
          out(`\n🏁 Release ${computeLabels(w).releaseLabel[rel]} (${(w.releases[rel] || {}).name || rel}) is complete. Once its milestone PRs are merged: forge release tag ${rel}`);
      }
      if (mCommits) out(`Commit range recorded: ${mCommits.base.slice(0, 7)}..${mCommits.head.slice(0, 7)} (${mCommits.count} commit(s)) — git log ${mCommits.base}..${mCommits.head}`);
      out(`📊 forge/dashboard.html now shows this milestone closed — worth a look for the user.`);
      if (perMilestone(loadConfig() || {})) out(`\nNext (per-milestone git flow): forge milestone ship ${m}   — opens ONE PR ${milestoneBranch(loadConfig() || {}, m)} → ${gitCfg(loadConfig() || {}).base || '<baseBranch>'} with every item commit.`);
      // v0.16: the gate is the designed session boundary. Measured: the orchestrator
      // re-read 601M cached tokens across one long session because context only ever
      // grows. Forge's state lives on disk precisely so a cold session can resume.
      out(`\n🔄 START A NEW SESSION NOW. This milestone is closed and its conversation is spent —\n` +
          `   everything needed to continue is in forge/ (the session-start hook reloads it).\n` +
          `   Carrying this context into the next milestone makes every later turn more expensive\n` +
          `   and slower, for no benefit. Tell the user: "close this session and open a new one".`);
    } else if (sub === 'reopen') {
      const m = argv[2];
      if (!opt('reason')) die('Reopening a gate must be explicit: --reason "..."');
      if (!w.gates[m] || !w.gates[m].approved) die(`Milestone '${m}' is not approved; nothing to reopen.`);
      w.gates[m] = { approved: false, ts: ts(), note: `REOPENED: ${opt('reason')}` };
      saveWork(w);
      out(`Milestone '${m}' gate reopened: ${opt('reason')} — items in later milestones are blocked again.`);
    } else die('Usage: forge milestone list | add <id> --name "..." [--demo] [--before|--after <M>] | update <id> [--name] [--demo] | move <id> --before|--after <M> [--pull-deps] --reason "..." | remove <id> --reason "..." | security <id> --agent <a> --note "..." | approve <id> [--note "..."] [--skip-security --reason "..."] | reopen <id> --reason "..."');
  },

  // -- dashboard ----------------------------------------------------------------
  dashboard() {
    if (!loadConfig()) die('No forge project here (run: forge init).');
    regenDashboard();   // v0.15.2: also brings the token snapshot up to date
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
          // v0.20: autopilot changes how the loop ends a task
          try { if (autopilotCfg(cfgNS).on) ns += `\n\nAUTOPILOT IS ON: after each task, take the next one of the current milestone without asking and without a progress summary. Stop only for the user — milestone ready to test, a product question (forge task block <id> --reason "question: …", then ask it), an escalation, nothing startable. The Stop hook enforces this and tells you when to stop. The user may be following from their phone: keep the message that ends a stop short, with what you need from them in the first line.`; } catch (_) { }
          // v0.19: a plan behind the installed Forge's standards is mentioned once — never acted on unasked
          try { const openU = upgradeStatus().filter(x => !x.done);
            if (openU.length) ns += `\n\nPlan standards: ${openU.length} open for Forge v${VERSION} (${openU.map(x => x.id).join(', ')}). Mention it to the user in one line after the next step ("forge upgrade shows what a newer Forge would reshape"); automatic steps are safe to apply between items, judgement steps only with their go.`; } catch (_) { }
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
        // v0.16.3: only writes INSIDE the project are orchestration. Claude's own files
        // (e.g. ~/.claude/projects/<p>/memory/) were being blocked by a stale lock.
        const insideProject = abs === PROJECT || abs.startsWith(PROJECT + path.sep);
        if (sid && insideProject) {
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

    } else if (which === 'session-end') {
      // v0.16.3: a session that ends (/clear, exit, logout) releases the lock it holds.
      // Field evidence: /clear starts a NEW session id; the old id's lock stayed fresh for
      // the full TTL and the edit-war guard blocked the very session that replaced it.
      const sid = input.session_id || null;
      const l = loadLock();
      if (sid && l && l.sessionId === sid && !l.released) {
        saveLock(Object.assign({}, l, { released: true, lastBeat: ts(), endedBy: input.reason || 'session-end' }));
        traceEvent({ outcome: 'ok', hook: 'session-end', released: String(sid).slice(0, 8), reason: input.reason || null });
      }
      process.exit(0);

    } else if (which === 'pre-compact') {
      // v0.20: what the compaction summary must keep — the plan itself lives on disk
      let note = 'Forge: the plan, its order and every task\'s state live in forge/state — after this compaction, re-read them with `forge status` and `forge task next` instead of trusting the summary. Keep in the summary: the active milestone, any IN_PROGRESS task id with its last verification result and what remains, open questions to the user, decisions taken in this conversation that are not yet recorded with `forge decision add`.';
      try {
        const cfgC = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
        const wC = JSON.parse(fs.readFileSync(WORK_FILE, 'utf8')); ensureMilestones(wC);
        const ipC = wC.order.filter(id => wC.items[id].status === 'IN_PROGRESS');
        note += ` Now: milestone ${activeMilestone(wC) || '—'}${ipC.length ? `, in progress ${ipC.join(', ')}` : ''}${autopilotCfg(cfgC).on ? '; AUTOPILOT IS ON — keep taking the next task after compaction' : ''}.`;
      } catch (_) { }
      traceEvent({ outcome: 'ok', hook: 'pre-compact', trigger: input.trigger || null });
      out(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreCompact', additionalContext: note } }));
      process.exit(0);

    } else if (which === 'stop') {
      // v0.5: release the orchestrator lock on clean finish (kept on exit 2 — session continues)
      const releaseLock = () => {
        const sid = input.session_id || null;
        const l = loadLock();
        if (sid && l && l.sessionId === sid && !l.released) saveLock(Object.assign({}, l, { released: true, lastBeat: ts() }));
      };
      let cfgS = null; try { cfgS = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch (_) { }
      const ap = autopilotCfg(cfgS);
      if (input.stop_hook_active && !ap.on) { releaseLock(); process.exit(0); } // never loop
      let w = null;
      try { w = JSON.parse(fs.readFileSync(WORK_FILE, 'utf8')); } catch (_) { releaseLock(); process.exit(0); } // P4: never crash a hook on bad state
      if (!w) { releaseLock(); process.exit(0); }
      try { ensureMilestones(w); } catch (_) { }
      const inProg = w.order.filter(id => w.items[id].status === 'IN_PROGRESS');
      // 3.2: twice-failed TODO items are dangling work too — surface them
      const failedTodo = w.order.filter(id => {
        const t = w.items[id];
        return t.status === 'TODO' && t.attempts.some(a => a.outcome === 'failed');
      });
      if (!ap.on) {
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
      }
      // ---- v0.20 autopilot ------------------------------------------------------
      const run = readJson(AUTOPILOT_FILE, {});
      const key = progressKey(w);
      const saveRun = r => { try { writeJson(AUTOPILOT_FILE, r); } catch (_) { } };
      // a nudge that produced no change in the plan is not repeated: the turn may end
      if (input.stop_hook_active && run.lastNudgeKey === key) {
        if (run.stopNoticeKey === key) { traceEvent({ outcome: 'ok', hook: 'stop', autopilot: 'stop', kind: (run.stopped || {}).kind || null }); releaseLock(); process.exit(0); }
        saveRun(Object.assign(run, { stopped: { kind: 'no-progress', reason: inProg.length ? `the session ended its turn with ${inProg.join(', ')} still in progress — read its last message` : 'no change in the plan since the last nudge', ts: ts(), key } }));
        traceEvent({ outcome: 'ok', hook: 'stop', autopilot: 'stop', kind: 'no-progress' });
        releaseLock(); process.exit(0);
      }
      const nudge = (text, extra) => {
        saveRun(Object.assign(run, { lastNudgeKey: key, lastNudgeTs: ts(), nudges: (run.nudges || 0) + 1 }, extra || {}));
        process.stderr.write(text);
        process.exit(2);
      };
      if (inProg.length) {
        traceEvent({ outcome: 'block', hook: 'stop', autopilot: 'finish-in-progress', inProgress: inProg });
        nudge(`AUTOPILOT is on and ${inProg.join(', ')} is still IN_PROGRESS. Settle it now — verify, review and 'forge task done'; ` +
          `or 'forge task block <id> --reason "question: …"' if you need the user (anything only they can do — a decision, a commit, a credential); ` +
          `once they have answered, 'forge task unblock <id>' resumes it with its attempt and verification intact. Or 'forge task fail --note' with a diagnosis. Do not stop to report progress.\n`);
      }
      const d = autopilotDecision(w, cfgS, run);
      if (d.go) {
        traceEvent({ outcome: 'block', hook: 'stop', autopilot: 'continue', next: d.next.id });
        nudge(`AUTOPILOT: keep going — the next task is ${d.label}: ${d.next.title}.\n` +
          (d.prepare ? `It is still thin: write its acceptance criteria from the spec and its file scope first (forge task update ${d.next.id} --criterion-add "…::check" --allowed "…"), then ` : '') +
          (d.prepare && sw(cfgS, 'itemShape') === 'refuse' ? `Keep it to at most 6 criteria (task start refuses more); if it needs more, split it side by side into sibling tasks that can run in parallel, not into a chain. ` : '') +
          `Run the build loop for it now (forge task start with no id → brief → dispatch → verify → review → done), without a progress summary in between. ` +
          `If options.concurrency allows, start other READY tasks with disjoint scopes in parallel. ` +
          `If a product question comes up: 'forge task block <id> --reason "question: …"' and ask it — Forge then lets the turn end so it reaches the user.\n`,
          { continues: (run.continues || 0) + 1 });
      }
      // a human stop: once, make sure the turn ends with the message the user needs (it is what reaches their phone)
      if (run.stopNoticeKey !== key) {
        traceEvent({ outcome: 'block', hook: 'stop', autopilot: 'stop-notice', kind: d.kind });
        nudge(`AUTOPILOT stops here: ${d.reason}.\n${d.ask}\nEnd your turn with exactly that message to the user — short, and first line saying what you need from them.\n`,
          { stopNoticeKey: key, stopped: { kind: d.kind, reason: d.reason, ts: ts(), key } });
      }
      traceEvent({ outcome: 'ok', hook: 'stop', autopilot: 'stop', kind: d.kind });
      releaseLock(); process.exit(0);

    } else die('Usage: forge hook session-start|pretooluse|stop|pre-compact|session-end');
  },

  help() {
    out(`forge — Forge v0 state CLI
  init [--project name]                  create forge/ state (idempotent)
  preflight [--full]                     check git, verify commands, graphify, playwright
  config get [path] | set <path> <val>   read/write forge config
  task add --id T1 --title .. --objective .. [--milestone M1] [--deps A,B]
           [--criterion "desc::check-cmd"]... [--allowed glob,..] [--forbidden glob,..] [--mock spec/mocks/x.png]
           (or: task add --json '{...}')
  task list [--status S] | show <id>
  task start <id> [--agent forge-implementer] [--escalate strategy --note why] [--whole-tree --reason r]
                                         refuses: no criteria, unmet deps, unapproved earlier milestone,
                                         already IN_PROGRESS, 3rd attempt w/o --escalate, EMPTY scope.allowed
                                         (set it: task update --allowed; deliberate: --whole-tree --reason),
                                         concurrency cap reached (options.concurrency; new projects 4, unset 1),
                                         scope overlap with an in-progress item; records pre-work check state
  task dispatch <id> [--agent name] [--kind launch|message] [--note n]
                                         record the handoff to a worker (state, not transcript inference);
                                         kind=message audits a mid-flight message to a running worker
  task verify <id> [--skip-baseline --reason r]
                                         project checks + criterion checks + baseline (when captured); records evidence + tree state
  task done <id>                         refuses: no passing verification, tree changed since verification,
                                         checks that were green before work with an unchanged tree
  task fail <id> --note "diagnosis"      record failed attempt (2 failures ⇒ escalation required)
  task update <id> [--title|--objective|--milestone|--deps|--allowed|--forbidden|--mock]
                   [--criterion-add "d::cmd"]... [--criterion-remove i]... [--reason r]
                                         audited edits; criteria changes after failures require --reason
  task dispatch <id> --agent <worker> [--model <m>] [--kind launch|message] [--note]
                                         --agent is required on a launch; a --kind message inherits
                                         the agent of the launch it follows
  task block <id> --reason | unblock <id> [--note "answer"] | cancel <id> --reason [--dependents drop|cancel]
  milestone add <m> --name "<feature it enables>" [--demo "<how to try it>"] [--before|--after <M>]
  milestone update <m> [--name ..] [--demo ..] [--reason ..]
  milestone move <m> --before|--after <M> --reason ".." [--pull-deps]
  milestone remove <m> --reason ".."     only an empty milestone with no gate record
  milestone branch <m>                   v0.17: create/switch to the milestone branch (from options.baseBranch)
  release list | add <R> --name ".." [--before|--after <R>] | update <R> --name ".."
  release move <R> --before|--after <R> --reason ".." | remove <R> --reason ".." | freeze | tag <R>
                                         v0.18: releases (V0 = MVP, V1, V2 …) above milestones. Every
                                         release / milestone / task gets a VERSION LABEL (V1.2.3) computed
                                         from position (options.versionStart) — ids never change; a label
                                         freezes when its work starts; reordering renumbers the rest.
                                         'freeze' labels already-started work (after assigning releases)
  milestone add|update <m> ... --release <R|none>   put a milestone in a release
  task next                              the next READY task in plan order (read-only)
  task start [<id>] [--reason ..]        no id = next in plan order; out of order needs --reason
  task move <id> --before|--after <id> [--reason ..]   reorder unstarted tasks (dependency-checked)
  milestone ship <m> [--steps-done] [--auto-merge] [--reason ..]
                                         v0.17: after the gate — commit the gate record, push, open ONE PR
                                         milestone branch → base (merge commit), record it; auto-merge only
                                         when the base branch has required status checks
  dispatch --agent <a> --purpose explore|review|security|advise|test|other [--model m] [--item id] [--note]
                                         v0.17: record a dispatch that has no IN_PROGRESS item
                                         v0.16.2: milestones are named feature slices in an explicit
                                         order; a move that would break a dependency or jump ahead of
                                         started work is refused (--pull-deps brings blockers along)
  milestone list | security <m> --agent <worker|self> --note | approve <m> [--note] | reopen <m> --reason
                                         human gates between milestones (config: options.gates per-milestone|end-only)
                                         approve records the milestone's commit range; task done records the item's
  brief <id>                             print the brief skeleton for a work item
  worker run <id> [--model m] [--max-turns N]
                                         v0.15: execute an IN_PROGRESS item with an API worker
                                         (OpenRouter/OpenAI-compatible). Reads the saved brief; writes
                                         only inside the item's allowed scope; runs only configured
                                         verify commands; records an 'api' dispatch with token counts.
                                         Key from env (default OPENROUTER_API_KEY), never stored.
  task fail <id> --kind provider|worker  provider = rate limit/outage/timeout — never counts toward
                                         the escalation ladder; worker (default) = the approach failed
  decision add --title --decision --why [--authority human|forge]
  discovery add --title --evidence --impact [--affects T1,T2]
  baseline capture | check               brownfield: record and guard pre-existing state
  status                                 project overview
  dashboard                              (re)generate forge/dashboard.html — also auto-regens on every state change
  usage [--rescan] [--baseline --label]  OBSERVED token/dispatch report from local session logs:
                                         --baseline records today's totals so later runs report
                                         per-item calls/context/output for work done SINCE it
                                         by model, orchestrator vs subagents, dispatches by agent type,
                                         per-item dispatch counts, spend since last state change.
                                         The dashboard's token panel refreshes ITSELF on every state
                                         change (incremental: only new transcript bytes are read), so
                                         running this is optional. --rescan rebuilds from scratch.
  arch scan [--write|--json]             v0.19: draft the architecture from the repo — manifests, platform config,
                                         function folders, env var NAMES, SDK imports (zero tokens; proposes only)
  arch add|update <id> --name .. --kind frontend|backend|db|auth|job|storage|hosting|integration
       --runs-on "<lane>" [--summary ..] [--evidence path::why] [--confirm]
  arch link|unlink <from> <to> [--label ..] [--planned]  ·  arch confirm <id>…|--all  ·  arch remove <id>
  arch list [--json] | lanes [a,b,…|auto]  lanes: Browser first, external services last unless pinned
  screen add|update <id> [--name ..] [--app <part>] [--mock ..] [--route ..]  ·  screen assign <app> <id>…|--match re
  screen list                            screens and mocks, grouped by the app they belong to
  component add|update <id> ... | list   legacy entry point — routed to a screen, a part or a plain tag;
                                         items tag via task --component (screen, part or tag)
  brief <id> --context                   v0.21: forge-explorer prompt that assembles forge/context/<id>.md (options.contextPack)
  context save <id> [--section design-note] < file   record a context pack / design note (stdin)
  task add|update … --domain api,auth    domain packs in the brief; auth|data|payments|migrations|security = high-risk
  task fail <id> --from-review <file>    retry brief = original + latest findings (options.retryFromReview)
  task done <id> --self --reason ..      self-close without a worker (options.requireDispatch)
  task verify <id> [--no-wait]           verifies run one at a time (forge/state/verify.lock)
  milestone security <M> --brief         ready-to-dispatch security-pass prompt (writes nothing)
  autopilot on [--max-items N] [--hours H] | off | status
                                         v0.20: keep taking the next task of the current milestone; stop only
                                         for a human (milestone ready to test, a question, an escalation,
                                         nothing startable, a run limit, no progress). Enforced by the Stop hook.
  upgrade [--json]                       v0.19: which plan standards of this Forge the project meets
  upgrade apply                          run the automatic steps (state backed up first)
  upgrade dry-run <script> | run <script>  judgement steps: a reviewed change script in forge/changes/,
                                         dry-run on a throwaway copy first; run refuses anything else
  upgrade accept <step> --reason ..  ·  upgrade revert [--force]
  trace [--refusals|--hooks|--last N]    flight recorder: every CLI call and hook decision (FORGE_DEBUG=1 = verbose)
  doctor                                 install/state self-check: versions, cache, hooks, lock, orphaned work
  stats                                  process metrics from the work graph: first-pass rate, retries,
                                         escalations, elapsed times, per-milestone health
  session status | takeover [--force]    orchestrator lock: who is allowed to write; takeover clears a dead session's lock
  hook session-start|pretooluse|stop     (used by plugin hooks)

  config keys: verify.* · options.gates per-milestone|end-only · options.security off · options.protect "p1/,p2/"
               options.integration per-milestone|manual (v0.17 git flow; manual needs --reason) · options.baseBranch
               options.branchPattern "milestone/<id>" · options.mergeMethod merge · options.remote origin
               options.gateSteps "step one || step two"   shown at 'milestone ship', confirmed with --steps-done
               options.versionStart 0   number of the first release (V0 = MVP; an existing product may start at 2)
               v0.21 switches (on for new projects, off when absent): options.itemShape warn|refuse ·
               options.workerExplore off|bounded · options.workerReadBudget 10 · options.contextPack false|true ·
               options.briefLimit off|on · options.retryFromReview · options.requireDispatch ·
               options.requireTester false|warn|high-risk · options.architectPrepass false|high-risk · options.delegateSpecSync
               options.concurrency N     max items IN_PROGRESS at once (new projects: 4; unset = 1 serial; parallel only with
                                         disjoint scopes — see OPERATING.md parallel dispatch)
               options.scopeExempt "a/,b/"  dirs exempt from the scope whitelist (default forge/,spec/,docs/; *.md always exempt)
               options.usageAuto false   stop refreshing the token snapshot automatically (then it is
                                         only as fresh as your last 'forge usage' run)
               options.verifyVerbose true  print every check's full output again (default: passing
                                         checks print one line; the full tail always lands in work.json)
               providers.model "<id>" · providers.url (default https://openrouter.ai/api/v1) ·
               providers.keyEnv (default OPENROUTER_API_KEY) · providers.maxTurns (default 24)
  state writes are serialised by forge/state/work.lock (concurrent forge processes wait, then refuse;
  a dead process's lock breaks automatically and is recorded in trace.jsonl)`);
  }
};

// ---------------------------------------------------------------------------

const cmd = argv[0] || 'help';
if (!commands[cmd]) die(`Unknown command '${cmd}'. Try: forge help`);
const ret = commands[cmd]();
// v0.15: 'worker' is async (provider API loop); every other command stays sync.
if (ret && typeof ret.catch === 'function') ret.catch(e => die(String((e && e.message) || e)));
