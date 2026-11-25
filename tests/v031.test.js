'use strict';
/**
 * v0.31 — the testing budget: a task closes on its own checks (quick lanes at once), one re-run for a flaky check,
 * the milestone's one full run in the background while the owner reviews, ship (not approve) needs it green,
 * a red full run re-runs only what failed.
 *   npm test
 */
const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const CLI = path.resolve(__dirname, '..', 'plugins', 'forge', 'bin', 'forge.js');
let dir, cnt;
const env = () => Object.assign({}, process.env, { CLAUDE_PROJECT_DIR: dir, FORGE_CLAUDE_PROJECTS: path.join(os.tmpdir(), 'forge-no-such-logs'), FORGE_DEFAULTS: path.join(os.tmpdir(), 'forge-no-such-defaults.json'), FORGE_T_CNT: cnt });
function forge(args) { const r = spawnSync(process.execPath, [CLI, ...args], { cwd: dir, encoding: 'utf8', input: '', env: env() }); return { code: r.status, out: (r.stdout || '') + (r.stderr || '') }; }
function ok(args) { const r = forge(args); assert.strictEqual(r.code, 0, `${args.join(' ')}\n${r.out}`); return r; }
function work() { return JSON.parse(fs.readFileSync(path.join(dir, 'forge', 'state', 'work.json'), 'utf8')); }
function write(rel, text) { const f = path.join(dir, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); }
function g(...args) { return spawnSync('git', args, { cwd: dir, encoding: 'utf8' }); }
const runs = (tag) => { try { return fs.readFileSync(cnt, 'utf8').split('\n').filter(l => l === tag).length; } catch (_) { return 0; } };
const counter = (tag) => `node -e "require('fs').appendFileSync(process.env.FORGE_T_CNT,'${tag}\\n')"`;
// fails the first time it runs, passes after (a marker file next to the counter)
const flakyOnce = (tag) => `node -e "const f=process.env.FORGE_T_CNT+'.${tag}';const fs=require('fs');if(fs.existsSync(f))process.exit(0);fs.writeFileSync(f,'x');process.exit(1)"`;
const sleepMs = (ms) => `node -e "setTimeout(()=>{},${ms})"`;
function waitFor(fn, ms = 30000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = fn(); if (v) return v; Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200); } return null; }

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-v031-'));
  cnt = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'forge-v031-cnt-')), 'runs');
  g('init', '-q'); g('config', 'user.email', 't@t'); g('config', 'user.name', 't');
  write('src/a.js', 'module.exports = 1;\n'); g('add', '-A'); g('commit', '-qm', 'base');
  forge(['init', '--project', 'test']);
  forge(['config', 'set', 'phase', 'build']);
  forge(['config', 'set', 'options.graphify', 'skip']);
  forge(['config', 'set', 'options.integration', 'manual', '--reason', 'test fixture']);
  const cf = path.join(dir, 'forge', 'config.json');
  const c = JSON.parse(fs.readFileSync(cf, 'utf8'));
  delete c.defaults; delete c.profile; c.verify = {};
  c.options = Object.assign({}, c.options, { concurrency: 4, briefCheck: 'off', security: 'off' });
  fs.writeFileSync(cf, JSON.stringify(c, null, 2));
});
function budget() { for (const [k, v] of [['gateAt', 'ship'], ['parallelChecks', 'on'], ['flakyRerun', 'on']]) ok(['config', 'set', `options.${k}`, v]); }
function milestoneWithTask(id = 'A') {
  ok(['milestone', 'add', 'm1', '--name', 'One']);
  ok(['task', 'add', '--id', id, '--title', `Task ${id}`, '--milestone', 'm1', '--criterion', 'ok::node -e "process.exit(0)"', '--allowed', 'src/']);
  ok(['task', 'start', id]);
  write('src/a.js', 'module.exports = 2;\n');
}

test('a new project starts with the testing budget', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-v031-new-'));
  spawnSync('git', ['init', '-q'], { cwd: d });
  const e = Object.assign(env(), { CLAUDE_PROJECT_DIR: d });
  spawnSync(process.execPath, [CLI, 'init', '--project', 'x'], { cwd: d, encoding: 'utf8', env: e });
  const get = k => JSON.parse(spawnSync(process.execPath, [CLI, 'config', 'get', `options.${k}`], { cwd: d, encoding: 'utf8', env: e }).stdout);
  assert.deepStrictEqual(['gateAt', 'gateAuto', 'parallelChecks', 'flakyRerun', 'fullVerifyEvery', 'fullVerifyHighRisk'].map(get), ['ship', 'on', 'on', 'on', 0, false]);
});

