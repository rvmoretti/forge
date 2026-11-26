'use strict';
/**
 * v0.32 — what the cockpit boards read from `forge status --json` (the Gate board, what happened, how long a
 * running check usually takes), autopilot putting the active milestone first, and the full run at hand-over
 * with options.gates end-only.
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
function forge(args) { const r = spawnSync(process.execPath, [CLI, ...args], { cwd: dir, encoding: 'utf8', input: '', env: env() }); return { code: r.status, out: (r.stdout || '') + (r.stderr || ''), stdout: r.stdout || '' }; }
function ok(args) { const r = forge(args); assert.strictEqual(r.code, 0, `${args.join(' ')}\n${r.out}`); return r; }
const snap = () => JSON.parse(ok(['status', '--json']).stdout);
function write(rel, text) { const f = path.join(dir, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); }
function g(...args) { return spawnSync('git', args, { cwd: dir, encoding: 'utf8' }); }
function waitFor(fn, ms = 30000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = fn(); if (v) return v; Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200); } return null; }

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-v032-'));
  cnt = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'forge-v032-cnt-')), 'runs');
  g('init', '-q'); g('config', 'user.email', 't@t'); g('config', 'user.name', 't');
  write('src/a.js', 'module.exports = 1;\n'); g('add', '-A'); g('commit', '-qm', 'base');
  forge(['init', '--project', 'test']);
  forge(['config', 'set', 'phase', 'build']);
  forge(['config', 'set', 'options.graphify', 'skip']);
  forge(['config', 'set', 'options.integration', 'manual', '--reason', 'test fixture']);
  const cf = path.join(dir, 'forge', 'config.json');
  const c = JSON.parse(fs.readFileSync(cf, 'utf8'));
  delete c.defaults; delete c.profile; c.verify = {};
  c.options = Object.assign({}, c.options, { concurrency: 4, briefCheck: 'off', security: 'off', gates: 'end-only' });
  fs.writeFileSync(cf, JSON.stringify(c, null, 2));
});
const crit = ['--criterion', 'ok::node -e "process.exit(0)"'];

test('status --json carries what happened in plain words, the milestone name and the Gate board', () => {
  ok(['config', 'set', 'gate.e2e', 'node -e "process.exit(1)"']);
  ok(['milestone', 'add', 'm1', '--name', 'Customers can pay']);
  ok(['task', 'add', '--id', 'A', '--title', 'Cart', '--milestone', 'm1', ...crit, '--allowed', 'src/']);
  ok(['task', 'start', 'A']); write('src/a.js', 'module.exports = 2;\n');
  ok(['task', 'verify', 'A']); ok(['task', 'done', 'A']);
  let s = snap();
  assert.strictEqual(s.schema, 2);
  assert.deepStrictEqual(s.recent.map(e => e.text).slice(-4), ['task A added', 'A started', 'A passed its checks', 'A closed']);
  assert.ok(s.recent.every(e => e.ts && e.tone));
  assert.deepStrictEqual([s.gate.milestone, s.gate.name, s.gate.done, s.gate.total, s.gate.complete, s.gate.fullRun.state], ['m1', 'Customers can pay', 1, 1, true, 'none']);
  assert.notStrictEqual(forge(['milestone', 'verify', 'm1']).code, 0);
  s = snap();
  assert.deepStrictEqual([s.gate.fullRun.state, s.gate.fullRun.failed], ['red', ['gate:e2e']]);
  assert.strictEqual(s.recent.pop().text, 'full test run of m1 failed');
});

test('a running check carries how long it took last time (the progress bar)', () => {
  ok(['milestone', 'add', 'm1', '--name', 'One']);
  ok(['task', 'add', '--id', 'A', '--title', 'Cart', '--milestone', 'm1', ...crit, '--allowed', 'src/']);
  ok(['config', 'set', 'verify.unit', 'node -e "setTimeout(()=>{},300)"']);
  ok(['task', 'start', 'A']); ok(['task', 'verify', 'A']);
  write('forge/state/verify.lock', JSON.stringify({ item: 'A', pid: process.pid, ts: new Date().toISOString() }));
  const v = snap().verify;
  assert.strictEqual(v.item, 'A');
  assert.ok(v.expectedMs >= 250, JSON.stringify(v));
});

test('autopilot takes a thin task of the active milestone before a ready task of a later one, and says why it stops', () => {
  ok(['milestone', 'add', 'm1', '--name', 'One']); ok(['milestone', 'add', 'm2', '--name', 'Two']);
  ok(['task', 'add', '--id', 'A', '--title', 'Needs scope', '--milestone', 'm1']);
  ok(['task', 'add', '--id', 'B', '--title', 'Ready', '--milestone', 'm2', ...crit, '--allowed', 'lib/']);
  ok(['autopilot', 'on']);
  let s = snap();
  assert.deepStrictEqual([s.autopilot.next, s.autopilot.stop], ['A', null]);
  ok(['task', 'update', 'A', ...crit.map(x => x === '--criterion' ? '--criterion-add' : x), '--allowed', 'src/', '--reason', 'test']);
  ok(['task', 'update', 'A', '--deps', 'B', '--reason', 'test']);
  s = snap();
  assert.strictEqual(s.autopilot.stop.kind, 'boundary');
  assert.match(s.autopilot.stop.reason, /^m1 has 1 task\(s\) that cannot start yet \(1 waiting on B\); the next task that can, .*B.*, is in milestone m2$/);
});

test('with options.gates end-only, the full run still starts in the background when the last task closes', () => {
  for (const [k, v] of [['gateAt', 'ship']]) ok(['config', 'set', `options.${k}`, v]);
  ok(['config', 'set', 'gate.e2e', `node -e "require('fs').appendFileSync(process.env.FORGE_T_CNT,'e2e\\n')"`]);
  ok(['milestone', 'add', 'm1', '--name', 'One']);
  ok(['task', 'add', '--id', 'A', '--title', 'Cart', '--milestone', 'm1', ...crit, '--allowed', 'src/']);
  ok(['task', 'start', 'A']); write('src/a.js', 'module.exports = 2;\n'); ok(['task', 'verify', 'A']);
  const d = ok(['task', 'done', 'A']);
  assert.match(d.out, /The full test run of 'm1' started in the background/);
  const gv = waitFor(() => { const s = snap(); return s.gate && s.gate.fullRun && s.gate.fullRun.state === 'green' ? s.gate : null; });
  assert.ok(gv, 'the background run finished green');
});
