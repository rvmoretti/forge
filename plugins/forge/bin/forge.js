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
const path = require('path');
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
    return `<h3>${esc(m)} <span class="mut" style="font-weight:400">${done}/${items.length} done</span></h3>
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
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : null;
}
function optAll(name) {
  const vals = [];
  argv.forEach((a, i) => { if (a === '--' + name && argv[i + 1] !== undefined) vals.push(argv[i + 1]); });
  return vals;
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
        status: 'TODO', attempts: [], verifications: [],
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
      if (!['TODO', 'BLOCKED', 'IN_PROGRESS'].includes(item.status))
        die(`Cannot start '${item.id}' from status ${item.status}.`);
      if (item.criteria.length === 0)
        die(`Refused: '${item.id}' has no acceptance criteria. A work item without criteria cannot be verified, so it cannot be started.\n` +
            `Add criteria first (task add used --criterion "desc::check-command").`);
      const missing = depsSatisfied(w, item);
      if (missing.length)
        die(`Refused: '${item.id}' has unfinished dependencies: ${missing.join(', ')}.`);
      const fails = failedAttempts(item);
      if (fails >= 2 && !opt('escalate'))
        die(`Refused: '${item.id}' has failed ${fails} attempts. A third identical attempt is not allowed.\n` +
            `Escalate explicitly: forge task start ${item.id} --escalate <stronger-model|decompose|self|revisit-criteria> --note "what changes this time"`);
      item.status = 'IN_PROGRESS';
      item.blockReason = null;
      item.attempts.push({ ts: ts(), outcome: 'started', escalation: opt('escalate') || null, note: opt('note') || null });
      item.updated = ts();
      saveWork(w);
      out(`${item.id} → IN_PROGRESS${opt('escalate') ? ` (escalation: ${opt('escalate')})` : ''}`);

    } else if (sub === 'verify') {
      const item = getItem(w, argv[2]);
      const cfg = loadConfig() || { verify: {} };
      const results = [];
      for (const [k, cmd] of Object.entries(cfg.verify || {})) results.push(Object.assign({ kind: `project:${k}` }, run(cmd)));
      for (const c of item.criteria) if (c.check) results.push(Object.assign({ kind: `criterion: ${c.desc}` }, run(c.check)));
      if (results.length === 0)
        die(`Nothing executable to verify for '${item.id}': no project verify commands and no criterion checks.\n` +
            `This item cannot be machine-verified. Either add a check, or record a human verification decision in the decisions log and cancel/redefine the item.`);
      const passed = results.every(r => r.exit === 0);
      item.verifications.push({ ts: ts(), passed, results });
      item.updated = ts();
      saveWork(w);
      for (const r of results) out(`${r.exit === 0 ? 'PASS' : 'FAIL'}  [${r.kind}] ${r.cmd}${r.exit !== 0 ? '\n' + r.tail : ''}`);
      out(passed ? `\n${item.id}: verification PASSED` : `\n${item.id}: verification FAILED`);
      if (!passed) process.exit(1);

    } else if (sub === 'done') {
      const item = getItem(w, argv[2]);
      if (item.status !== 'IN_PROGRESS') die(`Cannot complete '${item.id}' from status ${item.status}.`);
      const v = lastVerification(item);
      if (!v || !v.passed)
        die(`Refused: '${item.id}' has no passing verification record.\n` +
            `Run: forge task verify ${item.id} — DONE is granted by evidence, not by claim.`);
      item.status = 'DONE';
      item.attempts.push({ ts: ts(), outcome: 'passed', note: opt('note') || null });
      item.updated = ts();
      saveWork(w);
      out(`${item.id} → DONE (verified ${v.ts})`);

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
      item.status = 'CANCELLED';
      item.cancelReason = opt('reason');
      item.updated = ts();
      saveWork(w);
      out(`${item.id} → CANCELLED: ${item.cancelReason}`);

    } else die('Usage: forge task add|list|show|start|verify|done|fail|block|cancel ...');
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
      regenDashboard();
      results.forEach(r => out(`${r.exit === 0 ? 'GREEN' : 'RED  '}  ${r.kind}: ${r.cmd}`));
      out('Baseline captured. RED items are recorded as PRE-EXISTING failures — new work must not make them worse and is not required to fix them.');
    } else if (sub === 'check') {
      const base = readJson(BASELINE_FILE, null);
      if (!base) die('No baseline captured. Run: forge baseline capture');
      let regressed = false;
      for (const b of base.results) {
        const now = run(cfg.verify[b.kind] || b.cmd);
        const was = b.exit === 0 ? 'GREEN' : 'RED';
        const is = now.exit === 0 ? 'GREEN' : 'RED';
        if (was === 'GREEN' && is === 'RED') { regressed = true; out(`REGRESSION  ${b.kind}: was GREEN at baseline, now RED\n${now.tail}`); }
        else out(`OK  ${b.kind}: baseline ${was} → now ${is}`);
      }
      if (regressed) die('\nBaseline regression detected. The current change degrades previously-working behavior.');
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
      parts.push(`\n---\nFORGE_CLI: node "${path.join(PLUGIN_ROOT, 'bin', 'forge.js')}" (run from the project root)\n`);
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
      const w = readJson(WORK_FILE, null);
      if (!w) process.exit(0);
      const inProg = w.order.filter(id => w.items[id].status === 'IN_PROGRESS');
      if (!inProg.length) process.exit(0);
      process.stderr.write(
        `Open work items are still IN_PROGRESS: ${inProg.join(', ')}.\n` +
        `Before finishing: verify and complete them (forge task verify/done), mark them blocked with a reason (forge task block --reason), ` +
        `or record a failed attempt with a diagnosis (forge task fail --note). If the user asked to pause, block with reason "user paused". ` +
        `Then give the user a short status summary.\n`);
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
  task start <id> [--escalate strategy --note why]
  task verify <id>                       run project verify commands + criterion checks; records evidence
  task done <id>                         only with a passing verification record
  task fail <id> --note "diagnosis"      record failed attempt (2 failures ⇒ escalation required)
  task block <id> --reason | cancel <id> --reason
  brief <id>                             print the brief skeleton for a work item
  decision add --title --decision --why [--authority human|forge]
  discovery add --title --evidence --impact [--affects T1,T2]
  baseline capture | check               brownfield: record and guard pre-existing state
  status                                 project overview
  dashboard                              (re)generate forge/dashboard.html — also auto-regens on every state change
  hook session-start|pretooluse|stop     (used by plugin hooks)`);
  }
};

// ---------------------------------------------------------------------------

const cmd = argv[0] || 'help';
if (!commands[cmd]) die(`Unknown command '${cmd}'. Try: forge help`);
commands[cmd]();
