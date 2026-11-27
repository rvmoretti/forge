'use strict';
/**
 * v0.29 — the dashboard as the place to manage Forge, drawn from the same snapshot the cockpit reads; it advises
 * (what to type, where), never drives Claude.
 * v0.33 — the same content, every fact once: what needs you is on Home, a task's step is on its row in Plan and in
 * the milestone's bar on Home, how each milestone grew is under Insights; the page follows Forge without reloading
 * (tests/v033.test.js).
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

test('the top bar has Home (counting what needs you) and Plan, and the live switch', () => {
  forge(['task', 'block', 'B', '--question', 'Mock or spec?', '--option', 'mock=3 add-ons', '--option', 'spec=2 add-ons', '--recommend', 'spec']);
  const h = html();
  assert.match(h, /<a href="#\/overview" data-p="overview" data-g="home">Home <span class="k warnk" title="1 thing\(s\) need you">1<\/span><\/a>/);
  assert.match(h, /data-p="plan" data-g="plan">Plan <span class="k">0\/2<\/span>/);
  assert.match(h, /id="forgeLive"/);
  // v0.33: the pages of v0.29 are gone from the menu, and their addresses still land
  assert.doesNotMatch(h, /data-p="needs"|data-p="loop"|data-p="project"/);
  assert.match(h, /needs: 'overview', loop: 'plan'/);
  // every script on the page still parses
  const re = /<script>([\s\S]*?)<\/script>/g; let m, n = 0;
  while ((m = re.exec(h))) { new Function(m[1]); n++; } // eslint-disable-line no-new-func
  assert.ok(n >= 2);
});

test('a question card says what to type in the session and what to run, for each option; the recommendation is marked', () => {
  forge(['task', 'block', 'B', '--question', 'Mock or spec?', '--option', 'mock=3 add-ons', '--option', 'spec=2 add-ons', '--recommend', 'spec']);
  const p = page('overview');
  assert.match(p, /<blockquote>Mock or spec\?<\/blockquote>/);
  assert.match(p, /<code class="copyable say">B: spec<\/code>/);
  assert.match(p, /<code class="copyable">forge question answer B --choice mock<\/code>/);
  assert.match(p, /class="nopt rec"><span class="nlab"><b>spec<\/b> 2 add-ons <span class="pill"[^>]*>recommended/);
});

test('text that came from elsewhere is shown escaped and never offered to copy', () => {
  forge(['task', 'block', 'B', '--question', 'Pick <img src=x onerror=alert(1)>', '--option', 'a=<b>bold</b>', '--option', 'b=plain']);
  hook('notification', { session_id: 's-1', notification_type: 'idle_prompt', message: 'run `rm -rf /` <script>alert(2)</script>' });
  const p = page('overview');
  assert.doesNotMatch(p, /<img src=x|<script>alert|<b>bold<\/b>/);
  assert.match(p, /&lt;img src=x onerror=alert\(1\)&gt;/);
  // the notification's words are context only: no copyable code carries them
  const copies = [...p.matchAll(/<code class="copyable[^"]*">([^<]*)<\/code>/g)].map(m => m[1]);
  assert.ok(copies.length > 0);
  assert.ok(copies.every(c => !/rm -rf|alert/.test(c)), copies.join(' | '));
});

test('a Claude Code session waiting on you appears on the page and leaves it when the session moves on', () => {
  hook('notification', { session_id: 'abcdef1234', notification_type: 'permission_prompt', message: 'Claude needs your permission to use Bash' });
  assert.match(page('overview'), /session <code>abcdef12<\/code> is asking for a permission — approve or deny it in that terminal/);
  assert.match(html(), /data-g="home">Home <span class="k warnk"[^>]*>1</);
  hook('user-prompt-submit', { session_id: 'abcdef1234', prompt: 'yes' });
  assert.doesNotMatch(page('overview'), /abcdef12/);
  assert.match(page('overview'), /Nothing needs you right now/);
  assert.match(html(), /data-g="home">Home<\/a>/);
});

test('each task is shown at its step; Insights shows each milestone and how it grew', () => {
  forge(['task', 'add', '--id', 'C', '--title', 'Split piece', '--milestone', 'm1', '--origin', 'split', '--parent', 'A', '--criterion', 'ok::true', '--allowed', 'docs/']);
  forge(['task', 'start', 'A']);
  const l = page('plan');
  assert.match(l, /milestone m1 — 0\/3 done/);
  // Home: the task being built is a tile that names its step
  const o = page('overview');
  assert.match(o, /<li class="tile t-run" data-key="A"><a href="#\/plan\/A"[^>]*><span class="mk"><\/span><span class="tn">[^<]+<\/span><span class="ts"><b>A<\/b>brief/);
  // the steps of the loop, counted over the active milestone: one ring on Insights
  const ins = page('insights');
  assert.match(ins, /<circle class="f-brief"[^>]*><title>Brief 1<\/title><\/circle><circle class="f-todo"[^>]*><title>To do 2<\/title><\/circle>/);
  assert.match(ins, /<span class="f-brief"><i><\/i><b class="num">1<\/b> brief<\/span>/);
  assert.match(l, /id="it-A" data-id="A"[^>]*data-s="IN_PROGRESS"[^>]*data-stage="brief"/);
  assert.match(l, /id="it-C" data-id="C"[^>]*data-stage="todo"/);
  assert.match(l, /<b class="stg">Brief<\/b>/);
  assert.match(l, /class="cchip origin-split"/);
  const p = page('insights');
  assert.match(p, /1 milestones · 3 tasks · 1 added after planning \(33%\)/);
  assert.match(p, /<i class="o-plan" title="plan 2" style="flex:2"><\/i><i class="o-split" title="split 1" style="flex:1"><\/i>/); // v0.33: one hue — planned neutral, added in the accent
  assert.match(p, /2 planned · <b class="grew">\+1<\/b> split 1/);
  assert.match(p, /<div class="num pv">0\/3<\/div>/);
});
