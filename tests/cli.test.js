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
    env: Object.assign({}, process.env, { CLAUDE_PROJECT_DIR: dir })
  });
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
}
function hook(name, stdinObj) {
  const r = spawnSync(process.execPath, [CLI, 'hook', name], {
    cwd: dir, encoding: 'utf8', input: JSON.stringify(stdinObj || {}),
    env: Object.assign({}, process.env, { CLAUDE_PROJECT_DIR: dir })
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
  return forge(['task', 'add', '--id', id, '--title', id, '--criterion', 'ok::node -e "process.exit(0)"', ...extra]);
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
         '--forbidden', 'src/gen/,schemas/events.json']);
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
  forge(['task', 'add', '--id', 'T1', '--title', 't', '--criterion', 'ok::node -e "process.exit(0)"', '--milestone', 'M1']);
  forge(['task', 'add', '--id', 'T2', '--title', 't', '--criterion', 'ok::node -e "process.exit(0)"', '--milestone', 'M1']);
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
