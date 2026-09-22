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

test('components register, auto-register from --component, and render in the dashboard map', () => {
  forge(['component', 'add', 'listing-detail', '--name', 'Listing detail', '--kind', 'frontend', '--route', '/anuncios/:id']);
  const dup = forge(['component', 'add', 'listing-detail']);
  assert.notStrictEqual(dup.code, 0);
  forge(['task', 'add', '--id', 'T1', '--title', 't', '--criterion', 'ok::node -e "process.exit(0)"', '--component', 'listing-detail']);
  forge(['task', 'add', '--id', 'T2', '--title', 't', '--criterion', 'ok::node -e "process.exit(0)"', '--component', 'api-core']); // auto-registers
  const list = forge(['component', 'list']);
  assert.match(list.out, /listing-detail \(frontend · \/anuncios\/:id\) — 0\/1 items done/);
  assert.match(list.out, /api-core \(unspecified\)/);
  const dash = fs.readFileSync(path.join(dir, 'forge', 'dashboard.html'), 'utf8');
  assert.match(dash, /Project map/);
  assert.match(dash, /Listing detail/);
  assert.match(dash, /api-core/);
  assert.doesNotMatch(dash, /not tagged to any component/); // every item is tagged here
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
  // dashboard is collapsible
  const dash = fs.readFileSync(path.join(dir, 'forge', 'dashboard.html'), 'utf8');
  assert.match(dash, /<details class="sec"/);
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
  assert.match(dash, /next touched: <b>M1<\/b>/);     // component box next-touch
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
  assert.match(dash, /class="mapgrid"/);                 // project map is a grid of component cards
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
