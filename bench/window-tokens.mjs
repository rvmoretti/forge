#!/usr/bin/env node
/**
 * window-tokens — orchestrator context composition in TOKENS, not bytes.
 * Images are billed by pixel area after downscaling, not by base64 size,
 * so byte-share wildly overstates them. Read-only; prints counts only.
 *
 *   node bench/window-tokens.mjs <project-substring>
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const filter = process.argv[2] || '';
const ROOT = process.env.FORGE_CLAUDE_PROJECTS || path.join(os.homedir(), '.claude', 'projects');
const dirs = fs.readdirSync(ROOT).filter(d => !filter || d.toLowerCase().includes(filter.toLowerCase()));
console.log(`Transcripts: ${dirs.join(', ')}\n`);

const TXT = n => Math.round(n / 3.7);
function imgTokens(b64) {
  try {
    const head = Buffer.from(b64.slice(0, 64), 'base64');
    let w = 0, h = 0;
    if (head.slice(1, 4).toString() === 'PNG') { w = head.readUInt32BE(16); h = head.readUInt32BE(20); }
    if (!w || !h) return 1600;
    let s = Math.min(1, 1568 / Math.max(w, h));
    if (w * s * h * s > 1150000) s = Math.sqrt(1150000 / (w * h));
    return Math.round((w * s) * (h * s) / 750);
  } catch { return 1600; }
}

const cat = { userText: 0, asstText: 0, toolInput: 0, textResult: 0, imageResult: 0 };
let imgs = 0, imgBytes = 0;
const byTool = new Map();
const bump = (t, k, n) => { const e = byTool.get(t) || { calls: 0, inTok: 0, outTok: 0 }; e[k] += n; byTool.set(t, e); };

for (const d of dirs) {
  const walk = p => fs.readdirSync(p, { withFileTypes: true }).flatMap(e =>
    e.isDirectory() ? walk(path.join(p, e.name)) : e.name.endsWith('.jsonl') ? [path.join(p, e.name)] : []);
  for (const f of walk(path.join(ROOT, d))) {
    if (f.includes(`${path.sep}subagents${path.sep}`)) continue;
    const idTool = new Map();
    for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      let ev; try { ev = JSON.parse(line); } catch { continue; }
      if (ev.isSidechain) continue;
      const blocks = Array.isArray(ev.message?.content) ? ev.message.content
        : typeof ev.message?.content === 'string' ? [{ type: 'text', text: ev.message.content }] : [];
      for (const b of blocks) {
        if (b.type === 'text') { ev.type === 'user' ? cat.userText += TXT(b.text.length) : cat.asstText += TXT(b.text.length); }
        else if (b.type === 'tool_use') {
          const t = TXT(JSON.stringify(b.input || {}).length);
          cat.toolInput += t; idTool.set(b.id, b.name); bump(b.name, 'calls', 1); bump(b.name, 'inTok', t);
        } else if (b.type === 'tool_result') {
          const tool = idTool.get(b.tool_use_id) || '(unknown)';
          let tk = 0;
          const parts = Array.isArray(b.content) ? b.content : [{ type: 'text', text: String(b.content ?? '') }];
          for (const p of parts) {
            if (p.type === 'image' && p.source?.data) { const n = imgTokens(p.source.data); cat.imageResult += n; tk += n; imgs++; imgBytes += p.source.data.length; }
            else { const n = TXT((p.text || JSON.stringify(p) || '').length); cat.textResult += n; tk += n; }
          }
          bump(tool, 'outTok', tk);
        }
      }
    }
  }
}

const total = Object.values(cat).reduce((a, b) => a + b, 0);
const k = n => `${(n / 1000).toFixed(0)}k`;
const pc = n => `${((n / total) * 100).toFixed(1)}%`;
console.log(`TOTAL ~${k(total)} tokens across the orchestrator window\n`);
for (const [c, v] of Object.entries(cat).sort((a, b) => b[1] - a[1]))
  console.log(`  ${c.padEnd(12)} ${k(v).padStart(7)}  ${pc(v).padStart(6)}`);
console.log(`\n  ${imgs} image result(s): ${(imgBytes / 1048576).toFixed(1)}MB of base64 -> only ~${k(cat.imageResult)} tokens`);

console.log('\nTOOL RESULT TOKENS BY TOOL');
for (const [t, v] of [...byTool.entries()].sort((a, b) => b[1].outTok - a[1].outTok).slice(0, 12))
  console.log(`  ${t.padEnd(30)} ${String(v.calls).padStart(5)}x  out ${k(v.outTok).padStart(7)} ${pc(v.outTok).padStart(6)}  in ${k(v.inTok).padStart(7)}`);

const prunable = cat.textResult + cat.imageResult;
console.log(`\n>>> ALL tool results = ${pc(prunable)} · TEXT results only (what text pruning can touch) = ${pc(cat.textResult)}`);
