'use strict';
/**
 * v0.30 — tests run when they can find something, never again on the same code: evidence by content,
 * results reused on identical code, affected-only fast lanes between full runs, task pushes that do not
 * start CI, and the e2e harness notes.
 *   npm test
 */
const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const CLI = path.resolve(__dirname, '..', 'plugins', 'forge', 'bin', 'forge.js');
let dir, cnt, extraEnv;
function forge(args) {
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd: dir, encoding: 'utf8', input: '',
    env: Object.assign({}, process.env, { CLAUDE_PROJECT_DIR: dir, FORGE_CLAUDE_PROJECTS: path.join(os.tmpdir(), 'forge-no-such-logs'), FORGE_DEFAULTS: path.join(os.tmpdir(), 'forge-no-such-defaults.json') }, extraEnv) });
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
}
function ok(args) { const r = forge(args); assert.strictEqual(r.code, 0, `${args.join(' ')}\n${r.out}`); return r; }
function work() { return JSON.parse(fs.readFileSync(path.join(dir, 'forge', 'state', 'work.json'), 'utf8')); }
function write(rel, text) { const f = path.join(dir, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); }
function g(...args) { return spawnSync('git', args, { cwd: dir, encoding: 'utf8' }); }
const runs = (tag) => { try { return fs.readFileSync(cnt, 'utf8').split('\n').filter(l => l === tag).length; } catch (_) { return 0; } };
// a command that counts its runs in a file outside the project (so running it changes no code)
const counter = (tag) => `node -e "require('fs').appendFileSync(process.env.FORGE_T_CNT,'${tag}\\n')"`;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-v030-'));
  cnt = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'forge-v030-cnt-')), 'runs');
  extraEnv = { FORGE_T_CNT: cnt };
  g('init', '-q'); g('config', 'user.email', 't@t'); g('config', 'user.name', 't');
  write('src/a.js', 'module.exports = 1;\n');
  g('add', '-A'); g('commit', '-qm', 'base');
  forge(['init', '--project', 'test']);
  forge(['config', 'set', 'phase', 'build']);
  forge(['config', 'set', 'options.graphify', 'skip']);
  forge(['config', 'set', 'options.integration', 'manual', '--reason', 'test fixture']);
  const cf = path.join(dir, 'forge', 'config.json');
  const c = JSON.parse(fs.readFileSync(cf, 'utf8'));
  delete c.defaults; delete c.profile; c.verify = {};
  c.options = Object.assign({}, c.options, { concurrency: 4, briefCheck: 'off' });
  fs.writeFileSync(cf, JSON.stringify(c, null, 2));
});
function task(id, extra = []) { ok(['task', 'add', '--id', id, '--title', `Task ${id}`, '--criterion', 'ok::node -e "process.exit(0)"', '--allowed', 'src/', ...extra]); }

test('done sees a second edit of an already-changed file: evidence is about content, not the file list', () => {
  task('A'); ok(['task', 'start', 'A']);
  write('src/a.js', 'module.exports = 2;\n');
  ok(['task', 'verify', 'A']);
  write('src/a.js', 'module.exports = 3;\n'); // same `git status` line as before
  const d = forge(['task', 'done', 'A']);
  assert.notStrictEqual(d.code, 0);
  assert.match(d.out, /tree changed since the passing verification/);
  ok(['task', 'verify', 'A']);
  ok(['task', 'done', 'A']);
});

test('a check that passed on the same code is not run again; --fresh runs it; a run that changed the code does not count', () => {
  ok(['config', 'set', 'verify.unit', counter('unit')]);
  ok(['config', 'set', 'verify.gen', 'node -e "require(\'fs\').appendFileSync(\'src/gen.js\',\'//x\\n\')"']);
  task('A'); ok(['task', 'start', 'A']);
  write('src/a.js', 'module.exports = 2;\n');
  ok(['task', 'verify', 'A']);
  const again = ok(['task', 'verify', 'A']);
  // gen changed the code during the first run, so nothing from it counts as "same code" … the second run is the first clean one
  assert.strictEqual(runs('unit'), 2);
  ok(['config', 'unset', 'verify.gen']);
  ok(['task', 'verify', 'A']);
  const third = ok(['task', 'verify', 'A']);
  assert.strictEqual(runs('unit'), 3, third.out);
  assert.match(third.out, /not run again/);
  assert.ok(work().items.A.verifications.pop().results.find(r => r.kind === 'project:unit').reused);
  ok(['task', 'verify', 'A', '--fresh']);
  assert.strictEqual(runs('unit'), 4);
  write('src/a.js', 'module.exports = 4;\n');
  ok(['task', 'verify', 'A']);
  assert.strictEqual(runs('unit'), 5, 'new code runs again');
  assert.ok(again);
});

