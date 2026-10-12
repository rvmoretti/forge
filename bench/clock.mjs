#!/usr/bin/env node
/**
 * clock — where the wall-clock goes, from Claude Code transcript timestamps.
 * Splits each thread's time into: model (waiting for the API to answer, thinking included),
 * tool execution by kind (forge verify, playwright, npm/tsc, git, file ops, waiting on a
 * foreground subagent…), and between-turns (human, or a hook restarting the loop).
 * Read-only; prints totals only.
 *
 *   node bench/clock.mjs <project-substring> [--since 2026-10-12T06:00] [--until 2026-10-12T15:00]
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const args = process.argv.slice(2);
const opt = k => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : null; };
const filter = args.find(a => !a.startsWith('--') && args[args.indexOf(a) - 1]?.startsWith('--') !== true) || '';
const today = new Date().toISOString().slice(0, 10);
const SINCE = Date.parse(opt('since') || today + 'T00:00:00Z');
const UNTIL = Date.parse(opt('until') || '2999-01-01');
const ROOT = process.env.FORGE_CLAUDE_PROJECTS || path.join(os.homedir(), '.claude', 'projects');
const dirs = fs.readdirSync(ROOT).filter(d => !filter || d.toLowerCase().includes(filter.toLowerCase())).map(d => path.join(ROOT, d));

const files = [];
for (const d of dirs) for (const e of fs.readdirSync(d)) {
  const full = path.join(d, e);
  if (e.endsWith('.jsonl')) files.push({ f: full, side: false });
  const sub = path.join(full, 'subagents');
  if (fs.existsSync(sub)) for (const w of fs.readdirSync(sub)) if (w.endsWith('.jsonl')) files.push({ f: path.join(sub, w), side: true });
}

function bashKind(cmd = '') {
  const c = cmd.replace(/^\s*(cd [^&;]+(&&|;)\s*)+/, '').trim();
  if (/forge(\.js)?["']?\s+task verify|forge(\.js)?["']?\s+milestone verify/.test(c)) return 'bash: forge verify';
  if (/forge(\.js)?["']?\s+task start/.test(c)) return 'bash: forge task start';
  { const m = c.match(/forge(?:\.js)?["']?\s+([a-z-]+)(?:\s+([a-z-]+))?/); if (m) return `bash: forge ${m[1]}${m[2] && /^(start|done|verify|update|add|show|dispatch|list|next)$/.test(m[2]) ? ' ' + m[2] : ''}`; }
  if (/playwright/.test(c)) return 'bash: playwright';
  if (/vitest|npm (run )?test|test:db/.test(c)) return 'bash: unit/db tests';
  if (/tsc|eslint|npm run (lint|build|check)|vite build/.test(c)) return 'bash: lint/typecheck/build';
  if (/^git\b|\bgh\b/.test(c)) return 'bash: git/gh';
  if (/graphify/.test(c)) return 'bash: graphify';
  if (/sleep|until |while /.test(c)) return /verify|playwright|e2e/.test(c) ? 'bash: sleep/poll (on a verify or e2e run)' : 'bash: sleep/poll';
  return 'bash: other';
}
function toolKind(b) {
  const n = b.name || '?';
  if (n === 'Bash') return bashKind(b.input && b.input.command);
  if (n === 'Task' || n === 'Agent') return (b.input && b.input.run_in_background) ? 'agent launch (background)' : 'waiting on subagent (foreground)';
  if (['Read', 'Write', 'Edit', 'MultiEdit', 'Glob', 'Grep', 'NotebookEdit'].includes(n)) return 'file ops (' + n + ')';
  if (/^mcp__/.test(n)) return 'mcp: ' + n.split('__')[1];
  return 'tool: ' + n;
}

function textOf(d) {
  const c = d.message && d.message.content;
  if (typeof c === 'string') return c;
  return Array.isArray(c) ? c.map(b => b.text || '').join(' ') : '';
}
// what ended the idle gap tells what the thread was waiting for
function gapKind(d) {
  const x = textOf(d);
  if (/<task-notification>|task-notification|background (task|agent|command)/i.test(x)) return 'idle → woken by background worker/command finishing';
  if (/stop hook|forge.*autopilot|hook (stop|blocked)/i.test(x)) return 'idle → woken by Stop hook (autopilot)';
  if (/compact|summary of the conversation|continued from a previous/i.test(x)) return 'idle → compaction';
  if (d.isMeta) return 'idle → other meta message';
  return 'idle → human message';
}
const T = { main: {}, side: {} };
const SAMPLES = args.includes('--samples');
const S = { main: {}, side: {} };   // kind -> prefix -> ms
const sample = (th, k, x, ms) => { if (!SAMPLES || !(ms > 0)) return; const key = String(x || '(empty)').replace(/\s+/g, ' ').replace(/sb_(secret|publishable)_\S+/g, 'sb_…').slice(0, 110); const m = (S[th][k] = S[th][k] || {}); m[key] = (m[key] || 0) + ms; };
const add = (th, k, ms) => { if (ms > 0 && ms < 6 * 3600e3) T[th][k] = (T[th][k] || 0) + ms; };
let nfiles = { main: 0, side: 0 };

for (const { f, side } of files) {
  let st; try { st = fs.statSync(f); } catch { continue; }
  if (st.mtimeMs < SINCE) continue;
  const ev = [];
  for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
    if (!line) continue; let d; try { d = JSON.parse(line); } catch { continue; }
    const t = Date.parse(d.timestamp); if (!Number.isFinite(t) || t < SINCE || t > UNTIL) continue;
    if (d.type !== 'user' && d.type !== 'assistant') continue;
    ev.push({ t, d });
  }
  if (!ev.length) continue;
  const th = side || ev.some(e => e.d.isSidechain) ? 'side' : 'main';
  nfiles[th]++;
  // walk: assistant messages grouped by message.id
  let lastInputT = null;          // time the model was last handed input (user text or tool_result)
  let pending = new Map();        // tool_use_id -> { t, kind }
  let lastAsstT = null; let curMsg = null; let msgStart = null;
  for (const { t, d } of ev) {
    const content = Array.isArray(d.message && d.message.content) ? d.message.content : [];
    if (d.type === 'assistant') {
      const id = d.message && d.message.id;
      if (id !== curMsg) { curMsg = id; msgStart = lastInputT ?? t; }
      if (lastInputT != null) { add(th, 'model (API answering, thinking incl.)', t - lastInputT); lastInputT = t; }
      for (const b of content) if (b.type === 'tool_use') pending.set(b.id, { t, kind: toolKind(b), cmd: b.name === 'Bash' ? (b.input && b.input.command) : null, bg: !!(b.input && b.input.run_in_background) });
      lastAsstT = t;
    } else {
      const results = content.filter(b => b.type === 'tool_result');
      if (results.length) {
        let worst = null;
        for (const r of results) { const p = pending.get(r.tool_use_id); if (p) { pending.delete(r.tool_use_id); if (!worst || p.t < worst.t) worst = p; } }
        if (worst && lastInputT != null) { const ms = t - Math.max(worst.t, lastInputT); const k = worst.kind + (worst.bg ? ' [bg launch]' : ''); add(th, k, ms); if (/bash: (other|sleep)/.test(worst.kind)) sample(th, worst.kind, worst.cmd, ms); }
        lastInputT = t;
      } else {
        // a fresh user/hook message: the gap since the model finished is time between turns
        if (lastAsstT != null && lastInputT != null && t > lastInputT) { const gk = gapKind(d); add(th, gk, t - lastInputT); if (/other meta|human/.test(gk)) sample(th, gk, textOf(d), t - lastInputT); }
        lastInputT = t; curMsg = null;
      }
    }
  }
}
const fmt = ms => { const m = ms / 60000; return m >= 60 ? `${(m / 60).toFixed(1)} h` : `${m.toFixed(1)} min`; };
for (const th of ['main', 'side']) {
  const tot = Object.values(T[th]).reduce((a, b) => a + b, 0);
  console.log(`\n${th === 'main' ? 'ORCHESTRATOR (main thread)' : 'WORKERS (subagents, summed across parallel threads)'} — ${nfiles[th]} transcript(s), ${fmt(tot)} total`);
  for (const [k, v] of Object.entries(T[th]).sort((a, b) => b[1] - a[1])) console.log(`  ${fmt(v).padStart(9)}  ${String(Math.round(100 * v / tot)).padStart(3)}%  ${k}`);
}
if (SAMPLES) for (const th of ['main', 'side']) for (const [k, m] of Object.entries(S[th])) {
  console.log(`\n[${th}] top of: ${k}`);
  for (const [x, ms] of Object.entries(m).sort((a, b) => b[1] - a[1]).slice(0, 6)) console.log(`  ${fmt(ms).padStart(9)}  ${x}`);
}
console.log(`\nWindow: ${new Date(SINCE).toISOString()} → ${UNTIL > 4e12 ? 'now' : new Date(UNTIL).toISOString()}. Model time is wall time from input handed over to the reply landing (queueing, thinking, generation). Parallel tool calls in one turn count once, as the slowest.`);
