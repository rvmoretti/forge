'use strict';
/**
 * v0.25 — the state contract the cockpit and the dashboard read: structured questions,
 * status --json, trace --json --since, owner notes, and the Notification-hook attention record.
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
  return { code: r.status, out: (r.stdout || '') + (r.stderr || ''), stdout: r.stdout || '' };
}
function hook(name, stdinObj) {
  const r = spawnSync(process.execPath, [CLI, 'hook', name], { cwd: dir, encoding: 'utf8', input: JSON.stringify(stdinObj || {}), env: Object.assign({}, process.env, ENV()) });
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
}
function work() { return JSON.parse(fs.readFileSync(path.join(dir, 'forge', 'state', 'work.json'), 'utf8')); }
function addItem(id, scope) { return forge(['task', 'add', '--id', id, '--title', id, '--criterion', 'ok::node -e "process.exit(0)"', '--allowed', scope || 'src/']); }
function json(args) { const r = forge(args); assert.strictEqual(r.code, 0, r.out); return JSON.parse(r.stdout); }

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-v025-'));
  spawnSync('git', ['init', '-q'], { cwd: dir });
  spawnSync('git', ['config', 'user.email', 't@t'], { cwd: dir });
  spawnSync('git', ['config', 'user.name', 't'], { cwd: dir });
  forge(['init', '--project', 'test']);
  forge(['config', 'set', 'phase', 'build']);
  forge(['config', 'set', 'verify.test', 'node -e "process.exit(0)"']);
  forge(['config', 'set', 'options.graphify', 'skip']);
  forge(['config', 'set', 'options.integration', 'manual', '--reason', 'test fixture']);
  forge(['config', 'set', 'options.briefCheck', 'off']);
});

// --- structured questions ----------------------------------------------------

test('task block --question records options and the recommendation; question list shows them', () => {
  addItem('Q1');
  const b = forge(['task', 'block', 'Q1', '--question', 'Checkout add-ons: mock or spec?', '--option', 'mock=3 add-ons', '--option', 'spec=2 add-ons', '--recommend', 'spec']);
  assert.strictEqual(b.code, 0, b.out);
  assert.match(b.out, /Options: mock = 3 add-ons · spec = 2 add-ons \(recommended\)/);
  assert.match(b.out, /forge question answer Q1 --choice <key>/);
  const t = work().items.Q1;
  assert.strictEqual(t.status, 'BLOCKED');
  assert.strictEqual(t.blockReason, 'question: Checkout add-ons: mock or spec?');
  assert.deepStrictEqual(t.question.options, [{ key: 'mock', label: '3 add-ons' }, { key: 'spec', label: '2 add-ons' }]);
  const qs = json(['question', 'list', '--json']);
  assert.strictEqual(qs.length, 1);
  assert.strictEqual(qs[0].id, 'Q1');
  assert.strictEqual(qs[0].question, 'Checkout add-ons: mock or spec?');
  assert.deepStrictEqual(qs[0].options.map(o => [o.key, o.recommended]), [['mock', false], ['spec', true]]);
  assert.ok(qs[0].since);
  assert.match(forge(['question', 'list']).out, /spec: 2 add-ons {3}← recommended/);
});

test('task block --question refuses malformed questions', () => {
  addItem('Q2');
  assert.match(forge(['task', 'block', 'Q2', '--question', 'x?', '--option', 'only=one']).out, /at least two/);
  assert.match(forge(['task', 'block', 'Q2', '--question', 'x?', '--option', 'a=1', '--option', 'b=2', '--recommend', 'c']).out, /not one of the options \(a, b\)/);
  assert.match(forge(['task', 'block', 'Q2', '--question', 'x?', '--option', 'a=1', '--option', 'a=2']).out, /given twice/);
  assert.match(forge(['task', 'block', 'Q2', '--question', 'x?', '--option', 'no label']).out, /key="label"/);
  assert.match(forge(['task', 'block', 'Q2', '--question', 'x?', '--reason', 'y']).out, /not both/);
  assert.match(forge(['task', 'block', 'Q2', '--option', 'a=1', '--option', 'b=2']).out, /belong to a question/);
  assert.strictEqual(work().items.Q2.status, 'TODO'); // nothing was recorded
});

test('question answer --choice resumes the task and records the choice; wrong or missing answers are refused', () => {
  addItem('Q3');
  forge(['task', 'block', 'Q3', '--question', 'Card or invoice?', '--option', 'card=Card', '--option', 'invoice=Invoice', '--recommend', 'card']);
  assert.match(forge(['question', 'answer', 'Q3', '--choice', 'cash']).out, /not an option of Q3: card, invoice/);
  assert.match(forge(['question', 'answer', 'Q3']).out, /--choice <card\|invoice>/);
  const a = forge(['question', 'answer', 'Q3', '--choice', 'INVOICE', '--note', 'B2B only']);
  assert.strictEqual(a.code, 0, a.out);
  assert.match(a.out, /Q3 answered \(invoice: Invoice — B2B only\) → TODO/);
  const t = work().items.Q3;
  assert.strictEqual(t.status, 'TODO');
  assert.strictEqual(t.question, undefined);
  assert.strictEqual(t.blockedAt, undefined);
  const u = t.unblocks[t.unblocks.length - 1];
  assert.strictEqual(u.choice, 'invoice');
  assert.strictEqual(u.answer, 'invoice: Invoice — B2B only');
  assert.strictEqual(u.question.recommend, 'card');
  assert.deepStrictEqual(json(['question', 'list', '--json']), []);
});

test('a question asked mid-attempt resumes that attempt when answered', () => {
  forge(['config', 'set', 'options.concurrency', '2']);
  addItem('Q4');
  const st = forge(['task', 'start', 'Q4']);
  assert.strictEqual(st.code, 0, st.out);
  forge(['task', 'block', 'Q4', '--question', 'Which copy?', '--option', 'a=Short', '--option', 'b=Long']);
  assert.strictEqual(work().items.Q4.blockedFrom, 'IN_PROGRESS');
  const a = forge(['question', 'answer', 'Q4', '--choice', 'a']);
  assert.strictEqual(a.code, 0, a.out);
  assert.match(a.out, /→ IN_PROGRESS — the same attempt continues/);
  assert.strictEqual(work().items.Q4.attempts.filter(x => x.outcome === 'started').length, 1);
});

test('legacy "question:" blocks are listed and answerable with --note; other blocks are not questions', () => {
  addItem('L1'); addItem('L2');
  forge(['task', 'block', 'L1', '--reason', 'question: card or invoice?']);
  forge(['task', 'block', 'L2', '--reason', 'waiting on the payments API key']);
  const qs = json(['question', 'list', '--json']);
  assert.deepStrictEqual(qs.map(q => [q.id, q.question, q.options.length]), [['L1', 'card or invoice?', 0]]);
  assert.match(forge(['question', 'answer', 'L1', '--choice', 'card']).out, /it has none: answer with --note/);
  assert.strictEqual(forge(['question', 'answer', 'L1', '--note', 'card']).code, 0);
  const r = forge(['question', 'answer', 'L2', '--note', 'x']);
  assert.notStrictEqual(r.code, 0);
  assert.match(r.out, /has no open question .*forge task unblock L2/);
  assert.strictEqual(forge(['task', 'unblock', 'L2', '--note', 'key arrived']).code, 0); // unblock still works
  assert.strictEqual(work().items.L2.unblocks[0].answer, 'key arrived');
});

// --- owner notes ---------------------------------------------------------------

test('note for the next task is taken at its start, shown, and lands in its brief', () => {
  addItem('N1'); addItem('N2');
  assert.match(forge(['note', 'add', 'Totals in integer cents']).out, /Note 1 queued for the next task that starts/);
  assert.match(forge(['note', 'list']).out, /1\. \[for next\] Totals in integer cents/);
  assert.strictEqual(json(['note', 'list', '--json']).length, 1);
  const s = forge(['task', 'start', 'N1']);
  assert.strictEqual(s.code, 0, s.out);
  assert.match(s.out, /OWNER NOTES for this task \(1\)[\s\S]*Totals in integer cents/);
  assert.match(forge(['brief', 'N1']).out, /## Notes from the owner \(they bind this task\)\n- Totals in integer cents/);
  assert.doesNotMatch(forge(['brief', 'N2']).out, /Notes from the owner/);
  assert.match(forge(['note', 'list']).out, /No pending notes/);
  assert.match(forge(['note', 'list', '--all']).out, /\[taken into N1\]/);
});

test('a note for one task waits for that task; drop works only while pending', () => {
  forge(['config', 'set', 'options.concurrency', '2']);
  addItem('A1', 'src/a/'); addItem('A2', 'src/b/'); // disjoint scopes: both may run at once
  forge(['note', 'add', 'Keep the old route', '--for', 'A2']);
  forge(['note', 'add', 'Scratch this']);
  assert.match(forge(['note', 'drop', '2']).out, /Note 2 dropped/);
  assert.strictEqual(forge(['task', 'start', 'A1']).code, 0);
  assert.strictEqual(work().notes.find(x => x.n === 1).consumedBy, undefined);
  assert.match(forge(['brief', 'A2']).out, /- Keep the old route/); // addressed to it, before its start
  assert.strictEqual(forge(['task', 'start', 'A2']).code, 0);
  assert.strictEqual(work().notes.find(x => x.n === 1).consumedBy, 'A2');
  assert.match(forge(['note', 'drop', '1']).out, /already taken into A2's brief/);
  assert.match(forge(['note', 'add', 'x', '--for', 'NOPE']).out, /NOPE/);
});

test('a note for a task already in progress goes straight into its brief', () => {
  addItem('R1');
  assert.strictEqual(forge(['task', 'start', 'R1']).code, 0);
  const r = forge(['note', 'add', 'Use the shared units helper', '--for', 'R1']);
  assert.match(r.out, /already in progress/);
  assert.match(forge(['brief', 'R1']).out, /- Use the shared units helper/);
});

// --- status --json, trace --json ----------------------------------------------

test('status --json is one machine-readable snapshot: counts, work in progress, questions, notes, what needs you', () => {
  addItem('S1'); addItem('S2'); addItem('S3');
  assert.strictEqual(forge(['task', 'start', 'S1']).code, 0);
  forge(['task', 'block', 'S2', '--question', 'Which?', '--option', 'a=A', '--option', 'b=B', '--recommend', 'a']);
  forge(['note', 'add', 'Hello']);
  const s = json(['status', '--json']);
  assert.strictEqual(s.schema, 1);
  assert.strictEqual(s.project, 'test');
  assert.strictEqual(s.phase, 'build');
  assert.strictEqual(s.counts.IN_PROGRESS, 1);
  assert.strictEqual(s.counts.BLOCKED, 1);
  assert.strictEqual(s.counts.READY, 1);
  assert.deepStrictEqual(s.inProgress.map(x => x.id), ['S1']);
  assert.strictEqual(s.questions[0].id, 'S2');
  assert.strictEqual(s.notes[0].text, 'Hello');
  assert.deepStrictEqual(s.needsYou.map(n => n.kind), ['question']);
  assert.strictEqual(s.autopilot.on, false);
  assert.strictEqual(s.verify, null);
});

test('status --json outside a Forge project says so instead of failing', () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-v025-empty-'));
  const r = spawnSync(process.execPath, [CLI, 'status', '--json'], { cwd: empty, encoding: 'utf8', env: Object.assign({}, process.env, ENV(), { CLAUDE_PROJECT_DIR: empty }) });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(JSON.parse(r.stdout).initialized, false);
});

test('trace --json prints JSON lines; --since keeps only later events', () => {
  addItem('T1');
  spawnSync(process.execPath, ['-e', 'Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,20)']);
  const mid = new Date().toISOString();
  spawnSync(process.execPath, ['-e', 'Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,20)']);
  addItem('T2');
  const all = forge(['trace', '--json']).stdout.trim().split('\n').map(l => JSON.parse(l));
  assert.ok(all.length >= 2);
  assert.ok(all.every(e => e.ts && e.cmd !== undefined && e.outcome));
  const later = forge(['trace', '--json', '--since', mid]).stdout.trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
  assert.ok(later.some(e => /task add --id T2/.test(e.cmd)));
  assert.ok(!later.some(e => /task add --id T1/.test(e.cmd)));
  assert.match(forge(['trace', '--since', 'yesterday-ish']).out, /--since needs an ISO time/);
});

// --- attention (Notification hook) --------------------------------------------

test('Notification hook records which session waits on the owner; the session moving on clears it', () => {
  addItem('H1');
  assert.strictEqual(hook('notification', { session_id: 's1', notification_type: 'permission_prompt', title: 'Permission needed', message: 'Claude needs your permission to use Bash' }).code, 0);
  hook('notification', { session_id: 's2', notification_type: 'idle_prompt', message: 'Claude is waiting for your input' });
  let s = json(['status', '--json']);
  assert.deepStrictEqual(s.attention.map(a => [a.session, a.type]).sort(), [['s1', 'permission_prompt'], ['s2', 'idle_prompt']]);
  assert.ok(s.needsYou.some(n => n.kind === 'claude' && n.session === 's1' && /permission to use Bash/.test(n.text)));
  // a subagent's tool call does not mean the owner answered
  hook('pretooluse', { session_id: 's1', agent_id: 'ag1', tool_name: 'Read', tool_input: { file_path: 'README.md' } });
  assert.strictEqual(json(['status', '--json']).attention.length, 2);
  // the main thread moving on does
  hook('pretooluse', { session_id: 's1', tool_name: 'Read', tool_input: { file_path: 'README.md' } });
  hook('user-prompt-submit', { session_id: 's2', prompt: 'go on' });
  s = json(['status', '--json']);
  assert.deepStrictEqual(s.attention, []);
  // a prompt is not recorded in the committed trace; a notification is
  const tr = fs.readFileSync(path.join(dir, 'forge', 'state', 'trace.jsonl'), 'utf8');
  assert.match(tr, /"hook":"notification"/);
  assert.doesNotMatch(tr, /hook user-prompt-submit/);
});

test('the Notification and UserPromptSubmit hooks are registered; outside a Forge project they write nothing', () => {
  const h = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', 'plugins', 'forge', 'hooks', 'hooks.json'), 'utf8')).hooks;
  assert.match(h.Notification[0].matcher, /permission_prompt/);
  assert.match(h.Notification[0].hooks[0].command, /hook notification$/);
  assert.match(h.UserPromptSubmit[0].hooks[0].command, /hook user-prompt-submit$/);
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-v025-empty-'));
  const r = spawnSync(process.execPath, [CLI, 'hook', 'notification'], { cwd: empty, encoding: 'utf8', input: JSON.stringify({ session_id: 'x', message: 'm' }), env: Object.assign({}, process.env, ENV(), { CLAUDE_PROJECT_DIR: empty }) });
  assert.strictEqual(r.status, 0);
  assert.ok(!fs.existsSync(path.join(empty, 'forge')));
});
