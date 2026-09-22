#!/usr/bin/env node
/**
 * context-composition — what actually fills the Forge orchestrator's window.
 * Read-only. Prints byte counts and tool names ONLY — never transcript
 * content, prompts, file contents or code.
 *
 *   node bench/context-composition.mjs <project-substring>
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const filter = process.argv[2] || '';
const ROOT = process.env.FORGE_CLAUDE_PROJECTS || path.join(os.homedir(), '.claude', 'projects');
if (!fs.existsSync(ROOT)) { console.error(`no transcripts at ${ROOT}`); process.exit(1); }
const dirs = fs.readdirSync(ROOT).filter(d => !filter || d.toLowerCase().includes(filter.toLowerCase()));
if (!dirs.length) { console.error('no matching project dirs'); process.exit(1); }
console.log(`Transcripts: ${dirs.join(', ')}\n`);

const len = c => typeof c === 'string' ? c.length
  : Array.isArray(c) ? c.reduce((n, b) => n + (b?.text?.length || b?.content?.length || JSON.stringify(b || '').length), 0)
  : c ? JSON.stringify(c).length : 0;

let sessions = 0;
const cat = { userText: 0, asstText: 0, thinking: 0, toolInput: 0, toolResult: 0 };
const byTool = new Map();   // tool -> {calls, inBytes, outBytes}
const bump = (t, k, n) => { const e = byTool.get(t) || { calls: 0, inBytes: 0, outBytes: 0 }; e[k] += n; byTool.set(t, e); };

for (const d of dirs) {
  const walk = p => fs.readdirSync(p, { withFileTypes: true }).flatMap(e =>
    e.isDirectory() ? walk(path.join(p, e.name)) : e.name.endsWith('.jsonl') ? [path.join(p, e.name)] : []);
  for (const f of walk(path.join(ROOT, d))) {
    const isSub = f.includes(`${path.sep}subagents${path.sep}`);
    let sawMain = false;
    const idTool = new Map();
    for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      let ev; try { ev = JSON.parse(line); } catch { continue; }
      if (isSub || ev.isSidechain) continue;          // orchestrator window only
      sawMain = true;
      const blocks = Array.isArray(ev.message?.content) ? ev.message.content
        : typeof ev.message?.content === 'string' ? [{ type: 'text', text: ev.message.content }] : [];
      for (const b of blocks) {
        if (b.type === 'text') { (ev.type === 'user' ? cat.userText += b.text.length : cat.asstText += b.text.length); }
        else if (b.type === 'thinking') cat.thinking += (b.thinking || '').length;
        else if (b.type === 'tool_use') {
          const n = JSON.stringify(b.input || {}).length;
          cat.toolInput += n; idTool.set(b.id, b.name); bump(b.name, 'calls', 1); bump(b.name, 'inBytes', n);
        } else if (b.type === 'tool_result') {
          const n = len(b.content); cat.toolResult += n;
          bump(idTool.get(b.tool_use_id) || '(unknown)', 'outBytes', n);
        }
      }
    }
    if (sawMain) sessions++;
  }
}

const total = Object.values(cat).reduce((a, b) => a + b, 0);
const pc = n => `${((n / total) * 100).toFixed(1)}%`;
const kb = n => `${(n / 1024).toFixed(0)}KB`;
const tok = n => `~${Math.round(n / 3.7 / 1000)}k tok`;

console.log(`${sessions} orchestrator session file(s) · ${kb(total)} total (${tok(total)})\n`);
console.log('WHAT FILLS THE ORCHESTRATOR WINDOW');
for (const [k, v] of Object.entries(cat).sort((a, b) => b[1] - a[1]))
  console.log(`  ${k.padEnd(12)} ${kb(v).padStart(9)}  ${pc(v).padStart(6)}  ${tok(v)}`);

console.log('\nTOOL RESULTS BY TOOL (the prunable surface)');
const rows = [...byTool.entries()].sort((a, b) => b[1].outBytes - a[1].outBytes).slice(0, 15);
for (const [t, v] of rows)
  console.log(`  ${t.padEnd(18)} ${String(v.calls).padStart(5)} calls  out ${kb(v.outBytes).padStart(9)} ${pc(v.outBytes).padStart(6)}  in ${kb(v.inBytes).padStart(8)}`);

const prunable = cat.toolResult + cat.toolInput;
console.log(`\n>>> tool calls + results = ${pc(prunable)} of the orchestrator window (${tok(prunable)})`);
console.log(`>>> text that pruning can never touch = ${pc(cat.userText + cat.asstText + cat.thinking)}`);
