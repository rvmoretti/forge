'use strict';
/**
 * v0.33 — the dashboard reorganized so every fact is said once, in five destinations: Home (the state in a
 * sentence, what needs you, what is in flight, the milestone on its way out, what happened), Plan (releases →
 * milestones → tasks; a task opens beside the list), Insights, Product (tabs) and Setup (tabs). It follows Forge
 * without reloading. One neutral scale and one accent; dark unless the owner chooses light.
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
const html = () => fs.readFileSync(path.join(dir, 'forge', 'dashboard.html'), 'utf8');
const page = (name) => { const m = html().match(new RegExp(`<section class="page" data-page="${name}"[\\s\\S]*?</section>`)); return m ? m[0] : ''; };
const client = () => { const all = [...html().matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]); return all[all.length - 1]; };

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-v033-'));
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

test('the page follows Forge without reloading: it asks its own file and patches what changed', () => {
  const h = html(), js = client();
  assert.doesNotMatch(h, /location\.reload\(/);
  assert.doesNotMatch(h, /http-equiv="refresh"/i);
  // the stamp names the content; a state change gives the file another one
  const s1 = h.match(/<body data-stamp="([0-9a-f]{16})">/);
  assert.ok(s1, 'the body carries a stamp');
  forge(['task', 'block', 'B', '--reason', 'waiting on a vendor']);
  const s2 = html().match(/<body data-stamp="([0-9a-f]{16})">/);
  assert.notStrictEqual(s2[1], s1[1]);
  // a copy loaded in the hidden frame answers and stops — and sends its content only when the stamps differ
  assert.match(js, /forgelive=/);
  assert.match(js, /W\.parent\.postMessage\(\{ forge: 'live', stamp: mine, html: mine === decodeURIComponent\(asked\[1\]\) \? null : app\.innerHTML \}, '\*'\)/);
  // the open page takes an answer only from the frame it made
  assert.match(js, /e\.source !== frame\.contentWindow/);
  // unchanged content is skipped, so what the owner opened, typed or scrolled to stays as it is
  assert.match(js, /if \(prev\.isEqualNode\(next\)\) return;/);
  new Function(js); // eslint-disable-line no-new-func
  // everything a live update must carry travels inside #app — the documents included
  const app = h.slice(h.indexOf('<div class="shell" id="app">'), h.indexOf('<div class="docscrim" id="taskscrim">'));
  assert.match(app, /<script type="application\/json" id="docdata">/);
  assert.match(app, /id="snav"/);
  // and no second file appears beside the dashboard (an untracked file would change the tree a verify is bound to)
  assert.deepStrictEqual(fs.readdirSync(path.join(dir, 'forge')).filter(f => /dashboard/.test(f)), ['dashboard.html']);
});

test('five destinations in the dock; Product and Setup hold their pages as tabs; every page is still there', () => {
  const h = html();
  const nav = h.slice(h.indexOf('<nav id="snav"'), h.indexOf('</nav>', h.indexOf('<nav id="snav"')));
  assert.deepStrictEqual([...nav.matchAll(/data-g="([\w-]+)">([A-Za-z]+)/g)].map(m => `${m[1]}:${m[2]}`), ['home:Home', 'plan:Plan', 'insights:Insights', 'product:Product', 'setup:Setup']);
  const tabs = g => { const m = h.match(new RegExp(`<nav class="tabs" data-g="${g}"[\\s\\S]*?</nav>`)); return [...m[0].matchAll(/data-p="([\w-]+)"/g)].map(x => x[1]); };
  assert.deepStrictEqual(tabs('product'), ['specs', 'screens', 'architecture', 'journal']);
  assert.deepStrictEqual(tabs('setup'), ['configuration', 'commands', 'system']);
  assert.deepStrictEqual([...h.matchAll(/<section class="page" data-page="([\w-]+)"/g)].map(m => m[1]),
    ['overview', 'plan', 'insights', 'specs', 'screens', 'architecture', 'journal', 'configuration', 'commands', 'system']);
  // the pages merged away keep their addresses
  assert.match(client(), /roadmap: 'plan', project: 'plan', usage: 'insights'/);
  // one self-contained file: nothing is fetched
  assert.doesNotMatch(h, /<link[^>]+rel="stylesheet"|@import|fonts\.googleapis|<script[^>]+src=/);
});

test('Home says each thing once: the state, what needs you, the milestone as tiles, what happened; the rail says where the project stands', () => {
  forge(['task', 'block', 'B', '--question', 'Mock or spec?', '--option', 'mock=3 add-ons', '--option', 'spec=2 add-ons', '--recommend', 'spec']);
  forge(['task', 'start', 'A']);
  const p = page('overview');
  const at = s => { const i = p.indexOf(s); assert.ok(i >= 0, `missing: ${s}`); return i; };
  assert.ok(at('<h3>1 question needs your answer</h3>') < at('id="needs"'), 'the state sentence leads');
  assert.ok(at('id="needs"') < at('id="inflight"') && at('id="inflight"') < at('id="recent"'));
  // the sentence names the task; the question itself is on its card, once
  assert.match(p, /<p><code>B<\/code> waits on you · meanwhile A keeps building<\/p>/);
  assert.strictEqual(p.split('Mock or spec?').length - 1, 1);
  assert.match(p, /<h2 class="tl">Needs you <span class="cnt">1<\/span><\/h2>/);
  // an option: what to type first, the terminal form under it
  assert.match(p, /<span class="nsay"><code class="copyable say">B: spec<\/code><\/span>\s*<div class="nalt">or in a terminal <code class="copyable">forge question answer B --choice spec<\/code><\/div>/);
  // the active milestone, one tile per task: the one that waits on the owner first, then the one being built, with its step
  const fl = p.slice(at('id="inflight"'), at('id="recent"'));
  assert.match(fl, /<h2 class="tl"><a href="#\/plan\/m1">Customers can book a board<\/a>/);
  const you = fl.indexOf('<li class="tile t-you" data-key="B">'), run = fl.indexOf('<li class="tile t-run" data-key="A">');
  assert.ok(you >= 0 && you < run, 'the solid tile comes first');
  assert.match(fl, /<li class="tile t-run" data-key="A"><a href="#\/plan\/A"[^>]*><span class="mk"><\/span><span class="tn">Cart<\/span><span class="ts"><b>A<\/b>brief/);
  assert.match(p, /<li class="t-info"><i><\/i><span>A started<\/span><time data-since="/);
  assert.match(p, /<h3>Autopilot <span class="mut">— off<\/span><i class="sw" aria-hidden="true"><\/i><\/h3>/);
  // the rail, on every page: Forge and its version, the milestone's count, what waits, phase and autopilot, the gate, the whole project
  const h = html(), rail = h.slice(h.indexOf('<aside class="side"'), h.indexOf('</aside>'));
  assert.match(rail, /<img src="data:image\/png;base64,[^"]+" alt="FORGE"><\/a><span class="ver" title="Forge version">v\d+\.\d+\.\d+<\/span>/);
  assert.match(rail, /<div class="proj">demo<\/div><div class="railnum"><b class="num">0<\/b> of 2<\/div>/);
  assert.match(rail, /<a class="railneed" href="#\/overview"><span class="mk"><\/span><span><b>1 thing waits on you<\/b>/);
  assert.match(rail, /<span class="phase ph" data-k="Phase">build<\/span><span class="phase" data-k="Autopilot">Off<\/span>/);
  assert.match(rail, /<li class="g-now"><i><\/i><b>Tasks<\/b><span>0\/2 closed<\/span><\/li>/);
  assert.match(rail, /<li class="g-wait"><i><\/i><b>Your review<\/b><span>after the tasks close<\/span><\/li>/);
  assert.match(rail, /0 of 2 tasks closed · 0 of 1 milestones approved/);
  // the milestone's ring and its facts are on Insights, once
  const ins = page('insights'), ms = ins.slice(ins.indexOf('id="milestone"'));
  assert.match(ms, /<svg class="ring" viewBox="0 0 128 128" role="img" aria-label="1 Brief, 1 Blocked">/);
  assert.match(ms, /<dt>Whole project<\/dt><dd>0\/2 tasks · 0 of 1 milestones approved/);
  assert.match(ms, /<dt>Scope<\/dt><dd>2 planned · /);
  assert.strictEqual(html().split('class="gsteps"').length - 1, 1, 'the gate is drawn once');
  // what the old Home repeated is gone
  assert.doesNotMatch(html(), /class="kpis"|READY TO BUILD|class="rels"/);
});

test('one solid surface: what waits on the owner; the typefaces travel inside the file with their licence in the plugin', () => {
  forge(['task', 'block', 'B', '--question', 'Mock or spec?']);
  const h = html();
  // the scale turns over inside a solid surface, so everything nested in it keeps working in both themes
  assert.match(h, /\.ncard:not\(\.claude\),\.t-you>a,details\.icd\[data-q="1"\]>summary\.irow,\.railneed,\.cnt,\.toast\{--ink:var\(--c-onlit\);/);
  assert.match(h, /#snav a\.on\{background:var\(--raised\);box-shadow:var\(--raisering\)/); // "you are here" is raised glass, never solid
  assert.strictEqual((h.match(/@font-face\{font-family:"(?:Outfit|DM Mono)";[^}]*src:url\(data:font\/woff2;base64,/g) || []).length, 3);
  const fdir = path.join(__dirname, '..', 'plugins', 'forge', 'fonts');
  for (const f of ['outfit-latin.woff2', 'dm-mono-latin-400.woff2', 'dm-mono-latin-500.woff2', 'OFL.txt']) assert.ok(fs.existsSync(path.join(fdir, f)), f);
  assert.match(fs.readFileSync(path.join(fdir, 'OFL.txt'), 'utf8'), /SIL OPEN FONT LICENSE Version 1\.1/);
});

test('where something is cut off, a pair of arrows says so and moves it: the rail, the page, an open task, an open document', () => {
  const h = html();
  for (const f of ['side', 'page', 'taskbody', 'docbody'])
    assert.match(h, new RegExp(`<div class="cues" data-for="${f}"><button type="button" data-cue="up" aria-label="Scroll [^"]+ up" hidden></button><button type="button" data-cue="down" aria-label="Scroll [^"]+ down" hidden></button></div>`));
  assert.match(h, /<aside class="side"[^>]*><div class="sidein" id="side">/); // the rail scrolls inside its pane; its arrows stay put
  assert.match(client(), /box\.querySelector\('\[data-cue="down"\]'\)\.hidden = room < 8;/); // shown only while there is more that way
  assert.match(client(), /behavior: calm \? 'auto' : 'smooth'/);
});

test('Plan: a milestone header is its roadmap line; a task row carries what the side panel and the search need', () => {
  forge(['task', 'add', '--id', 'C', '--title', 'Split piece', '--milestone', 'm1', '--origin', 'split', '--parent', 'A', '--criterion', 'ok::true', '--allowed', 'docs/']);
  const p = page('plan');
  assert.match(p, /<summary>[^\n]*<b>Customers can book a board<\/b>[^\n]*<span class="mprog"><span class="pbar"><i style="width:0%"><\/i><\/span><span class="mut num">0\/3 done<\/span><\/span> <span class="mut grow"[^>]*>\+1 added<\/span>/);
  assert.doesNotMatch(p, /gate pending/i);
  assert.match(p, /<span class="tt">Cart<\/span>/);
  assert.match(p, /<button type="button" class="ghost" id="wgfold" aria-pressed="false">Milestones only<\/button>/);
  assert.doesNotMatch(p, /id="lpipe"/);
  const h = html();
  for (const id of ['taskpanel', 'tasktitle', 'taskmeta', 'taskbody', 'taskprev', 'tasknext', 'taskclose', 'pal', 'palq', 'pallist', 'searchbtn', 'themebtn', 'toast'])
    assert.match(h, new RegExp(`id="${id}"`));
});

test('one neutral scale and one attention colour; dark unless the owner chose light', () => {
  const h = html();
  assert.match(h, /:root\{[^}]*color-scheme:dark;/);
  assert.match(h, /:root\[data-theme="light"\]\{color-scheme:light;/);
  assert.match(h, /@media \(prefers-color-scheme:light\)\{:root\[data-theme="auto"\]\{color-scheme:light;/);
  assert.ok(h.indexOf("localStorage.getItem('forge.theme')") < h.indexOf('<style>'), 'the stored choice is applied before the page paints');
  // the names the blocks use for states resolve to the neutral scale or to the accent — no second hue
  assert.match(h, /--done:var\(--ink2\);--readyc:var\(--ink2\);--progc:var\(--ink\);--blockc:var\(--accent\);--awaitc:var\(--accent\)/);
  // and the generator writes no colour into the markup: the stylesheet decides, from the state the markup names
  forge(['arch', 'add', 'web', '--name', 'Web app', '--kind', 'frontend', '--runs-on', 'Cloudflare', '--confirm']);
  forge(['task', 'update', 'A', '--component', 'web']);
  const h2 = html();
  const app = h2.slice(h2.indexOf('<div class="shell" id="app">'), h2.indexOf('<script type="application/json" id="docdata">'));
  assert.match(app, /<button type="button" class="acard" data-c="web"/);
  assert.match(app, /<span class="stripe"><\/span>/);
  assert.deepStrictEqual(app.match(/style="[^"]*#[0-9a-fA-F]{3,8}\b[^"]*"/g) || [], []);
  assert.match(h, /@media \(prefers-reduced-motion:reduce\)/);
});

test('Setup: Configuration opens on what this project changed; Health puts what needs attention first', () => {
  forge(['config', 'set', 'options.concurrency', '2']);
  const p = page('configuration');
  assert.match(p, /id="cfgfilter"/);
  assert.match(p, /<button data-f="mine">Changed here<span class="n"><\/span><\/button><button class="on" data-f="all">All settings<\/button>/);
  assert.match(client(), /cfgMode = D\.querySelector\('table\.cfgt tr\[data-mine="1"\]'\) \? 'mine' : 'all'/);
  assert.match(p, /<tr data-mine="1"><td><code>options\.concurrency<\/code><\/td><td><code>2<\/code><div class="src">this project<\/div><\/td>/);
  // a value that comes from Forge's defaults is shown with where it comes from, and is not "changed here"
  const fromDefault = [...p.matchAll(/<tr data-mine="0"><td><code>(options\.[A-Za-z]+)<\/code><\/td><td><code>[^<]*<\/code><div class="src">(Forge [\d.]+ default|profile \w+)<\/div>/g)];
  assert.ok(fromDefault.length > 0, 'at least one setting is shown as a Forge default');
  assert.match(p, /<details class="cfgintro panel hint"><summary>How this page works/);
  const s = page('system');
  assert.match(s, /<h2>Health<\/h2>/);
  const met = s.indexOf('<details class="metmore"><summary>');
  assert.ok(met > 0, 'the standards that are met fold away');
  assert.doesNotMatch(s.slice(0, met), /<span class="bdg ok">MET<\/span>/);
  assert.match(s.slice(met), /<span class="bdg ok">MET<\/span>/);
});
