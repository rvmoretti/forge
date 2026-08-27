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
const PLUGIN_ROOT = path.resolve(__dirname, '..');

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

function die(msg, code = 1) { process.stderr.write(msg + '\n'); process.exit(code); }
function out(msg) { process.stdout.write(msg + '\n'); }

function loadConfig() { return readJson(CONFIG_FILE, null); }
function loadWork() { return readJson(WORK_FILE, { schema: 1, items: {}, order: [] }); }
function saveWork(w) { writeJson(WORK_FILE, w); regenDashboard(); }

function run(cmd, opts = {}) {
  const r = spawnSync(cmd, { shell: true, cwd: PROJECT, encoding: 'utf8',
    timeout: opts.timeout || 600000, maxBuffer: 16 * 1024 * 1024 });
  const outText = ((r.stdout || '') + (r.stderr || '')).trim();
  return {
    cmd,
    exit: r.status === null ? -1 : r.status,
    tail: outText.split('\n').slice(-40).join('\n')
  };
}

// ---------------------------------------------------------------------------
// dashboard (generated projection — never authoritative; state always wins)
// ---------------------------------------------------------------------------

const DASHBOARD_FILE = path.join(FORGE, 'dashboard.html');

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
    const isReady = t.status === 'TODO' && t.deps.every(d => !w.items[d] || w.items[d].status === 'DONE') && t.criteria.length > 0;
    if (isReady) ready++;
    const m = t.milestone || '(no milestone)';
    (byMilestone[m] = byMilestone[m] || []).push({ t, isReady });
  }
  const total = w.order.length;
  const pct = total ? Math.round(100 * counts.DONE / total) : 0;

  const sColor = { DONE: '#15803d', IN_PROGRESS: '#3b3f8f', BLOCKED: '#b91c1c', TODO: '#57606f', CANCELLED: '#9aa0ad', READY: '#0f766e' };
  const chip = (label, color) =>
    `<span style="display:inline-block;font-size:10.5px;font-weight:700;letter-spacing:.04em;padding:1px 8px;border-radius:99px;border:1px solid ${color}44;color:${color};background:${color}12">${esc(label)}</span>`;

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

  const milestoneBlocks = Object.entries(byMilestone).map(([m, items]) => {
    const gate = (w.gates || {})[m];
    const allClosed = items.every(x => ['DONE', 'CANCELLED'].includes(x.t.status));
    const gateChip = m === '(no milestone)' ? '' :
      gate && gate.approved ? chip('GATE APPROVED', '#15803d') :
      allClosed ? chip('AWAITING HUMAN APPROVAL', '#b45309') : chip('gate pending', '#57606f');
    const done = items.filter(x => x.t.status === 'DONE').length;
    const rows = items.map(({ t, isReady }) => {
      const fails = t.attempts.filter(a => a.outcome === 'failed').length;
      const lastV = t.verifications.length ? t.verifications[t.verifications.length - 1] : null;
      return `<tr>
        <td>${chip(isReady ? 'READY' : t.status, sColor[isReady ? 'READY' : t.status] || '#57606f')}</td>
        <td><b>${esc(t.id || '')}</b> ${esc(t.title)}${t.status === 'BLOCKED' ? `<div class="mut">⛔ ${esc(t.blockReason)}</div>` : ''}${t.status === 'CANCELLED' ? `<div class="mut">✕ ${esc(t.cancelReason)}</div>` : ''}</td>
        <td class="mut">${t.deps.length ? t.deps.map(esc).join(', ') : '—'}</td>
        <td class="mut">${t.criteria.length}${t.criteria.some(c => c.check) ? ' ✓' : ''}</td>
        <td>${fails ? chip(fails + ' failed', '#b45309') : '<span class="mut">—</span>'}</td>
        <td>${lastV ? chip(lastV.passed ? 'passed' : 'failed', lastV.passed ? '#15803d' : '#b91c1c') + `<span class="mut" style="margin-left:6px">${esc(lastV.ts.slice(0, 16).replace('T', ' '))}</span>` : '<span class="mut">never</span>'}</td>
      </tr>`;
    }).join('');
    return `<h3>${esc(m)} <span class="mut" style="font-weight:400">${done}/${items.length} done</span> ${gateChip}</h3>
      <div class="tblwrap"><table><thead><tr><th>Status</th><th>Item</th><th>Deps</th><th>Criteria</th><th>Attempts</th><th>Last verification</th></tr></thead><tbody>${rows}</tbody></table></div>`;
  }).join('');

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
<h2>Work graph</h2>
${milestoneBlocks || '<p class="mut">No work items yet.</p>'}
<div class="grid2">
<div><h2>Decisions <span class="mut" style="font-weight:400">(latest first · forge/decisions.md)</span></h2>${logBlock(decisions, 'None recorded yet.')}</div>
<div><h2>Discoveries <span class="mut" style="font-weight:400">(latest first · forge/discoveries.md)</span></h2>${logBlock(discoveries, 'None recorded yet.')}</div>
</div>
<div class="grid2">
<div><h2>Preflight ${pf ? `<span class="mut" style="font-weight:400">${esc(pf.ts.slice(0, 16).replace('T', ' '))}</span>` : ''}</h2>
<div class="tblwrap"><table><tbody>${pfBlock}</tbody></table></div></div>
<div><h2>Baseline ${base ? `<span class="mut" style="font-weight:400">${esc(base.ts.slice(0, 16).replace('T', ' '))}</span>` : ''}</h2>
<div class="tblwrap"><table><tbody>${baseBlock}</tbody></table></div></div>
</div>
${specRows ? `<h2>Specification <span class="mut" style="font-weight:400">(${esc(cfg.specDir)}/ — the source of intent)</span></h2>
<div class="tblwrap"><table><thead><tr><th>File</th><th>Size</th><th>Modified</th></tr></thead><tbody>${specRows}</tbody></table></div>` : ''}
</div></body></html>`;

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
        status: 'TODO', attempts: [], verifications: [], history: [],
        preState: null, startTree: null,
        blockReason: null, cancelReason: null, created: ts(), updated: ts()
      }, item, { status: 'TODO' });
      w.order.push(item.id);
      saveWork(w);
      out(`Created ${item.id}: ${item.title}`);

    } else if (sub === 'list') {
      const filter = opt('status');
      for (const id of w.order) {
        const t = w.items[id];
        if (filter && t.status !== filter) continue;
        const ready = t.status === 'TODO' && depsSatisfied(w, t).length === 0 && t.criteria.length > 0;
        out(`${t.status.padEnd(11)} ${id.padEnd(8)} ${t.title}${ready ? '  [READY]' : ''}` +
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
      item.verifications.push({ ts: ts(), passed, results, tree: treeState(), skippedBaseline });
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
      // F9: surface the gate the moment a milestone completes
      if (item.milestone && milestoneComplete(w, item.milestone) && !((w.gates || {})[item.milestone] || {}).approved
          && ((loadConfig() || {}).options || {}).gates !== 'end-only')
        out(`\nMILESTONE '${item.milestone}' IS COMPLETE and now awaits human review.\n` +
            `Demo it to the user, collect their verdict, then: forge milestone approve ${item.milestone} --note "..."\n` +
            `Items in later milestones will refuse to start until then.`);

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

    } else die('Usage: forge task add|list|show|start|verify|done|fail|block|cancel|update ...');
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
    out(lines.join('\n'));
  },

  // -- decisions / discoveries -------------------------------------------------
  decision() {
    if (argv[1] !== 'add') die('Usage: forge decision add --title t --decision d --why w [--authority human|forge]');
    appendMd(DECISIONS_FILE, '# Decisions log (append-only, via forge CLI)',
      `\n### ${ts()} — ${opt('title') || '(untitled)'}\n- Authority: ${opt('authority') || 'forge'}\n- Decision: ${opt('decision') || ''}\n- Why: ${opt('why') || ''}\n`);
    regenDashboard();
    out('Decision recorded.');
  },

  discovery() {
    if (argv[1] !== 'add') die('Usage: forge discovery add --title t --evidence e --impact i [--affects T1,T2]');
    appendMd(DISCOVERIES_FILE, '# Discoveries log (append-only, via forge CLI)',
      `\n### ${ts()} — ${opt('title') || '(untitled)'}\n- Evidence: ${opt('evidence') || ''}\n- Impact: ${opt('impact') || ''}\n- Affects: ${opt('affects') || '-'}\n`);
    regenDashboard();
    out('Discovery recorded. If it invalidates planned work, update the work graph now (block/cancel/add items) — a logged discovery with unhandled consequences is a failure.');
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
    } catch (_) { /* no work graph -> inline/path matching only */ }
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
    } else if (sub === 'approve') {
      const m = argv[2];
      if (!m || !milestoneSeq(w).includes(m)) die(`Unknown milestone '${m || ''}'. See: forge milestone list`);
      if (!milestoneComplete(w, m))
        die(`Refused: milestone '${m}' still has unfinished items — approval is for a testable, finished slice.`);
      w.gates[m] = { approved: true, ts: ts(), note: opt('note') || null };
      saveWork(w);
      appendMd(DECISIONS_FILE, '# Decisions log (append-only, via forge CLI)',
        `\n### ${ts()} — Milestone '${m}' approved\n- Authority: human\n- Decision: milestone gate approved after human review\n- Why: ${opt('note') || '(no note recorded)'}\n`);
      out(`Milestone '${m}' approved — later milestones may now start.`);
    } else if (sub === 'reopen') {
      const m = argv[2];
      if (!opt('reason')) die('Reopening a gate must be explicit: --reason "..."');
      if (!w.gates[m] || !w.gates[m].approved) die(`Milestone '${m}' is not approved; nothing to reopen.`);
      w.gates[m] = { approved: false, ts: ts(), note: `REOPENED: ${opt('reason')}` };
      saveWork(w);
      out(`Milestone '${m}' gate reopened: ${opt('reason')} — items in later milestones are blocked again.`);
    } else die('Usage: forge milestone list | approve <name> [--note "..."] | reopen <name> --reason "..."');
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
      } else {
        parts.push('## Current project state\nForge is installed but this project has no forge/config.json yet.\n' +
          '- New project → this is the SPEC PHASE: use the forge-method skill; run `forge init` to create state.\n' +
          '- Existing codebase → use the forge-brownfield skill; run `forge init`, then orientation.');
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
        process.stderr.write(
          `Forge state files are managed exclusively by the forge CLI — direct edits are blocked.\n` +
          `Use: forge task ... | forge config set ... | forge decision add ... | forge discovery add ...\n`);
        process.exit(2);
      }
      process.exit(0);

    } else if (which === 'stop') {
      if (input.stop_hook_active) process.exit(0); // never loop
      let w = null;
      try { w = JSON.parse(fs.readFileSync(WORK_FILE, 'utf8')); } catch (_) { process.exit(0); } // P4: never crash a hook on bad state
      if (!w) process.exit(0);
      const inProg = w.order.filter(id => w.items[id].status === 'IN_PROGRESS');
      // 3.2: twice-failed TODO items are dangling work too — surface them
      const failedTodo = w.order.filter(id => {
        const t = w.items[id];
        return t.status === 'TODO' && t.attempts.some(a => a.outcome === 'failed');
      });
      if (!inProg.length && !failedTodo.length) process.exit(0);
      let msg = '';
      if (inProg.length) msg +=
        `Open work items are still IN_PROGRESS: ${inProg.join(', ')}.\n` +
        `Before finishing: verify and complete them (forge task verify/done), mark them blocked with a reason (forge task block --reason), ` +
        `or record a failed attempt with a diagnosis (forge task fail --note). If the user asked to pause, block with reason "user paused".\n`;
      if (failedTodo.length) msg +=
        `Items with recorded failed attempts are sitting in TODO: ${failedTodo.join(', ')}. ` +
        `State their disposition in your closing summary (queued for escalation / superseded / awaiting decision) so nothing dangles silently.\n`;
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
  task start <id> [--agent forge-implementer] [--escalate strategy --note why]
                                         refuses: no criteria, unmet deps, unapproved earlier milestone,
                                         already IN_PROGRESS, 3rd attempt w/o --escalate; records pre-work check state
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
  hook session-start|pretooluse|stop     (used by plugin hooks)`);
  }
};

// ---------------------------------------------------------------------------

const cmd = argv[0] || 'help';
if (!commands[cmd]) die(`Unknown command '${cmd}'. Try: forge help`);
commands[cmd]();
