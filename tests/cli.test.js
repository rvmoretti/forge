'use strict';
/**
 * Forge CLI refusal tests (F1) — one test per advertised refusal/gate.
 * Runs the real CLI against throwaway git projects. No dependencies:
 *   node --test tests/
 */
const { test, before, beforeEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const CLI = path.resolve(__dirname, '..', 'plugins', 'forge', 'bin', 'forge.js');
let dir;

function forge(args, opts = {}) {
  const r = spawnSync(process.execPath, [CLI, ...args], {
    cwd: dir, encoding: 'utf8', input: opts.stdin || '',
    env: Object.assign({}, process.env,
      { CLAUDE_PROJECT_DIR: dir, FORGE_CLAUDE_PROJECTS: path.join(os.tmpdir(), 'forge-no-such-logs'), FORGE_DEFAULTS: path.join(os.tmpdir(), 'forge-no-such-defaults.json') },
      opts.env || {})
  });
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
}
function hook(name, stdinObj) {
  const r = spawnSync(process.execPath, [CLI, 'hook', name], {
    cwd: dir, encoding: 'utf8', input: JSON.stringify(stdinObj || {}),
    env: Object.assign({}, process.env,
      { CLAUDE_PROJECT_DIR: dir, FORGE_CLAUDE_PROJECTS: path.join(os.tmpdir(), 'forge-no-such-logs'), FORGE_DEFAULTS: path.join(os.tmpdir(), 'forge-no-such-defaults.json') })
  });
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
}
function freshProject() {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-test-'));
  spawnSync('git', ['init', '-q'], { cwd: dir });
  spawnSync('git', ['config', 'user.email', 't@t'], { cwd: dir });
  spawnSync('git', ['config', 'user.name', 't'], { cwd: dir });
  forge(['init', '--project', 'test']);
  forge(['config', 'set', 'phase', 'build']);
  forge(['config', 'set', 'verify.test', 'node -e "process.exit(0)"']);
  forge(['config', 'set', 'options.graphify', 'skip']);
  // v0.17: the per-milestone git flow is the default; the legacy tests exercise the
  // gates without git, so they opt out explicitly (the v0.17 tests opt back in).
  forge(['config', 'set', 'options.integration', 'manual', '--reason', 'test fixture']);
  // v0.21: forge init turns the delegation switches on for NEW projects; the legacy tests
  // exercise an existing project, where they are absent (off). v0.21 tests opt back in.
  const cf = path.join(dir, 'forge', 'config.json');
  const c = JSON.parse(fs.readFileSync(cf, 'utf8'));
  for (const k of ['itemShape', 'workerExplore', 'contextPack', 'briefLimit', 'retryFromReview', 'requireDispatch', 'requireTester', 'architectPrepass', 'delegateSpecSync']) delete c.options[k];
  // v0.22: new projects also start with fixed model routing and runner-capable autopilot settings;
  // the legacy tests exercise an existing project (auto routing). v0.22 tests opt back in.
  for (const k of ['modelRouting', 'models', 'autopilotMode']) delete c.options[k];
  fs.writeFileSync(cf, JSON.stringify(c, null, 2));
}
function switchOn(k, v) { forge(['config', 'set', 'options.' + k, String(v)]); }
function addItem(id, extra = []) {
  // v0.12: start refuses an unscoped item — default a scope; explicit --allowed in `extra` wins (opt() takes the first).
  return forge(['task', 'add', '--id', id, '--title', id, '--criterion', 'ok::node -e "process.exit(0)"', ...extra, '--allowed', 'src/']);
}
function touch(name) {
  fs.writeFileSync(path.join(dir, name), String(Math.random()));
}

beforeEach(freshProject);

// --- start refusals ---------------------------------------------------------

test('start refuses with no criteria', () => {
  forge(['task', 'add', '--id', 'T1', '--title', 'no criteria']);
  const r = forge(['task', 'start', 'T1']);
  assert.notStrictEqual(r.code, 0);
  assert.match(r.out, /no acceptance criteria/);
});

test('start refuses with unmet deps', () => {
  addItem('T1'); addItem('T2', ['--deps', 'T1']);
  const r = forge(['task', 'start', 'T2']);
  assert.notStrictEqual(r.code, 0);
  assert.match(r.out, /unfinished dependencies/);
});

test('start refuses from IN_PROGRESS (retry-ladder bypass closed)', () => {
  addItem('T1');
  forge(['task', 'start', 'T1']);
  const r = forge(['task', 'start', 'T1']);
  assert.notStrictEqual(r.code, 0);
  assert.match(r.out, /already IN_PROGRESS/);
});

test('start refuses 3rd attempt without --escalate, allows with it', () => {
  addItem('T1');
  for (let i = 0; i < 2; i++) {
    forge(['task', 'start', 'T1']);
    forge(['task', 'fail', 'T1', '--note', 'diag ' + i]);
  }
  const refused = forge(['task', 'start', 'T1']);
  assert.notStrictEqual(refused.code, 0);
  assert.match(refused.out, /--escalate/);
  const allowed = forge(['task', 'start', 'T1', '--escalate', 'stronger-model', '--note', 'escalating']);
  assert.strictEqual(allowed.code, 0);
});

// --- verify / done gates ----------------------------------------------------

test('verify refuses when nothing executable exists', () => {
  forge(['config', 'set', 'verify.test', '']); // leaves key but empty -> still runs; use fresh cfg instead
  freshProject();
  // remove verify commands entirely by re-initing config
  fs.writeFileSync(path.join(dir, 'forge', 'config.json'),
    JSON.stringify({ project: 't', phase: 'build', verify: {}, options: { graphify: 'skip' } }));
  forge(['task', 'add', '--id', 'T1', '--title', 't', '--criterion', 'manual only']);
  const r = forge(['task', 'verify', 'T1']);
  assert.notStrictEqual(r.code, 0);
  assert.match(r.out, /Nothing executable/);
});

test('done refuses without a passing verification record', () => {
  addItem('T1');
  forge(['task', 'start', 'T1']);
  const r = forge(['task', 'done', 'T1']);
  assert.notStrictEqual(r.code, 0);
  assert.match(r.out, /no passing verification/);
});

test('done refuses when the last verification failed; verify exits 1 on failure', () => {
  addItem('T1', ['--criterion', 'fails::node -e "process.exit(1)"']);
  forge(['task', 'start', 'T1']);
  touch('work.txt'); // real work happened
  const v = forge(['task', 'verify', 'T1']);
  assert.notStrictEqual(v.code, 0);
  const r = forge(['task', 'done', 'T1']);
  assert.notStrictEqual(r.code, 0);
});

test('done refuses on stale evidence (tree changed after verify)', () => {
  addItem('T1');
  forge(['task', 'start', 'T1']);
  touch('work.txt');
  assert.strictEqual(forge(['task', 'verify', 'T1']).code, 0);
  touch('later-edit.txt'); // tree drifts after the green verify
  const r = forge(['task', 'done', 'T1']);
  assert.notStrictEqual(r.code, 0);
  assert.match(r.out, /tree changed since/);
});

test('red-first: done refuses when checks were green before work and tree unchanged', () => {
  addItem('T1'); // check always passes => green at start
  const s = forge(['task', 'start', 'T1']);
  assert.match(s.out, /ALREADY PASS/);
  forge(['task', 'verify', 'T1']); // no file changes made
  const r = forge(['task', 'done', 'T1']);
  assert.notStrictEqual(r.code, 0);
  assert.match(r.out, /prove nothing/);
});

test('red-first: done succeeds when work actually changed the tree', () => {
  addItem('T1');
  forge(['task', 'start', 'T1']);
  touch('src.js'); // the work
  assert.strictEqual(forge(['task', 'verify', 'T1']).code, 0);
  assert.strictEqual(forge(['task', 'done', 'T1']).code, 0);
});

// --- baseline in verify -----------------------------------------------------

test('verify includes baseline; regression fails verification', () => {
  addItem('T1');
  forge(['baseline', 'capture']); // GREEN baseline
  forge(['task', 'start', 'T1']);
  touch('work.txt');
  // break the project check => baseline regression
  fs.writeFileSync(path.join(dir, 'forge', 'config.json'),
    JSON.stringify({ project: 't', phase: 'build', verify: { test: 'node -e "process.exit(0)"' }, options: { graphify: 'skip' } }));
  // regression simulated via criterion? Instead: change baseline cmd result by breaking it
  const cfg = JSON.parse(fs.readFileSync(path.join(dir, 'forge', 'config.json'), 'utf8'));
  cfg.verify.test = 'node -e "process.exit(1)"';
  fs.writeFileSync(path.join(dir, 'forge', 'config.json'), JSON.stringify(cfg));
  const v = forge(['task', 'verify', 'T1']);
  assert.notStrictEqual(v.code, 0);
  assert.match(v.out, /baseline/);
});

test('verify --skip-baseline requires a reason', () => {
  addItem('T1');
  forge(['baseline', 'capture']);
  forge(['task', 'start', 'T1']);
  const r = forge(['task', 'verify', 'T1', '--skip-baseline']);
  assert.notStrictEqual(r.code, 0);
  assert.match(r.out, /--reason/);
});

// --- cancel / update --------------------------------------------------------

test('cancel refuses without --reason and refuses DONE items', () => {
  addItem('T1');
  const r1 = forge(['task', 'cancel', 'T1']);
  assert.notStrictEqual(r1.code, 0);
  forge(['task', 'start', 'T1']); touch('w'); forge(['task', 'verify', 'T1']); forge(['task', 'done', 'T1']);
  const r2 = forge(['task', 'cancel', 'T1', '--reason', 'x']);
  assert.notStrictEqual(r2.code, 0);
  assert.match(r2.out, /DONE/);
});

test('cancel refuses to strand dependents; --dependents drop unbricks them', () => {
  addItem('T1'); addItem('T2', ['--deps', 'T1']);
  const refused = forge(['task', 'cancel', 'T1', '--reason', 'obsolete']);
  assert.notStrictEqual(refused.code, 0);
  assert.match(refused.out, /strand dependent/);
  const ok = forge(['task', 'cancel', 'T1', '--reason', 'obsolete', '--dependents', 'drop']);
  assert.strictEqual(ok.code, 0);
  assert.strictEqual(forge(['task', 'start', 'T2']).code, 0); // T2 no longer bricked
});

test('update revises criteria; requires --reason after failed attempts', () => {
  addItem('T1');
  forge(['task', 'start', 'T1']);
  forge(['task', 'fail', 'T1', '--note', 'bad criteria']);
  const refused = forge(['task', 'update', 'T1', '--criterion-add', 'better::node -e "process.exit(0)"']);
  assert.notStrictEqual(refused.code, 0);
  assert.match(refused.out, /--reason/);
  const ok = forge(['task', 'update', 'T1', '--criterion-add', 'better::node -e "process.exit(0)"', '--reason', 'goalposts moved knowingly']);
  assert.strictEqual(ok.code, 0);
});

// --- opt() hygiene ----------------------------------------------------------

test('omitted flag value does not swallow the next flag', () => {
  addItem('T1');
  for (let i = 0; i < 2; i++) { forge(['task', 'start', 'T1']); forge(['task', 'fail', 'T1', '--note', 'd' + i]); }
  // --escalate with no value followed by --note must NOT record "--note" as strategy
  const r = forge(['task', 'start', 'T1', '--escalate', '--note', 'why']);
  assert.notStrictEqual(r.code, 0); // escalate had no value => still refused
});

// --- milestone gates --------------------------------------------------------

test('milestone gate blocks next milestone until approved; approve unblocks', () => {
  addItem('M1a', ['--milestone', 'M1']);
  addItem('M2a', ['--milestone', 'M2']);
  forge(['task', 'start', 'M1a']); touch('w1'); forge(['task', 'verify', 'M1a']); forge(['task', 'done', 'M1a']);
  const blocked = forge(['task', 'start', 'M2a']);
  assert.notStrictEqual(blocked.code, 0);
  assert.match(blocked.out, /awaits HUMAN approval/);
  const early = forge(['milestone', 'approve', 'M2']);
  assert.notStrictEqual(early.code, 0); // cannot approve an unfinished milestone
  forge(['milestone', 'security', 'M1', '--agent', 'forge-reviewer', '--note', 'pass clean']); // v0.8: gate requires the security review
  assert.strictEqual(forge(['milestone', 'approve', 'M1', '--note', 'demo ok']).code, 0);
  assert.strictEqual(forge(['task', 'start', 'M2a']).code, 0);
});

test('gates end-only disables milestone blocking', () => {
  forge(['config', 'set', 'options.gates', 'end-only']);
  addItem('M1a', ['--milestone', 'M1']);
  addItem('M2a', ['--milestone', 'M2']);
  forge(['task', 'start', 'M1a']); touch('w1'); forge(['task', 'verify', 'M1a']); forge(['task', 'done', 'M1a']);
  assert.strictEqual(forge(['task', 'start', 'M2a']).code, 0);
});

// --- hooks ------------------------------------------------------------------

test('pretooluse denies forge state writes, allows normal writes', () => {
  const denyState = hook('pretooluse', { tool_name: 'Edit', tool_input: { file_path: 'forge/state/work.json' } });
  assert.strictEqual(denyState.code, 2);
  const denyCfg = hook('pretooluse', { tool_name: 'Write', tool_input: { file_path: 'forge/config.json' } });
  assert.strictEqual(denyCfg.code, 2);
  const allow = hook('pretooluse', { tool_name: 'Write', tool_input: { file_path: 'src/app.js' } });
  assert.strictEqual(allow.code, 0);
});

test('stop hook blocks on IN_PROGRESS, reports failed-TODO, respects stop_hook_active', () => {
  addItem('T1');
  forge(['task', 'start', 'T1']);
  const blocked = hook('stop', {});
  assert.strictEqual(blocked.code, 2);
  assert.match(blocked.out, /IN_PROGRESS/);
  const loopGuard = hook('stop', { stop_hook_active: true });
  assert.strictEqual(loopGuard.code, 0);
  forge(['task', 'fail', 'T1', '--note', 'd']);
  const failedTodo = hook('stop', {});
  assert.strictEqual(failedTodo.code, 2);
  assert.match(failedTodo.out, /failed attempts/);
  forge(['task', 'block', 'T1', '--reason', 'awaiting decision']);
  // blocked-with-reason + no failed-TODO-only rule violation? T1 now BLOCKED (not TODO) => clean stop
  assert.strictEqual(hook('stop', {}).code, 0);
});

// --- usage: dispatch → work-item tie (v0.4.5) -------------------------------

test('usage ties dispatches via inline header, brief file path, and known item id', () => {
  addItem('T20'); addItem('T20f');
  // fake session logs: FORGE_CLAUDE_PROJECTS/<sanitized-cwd>/session.jsonl
  const logsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-logs-'));
  const projDir = path.join(logsRoot, dir.replace(/[^a-zA-Z0-9]/g, '-'));
  fs.mkdirSync(projDir, { recursive: true });
  const disp = (prompt) => JSON.stringify({
    type: 'assistant', timestamp: '2026-08-26T12:00:00.000Z',
    message: { model: 'm', usage: { output_tokens: 1 },
      content: [{ type: 'tool_use', name: 'Task', input: { subagent_type: 'forge:forge-implementer', prompt } }] }
  });
  fs.writeFileSync(path.join(projDir, 'session.jsonl'), [
    disp('# Work brief — T20: title\ndo the thing'),                    // 1. inline header
    disp('Your brief is in forge/briefs/T20f.md — follow it exactly'),  // 2. brief file path
    disp('Implement the T20f follow-up per the attached spec'),         // 3. bare known id (longest match wins)
    disp('Refactor the widget; no item reference anywhere'),            // untied
  ].join('\n'));
  const r = spawnSync(process.execPath, [CLI, 'usage'], {
    cwd: dir, encoding: 'utf8',
    env: Object.assign({}, process.env, { CLAUDE_PROJECT_DIR: dir, FORGE_CLAUDE_PROJECTS: logsRoot })
  });
  const out = (r.stdout || '') + (r.stderr || '');
  assert.strictEqual(r.status, 0);
  assert.match(out, /T20×1/);
  assert.match(out, /T20f×2/);
  assert.match(out, /1 dispatch\(es\) could not be tied/);
});

// --- v0.5: orchestrator session lock ----------------------------------------

test('pretooluse blocks writes from a second session while the first is active', () => {
  // session A claims via a write
  const a = hook('pretooluse', { session_id: 'sess-A', tool_name: 'Write', tool_input: { file_path: 'src/app.js' } });
  assert.strictEqual(a.code, 0);
  // session B is refused
  const b = hook('pretooluse', { session_id: 'sess-B', tool_name: 'Write', tool_input: { file_path: 'src/app.js' } });
  assert.strictEqual(b.code, 2);
  assert.match(b.out, /EDIT-WAR GUARD/);
  // session A keeps working
  const a2 = hook('pretooluse', { session_id: 'sess-A', tool_name: 'Edit', tool_input: { file_path: 'src/other.js' } });
  assert.strictEqual(a2.code, 0);
});

test('a stale lock is taken over silently; a released lock too', () => {
  hook('pretooluse', { session_id: 'sess-A', tool_name: 'Write', tool_input: { file_path: 'src/app.js' } });
  // age the lock past the TTL
  const sessFile = path.join(dir, 'forge', 'state', 'session.json');
  const l = JSON.parse(fs.readFileSync(sessFile, 'utf8'));
  l.lastBeat = new Date(Date.now() - 16 * 60 * 1000).toISOString();
  fs.writeFileSync(sessFile, JSON.stringify(l));
  const b = hook('pretooluse', { session_id: 'sess-B', tool_name: 'Write', tool_input: { file_path: 'src/app.js' } });
  assert.strictEqual(b.code, 0);
  assert.strictEqual(JSON.parse(fs.readFileSync(sessFile, 'utf8')).sessionId, 'sess-B');
});

test('clean stop releases the lock; the next session claims freely', () => {
  hook('pretooluse', { session_id: 'sess-A', tool_name: 'Write', tool_input: { file_path: 'src/app.js' } });
  const stop = hook('stop', { session_id: 'sess-A' });
  assert.strictEqual(stop.code, 0);
  const sessFile = path.join(dir, 'forge', 'state', 'session.json');
  assert.strictEqual(JSON.parse(fs.readFileSync(sessFile, 'utf8')).released, true);
  const b = hook('pretooluse', { session_id: 'sess-B', tool_name: 'Write', tool_input: { file_path: 'src/app.js' } });
  assert.strictEqual(b.code, 0);
});

test('session takeover refuses an active lock without --force, clears with it', () => {
  hook('pretooluse', { session_id: 'sess-A', tool_name: 'Write', tool_input: { file_path: 'src/app.js' } });
  const refuse = forge(['session', 'takeover']);
  assert.notStrictEqual(refuse.code, 0);
  assert.match(refuse.out, /ACTIVE/);
  const force = forge(['session', 'takeover', '--force']);
  assert.strictEqual(force.code, 0);
  const b = hook('pretooluse', { session_id: 'sess-B', tool_name: 'Write', tool_input: { file_path: 'src/app.js' } });
  assert.strictEqual(b.code, 0);
});

// --- v0.5: decision/discovery title required ---------------------------------

test('discovery/decision add refuse without a title; positional title accepted', () => {
  const discFile = path.join(dir, 'forge', 'discoveries.md');
  const before = fs.existsSync(discFile) ? fs.readFileSync(discFile, 'utf8') : null;
  const noTitle = forge(['discovery', 'add', '--evidence', 'e', '--impact', 'i']);
  assert.notStrictEqual(noTitle.code, 0);
  assert.match(noTitle.out, /needs a title/);
  const after = fs.existsSync(discFile) ? fs.readFileSync(discFile, 'utf8') : null;
  assert.strictEqual(after, before); // nothing appended
  const positional = forge(['discovery', 'add', 'S8 screen missing', '--impact', 'i']);
  assert.strictEqual(positional.code, 0);
  assert.match(fs.readFileSync(path.join(dir, 'forge', 'discoveries.md'), 'utf8'), /S8 screen missing/);
  const dec = forge(['decision', 'add', '--decision', 'd', '--why', 'w']);
  assert.notStrictEqual(dec.code, 0);
  assert.match(dec.out, /needs a title/);
});

// --- v0.6: scope enforcement -------------------------------------------------

test('hook blocks edits to a forbidden path while its item is IN_PROGRESS, allows after done', () => {
  forge(['task', 'add', '--id', 'T1', '--title', 't', '--criterion', 'ok::node -e "process.exit(0)"',
         '--allowed', 'src/,schemas/', '--forbidden', 'src/gen/,schemas/events.json']);
  forge(['task', 'start', 'T1']);
  const dir1 = hook('pretooluse', { session_id: 's1', tool_name: 'Write', tool_input: { file_path: 'src/gen/Model.java' } });
  assert.strictEqual(dir1.code, 2);
  assert.match(dir1.out, /SCOPE GUARD/);
  assert.match(dir1.out, /T1/);
  const exact = hook('pretooluse', { session_id: 's1', tool_name: 'Edit', tool_input: { file_path: 'schemas/events.json' } });
  assert.strictEqual(exact.code, 2);
  const ok = hook('pretooluse', { session_id: 's1', tool_name: 'Write', tool_input: { file_path: 'src/app.js' } });
  assert.strictEqual(ok.code, 0);
  // resolve the item — the forbidden scope no longer applies
  touch('work.txt');
  forge(['task', 'verify', 'T1']);
  forge(['task', 'done', 'T1']);
  const after = hook('pretooluse', { session_id: 's1', tool_name: 'Write', tool_input: { file_path: 'src/gen/Model.java' } });
  assert.strictEqual(after.code, 0);
});

test('config options.protect blocks edits regardless of work items', () => {
  forge(['config', 'set', 'options.protect', 'migrations/,vendor/']);
  const r = hook('pretooluse', { session_id: 's1', tool_name: 'Write', tool_input: { file_path: 'migrations/001_init.sql' } });
  assert.strictEqual(r.code, 2);
  assert.match(r.out, /PROTECTED PATH/);
  const ok = hook('pretooluse', { session_id: 's1', tool_name: 'Write', tool_input: { file_path: 'src/app.js' } });
  assert.strictEqual(ok.code, 0);
});

// --- v0.6: stats ---------------------------------------------------------------

test('stats reports first-pass rate, retries and milestone health', () => {
  forge(['task', 'add', '--id', 'T1', '--title', 't', '--criterion', 'ok::node -e "process.exit(0)"', '--milestone', 'M1', '--allowed', 'src/']);
  forge(['task', 'add', '--id', 'T2', '--title', 't', '--criterion', 'ok::node -e "process.exit(0)"', '--milestone', 'M1', '--allowed', 'src/']);
  forge(['task', 'start', 'T1']); touch('a.txt');
  forge(['task', 'verify', 'T1']); forge(['task', 'done', 'T1']);
  forge(['task', 'start', 'T2']);
  forge(['task', 'fail', 'T2', '--note', 'diag']);
  forge(['task', 'start', 'T2']); touch('b.txt');
  forge(['task', 'verify', 'T2']); forge(['task', 'done', 'T2']);
  const r = forge(['stats']);
  assert.strictEqual(r.code, 0);
  assert.match(r.out, /First-pass rate: 1\/2/);
  assert.match(r.out, /T2×1/);
  assert.match(r.out, /M1: 2\/2 done/);
});

// --- v0.7: trace + doctor ------------------------------------------------------

test('trace records commands, refusals and hook blocks with version stamps', () => {
  forge(['task', 'add', '--id', 'T1', '--title', 'no criteria']);
  forge(['task', 'start', 'T1']); // refused: no criteria
  hook('pretooluse', { session_id: 's1', tool_name: 'Write', tool_input: { file_path: 'forge/state/work.json' } }); // blocked: state-guard
  const traceFile = path.join(dir, 'forge', 'state', 'trace.jsonl');
  const evs = fs.readFileSync(traceFile, 'utf8').split('\n').filter(Boolean).map(JSON.parse);
  assert.ok(evs.length >= 3);
  assert.ok(evs.every(e => e.v && e.ts && e.cmd !== undefined));
  assert.ok(evs.some(e => e.outcome === 'refused' && /no acceptance criteria/.test(e.refusal)));
  assert.ok(evs.some(e => e.outcome === 'block' && e.reason === 'state-guard'));
  const r = forge(['trace', '--refusals']);
  assert.strictEqual(r.code, 0);
  assert.match(r.out, /state-guard/);
});

test('trace never creates forge/ in an uninitialized directory', () => {
  const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-bare-'));
  spawnSync(process.execPath, [CLI, 'task', 'list'], {
    cwd: bare, encoding: 'utf8',
    env: Object.assign({}, process.env, { CLAUDE_PROJECT_DIR: bare })
  });
  assert.ok(!fs.existsSync(path.join(bare, 'forge')));
});

test('doctor passes on a healthy project and flags orphaned IN_PROGRESS work', () => {
  const ok = forge(['doctor']);
  assert.strictEqual(ok.code, 0);
  assert.match(ok.out, /look sane/);
  // orphan an item: start it, then age the lock out
  addItem('T1');
  forge(['task', 'start', 'T1']);
  const sessFile = path.join(dir, 'forge', 'state', 'session.json');
  hook('pretooluse', { session_id: 'sX', tool_name: 'Write', tool_input: { file_path: 'src/a.js' } });
  const l = JSON.parse(fs.readFileSync(sessFile, 'utf8'));
  l.lastBeat = new Date(Date.now() - 20 * 60 * 1000).toISOString();
  fs.writeFileSync(sessFile, JSON.stringify(l));
  const bad = forge(['doctor']);
  assert.match(bad.out, /orphaned work/);
});

// --- v0.8: security in the gate -------------------------------------------------

test('milestone approve refuses without a security review; passes with one; skip needs a reason', () => {
  addItem('T1', ['--milestone', 'M1']);
  forge(['task', 'start', 'T1']); touch('w1');
  forge(['task', 'verify', 'T1']); forge(['task', 'done', 'T1']);
  const refused = forge(['milestone', 'approve', 'M1', '--note', 'ok']);
  assert.notStrictEqual(refused.code, 0);
  assert.match(refused.out, /no recorded security review/);
  const badSkip = forge(['milestone', 'approve', 'M1', '--skip-security']);
  assert.notStrictEqual(badSkip.code, 0);
  assert.match(badSkip.out, /--reason/);
  forge(['milestone', 'security', 'M1', '--agent', 'forge-reviewer', '--note', 'reviewer pass clean, no findings']);
  const ok = forge(['milestone', 'approve', 'M1', '--note', 'demo ok']);
  assert.strictEqual(ok.code, 0);
});

test('milestone approve with options.security off needs no review; skip-security is recorded in decisions', () => {
  forge(['config', 'set', 'options.security', 'off']);
  addItem('T1', ['--milestone', 'M1']);
  forge(['task', 'start', 'T1']); touch('w1');
  forge(['task', 'verify', 'T1']); forge(['task', 'done', 'T1']);
  assert.strictEqual(forge(['milestone', 'approve', 'M1', '--note', 'ok']).code, 0);
  // second project path: skip with reason lands in the decisions log
  freshProject();
  addItem('T1', ['--milestone', 'M1']);
  forge(['task', 'start', 'T1']); touch('w1');
  forge(['task', 'verify', 'T1']); forge(['task', 'done', 'T1']);
  assert.strictEqual(forge(['milestone', 'approve', 'M1', '--skip-security', '--reason', 'internal prototype']).code, 0);
  assert.match(fs.readFileSync(path.join(dir, 'forge', 'decisions.md'), 'utf8'), /SECURITY REVIEW SKIPPED: internal prototype/);
});

// --- v0.9: evidence artifacts ---------------------------------------------------

test('verify records existing artifacts and warns on missing ones', () => {
  addItem('T1');
  forge(['task', 'start', 'T1']);
  touch('shot.png');
  const r = forge(['task', 'verify', 'T1', '--artifact', 'shot.png', '--artifact', 'missing.png']);
  assert.strictEqual(r.code, 0);
  assert.match(r.out, /missing.png does not exist/);
  const w = JSON.parse(fs.readFileSync(path.join(dir, 'forge', 'state', 'work.json'), 'utf8'));
  const v = w.items.T1.verifications.at(-1);
  assert.deepStrictEqual(v.artifacts, ['shot.png']);
});

// --- v0.10: component map --------------------------------------------------------

test('component add routes screens / parts / tags; unknown --component tags auto-register as tags', () => {
  forge(['component', 'add', 'listing-detail', '--name', 'Listing detail', '--kind', 'frontend', '--route', '/anuncios/:id']);
  const dup = forge(['component', 'add', 'listing-detail']);
  assert.notStrictEqual(dup.code, 0);
  forge(['component', 'add', 'db', '--name', 'Postgres', '--kind', 'db']);
  forge(['task', 'add', '--id', 'T1', '--title', 't', '--criterion', 'ok::node -e "process.exit(0)"', '--component', 'listing-detail']);
  forge(['task', 'add', '--id', 'T2', '--title', 't', '--criterion', 'ok::node -e "process.exit(0)"', '--component', 'api-core']); // auto-registers as a tag
  const c = JSON.parse(fs.readFileSync(path.join(dir, 'forge', 'state', 'components.json'), 'utf8'));
  assert.strictEqual(c.schema, 2);
  assert.ok(c.screens['listing-detail']);
  assert.strictEqual(c.screens['listing-detail'].route, '/anuncios/:id');
  assert.ok(c.components.db);
  assert.ok(c.tags['api-core']);
  const list = forge(['component', 'list']);
  assert.match(list.out, /Screens \(1\)/);
  assert.match(list.out, /api-core 0\/1/);
  const dash = fs.readFileSync(path.join(dir, 'forge', 'dashboard.html'), 'utf8');
  assert.match(dash, /data-page="architecture"/);
  assert.match(dash, /Postgres/);
  assert.match(dash, /Listing detail/);
});

// --- v0.12: state-write lock -------------------------------------------------

test('concurrent task adds all persist under the state lock', async () => {
  const { spawn } = require('child_process');
  const N = 12;
  await Promise.all(Array.from({ length: N }, (_, i) => new Promise(res => {
    spawn(process.execPath, [CLI, 'task', 'add', '--id', 'P' + i, '--title', 'p',
      '--criterion', 'ok::node -e "process.exit(0)"', '--allowed', `p${i}/`], {
      cwd: dir, env: Object.assign({}, process.env, { CLAUDE_PROJECT_DIR: dir, FORGE_LOCK_WAIT_MS: '30000' })
    }).on('exit', res);
  })));
  const w = JSON.parse(fs.readFileSync(path.join(dir, 'forge', 'state', 'work.json'), 'utf8'));
  assert.strictEqual(Object.keys(w.items).filter(k => k.startsWith('P')).length, N);
});

test('a live-holder lock refuses a concurrent mutation; a dead-holder lock breaks and is traced', () => {
  const lock = path.join(dir, 'forge', 'state', 'work.lock');
  fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, ts: new Date().toISOString(), cmd: 'test-holder' }));
  const refused = forge(['task', 'add', '--id', 'L1', '--title', 'l', '--criterion', 'ok::node -e "process.exit(0)"', '--allowed', 'l/'],
    { env: { FORGE_LOCK_WAIT_MS: '300' } });
  assert.notStrictEqual(refused.code, 0);
  assert.match(refused.out, /write-locked/);
  fs.writeFileSync(lock, JSON.stringify({ pid: 999999, ts: new Date().toISOString(), cmd: 'dead-holder' }));
  const ok = forge(['task', 'add', '--id', 'L2', '--title', 'l', '--criterion', 'ok::node -e "process.exit(0)"', '--allowed', 'l2/']);
  assert.strictEqual(ok.code, 0);
  assert.match(fs.readFileSync(path.join(dir, 'forge', 'state', 'trace.jsonl'), 'utf8'), /lock-break/);
  assert.ok(!fs.existsSync(lock)); // released on exit
});

