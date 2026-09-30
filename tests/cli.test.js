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
      { CLAUDE_PROJECT_DIR: dir, FORGE_CLAUDE_PROJECTS: path.join(os.tmpdir(), 'forge-no-such-logs') },
      opts.env || {})
  });
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
}
function hook(name, stdinObj) {
  const r = spawnSync(process.execPath, [CLI, 'hook', name], {
    cwd: dir, encoding: 'utf8', input: JSON.stringify(stdinObj || {}),
    env: Object.assign({}, process.env,
      { CLAUDE_PROJECT_DIR: dir, FORGE_CLAUDE_PROJECTS: path.join(os.tmpdir(), 'forge-no-such-logs') })
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
}
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

test('second in-flight item refused at default cap 1; cap 2 allows disjoint scopes, refuses overlap', () => {
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
