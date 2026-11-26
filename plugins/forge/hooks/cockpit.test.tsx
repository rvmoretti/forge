import { expect, test } from 'claude-code/testing'

import type { Snapshot } from '../types'

// What `forge status --json` answers in these tests.
const SNAP: Snapshot = {
  schema: 2, forge: '0.32.0', project: 'demo', phase: 'build',
  counts: { TODO: 1, IN_PROGRESS: 1, BLOCKED: 1, DONE: 2, CANCELLED: 1, READY: 1 },
  milestone: { id: 'cart', name: 'Customers can pay', total: 5, counts: { TODO: 1, IN_PROGRESS: 1, BLOCKED: 1, DONE: 2, CANCELLED: 0 } },
  inProgress: [{ id: 'cart-4', title: 'Checkout totals', worker: { agent: 'forge-implementer', since: '2026-11-20T10:00:00Z' } }],
  verify: null,
  autopilot: { on: true, next: 'cart-5', stop: null },
  questions: [{ id: 'cart-3', title: 'Add-ons', question: 'Mock or spec?', since: null,
    options: [{ key: 'mock', label: '3 add-ons', recommended: false }, { key: 'spec', label: '2 add-ons', recommended: true }] }],
  notes: [{ n: 1, text: 'keep totals in cents', for: 'next task' }],
  needsYou: [{ kind: 'question', item: 'cart-3', text: 'Mock or spec?' }],
  tasks: [
    { id: 'cart-1', title: 'Cart page', status: 'DONE', stage: 'done', origin: 'plan', criteria: 3, starts: 1, failedAttempts: 0, lastVerify: { passed: true, ts: 'x' }, blockReason: null },
    { id: 'cart-4', title: 'Checkout totals', status: 'IN_PROGRESS', stage: 'implement', origin: 'split', criteria: 2, starts: 1, failedAttempts: 0, lastVerify: null, blockReason: null, worker: 'forge-implementer' },
    { id: 'cart-9', title: 'Old idea', status: 'CANCELLED', stage: 'cancelled', origin: 'plan', criteria: 1, starts: 0, failedAttempts: 0, lastVerify: null, blockReason: null },
  ],
  milestones: [
    { id: 'm0', name: 'Setup', release: 'mvp', total: 3, counts: { DONE: 3 }, origins: { plan: 3 }, approved: true, hardening: false },
    { id: 'cart', name: 'Customers can pay', release: 'mvp', total: 5, counts: { DONE: 2 }, origins: { plan: 3, split: 2 }, approved: false, hardening: false },
  ],
  config: [{ key: 'hardening', value: 'on', default: 'on', group: 'Hardening', what: 'v0.27: every release ends hardened', change: 'forge config set options.hardening off', risk: 'low' }],
  gate: { milestone: 'cart', name: 'Customers can pay', done: 2, total: 5, complete: false, gateAt: 'ship', hasGate: true,
    fullRun: { state: 'red', ts: '2026-11-26T09:12:00Z', failed: ['gate:e2e'] }, security: null, securityOff: false, approved: false, ship: null, perMilestone: true },
  recent: [{ ts: '2026-11-26T09:30:00Z', text: 'cart-1 closed', tone: 'good' }, { ts: '2026-11-26T09:40:00Z', text: 'cart-4 started', tone: 'info' }],
}
const BAND = { plugin: 'forge', component: 'AbovePrompt', props: { hasSurvey: false, isCollapsed: false, isWorking: false, maxRows: 10, bodyColumns: 120, scroll: { offset: 0, bodyRows: 10 }, view: {} } } as const
const PANE = {
  plugin: 'forge', component: 'Pane', requestId: 'forge',
  props: { title: 'Forge', isFocused: true, bodyColumns: 120, placement: 'dock', scroll: { offset: 0, bodyRows: 60 }, view: {} },
} as const

const RUN = { origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 120 } } as const