test('read-only commands proceed while the lock is held', () => {
  addItem('R1');
  const lock = path.join(dir, 'forge', 'state', 'work.lock');
  fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, ts: new Date().toISOString(), cmd: 'test-holder' }));
  assert.strictEqual(forge(['task', 'list'], { env: { FORGE_LOCK_WAIT_MS: '300' } }).code, 0);
  assert.strictEqual(forge(['status'], { env: { FORGE_LOCK_WAIT_MS: '300' } }).code, 0);
  fs.unlinkSync(lock);
});

// --- v0.12: scope.allowed required + whitelist --------------------------------

test('start refuses an empty scope.allowed; --whole-tree needs a reason, then records **', () => {
  forge(['task', 'add', '--id', 'S1', '--title', 's', '--criterion', 'ok::node -e "process.exit(0)"']);
  const r = forge(['task', 'start', 'S1']);
  assert.notStrictEqual(r.code, 0);
  assert.match(r.out, /no allowed file scope/);
  const noReason = forge(['task', 'start', 'S1', '--whole-tree']);
  assert.notStrictEqual(noReason.code, 0);
  assert.match(noReason.out, /--reason/);
  assert.strictEqual(forge(['task', 'start', 'S1', '--whole-tree', '--reason', 'repo-wide rename']).code, 0);
  const w = JSON.parse(fs.readFileSync(path.join(dir, 'forge', 'state', 'work.json'), 'utf8'));
  assert.deepStrictEqual(w.items.S1.scope.allowed, ['**']);
});

test('hook enforces scope.allowed as a whitelist with exemptions; inert when an in-progress item lacks scope', () => {
  addItem('W1'); // allowed: src/
  forge(['task', 'start', 'W1']);
  const outside = hook('pretooluse', { session_id: 's1', tool_name: 'Write', tool_input: { file_path: 'lib/x.js' } });
  assert.strictEqual(outside.code, 2);
  assert.match(outside.out, /OUTSIDE the allowed scope/);
  assert.strictEqual(hook('pretooluse', { session_id: 's1', tool_name: 'Write', tool_input: { file_path: 'src/x.js' } }).code, 0);
  assert.strictEqual(hook('pretooluse', { session_id: 's1', tool_name: 'Write', tool_input: { file_path: 'PLAN.md' } }).code, 0);
  assert.strictEqual(hook('pretooluse', { session_id: 's1', tool_name: 'Write', tool_input: { file_path: 'docs/notes.txt' } }).code, 0);
  assert.match(fs.readFileSync(path.join(dir, 'forge', 'state', 'trace.jsonl'), 'utf8'), /scope-allowed/);
  // pre-v0.12 state compat: an in-progress item without a scope disables the whitelist (blacklist still applies)
  const wf = path.join(dir, 'forge', 'state', 'work.json');
  const w = JSON.parse(fs.readFileSync(wf, 'utf8'));
  w.items.W1.scope.allowed = [];
  fs.writeFileSync(wf, JSON.stringify(w));
  assert.strictEqual(hook('pretooluse', { session_id: 's1', tool_name: 'Write', tool_input: { file_path: 'lib/x.js' } }).code, 0);
});

test('task list flags items without a scope and withholds READY', () => {
  forge(['task', 'add', '--id', 'N1', '--title', 'n', '--criterion', 'ok::node -e "process.exit(0)"']);
  const r = forge(['task', 'list']);
  assert.match(r.out, /N1.*NO SCOPE/);
  assert.doesNotMatch(r.out, /N1.*\[READY\]/);
});

// --- v0.12: concurrency cap + disjoint scopes ---------------------------------

test('second in-flight item refused at cap 1; cap 2 allows disjoint scopes, refuses overlap; new projects start at 4', () => {
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(dir, 'forge', 'config.json'), 'utf8')).options.concurrency, 4);
  forge(['config', 'set', 'options.concurrency', '1']);
  addItem('C1'); // src/
  forge(['task', 'add', '--id', 'C2', '--title', 'c', '--criterion', 'ok::node -e "process.exit(0)"', '--allowed', 'lib/']);
  forge(['task', 'add', '--id', 'C3', '--title', 'c', '--criterion', 'ok::node -e "process.exit(0)"', '--allowed', 'src/deep/']);
  forge(['task', 'start', 'C1']);
  const capped = forge(['task', 'start', 'C2']);
  assert.notStrictEqual(capped.code, 0);
  assert.match(capped.out, /concurrency cap/);
  forge(['config', 'set', 'options.concurrency', '2']);
  const overlap = forge(['task', 'start', 'C3']);
  assert.notStrictEqual(overlap.code, 0);
  assert.match(overlap.out, /overlaps the scope/);
  assert.strictEqual(forge(['task', 'start', 'C2']).code, 0);
});

// --- v0.12.1: dashboard telemetry panel ----------------------------------------

test('dashboard renders time telemetry from dispatch records and tokens from the usage snapshot', () => {
  addItem('T1');
  forge(['task', 'start', 'T1']);
  forge(['task', 'dispatch', 'T1', '--agent', 'forge-implementer']);
  touch('work.txt');
  forge(['task', 'verify', 'T1']);
  forge(['task', 'done', 'T1']);
  // no snapshot yet → honest empty state
  let dash = fs.readFileSync(path.join(dir, 'forge', 'dashboard.html'), 'utf8');
  assert.match(dash, /Development time/);
  assert.match(dash, /forge-implementer/);
  assert.match(dash, /Median item start→done/);
  assert.match(dash, /No usage snapshot yet/);
  // snapshot present → token panel with staleness stamp
  fs.writeFileSync(path.join(dir, 'forge', 'state', 'usage.json'), JSON.stringify({
    ts: new Date().toISOString(),
    models: { 'claude-sonnet': { main: { calls: 10, in: 5000, out: 2000 }, side: { calls: 30, in: 90000, out: 41000 } } },
    byType: { 'forge:forge-implementer': 12 }, mainOut: 2000, sideOut: 41000
  }));
  forge(['dashboard']);
  dash = fs.readFileSync(path.join(dir, 'forge', 'dashboard.html'), 'utf8');
  assert.match(dash, /snapshot as of/);
  assert.match(dash, /41,000/);
  assert.match(dash, /% delegated/);
});

test('dashboard telemetry shows the no-records empty state on a fresh project', () => {
  addItem('T1');
  forge(['dashboard']);
  const dash = fs.readFileSync(path.join(dir, 'forge', 'dashboard.html'), 'utf8');
  assert.match(dash, /No dispatch records yet/);
});

// --- v0.13: guided experience + whole-graph + timing ---------------------------

test('session-start injects a computed next step; welcome guidance when uninitialized', () => {
  // uninitialized project → guided entry
  const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-welcome-'));
  spawnSync('git', ['init', '-q'], { cwd: bare });
  const r0 = spawnSync(process.execPath, [CLI, 'hook', 'session-start'], {
    cwd: bare, encoding: 'utf8', input: '{}',
    env: Object.assign({}, process.env, { CLAUDE_PROJECT_DIR: bare })
  });
  assert.match((r0.stdout || ''), /GUIDE THE USER IN/);
  assert.match((r0.stdout || ''), /FEATURE DUMP MOMENT/);
  // initialized project with an IN_PROGRESS item → "picking up" guidance
  addItem('T1');
  forge(['task', 'start', 'T1']);
  const r1 = hook('session-start', {});
  assert.match(r1.out, /YOUR NEXT STEP/);
  assert.match(r1.out, /IN_PROGRESS \(T1\)/);
  // milestone awaiting approval → "your turn" guidance
  touch('w.txt');
  forge(['task', 'verify', 'T1']);
  forge(['task', 'done', 'T1']);
  const r2 = hook('session-start', {});
  assert.match(r2.out, /YOUR NEXT STEP/);
});

test('scope warning targets only the active milestone; thin later-milestone items stay quiet', () => {
  forge(['task', 'add', '--id', 'A1', '--title', 'a', '--criterion', 'ok::node -e "process.exit(0)"', '--milestone', 'M1']); // active, unscoped → warn
  forge(['task', 'add', '--id', 'Z9', '--title', 'z', '--milestone', 'M9']); // thin backlog → quiet
  const r = forge(['task', 'list']);
  assert.match(r.out, /A1.*NO SCOPE/);
  assert.doesNotMatch(r.out, /Z9.*NO SCOPE/);
});

test('untagged component warning on add, preflight counts untagged, verification records duration', () => {
  const add = forge(['task', 'add', '--id', 'C9', '--title', 'c', '--criterion', 'ok::node -e "process.exit(0)"', '--allowed', 'src/']);
  assert.match(add.out, /no --component tag/);
  const pf = forge(['preflight']);
  assert.match(pf.out, /component map/);
  assert.match(pf.out, /not tagged/);
  forge(['task', 'start', 'C9']);
  touch('w.txt');
  forge(['task', 'verify', 'C9']);
  const w = JSON.parse(fs.readFileSync(path.join(dir, 'forge', 'state', 'work.json'), 'utf8'));
  const v = w.items.C9.verifications.at(-1);
  assert.ok(typeof v.durationMs === 'number' && v.durationMs >= 0);
  // dashboard: paged (v0.19), milestone groups collapsible
  const dash = fs.readFileSync(path.join(dir, 'forge', 'dashboard.html'), 'utf8');
  assert.match(dash, /<section class="page"/);
  assert.match(dash, /<details class="sec sub" open/);
});

// --- v0.13.1: readable dashboard + saved briefs --------------------------------

test('v0.14: --mock is stored, the dashboard renders the design strip, sidebar shell present', () => {
  fs.mkdirSync(path.join(dir, 'spec', 'mocks'), { recursive: true });
  // tiny valid png
  fs.writeFileSync(path.join(dir, 'spec', 'mocks', 's1.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64'));
  forge(['task', 'add', '--id', 'S1', '--title', 'screen', '--criterion', 'ok::node -e "process.exit(0)"', '--allowed', 'ui/', '--mock', 'spec/mocks/s1.png']);
  const w = JSON.parse(fs.readFileSync(path.join(dir, 'forge', 'state', 'work.json'), 'utf8'));
  assert.strictEqual(w.items.S1.mock, 'spec/mocks/s1.png');
  forge(['dashboard']);
  const dash = fs.readFileSync(path.join(dir, 'forge', 'dashboard.html'), 'utf8');
  assert.match(dash, /Design — intended vs built/);
  assert.match(dash, /spec\/mocks\/s1\.png/);
  assert.match(dash, /no screen capture yet/);
  assert.match(dash, /id="snav"/);           // branded sidebar shell
  assert.match(dash, /where things stand/);  // overview header
  // update --mock is audited
  const up = forge(['task', 'update', 'S1', '--mock', 'spec/mocks/s2.png']);
  assert.strictEqual(up.code, 0);
  assert.match(up.out, /mock = spec\/mocks\/s2\.png/);
});

test('brief --save writes forge/briefs/<id>.md and the dashboard links it in the item card', () => {
  forge(['component', 'add', 'ui', '--name', 'UI', '--kind', 'frontend']);
  forge(['task', 'add', '--id', 'B1', '--title', 'screen', '--objective', 'obj', '--criterion', 'ok::node -e "process.exit(0)"', '--allowed', 'src/', '--milestone', 'M1', '--component', 'ui']);
  forge(['task', 'add', '--id', 'B2', '--title', 'later', '--milestone', 'M2', '--component', 'ui', '--deps', 'B1']);
  const r = forge(['brief', 'B1', '--save']);
  assert.strictEqual(r.code, 0);
  assert.match(r.out, /Saved skeleton to forge\/briefs\/B1\.md/);
  assert.match(fs.readFileSync(path.join(dir, 'forge', 'briefs', 'B1.md'), 'utf8'), /Work brief — B1/);
  const dash = fs.readFileSync(path.join(dir, 'forge', 'dashboard.html'), 'utf8');
  assert.match(dash, /briefs\/B1\.md/);              // brief linked
  assert.match(dash, /details class="icd"/);          // per-item card
  assert.match(dash, /Acceptance criteria/);
  assert.match(dash, /thin item/);                    // B2 has no criteria yet
  assert.match(dash, /data-comp="ui"/);              // item card carries its tag for the plan filter
  assert.match(dash, /wgfilter/);                     // filter input present
});

test('dispatch records launches and mid-flight messages on IN_PROGRESS items only', () => {
  addItem('D1');
  const early = forge(['task', 'dispatch', 'D1', '--agent', 'forge-implementer']);
  assert.notStrictEqual(early.code, 0);
  assert.match(early.out, /not IN_PROGRESS/);
  forge(['task', 'start', 'D1']);
  assert.strictEqual(forge(['task', 'dispatch', 'D1', '--agent', 'forge-implementer']).code, 0);
  assert.strictEqual(forge(['task', 'dispatch', 'D1', '--kind', 'message', '--note', 'clarified API shape']).code, 0);
  assert.notStrictEqual(forge(['task', 'dispatch', 'D1', '--kind', 'resume']).code, 0);
  const w = JSON.parse(fs.readFileSync(path.join(dir, 'forge', 'state', 'work.json'), 'utf8'));
  assert.strictEqual(w.items.D1.dispatches.length, 2);
  assert.strictEqual(w.items.D1.dispatches[0].agent, 'forge-implementer');
  assert.strictEqual(w.items.D1.dispatches[0].kind, 'launch');
  assert.strictEqual(w.items.D1.dispatches[1].kind, 'message');
});

// --- v0.15: API workers (providers phase A), failure taxonomy, item-shape guard ---

const { spawn } = require('child_process');
function sleepSync(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }

// A scripted OpenAI-compatible provider: responds with S[n] per request (last repeats).
const MOCK_SERVER_SRC = `
const http=require('http');const fs=require('fs');let n=0;
const S=JSON.parse(fs.readFileSync(process.argv[1]+'.script','utf8'));
const srv=http.createServer((req,res)=>{let b='';req.on('data',c=>b+=c);req.on('end',()=>{
  try{fs.appendFileSync(process.argv[1]+'.log',b+'\\n===\\n')}catch(_){}
  const r=S[Math.min(n++,S.length-1)];
  res.writeHead(r.status||200,{'content-type':'application/json'});
  res.end(JSON.stringify(r.body||{}));});});
srv.listen(0,'127.0.0.1',()=>fs.writeFileSync(process.argv[1],String(srv.address().port)));
`;

function withMockProvider(script, fn) {
  const portFile = path.join(dir, 'provider.port');
  fs.writeFileSync(portFile + '.script', JSON.stringify(script));
  const child = spawn(process.execPath, ['-e', MOCK_SERVER_SRC, portFile], { stdio: 'ignore' });
  try {
    const t0 = Date.now();
    while (!fs.existsSync(portFile)) { if (Date.now() - t0 > 5000) throw new Error('mock provider did not start'); sleepSync(50); }
    return fn(fs.readFileSync(portFile, 'utf8').trim());
  } finally { child.kill(); }
}
const toolCallMsg = (calls, usage) => ({ status: 200, body: { choices: [{ message: { role: 'assistant', content: null, tool_calls: calls } }], usage } });

test('worker run refuses items that are not IN_PROGRESS, and demands model + key config', () => {
  addItem('W0');
  const r = forge(['worker', 'run', 'W0']);
  assert.notStrictEqual(r.code, 0);
  assert.match(r.out, /not IN_PROGRESS/);
  forge(['task', 'start', 'W0']);
  const noModel = forge(['worker', 'run', 'W0'], { env: { OPENROUTER_API_KEY: '' } });
  assert.notStrictEqual(noModel.code, 0);
  assert.match(noModel.out, /No worker model configured/);
  forge(['config', 'set', 'providers.model', 'test-model']);
  const noKey = forge(['worker', 'run', 'W0'], { env: { OPENROUTER_API_KEY: '' } });
  assert.notStrictEqual(noKey.code, 0);
  assert.match(noKey.out, /OPENROUTER_API_KEY is not set/);
  assert.match(noKey.out, /never stored/);
});

test('API worker: writes only inside scope, records an api dispatch with tokens, verification stays independent', () => {
  addItem('W1');
  forge(['task', 'start', 'W1']);
  forge(['config', 'set', 'providers.model', 'test-model']);
  const script = [
    toolCallMsg([
      { id: 'c1', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: 'docs/evil.txt', content: 'outside scope' }) } },
      { id: 'c2', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: 'src/out.txt', content: 'hello' }) } },
      { id: 'c3', type: 'function', function: { name: 'run_verify', arguments: JSON.stringify({ which: 'all' }) } }
    ], { prompt_tokens: 100, completion_tokens: 20 }),
    toolCallMsg([
      { id: 'c4', type: 'function', function: { name: 'done', arguments: JSON.stringify({ summary: 'wrote src/out.txt and verified', blocked: false }) } }
    ], { prompt_tokens: 60, completion_tokens: 10 })
  ];
  const r = withMockProvider(script, (port) => {
    forge(['config', 'set', 'providers.url', `http://127.0.0.1:${port}`]);
    return forge(['worker', 'run', 'W1'], { env: { OPENROUTER_API_KEY: 'test-key' } });
  });
  assert.strictEqual(r.code, 0, r.out);
  assert.match(r.out, /REFUSED \(scope\)/);                       // docs/evil.txt refused, visibly
  assert.match(r.out, /word proves nothing/);                     // independent verification reminder
  assert.strictEqual(fs.existsSync(path.join(dir, 'src', 'out.txt')), true);
  assert.strictEqual(fs.existsSync(path.join(dir, 'docs', 'evil.txt')), false);
  const w = JSON.parse(fs.readFileSync(path.join(dir, 'forge', 'state', 'work.json'), 'utf8'));
  const d = w.items.W1.dispatches;
  assert.strictEqual(d.length, 1);
  assert.strictEqual(d[0].kind, 'api');
  assert.strictEqual(d[0].agent, 'test-model');
  assert.strictEqual(d[0].tokensIn, 160);
  assert.strictEqual(d[0].tokensOut, 30);
  assert.deepStrictEqual(d[0].filesWritten, ['src/out.txt']);
  assert.strictEqual(w.items.W1.status, 'IN_PROGRESS');           // worker cannot close the item
});

test('API worker: provider 5xx is a PROVIDER FAILURE (exit 3) pointing at fail --kind provider', () => {
  addItem('W2');
  forge(['task', 'start', 'W2']);
  forge(['config', 'set', 'providers.model', 'test-model']);
  const r = withMockProvider([{ status: 500, body: { error: 'boom' } }], (port) => {
    forge(['config', 'set', 'providers.url', `http://127.0.0.1:${port}`]);
    return forge(['worker', 'run', 'W2'], { env: { OPENROUTER_API_KEY: 'test-key' } });
  });
  assert.strictEqual(r.code, 3);
  assert.match(r.out, /PROVIDER FAILURE/);
  assert.match(r.out, /--kind provider/);
});

test('API worker: turn cap without done is a WORKER failure, not a provider failure', () => {
  addItem('W3');
  forge(['task', 'start', 'W3']);
  forge(['config', 'set', 'providers.model', 'test-model']);
  const chatter = { status: 200, body: { choices: [{ message: { role: 'assistant', content: 'thinking...' } }], usage: { prompt_tokens: 5, completion_tokens: 5 } } };
  const r = withMockProvider([chatter], (port) => {
    forge(['config', 'set', 'providers.url', `http://127.0.0.1:${port}`]);
    return forge(['worker', 'run', 'W3', '--max-turns', '2'], { env: { OPENROUTER_API_KEY: 'test-key' } });
  });
  assert.notStrictEqual(r.code, 0);
  assert.match(r.out, /turn cap \(2\)/);
  assert.match(r.out, /--kind worker/);
});

test('fail --kind provider never burns the escalation ladder; bogus kinds are refused', () => {
  addItem('P1');
  forge(['task', 'start', 'P1']);
  const bogus = forge(['task', 'fail', 'P1', '--kind', 'gremlins']);
  assert.notStrictEqual(bogus.code, 0);
  assert.match(bogus.out, /--kind must be 'provider'/);
  for (let i = 0; i < 3; i++) {
    if (i) forge(['task', 'start', 'P1']);
    const r = forge(['task', 'fail', 'P1', '--kind', 'provider', '--note', 'rate limited']);
    assert.match(r.out, /PROVIDER failure \(escalation counter unchanged: 0\)/);
  }
  // three provider failures later, a plain start still works — no --escalate demanded
  assert.strictEqual(forge(['task', 'start', 'P1']).code, 0);
  // but two REAL failures still trip the ladder
  forge(['task', 'fail', 'P1', '--note', 'wrong approach A']);
  forge(['task', 'start', 'P1']);
  forge(['task', 'fail', 'P1', '--note', 'wrong approach B']);
  const gated = forge(['task', 'start', 'P1']);
  assert.notStrictEqual(gated.code, 0);
  assert.match(gated.out, /REQUIRES --escalate|Escalate explicitly/);
});

