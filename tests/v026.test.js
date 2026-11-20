'use strict';
/**
 * v0.26 — forge ci checks: which deterministic checks CI runs (secrets, dependency audit,
 * findings for the hardening milestone) and a separate workflow holding only the missing ones.
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
function write(rel, text) { const f = path.join(dir, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); }
const WF = '.github/workflows/forge-checks.yml';
const read = rel => fs.readFileSync(path.join(dir, rel), 'utf8');

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-v026-'));
  spawnSync('git', ['init', '-q'], { cwd: dir });
});

test('ci checks with no workflows: everything missing for a Node project; --write writes all three jobs', () => {
  write('package.json', JSON.stringify({ name: 'x', dependencies: { react: '18.0.0' } }));
  write('package-lock.json', '{}');
  const r = forge(['ci', 'checks']);
  assert.strictEqual(r.code, 0, r.out);
  assert.match(r.out, /no workflows in \.github\/workflows/);
  assert.match(r.out, /secrets: MISSING/);
  assert.match(r.out, /dependency audit: MISSING/);
  assert.match(r.out, /\(knip, legacy-scan\): MISSING/);
  assert.match(r.out, /forge ci checks --write --release-branch main/);
  assert.ok(!fs.existsSync(path.join(dir, WF)), 'without --write nothing is written');
  const w = forge(['ci', 'checks', '--write']);
  assert.strictEqual(w.code, 0, w.out);
  const y = read(WF);
  assert.match(y, /^ {2}secrets:$/m);
  assert.match(y, /gitleaks_\$\{V\}_linux_x64\.tar\.gz/);
  assert.match(y, /sha256sum -c -/);
  assert.match(y, /\.\/gitleaks git --redact --no-banner \./);
  assert.match(y, /^ {2}audit:$/m);
  assert.match(y, /npm ci --ignore-scripts/);
  assert.match(y, /npm audit --omit=dev --audit-level=critical/);
  assert.match(y, /^ {2}findings:$/m);
  assert.match(y, /continue-on-error: true/);
  assert.match(y, /if: github\.event_name == 'push' \|\| github\.base_ref == 'main'/);
  assert.match(y, /npx --yes knip@\d+\.\d+\.\d+ --reporter json > forge-findings\/knip\.json \|\| true/);
  assert.match(y, /modern-web-guidance@\d+\.\d+\.\d+ legacy-scan \. --json/);
  assert.match(y, /name: forge-findings/);
  // the written workflow satisfies the check
  assert.match(forge(['ci', 'checks']).out, /Nothing to add/);
});

test('ci checks writes only what the existing workflows lack, and never edits them', () => {
  write('package.json', JSON.stringify({ name: 'x' }));
  write('package-lock.json', '{}');
  const own = 'name: CI\non: [pull_request]\njobs:\n  s:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: gitleaks/gitleaks-action@v3\n      - run: npm audit --audit-level=high\n';
  write('.github/workflows/ci.yml', own);
  const r = forge(['ci', 'checks']);
  assert.match(r.out, /secrets: present in \.github\/workflows\/ci\.yml/);
  assert.match(r.out, /dependency audit: present in \.github\/workflows\/ci\.yml/);
  assert.match(r.out, /\(knip\): MISSING/); // no frontend: no legacy-scan
  forge(['ci', 'checks', '--write', '--release-branch', 'production']);
  const y = read(WF);
  assert.doesNotMatch(y, /^ {2}secrets:$/m);
  assert.doesNotMatch(y, /^ {2}audit:$/m);
  assert.match(y, /^ {2}findings:$/m);
  assert.doesNotMatch(y, /legacy-scan/);
  assert.match(y, /branches: \[production\]/);
  assert.match(y, /github\.base_ref == 'production'/);
  assert.match(y, /npm ci --ignore-scripts/);
  assert.strictEqual(read('.github/workflows/ci.yml'), own);
});

test('a hand-edited forge-checks.yml is not overwritten without --force', () => {
  write('package.json', JSON.stringify({ name: 'x' }));
  write(WF, 'name: Forge checks\njobs: {}\n');
  const r = forge(['ci', 'checks', '--write']);
  assert.notStrictEqual(r.code, 0);
  assert.match(r.out, /edited by hand.*--force/);
  assert.strictEqual(read(WF), 'name: Forge checks\njobs: {}\n');
  assert.strictEqual(forge(['ci', 'checks', '--write', '--force']).code, 0);
  assert.match(read(WF), /^ {2}secrets:$/m);
  assert.match(read(WF), /npm install --ignore-scripts/); // no lockfile
});

test('other stacks: no audit written for a pnpm lockfile or a non-Node project; secrets always', () => {
  write('package.json', JSON.stringify({ name: 'x' }));
  write('pnpm-lock.yaml', '');
  let r = forge(['ci', 'checks']);
  assert.match(r.out, /pnpm-lock\.yaml found — Forge writes npm audit only/);
  forge(['ci', 'checks', '--write']);
  assert.doesNotMatch(read(WF), /^ {2}audit:$/m);
  assert.match(read(WF), /^ {2}secrets:$/m);
  fs.rmSync(path.join(dir, 'package.json')); fs.rmSync(path.join(dir, 'pnpm-lock.yaml')); fs.rmSync(path.join(dir, WF));
  write('pyproject.toml', '[project]\nname="x"\n');
  r = forge(['ci', 'checks']);
  assert.match(r.out, /npm projects only/);
  forge(['ci', 'checks', '--write']);
  const y = read(WF);
  assert.match(y, /^ {2}secrets:$/m);
  assert.doesNotMatch(y, /^ {2}(audit|findings):$/m);
});

test('ci checks --json reports the state; preflight warns about missing blocking checks', () => {
  write('package.json', JSON.stringify({ name: 'x' }));
  write('.github/workflows/ci.yml', 'name: CI\non: [push]\njobs: {}\n');
  const j = JSON.parse(forge(['ci', 'checks', '--json']).stdout);
  assert.deepStrictEqual(j.workflows, ['.github/workflows/ci.yml']);
  assert.deepStrictEqual(j.missing, ['secrets', 'audit', 'findings']);
  assert.strictEqual(j.releaseBranch, 'main');
  forge(['init', '--project', 'test']);
  forge(['config', 'set', 'phase', 'build']);
  forge(['config', 'set', 'verify.test', 'node -e "process.exit(0)"']);
  forge(['config', 'set', 'options.graphify', 'skip']);
  const p = forge(['preflight']);
  assert.match(p.out, /WARN {2}ci checks: secrets: none · dependency audit: none · findings: none — add them: forge ci checks --write/);
  forge(['ci', 'checks', '--write']);
  assert.match(forge(['preflight']).out, /OK {4}ci checks: secrets: \.github\/workflows\/forge-checks\.yml/);
  assert.match(forge(['ci']).out, /Usage: forge ci checks/);
});
