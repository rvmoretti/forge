#!/usr/bin/env node
/**
 * usertext-split — what is actually inside the "userText" bucket.
 * Read-only. Prints token counts and category labels ONLY, never content.
 *
 *   node bench/usertext-split.mjs <project-substring>
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const filter = process.argv[2] || '';
const ROOT = process.env.FORGE_CLAUDE_PROJECTS || path.join(os.homedir(), '.claude', 'projects');
const dirs = fs.readdirSync(ROOT).filter(d => !filter || d.toLowerCase().includes(filter.toLowerCase()));
console.log(`Transcripts: ${dirs.join(', ')}\n`);
const TXT = n => Math.round(n / 3.7);

// ordered: first match wins
const RULES = [
  ['forge SessionStart hook', t => t.includes('Forge operating contract') || t.includes('YOUR NEXT STEP')],
  ['CLAUDE.md re-injection',  t => t.includes('Contents of') && t.includes('CLAUDE.md')],
  ['system-reminder (other)', t => t.includes('<system-reminder>')],
  ['slash-command output',    t => /<command-(name|message|args)>|<local-command-std/.test(t)],
  ['skill / plugin injection',t => t.includes('<skill') || t.includes('SKILL.md')],
  ['tool-denied / interrupt', t => /tool use was rejected|Request interrupted|user doesn't want/i.test(t)],
];
const cat = new Map(); const cnt = new Map();
const add = (k, n) => { cat.set(k, (cat.get(k) || 0) + n); cnt.set(k, (cnt.get(k) || 0) + 1); };
const sizes = [];

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
        const n = TXT(t.length);
        const hit = RULES.find(([, fn]) => { try { return fn(t); } catch { return false; } });
        if (hit) { add(hit[0], n); continue; }
        add(t.length > 4000 ? 'pasted block (>4k chars)' : 'typed prompt', n);
        sizes.push(t.length);
      }
    }
  }
}
const total = [...cat.values()].reduce((a, b) => a + b, 0);
const k = n => `${(n / 1000).toFixed(0)}k`;
console.log(`userText total ~${k(total)} tokens\n`);
for (const [c, v] of [...cat.entries()].sort((a, b) => b[1] - a[1]))
  console.log(`  ${c.padEnd(26)} ${k(v).padStart(7)}  ${((v / total) * 100).toFixed(1).padStart(5)}%  ${String(cnt.get(c)).padStart(5)} msg`);
sizes.sort((a, b) => a - b);
if (sizes.length) console.log(`\n  human messages: ${sizes.length} · median ${sizes[sizes.length >> 1]} chars · p90 ${sizes[Math.floor(sizes.length * 0.9)]} · max ${sizes[sizes.length - 1]}`);