test('item-shape guard warns on mega-items and decision-shaped criteria (T55 rule); headers lose component chips', () => {
  const wide = forge(['task', 'add', '--id', 'G1', '--title', 'mega', '--milestone', 'M1', '--component', 'ui',
    '--criterion', 'ok::node -e "process.exit(0)"',
    '--allowed', 'a/,b/,c/,d/,e/,f/,g/,h/,i/,j/']);
  assert.match(wide.out, /ITEM-SHAPE WARNING: scope has 10 allowed globs/);
  const dec = forge(['task', 'add', '--id', 'G2', '--title', 'decision smuggled', '--allowed', 'src/',
    '--criterion', 'the owner has decided whether to add jsdom::']);
  assert.match(dec.out, /PRODUCT DECISION/);
  const dash = fs.readFileSync(path.join(dir, 'forge', 'dashboard.html'), 'utf8');
  assert.doesNotMatch(dash, /mchips/);   // v0.15: milestone headers carry no component pills
});

test('v0.15.1 dashboard shell: rows are cards with drawers, sections are styled, no native markers', () => {
  forge(['component', 'add', 'ui', '--name', 'UI', '--kind', 'frontend']);
  forge(['task', 'add', '--id', 'R1', '--title', 'screen', '--milestone', 'M1', '--component', 'ui',
    '--criterion', 'ok::node -e "process.exit(0)"', '--allowed', 'src/']);
  forge(['task', 'start', 'R1']);
  forge(['task', 'dispatch', 'R1', '--agent', 'forge-implementer']);
  touch('w.txt');
  forge(['task', 'verify', 'R1']);
  forge(['decision', 'add', 'Cutoff is 4 hours', '--authority', 'human', '--decision', 'four hours', '--why', 'desk practice']);
  const dash = fs.readFileSync(path.join(dir, 'forge', 'dashboard.html'), 'utf8');
  assert.match(dash, /<summary class="irow">/);          // item rows, not table rows
  assert.match(dash, /data-s="IN_PROGRESS"/);            // quick-filter hooks
  assert.match(dash, /class="st s-prog"/);               // status badge classes
  assert.match(dash, /<ul class="crit">/);               // criteria with pass/fail marks
  assert.match(dash, /class="ck ok"/);                   // the passing criterion is marked green
  assert.match(dash, /class="kv"/);                      // scope & evidence key/value block
  assert.match(dash, /class="cchip"/);                   // component chip with kind swatch
  assert.match(dash, /id="wgseg"/);                      // All / Needs me / Active / Done
  assert.match(dash, /class="mgb"/);                     // milestone body inside the group card
  assert.match(dash, /section class="page" data-page="plan"/); // v0.19: one page per menu entry
  assert.match(dash, /class="hbar"/);                    // development-time bars
  assert.match(dash, /class="jitem human"/);             // journal timeline marks human authority
  assert.match(dash, /details\.sec>summary::-webkit-details-marker\{display:none\}/); // no OS triangles
  assert.doesNotMatch(dash, /<th>Deps<\/th>/);           // the old work table is gone
});

// --- v0.15.2: the dashboard keeps itself current ------------------------------

// writes a fake Claude Code transcript folder and returns its root
function fakeLogs(lines, opts = {}) {
  const root = opts.root || fs.mkdtempSync(path.join(os.tmpdir(), 'forge-logs-'));
  const projDir = path.join(root, dir.replace(/[^a-zA-Z0-9]/g, '-'));
  fs.mkdirSync(projDir, { recursive: true });
  const file = path.join(projDir, 'session.jsonl');
  const text = lines.join('\n') + (opts.trailingNewline === false ? '' : '\n');
  if (opts.append) fs.appendFileSync(file, text); else fs.writeFileSync(file, text);
  return root;
}
const asst = (out, extra = {}) => JSON.stringify(Object.assign({
  type: 'assistant', timestamp: '2026-09-18T10:00:00.000Z',
  message: { model: 'test-model', usage: { output_tokens: out, input_tokens: 1 } }
}, extra));

test('usage snapshot refreshes itself on a state change — no manual forge usage needed', () => {
  const root = fakeLogs([asst(1000), asst(500)]);
  addItem('U1');   // any state change regenerates the dashboard
  forge(['dashboard'], { env: { FORGE_CLAUDE_PROJECTS: root } });
  const snap = JSON.parse(fs.readFileSync(path.join(dir, 'forge', 'state', 'usage.json'), 'utf8'));
  assert.strictEqual(snap.mainOut, 1500);
  assert.strictEqual(snap.complete, true);
  const dash = fs.readFileSync(path.join(dir, 'forge', 'dashboard.html'), 'utf8');
  assert.match(dash, /snapshot as of/);
  assert.doesNotMatch(dash, /No usage snapshot yet/);
});

test('a second scan reads only the new tail and never double-counts', () => {
  const root = fakeLogs([asst(1000)]);
  addItem('U1');
  forge(['dashboard'], { env: { FORGE_CLAUDE_PROJECTS: root } });
  const first = JSON.parse(fs.readFileSync(path.join(dir, 'forge', 'state', 'usage.json'), 'utf8'));
  assert.strictEqual(first.mainOut, 1000);
  const cache = JSON.parse(fs.readFileSync(path.join(dir, 'forge', 'state', 'usage-cache.json'), 'utf8'));
  const off = Object.values(cache.files)[0].off;
  assert.ok(off > 0);
  // append and rescan: the total grows by exactly the new entry
  fakeLogs([asst(250)], { root, append: true });
  forge(['usage'], { env: { FORGE_CLAUDE_PROJECTS: root } });
  const second = JSON.parse(fs.readFileSync(path.join(dir, 'forge', 'state', 'usage.json'), 'utf8'));
  assert.strictEqual(second.mainOut, 1250);
  const cache2 = JSON.parse(fs.readFileSync(path.join(dir, 'forge', 'state', 'usage-cache.json'), 'utf8'));
  assert.ok(Object.values(cache2.files)[0].off > off);
});

test('a transcript with no trailing newline is counted once, not once per scan', () => {
  const root = fakeLogs([asst(700), asst(300)], { trailingNewline: false });
  addItem('U1');
  const run = () => {
    forge(['usage'], { env: { FORGE_CLAUDE_PROJECTS: root } });
    return JSON.parse(fs.readFileSync(path.join(dir, 'forge', 'state', 'usage.json'), 'utf8')).mainOut;
  };
  assert.strictEqual(run(), 1000);
  assert.strictEqual(run(), 1000);   // the unterminated last line is not re-added
  assert.strictEqual(run(), 1000);
});

test('a rewritten (shrunk) transcript is re-read from the start', () => {
  const root = fakeLogs([asst(100), asst(100), asst(100)]);
  addItem('U1');
  forge(['usage'], { env: { FORGE_CLAUDE_PROJECTS: root } });
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(dir, 'forge', 'state', 'usage.json'), 'utf8')).mainOut, 300);
  fakeLogs([asst(42)], { root });   // replaced, now smaller
  forge(['usage'], { env: { FORGE_CLAUDE_PROJECTS: root } });
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(dir, 'forge', 'state', 'usage.json'), 'utf8')).mainOut, 42);
});

test('auto-refresh is skippable and never breaks a state change when logs are unreadable', () => {
  forge(['config', 'set', 'options.usageAuto', 'false']);
  const root = fakeLogs([asst(9999)]);
  const r = addItem('U1');
  assert.strictEqual(r.code, 0);
  assert.strictEqual(fs.existsSync(path.join(dir, 'forge', 'state', 'usage.json')), false);
  // and with no log folder at all, commands still succeed
  const r2 = forge(['dashboard'], { env: { FORGE_CLAUDE_PROJECTS: path.join(root, 'nope') } });
  assert.strictEqual(r2.code, 0);
});

test('dispatch refuses an unnamed launch; a mid-flight message inherits the agent', () => {
  addItem('D9');
  forge(['task', 'start', 'D9']);
  const bare = forge(['task', 'dispatch', 'D9']);
  assert.notStrictEqual(bare.code, 0);
  assert.match(bare.out, /needs --agent/);
  const orphanMsg = forge(['task', 'dispatch', 'D9', '--kind', 'message', '--note', 'hi']);
  assert.notStrictEqual(orphanMsg.code, 0);
  assert.match(orphanMsg.out, /no launch on 'D9'/);
  assert.strictEqual(forge(['task', 'dispatch', 'D9', '--agent', 'forge-implementer']).code, 0);
  const msg = forge(['task', 'dispatch', 'D9', '--kind', 'message', '--note', 'clarified']);
  assert.strictEqual(msg.code, 0);
  assert.match(msg.out, /inherited from the last launch/);
  const w = JSON.parse(fs.readFileSync(path.join(dir, 'forge', 'state', 'work.json'), 'utf8'));
  assert.strictEqual(w.items.D9.dispatches[1].agent, 'forge-implementer');
  assert.strictEqual(w.items.D9.dispatches[1].kind, 'message');
});

test('a legacy unnamed message does not create a phantom agent row', () => {
  addItem('D8');
  forge(['task', 'start', 'D8']);
  forge(['task', 'dispatch', 'D8', '--agent', 'forge-implementer']);
  // simulate a pre-v0.15.2 record written without an agent
  const wf = path.join(dir, 'forge', 'state', 'work.json');
  const w = JSON.parse(fs.readFileSync(wf, 'utf8'));
  w.items.D8.dispatches.push({ ts: new Date().toISOString(), agent: null, kind: 'message', note: 'legacy' });
  fs.writeFileSync(wf, JSON.stringify(w, null, 2));
  forge(['dashboard']);
  const dash = fs.readFileSync(path.join(dir, 'forge', 'dashboard.html'), 'utf8');
  assert.doesNotMatch(dash, /agent not named/);
  assert.match(dash, /forge-implementer/);
});

