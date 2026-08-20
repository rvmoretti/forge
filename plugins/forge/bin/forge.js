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
function saveWork(w) { writeJson(WORK_FILE, w); }

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
    out('Decision recorded.');
  },

  discovery() {
    if (argv[1] !== 'add') die('Usage: forge discovery add --title t --evidence e --impact i [--affects T1,T2]');
    appendMd(DISCOVERIES_FILE, '# Discoveries log (append-only, via forge CLI)',
      `\n### ${ts()} — ${opt('title') || '(untitled)'}\n- Evidence: ${opt('evidence') || ''}\n- Impact: ${opt('impact') || ''}\n- Affects: ${opt('affects') || '-'}\n`);
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
  hook session-start|pretooluse|stop     (used by plugin hooks)`);
  }
};

// ---------------------------------------------------------------------------

const cmd = argv[0] || 'help';
if (!commands[cmd]) die(`Unknown command '${cmd}'. Try: forge help`);
commands[cmd]();
