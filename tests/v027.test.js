'use strict';
/**
 * v0.27 — the hardening milestone: forge release harden, audit tasks and their briefs,
 * forge audit list / triage, and the gates (milestone approve, release tag).
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
function forge(args) {
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd: dir, encoding: 'utf8', input: '',
    env: Object.assign({}, process.env, { CLAUDE_PROJECT_DIR: dir, FORGE_CLAUDE_PROJECTS: path.join(os.tmpdir(), 'forge-no-such-logs'), FORGE_DEFAULTS: path.join(os.tmpdir(), 'forge-no-such-defaults.json') }) });
  return { code: r.status, out: (r.stdout || '') + (r.stderr || ''), stdout: r.stdout || '' };
}
function ok(args) { const r = forge(args); assert.strictEqual(r.code, 0, `${args.join(' ')}\n${r.out}`); return r; }
function work() { return JSON.parse(fs.readFileSync(path.join(dir, 'forge', 'state', 'work.json'), 'utf8')); }
function write(rel, text) { const f = path.join(dir, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); }

// a project as the legacy tests build it: no layered defaults, so hardening is off until set
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-v027-'));
  spawnSync('git', ['init', '-q'], { cwd: dir });
  spawnSync('git', ['config', 'user.email', 't@t'], { cwd: dir });
  spawnSync('git', ['config', 'user.name', 't'], { cwd: dir });
  forge(['init', '--project', 'test']);
  forge(['config', 'set', 'phase', 'build']);
  forge(['config', 'set', 'verify.test', 'node -e "process.exit(0)"']);
  forge(['config', 'set', 'options.graphify', 'skip']);
  forge(['config', 'set', 'options.integration', 'manual', '--reason', 'test fixture']);
  const cf = path.join(dir, 'forge', 'config.json');
  const c = JSON.parse(fs.readFileSync(cf, 'utf8'));
  delete c.defaults; delete c.profile;
  c.options = Object.assign({}, c.options, { concurrency: 4, briefCheck: 'off' });
  fs.writeFileSync(cf, JSON.stringify(c, null, 2));
});

// one finished, approved feature milestone in release mvp
function shipFeature() {
  ok(['release', 'add', 'mvp', '--name', 'MVP']);
  ok(['milestone', 'add', 'm1', '--name', 'Customers can book a board', '--release', 'mvp']);
  ok(['task', 'add', '--id', 'F1', '--title', 'F1', '--milestone', 'm1', '--criterion', 'ok::node -e "process.exit(0)"', '--allowed', 'src/']);
  ok(['task', 'start', 'F1']);
  write('src/f1.js', String(Math.random()));
  ok(['task', 'verify', 'F1']);
  ok(['task', 'done', 'F1']);
  ok(['milestone', 'security', 'm1', '--agent', 'forge-reviewer', '--note', 'pass clean']);
  return forge(['milestone', 'approve', 'm1', '--note', 'demo ok']);
}
function finishAudit(id, file, findings) {
  ok(['task', 'start', id]);
  write(file, JSON.stringify(findings));
  ok(['task', 'verify', id]);
  ok(['task', 'done', id]);
}

test('hardening is off for a project that has not adopted it: nothing changes', () => {
  const a = shipFeature();
  assert.strictEqual(a.code, 0, a.out);
  assert.match(a.out, /🏁 Release .* is complete/);
  assert.match(forge(['release', 'harden', 'mvp']).out, /Hardening is off for this project/);
  assert.doesNotMatch(forge(['release', 'tag', 'mvp']).out, /hardening milestone/);
});

test('with hardening on, a finished release is told to harden; tag refuses without it, and never skips it on the first release', () => {
  ok(['config', 'set', 'options.hardening', 'on']);
  const a = shipFeature();
  assert.strictEqual(a.code, 0, a.out);
  assert.match(a.out, /🛡️ .*forge release harden mvp/);
  const s = JSON.parse(ok(['status', '--json']).stdout);
  assert.ok(s.needsYou.some(n => n.kind === 'hardening-due' && n.release === 'mvp'));
  assert.match(forge(['release', 'tag', 'mvp']).out, /has no hardening milestone .*forge release harden mvp/s);
  assert.match(forge(['release', 'tag', 'mvp', '--skip-hardening']).out, /needs --reason/);
  assert.match(forge(['release', 'tag', 'mvp', '--skip-hardening', '--reason', 'x']).out, /first tagged release, and it cannot ship without its security audit/);
  assert.match(forge(['release', 'harden', 'mvp', '--tracks', 'cleanup']).out, /security audit cannot be left out/);
  assert.match(forge(['release', 'harden', 'mvp', '--tracks', 'nope']).out, /unknown track\(s\) nope/);
});

test('release harden adds the last milestone of the release with one audit task per track and an audit brief', () => {
  ok(['config', 'set', 'options.hardening', 'on']);
  shipFeature();
  write('package.json', JSON.stringify({ name: 'x', dependencies: { react: '18.0.0' } }));
  write('public/robots.txt', 'User-agent: *\n');
  const h = ok(['release', 'harden', 'mvp']);
  assert.match(h.out, /harden-mvp added as the last milestone of release mvp: cleanup .*security .*modern-web .*seo .*ui/);
  assert.match(h.out, /the whole codebase/);
  const w = work();
  assert.strictEqual(w.milestones['harden-mvp'].release, 'mvp');
  assert.deepStrictEqual(w.milestones['harden-mvp'].hardening.tracks, ['cleanup', 'security', 'modern-web', 'seo', 'ui']);
  assert.strictEqual(w.milestoneOrder[w.milestoneOrder.indexOf('m1') + 1], 'harden-mvp');
  const t = w.items['harden-mvp-security'];
  assert.strictEqual(t.origin, 'audit');
  assert.deepStrictEqual(t.audit, { release: 'mvp', track: 'security' });
  assert.deepStrictEqual(t.scope.allowed, ['forge/audits/mvp/security.json']);
  const b = ok(['brief', 'harden-mvp-security']).out;
  assert.match(b, /# Audit brief — harden-mvp-security: security \(release mvp\)/);
  assert.match(b, /READ-ONLY/);
  assert.match(b, /PRODUCTION CONFIGURATION/);
  assert.match(b, /forge\/audits\/mvp\/security\.json/);
  assert.match(b, /on the security model/);
  assert.match(ok(['brief', 'harden-mvp-ui']).out, /ui-direction/);
  assert.match(forge(['release', 'harden', 'mvp']).out, /already has its hardening milestone/);
});

test('audits, the findings list, triage into fix tasks (cleanup first), and the gates', () => {
  ok(['config', 'set', 'options.hardening', 'on']);
  shipFeature();
  ok(['release', 'harden', 'mvp']); // no package.json: cleanup + security
  assert.deepStrictEqual(work().milestones['harden-mvp'].hardening.tracks, ['cleanup', 'security']);
  // an invalid findings file does not pass the audit's check
  ok(['task', 'start', 'harden-mvp-cleanup']);
  write('forge/audits/mvp/cleanup.json', JSON.stringify([{ id: 'c1', issue: 'x', impact: 'urgent' }]));
  assert.notStrictEqual(forge(['task', 'verify', 'harden-mvp-cleanup']).code, 0);
  write('forge/audits/mvp/cleanup.json', JSON.stringify([
    { id: 'c1', file: 'src/a.js', line: 10, issue: 'helper duplicated from src/lib', impact: 'medium', effort: 'S', fix: 'use src/lib/units' },
    { id: 'c2', file: 'src/b.js', line: 1, issue: 'unused export', impact: 'low' }]));
  ok(['task', 'verify', 'harden-mvp-cleanup']); ok(['task', 'done', 'harden-mvp-cleanup']);
  assert.match(forge(['audit', 'triage', 'mvp', '--accept', 'floor']).out, /not all done yet/);
  assert.match(ok(['audit', 'list', 'mvp']).out, /Audits still running: harden-mvp-security/);
  finishAudit('harden-mvp-security', 'forge/audits/mvp/security.json', [
    { id: 's1', file: 'src/a.js', line: 12, issue: 'query built from user input', impact: 'high', fix: 'parameterise' },
    { id: 's2', issue: 'WAF rules on production never checked', impact: 'critical', fix: 'confirm bot rules' }]);
  // the same spot flagged twice is one finding, at the higher impact
  const L = JSON.parse(ok(['audit', 'list', 'mvp', '--json']).stdout);
  assert.strictEqual(L.auditsDone, true);
  assert.deepStrictEqual(L.findings.map(g => [g.key, g.impact, g.keys.length]), [['security:s2', 'critical', 1], ['cleanup:c1', 'high', 2], ['cleanup:c2', 'low', 1]]);
  assert.strictEqual(L.findings[1].issue, 'query built from user input');
  assert.match(ok(['audit', 'list', 'mvp']).out, /\[critical\] security:s2 — WAF rules/);
  const s = JSON.parse(ok(['status', '--json']).stdout);
  assert.ok(s.needsYou.some(n => n.kind === 'audit-triage' && n.count === 3));
  // the milestone looks finished, but it cannot be approved before triage
  assert.match(forge(['milestone', 'approve', 'harden-mvp']).out, /3 audit finding\(s\) of release mvp are not triaged/);
  // cap, dismiss without reason, unknown keys
  ok(['config', 'set', 'options.hardeningCap', '1']);
  assert.match(forge(['audit', 'triage', 'mvp', '--accept', 'floor']).out, /would exceed options\.hardeningCap 1/);
  ok(['config', 'set', 'options.hardeningCap', '25']);
  assert.match(forge(['audit', 'triage', 'mvp', '--dismiss', 'cleanup:c2']).out, /--dismiss needs --reason/);
  assert.match(forge(['audit', 'triage', 'mvp', '--accept', 'nope:1']).out, /No finding 'nope:1'/);
  // accept everything at or above the floor (medium): two fix tasks, cleanup first
  const t = ok(['audit', 'triage', 'mvp', '--accept', 'floor']);
  assert.match(t.out, /2 accepted → harden-mvp-fix-1, harden-mvp-fix-2 · 0 deferred · 0 dismissed · 1 undecided/);
  const w = work();
  const f1 = w.items['harden-mvp-fix-1'], f2 = w.items['harden-mvp-fix-2'];
  assert.strictEqual(f1.parent, 'harden-mvp-cleanup');
  assert.strictEqual(f1.origin, 'audit');
  assert.deepStrictEqual(f1.scope.allowed, ['src/']);
  assert.match(f1.objective, /Behaviour must not change/);
  assert.strictEqual(f2.parent, 'harden-mvp-security');
  assert.deepStrictEqual(f2.domains, ['security']);
  assert.deepStrictEqual(f2.scope.allowed, []);
  const ord = w.milestones['harden-mvp'].taskOrder;
  assert.ok(ord.indexOf('harden-mvp-fix-1') > ord.indexOf('harden-mvp-security') && ord.indexOf('harden-mvp-fix-1') < ord.indexOf('harden-mvp-fix-2'));
  assert.strictEqual(w.audits.mvp.decisions['security:s1'].task, 'harden-mvp-fix-1'); // merged keys share the decision
  assert.match(forge(['audit', 'triage', 'mvp', '--accept', 'cleanup:c1']).out, /already decided/);
  ok(['audit', 'triage', 'mvp', '--dismiss', 'cleanup:c2', '--reason', 'kept for the public API']);
  assert.match(ok(['audit', 'list', 'mvp']).out, /cleanup:c2 .*→ dismissed \(kept for the public API\)/);
  assert.ok(!JSON.parse(ok(['status', '--json']).stdout).needsYou.some(n => n.kind === 'audit-triage'));
  // the release still cannot be tagged until its hardening milestone is approved
  assert.match(forge(['release', 'tag', 'mvp']).out, /unapproved: harden-mvp/);
});