test('durations on the page are computed in the browser, not frozen at generation', () => {
  addItem('L1');
  forge(['task', 'start', 'L1']);
  forge(['task', 'dispatch', 'L1', '--agent', 'forge-implementer']);
  const dash = fs.readFileSync(path.join(dir, 'forge', 'dashboard.html'), 'utf8');
  assert.match(dash, /data-since="\d{4}-\d{2}-\d{2}T/);    // in-progress elapsed
  assert.match(dash, /setInterval\(tick,30000\)/);          // and it keeps ticking
  assert.match(dash, /regenerated <span data-since=/);      // the file states its own age
});

// --- v0.15.3: rail card, working quick filters, in-place document reader -------

test('the milestone rail sits in a card', () => {
  addItem('C1', ['--milestone', 'M1']);
  const dash = fs.readFileSync(path.join(dir, 'forge', 'dashboard.html'), 'utf8');
  assert.match(dash, /<div class="railcard">/);
  assert.match(dash, /\.railcard\{background:var\(--surface\)/);
});

test('quick filters can see gate state and the active milestone', () => {
  forge(['task', 'add', '--id', 'F1', '--title', 'done one', '--milestone', 'M1',
    '--criterion', 'ok::node -e "process.exit(0)"', '--allowed', 'src/']);
  forge(['task', 'add', '--id', 'F2', '--title', 'later', '--milestone', 'M2',
    '--criterion', 'ok::node -e "process.exit(0)"', '--allowed', 'other/']);
  forge(['task', 'start', 'F1']);
  touch('f.txt');
  forge(['task', 'verify', 'F1']);
  forge(['task', 'done', 'F1']);   // M1 now complete → gate awaiting
  const dash = fs.readFileSync(path.join(dir, 'forge', 'dashboard.html'), 'utf8');
  assert.match(dash, /data-gate="awaiting" data-m="M1"/);   // "Needs me" matches this group
  assert.match(dash, /data-gate="pending" data-m="M2"/);
  assert.match(dash, /data-s="DONE" data-act="0"/);          // M1 is no longer the active milestone
  assert.match(dash, /data-act="1"/);                        // M2's item is
  assert.match(dash, /id="wgnone"/);                         // honest empty state
  assert.match(dash, /class="mcount"/);                      // per-group match count
  assert.match(dash, /gate==='awaiting'/);                   // the predicate itself
});

test('briefs and spec files are embedded and open in the reader panel', () => {
  fs.mkdirSync(path.join(dir, 'spec'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'spec', '01-vision.md'), '# Vision\n\n- one\n- two\n\n`code` and **bold**\n');
  forge(['config', 'set', 'specDir', 'spec']);
  forge(['task', 'add', '--id', 'R2', '--title', 'screen', '--objective', 'obj',
    '--criterion', 'ok::node -e "process.exit(0)"', '--allowed', 'src/']);
  forge(['brief', 'R2', '--save']);
  const dash = fs.readFileSync(path.join(dir, 'forge', 'dashboard.html'), 'utf8');
  assert.match(dash, /id="docdata"/);                         // embedded document store
  assert.match(dash, /brief:R2/);                             // the brief is in it
  assert.match(dash, /briefs\/R2\.md/);                       // with its real path
  assert.match(dash, /spec:01-vision\.md/);                   // and the spec file
  assert.match(dash, /Work brief/);                           // brief text is embedded, not linked only
  assert.match(dash, /id="docpanel"/);
  assert.match(dash, /id="docdownload"/);
  assert.match(dash, /id="docfolder"/);
  assert.match(dash, /class="cchip docopen"/);                // row chip opens the reader
  const docs = JSON.parse(dash.match(/id="docdata">([\s\S]*?)<\/script>/)[1].replace(/\\u003c/g, '<'));
  assert.ok(docs['brief:R2'].text.includes('Acceptance criteria'));
  assert.strictEqual(docs['spec:01-vision.md'].rel, 'spec/01-vision.md');
});

test('an oversized document is listed but not embedded', () => {
  fs.mkdirSync(path.join(dir, 'spec'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'spec', 'huge.md'), 'x'.repeat(60 * 1024));
  forge(['config', 'set', 'specDir', 'spec']);
  forge(['dashboard']);
  const dash = fs.readFileSync(path.join(dir, 'forge', 'dashboard.html'), 'utf8');
  const docs = JSON.parse(dash.match(/id="docdata">([\s\S]*?)<\/script>/)[1].replace(/\\u003c/g, '<'));
  assert.strictEqual(docs['spec:huge.md'].text, null);
  assert.ok(docs['spec:huge.md'].size > 48 * 1024);
  assert.doesNotMatch(dash, /xxxxxxxxxxxxxxxxxxxx/);   // its content never lands in the file
});

// --- v0.16: cost and speed -----------------------------------------------------

test('the brief hands the worker its file list and forbids exploring', () => {
  fs.mkdirSync(path.join(dir, 'src', 'pay'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src', 'pay', 'intent.ts'), 'x'.repeat(2048));
  fs.writeFileSync(path.join(dir, 'src', 'pay', 'client.ts'), 'y');
  fs.mkdirSync(path.join(dir, 'src', 'pay', 'node_modules'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src', 'pay', 'node_modules', 'junk.js'), 'z');
  forge(['task', 'add', '--id', 'B9', '--title', 'pay', '--objective', 'o',
    '--criterion', 'ok::node -e "process.exit(0)"', '--allowed', 'src/pay/']);
  const r = forge(['brief', 'B9']);
  assert.strictEqual(r.code, 0);
  assert.match(r.out, /## Files in scope \(2\)/);
  assert.match(r.out, /src\/pay\/intent\.ts` \(2 KB\)/);
  assert.match(r.out, /src\/pay\/client\.ts/);
  assert.doesNotMatch(r.out, /node_modules/);          // never handed to a worker
  assert.match(r.out, /Do not search or scan the repository/);
  assert.match(r.out, /STOP and report/);
  // whole-tree items cannot get a list, and say so rather than pretending
  forge(['task', 'add', '--id', 'B10', '--title', 'wide', '--criterion', 'ok::node -e "process.exit(0)"']);
  forge(['task', 'start', 'B10', '--whole-tree', '--reason', 'migration']);
  assert.match(forge(['brief', 'B10']).out, /deliberately whole-tree/);
});

test('verify prints one line per passing check; the full tail still lands in state', () => {
  addItem('V1');
  forge(['task', 'start', 'V1']);
  touch('v.txt');
  const r = forge(['task', 'verify', 'V1']);
  assert.strictEqual(r.code, 0);
  assert.match(r.out, /VERIFY V1 — PASS 2\/2/);
  assert.match(r.out, /✓ project:test/);
  assert.match(r.out, /recorded in work\.json/);
  const w = JSON.parse(fs.readFileSync(path.join(dir, 'forge', 'state', 'work.json'), 'utf8'));
  assert.ok(w.items.V1.verifications[0].results.every(x => 'tail' in x));   // evidence unchanged
  // a failing check keeps its output
  forge(['task', 'update', 'V1', '--criterion-add', 'bad::node -e "console.log(\'BOOM\');process.exit(1)"']);
  const f = forge(['task', 'verify', 'V1']);
  assert.notStrictEqual(f.code, 0);
  assert.match(f.out, /✗ criterion: bad — exit 1/);
  assert.match(f.out, /BOOM/);
  // verbose restores the old shape
  forge(['config', 'set', 'options.verifyVerbose', 'true']);
  const v = forge(['task', 'verify', 'V1']);
  assert.match(v.out, /PASS {2}\[project:test\]/);
});

test('the security pass must name who ran it; self is recorded as absorbed', () => {
  forge(['task', 'add', '--id', 'S1', '--title', 'one', '--milestone', 'M1',
    '--criterion', 'ok::node -e "process.exit(0)"', '--allowed', 'src/']);
  forge(['task', 'start', 'S1']); touch('s.txt');
  forge(['task', 'verify', 'S1']); forge(['task', 'done', 'S1']);
  const bare = forge(['milestone', 'security', 'M1', '--note', 'looked fine']);
  assert.notStrictEqual(bare.code, 0);
  assert.match(bare.out, /record WHO ran the security pass/);
  assert.match(bare.out, /--agent self/);
  const ok = forge(['milestone', 'security', 'M1', '--agent', 'forge-reviewer', '--note', 'clean']);
  assert.strictEqual(ok.code, 0);
  assert.match(ok.out, /dispatched → forge-reviewer/);
  const w = JSON.parse(fs.readFileSync(path.join(dir, 'forge', 'state', 'work.json'), 'utf8'));
  assert.strictEqual(w.gates.M1.security.agent, 'forge-reviewer');
  const self = forge(['milestone', 'security', 'M1', '--agent', 'self', '--note', 'did it here']);
  assert.match(self.out, /ABSORBED in-session/);
});

test('approving a gate tells the session to end', () => {
  forge(['task', 'add', '--id', 'G1', '--title', 'one', '--milestone', 'M1',
    '--criterion', 'ok::node -e "process.exit(0)"', '--allowed', 'src/']);
  forge(['task', 'start', 'G1']); touch('g.txt');
  forge(['task', 'verify', 'G1']); forge(['task', 'done', 'G1']);
  forge(['milestone', 'security', 'M1', '--agent', 'forge-reviewer', '--note', 'clean']);
  const r = forge(['milestone', 'approve', 'M1', '--note', 'tested']);
  assert.strictEqual(r.code, 0);
  assert.match(r.out, /START A NEW SESSION NOW/);
  assert.match(r.out, /session-start hook reloads it/);
});

test('usage reports per-item efficiency, calls per dispatch, and a baseline delta', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-logs-'));
  const projDir = path.join(root, dir.replace(/[^a-zA-Z0-9]/g, '-'));
  const subs = path.join(projDir, 'sess-1', 'subagents');
  fs.mkdirSync(subs, { recursive: true });
  const asstL = (out, extra) => JSON.stringify(Object.assign({
    type: 'assistant', timestamp: '2026-09-18T10:00:00.000Z',
    message: { model: 'm', usage: { output_tokens: out, input_tokens: 10, cache_read_input_tokens: 100000 } }
  }, extra || {}));
  fs.writeFileSync(path.join(projDir, 'session.jsonl'), [asstL(100), asstL(100)].join('\n') + '\n');
  // two worker transcripts of very different length, each naming its item
  const userL = (txt) => JSON.stringify({ type: 'user', timestamp: '2026-09-18T10:00:00.000Z', message: { content: txt } });
  fs.writeFileSync(path.join(subs, 'agent-a.jsonl'),
    [userL('# Work brief — E1: cheap one'), asstL(10), asstL(10)].join('\n') + '\n');
  fs.writeFileSync(path.join(subs, 'agent-b.jsonl'),
    [userL('# Work brief — E2: thrashing one')].concat(Array.from({ length: 12 }, () => asstL(10))).join('\n') + '\n');

  addItem('E1'); addItem('E2');
  for (const id of ['E1', 'E2']) {
    forge(['task', 'start', id]); touch(id + '.txt');
    forge(['task', 'verify', id]); forge(['task', 'done', id]);
  }
  const r = forge(['usage'], { env: { FORGE_CLAUDE_PROJECTS: root } });
  assert.strictEqual(r.code, 0);
  assert.match(r.out, /Efficiency — what actually drives quota/);
  assert.match(r.out, /context:output = \d+:1/);
  assert.match(r.out, /PER DONE ITEM \(2 done\)/);
  assert.match(r.out, /Calls per worker dispatch \(2 worker transcripts\): median \d+ · p90 \d+ · max 12/);
  assert.match(r.out, /heaviest: E2×12/);            // tied to its item, so it is actionable

  // baseline, then more work, then the delta
  const b = forge(['usage', '--baseline', '--label', 'pre'], { env: { FORGE_CLAUDE_PROJECTS: root } });
  assert.match(b.out, /BASELINE RECORDED as 'pre'/);
  assert.ok(fs.existsSync(path.join(dir, 'forge', 'state', 'usage-baseline.json')));
  fs.appendFileSync(path.join(projDir, 'session.jsonl'), asstL(50) + '\n');
  addItem('E3'); forge(['task', 'start', 'E3']); touch('e3.txt');
  forge(['task', 'verify', 'E3']); forge(['task', 'done', 'E3']);
  const r2 = forge(['usage'], { env: { FORGE_CLAUDE_PROJECTS: root } });
  assert.match(r2.out, /Since baseline 'pre'/);
  assert.match(r2.out, /1 item\(s\) completed since/);
  assert.match(r2.out, /vs baseline: calls [+-]\d+%/);
});

test('stats reports clean-run rate alongside first-pass', () => {
  addItem('C1');
  forge(['task', 'start', 'C1']);
  forge(['task', 'fail', 'C1', '--note', 'wrong approach']);
  forge(['task', 'start', 'C1']); touch('c.txt');
  forge(['task', 'verify', 'C1']); forge(['task', 'done', 'C1']);
  addItem('C2');
  forge(['task', 'start', 'C2']); touch('c2.txt');
  forge(['task', 'verify', 'C2']); forge(['task', 'done', 'C2']);
  const r = forge(['stats']);
  assert.match(r.out, /First-pass rate: 1\/2/);
  assert.match(r.out, /Clean-run rate:  1\/2/);
  assert.match(r.out, /one start, zero failed attempts, zero failed verify runs/);
});

test('usage splits a segment by model and flags an entangled model change', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-mdl-'));
  const projDir = path.join(root, dir.replace(/[^a-zA-Z0-9]/g, '-'));
  const subs = path.join(projDir, 'sess-1', 'subagents');
  fs.mkdirSync(subs, { recursive: true });
  const line = (model, out, ctx) => JSON.stringify({
    type: 'assistant', timestamp: '2026-09-18T10:00:00.000Z',
    message: { model, usage: { output_tokens: out, input_tokens: 10, cache_read_input_tokens: ctx } }
  });
  const userL = (txt) => JSON.stringify({ type: 'user', timestamp: '2026-09-18T10:00:00.000Z', message: { content: txt } });
  const main = path.join(projDir, 'session.jsonl');

  // baseline regime: one orchestrator model, one worker model
  fs.writeFileSync(main, [line('alpha', 100, 200000), line('alpha', 100, 200000)].join('\n') + '\n');
  fs.writeFileSync(path.join(subs, 'agent-a.jsonl'),
    [userL('# Work brief — M1: first'), line('cheap', 10, 1000)].join('\n') + '\n');
  addItem('M1');
  forge(['task', 'start', 'M1']); touch('m1.txt');
  forge(['task', 'verify', 'M1']); forge(['task', 'done', 'M1']);
  const b = forge(['usage', '--baseline', '--label', 'pre'], { env: { FORGE_CLAUDE_PROJECTS: root } });
  assert.match(b.out, /BASELINE RECORDED as 'pre'/);
  const snap = JSON.parse(fs.readFileSync(path.join(dir, 'forge', 'state', 'usage-baseline.json'), 'utf8'));
  assert.ok(snap.byModel && snap.byModel.alpha, 'baseline carries per-model counters');

  // new segment: the orchestrator model changes part-way through
  fs.appendFileSync(main, [line('alpha', 50, 100000), line('beta', 50, 20000)].join('\n') + '\n');
  addItem('M2');
  forge(['task', 'start', 'M2']); touch('m2.txt');
  forge(['task', 'verify', 'M2']); forge(['task', 'done', 'M2']);

  const r = forge(['usage'], { env: { FORGE_CLAUDE_PROJECTS: root } });
  assert.strictEqual(r.code, 0);
  assert.match(r.out, /By model in this segment/);
  assert.match(r.out, /alpha/);
  assert.match(r.out, /beta/);
  assert.match(r.out, /orchestrator/);
  // both orchestrator models moved inside the segment -> entangled
  assert.match(r.out, /More than one orchestrator model ran in this segment/);
  // the baseline's own calls must not be counted into the segment
  assert.doesNotMatch(r.out, /alpha\s+400,000/);
});

test('usage withholds the per-model split when the baseline predates it', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-old-'));
  const projDir = path.join(root, dir.replace(/[^a-zA-Z0-9]/g, '-'));
  fs.mkdirSync(projDir, { recursive: true });
  const line = (model, out) => JSON.stringify({
    type: 'assistant', timestamp: '2026-09-18T10:00:00.000Z',
    message: { model, usage: { output_tokens: out, input_tokens: 10, cache_read_input_tokens: 5000 } }
  });
  fs.writeFileSync(path.join(projDir, 'session.jsonl'), line('alpha', 100) + '\n');
  addItem('O1');
  // a v0.16.0-shaped baseline: totals, no byModel
  fs.writeFileSync(path.join(dir, 'forge', 'state', 'usage-baseline.json'), JSON.stringify({
    ts: '2026-09-01T00:00:00.000Z', label: 'old', done: 0,
    calls: 0, context: 0, outTok: 0, perItem: null
  }));
  forge(['task', 'start', 'O1']); touch('o1.txt');
  forge(['task', 'verify', 'O1']); forge(['task', 'done', 'O1']);
  const r = forge(['usage'], { env: { FORGE_CLAUDE_PROJECTS: root } });
  assert.match(r.out, /per-model split unavailable/);
  assert.doesNotMatch(r.out, /By model in this segment/);
});

// --- v0.16.2: milestones as named feature slices ------------------------------

function work() { return JSON.parse(fs.readFileSync(path.join(dir, 'forge', 'state', 'work.json'), 'utf8')); }
function commitAll(msg) {
  spawnSync('git', ['add', '-A', '--', '.', ':(exclude)forge'], { cwd: dir });
  spawnSync('git', ['commit', '-qm', msg], { cwd: dir });
}

test('label-only milestones migrate as unnamed records in first-appearance order', () => {
  addItem('A', ['--milestone', 'M2']);
  addItem('B', ['--milestone', 'M1']);
  const w = work();
  assert.deepStrictEqual(w.milestoneOrder, ['M2', 'M1']);
  assert.strictEqual(w.milestones.M1.unnamed, true);
  const pf = forge(['preflight']);
  assert.match(pf.out, /milestone\(s\) unnamed/);
  const r = forge(['milestone', 'update', 'M1', '--name', 'Customers can reorder']);
  assert.strictEqual(r.code, 0);
  assert.strictEqual(work().milestones.M1.name, 'Customers can reorder');
  assert.strictEqual(work().milestones.M1.unnamed, undefined);
});

test('milestone add requires a name, warns on layer names, and places by anchor', () => {
  assert.notStrictEqual(forge(['milestone', 'add', 'M1']).code, 0);
  assert.strictEqual(forge(['milestone', 'add', 'M1', '--name', 'Sign up and see your box']).code, 0);
  const layer = forge(['milestone', 'add', 'M0', '--name', 'Foundation', '--before', 'M1']);
  assert.strictEqual(layer.code, 0);
  assert.match(layer.out, /names a layer, not a feature/);
  assert.deepStrictEqual(work().milestoneOrder, ['M0', 'M1']);
});

test('an empty named milestone never gates later work', () => {
  forge(['milestone', 'add', 'M1', '--name', 'Planned later']);
  addItem('X', ['--milestone', 'M2']);
  const r = forge(['task', 'start', 'X']);
  assert.strictEqual(r.code, 0, r.out);
});

test('milestone move changes gate order; refuses a move that breaks a dependency', () => {
  addItem('A', ['--milestone', 'M1']);
  addItem('B', ['--milestone', 'M2']);
  addItem('C', ['--milestone', 'M3', '--deps', 'B']);
  // needs a reason
  assert.notStrictEqual(forge(['milestone', 'move', 'M3', '--before', 'M1']).code, 0);
  // M3 ahead of M2 breaks C -> B
  const bad = forge(['milestone', 'move', 'M3', '--before', 'M2', '--reason', 'sales asked']);
  assert.notStrictEqual(bad.code, 0);
  assert.match(bad.out, /C \(M3\) depends on B \(M2\)/);
  assert.match(bad.out, /--pull-deps/);
  assert.deepStrictEqual(work().milestoneOrder, ['M1', 'M2', 'M3']);
  // independent move is fine and takes effect in gating
  addItem('D', ['--milestone', 'M4']);
  assert.strictEqual(forge(['milestone', 'move', 'M4', '--before', 'M1', '--reason', 'launch partner needs it']).code, 0);
  assert.deepStrictEqual(work().milestoneOrder, ['M4', 'M1', 'M2', 'M3']);
  const blocked = forge(['task', 'start', 'A']);
  assert.notStrictEqual(blocked.code, 0);
  assert.match(blocked.out, /milestone 'M4' still has unfinished items/);
  assert.match(fs.readFileSync(path.join(dir, 'forge', 'decisions.md'), 'utf8'), /reordered/);
});

test('milestone move --pull-deps brings blocking items along, recorded in history', () => {
  addItem('A', ['--milestone', 'M1']);
  addItem('B', ['--milestone', 'M2']);
  addItem('C', ['--milestone', 'M3', '--deps', 'B']);
  const r = forge(['milestone', 'move', 'M3', '--before', 'M2', '--pull-deps', '--reason', 'feature first']);
  assert.strictEqual(r.code, 0, r.out);
  const w = work();
  assert.strictEqual(w.items.B.milestone, 'M3');
  assert.match(w.items.B.history.pop().change, /pulled forward with M3/);
  assert.deepStrictEqual(w.milestoneOrder, ['M1', 'M3', 'M2']);
});

test('milestone move refuses to jump ahead of started work', () => {
  addItem('A', ['--milestone', 'M1']);
  addItem('B', ['--milestone', 'M2']);
  forge(['task', 'start', 'A']);
  const r = forge(['milestone', 'move', 'M2', '--before', 'M1', '--reason', 'x']);
  assert.notStrictEqual(r.code, 0);
  assert.match(r.out, /already started or been approved/);
});

test('task done and milestone approve record commit ranges', () => {
  commitAll('base'); touch('seed.txt'); commitAll('seed');
  addItem('A', ['--milestone', 'M1']);
  forge(['task', 'start', 'A']);
  touch('a.txt'); commitAll('M1/A: work');
  assert.strictEqual(forge(['task', 'verify', 'A']).code, 0);
  assert.strictEqual(forge(['task', 'done', 'A']).code, 0);
  const it = work().items.A;
  assert.ok(it.commits && it.commits.base && it.commits.head);
  assert.strictEqual(it.commits.count, 1);
  assert.strictEqual(it.commits.uncommitted, false);
  forge(['milestone', 'security', 'M1', '--agent', 'forge-reviewer', '--note', 'clean']);
  const ap = forge(['milestone', 'approve', 'M1', '--note', 'ok']);
  assert.match(ap.out, /Commit range recorded: .*\(1 commit/);
  assert.strictEqual(work().gates.M1.commits.count, 1);
});

test('milestone remove drops only an empty, never-gated milestone', () => {
  addItem('A', ['--milestone', 'M1']);
  addItem('B', ['--milestone', 'M2']);
  assert.notStrictEqual(forge(['milestone', 'remove', 'M2', '--reason', 'x']).code, 0); // holds an item
  forge(['milestone', 'add', 'F1', '--name', 'Members can reorder']);
  forge(['task', 'update', 'B', '--milestone', 'F1']);
  assert.notStrictEqual(forge(['milestone', 'remove', 'M2']).code, 0); // needs a reason
  assert.strictEqual(forge(['milestone', 'remove', 'M2', '--reason', 'feature re-cut']).code, 0);
  assert.deepStrictEqual(work().milestoneOrder, ['M1', 'F1']);
});

// --- v0.16.3: lock hygiene and closed-item tagging -----------------------------

test('session-end releases the lock its session holds (the /clear case), and only that one', () => {
  hook('session-start', { session_id: 'sess-OLD', source: 'startup' });
  // a different session ending does nothing
  hook('session-end', { session_id: 'sess-OTHER', reason: 'other' });
  const blocked = hook('pretooluse', { session_id: 'sess-NEW', tool_name: 'Write', tool_input: { file_path: 'src/a.js' } });
  assert.strictEqual(blocked.code, 2);
  // /clear ends the old id -> lock released -> the new id writes
  hook('session-end', { session_id: 'sess-OLD', reason: 'clear' });
  const l = JSON.parse(fs.readFileSync(path.join(dir, 'forge', 'state', 'session.json'), 'utf8'));
  assert.strictEqual(l.released, true);
  assert.strictEqual(l.endedBy, 'clear');
  const ok = hook('pretooluse', { session_id: 'sess-NEW', tool_name: 'Write', tool_input: { file_path: 'src/a.js' } });
  assert.strictEqual(ok.code, 0);
});

test('edit-war guard ignores writes outside the project', () => {
  hook('pretooluse', { session_id: 'sess-A', tool_name: 'Write', tool_input: { file_path: 'src/app.js' } });
  const outside = path.join(os.tmpdir(), 'forge-claude-memory', 'note.md');
  const r = hook('pretooluse', { session_id: 'sess-B', tool_name: 'Write', tool_input: { file_path: outside } });
  assert.strictEqual(r.code, 0, r.out);
  const inside = hook('pretooluse', { session_id: 'sess-B', tool_name: 'Write', tool_input: { file_path: 'src/app.js' } });
  assert.strictEqual(inside.code, 2);
});

test('a closed item accepts a component tag and nothing else', () => {
  addItem('C1');
  forge(['task', 'start', 'C1']); touch('c1.txt');
  forge(['task', 'verify', 'C1']); forge(['task', 'done', 'C1']);
  const tag = forge(['task', 'update', 'C1', '--component', 'Checkout', '--reason', 'map']);
  assert.strictEqual(tag.code, 0, tag.out);
  const w = JSON.parse(fs.readFileSync(path.join(dir, 'forge', 'state', 'work.json'), 'utf8'));
  assert.strictEqual(w.items.C1.component, 'Checkout');
  assert.match(w.items.C1.history.pop().change, /component = Checkout/);
  const other = forge(['task', 'update', 'C1', '--title', 'x']);
  assert.notStrictEqual(other.code, 0);
  const mixed = forge(['task', 'update', 'C1', '--component', 'X', '--title', 'x']);
  assert.notStrictEqual(mixed.code, 0);
});

// --- v0.17: per-milestone git flow ----------------------------------------------

function g(...args) { return spawnSync('git', args, { cwd: dir, encoding: 'utf8' }); }
function gitFlowProject() {
  const remote = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-remote-'));
  spawnSync('git', ['init', '--bare', '-q', remote]);
  g('checkout', '-q', '-b', 'staging');
  forge(['config', 'set', 'options.integration', 'per-milestone']);
  forge(['config', 'set', 'options.baseBranch', 'staging']);
  fs.writeFileSync(path.join(dir, '.gitignore'), ['forge/dashboard.html', 'forge/state/usage.json', 'forge/state/usage-cache.json',
    'forge/state/preflight.json', 'forge/state/session.json', 'forge/state/work.lock', ''].join('\n'));
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src', 'keep.txt'), 'x');
  g('add', '-A'); g('commit', '-qm', 'base');
  g('remote', 'add', 'origin', remote); g('push', '-q', '-u', 'origin', 'staging');
  return remote;
}
function fakeGh() {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-gh-'));
  const log = path.join(bin, 'calls.log');
  const script = path.join(bin, 'gh');
  fs.writeFileSync(script, `#!/bin/sh\necho "$@" >> "${log}"\ncase "$1 $2" in\n  "pr create") echo "https://github.com/acme/app/pull/7" ;;\n  "api repos/{owner}/{repo}") echo true ;;\n  "api "*) exit 1 ;;\n  "pr checks") echo "ci  pending" ;;\nesac\nexit 0\n`);
  fs.chmodSync(script, 0o755);
  return { gh: script, log };
}

test('git flow: config guards — opting out needs a reason, production is never the base', () => {
  assert.notStrictEqual(forge(['config', 'set', 'options.integration', 'manual']).code, 0);
  assert.notStrictEqual(forge(['config', 'set', 'options.baseBranch', 'main']).code, 0);
  assert.strictEqual(forge(['config', 'set', 'options.baseBranch', 'staging']).code, 0);
});

test('git flow: start refuses without a base branch and off the milestone branch', () => {
  forge(['config', 'set', 'options.integration', 'per-milestone']);
  addItem('A', ['--milestone', 'M1']);
  const noBase = forge(['task', 'start', 'A']);
  assert.notStrictEqual(noBase.code, 0);
  assert.match(noBase.out, /needs a base branch/);
  gitFlowProject();
  const pf = forge(['preflight']);
  assert.match(pf.out, /OK\s+git flow: base branch: per-milestone · base staging/);
  assert.match(pf.out, /git flow: append-only history: working tree extends HEAD/);
  const wrong = forge(['task', 'start', 'A']);
  assert.notStrictEqual(wrong.code, 0);
  assert.match(wrong.out, /built on branch 'milestone\/M1' — you are on 'staging'/);
  const br = forge(['milestone', 'branch', 'M1']);
  assert.strictEqual(br.code, 0, br.out);
  assert.strictEqual(g('rev-parse', '--abbrev-ref', 'HEAD').stdout.trim(), 'milestone/M1');
  assert.strictEqual(forge(['task', 'start', 'A']).code, 0);
});

test('git flow: done makes exactly one commit per item — its files plus Forge state — and pushes it', () => {
  const remote = gitFlowProject();
  forge(['task', 'add', '--id', 'A', '--title', 'Pass tokens', '--criterion', 'ok::node -e "process.exit(0)"', '--milestone', 'M1', '--allowed', 'src/']);
  forge(['milestone', 'branch', 'M1']);
  forge(['task', 'start', 'A']);
  fs.writeFileSync(path.join(dir, 'src', 'a.js'), 'a');
  assert.strictEqual(forge(['task', 'verify', 'A']).code, 0);
  const d = forge(['task', 'done', 'A']);
  assert.strictEqual(d.code, 0, d.out);
  assert.strictEqual(g('log', '-1', '--format=%s').stdout.trim(), 'A (V0.1.1): Pass tokens');
  const files = g('show', '--name-only', '--format=', 'HEAD').stdout.trim().split('\n');
  assert.ok(files.includes('src/a.js'));
  assert.ok(files.includes('forge/state/work.json'));
  assert.ok(!files.includes('forge/dashboard.html'));
  assert.strictEqual(g('rev-list', '--count', 'staging..HEAD').stdout.trim(), '1');
  const w = work();
  assert.strictEqual(w.items.A.status, 'DONE');
  assert.strictEqual(w.items.A.commit.pushed, true);
  const r = spawnSync('git', ['--git-dir', remote, 'rev-parse', 'milestone/M1'], { encoding: 'utf8' });
  assert.strictEqual(r.stdout.trim(), w.items.A.commit.sha);
});

test('git flow: done refuses changes outside the item scope', () => {
  gitFlowProject();
  addItem('A', ['--milestone', 'M1']);
  forge(['milestone', 'branch', 'M1']);
  forge(['task', 'start', 'A']);
  fs.writeFileSync(path.join(dir, 'src', 'a.js'), 'a');
  fs.writeFileSync(path.join(dir, 'stray.js'), 's');
  forge(['task', 'verify', 'A']);
  const d = forge(['task', 'done', 'A']);
  assert.notStrictEqual(d.code, 0);
  assert.match(d.out, /outside 'A''s scope/);
  assert.match(d.out, /stray\.js/);
  assert.strictEqual(work().items.A.status, 'IN_PROGRESS');
});

test('git flow: done refuses when append-only history is behind HEAD (stale state)', () => {
  gitFlowProject();
  addItem('A', ['--milestone', 'M1']);
  addItem('B', ['--milestone', 'M1']);
  forge(['milestone', 'branch', 'M1']);
  forge(['task', 'start', 'A']);
  fs.writeFileSync(path.join(dir, 'src', 'a.js'), 'a');
  forge(['task', 'verify', 'A']);
  assert.strictEqual(forge(['task', 'done', 'A']).code, 0);
  forge(['task', 'start', 'B']);
  fs.writeFileSync(path.join(dir, 'src', 'b.js'), 'b');
  forge(['task', 'verify', 'B']);
  // shorten the working copy of trace.jsonl below what HEAD holds
  const tf = path.join(dir, 'forge', 'state', 'trace.jsonl');
  fs.writeFileSync(tf, fs.readFileSync(tf, 'utf8').split('\n')[0] + '\n');
  const d = forge(['task', 'done', 'B']);
  assert.notStrictEqual(d.code, 0);
  assert.match(d.out, /BEHIND or diverged from HEAD/);
  assert.match(d.out, /trace\.jsonl/);
});

test('git flow: own-branch escape hatch needs a reason and commits on item/<id>', () => {
  gitFlowProject();
  addItem('R', ['--milestone', 'M1', '--title', 'Risky migration']);
  forge(['milestone', 'branch', 'M1']);
  assert.notStrictEqual(forge(['task', 'start', 'R', '--own-branch']).code, 0);
  const s = forge(['task', 'start', 'R', '--own-branch', '--reason', 'large schema change']);
  assert.strictEqual(s.code, 0, s.out);
  assert.strictEqual(g('rev-parse', '--abbrev-ref', 'HEAD').stdout.trim(), 'item/R');
  fs.writeFileSync(path.join(dir, 'src', 'r.js'), 'r');
  forge(['task', 'verify', 'R']);
  const d = forge(['task', 'done', 'R']);
  assert.strictEqual(d.code, 0, d.out);
  assert.match(d.out, /open a PR item\/R → milestone\/M1/);
  assert.strictEqual(work().items.R.commit.branch, 'item/R');
  assert.match(fs.readFileSync(path.join(dir, 'forge', 'decisions.md'), 'utf8'), /built on its own branch/);
});

test('git flow: ship refuses an unapproved gate, then opens one PR and records it', () => {
  gitFlowProject();
  const { gh, log } = fakeGh();
  addItem('A', ['--milestone', 'M1']);
  forge(['milestone', 'branch', 'M1']);
  forge(['task', 'start', 'A']);
  fs.writeFileSync(path.join(dir, 'src', 'a.js'), 'a');
  forge(['task', 'verify', 'A']); forge(['task', 'done', 'A']);
  const early = forge(['milestone', 'ship', 'M1'], { env: { FORGE_GH: gh } });
  assert.notStrictEqual(early.code, 0);
  assert.match(early.out, /not approved/);
  forge(['milestone', 'security', 'M1', '--agent', 'forge-reviewer', '--note', 'clean']);
  forge(['milestone', 'approve', 'M1', '--note', 'ok']);
  forge(['config', 'set', 'options.gateSteps', 'apply migrations to staging']);
  const noSteps = forge(['milestone', 'ship', 'M1'], { env: { FORGE_GH: gh } });
  assert.notStrictEqual(noSteps.code, 0);
  assert.match(noSteps.out, /apply migrations to staging/);
  const ok = forge(['milestone', 'ship', 'M1', '--steps-done'], { env: { FORGE_GH: gh } });
  assert.strictEqual(ok.code, 0, ok.out);
  assert.match(ok.out, /pull\/7/);
  assert.match(ok.out, /Could not read 'staging' branch protection/);
  const calls = fs.readFileSync(log, 'utf8');
  assert.match(calls, /pr create --base staging --head milestone\/M1/);
  assert.doesNotMatch(calls, /pr merge/);
  assert.strictEqual(work().gates.M1.ship.pr, 'https://github.com/acme/app/pull/7');
  assert.strictEqual(g('log', '-1', '--format=%s').stdout.trim(), 'milestone M1: gate record');
});

test('dispatches: item-less dispatches and models are recorded', () => {
  const r = forge(['dispatch', '--agent', 'forge-explorer', '--purpose', 'explore', '--model', 'haiku', '--note', 'map the checkout']);
  assert.strictEqual(r.code, 0, r.out);
  assert.notStrictEqual(forge(['dispatch', '--agent', 'x', '--purpose', 'nonsense']).code, 0);
  addItem('D');
  forge(['task', 'start', 'D']);
  forge(['task', 'dispatch', 'D', '--agent', 'forge-implementer', '--model', 'sonnet']);
  const w = work();
  assert.strictEqual(w.dispatchLog[0].purpose, 'explore');
  assert.strictEqual(w.dispatchLog[0].model, 'haiku');
  assert.strictEqual(w.items.D.dispatches[0].model, 'sonnet');
});

test('usage: a top-level transcript that opens with a Forge brief is a worker, and an older model version is flagged', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-ver-'));
  const projDir = path.join(root, dir.replace(/[^a-zA-Z0-9]/g, '-'));
  fs.mkdirSync(projDir, { recursive: true });
  const line = (model, out, ctx) => JSON.stringify({
    type: 'assistant', timestamp: '2026-09-29T10:00:00.000Z',
    message: { model, usage: { output_tokens: out, input_tokens: 10, cache_read_input_tokens: ctx } }
  });
  const userL = (txt) => JSON.stringify({ type: 'user', timestamp: '2026-09-29T10:00:00.000Z', message: { content: txt } });
  addItem('V0');
  forge(['task', 'start', 'V0']); touch('v0.txt'); forge(['task', 'verify', 'V0']); forge(['task', 'done', 'V0']);
  fs.writeFileSync(path.join(projDir, 'orch.jsonl'), [userL('continue'), line('claude-opus-5-5', 100, 200000)].join('\n') + '\n');
  forge(['usage', '--baseline', '--label', 'pre'], { env: { FORGE_CLAUDE_PROJECTS: root } });
  // in the new segment a review runs as a TOP-LEVEL transcript on an older Opus
  fs.appendFileSync(path.join(projDir, 'orch.jsonl'), line('claude-opus-5-5', 50, 100000) + '\n');
  fs.writeFileSync(path.join(projDir, 'rev.jsonl'), [userL('# Review brief — V1: check'), line('claude-opus-4-7', 20, 30000)].join('\n') + '\n');
  addItem('V1');
  forge(['task', 'start', 'V1']); touch('v1.txt'); forge(['task', 'verify', 'V1']); forge(['task', 'done', 'V1']);
  const r = forge(['usage'], { env: { FORGE_CLAUDE_PROJECTS: root } });
  assert.strictEqual(r.code, 0, r.out);
  assert.match(r.out, /claude-opus-4-7 \[side\]/);
  assert.doesNotMatch(r.out, /claude-opus-4-7 \[main\]/);
  assert.match(r.out, /Versions seen \(opus\): newest claude-opus-5-5 · older claude-opus-4-7/);
  assert.match(r.out, /OLDER OPUS VERSION IN THIS SEGMENT: claude-opus-4-7 \(1 calls, workers\)/);
});

test('opus-tier agents inherit the session model; no agent pins a version', () => {
  const agents = path.resolve(__dirname, '..', 'plugins', 'forge', 'agents');
  for (const f of fs.readdirSync(agents)) {
    const m = fs.readFileSync(path.join(agents, f), 'utf8').match(/^model:\s*(\S+)/m);
    assert.ok(m, f + ' declares a model');
    assert.ok(['inherit', 'sonnet', 'haiku'].includes(m[1]), `${f}: model '${m[1]}' — Opus-tier agents inherit; nothing pins a version`);
  }
});

test('usage: SDK-driven sessions from other tools are reported as external, never as Forge cost', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-ext-'));
  const projDir = path.join(root, dir.replace(/[^a-zA-Z0-9]/g, '-'));
  fs.mkdirSync(projDir, { recursive: true });
  const line = (model, out, ctx, ep) => JSON.stringify({
    type: 'assistant', timestamp: '2026-09-29T10:00:00.000Z', entrypoint: ep,
    message: { model, usage: { output_tokens: out, input_tokens: 10, cache_read_input_tokens: ctx } }
  });
  const userL = (txt, ep) => JSON.stringify({ type: 'user', timestamp: '2026-09-29T10:00:00.000Z', entrypoint: ep, message: { content: txt } });
  addItem('E0');
  forge(['task', 'start', 'E0']); touch('e0.txt'); forge(['task', 'verify', 'E0']); forge(['task', 'done', 'E0']);
  fs.writeFileSync(path.join(projDir, 'orch.jsonl'), [userL('continue', 'cli'), line('claude-opus-5-5', 100, 200000, 'cli')].join('\n') + '\n');
  forge(['usage', '--baseline', '--label', 'pre'], { env: { FORGE_CLAUDE_PROJECTS: root } });
  fs.appendFileSync(path.join(projDir, 'orch.jsonl'), line('claude-opus-5-5', 50, 100000, 'cli') + '\n');
  fs.writeFileSync(path.join(projDir, 'sec.jsonl'), [userL('Review this change for security vulnerabilities.', 'sdk-py'),
    line('claude-opus-4-7', 20, 900000, 'sdk-py'), line('claude-opus-4-7', 20, 900000, 'sdk-py')].join('\n') + '\n');
  addItem('E1');
  forge(['task', 'start', 'E1']); touch('e1.txt'); forge(['task', 'verify', 'E1']); forge(['task', 'done', 'E1']);
  const r = forge(['usage'], { env: { FORGE_CLAUDE_PROJECTS: root } });
  assert.strictEqual(r.code, 0, r.out);
  assert.match(r.out, /claude-opus-4-7 \[external\]/);
  assert.doesNotMatch(r.out, /claude-opus-4-7 \[main\]/);
  assert.match(r.out, /External sessions in this segment \(not Forge[^)]*\): 2 calls/);
  assert.doesNotMatch(r.out, /OLDER OPUS VERSION/);           // not Forge's model choice
  assert.match(r.out, /per item: 1 calls/);                   // only the orchestrator call counts
});

// --- v0.18: releases, computed version labels, plan order -----------------------

function setupReleases() {
  forge(['release', 'add', 'mvp', '--name', 'MVP']);
  forge(['release', 'add', 'v1', '--name', 'Stays']);
  forge(['milestone', 'add', 'pass', '--name', 'Every booking has a pass', '--release', 'mvp']);
  forge(['milestone', 'add', 'trip', '--name', 'Members book trips', '--release', 'mvp']);
  forge(['milestone', 'add', 'stay', '--name', 'Members book stays', '--release', 'v1']);
  addItem('P1', ['--milestone', 'pass']); addItem('P2', ['--milestone', 'pass']); addItem('P3', ['--milestone', 'pass']);
  addItem('T1', ['--milestone', 'trip']); addItem('T2', ['--milestone', 'trip', '--deps', 'T1']);
  addItem('S1', ['--milestone', 'stay']);
}
function labelOf(id) { const r = forge(['task', 'list']); const l = r.out.split('\n').find(x => new RegExp(`\\s${id}\\s`).test(x)); return l ? l.split(/\s+/)[1] : null; }

test('labels: release / milestone / task versions are computed from position, starting at versionStart', () => {
  setupReleases();
  assert.strictEqual(labelOf('P1'), 'V0.1.1');
  assert.strictEqual(labelOf('P3'), 'V0.1.3');
  assert.strictEqual(labelOf('T2'), 'V0.2.2');
  assert.strictEqual(labelOf('S1'), 'V1.1.1');
  forge(['config', 'set', 'options.versionStart', '2']);
  assert.strictEqual(labelOf('P1'), 'V2.1.1');
  assert.strictEqual(labelOf('S1'), 'V3.1.1');
  const rl = forge(['release', 'list']);
  assert.match(rl.out, /V2\s+mvp: MVP/);
  assert.match(rl.out, /V3\.1\s+stay/);
});

test('labels: reordering renumbers everything not started; started work keeps its frozen label', () => {
  setupReleases();
  // nothing started: moving a milestone renumbers
  assert.strictEqual(forge(['milestone', 'move', 'trip', '--before', 'pass', '--reason', 'x']).code, 0);
  assert.strictEqual(labelOf('T1'), 'V0.1.1');
  assert.strictEqual(labelOf('P1'), 'V0.2.1');
  // start the first task in plan order -> its milestone and label freeze
  const s = forge(['task', 'start']);
  assert.match(s.out, /T1 \(V0\.1\.1\) → IN_PROGRESS/);
  // a milestone cannot jump ahead of started work any more
  assert.notStrictEqual(forge(['milestone', 'move', 'pass', '--before', 'trip', '--reason', 'x']).code, 0);
  // moving a release before a started one is refused; after it is fine and renumbers
  assert.notStrictEqual(forge(['release', 'move', 'v1', '--before', 'mvp', '--reason', 'x']).code, 0);
  forge(['release', 'add', 'v2', '--name', 'Agents']);
  forge(['milestone', 'add', 'agent', '--name', 'Agents book', '--release', 'v2']);
  addItem('A1', ['--milestone', 'agent']);
  assert.strictEqual(labelOf('A1'), 'V2.1.1');
  assert.strictEqual(forge(['release', 'move', 'v2', '--before', 'v1', '--reason', 'partner']).code, 0);
  assert.strictEqual(labelOf('A1'), 'V1.1.1');
  assert.strictEqual(labelOf('S1'), 'V2.1.1');
  assert.strictEqual(labelOf('T1'), 'V0.1.1'); // frozen
});

test('plan order: start without an id takes the next READY task; out-of-order needs a reason; task move is dependency-checked', () => {
  setupReleases();
  const n = forge(['task', 'next']);
  assert.match(n.out, /V0\.1\.1\s+P1/);
  const ooo = forge(['task', 'start', 'P3']);
  assert.notStrictEqual(ooo.code, 0);
  assert.match(ooo.out, /not next in plan order — READY before it in 'pass': P1, P2/);
  assert.notStrictEqual(forge(['task', 'move', 'T2', '--before', 'T1']).code, 0); // T2 depends on T1
  const mv = forge(['task', 'move', 'P3', '--before', 'P1', '--reason', 'customer first']);
  assert.strictEqual(mv.code, 0, mv.out);
  assert.match(mv.out, /V0\.1\.3 → V0\.1\.1/);
  const s = forge(['task', 'start']);
  assert.match(s.out, /P3 \(V0\.1\.1\) → IN_PROGRESS/);
  touch('p3.txt'); forge(['task', 'verify', 'P3']); assert.strictEqual(forge(['task', 'done', 'P3']).code, 0);
  // the explicit escape: out of order (P1 is next) with a recorded reason
  assert.notStrictEqual(forge(['task', 'start', 'P2']).code, 0);
  assert.strictEqual(forge(['task', 'start', 'P2', '--reason', 'blocked on data for P1']).code, 0);
  assert.strictEqual(work().items.P2.label, 'V0.1.2');
  // started work cannot be moved or re-homed
  assert.notStrictEqual(forge(['task', 'move', 'P3', '--after', 'P1']).code, 0);
  assert.notStrictEqual(forge(['task', 'update', 'P3', '--milestone', 'trip']).code, 0);
});

test('releases: milestone moves stay inside their release; re-homing is dependency-checked; list is in plan order', () => {
  setupReleases();
  assert.notStrictEqual(forge(['milestone', 'move', 'stay', '--before', 'pass', '--reason', 'x']).code, 0);
  assert.strictEqual(forge(['milestone', 'update', 'stay', '--release', 'mvp']).code, 0);
  assert.strictEqual(labelOf('S1'), 'V0.3.1');
  forge(['task', 'update', 'T1', '--deps', 'S1']);          // trip (V0.2) now needs stay (V0.3)
  const bad = forge(['milestone', 'update', 'stay', '--release', 'v1']);
  assert.notStrictEqual(bad.code, 0);
  assert.match(bad.out, /T1 \(trip\) depends on S1 \(stay\)/);
  const ids = forge(['task', 'list']).out.split('\n').filter(l => /\s(P\d|T\d|S\d)\s/.test(l)).map(l => l.split(/\s+/)[2]);
  assert.deepStrictEqual(ids, ['P1', 'P2', 'P3', 'T1', 'T2', 'S1']);
  assert.strictEqual(forge(['release', 'remove', 'v1', '--reason', 'empty now']).code, 0);
});

test('dashboard shows release headers, milestone and task version labels', () => {
  setupReleases();
  forge(['task', 'start']);
  forge(['dashboard']);
  const html = fs.readFileSync(path.join(dir, 'forge', 'dashboard.html'), 'utf8');
  assert.match(html, /class="vtag rel">V0<\/span>MVP/);
  assert.match(html, /class="vtag">V0\.1<\/span>pass/);
  assert.match(html, /class="vlab"[^>]*>V0\.1\.1<\/b>P1/);
  assert.match(html, /class="rsep"><span>V1<\/span><em>Stays<\/em>/);
  assert.strictEqual((html.match(/>next up</g) || []).length, 1);
});

// --- v0.19: architecture, screens, upgrade, paged dashboard ------------------

function writeRepo(files) {
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  }
}
const SHOP = {
  'package.json': JSON.stringify({ dependencies: { react: '18', 'react-dom': '18', '@supabase/supabase-js': '2' }, devDependencies: { vite: '5' } }),
  'wrangler.toml': 'name="shop"\npages_build_output_dir="dist"\n',
  'supabase/config.toml': '[auth]\nenabled = true\n',
  'supabase/migrations/001.sql': 'select 1;',
  'supabase/functions/stripe-webhook/index.ts': 'import Stripe from "npm:stripe@14"; Deno.env.get("STRIPE_SECRET_KEY");',
  'supabase/functions/acme-webhook/index.ts': 'Deno.env.get("ACMEPAY_API_KEY");',
  'src/main.tsx': 'supabase.auth.getUser()',
  '.env.provider.example': 'RESEND_API_KEY=\n',
};

test('arch scan: finds apps, hosting, platform parts and providers from the repo; --write records drafts only', () => {
  writeRepo(SHOP);
  const dry = forge(['arch', 'scan']);
  assert.strictEqual(dry.code, 0);
  for (const re of [/web-app — Web app \(frontend\)/, /Cloudflare\n\s+frontend-hosting/, /postgres — Postgres \(db\)/, /auth — Auth \(auth\)/,
    /edge-functions — Edge functions/, /stripe — Stripe/, /acmepay — Acmepay \(integration\) · low confidence/, /resend — Resend/,
    /stripe → edge-functions \(webhook\)/, /web-app → postgres \(supabase-js\)/, /Nothing written/]) assert.match(dry.out, re);
  assert.ok(!fs.existsSync(path.join(dir, 'forge', 'state', 'components.json')), 'a dry scan writes nothing');
  assert.strictEqual(forge(['arch', 'scan', '--write']).code, 0);
  let c = JSON.parse(fs.readFileSync(path.join(dir, 'forge', 'state', 'components.json'), 'utf8'));
  assert.strictEqual(c.components['web-app'].confirmed, false);
  assert.strictEqual(c.components['web-app'].source, 'scan');
  assert.ok(c.edges.some(e => e.from === 'stripe' && e.to === 'edge-functions'));
  // a human edit survives a re-scan
  forge(['arch', 'update', 'web-app', '--name', 'Member app', '--confirm']);
  forge(['arch', 'scan', '--write']);
  c = JSON.parse(fs.readFileSync(path.join(dir, 'forge', 'state', 'components.json'), 'utf8'));
  assert.strictEqual(c.components['web-app'].name, 'Member app');
  assert.strictEqual(c.components['web-app'].confirmed, true);
  assert.strictEqual(forge(['arch', 'confirm', '--all']).code, 0);
  assert.match(forge(['arch', 'list']).out, /✓ web-app — Member app/);
});

test('screens belong to apps: work tagged to a screen rolls up to its app; removing a tagged part needs a reason', () => {
  forge(['arch', 'add', 'member-app', '--name', 'Member app', '--kind', 'frontend', '--runs-on', 'Browser']);
  forge(['arch', 'add', 'db', '--name', 'Postgres', '--kind', 'db', '--runs-on', 'Supabase']);
  forge(['arch', 'link', 'member-app', 'db', '--label', 'supabase-js']);
  forge(['screen', 'add', 'Home', '--name', 'Home']);
  forge(['screen', 'add', 'Cart', '--name', 'Cart']);
  forge(['screen', 'add', 'AdminFees', '--name', 'Fees']);
  const a = forge(['screen', 'assign', 'member-app', '--match', '^(Home|Cart)$']);
  assert.match(a.out, /2 screen\(s\) → Member app/);
  assert.notStrictEqual(forge(['screen', 'assign', 'nope', 'Home']).code, 0);
  addItem('S1', ['--component', 'Cart']);
  addItem('S2', ['--component', 'member-app']);
  assert.match(forge(['arch', 'list']).out, /member-app — Member app \(frontend\) · 0\/2 items · 2 screen\(s\)/);
  const rm = forge(['arch', 'remove', 'member-app']);
  assert.notStrictEqual(rm.code, 0);
  assert.match(rm.out, /tagged 'member-app'/);
  assert.strictEqual(forge(['arch', 'remove', 'member-app', '--reason', 'merged']).code, 0);
  const c = JSON.parse(fs.readFileSync(path.join(dir, 'forge', 'state', 'components.json'), 'utf8'));
  assert.ok(c.tags['member-app'], 'the tag survives as a plain tag');
  assert.strictEqual(c.screens.Cart.app, null);
  assert.strictEqual(c.edges.length, 0);
});

test('upgrade: automatic steps are detected, applied with a backup, and revert refuses once the plan moved on', () => {
  // a v0.18-era registry: screens, runtime parts and tags in one table
  fs.writeFileSync(path.join(dir, 'forge', 'state', 'components.json'), JSON.stringify({ schema: 1, components: {
    Home: { id: 'Home', name: 'Home', kind: 'frontend', mock: 'spec/mocks/Home.png' },
    Sheets: { id: 'Sheets', name: 'Sheets sync', kind: 'integration' },
    Security: { id: 'Security', name: 'Security', kind: 'unspecified' } } }));
  addItem('U1', ['--component', 'Home']);
  const st = forge(['upgrade']);
  assert.match(st.out, /✗ components-split/);
  assert.match(st.out, /1 screen\(s\), 1 architecture part\(s\), 1 tag\(s\)/);
  const ap = forge(['upgrade', 'apply']);
  assert.strictEqual(ap.code, 0);
  const backup = (ap.out.match(/Backup: (\S+) /) || [])[1];
  assert.ok(backup && fs.existsSync(path.join(dir, backup, 'components.json')));
  let c = JSON.parse(fs.readFileSync(path.join(dir, 'forge', 'state', 'components.json'), 'utf8'));
  assert.strictEqual(c.schema, 2);
  assert.ok(c.screens.Home && c.components.Sheets && c.tags.Security);
  const w = JSON.parse(fs.readFileSync(path.join(dir, 'forge', 'state', 'work.json'), 'utf8'));
  assert.strictEqual(w.items.U1.component, 'Home', 'item tags are untouched');
  assert.match(forge(['upgrade']).out, /✓ components-split/);
  // revert is clean while nothing else changed…
  assert.strictEqual(forge(['upgrade', 'revert']).code, 0);
  c = JSON.parse(fs.readFileSync(path.join(dir, 'forge', 'state', 'components.json'), 'utf8'));
  assert.strictEqual(c.schema, 1);
  // …and refuses once the plan moved on
  forge(['upgrade', 'apply']);
  addItem('U2');
  const rv = forge(['upgrade', 'revert']);
  assert.notStrictEqual(rv.code, 0);
  assert.match(rv.out, /plan changed after that upgrade/);
});

test('upgrade: judgement steps report findings; a change script runs only after a matching dry-run; history changes are flagged', () => {
  forge(['milestone', 'add', 'M1', '--name', 'V1 · Members pay online']);
  forge(['milestone', 'add', 'M2', '--name', 'Backend foundation']);
  addItem('A', ['--milestone', 'M1']);
  addItem('B', ['--milestone', 'M2']);
  const st = forge(['upgrade']);
  assert.match(st.out, /! feature-milestones/);
  assert.match(st.out, /M1: "V1 · Members pay online" carries a version prefix/);
  assert.match(st.out, /M2: "Backend foundation" names a layer/);
  assert.match(st.out, /no releases/);
  fs.mkdirSync(path.join(dir, 'forge', 'changes'), { recursive: true });
  const script = path.join('forge', 'changes', 'up.sh');
  fs.writeFileSync(path.join(dir, script), '#!/usr/bin/env bash\n# forge-upgrade-step: feature-milestones\nset -euo pipefail\nforge() { node "$FORGE_JS" "$@"; }\n' +
    'forge release add mvp --name MVP\nforge milestone update M1 --name "Members pay online" --release mvp\nforge milestone update M2 --name "Staff see the day" --release mvp\n');
  const refused = forge(['upgrade', 'run', script]);
  assert.notStrictEqual(refused.code, 0);
  assert.match(refused.out, /dry-run this exact script first/);
  const dr = forge(['upgrade', 'dry-run', script]);
  assert.strictEqual(dr.code, 0, dr.out);
  assert.match(dr.out, /\+ release V0 mvp "MVP"/);
  assert.match(dr.out, /~ M1: .*"V1 · Members pay online" → "Members pay online"/);
  let w = JSON.parse(fs.readFileSync(path.join(dir, 'forge', 'state', 'work.json'), 'utf8'));
  assert.ok(!(w.releaseOrder || []).length, 'a dry run changes nothing');
  // an edit after the dry-run invalidates it
  fs.appendFileSync(path.join(dir, script), '# edited\n');
  assert.match(forge(['upgrade', 'run', script]).out, /dry-run this exact script first/);
  forge(['upgrade', 'dry-run', script]);
  const run = forge(['upgrade', 'run', script]);
  assert.strictEqual(run.code, 0, run.out);
  assert.match(forge(['upgrade']).out, /✓ feature-milestones/);
  w = JSON.parse(fs.readFileSync(path.join(dir, 'forge', 'state', 'work.json'), 'utf8'));
  assert.strictEqual(w.upgrade.history.slice(-1)[0].step, 'feature-milestones');
  assert.match(fs.readFileSync(path.join(dir, 'forge', 'decisions.md'), 'utf8'), /upgrade 'feature-milestones'/);
  // a script that touches work history is flagged and cannot be run
  const bad = path.join('forge', 'changes', 'bad.sh');
  fs.writeFileSync(path.join(dir, bad), '#!/usr/bin/env bash\nforge() { node "$FORGE_JS" "$@"; }\nforge task start A\n');
  const bdr = forge(['upgrade', 'dry-run', bad]);
  assert.notStrictEqual(bdr.code, 0);
  assert.match(bdr.out, /Touches work history/);
  assert.match(forge(['upgrade', 'run', bad]).out, /failed or touched work history/);
  // keeping a judgement step as-is needs a reason
  assert.notStrictEqual(forge(['upgrade', 'accept', 'architecture']).code, 0);
  assert.strictEqual(forge(['upgrade', 'accept', 'architecture', '--reason', 'no UI yet']).code, 0);
  assert.match(forge(['upgrade']).out, /✓ architecture .* accepted as-is: no UI yet/);
});

test('dashboard v0.19: one page per menu entry, architecture drawing data, screens grouped by app, plan filter hooks', () => {
  forge(['arch', 'add', 'member-app', '--name', 'Member app', '--kind', 'frontend', '--runs-on', 'Browser', '--summary', 'booking · cart']);
  forge(['arch', 'add', 'db', '--name', 'Postgres', '--kind', 'db', '--runs-on', 'Supabase']);
  forge(['arch', 'add', 'mail', '--name', 'Email provider', '--kind', 'integration', '--runs-on', 'External services']);
  forge(['arch', 'link', 'member-app', 'db', '--label', 'supabase-js']);
  forge(['arch', 'link', 'db', 'mail', '--label', 'confirmations', '--planned']);
  forge(['screen', 'add', 'Cart', '--name', 'Cart', '--app', 'member-app', '--mock', 'spec/mocks/Cart.png']);
  addItem('D1', ['--component', 'Cart', '--milestone', 'M1']);
  const dash = fs.readFileSync(path.join(dir, 'forge', 'dashboard.html'), 'utf8');
  for (const p of ['overview', 'plan', 'architecture', 'screens', 'usage', 'journal', 'specs', 'system'])
    assert.match(dash, new RegExp(`<section class="page" data-page="${p}"`));
  assert.match(dash, /href="#\/architecture" data-p="architecture">Architecture <span class="k">3 · 3 draft/);
  const data = JSON.parse(dash.match(/<script type="application\/json" id="archdata">([\s\S]*?)<\/script>/)[1]);
  assert.deepStrictEqual(Object.keys(data.parts).sort(), ['db', 'mail', 'member-app']);
  assert.strictEqual(data.parts['member-app'].live, 1, 'screen work rolls up to its app');
  assert.ok(data.edges.find(e => e.to === 'mail').planned);
  assert.match(dash, /BROWSER[\s\S]*SUPABASE[\s\S]*EXTERNAL SERVICES/);   // lanes: browser first, external last
  assert.match(dash, /<section class="sgroup" id="scr-member-app">/);
  assert.match(dash, /data-comp="Cart" data-arch="member-app"/);
  assert.match(dash, /id="wgcomp" hidden/);
  assert.match(dash, /Plan standards/);
  assert.doesNotMatch(dash, /Project map/);
});

test('v0.19.1: a released lock marker is free; arch writes wait on a live lock; a failed change script is recorded and revertable', () => {
  // no-delete filesystems leave a released marker instead of removing the lock
  fs.writeFileSync(path.join(dir, 'forge', 'state', 'work.lock'), JSON.stringify({ released: true, pid: 1, ts: new Date().toISOString() }));
  assert.strictEqual(forge(['arch', 'add', 'app', '--name', 'App', '--kind', 'frontend', '--runs-on', 'Browser']).code, 0);
  // a live holder blocks components.json writes too (they are state writes)
  fs.writeFileSync(path.join(dir, 'forge', 'state', 'work.lock'), JSON.stringify({ pid: process.pid, ts: new Date().toISOString(), cmd: 'test' }));
  const blocked = forge(['arch', 'add', 'db', '--kind', 'db'], { env: { FORGE_LOCK_WAIT_MS: '300' } });
  assert.notStrictEqual(blocked.code, 0);
  assert.match(blocked.out, /write-locked/);
  fs.unlinkSync(path.join(dir, 'forge', 'state', 'work.lock'));
  // a script that fails part-way: recorded (ok false) and revertable
  fs.mkdirSync(path.join(dir, 'forge', 'changes'), { recursive: true });
  const sc = path.join('forge', 'changes', 'half.sh');
  fs.writeFileSync(path.join(dir, sc), '#!/usr/bin/env bash\n# forge-upgrade-step: architecture\nset -euo pipefail\nforge() { node "$FORGE_JS" "$@"; }\nforge arch add db --name DB --kind db --runs-on Supabase\nexit 3\n');
  forge(['upgrade', 'dry-run', sc]);
  // the dry run failed, so run refuses; allow the check by making the script pass in dry-run but fail for real
  fs.writeFileSync(path.join(dir, sc), '#!/usr/bin/env bash\n# forge-upgrade-step: architecture\nset -euo pipefail\nforge() { node "$FORGE_JS" "$@"; }\nforge arch add db --name DB --kind db --runs-on Supabase\n[ -n "${FAIL_REAL:-}" ] && exit 3 || true\n');
  assert.strictEqual(forge(['upgrade', 'dry-run', sc]).code, 0);
  const run = forge(['upgrade', 'run', sc], { env: { FAIL_REAL: '1' } });
  assert.notStrictEqual(run.code, 0);
  const w = JSON.parse(fs.readFileSync(path.join(dir, 'forge', 'state', 'work.json'), 'utf8'));
  const h = w.upgrade.history.slice(-1)[0];
  assert.strictEqual(h.kind, 'run'); assert.strictEqual(h.ok, false); assert.ok(h.backup);
  assert.strictEqual(forge(['upgrade', 'revert']).code, 0);
  const c = JSON.parse(fs.readFileSync(path.join(dir, 'forge', 'state', 'components.json'), 'utf8'));
  assert.ok(!c.components.db, 'revert removed the half-applied part');
  assert.ok(c.components.app);
});

// --- v0.20: autopilot ----------------------------------------------------------

test('autopilot: the Stop hook continues inside a milestone and stops only for a human, with one notice', () => {
  // off: behaviour unchanged — nothing in progress, the turn may end
  addItem('A1', ['--milestone', 'M1']); addItem('A2', ['--milestone', 'M1', '--deps', 'A1']); addItem('B1', ['--milestone', 'M2']);
  assert.strictEqual(hook('stop', { session_id: 's' }).code, 0);
  const on = forge(['autopilot', 'on', '--max-items', '5']);
  assert.strictEqual(on.code, 0);
  assert.match(on.out, /Autopilot ON · stops after 5 task\(s\)/);
  assert.match(on.out, /Next: .*A1/);
  assert.match(on.out, /claude --remote-control/);
  // next task ready in the same milestone → keep going
  let h = hook('stop', { session_id: 's' });
  assert.strictEqual(h.code, 2);
  assert.match(h.out, /AUTOPILOT: keep going — the next task is .*A1/);
  // the nudge produced nothing → the next stop is allowed (no spinning)
  h = hook('stop', { session_id: 's', stop_hook_active: true });
  assert.strictEqual(h.code, 0);
  assert.match(forge(['autopilot', 'status']).out, /last stop: no-progress/);
  // progress: A1 done → continue with A2
  forge(['task', 'start', 'A1']); touch('a.txt'); forge(['task', 'verify', 'A1']);
  h = hook('stop', { session_id: 's', stop_hook_active: true });
  assert.strictEqual(h.code, 2);
  assert.match(h.out, /A1 is still IN_PROGRESS/);
  forge(['task', 'done', 'A1']);
  h = hook('stop', { session_id: 's', stop_hook_active: true });
  assert.strictEqual(h.code, 2);
  assert.match(h.out, /next task is .*A2/);
  // A2 done → milestone complete → one stop notice telling the agent what to ask, then the turn ends
  forge(['task', 'start', 'A2']); touch('b.txt'); forge(['task', 'verify', 'A2']); forge(['task', 'done', 'A2']);
  h = hook('stop', { session_id: 's', stop_hook_active: true });
  assert.strictEqual(h.code, 2);
  assert.match(h.out, /AUTOPILOT stops here: milestone .*M1 is complete and waiting for your testing/);
  assert.match(h.out, /ready to test/);
  h = hook('stop', { session_id: 's', stop_hook_active: true });
  assert.strictEqual(h.code, 0, 'the notice is given once');
  assert.match(forge(['autopilot', 'status']).out, /last stop: gate/);
  assert.match(fs.readFileSync(path.join(dir, 'forge', 'dashboard.html'), 'utf8'), /autopilot on/);
  assert.strictEqual(forge(['autopilot', 'off']).code, 0);
  assert.strictEqual(hook('stop', { session_id: 's' }).code, 0);
});

test('autopilot: a blocked question and the run limit stop it; pre-compact tells the summary what to keep', () => {
  addItem('Q1', ['--milestone', 'M1']); addItem('Q2', ['--milestone', 'M1']); addItem('Q3', ['--milestone', 'M1']);
  forge(['autopilot', 'on', '--max-items', '1']);
  forge(['task', 'start', 'Q1']); forge(['task', 'block', 'Q1', '--reason', 'question: card or invoice?']);
  let h = hook('stop', { session_id: 's' });
  assert.strictEqual(h.code, 2);
  assert.match(h.out, /AUTOPILOT stops here: .*Q1 is blocked: question: card or invoice\?/);
  assert.match(h.out, /Ask the user the exact question/);
  forge(['task', 'cancel', 'Q1', '--reason', 'answered: dropped']);
  forge(['task', 'start', 'Q2']); touch('q.txt'); forge(['task', 'verify', 'Q2']); forge(['task', 'done', 'Q2']);
  h = hook('stop', { session_id: 's', stop_hook_active: true });
  assert.strictEqual(h.code, 2);
  assert.match(h.out, /run limit reached: 1 task\(s\) done this run/);
  const pc = hook('pre-compact', { session_id: 's', trigger: 'auto' });
  assert.strictEqual(pc.code, 0);
  const j = JSON.parse(pc.out);
  assert.strictEqual(j.hookSpecificOutput.hookEventName, 'PreCompact');
  assert.match(j.hookSpecificOutput.additionalContext, /forge task next/);
  assert.match(j.hookSpecificOutput.additionalContext, /AUTOPILOT IS ON/);
  const ss = hook('session-start', { session_id: 's2', source: 'compact' });
  assert.match(ss.out, /AUTOPILOT IS ON/);
});

test('autopilot: a thin next task is prepared, not treated as a dead end', () => {
  addItem('P1', ['--milestone', 'M1']);
  forge(['task', 'add', '--id', 'P2', '--title', 'later', '--milestone', 'M1', '--deps', 'P1']); // thin: no criteria, no scope
  forge(['autopilot', 'on']);
  forge(['task', 'start', 'P1']); touch('p.txt'); forge(['task', 'verify', 'P1']); forge(['task', 'done', 'P1']);
  const h = hook('stop', { session_id: 's' });
  assert.strictEqual(h.code, 2);
  assert.match(h.out, /next task is .*P2/);
  assert.match(h.out, /still thin: write its acceptance criteria/);
});

test('v0.20.1: graphify "use" without a built graph is flagged with the fix; briefs point at the graph once built; Configuration and Commands pages', () => {
  forge(['config', 'set', 'options.graphify', 'use']);
  addItem('G1', ['--milestone', 'M1']);
  let dash = fs.readFileSync(path.join(dir, 'forge', 'dashboard.html'), 'utf8');
  assert.match(dash, /<section class="page" data-page="configuration"/);
  assert.match(dash, /<section class="page" data-page="commands"/);
  assert.match(dash, /data-p="configuration">Configuration <span class="k warnk">graphify<\/span>/);
  assert.match(dash, /graphify update \./);
  assert.match(dash, /graphify claude install/);
  assert.match(dash, /<code>options\.concurrency<\/code><\/td><td><code>4<\/code>/);
  assert.match(dash, /forge autopilot on \[--max-items N\]/);
  assert.doesNotMatch(forge(['brief', 'G1']).out, /graphify query/);
  // a built, ignored graph: the brief tells workers how to ask it
  fs.mkdirSync(path.join(dir, 'graphify-out'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'graphify-out', 'graph.json'), '{}');
  fs.writeFileSync(path.join(dir, '.gitignore'), 'graphify-out/\n');
  assert.match(forge(['brief', 'G1']).out, /graphify query "<question>"/);
  forge(['dashboard']);
  dash = fs.readFileSync(path.join(dir, 'forge', 'dashboard.html'), 'utf8');
  assert.match(dash, /graphify-out\/ ignored/);
  assert.doesNotMatch(dash, /graphify update \./);         // built and fresh: no rebuild advice
  assert.match(dash, /graphify claude install/);             // still not wired into Claude Code
});

// --- v0.21: team delegation (docs/IMPL-team-delegation.md) ------------------

test('C0: lines that share one message.id are one call; the last line\'s usage counts', () => {
  const lines = [];
  const u = (out) => ({ input_tokens: 2, cache_creation_input_tokens: 100, cache_read_input_tokens: 1000, output_tokens: out });
  lines.push({ type: 'assistant', timestamp: '2026-10-01T10:00:00Z', message: { id: 'msg_1', model: 'claude-opus-5-5', content: [{ type: 'thinking' }], usage: u(10) } });
  lines.push({ type: 'assistant', timestamp: '2026-10-01T10:00:01Z', message: { id: 'msg_1', model: 'claude-opus-5-5', content: [{ type: 'text', text: 'x' }], usage: u(10) } });
  lines.push({ type: 'assistant', timestamp: '2026-10-01T10:00:02Z', message: { id: 'msg_1', model: 'claude-opus-5-5', content: [{ type: 'tool_use', name: 'Bash', input: {} }], usage: u(50) } });
  lines.push({ type: 'assistant', timestamp: '2026-10-01T10:00:03Z', message: { id: 'msg_2', model: 'claude-opus-5-5', content: [{ type: 'text', text: 'y' }], usage: u(7) } });
  const root = fakeLogs(lines.map(l => JSON.stringify(l)));
  const r = forge(['usage', '--rescan'], { env: { FORGE_CLAUDE_PROJECTS: root } });
  assert.strictEqual(r.code, 0, r.out);
  assert.match(r.out, /claude-opus-5-5 \[main\]: 2 calls · in 4 · out 57 · cache write 200 \/ read 2,000/);
});

test('C6: two verifies started together run one after the other; --no-wait refuses; state writes are not blocked meanwhile', async () => {
  const { spawn } = require('child_process');
  const log = path.join(dir, 'verify-log.txt');
  const slow = `node -e "const fs=require('fs');fs.appendFileSync('${log.replace(/\\/g, '/')}', 'start '+Date.now()+'\\n');const t=Date.now();while(Date.now()-t<1200){};fs.appendFileSync('${log.replace(/\\/g, '/')}', 'end '+Date.now()+'\\n')"`;
  forge(['config', 'set', 'verify.test', slow]);
  addItem('V1', ['--allowed', 'a/']); forge(['task', 'add', '--id', 'V2', '--title', 'v', '--criterion', 'ok::node -e "process.exit(0)"', '--allowed', 'b/']);
  assert.strictEqual(forge(['task', 'start', 'V1']).code, 0);
  assert.strictEqual(forge(['task', 'start', 'V2']).code, 0);
  const runV = id => new Promise(res => {
    const p = spawn(process.execPath, [CLI, 'task', 'verify', id], { cwd: dir, env: Object.assign({}, process.env, { CLAUDE_PROJECT_DIR: dir, FORGE_CLAUDE_PROJECTS: path.join(os.tmpdir(), 'forge-no-such-logs') }) });
    let o = ''; p.stdout.on('data', d => { o += d; }); p.stderr.on('data', d => { o += d; }); p.on('exit', c => res({ c, o }));
  });
  const both = Promise.all([runV('V1'), runV('V2')]);
  // while a verify runs, an ordinary state write still goes through (the state lock is not held)
  await new Promise(r => setTimeout(r, 400));
  assert.strictEqual(forge(['decision', 'add', 'meanwhile', '--decision', 'x', '--why', 'y']).code, 0);
  const nw = forge(['task', 'verify', 'V1', '--no-wait']);
  const [a, b] = await both;
  assert.strictEqual(a.c, 0, a.o); assert.strictEqual(b.c, 0, b.o);
  assert.match(a.o + b.o, /Waiting for the verify of/);
  assert.notStrictEqual(nw.code, 0); assert.match(nw.out, /another verify is running/);
  const ev = fs.readFileSync(log, 'utf8').trim().split('\n').map(l => l.split(' '));
  // runs must not interleave: start,end,start,end
  assert.deepStrictEqual(ev.map(e => e[0]), ['start', 'end', 'start', 'end']);
  const w = JSON.parse(fs.readFileSync(path.join(dir, 'forge', 'state', 'work.json'), 'utf8'));
  assert.strictEqual(w.items.V1.verifications.length, 1); assert.strictEqual(w.items.V2.verifications.length, 1);
});

test('v0.21: new projects start with every delegation switch on; existing projects (absent) are off; doctor lists them', () => {
  const t = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-new-'));
  spawnSync('git', ['init', '-q'], { cwd: t });
  spawnSync(process.execPath, [CLI, 'init', '--project', 'n'], { cwd: t, env: Object.assign({}, process.env, { CLAUDE_PROJECT_DIR: t }) });
  const o = JSON.parse(fs.readFileSync(path.join(t, 'forge', 'config.json'), 'utf8')).options;
  assert.deepStrictEqual([o.itemShape, o.workerExplore, o.contextPack, o.briefLimit, o.retryFromReview, o.requireDispatch, o.requireTester, o.architectPrepass, o.delegateSpecSync],
    ['refuse', 'bounded', true, 'on', true, true, 'high-risk', 'high-risk', true]);
  const d = forge(['doctor']).out;   // the fixture project: switches absent
  assert.match(d, /switch itemShape: "warn" \(not set — off; new projects start with "refuse": forge config set options.itemShape refuse\)/);
  assert.match(d, /switch requireTester: false/);
});

test('C1: more than 6 criteria is refused at start without --reason, recorded with it; warn keeps the warning; autopilot states the limit', () => {
  const crit = []; for (let i = 0; i < 7; i++) crit.push('--criterion', `c${i}::node -e "process.exit(0)"`);
  forge(['task', 'add', '--id', 'BIG', '--title', 'big', '--milestone', 'M1', ...crit, '--allowed', 'src/']);
  // warn (absent): today's behaviour
  let r = forge(['task', 'start', 'BIG']);
  assert.strictEqual(r.code, 0); assert.match(r.out, /ITEM-SHAPE WARNING: 7 acceptance criteria/);
  forge(['task', 'fail', 'BIG', '--note', 'reset']);
  switchOn('itemShape', 'refuse');
  r = forge(['task', 'start', 'BIG']);
  assert.notStrictEqual(r.code, 0); assert.match(r.out, /7 acceptance criteria \(limit 6, options.itemShape=refuse\)/); assert.match(r.out, /SIDE BY SIDE/);
  r = forge(['task', 'start', 'BIG', '--reason', 'one atomic migration']);
  assert.strictEqual(r.code, 0);
  const w = JSON.parse(fs.readFileSync(path.join(dir, 'forge', 'state', 'work.json'), 'utf8'));
  assert.strictEqual(w.items.BIG.attempts.slice(-1)[0].shapeReason, 'one atomic migration');
  // autopilot's thin-task message states the limit
  forge(['task', 'add', '--id', 'THIN', '--title', 'thin', '--milestone', 'M1', '--deps', 'BIG']);
  forge(['autopilot', 'on']);
  touch('z.txt'); forge(['task', 'verify', 'BIG']); forge(['task', 'done', 'BIG']);
  const h = hook('stop', { session_id: 's' });
  assert.match(h.out, /at most 6 criteria .* side by side/);
});

test('C2: bounded exploration, context pack and brief limit — and with every C2 switch off the brief is unchanged', () => {
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true }); fs.writeFileSync(path.join(dir, 'src', 'a.ts'), 'export const a = 1;\n');
  addItem('B1', ['--objective', 'obj']);
  const off = forge(['brief', 'B1']).out;
  assert.match(off, /this is the set; do not go looking for more/);
  assert.match(off, /Do not search or scan the repository/);
  assert.match(off, /_Orchestrator: prepend relevant spec excerpts/);
  assert.match(forge(['brief', 'B1', '--context']).out, /Context packs are off for this project \(options.contextPack\)/);
  switchOn('workerExplore', 'bounded'); switchOn('contextPack', true); switchOn('briefLimit', 'on');
  forge(['config', 'set', 'options.workerReadBudget', '7']);
  const on = forge(['brief', 'B1']).out;
  assert.match(on, /Files in scope \(\d+\) — start here/);
  assert.match(on, /up to 7 files OUTSIDE the allowed scope/);
  assert.match(on, /STOP and report only for a scope change/);
  assert.doesNotMatch(on, /Do not search or scan the repository/);
  assert.match(on, /no line numbers or code-level fix lists here/);
  // --context: an explorer prompt that writes nothing
  const ctx = forge(['brief', 'B1', '--context']);
  assert.match(ctx.out, /^# Explore brief — B1: context pack/);
  assert.match(ctx.out, /## Invariants/); assert.match(ctx.out, /context save B1/); assert.match(ctx.out, /--purpose explore --item B1/);
  assert.ok(!fs.existsSync(path.join(dir, 'forge', 'context', 'B1.md')));
  // the explorer records the pack; the brief then points at it
  const sv = spawnSync(process.execPath, [CLI, 'context', 'save', 'B1'], { cwd: dir, input: '# Context pack — B1\n## Relevant files\n- src/a.ts\n', encoding: 'utf8', env: Object.assign({}, process.env, { CLAUDE_PROJECT_DIR: dir }) });
  assert.strictEqual(sv.status, 0, sv.stdout + sv.stderr);
  assert.match(forge(['brief', 'B1']).out, /Read `forge\/context\/B1\.md` first/);
  // brief limit: >20 KB refused at --save without --reason; warned above 12 KB at launch
  forge(['task', 'update', 'B1', '--objective', 'x'.repeat(21 * 1024)]);
  let r = forge(['brief', 'B1', '--save']);
  assert.notStrictEqual(r.code, 0); assert.match(r.out, /limit 20 KB, options.briefLimit=on/);
  r = forge(['brief', 'B1', '--save', '--reason', 'one-off']);
  assert.strictEqual(r.code, 0);
  forge(['task', 'start', 'B1']);
  r = forge(['task', 'dispatch', 'B1', '--agent', 'forge-implementer', '--model', 'sonnet']);
  assert.notStrictEqual(r.code, 0); assert.match(r.out, /is 2\d\.\d KB \(limit 20 KB/);
  forge(['task', 'update', 'B1', '--objective', 'x'.repeat(14 * 1024)]); forge(['brief', 'B1', '--save']);
  r = forge(['task', 'dispatch', 'B1', '--agent', 'forge-implementer', '--model', 'sonnet']);
  assert.strictEqual(r.code, 0); assert.match(r.out, /BRIEF SIZE WARNING/);
});

test('C3: a retry brief is the original brief plus only the latest review findings', () => {
  switchOn('retryFromReview', true);
  addItem('R1');
  forge(['brief', 'R1', '--save']);
  const bf = path.join(dir, 'forge', 'briefs', 'R1.md');
  fs.appendFileSync(bf, '\n## Spec excerpt\nThe CTO completed this brief.\n');
  forge(['task', 'start', 'R1']);
  fs.writeFileSync(path.join(dir, 'review1.md'), '- FINDING-ONE: 401 returned when JWKS is down\n');
  assert.strictEqual(forge(['task', 'fail', 'R1', '--from-review', 'review1.md']).code, 0);
  forge(['brief', 'R1', '--save']);
  let b = fs.readFileSync(bf, 'utf8');
  assert.match(b, /The CTO completed this brief/); assert.match(b, /FINDING-ONE/);
  forge(['task', 'start', 'R1']);
  fs.writeFileSync(path.join(dir, 'review2.md'), '- FINDING-TWO: refresh offline signs the user out\n');
  forge(['task', 'fail', 'R1', '--from-review', 'review2.md']);
  forge(['brief', 'R1', '--save']);
  b = fs.readFileSync(bf, 'utf8');
  assert.match(b, /FINDING-TWO/); assert.doesNotMatch(b, /FINDING-ONE/);
  assert.strictEqual((b.match(/## Fix these review findings/g) || []).length, 1);
  assert.match(b, /The CTO completed this brief/);
  assert.match(forge(['task', 'start', 'R1']).out, /REQUIRES --escalate|failed 2 attempts/);
});

test('C4: a task tagged api/auth carries the failure-class rule from its domain packs', () => {
  addItem('D1', ['--domain', 'api,auth']);
  const b = forge(['brief', 'D1']).out;
  assert.match(b, /## Domain rules \(backend, security\)/);
  assert.match(b, /name each failure class and its distinct handling; an unknown outcome is never treated as a known failure/);
  addItem('D2');
  assert.doesNotMatch(forge(['brief', 'D2']).out, /Domain rules/);
});

test('C5: done refuses without a worker dispatch; accepts a recorded one; --self --reason is counted in stats', () => {
  switchOn('requireDispatch', true);
  addItem('S1', ['--allowed', 'a/']); forge(['task', 'add', '--id', 'S2', '--title', 's', '--criterion', 'ok::node -e "process.exit(0)"', '--allowed', 'b/']);
  forge(['task', 'start', 'S1']); touch('s1.txt'); forge(['task', 'verify', 'S1']);
  let r = forge(['task', 'done', 'S1']);
  assert.notStrictEqual(r.code, 0); assert.match(r.out, /no implementer or tester dispatch recorded/); assert.match(r.out, /forge task dispatch S1 --agent forge-implementer/);
  forge(['task', 'dispatch', 'S1', '--agent', 'forge-implementer', '--model', 'sonnet']);
  assert.strictEqual(forge(['task', 'done', 'S1']).code, 0);
  forge(['task', 'start', 'S2']); touch('s2.txt'); forge(['task', 'verify', 'S2']);
  assert.notStrictEqual(forge(['task', 'done', 'S2', '--self']).code, 0);
  assert.strictEqual(forge(['task', 'done', 'S2', '--self', '--reason', 'one-line copy fix']).code, 0);
  assert.match(forge(['stats']).out, /Closed by the CTO \(--self\): 1\/2 — S2/);
});

test('C8: high-risk tasks need a tester (or a reason); warn mode only warns on test-lane tasks', () => {
  switchOn('requireTester', 'high-risk');
  addItem('H1', ['--domain', 'payments', '--allowed', 'a/']);
  forge(['task', 'start', 'H1']); touch('h1.txt'); forge(['task', 'verify', 'H1']);
  let r = forge(['task', 'done', 'H1']);
  assert.notStrictEqual(r.code, 0); assert.match(r.out, /high-risk \(payments\) and no forge-tester was dispatched/);
  forge(['task', 'dispatch', 'H1', '--agent', 'forge-tester', '--model', 'sonnet']);
  assert.strictEqual(forge(['task', 'done', 'H1']).code, 0);
  // a routine task is not held
  addItem('H2', ['--allowed', 'b/']); forge(['task', 'start', 'H2']); touch('h2.txt'); forge(['task', 'verify', 'H2']);
  assert.strictEqual(forge(['task', 'done', 'H2']).code, 0);
  // warn: test-lane criteria without a tester warn, never refuse
  switchOn('requireTester', 'warn');
  forge(['task', 'add', '--id', 'H3', '--title', 't', '--criterion', 'tests pass::node -e "process.exit(0)" # vitest', '--allowed', 'c/']);
  forge(['task', 'start', 'H3']); touch('h3.txt'); forge(['task', 'verify', 'H3']);
  r = forge(['task', 'done', 'H3']);
  assert.strictEqual(r.code, 0); assert.match(r.out, /TESTER WARNING/);
});

test('C9: starting a high-risk task without an architect dispatch prints the design prompt; the brief carries the note', () => {
  switchOn('architectPrepass', 'high-risk');
  addItem('A9', ['--domain', 'auth']);
  const r = forge(['task', 'start', 'A9']);
  assert.match(r.out, /HIGH-RISK TASK \(auth\)/); assert.match(r.out, /# Design brief — A9/); assert.match(r.out, /context save A9 --section design-note/);
  const sv = spawnSync(process.execPath, [CLI, 'context', 'save', 'A9', '--section', 'design-note'], { cwd: dir, input: 'Failure classes: invalid token → 401; JWKS down → 503.\n', encoding: 'utf8', env: Object.assign({}, process.env, { CLAUDE_PROJECT_DIR: dir }) });
  assert.strictEqual(sv.status, 0);
  forge(['brief', 'A9', '--save']);
  assert.match(fs.readFileSync(path.join(dir, 'forge', 'briefs', 'A9.md'), 'utf8'), /## Design note \(forge-architect\)\nFailure classes: invalid token → 401; JWKS down → 503\./);
  // a routine task gets no prompt
  addItem('A8', ['--allowed', 'zz/']);
  assert.doesNotMatch(forge(['task', 'start', 'A8']).out, /HIGH-RISK/);
});

test('C11: milestone security --brief prints a reviewer prompt with the range, pack and output shape, and writes nothing', () => {
  addItem('M1a', ['--milestone', 'M1']);
  const before = fs.readFileSync(path.join(dir, 'forge', 'state', 'work.json'), 'utf8');
  const r = forge(['milestone', 'security', 'M1', '--brief']);
  assert.strictEqual(r.code, 0, r.out);
  assert.match(r.out, /^# Security brief — milestone M1/);
  assert.match(r.out, /forge-domain-packs\/references\/security\.md/);
  assert.match(r.out, /NEW WORK ITEM .* ACCEPTED RISK/);
  assert.strictEqual(fs.readFileSync(path.join(dir, 'forge', 'state', 'work.json'), 'utf8'), before);
});

test('v0.21: Configuration is Forge and the dev setup (why, risk, copyable command); Specs is the application; change scripts live on System', () => {
  addItem('S1', ['--milestone', 'M1']);
  fs.mkdirSync(path.join(dir, 'forge', 'changes'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'forge', 'changes', '2026-10-01-recut.md'), '# recut\n');
  forge(['dashboard']);
  const dash = fs.readFileSync(path.join(dir, 'forge', 'dashboard.html'), 'utf8');
  const page = id => dash.split(`data-page="${id}"`)[1].split('</section>')[0];
  const conf = page('configuration'), specs = page('specs'), sys = page('system');
  assert.match(conf, /how Forge and the development setup are configured/);
  assert.match(conf, /<th>Why you'd change it<\/th><th>Risk<\/th><th>How to change<\/th>/);
  assert.match(conf, /<code>options\.itemShape<\/code>.*class="risk risk-testfirst">test first<\/span>.*<code class="cmd copyable"[^>]*>forge config set options\.itemShape refuse<\/code>/);
  assert.match(conf, /turn it back off/);
  assert.match(specs, /what the application must do/);
  assert.doesNotMatch(specs, /2026-10-01-recut\.md|Change scripts/);
  assert.match(sys, /Plan change scripts/);
  assert.match(sys, /2026-10-01-recut\.md/);
  assert.match(dash, /closest\('code\.copyable'\)/);
});

test('v0.21: the graphify git hook is found under core.hooksPath (a tracked .githooks/), not only .git/hooks', () => {
  forge(['config', 'set', 'options.graphify', 'use']);
  addItem('H1', ['--milestone', 'M1']);
  const dash = () => { forge(['dashboard']); return fs.readFileSync(path.join(dir, 'forge', 'dashboard.html'), 'utf8').split('data-page="configuration"')[1].split('</section>')[0]; };
  assert.match(dash(), /graphify hook install/);
  fs.mkdirSync(path.join(dir, '.githooks'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.githooks', 'post-commit'), '#!/bin/sh\n# graphify-hook-start\n# graphify-hook-end\n');
  spawnSync('git', ['config', 'core.hooksPath', '.githooks'], { cwd: dir });
  const d = dash();
  assert.match(d, /rebuilt after every commit \(git hook\)/);
  assert.doesNotMatch(d, /graphify hook install/);
});

test('v0.21.2: overview has no journal card; overview grids cannot be widened by long titles', () => {
  addItem('L1', ['--milestone', 'M1', '--title', 'A very long title '.repeat(20)]);
  forge(['decision', 'add', '--title', 'Some decision', '--why', 'because', '--authority', 'human']);
  forge(['dashboard']);
  const dash = fs.readFileSync(path.join(dir, 'forge', 'dashboard.html'), 'utf8');
  const ov = dash.split('data-page="overview"')[1].split('</section>')[0];
  assert.doesNotMatch(ov, /Latest in the journal/);
  assert.match(dash, /\.ovgrid\{display:grid;grid-template-columns:minmax\(0,1\.7fr\) minmax\(0,1fr\)/);
  assert.match(dash, /\.ovgrid>\*,\.panel\{min-width:0\}/);
  assert.match(dash, /\.kpis\{display:grid;grid-template-columns:minmax\(0,1\.35fr\)/);
});

test('v0.21.2: a task blocked mid-work on the user\'s stray change resumes with unblock — same attempt, verification kept — and closes', () => {
  gitFlowProject();
  addItem('A', ['--milestone', 'M1']);
  forge(['milestone', 'branch', 'M1']);
  forge(['task', 'start', 'A']);
  fs.writeFileSync(path.join(dir, 'src', 'a.js'), 'a');
  fs.mkdirSync(path.join(dir, '.githooks'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.githooks', 'post-checkout'), '#!/bin/sh\n');
  assert.strictEqual(forge(['task', 'verify', 'A']).code, 0);
  const d = forge(['task', 'done', 'A']);
  assert.notStrictEqual(d.code, 0);
  assert.match(d.out, /only the user can commit or revert them/);
  assert.match(d.out, /forge task unblock A && forge task done A/);
  const b = forge(['task', 'block', 'A', '--reason', 'question: commit .githooks/post-checkout?']);
  assert.match(b.out, /forge task unblock A/);
  assert.strictEqual(work().items.A.blockedFrom, 'IN_PROGRESS');
  // the user commits their file
  g('add', '.githooks/post-checkout'); g('commit', '-qm', 'hooks');
  const u = forge(['task', 'unblock', 'A', '--note', 'committed']);
  assert.strictEqual(u.code, 0, u.out);
  const wa = work().items.A;
  assert.strictEqual(wa.status, 'IN_PROGRESS');
  assert.strictEqual(wa.attempts.length, 1);               // no new start
  assert.strictEqual(wa.unblocks[0].answer, 'committed');
  assert.strictEqual(wa.blockedFrom, undefined);
  assert.strictEqual(forge(['task', 'verify', 'A']).code, 0);
  const done = forge(['task', 'done', 'A']);
  assert.strictEqual(done.code, 0, done.out);
  assert.strictEqual(work().items.A.status, 'DONE');
});

test('v0.21.2: unblock of a task blocked before it started returns it to TODO; unblock of a non-blocked task refuses', () => {
  addItem('T', ['--milestone', 'M1']);
  forge(['task', 'block', 'T', '--reason', 'question: which provider?']);
  assert.strictEqual(forge(['task', 'unblock', 'T']).code, 0);
  assert.strictEqual(work().items.T.status, 'TODO');
  assert.notStrictEqual(forge(['task', 'unblock', 'T']).code, 0);
});

test('v0.21.2: an autopilot stop with work in progress shows on the dashboard until the plan moves', () => {
  addItem('P1', ['--milestone', 'M1']);
  forge(['autopilot', 'on']);
  forge(['task', 'start', 'P1']);
  assert.strictEqual(hook('stop', { session_id: 's' }).code, 2);                             // nudge
  assert.strictEqual(hook('stop', { session_id: 's', stop_hook_active: true }).code, 0);     // no progress: the turn ends
  forge(['dashboard']);
  let dash = fs.readFileSync(path.join(dir, 'forge', 'dashboard.html'), 'utf8');
  assert.match(dash, /Autopilot stopped — your session is waiting for you/);
  assert.match(dash, /ended its turn with P1 still in progress/);
  assert.match(dash, /class="phase apstop"/);
  assert.doesNotMatch(dash, /<h3>Building — P1 in progress<\/h3>/);
  touch('p.txt'); forge(['task', 'verify', 'P1']);                                          // the plan moves
  dash = fs.readFileSync(path.join(dir, 'forge', 'dashboard.html'), 'utf8');
  assert.doesNotMatch(dash, /Autopilot stopped/);
  assert.match(dash, /class="phase ap"/);
});

test('v0.21.2: a blocked task is shown as needing you even while others are in progress', () => {
  addItem('A', ['--milestone', 'M1', '--allowed', 'a/']); addItem('B', ['--milestone', 'M1', '--allowed', 'b/']);
  forge(['config', 'set', 'options.concurrency', '2']);
  forge(['task', 'start', 'A']); forge(['task', 'start', 'B']);
  forge(['task', 'block', 'B', '--reason', 'question: which?']);
  const dash = fs.readFileSync(path.join(dir, 'forge', 'dashboard.html'), 'utf8');
  assert.match(dash, /1 item\(s\) are blocked and need your answer/);
});

// --- v0.22 -------------------------------------------------------------------

test('v0.22: task origin — a review fix names its parent and sits right after it; splits need a parent; fixes do not chain; stats and dashboard show planned vs discovered', () => {
  addItem('P1', ['--milestone', 'M1']); addItem('P2', ['--milestone', 'M1', '--deps', 'P1']);
  let r = forge(['task', 'add', '--id', 'S1', '--title', 'split', '--milestone', 'M1', '--origin', 'split', '--criterion', 'ok::true']);
  assert.notStrictEqual(r.code, 0); assert.match(r.out, /needs --parent/);
  r = forge(['task', 'add', '--id', 'X1', '--title', 'x', '--milestone', 'M1', '--origin', 'nonsense']);
  assert.notStrictEqual(r.code, 0); assert.match(r.out, /--origin must be one of/);
  r = forge(['task', 'add', '--id', 'F1', '--title', 'fix a', '--milestone', 'M1', '--origin', 'review', '--parent', 'P1', '--criterion', 'ok::true', '--allowed', 'src/']);
  assert.strictEqual(r.code, 0); assert.match(r.out, /origin: review of P1, placed after P1/);
  r = forge(['task', 'add', '--id', 'F1b', '--title', 'fix b', '--milestone', 'M1', '--origin', 'review', '--parent', 'P1', '--criterion', 'ok::true', '--allowed', 'src/']);
  assert.match(r.out, /placed after F1/);                                            // after the parent's earlier children
  const w = JSON.parse(fs.readFileSync(path.join(dir, 'forge', 'state', 'work.json'), 'utf8'));
  assert.deepStrictEqual(w.milestones.M1.taskOrder, ['P1', 'F1', 'F1b', 'P2']);
  assert.strictEqual(w.items.F1.origin, 'review'); assert.strictEqual(w.items.F1.parent, 'P1');
  // depth 1: a finding on a fix task folds into it
  r = forge(['task', 'add', '--id', 'F2', '--title', 'fix of a fix', '--milestone', 'M1', '--origin', 'review', '--parent', 'F1']);
  assert.notStrictEqual(r.code, 0); assert.match(r.out, /fold INTO it/);
  // an untagged add to a started milestone is warned, and can be tagged after the fact
  forge(['task', 'start', 'P1']);
  r = forge(['task', 'add', '--id', 'D1', '--title', 'found', '--milestone', 'M1', '--criterion', 'ok::true']);
  assert.match(r.out, /ORIGIN WARNING/);
  r = forge(['task', 'update', 'D1', '--origin', 'discovery']);
  assert.match(r.out, /origin = discovery/);
  assert.match(forge(['task', 'list']).out, /F1 .*\[review of P1\]/);
  // a closed task can still be tagged with its origin (a label, like the component tag)
  touch('p1.txt'); forge(['task', 'verify', 'P1']); forge(['task', 'done', 'P1']);
  r = forge(['task', 'update', 'P1', '--origin', 'human', '--reason', 'asked on 30 Sep']);
  assert.strictEqual(r.code, 0); assert.match(r.out, /\(DONE\) origin = human/);
  assert.notStrictEqual(forge(['task', 'update', 'P1', '--title', 'nope']).code, 0);
  const st = forge(['stats']).out;
  assert.match(st, /Origin: plan:1 · review:2 · discovery:1 · human:1/);
  assert.match(st, /4 task\(s\) \(80%\) were not in the plan/);
  const dash = fs.readFileSync(path.join(dir, 'forge', 'dashboard.html'), 'utf8');
  assert.match(dash, /1 planned · 0 split · <b title="review 2 · discovery 1 · human 1">4 discovered<\/b>/);
  assert.match(dash, /origin-review/);
});

test('v0.22: first-pass — a review rejection is a failed attempt of kind review, and findings sent to a running worker correct the attempt; stats split both out', () => {
  addItem('R1'); addItem('R2'); addItem('R3');
  // R1: reviewer rejected after green checks → fail --kind review → retry → done
  forge(['task', 'start', 'R1']); touch('r1.txt'); forge(['task', 'verify', 'R1']);
  let r = forge(['task', 'fail', 'R1', '--kind', 'review', '--note', 'B1 race']);
  assert.strictEqual(r.code, 0);
  forge(['task', 'start', 'R1']); touch('r1b.txt'); forge(['task', 'verify', 'R1']); forge(['task', 'done', 'R1']);
  // R2: findings messaged to the running worker — fixed before done, but not first pass
  forge(['task', 'start', 'R2']);
  forge(['task', 'dispatch', 'R2', '--agent', 'forge-implementer', '--model', 'sonnet']);
  r = forge(['task', 'dispatch', 'R2', '--kind', 'message', '--findings', '--note', 'review F1 F2']);
  assert.match(r.out, /no longer counts as first-pass/);
  touch('r2.txt'); forge(['task', 'verify', 'R2']); forge(['task', 'done', 'R2']);
  // R3: clean
  forge(['task', 'start', 'R3']); touch('r3.txt'); forge(['task', 'verify', 'R3']); forge(['task', 'done', 'R3']);
  const w = JSON.parse(fs.readFileSync(path.join(dir, 'forge', 'state', 'work.json'), 'utf8'));
  assert.strictEqual(w.items.R1.attempts.find(a => a.outcome === 'failed').kind, 'review');
  assert.strictEqual(w.items.R2.attempts.find(a => a.outcome === 'started').corrected, true);
  assert.strictEqual(w.items.R3.closed.forgeVersion, JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'plugins', 'forge', '.claude-plugin', 'plugin.json'), 'utf8')).version);
  const st = forge(['stats']).out;
  assert.match(st, /First-pass rate: 1\/3 \(33%\)/);
  assert.match(st, /\(1 corrected mid-flight\)/);
  assert.match(st, /Failed attempts by kind: 0 worker \(verify\/stall\) · 1 review/);
  assert.match(st, /First-pass by review tier: unreviewed 1\/3/);
  const dash = fs.readFileSync(path.join(dir, 'forge', 'dashboard.html'), 'utf8');
  assert.match(dash, /1\/3 · no failed attempt, no mid-flight correction · 1 corrected/);
  assert.match(dash, /failed attempt\(s\) · 0 worker · 1 review/);
  assert.match(dash, /LAST 7 DAYS<\/div><div class="pv">3 done <small>· 3 added/);
  // a failure recorded before v0.22 (no kind) is classified from its note
  addItem('R5'); forge(['task', 'start', 'R5']); forge(['task', 'fail', 'R5', '--note', 'Review (opus) REJECT, blocker B1: race']);
  forge(['task', 'start', 'R5']); touch('r5.txt'); forge(['task', 'verify', 'R5']); forge(['task', 'done', 'R5']);
  const wf = JSON.parse(fs.readFileSync(path.join(dir, 'forge', 'state', 'work.json'), 'utf8'));
  delete wf.items.R5.attempts.find(a => a.outcome === 'failed').kind; fs.writeFileSync(path.join(dir, 'forge', 'state', 'work.json'), JSON.stringify(wf));
  assert.match(forge(['stats']).out, /Failed attempts by kind: 0 worker \(verify\/stall\) · 2 review \(checks passed, reviewer rejected; attempts recorded before v0.22 are classified from their diagnosis note\)/);
  // a message that looks like findings but is not flagged gets a note, not a correction
  addItem('R4'); forge(['task', 'start', 'R4']); forge(['task', 'dispatch', 'R4', '--agent', 'forge-implementer', '--model', 'sonnet']);
  r = forge(['task', 'dispatch', 'R4', '--kind', 'message', '--note', 'review F3: fix the import']);
  assert.match(r.out, /looks like review findings/);
});

test('v0.22: the Stop hook lets a turn end quietly while a worker is live — no nudge, no no-progress stop — and nudges again once the worker window has passed', () => {
  addItem('W1', ['--milestone', 'M1']);
  forge(['autopilot', 'on']);
  forge(['task', 'start', 'W1']);
  forge(['task', 'dispatch', 'W1', '--agent', 'forge-implementer', '--model', 'sonnet']);
  let h = hook('stop', { session_id: 's' });
  assert.strictEqual(h.code, 0, h.out);                                                      // worker live: quiet
  assert.doesNotMatch(h.out, /AUTOPILOT/);
  h = hook('stop', { session_id: 's', stop_hook_active: true });
  assert.strictEqual(h.code, 0);
  const run = JSON.parse(fs.readFileSync(path.join(dir, 'forge', 'state', 'autopilot.json'), 'utf8'));
  assert.ok(!run.stopped, 'no stop recorded while the worker runs');
  assert.match(fs.readFileSync(path.join(dir, 'forge', 'state', 'trace.jsonl'), 'utf8'), /"autopilot":"worker-live"/);
  // dashboard: building, with the worker named — not "stopped"
  forge(['dashboard']);
  let dash = fs.readFileSync(path.join(dir, 'forge', 'dashboard.html'), 'utf8');
  assert.match(dash, /<h3>Building — W1 in progress<\/h3>/);
  assert.match(dash, /W1<\/code> → forge-implementer running/);
  assert.match(dash, /1 worker running/);
  // a verify after the dispatch means the worker reported back: the hook nudges again
  touch('w.txt'); forge(['task', 'verify', 'W1']);
  h = hook('stop', { session_id: 's' });
  assert.strictEqual(h.code, 2); assert.match(h.out, /AUTOPILOT is on and W1 is still IN_PROGRESS/);
  // a worker older than options.workerMaxMinutes is no longer live
  forge(['task', 'dispatch', 'W1', '--agent', 'forge-implementer', '--kind', 'message', '--note', 'go on']);
  assert.strictEqual(hook('stop', { session_id: 's' }).code, 0);
  forge(['config', 'set', 'options.workerMaxMinutes', '0.00001']);
  assert.strictEqual(hook('stop', { session_id: 's' }).code, 2);
  // without autopilot the same rule applies to the dangling-work guard
  forge(['autopilot', 'off']); forge(['config', 'set', 'options.workerMaxMinutes', '90']);
  forge(['task', 'dispatch', 'W1', '--agent', 'forge-implementer', '--kind', 'message', '--note', 'go on']);
  assert.strictEqual(hook('stop', { session_id: 's' }).code, 0);
});

test('v0.22: the banner — a question always wins; a dependency block while others build is a wait, not a question; a stale autopilot stop hides while a worker is live', () => {
  addItem('A', ['--milestone', 'M1', '--allowed', 'a/']); addItem('B', ['--milestone', 'M1', '--allowed', 'b/']); addItem('C', ['--milestone', 'M1', '--allowed', 'c/']);
  forge(['config', 'set', 'options.concurrency', '3']);
  forge(['task', 'start', 'A']); forge(['task', 'start', 'B']);
  forge(['task', 'block', 'B', '--reason', 'waiting on A (deferred release)']);
  let dash = fs.readFileSync(path.join(dir, 'forge', 'dashboard.html'), 'utf8');
  assert.match(dash, /<h3>Building — A in progress<\/h3>/);
  assert.match(dash, /B waits on other work/);
  assert.doesNotMatch(dash, /need your answer/);
  assert.match(dash, /QUESTIONS · NEED YOU<\/div><div class="d">1 blocked on other work/);
  assert.match(dash, /data-s="BLOCKED" data-act="1" data-q="0"/);
  forge(['task', 'start', 'C']); forge(['task', 'block', 'C', '--reason', 'question: which currency?']);
  dash = fs.readFileSync(path.join(dir, 'forge', 'dashboard.html'), 'utf8');
  assert.match(dash, /1 item\(s\) are blocked and need your answer/);
  assert.match(dash, /meanwhile A keeps building/);
  assert.match(dash, /data-s="BLOCKED" data-act="1" data-q="1"/);
  // a stop recorded before a dispatch does not outlive the worker it did not know about
  forge(['task', 'unblock', 'C']); forge(['task', 'unblock', 'B']);
  forge(['autopilot', 'on']);
  assert.strictEqual(hook('stop', { session_id: 's' }).code, 2);
  assert.strictEqual(hook('stop', { session_id: 's', stop_hook_active: true }).code, 0);
  forge(['dashboard']);
  dash = fs.readFileSync(path.join(dir, 'forge', 'dashboard.html'), 'utf8');
  assert.match(dash, /Autopilot stopped — your session is waiting for you/);
  forge(['task', 'dispatch', 'A', '--agent', 'forge-implementer', '--model', 'sonnet']);
  dash = fs.readFileSync(path.join(dir, 'forge', 'dashboard.html'), 'utf8');
  assert.doesNotMatch(dash, /Autopilot stopped/);
  assert.match(dash, /A<\/code> → forge-implementer running/);
});

test('v0.22: fixed model routing — new projects start fixed with a full id per role; dispatch fills or refuses the model; the Agent call is denied on another model; auto stays silent', () => {
  const cf = path.join(dir, 'forge', 'config.json');
  // what forge init wrote (the fixture removed it to emulate an existing project): put it back
  const fresh = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-init-'));
  spawnSync('git', ['init', '-q'], { cwd: fresh });
  spawnSync(process.execPath, [CLI, 'init'], { cwd: fresh, encoding: 'utf8', env: Object.assign({}, process.env, { CLAUDE_PROJECT_DIR: fresh }) });
  const initCfg = JSON.parse(fs.readFileSync(path.join(fresh, 'forge', 'config.json'), 'utf8'));
  assert.strictEqual(initCfg.options.modelRouting, 'fixed');
  assert.strictEqual(initCfg.options.models.implementer, 'claude-sonnet-5-5');
  assert.strictEqual(initCfg.options.models.explorer, 'claude-haiku-4-5-20251001');
  assert.strictEqual(initCfg.options.models.security, 'claude-opus-5-5');
  assert.strictEqual(initCfg.options.autopilotMode, 'session');
  // auto (existing project): nothing changes
  addItem('M1i'); forge(['task', 'start', 'M1i']);
  let r = forge(['task', 'dispatch', 'M1i', '--agent', 'forge-implementer', '--model', 'sonnet']);
  assert.strictEqual(r.code, 0);
  let h = hook('pretooluse', { session_id: 's', tool_name: 'Agent', tool_input: { subagent_type: 'forge:forge-implementer', model: 'sonnet', prompt: '# Work brief — M1i: x' } });
  assert.strictEqual(h.code, 0); assert.doesNotMatch(h.out, /deny/);
  // fixed
  forge(['config', 'set', 'options.modelRouting', 'fixed']);
  forge(['config', 'set', 'options.models.explorer', 'claude-sonnet-5-5']);           // haiku fell short: one value
  r = forge(['task', 'dispatch', 'M1i', '--agent', 'forge-tester', '--model', 'sonnet']);
  assert.notStrictEqual(r.code, 0); assert.match(r.out, /runs on claude-sonnet-5-5 \(options.models.tester\), not 'sonnet'/);
  r = forge(['task', 'dispatch', 'M1i', '--agent', 'forge-tester']);
  assert.strictEqual(r.code, 0); assert.match(r.out, /\[claude-sonnet-5-5\]/);          // filled from the map
  r = forge(['task', 'dispatch', 'M1i', '--agent', 'forge-tester', '--model', 'claude-sonnet-5', '--reason', 'comparing versions']);
  assert.strictEqual(r.code, 0);                                                        // recorded override
  r = forge(['dispatch', '--agent', 'forge-reviewer', '--purpose', 'review', '--item', 'M1i', '--model', 'opus']);
  assert.notStrictEqual(r.code, 0); assert.match(r.out, /options.models.reviewer/);
  r = forge(['dispatch', '--agent', 'forge-reviewer', '--purpose', 'security', '--model', 'claude-opus-5-5']);
  assert.strictEqual(r.code, 0);                                                        // the security pass is the security role
  r = forge(['dispatch', '--agent', 'forge-explorer', '--purpose', 'explore']);
  assert.match(r.out, /\[claude-sonnet-5-5\]/);
  // the Agent call itself
  h = hook('pretooluse', { session_id: 's', tool_name: 'Agent', tool_input: { subagent_type: 'forge:forge-implementer', model: 'sonnet', prompt: '# Work brief — M1i: x' } });
  assert.strictEqual(h.code, 0);
  const deny = JSON.parse(h.out.trim().split('\n').pop());
  assert.strictEqual(deny.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(deny.hookSpecificOutput.permissionDecisionReason, /runs on claude-sonnet-5-5 — not 'sonnet'/);
  h = hook('pretooluse', { session_id: 's', tool_name: 'Agent', tool_input: { subagent_type: 'forge-reviewer', prompt: '# Security brief — M1: pass' } });
  assert.match(h.out, /the call named no model/); assert.match(h.out, /claude-opus-5-5/);
  h = hook('pretooluse', { session_id: 's', tool_name: 'Agent', tool_input: { subagent_type: 'forge-implementer', model: 'claude-sonnet-5-5', prompt: '# Work brief — M1i: x' } });
  assert.strictEqual(h.out.trim(), '');                                                  // allowed: silent
  h = hook('pretooluse', { session_id: 's', tool_name: 'Agent', tool_input: { subagent_type: 'general-purpose', model: 'opus', prompt: 'anything' } });
  assert.strictEqual(h.out.trim(), '');                                                  // not a forge role: not Forge's call
  assert.match(fs.readFileSync(path.join(dir, 'forge', 'state', 'trace.jsonl'), 'utf8'), /"reason":"model-routing"/);
  // the brief names the models; doctor lists them; the dashboard documents the map
  assert.match(forge(['brief', 'M1i']).out, /Models \(options.modelRouting fixed\): implementer → claude-sonnet-5-5 · tester → claude-sonnet-5-5 · review → claude-sonnet-5-5 · explorer → claude-sonnet-5-5 · architect → claude-opus-5-5/);
  const doc = forge(['doctor']).out;
  assert.match(doc, /model routing: fixed/); assert.match(doc, /PASS  model explorer: claude-sonnet-5-5/);
  assert.match(doc, /WARN  model implementer: not set — default claude-sonnet-5-5 applies/);
  assert.match(fs.readFileSync(path.join(dir, 'forge', 'dashboard.html'), 'utf8'), /options.models.&lt;role&gt;/);
  assert.match(forge(['upgrade']).out, /model-map/);
});

test('v0.22: the runner — refused in session mode; dry-run prints the command; one fresh process per task, stops at the limit; the in-session Stop hook never nudges on in runner mode', () => {
  addItem('K1', ['--milestone', 'M1']); addItem('K2', ['--milestone', 'M1', '--deps', 'K1']);
  let r = forge(['autopilot', 'run', '--dry-run']);
  assert.notStrictEqual(r.code, 0); assert.match(r.out, /options.autopilotMode is 'session'/);
  forge(['config', 'set', 'options.autopilotMode', 'runner']);
  r = forge(['autopilot', 'run', '--dry-run']);
  assert.strictEqual(r.code, 0);
  assert.match(r.out, /Would run \(V0\.1\.1 K1 — K1\)/);
  assert.match(r.out, /claude -p 'AUTOPILOT RUNNER — this session does exactly ONE task, then ends\./);
  assert.match(r.out, /forge task start K1/);
  assert.match(r.out, /--permission-mode acceptEdits/);
  // a fake `claude` that does the task through the CLI, as a real session would
  const fake = path.join(dir, 'fake-claude');
  fs.writeFileSync(fake, `#!/usr/bin/env node
    const { spawnSync } = require('child_process'); const fs = require('fs'); const path = require('path');
    const prompt = process.argv[process.argv.indexOf('-p') + 1];
    const id = (prompt.match(/forge task start (\\S+)/) || [])[1];
    const f = a => spawnSync(process.execPath, [${JSON.stringify(CLI)}, ...a], { cwd: process.cwd(), encoding: 'utf8', env: process.env });
    fs.appendFileSync(path.join(process.cwd(), 'runner.log'), process.argv.slice(2).join(' ') + '\\n');
    f(['task', 'start', id]); fs.writeFileSync(path.join(process.cwd(), id + '.txt'), 'x');
    f(['task', 'dispatch', id, '--agent', 'forge-implementer', '--model', 'sonnet']);
    f(['task', 'verify', id]); const d = f(['task', 'done', id]); process.stdout.write(d.stdout);
  `);
  fs.chmodSync(fake, 0o755);
  r = forge(['autopilot', 'run', '--max-items', '1'], { env: { FORGE_CLAUDE: fake } });
  assert.strictEqual(r.code, 0, r.out);
  assert.match(r.out, /▶ V0\.1\.1 K1 — K1/);
  assert.match(r.out, /RUNNER STOPS: run limit reached: 1 task\(s\) done this run \(max 1\)/);
  assert.match(r.out, /1 process\(es\) · 1 task\(s\) done this run/);
  const w = JSON.parse(fs.readFileSync(path.join(dir, 'forge', 'state', 'work.json'), 'utf8'));
  assert.strictEqual(w.items.K1.status, 'DONE'); assert.strictEqual(w.items.K2.status, 'TODO');
  assert.match(fs.readFileSync(path.join(dir, 'runner.log'), 'utf8'), /-p AUTOPILOT RUNNER/);
  const run = JSON.parse(fs.readFileSync(path.join(dir, 'forge', 'state', 'autopilot.json'), 'utf8'));
  assert.strictEqual(run.mode, 'runner'); assert.strictEqual(run.sessions, 1); assert.strictEqual(run.stopped.kind, 'limit');
  // no limit: K2 runs too, then the milestone gate stops the runner with exit 3 (a human is needed)
  r = forge(['autopilot', 'run'], { env: { FORGE_CLAUDE: fake } });
  assert.strictEqual(r.code, 3, r.out);
  assert.match(r.out, /RUNNER STOPS: milestone .*M1 is complete and waiting for your testing/);
  // in runner mode the child session's Stop hook keeps the dangling-work guard and never nudges on
  addItem('K3', ['--milestone', 'M2']); forge(['config', 'set', 'options.autopilot', 'on']);
  assert.strictEqual(hook('stop', { session_id: 's' }).code, 0);                          // nothing in progress → nothing to say
  forge(['milestone', 'security', 'M1', '--agent', 'forge-reviewer', '--note', 'clean']); forge(['milestone', 'approve', 'M1', '--note', 'ok']);
  forge(['task', 'start', 'K3']);
  const h = hook('stop', { session_id: 's' });
  assert.strictEqual(h.code, 2); assert.match(h.out, /Open work items are still IN_PROGRESS: K3/); assert.doesNotMatch(h.out, /AUTOPILOT/);
  // a running orchestrator session refuses the runner
  forge(['autopilot', 'on']);
  hook('session-start', { session_id: 'live-session' });
  r = forge(['autopilot', 'run', '--dry-run']);
  assert.strictEqual(r.code, 0);                                                           // dry-run is allowed
  r = forge(['autopilot', 'run'], { env: { FORGE_CLAUDE: fake } });
  assert.notStrictEqual(r.code, 0); assert.match(r.out, /an orchestrator session is active/);
});

test('v0.22: usage attributes cost to tasks and rolls it up by Forge version, orchestrator model, milestone and total; task done stamps the version and model', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-logs-'));
  const projDir = path.join(root, dir.replace(/[^a-zA-Z0-9]/g, '-'));
  const subs = path.join(projDir, 'sess-main', 'subagents');
  fs.mkdirSync(subs, { recursive: true });
  addItem('U1', ['--milestone', 'M1']); addItem('U2', ['--milestone', 'M1', '--allowed', 'u2/']);
  const asstL = (t, out, model, id) => JSON.stringify({ type: 'assistant', timestamp: t, message: { id: id || ('m' + Math.random()), model: model || 'claude-opus-5-5', usage: { output_tokens: out, input_tokens: 10, cache_read_input_tokens: 1000 } } });
  const userL = (t, txt) => JSON.stringify({ type: 'user', timestamp: t, message: { content: txt } });
  hook('session-start', { session_id: 'sess-main' });                                    // the orchestrator session this test "is"
  // U1 runs 10:00 → 10:10; U2 10:20 → 10:30 (the start/pass timestamps come from the clock, so we
  // write the main transcript AFTER the items ran, around their real timestamps)
  forge(['task', 'start', 'U1']); touch('u1.txt'); forge(['task', 'verify', 'U1']);
  // one worker transcript for U1
  fs.writeFileSync(path.join(subs, 'w1.jsonl'), [userL(new Date().toISOString(), '# Work brief — U1: one'), asstL(new Date().toISOString(), 50, 'claude-sonnet-5-5'), asstL(new Date().toISOString(), 50, 'claude-sonnet-5-5')].join('\n') + '\n');
  // main transcript: 4 calls while U1 is in progress
  const now = () => new Date().toISOString();
  fs.writeFileSync(path.join(projDir, 'sess-main.jsonl'), [asstL(now(), 100), asstL(now(), 100), asstL(now(), 100), asstL(now(), 100)].join('\n') + '\n');
  forge(['usage'], { env: { FORGE_CLAUDE_PROJECTS: root } });                             // cache now knows sess-main's model
  let r = forge(['task', 'done', 'U1'], { env: { FORGE_CLAUDE_PROJECTS: root } });
  assert.strictEqual(r.code, 0, r.out);
  const w1 = JSON.parse(fs.readFileSync(path.join(dir, 'forge', 'state', 'work.json'), 'utf8'));
  assert.strictEqual(w1.items.U1.closed.model, 'claude-opus-5-5');
  assert.strictEqual(w1.items.U1.closed.session, 'sess-main');
  assert.ok(/^\d+\.\d+\.\d+$/.test(w1.items.U1.closed.forgeVersion));
  // U2: no worker transcript, 2 main calls
  forge(['task', 'start', 'U2']); touch('u2.txt'); forge(['task', 'verify', 'U2']);
  fs.appendFileSync(path.join(projDir, 'sess-main.jsonl'), [asstL(now(), 100), asstL(now(), 100)].join('\n') + '\n');
  forge(['task', 'done', 'U2'], { env: { FORGE_CLAUDE_PROJECTS: root } });
  r = forge(['usage'], { env: { FORGE_CLAUDE_PROJECTS: root } });
  assert.strictEqual(r.code, 0, r.out);
  assert.match(r.out, /## Per task, grouped/);
  assert.match(r.out, /By Forge version/);
  assert.match(r.out, new RegExp(w1.items.U1.closed.forgeVersion.replace(/\./g, '\\.') + '\\s+2 done · first-pass 100%'));
  assert.match(r.out, /claude-opus-5-5\s+2 done/);
  // a task closed without a stamp is grouped under the orchestrator model observed during its window
  const wo = JSON.parse(fs.readFileSync(path.join(dir, 'forge', 'state', 'work.json'), 'utf8'));
  delete wo.items.U1.closed; fs.writeFileSync(path.join(dir, 'forge', 'state', 'work.json'), JSON.stringify(wo));
  const r2 = forge(['usage'], { env: { FORGE_CLAUDE_PROJECTS: root } });
  assert.match(r2.out, /claude-opus-5-5 \(observed\)\s+1 done/);
  assert.match(r2.out, /claude-opus-5-5\s+1 done/);
  assert.match(r.out, /M1\s+2 done/);
  assert.match(r.out, /all\s+2 done/);
  // cost: U1 = 2 worker calls + 4 main; U2 = 2 main → 4 calls/task on average
  assert.match(r.out, /all\s+2 done · first-pass 100% ·\s+4 calls\/task/);
  const snap = JSON.parse(fs.readFileSync(path.join(dir, 'forge', 'state', 'usage.json'), 'utf8'));
  assert.strictEqual(snap.rollup.groups.total.all.items, 2);
  assert.strictEqual(Math.round(snap.rollup.groups.total.all.calls), 8);
  assert.strictEqual(Math.round(snap.rollup.groups.total.all.mainCalls), 6);
  const dash = fs.readFileSync(path.join(dir, 'forge', 'dashboard.html'), 'utf8');
  assert.match(dash, /Per task by Forge version/);
  assert.match(dash, /Per task by orchestrator model/);
  assert.match(dash, /Per task by milestone/);
});

test('v0.22.1: gate lanes — verify.* on every task, gate.* on --full, after a high-risk task, every Nth task and at the gate; approve needs the gate run; config unset', () => {
  const marker = path.join(dir, 'gate-ran.txt');
  forge(['config', 'set', 'gate.e2e', `node -e "require('fs').appendFileSync('${marker}','x')"`]);
  addItem('G1', ['--milestone', 'M1', '--allowed', 'g1/']); addItem('G2', ['--milestone', 'M1', '--allowed', 'g2/', '--deps', 'G1']);
  addItem('G3', ['--milestone', 'M1', '--allowed', 'g3/', '--deps', 'G2']); addItem('G4', ['--milestone', 'M1', '--allowed', 'g4/', '--deps', 'G3', '--domain', 'payments']);
  // G1: plain verify does not run the gate lane
  forge(['task', 'start', 'G1']); touch('g1.txt');
  let r = forge(['task', 'verify', 'G1']);
  assert.strictEqual(r.code, 0, r.out); assert.match(r.out, /gate lanes \(e2e\) run at the milestone gate/); assert.ok(!fs.existsSync(marker));
  forge(['task', 'done', 'G1']);
  // --full runs it and records why
  forge(['task', 'start', 'G2']); touch('g2.txt');
  r = forge(['task', 'verify', 'G2', '--full']);
  assert.match(r.out, /FULL \(gate lanes included: requested \(--full\)\)/); assert.strictEqual(fs.readFileSync(marker, 'utf8'), 'x');
  assert.strictEqual(work().items.G2.verifications[0].full, true);
  forge(['task', 'done', 'G2']);
  // every Nth task: N=1 → the next task's verify is full on its own
  forge(['config', 'set', 'options.fullVerifyEvery', '1']);
  forge(['task', 'start', 'G3']); touch('g3.txt');
  r = forge(['task', 'verify', 'G3']);
  assert.match(r.out, /FULL \(gate lanes included: 1 task\(s\) closed since the last full verification/); assert.strictEqual(fs.readFileSync(marker, 'utf8'), 'xx');
  forge(['task', 'done', 'G3']);
  forge(['config', 'unset', 'options.fullVerifyEvery']);
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(dir, 'forge', 'config.json'), 'utf8')).options.fullVerifyEvery, undefined);
  assert.notStrictEqual(forge(['config', 'unset', 'options.fullVerifyEvery']).code, 0);
  // high-risk task: full without asking
  forge(['task', 'start', 'G4']); touch('g4.txt');
  r = forge(['task', 'verify', 'G4']);
  assert.match(r.out, /FULL \(gate lanes included: high-risk task \(payments\)\)/); assert.strictEqual(fs.readFileSync(marker, 'utf8'), 'xxx');
  r = forge(['task', 'done', 'G4']);
  assert.match(r.out, /First the gate run — every lane over the finished slice: forge milestone verify M1/);
  // approve needs a passing gate run for the current tree
  forge(['milestone', 'security', 'M1', '--agent', 'forge-reviewer', '--note', 'clean']);
  r = forge(['milestone', 'approve', 'M1', '--note', 'ok']);
  assert.notStrictEqual(r.code, 0); assert.match(r.out, /no passing gate verification for the current tree/);
  r = forge(['milestone', 'verify', 'M1']);
  assert.strictEqual(r.code, 0, r.out); assert.match(r.out, /GATE VERIFY M1 — PASS 2\/2/); assert.strictEqual(fs.readFileSync(marker, 'utf8'), 'xxxx');
  assert.strictEqual(work().gates.M1.verify.passed, true);
  touch('late.txt');                                                                       // the tree moved: the run is stale
  r = forge(['milestone', 'approve', 'M1', '--note', 'ok']);
  assert.notStrictEqual(r.code, 0);
  forge(['milestone', 'verify', 'M1']);
  r = forge(['milestone', 'approve', 'M1', '--note', 'ok']);
  assert.strictEqual(r.code, 0, r.out);
  // a red gate lane names the situation and exits 1; --skip-gate needs a reason and is recorded
  addItem('H1', ['--milestone', 'M2', '--allowed', 'h1/']);
  forge(['config', 'set', 'gate.e2e', 'node -e "process.exit(1)"']);
  forge(['task', 'start', 'H1']); touch('h1.txt'); forge(['task', 'verify', 'H1']); forge(['task', 'done', 'H1']);
  r = forge(['milestone', 'verify', 'M2']);
  assert.strictEqual(r.code, 1); assert.match(r.out, /GATE VERIFY M2 — FAIL 1\/2/); assert.match(r.out, /regression somewhere in 'M2'/);
  forge(['milestone', 'security', 'M2', '--agent', 'forge-reviewer', '--note', 'clean']);
  assert.notStrictEqual(forge(['milestone', 'approve', 'M2', '--skip-gate']).code, 0);
  r = forge(['milestone', 'approve', 'M2', '--skip-gate', '--reason', 'known flake, tracked']);
  assert.strictEqual(r.code, 0, r.out);
  assert.match(fs.readFileSync(path.join(dir, 'forge', 'decisions.md'), 'utf8'), /GATE VERIFY SKIPPED: known flake, tracked/);
  // the baseline covers gate lanes but a plain verify does not compare them
  const failFile = path.join(dir, 'FAIL-E2E');
  forge(['config', 'set', 'gate.e2e', `node -e "process.exit(require('fs').existsSync('${failFile}')?1:0)"`]);
  r = forge(['baseline', 'capture']);
  assert.strictEqual(r.code, 0, r.out);
  const base = JSON.parse(fs.readFileSync(path.join(dir, 'forge', 'state', 'baseline.json'), 'utf8'));
  assert.ok(base.results.some(x => x.kind === 'e2e'));
  addItem('H2', ['--milestone', 'M3', '--allowed', 'h2/']);
  forge(['task', 'start', 'H2']); touch('h2.txt');
  r = forge(['task', 'verify', 'H2']);
  assert.strictEqual(r.code, 0, r.out); assert.doesNotMatch(r.out, /baseline:e2e/);
  r = forge(['task', 'verify', 'H2', '--full']);
  assert.match(r.out, /baseline:e2e/);
  // a verify where only a gate lane fails says it is a regression elsewhere
  fs.writeFileSync(failFile, '1');
  r = forge(['task', 'verify', 'H2', '--full']);
  assert.notStrictEqual(r.code, 0); assert.match(r.out, /only gate lane\(s\) failed \(gate:e2e, baseline:e2e\)/);
});

test('v0.22.1: red-first checks are capped — a slow criterion is recorded as not run, never as green, and does not weaken the done guard', () => {
  forge(['config', 'set', 'options.redFirstTimeoutSec', '1']);
  forge(['task', 'add', '--id', 'S1', '--title', 's', '--allowed', 'src/',
    '--criterion', 'fast::node -e "process.exit(0)"',
    '--criterion', 'slow::node -e "setTimeout(()=>process.exit(0),3000)"']);
  const t0 = Date.now();
  const r = forge(['task', 'start', 'S1']);
  assert.strictEqual(r.code, 0, r.out);
  assert.ok(Date.now() - t0 < 2500, 'start did not wait for the slow check');
  assert.match(r.out, /1 criterion check\(s\) ran past 1s at start and were cut/);
  assert.match(r.out, /- slow/);
  const ps = work().items.S1.preState;
  assert.strictEqual(ps[0].exit, 0); assert.strictEqual(ps[1].exit, null); assert.strictEqual(ps[1].timedOut, true);
  // the fast check was green before work and the tree is unchanged: done still refuses (the cut check adds no proof)
  forge(['config', 'set', 'options.redFirstTimeoutSec', '30']);
  forge(['task', 'verify', 'S1']);
  const d = forge(['task', 'done', 'S1']);
  assert.notStrictEqual(d.code, 0); assert.match(d.out, /already passed BEFORE work started/);
});

test('v0.22.1: the Stop hook is quiet when ANY in-progress task has a live worker, and a review dispatched about a task counts', () => {
  addItem('A', ['--milestone', 'M1', '--allowed', 'a/']); addItem('B', ['--milestone', 'M1', '--allowed', 'b/']);
  forge(['config', 'set', 'options.concurrency', '2']); forge(['autopilot', 'on']);
  forge(['task', 'start', 'A']); touch('a.txt'); forge(['task', 'verify', 'A']);           // A: verified, no worker now
  forge(['task', 'start', 'B']); forge(['task', 'dispatch', 'B', '--agent', 'forge-tester', '--model', 'sonnet']);
  let h = hook('stop', { session_id: 's' });
  assert.strictEqual(h.code, 0, h.out);                                                      // B's worker is live: A waits with it
  assert.match(fs.readFileSync(path.join(dir, 'forge', 'state', 'trace.jsonl'), 'utf8'), /"workers":\["B"\]/);
  touch('b.txt'); forge(['task', 'verify', 'B']);
  h = hook('stop', { session_id: 's' }); assert.strictEqual(h.code, 2);                     // nobody live: nudge
  forge(['dispatch', '--agent', 'forge-reviewer', '--purpose', 'review', '--item', 'A', '--model', 'sonnet']);
  h = hook('stop', { session_id: 's' }); assert.strictEqual(h.code, 0, h.out);              // the review about A is a live worker
  forge(['dashboard']);
  assert.match(fs.readFileSync(path.join(dir, 'forge', 'dashboard.html'), 'utf8'), /A<\/code> → forge-reviewer running/);
});

test('v0.22.1: CI on the milestone branch — session start reports a red run as the first thing to fix; ship refuses on it without a reason', () => {
  gitFlowProject();
  const { gh, log } = fakeGh();
  const script = fs.readFileSync(gh, 'utf8').replace('case "$1 $2" in', 'case "$1 $2" in\n  "run list") cat "$(dirname "$0")/runs.json" ;;');
  fs.writeFileSync(gh, script);
  const runs = path.join(path.dirname(gh), 'runs.json');
  fs.writeFileSync(runs, JSON.stringify([{ status: 'completed', conclusion: 'failure', headSha: 'abc1234def', url: 'https://github.com/acme/app/actions/runs/9', name: 'CI', createdAt: '2026-10-05T00:00:00Z' }]));
  addItem('A', ['--milestone', 'M1']);
  forge(['milestone', 'branch', 'M1']);
  forge(['task', 'start', 'A']); fs.writeFileSync(path.join(dir, 'src', 'a.js'), 'a'); forge(['task', 'verify', 'A']); forge(['task', 'done', 'A']);
  let h = hook('session-start', { session_id: 's9' });
  // the hook runs status as a child process: FORGE_GH must reach it
  const r0 = spawnSync(process.execPath, [CLI, 'hook', 'session-start'], { cwd: dir, encoding: 'utf8', input: '{"session_id":"s9"}', env: Object.assign({}, process.env, { CLAUDE_PROJECT_DIR: dir, FORGE_CLAUDE_PROJECTS: path.join(os.tmpdir(), 'forge-no-such-logs'), FORGE_GH: gh }) });
  assert.match(r0.stdout, /CI IS RED on milestone\/M1 \(failure, commit abc1234, https:\/\/github.com\/acme\/app\/actions\/runs\/9\)/);
  forge(['milestone', 'security', 'M1', '--agent', 'forge-reviewer', '--note', 'clean']);
  forge(['milestone', 'approve', 'M1', '--note', 'ok']);
  let r = forge(['milestone', 'ship', 'M1'], { env: { FORGE_GH: gh } });
  assert.notStrictEqual(r.code, 0); assert.match(r.out, /latest CI run on 'milestone\/M1' is failure/);
  fs.writeFileSync(runs, JSON.stringify([{ status: 'completed', conclusion: 'success', headSha: 'abc1234def', url: 'u', name: 'CI', createdAt: '2026-10-05T00:00:00Z' }]));
  r = forge(['milestone', 'ship', 'M1'], { env: { FORGE_GH: gh } });
  assert.strictEqual(r.code, 0, r.out); assert.match(r.out, /CI: success on milestone\/M1 \(abc1234\)/);
  assert.match(fs.readFileSync(log, 'utf8'), /run list --branch milestone\/M1/);
});

// --- v0.22.2 ---------------------------------------------------------------

test('v0.22.2: forge init starts every project with the verification tiers on, and merges the machine defaults file; config --global edits that file', () => {
  // a fresh init with no defaults file: the built-ins
  const c0 = JSON.parse(fs.readFileSync(path.join(dir, 'forge', 'config.json'), 'utf8'));
  assert.deepStrictEqual(c0.gate, {});
  assert.strictEqual(c0.options.fullVerifyEvery, 3);
  assert.strictEqual(c0.options.redFirstTimeoutSec, 120);
  assert.strictEqual(c0.options.slowLaneSec, 120);
  // the machine defaults file: written through config --global, options.* only
  const defs = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'forge-defs-')), 'cfg', 'forge', 'defaults.json');
  let r = forge(['config', 'set', 'options.concurrency', '2', '--global'], { env: { FORGE_DEFAULTS: defs } });
  assert.strictEqual(r.code, 0, r.out); assert.match(r.out, /every forge init on this machine starts with it/);
  r = forge(['config', 'set', 'options.models.explorer', 'claude-sonnet-5-5', '--global'], { env: { FORGE_DEFAULTS: defs } });
  assert.strictEqual(r.code, 0, r.out);
  r = forge(['config', 'set', 'verify.test', 'x', '--global'], { env: { FORGE_DEFAULTS: defs } });
  assert.notStrictEqual(r.code, 0); assert.match(r.out, /options\.\* keys only/);
  r = forge(['config', 'get', '--global'], { env: { FORGE_DEFAULTS: defs } });
  assert.match(r.out, /"concurrency": 2/); assert.match(r.out, /"explorer": "claude-sonnet-5-5"/);
  const saved = JSON.parse(fs.readFileSync(defs, 'utf8'));
  assert.strictEqual(saved.options.concurrency, 2);
  // a new project on this machine starts with them — merged over the built-ins, the rest of the model map intact
  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-test2-'));
  const r2 = spawnSync(process.execPath, [CLI, 'init', '--project', 'two'], { cwd: dir2, encoding: 'utf8', env: Object.assign({}, process.env, { CLAUDE_PROJECT_DIR: dir2, FORGE_DEFAULTS: defs }) });
  assert.strictEqual(r2.status, 0, r2.stdout + r2.stderr);
  assert.match(r2.stdout, /Applied your defaults from .*defaults\.json: concurrency, models\.explorer/);
  const c2 = JSON.parse(fs.readFileSync(path.join(dir2, 'forge', 'config.json'), 'utf8'));
  assert.strictEqual(c2.options.concurrency, 2);
  assert.strictEqual(c2.options.models.explorer, 'claude-sonnet-5-5');
  assert.strictEqual(c2.options.models.implementer, 'claude-sonnet-5-5');
  assert.strictEqual(c2.options.fullVerifyEvery, 3);
  // unset --global
  r = forge(['config', 'unset', 'options.concurrency', '--global'], { env: { FORGE_DEFAULTS: defs } });
  assert.strictEqual(r.code, 0, r.out);
  assert.strictEqual(JSON.parse(fs.readFileSync(defs, 'utf8')).options.concurrency, undefined);
  // doctor names the file
  r = forge(['doctor'], { env: { FORGE_DEFAULTS: defs } });
  assert.match(r.out, /machine defaults: .*defaults\.json · models/);
});

test('v0.22.2: a slow verify.* lane is reported as a gate-tier candidate by preflight, doctor and the verify-tiers upgrade step — with the exact move; fixed once moved', () => {
  // the fixture's verify.test takes a few ms; a 10 ms limit makes it "slow" without waiting
  forge(['config', 'set', 'options.slowLaneSec', '0.01']);
  forge(['config', 'set', 'verify.e2e', 'node -e "process.exit(0)"']);       // named like a slow suite, no run yet
  // no recorded run of verify.test yet → not reported by timing; e2e is reported by name
  let r = forge(['upgrade']);
  assert.match(r.out, /verify-tiers/);
  assert.match(r.out, /verify\.e2e is named like a slow suite and has no recorded run yet/);
  assert.ok(!/verify\.test averages/.test(r.out), r.out);
  // one verification records ms per lane
  addItem('S1'); forge(['task', 'start', 'S1']); touch('s1.txt');
  r = forge(['task', 'verify', 'S1']); assert.strictEqual(r.code, 0, r.out);
  const v = work().items.S1.verifications[0];
  assert.ok(v.results.find(x => x.kind === 'project:test').ms > 0);
  r = forge(['preflight']);
  assert.match(r.out, /WARN  verification tiers: .*verify\.test averages \d+ s over its last 1 run\(s\) \(limit options\.slowLaneSec 0\.01\) — it runs on every task: forge config set gate\.test "node -e \\"process\.exit\(0\)\\"" && forge config unset verify\.test/);
  r = forge(['doctor']);
  assert.match(r.out, /verification tiers: .*verify\.test averages/);
  r = forge(['upgrade']);
  assert.match(r.out, /verify\.test averages/);
  // the move, as printed: both lanes to gate.*; the step closes
  forge(['config', 'set', 'gate.test', 'node -e "process.exit(0)"']); forge(['config', 'unset', 'verify.test']);
  forge(['config', 'set', 'gate.e2e', 'node -e "process.exit(0)"']); forge(['config', 'unset', 'verify.e2e']);
  forge(['config', 'set', 'verify.lint', 'node -e "process.exit(0)"']);
  forge(['config', 'set', 'options.slowLaneSec', '120']);
  r = forge(['upgrade']);
  assert.ok(!/verify-tiers.*\n.*averages/.test(r.out), r.out);
  const st = JSON.parse(forge(['upgrade', '--json']).out).steps;
  const step = st.find(x => x.id === 'verify-tiers');
  assert.strictEqual(step.done, true, JSON.stringify(step));
  // gate.* without a periodic full run is a finding too
  forge(['config', 'unset', 'options.fullVerifyEvery']);
  const st2 = JSON.parse(forge(['upgrade', '--json']).out).steps.find(x => x.id === 'verify-tiers');
  assert.strictEqual(st2.done, false); assert.match(st2.findings[0], /options\.fullVerifyEvery is 0/);
  r = forge(['preflight']);
  assert.match(r.out, /OK    verification tiers: verify\.\* fast \(lint\) · gate\.\* at the milestone \(test, e2e\) only — set options\.fullVerifyEvery 3/);
  // the Configuration page lists the gate lanes
  const dash = fs.readFileSync(path.join(dir, 'forge', 'dashboard.html'), 'utf8');
  assert.match(dash, /<b>e2e<\/b> <code>node -e "process\.exit\(0\)"<\/code>/);
});

test('v0.22.2: the Usage page has a scope selector — the token table and the per-item strip per milestone, from attributed transcripts only; what fell between tasks is reported, not spread', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-logs-'));
  const projDir = path.join(root, dir.replace(/[^a-zA-Z0-9]/g, '-'));
  const subs = path.join(projDir, 'sess-main', 'subagents');
  fs.mkdirSync(subs, { recursive: true });
  addItem('U1', ['--milestone', 'M1']); addItem('U2', ['--milestone', 'M2', '--allowed', 'u2/']);
  forge(['milestone', 'update', 'M1', '--name', 'Cart']);
  forge(['config', 'set', 'options.gates', 'end-only']);   // M2 may start before M1 is approved
  const asstL = (t, out, model, extra) => JSON.stringify(Object.assign({ type: 'assistant', timestamp: t, message: { id: 'm' + Math.random(), model, usage: { output_tokens: out, input_tokens: 10, cache_read_input_tokens: 1000 } } }, extra || {}));
  const userL = (t, txt) => JSON.stringify({ type: 'user', timestamp: t, message: { content: txt } });
  const now = () => new Date().toISOString();
  hook('session-start', { session_id: 'sess-main' });
  // two orchestrator calls BEFORE any task: between-tasks work, outside every milestone
  fs.writeFileSync(path.join(projDir, 'sess-main.jsonl'), [asstL(now(), 7, 'claude-opus-5-5'), asstL(now(), 7, 'claude-opus-5-5')].join('\n') + '\n');
  sleepSync(20);
  forge(['task', 'start', 'U1']); touch('u1.txt'); forge(['task', 'verify', 'U1']);
  // U1: one worker transcript (sonnet, 2 calls, 100 out), dispatched as forge-implementer; 3 orchestrator calls while it ran
  fs.writeFileSync(path.join(subs, 'w1.jsonl'), [userL(now(), '# Work brief — U1: one'), asstL(now(), 60, 'claude-sonnet-5-5'), asstL(now(), 40, 'claude-sonnet-5-5')].join('\n') + '\n');
  fs.appendFileSync(path.join(projDir, 'sess-main.jsonl'), [
    asstL(now(), 100, 'claude-opus-5-5', { message: { id: 'd1', model: 'claude-opus-5-5', usage: { output_tokens: 100, input_tokens: 10, cache_read_input_tokens: 1000 }, content: [{ type: 'tool_use', name: 'Agent', input: { subagent_type: 'forge:forge-implementer', prompt: '# Work brief — U1: one' } }] } }),
    asstL(now(), 100, 'claude-opus-5-5'), asstL(now(), 100, 'claude-opus-5-5')].join('\n') + '\n');
  forge(['task', 'done', 'U1'], { env: { FORGE_CLAUDE_PROJECTS: root } });
  // U2 (M2): no worker, one orchestrator call, left in progress
  forge(['task', 'start', 'U2']); touch('u2.txt');
  fs.appendFileSync(path.join(projDir, 'sess-main.jsonl'), asstL(now(), 5, 'claude-opus-5-5') + '\n');
  const r = forge(['usage'], { env: { FORGE_CLAUDE_PROJECTS: root } });
  assert.strictEqual(r.code, 0, r.out);
  const snap = JSON.parse(fs.readFileSync(path.join(dir, 'forge', 'state', 'usage.json'), 'utf8'));
  const BM = snap.byMilestone;
  assert.ok(BM && BM.groups.M1 && BM.groups.M2, JSON.stringify(Object.keys(BM.groups)));
  const m1 = BM.groups.M1;
  assert.strictEqual(m1.sideCalls, 2); assert.strictEqual(m1.sideOut, 100);
  assert.strictEqual(Math.round(m1.mainCalls), 3); assert.strictEqual(Math.round(m1.mainOut), 300);
  assert.strictEqual(m1.models['claude-sonnet-5-5'].side.calls, 2);
  assert.strictEqual(m1.models['claude-sonnet-5-5'].side.ctx, 2 * 1010);
  assert.strictEqual(Math.round(m1.models['claude-opus-5-5'].main.calls), 3);
  assert.strictEqual(m1.models['claude-sonnet-5-5'].main, undefined);
  assert.deepStrictEqual(m1.byType, { 'forge:forge-implementer': 1 });
  assert.strictEqual(m1.done, 1); assert.strictEqual(m1.items, 1);
  assert.strictEqual(Math.round(m1.perDone.calls), 5);
  assert.strictEqual(m1.callsPerDispatch.median, 2);
  assert.strictEqual(Math.round(BM.groups.M2.mainCalls), 1); assert.strictEqual(BM.groups.M2.perDone, null);
  assert.strictEqual(BM.outside.mainCalls, 2);
  // the dashboard: a selector, one hidden view per milestone, the per-milestone rollup rows tagged for highlighting
  const dash = fs.readFileSync(path.join(dir, 'forge', 'dashboard.html'), 'utf8');
  assert.match(dash, /<select id="usms"><option value="all">Whole project<\/option><option value="M1">M1 — Cart<\/option><option value="M2">M2<\/option><\/select>/);
  assert.match(dash, /Outside every milestone: 2 orchestrator call\(s\) between tasks/);
  const vM1 = dash.slice(dash.indexOf('<div class="usview" data-ms="M1" hidden>'), dash.indexOf('<div class="usview" data-ms="M2" hidden>'));
  assert.ok(vM1.length > 0, 'M1 view rendered');
  assert.match(vM1, /observed, milestone M1 — Cart, snapshot as of/);
  assert.match(vM1, /<code>claude-sonnet-5-5<\/code> <span class="mut">workers · 2 call\(s\)<\/span><\/span><b>100<\/b><span class="n">out · 20 in · 2k context<\/span>/);
  assert.match(vM1, /<code>claude-opus-5-5<\/code> <span class="mut">orchestrator · 3 call\(s\)<\/span><\/span><b>300<\/b>/);
  assert.match(vM1, /1\/1 task\(s\) of this milestone done\./);
  assert.match(vM1, /CONTEXT RE-READ PER DONE ITEM/);
  assert.match(vM1, /Attributed to this milestone's tasks only/);
  const vM2 = dash.slice(dash.indexOf('<div class="usview" data-ms="M2" hidden>'), dash.indexOf('Per task by Forge version'));
  assert.match(vM2, /No task of this milestone is DONE yet/);
  assert.match(dash, /<tr data-ms="M1"><td><code>M1<\/code>/);
  // the whole-project view is unchanged in substance and shown first
  assert.match(dash, /<div class="usview" data-ms="all"><div class="telgrid one"><div class="panel"><h3>Tokens <span class="mut">— observed, snapshot as of/);
  assert.match(dash, /forge\.usage\.scope/);
});