// The engine beneath the mod: a Forge project whose CLI answers SNAP, and records every other forge command.
function engine(on: any, ran: string[][], opts: { forgeProject?: boolean; snap?: Snapshot } = {}) {
  on('command.register', () => ({ value: { command: 'forge' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_: unknown, e: any) => ({ cwd: e.cwd }))
  on('fs.stat', () => {
    if (opts.forgeProject === false) throw new Error('ENOENT')
    return { value: { isFile: true, isDirectory: false, size: 10, mtimeMs: 0 } }
  })
  on('agent.list', () => ({ value: [{ id: 'ag1', type: 'forge:forge-implementer', description: 'Implement cart-4 checkout totals', status: 'running', kind: 'local_agent',
    taskStatus: 'running', label: 'x', startTime: 0, cwd: '/p', tokenCount: 41000, tokenSamples: [], hasRow: true, model: 'claude-sonnet-5-5' }] }))
  on('process.run', (_: unknown, e: any) => {
    const args = e.argv.slice(2)
    if (args[0] === 'status') return { value: { exitCode: 0, stdout: JSON.stringify(opts.snap ?? SNAP), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    ran.push(args)
    return { value: { exitCode: 0, stdout: `ran: ${args.join(' ')}\n`, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('tool.call', () => ({ result: { text: 'ok' } }))
  on('ui.toast', () => ({ value: undefined }))
  on('clock.now', () => ({ value: Date.now() }))
  on('clock.every', () => ({ value: {} }))
}

test('the band: milestone, work in progress, what needs you, autopilot — and the question on its own line', async ($, on) => {
  engine(on, [])
  await $.session.start({ cwd: '/p', surface: 'terminal', isInteractive: true })
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })
    expect((await ui.find({ type: 'Text', text: /^FORGE$/ }))?.text).toBe('FORGE')
    expect((await ui.find({ type: 'Text', text: /cart 2\/5/ }))?.text).toBe('cart 2/5')
    expect((await ui.find({ type: 'Text', text: /cart-4/ }))?.text).toBe('│ ▸ cart-4')
    expect((await ui.find({ type: 'Text', text: /needs you/ }))?.text).toBe('│ ◆ 1 needs you')
    expect((await ui.find({ type: 'Text', text: /decision/ }))?.text).toBe('◆ Forge needs a decision: Mock or spec? — /forge to answer')
    await ui.unmount()
  }
})

test('a narrow band drops the least important parts first and keeps what needs you', async ($, on) => {
  engine(on, [])
  await $.session.start({ cwd: '/p', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal', props: { ...BAND.props, bodyColumns: 44 } })
  expect(await ui.find({ type: 'Text', text: /autopilot/ })).toBeUndefined()
  expect((await ui.find({ type: 'Text', text: /needs you/ }))?.text).toMatch(/◆ 1 needs you/)
  await ui.unmount()
})

test('Now: what is happening in plain words, the question with one button per answer, what happened', async ($, on) => {
  const ran: string[][] = []
  engine(on, ran)
  await $.session.start({ cwd: '/p', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /^Milestone/ }))?.text).toBe('Milestone Customers can pay (cart): 2 of 5 tasks done.')
  expect((await ui.find({ type: 'Text', text: /in progress:/ }))?.text).toBe('1 task is in progress: cart-4.')
  expect((await ui.find({ type: 'Text', text: /Autopilot/ }))?.text).toBe('Autopilot is on: next up cart-5.')
  expect((await ui.find({ type: 'Text', text: /cart-1 closed/ }))?.text).toBe('09:30  cart-1 closed')
  await ui.press({ key: 'q-cart-3-spec' })
  expect(ran).toEqual([['question', 'answer', 'cart-3', '--choice', 'spec']])
  await ui.unmount()
})

test('Tasks: aligned rows in plain steps, cancelled tasks folded away', async ($, on) => {
  engine(on, [])
  await $.session.start({ cwd: '/p', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'view-tasks' })
  expect((await ui.find({ type: 'Text', text: /cart-4 +Checkout/ }))?.text).toMatch(/^building +cart-4 +Checkout totals +forge-implementer/)
  expect((await ui.find({ type: 'Text', text: /→/ }))?.text).toBe('building 1  →  done 1')
  expect((await ui.find({ type: 'Text', text: /cancelled/ }))?.text).toBe('1 cancelled task not shown')
  expect(await ui.find({ type: 'Text', text: /Old idea/ })).toBeUndefined()
  await ui.unmount()
})

test('Running: each worker on its task, its calls in plain words', async ($, on) => {
  engine(on, [])
  await $.session.start({ cwd: '/p', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: 'Bash', command: 'cd /opt/p && forge() { node /x/forge.js "$@"; }; S=/tmp/a; forge task verify cart-4 2>&1 | tail -5' })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'view-running' })
  expect((await ui.find({ type: 'Text', text: /→ cart-4/ }))?.text).toBe('forge-implementer → cart-4')
  expect((await ui.find({ type: 'Text', text: /41k tokens/ }))?.text).toMatch(/^running · .* · 41k tokens · claude-sonnet-5-5$/)
  expect((await ui.find({ type: 'Text', text: /forge task verify/ }))?.text).toBe('now  forge task verify cart-4')
  await ui.unmount()
})

test('Gate: the way out in order — a red full run says what failed and what happens next', async ($, on) => {
  engine(on, [])
  await $.session.start({ cwd: '/p', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'view-gate' })
  expect((await ui.find({ type: 'Text', text: /Tasks/ }))?.text).toMatch(/^▸ Tasks +2 of 5 closed$/)
  expect((await ui.find({ type: 'Text', text: /Full test run/ }))?.text).toMatch(/^✗ Full test run +failed at 09:12: gate:e2e — fix it; the next run re-runs only what failed$/)
  expect((await ui.find({ type: 'Text', text: /Ship/ }))?.text).toMatch(/forge milestone ship cart — needs the full test run green/)
  await ui.unmount()
})

test('Project: the headline, now and next with progress bars, approved ones folded', async ($, on) => {
  engine(on, [])
  await $.session.start({ cwd: '/p', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'view-project' })
  expect((await ui.find({ type: 'Text', text: /milestones approved/ }))?.text).toBe('1 of 2 milestones approved · 8 tasks, 25% added after planning · 1 open question')
  expect((await ui.find({ type: 'Text', text: /Customers can pay +█/ }))?.text).toMatch(/^▸ Customers can pay +█+░+ +2\/5 +\[mvp\] +grew: split 2$/)
  expect((await ui.find({ type: 'Text', text: /^Approved/ }))?.text).toBe('Approved: m0')
  await ui.unmount()
})

test('Steer: pause autopilot, queue a note by typing, drop one', async ($, on) => {
  const ran: string[][] = []
  engine(on, ran)
  await $.session.start({ cwd: '/p', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'view-steer' })
  await ui.press({ key: 'ap-off' })
  await ui.input({ key: 'note', text: 'use the shared Price component' })
  await ui.press({ key: 'note-drop-1' })
  expect(ran).toEqual([['autopilot', 'off', '--reason', 'paused from the cockpit'], ['note', 'add', 'use the shared Price component'], ['note', 'drop', '1']])
  await ui.unmount()
})

test('Config: a switch toggles with one forge command', async ($, on) => {
  const ran: string[][] = []
  engine(on, ran)
  await $.session.start({ cwd: '/p', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'view-config' })
  await ui.press({ key: 'cfg-hardening-toggle' })
  expect(ran).toEqual([['config', 'set', 'options.hardening', 'off']])
  await ui.unmount()
})

test('/forge note adds a note for the next task; /forge status answers for the person only', async ($, on) => {
  const ran: string[][] = []
  engine(on, ran)
  await $.session.start({ cwd: '/p', surface: 'terminal', isInteractive: true })
  const r = await $.command.run({ ...RUN, command: 'forge', args: 'note keep totals in cents' })
  expect(ran).toEqual([['note', 'add', 'keep totals in cents']])
  expect(r.isTextDisplayOnly).toBe(true)
  const st = await $.command.run({ ...RUN, command: 'forge', args: 'status' })
  expect(st.text).toBe('• Mock or spec?')
  expect(st.context).toBeUndefined()
})

test('a tool call passes through untouched', async ($, on) => {
  engine(on, [])
  await $.session.start({ cwd: '/p', surface: 'terminal', isInteractive: true })
  const r = await $.tool.call({ tool: 'Bash', command: 'ls' })
  expect((r as any).result).toEqual({ text: 'ok' })
})

test('outside a Forge project the cockpit draws nothing', async ($, on) => {
  engine(on, [], { forgeProject: false })
  on('ui.render', ($: any, e: any) => { const { Text } = $.ui.resolve(e); return <Text>engine</Text> })
  await $.session.start({ cwd: '/p', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /engine/ }))?.text).toBe('engine')
  await ui.unmount()
})

test('turned off in the plugin settings, it registers nothing', { options: { cockpit: false } }, async ($, on) => {
  engine(on, [])
  on('ui.render', ($: any, e: any) => { const { Text } = $.ui.resolve(e); return <Text>engine</Text> })
  await $.session.start({ cwd: '/p', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /engine/ }))?.text).toBe('engine')
  await ui.unmount()
})
