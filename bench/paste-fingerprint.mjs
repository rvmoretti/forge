#!/usr/bin/env node
/**
 * paste-fingerprint — identifies the large pasted blocks in the orchestrator
 * window by their FIRST LINE only (truncated), so you can tell which are file
 * contents that should have been a path reference instead.
 *
 *   node bench/paste-fingerprint.mjs <project-substring>
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const filter = process.argv[2] || '';
const MIN = Number(process.argv[3] || 4000);
const ROOT = process.env.FORGE_CLAUDE_PROJECTS || path.join(os.homedir(), '.claude', 'projects');
const dirs = fs.readdirSync(ROOT).filter(d => !filter || d.toLowerCase().includes(filter.toLowerCase()));
console.log(`Transcripts: ${dirs.join(', ')}  ·  pastes >= ${MIN} chars\n`);

const hits = [];
for (const d of dirs) {
  const walk = p => fs.readdirSync(p, { withFileTypes: true }).flatMap(e =>
    e.isDirectory() ? walk(path.join(p, e.name)) : e.name.endsWith('.jsonl') ? [path.join(p, e.name)] : []);
  for (const f of walk(path.join(ROOT, d))) {
    if (f.includes(`${path.sep}subagents${path.sep}`)) continue;
    for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      let ev; try { ev = JSON.parse(line); } catch { continue; }
      if (ev.isSidechain || ev.type !== 'user') continue;
      const c = ev.message?.content;
      const texts = typeof c === 'string' ? [c]
        : Array.isArray(c) ? c.filter(b => b.type === 'text').map(b => b.text) : [];
      for (const t of texts) {
        if (t.length < MIN) continue;
        const head = (t.split('\n').find(l => l.trim()) || '').trim().slice(0, 72);
        hits.push({ tok: Math.round(t.length / 3.7), chars: t.length, head, ts: (ev.timestamp || '').slice(0, 10) });
      }
    }
  }
}
hits.sort((a, b) => b.tok - a.tok);
const tot = hits.reduce((s, h) => s + h.tok, 0);
console.log(`${hits.length} pasted block(s) · ~${(tot / 1000).toFixed(0)}k tokens total\n`);
console.log(`${'tokens'.padStart(8)}  ${'date'.padEnd(11)}first line`);
for (const h of hits.slice(0, 30)) console.log(`${String(h.tok).padStart(8)}  ${h.ts.padEnd(11)}${h.head}`);

// repeated pastes = the same thing sent more than once
const byHead = new Map();
for (const h of hits) { const e = byHead.get(h.head) || { n: 0, tok: 0 }; e.n++; e.tok += h.tok; byHead.set(h.head, e); }
const dupes = [...byHead.entries()].filter(([, v]) => v.n > 1).sort((a, b) => b[1].tok - a[1].tok);
if (dupes.length) {
  const waste = dupes.reduce((s, [, v]) => s + v.tok * (v.n - 1) / v.n, 0);
  console.log(`\nREPEATED PASTES: ${dupes.length} block(s) sent more than once · ~${(waste / 1000).toFixed(0)}k tokens redundant`);
  for (const [h, v] of dupes.slice(0, 10)) console.log(`  ${String(v.n).padStart(3)}x  ${String(Math.round(v.tok / v.n)).padStart(7)} tok each  ${h}`);
}
