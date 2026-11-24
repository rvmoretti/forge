'use strict';
/**
 * v0.28 — the cockpit: what `forge status --json` now carries for it, that its polling leaves no trace,
 * and the guard that holds the cockpit mod to its read-only set of hooks and calls.
 *   npm test   (the guard needs the `claude` CLI on PATH; without it that test is skipped)
 */
const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const PLUGIN = path.resolve(__dirname, '..', 'plugins', 'forge');
const CLI = path.join(PLUGIN, 'bin', 'forge.js');
let dir;
function forge(args) {
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd: dir, encoding: 'utf8', input: '',
    env: Object.assign({}, process.env, { CLAUDE_PROJECT_DIR: dir, FORGE_CLAUDE_PROJECTS: path.join(os.tmpdir(), 'forge-no-such-logs'), FORGE_DEFAULTS: path.join(os.tmpdir(), 'forge-no-such-defaults.json') }) });
  return { code: r.status, out: (r.stdout || '') + (r.stderr || ''), stdout: r.stdout || '' };
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-v028-'));
  spawnSync('git', ['init', '-q'], { cwd: dir });
  forge(['init', '--project', 'test']);
  forge(['config', 'set', 'phase', 'build']);
  forge(['config', 'set', 'options.graphify', 'skip']);
});

test('status --json carries the active milestone\'s tasks with their step, every milestone\'s shape, and the switches', () => {
  forge(['release', 'add', 'mvp', '--name', 'MVP']);
  forge(['milestone', 'add', 'm1', '--name', 'Customers can book a board', '--release', 'mvp']);
  forge(['task', 'add', '--id', 'A', '--title', 'Cart', '--milestone', 'm1', '--criterion', 'ok::true', '--allowed', 'src/']);
  forge(['task', 'add', '--id', 'B', '--title', 'Split part', '--milestone', 'm1', '--origin', 'split', '--parent', 'A', '--criterion', 'ok::true', '--allowed', 'lib/']);
  const s = JSON.parse(forge(['status', '--json']).stdout);
  assert.deepStrictEqual(s.tasks.map(t => [t.id, t.stage, t.origin, t.criteria]), [['A', 'todo', 'plan', 1], ['B', 'todo', 'split', 1]]);
  assert.deepStrictEqual(s.milestones.map(m => [m.id, m.release, m.total, m.origins]), [['m1', 'mvp', 2, { plan: 1, split: 1 }]]);
  const h = s.config.find(c => c.key === 'hardening');
  assert.ok(h && h.what && h.change, 'a switch carries its meaning and the command that changes it');
});

test('status --json, which the cockpit repeats every few seconds, writes nothing to the trace', () => {
  const tf = path.join(dir, 'forge', 'state', 'trace.jsonl');
  const before = fs.readFileSync(tf, 'utf8');
  for (let i = 0; i < 3; i++) assert.strictEqual(forge(['status', '--json']).code, 0);
  assert.strictEqual(fs.readFileSync(tf, 'utf8'), before);
  forge(['status']); // the human-facing status is still traced
  assert.notStrictEqual(fs.readFileSync(tf, 'utf8'), before);
});

test('the plugin manifest has the cockpit switch and the mod; Forge\'s own hooks stay', () => {
  const pj = JSON.parse(fs.readFileSync(path.join(PLUGIN, '.claude-plugin', 'plugin.json'), 'utf8'));
  assert.strictEqual(pj.userConfig.cockpit.type, 'boolean');
  assert.strictEqual(pj.userConfig.cockpit.default, true);
  const hj = JSON.parse(fs.readFileSync(path.join(PLUGIN, 'hooks', 'hooks.json'), 'utf8'));
  assert.deepStrictEqual(hj.modules, ['./cockpit.tsx']);
  for (const ev of ['SessionStart', 'PreToolUse', 'Stop', 'SessionEnd', 'PreCompact', 'Notification', 'UserPromptSubmit']) assert.ok(hj.hooks[ev], ev);
});

// The cockpit's promise: it reads, it draws, it runs the forge CLI on the owner's click — nothing else.
// This holds the mod to that, by what `claude plugin validate` reads in its source.
const ALLOWED_EVENTS = ['session.start', 'tool.call', 'command.run', 'ui.render'];
const ALLOWED_CALLS = ['agent.list', 'clock.every', 'clock.now', 'command.register', 'fs.stat', 'process.run', 'state.get', 'state.set', 'ui.open', 'ui.resolve', 'ui.toast'];
const hasClaude = spawnSync('claude', ['--version'], { encoding: 'utf8' }).status === 0;
test('the cockpit mod hooks and calls only its read-only set', { skip: hasClaude ? false : 'the claude CLI is not on PATH' }, () => {
  const r = spawnSync('claude', ['plugin', 'validate', PLUGIN, '--json'], { encoding: 'utf8' });
  const rep = JSON.parse(r.stdout);
  const mods = rep.contents.flatMap(c => c.modules || []);
  assert.deepStrictEqual(mods.map(m => m.module), ['./cockpit.tsx']);
  const uses = mods[0].uses;
  const extraEvents = uses.events.filter(e => !ALLOWED_EVENTS.includes(e));
  const extraCalls = uses.calls.filter(c => !ALLOWED_CALLS.includes(c));
  assert.deepStrictEqual(extraEvents, [], `the cockpit must not hook ${extraEvents.join(', ')} — it would change what Claude does`);
  assert.deepStrictEqual(extraCalls, [], `the cockpit must not call $.${extraCalls.join(', $.')}`);
  const gating = rep.contents.flatMap(c => c.gatingHooks || []);
  assert.deepStrictEqual(gating.map(g => [g.hook, g.hasCatch]), [['tool.call', true]]);
  const notes = rep.contents.flatMap(c => c.notes || []).join('\n');
  assert.doesNotMatch(notes, /adds to \$: (?!nothing)|withholds from \$: (?!nothing)/);
});