test('the quick lanes run at once: a verify waits for the slowest, not the sum', () => {
  budget();
  for (const k of ['a', 'b', 'c']) ok(['config', 'set', `verify.${k}`, sleepMs(1500)]);
  milestoneWithTask();
  ok(['task', 'verify', 'A']);
  const v = work().items.A.verifications.pop();
  assert.ok(v.results.filter(r => r.kind.startsWith('project:')).every(r => r.parallel && r.ms >= 1400), JSON.stringify(v.results));
  assert.ok(v.wallMs < 4000, `wall ${v.wallMs} ms for three 1.5 s lanes`);
  ok(['config', 'set', 'verify.bad', 'node -e "console.log(\'boom\');process.exit(3)"']);
  const r = forge(['task', 'verify', 'A']);
  assert.notStrictEqual(r.code, 0);
  assert.match(r.out, /✗ project:bad — exit 3[\s\S]*boom/);
});

test('a check that fails and passes on one re-run is recorded as flaky; with the switch off it fails', () => {
  budget();
  milestoneWithTask();
  ok(['task', 'update', 'A', '--criterion-add', `load::${flakyOnce('crit')}`, '--reason', 'test']);
  try { fs.unlinkSync(cnt + '.crit'); } catch (_) { }
  const v = ok(['task', 'verify', 'A']);
  assert.match(v.out, /passed only on a re-run — recorded as flaky/);
  assert.ok(work().items.A.verifications.pop().results.find(r => r.kind === 'criterion: load').flaky);
  ok(['config', 'set', 'options.flakyRerun', 'off']);
  fs.unlinkSync(cnt + '.crit');
  assert.notStrictEqual(forge(['task', 'verify', 'A']).code, 0);
});

test('the full run starts by itself in the background at hand-over; approve does not need it, ship does', () => {
  budget();
  ok(['config', 'set', 'verify.unit', counter('unit')]);
  ok(['config', 'set', 'gate.e2e', `${sleepMs(1500)} && ${counter('e2e')}`]);
  milestoneWithTask();
  ok(['task', 'verify', 'A']);
  const d = ok(['task', 'done', 'A']);
  assert.match(d.out, /The full run started in the background \(pid \d+, log forge\/state\/gate-m1\.log\)/);
  assert.doesNotMatch(d.out, /approve refuses without it/);
  // the owner reviews meanwhile: approve does not wait for the run
  ok(['milestone', 'approve', 'm1', '--note', 'looks good']);
  const gv = waitFor(() => { const v = (work().gates.m1 || {}).verify; return v && v.ts ? v : null; });
  assert.ok(gv && gv.passed && gv.background, JSON.stringify(gv));
  assert.strictEqual(runs('e2e'), 1);
  assert.match(fs.readFileSync(path.join(dir, 'forge', 'state', 'gate-m1.log'), 'utf8'), /GATE VERIFY m1 — PASS/);
});

test('a red full run re-runs only what failed, and that pass counts', () => {
  budget();
  ok(['config', 'set', 'verify.unit', counter('unit')]);
  ok(['config', 'set', 'gate.db', counter('db')]);
  ok(['config', 'set', 'gate.e2e', flakyOnce('e2e')]);
  ok(['config', 'set', 'options.gateAuto', 'off']);
  milestoneWithTask();
  ok(['task', 'verify', 'A']); ok(['task', 'done', 'A']);
  assert.strictEqual(runs('unit'), 1);
  assert.notStrictEqual(forge(['milestone', 'verify', 'm1']).code, 0);
  assert.deepStrictEqual([runs('unit'), runs('db')], [1, 1], 'unit passed on this code in the task verify: not run again');
  const again = ok(['milestone', 'verify', 'm1']);
  assert.match(again.out, /re-run of what failed counts as the full run/);
  assert.deepStrictEqual([runs('unit'), runs('db')], [1, 1], 'only the failed lane ran');
  const gv = work().gates.m1.verify;
  assert.ok(gv.passed && gv.retry && gv.results.length === 1 && gv.results[0].kind === 'gate:e2e');
});

test('done refuses while the task\'s verify is still running, and says why', () => {
  milestoneWithTask();
  write('forge/state/verify.lock', JSON.stringify({ item: 'A', pid: process.pid, ts: new Date().toISOString() }));
  const d = forge(['task', 'done', 'A']);
  assert.notStrictEqual(d.code, 0);
  assert.match(d.out, /the verify of 'A' is still running .* brief or dispatch the next task meanwhile/);
});

test('the worker\'s brief: affected unit tests and one re-run for a flaky test', () => {
  budget();
  write('package.json', JSON.stringify({ name: 'x', scripts: { test: 'vitest run' } }));
  ok(['config', 'set', 'verify.unit', 'npm test']);
  ok(['config', 'set', 'gate.e2e', 'true']);
  ok(['config', 'set', 'options.affectedTests', 'on']);
  milestoneWithTask();
  const b = ok(['brief', 'A']).out;
  assert.match(b, /The unit tests your change affects: `npx vitest related --run --passWithNoTests <the files you changed>`/);
  assert.match(b, /fails only under load .* run it once more; if it passes, report it as flaky/);
});