test('the milestone gate right after the last task\'s full verify does not re-run the suite on the same code', () => {
  ok(['config', 'set', 'verify.unit', counter('unit')]);
  ok(['config', 'set', 'gate.e2e', counter('e2e')]);
  ok(['milestone', 'add', 'm1', '--name', 'One']);
  task('A', ['--milestone', 'm1']); ok(['task', 'start', 'A']);
  write('src/a.js', 'module.exports = 2;\n');
  ok(['task', 'verify', 'A', '--full', '--reason', 'test']);
  ok(['task', 'done', 'A']);
  assert.strictEqual(runs('e2e'), 1);
  const gv = ok(['milestone', 'verify', 'm1']);
  assert.match(gv.out, /GATE VERIFY m1 — PASS .* 2 not run again/);
  assert.strictEqual(runs('e2e'), 1);
  assert.strictEqual(runs('unit'), 1);
  // the gate evidence holds for the approve: same code
  const w = work();
  assert.ok(w.gates.m1.verify.ctree && w.gates.m1.verify.ctree === w.gates.m1.verify.ctreeBefore);
});

test('affected tests between full runs: the runner is asked for the tests of the changed files; config and lock changes run the whole lane', () => {
  // a stand-in npx that records what it was asked
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-v030-bin-'));
  const log = path.join(bin, 'npx.log');
  fs.writeFileSync(path.join(bin, 'npx'), `#!/bin/sh\necho "$@" >> "${log}"\nexit 0\n`); fs.chmodSync(path.join(bin, 'npx'), 0o755);
  fs.writeFileSync(path.join(bin, 'npm'), `#!/bin/sh\necho "npm $@" >> "${log}"\nexit 0\n`); fs.chmodSync(path.join(bin, 'npm'), 0o755);
  extraEnv.PATH = `${bin}${path.delimiter}${process.env.PATH}`;
  write('package.json', JSON.stringify({ name: 'x', scripts: { test: 'vitest run' } }));
  g('add', '-A'); g('commit', '-qm', 'pkg');
  ok(['config', 'set', 'verify.unit', 'npm test']);
  ok(['config', 'set', 'gate.e2e', counter('e2e')]);
  ok(['config', 'set', 'options.fullVerifyEvery', '3']);
  ok(['config', 'set', 'options.affectedTests', 'on']);
  task('A'); ok(['task', 'start', 'A']);
  write('src/a.js', 'module.exports = 2;\n');
  write('src/b.ts', 'export const b = 1;\n');
  const v = ok(['task', 'verify', 'A']);
  assert.match(v.out, /tests affected by 2 changed file\(s\)/);
  assert.match(fs.readFileSync(log, 'utf8'), /^vitest related --run --passWithNoTests src\/a\.js src\/b\.ts$/m);
  const r = work().items.A.verifications.pop().results.find(x => x.kind === 'project:unit');
  assert.strictEqual(r.affected, true);
  assert.strictEqual(r.laneCmd, 'npm test');
  // a config change is outside what the import graph sees: the whole lane
  write('vitest.config.ts', 'export default {};\n');
  const v2 = forge(['task', 'verify', 'A']);
  assert.match(v2.out, /whole lane: vitest\.config\.ts changed/);
  assert.ok(!work().items.A.verifications.pop().results.find(x => x.kind === 'project:unit').affected);
  // a full verify always runs the whole lane
  fs.unlinkSync(path.join(dir, 'vitest.config.ts'));
  ok(['task', 'verify', 'A', '--full', '--reason', 'test']);
  assert.ok(!work().items.A.verifications.pop().results.find(x => x.kind === 'project:unit').affected);
});

test('affected tests stay off without gate lanes or a periodic full run — the whole lane would never run', () => {
  ok(['config', 'set', 'verify.unit', counter('unit')]);
  ok(['config', 'set', 'affected.unit', `${counter('aff')} -- {files}`]);
  task('A'); ok(['task', 'start', 'A']);
  write('src/a.js', 'module.exports = 2;\n');
  ok(['task', 'verify', 'A']);
  assert.strictEqual(runs('aff'), 0);
  assert.strictEqual(runs('unit'), 1);
});

