'use strict';
/**
 * v0.29 — the dashboard as the place to manage Forge: Needs you, Loop and Project pages from the same
 * snapshot the cockpit reads; it advises (what to type, where), never drives Claude; live reload.
 *   npm test
 */
const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const CLI = path.resolve(__dirname, '..', 'plugins', 'forge', 'bin', 'forge.js');
let dir;
const ENV = () => ({ CLAUDE_PROJECT_DIR: dir, FORGE_CLAUDE_PROJECTS: path.join(os.tmpdir(), 'forge-no-such-logs'), FORGE_DEFAULTS: path.join(os.tmpdir(), 'forge-no-such-defaults.json') });
function forge(args) {
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd: dir, encoding: 'utf8', input: '', env: Object.assign({}, process.env, ENV()) });
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
}
function hook(name, obj) {
  return spawnSync(process.execPath, [CLI, 'hook', name], { cwd: dir, encoding: 'utf8', input: JSON.stringify(obj), env: Object.assign({}, process.env, ENV()) });
}
const html = () => fs.readFileSync(path.join(dir, 'forge', 'dashboard.html'), 'utf8');
const page = (name) => { const m = html().match(new RegExp(`<section class="page" data-page="${name}"[\\s\\S]*?</section>`)); return m ? m[0] : ''; };

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-v029-'));
  spawnSync('git', ['init', '-q'], { cwd: dir });
  forge(['init', '--project', 'demo']);
  forge(['config', 'set', 'phase', 'build']);
  forge(['config', 'set', 'options.graphify', 'skip']);
  forge(['config', 'set', 'options.integration', 'manual', '--reason', 'test fixture']);
  forge(['release', 'add', 'mvp', '--name', 'MVP']);
  forge(['milestone', 'add', 'm1', '--name', 'Customers can book a board', '--release', 'mvp']);
  forge(['task', 'add', '--id', 'A', '--title', 'Cart', '--milestone', 'm1', '--criterion', 'ok::true', '--allowed', 'src/']);
  forge(['task', 'add', '--id', 'B', '--title', 'Add-ons', '--milestone', 'm1', '--criterion', 'ok::true', '--allowed', 'lib/']);
});

test('the side menu has Needs you (with its count), Loop and Project, and the live switch', () => {
  forge(['task', 'block', 'B', '--question', 'Mock or spec?', '--option', 'mock=3 add-ons', '--option', 'spec=2 add-ons', '--recommend', 'spec']);
  const h = html();
  assert.match(h, /<a href="#\/needs" data-p="needs">Needs you <span class="k warnk">1<\/span><\/a>/);
  assert.match(h, /data-p="loop">Loop/);
  assert.match(h, /data-p="project">Project <span class="k">1<\/span>/);
  assert.match(h, /id="forgeLive"/);
  assert.match(h, /location\.reload\(\)/);
  // every script on the page still parses
  const re = /<script>([\s\S]*?)<\/script>/g; let m, n = 0;
  while ((m = re.exec(h))) { new Function(m[1]); n++; } // eslint-disable-line no-new-func
  assert.ok(n >= 2);
});

test('a question card says what to type in the session and what to run, for each option; the recommendation is marked', () => {
  forge(['task', 'block', 'B', '--question', 'Mock or spec?', '--option', 'mock=3 add-ons', '--option', 'spec=2 add-ons', '--recommend', 'spec']);
  const p = page('needs');
  assert.match(p, /<blockquote>Mock or spec\?<\/blockquote>/);
  assert.match(p, /<code class="copyable say">B: spec<\/code>/);
  assert.match(p, /<code class="copyable">forge question answer B --choice mock<\/code>/);
  assert.match(p, /class="nopt rec"><b>spec<\/b> 2 add-ons <span class="pill"[^>]*>recommended/);
});

test('text that came from elsewhere is shown escaped and never offered to copy', () => {
  forge(['task', 'block', 'B', '--question', 'Pick <img src=x onerror=alert(1)>', '--option', 'a=<b>bold</b>', '--option', 'b=plain']);
  hook('notification', { session_id: 's-1', notification_type: 'idle_prompt', message: 'run `rm -rf /` <script>alert(2)</script>' });
  const p = page('needs');
  assert.doesNotMatch(p, /<img src=x|<script>alert|<b>bold<\/b>/);
  assert.match(p, /&lt;img src=x onerror=alert\(1\)&gt;/);
  // the notification's words are context only: no copyable code carries them
  const copies = [...p.matchAll(/<code class="copyable[^"]*">([^<]*)<\/code>/g)].map(m => m[1]);
  assert.ok(copies.length > 0);
  assert.ok(copies.every(c => !/rm -rf|alert/.test(c)), copies.join(' | '));
});

test('a Claude Code session waiting on you appears on the page and leaves it when the session moves on', () => {
  hook('notification', { session_id: 'abcdef1234', notification_type: 'permission_prompt', message: 'Claude needs your permission to use Bash' });
  assert.match(page('needs'), /session <code>abcdef12<\/code> is asking for a permission — approve or deny it in that terminal/);
  assert.match(html(), /Needs you <span class="k warnk">1/);
  hook('user-prompt-submit', { session_id: 'abcdef1234', prompt: 'yes' });
  assert.doesNotMatch(page('needs'), /abcdef12/);
  assert.match(page('needs'), /Nothing needs you right now/);
});

test('the Loop page shows each task at its step; the Project page shows each milestone and how it grew', () => {
  forge(['task', 'add', '--id', 'C', '--title', 'Split piece', '--milestone', 'm1', '--origin', 'split', '--parent', 'A', '--criterion', 'ok::true', '--allowed', 'docs/']);
  forge(['task', 'start', 'A']);
  const l = page('loop');
  assert.match(l, /milestone m1 — 0\/3 done/);
  assert.match(l, /<tr class="s-brief"><td>Brief<\/td><td><code>A<\/code> Cart/);
  assert.match(l, /<tr class="s-todo"><td>To do<\/td><td><code>C<\/code> Split piece/);
  assert.match(l, /<td>split<\/td>/);
  const p = page('project');
  assert.match(p, /1 milestones · 3 tasks · 1 added after planning \(33%\)/);
  assert.match(p, /title="split 1" style="flex:1;background:#b3660a"/);
  assert.match(p, /<div class="num pv">0\/3<\/div>/);
});
