#!/usr/bin/env node
/**
 * read-targets — which files the orchestrator reads, and how often.
 * Read-only. Prints paths, call counts and byte totals ONLY — never content.
 *
 *   node bench/read-targets.mjs <project-substring>
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const filter = process.argv[2] || '';
const ROOT = process.env.FORGE_CLAUDE_PROJECTS || path.join(os.homedir(), '.claude', 'projects');
const dirs = fs.readdirSync(ROOT).filter(d => !filter || d.toLowerCase().includes(filter.toLowerCase()));
console.log(`Transcripts: ${dirs.join(', ')}\n`);

const len = c => typeof c === 'string' ? c.length
  : Array.isArray(c) ? c.reduce((n, b) => n + (b?.text?.length || b?.content?.length || JSON.stringify(b || '').length), 0)
  : c ? JSON.stringify(c).length : 0;

const READERS = new Set(['Read', 'NotebookRead']);
const byPath = new Map();     // path -> {calls, bytes}
const bashByCmd = new Map();  // first 2 words -> {calls, bytes}
const bump = (m, k, b) => { const e = m.get(k) || { calls: 0, bytes: 0 }; e.calls++; e.bytes += b; m.set(k, e); };

for (const d of dirs) {
  const walk = p => fs.readdirSync(p, { withFileTypes: true }).flatMap(e =>
    e.isDirectory() ? walk(path.join(p, e.name)) : e.name.endsWith('.jsonl') ? [path.join(p, e.name)] : []);
  for (const f of walk(path.join(ROOT, d))) {
    if (f.includes(`${path.sep}subagents${path.sep}`)) continue;
    const pend = new Map();
    for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      let ev; try { ev = JSON.parse(line); } catch { continue; }
      if (ev.isSidechain) continue;
      for (const b of (Array.isArray(ev.message?.content) ? ev.message.content : [])) {
        if (b.type === 'tool_use') {
          if (READERS.has(b.name)) pend.set(b.id, ['read', b.input?.file_path || b.input?.notebook_path || '(?)']);
          else if (b.name === 'Bash') pend.set(b.id, ['bash', String(b.input?.command || '').trim().split(/\s+/).slice(0, 2).join(' ')]);
        } else if (b.type === 'tool_result' && pend.has(b.tool_use_id)) {
          const [kind, key] = pend.get(b.tool_use_id);
          bump(kind === 'read' ? byPath : bashByCmd, key, len(b.content));
        }
      }
    }
  }
}

const kb = n => `${(n / 1024).toFixed(0)}KB`;
const tok = n => `~${Math.round(n / 3.7 / 1000)}k`;
const show = (title, m, n) => {
  const rows = [...m.entries()].sort((a, b) => b[1].bytes - a[1].bytes).slice(0, n);
  const tot = [...m.values()].reduce((s, v) => s + v.bytes, 0);
  console.log(`\n${title} — ${kb(tot)} total (${tok(tot)} tok)`);
  for (const [k, v] of rows)
    console.log(`  ${kb(v.bytes).padStart(9)} ${tok(v.bytes).padStart(7)}  ${String(v.calls).padStart(4)}x  ${k.length > 70 ? '…' + k.slice(-69) : k}`);
};
show('READ TARGETS (biggest first)', byPath, 25);

const repeats = [...byPath.entries()].filter(([, v]) => v.calls > 1).sort((a, b) => b[1].bytes - a[1].bytes);
const wasted = repeats.reduce((s, [, v]) => s + v.bytes * (v.calls - 1) / v.calls, 0);
console.log(`\nRE-READS: ${repeats.length} file(s) read more than once · ~${kb(wasted)} (${tok(wasted)} tok) is redundant re-reading`);
show('BASH OUTPUT BY COMMAND', bashByCmd, 15);