// --- task pushes and CI ---------------------------------------------------------
function gitFlow() {
  const remote = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-v030-remote-'));
  spawnSync('git', ['init', '--bare', '-q', remote]);
  g('checkout', '-q', '-b', 'staging');
  ok(['config', 'set', 'options.integration', 'per-milestone']);
  ok(['config', 'set', 'options.baseBranch', 'staging']);
  write('.gitignore', ['forge/dashboard.html', 'forge/state/usage.json', 'forge/state/usage-cache.json', 'forge/state/preflight.json', 'forge/state/session.json', 'forge/state/work.lock', ''].join('\n'));
  g('add', '-A'); g('commit', '-qm', 'flow');
  g('remote', 'add', 'origin', remote); g('push', '-q', '-u', 'origin', 'staging');
  return remote;
}
const remoteHas = (remote, ref) => spawnSync('git', ['--git-dir', remote, 'rev-parse', '--verify', '--quiet', ref], { encoding: 'utf8' }).status === 0;
function closeOne(id) {
  ok(['milestone', 'add', 'M1', '--name', 'One']);
  task(id, ['--milestone', 'M1']);
  ok(['milestone', 'branch', 'M1']);
  ok(['task', 'start', id]);
  write('src/a.js', 'module.exports = 2;\n');
  ok(['task', 'verify', id]);
  return ok(['task', 'done', id]);
}

test('a workflow listening to milestone pushes keeps task commits local; ship pushes once', () => {
  const remote = gitFlow();
  write('.github/workflows/ci.yml', 'name: CI\non:\n  push:\n    branches: [\'milestone/**\', staging]\n  pull_request:\njobs:\n  t:\n    runs-on: ubuntu-latest\n    steps: [{ run: "true" }]\n');
  g('add', '-A'); g('commit', '-qm', 'ci'); g('push', '-q');
  const d = closeOne('A');
  assert.match(d.out, /kept local: \.github\/workflows\/ci\.yml runs on every push to milestone\/M1/);
  assert.strictEqual(work().items.A.commit.pushed, false);
  assert.ok(!remoteHas(remote, 'milestone/M1'));
  const runsOut = ok(['ci', 'runs']).out;
  assert.match(runsOut, /Each task push\s+none — task commits stay local/);
  assert.match(runsOut, /Runs twice on the same code at ship \(push and pull request\): \.github\/workflows\/ci\.yml/);
  assert.match(runsOut, /Runs again after the merge .*ci\.yml/);
});

test('with no workflow on milestone pushes, a task commit is pushed as it closes (and options.push milestone keeps it local)', () => {
  const remote = gitFlow();
  write('.github/workflows/ci.yml', 'on:\n  pull_request:\n    branches: [staging]\njobs: {}\n');
  g('add', '-A'); g('commit', '-qm', 'ci'); g('push', '-q');
  closeOne('A');
  assert.strictEqual(work().items.A.commit.pushed, true);
  assert.ok(remoteHas(remote, 'milestone/M1'));
});

test('workflow triggers are read the way GitHub reads them', () => {
  const cases = [
    ['on: push\n', true], ['on: [pull_request]\n', false], ['on:\n  push:\n    tags: [\'v*\']\n', false],
    ['on:\n  push:\n    branches:\n      - main\n', false], ['on:\n  push:\n    branches-ignore: [\'milestone/*\']\n', false],
    ['on:\n  push:\n    branches: [\'**\', \'!milestone/**\']\n', false], ['on:\n  workflow_dispatch:\n  push:\n', true],
  ];
  const remote = gitFlow(); assert.ok(remote);
  cases.forEach(([y], i) => write(`.github/workflows/w${i}.yml`, y + 'jobs: {}\n'));
  const rep = JSON.parse(ok(['ci', 'runs', '--json']).out);
  const hit = new Set(rep.onMilestonePush.map(f => f.match(/w(\d+)\.yml$/)[1]));
  cases.forEach(([y, want], i) => assert.strictEqual(hit.has(String(i)), want, y));
});

test('preflight names e2e harness costs it can see: the dev server, no saved sign-in', () => {
  ok(['config', 'set', 'options.web', 'true']);
  write('playwright.config.ts', "export default { webServer: { command: 'npm run dev', url: 'http://localhost:3000' } };\n");
  const p = forge(['preflight']).out;
  assert.match(p, /e2e harness: playwright\.config\.ts: e2e runs against the dev server \(npm run dev\)/);
  assert.match(p, /e2e harness: playwright\.config\.ts: no saved sign-in \(storageState\)/);
  write('playwright.config.ts', "export default { use: { storageState: 'auth.json' }, webServer: { command: 'npm run build && npm run start' } };\n");
  assert.doesNotMatch(forge(['preflight']).out, /e2e harness/);
});
