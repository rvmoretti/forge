import { expect, test } from 'claude-code/testing'

import type { Snapshot } from '../types'

// What `forge status --json` answers in these tests.
const SNAP: Snapshot = {
  schema: 1, forge: '0.28.0', project: 'demo', phase: 'build',
  counts: { TODO: 1, IN_PROGRESS: 1, BLOCKED: 1, DONE: 2, CANCELLED: 0, READY: 1 },
  milestone: { id: 'cart', total: 5, counts: { TODO: 1, IN_PROGRESS: 1, BLOCKED: 1, DONE: 2, CANCELLED: 0 } },
  inProgress: [{ id: 'cart-4', title: 'Checkout totals', worker: { agent: 'forge-implementer', since: '2026-11-20T10:00:00Z' } }],
  verify: null,
  autopilot: { on: true, next: 'cart-5', stop: null },
  questions: [{ id: 'cart-3', title: 'Add-ons', question: 'Mock or spec?', since: null,
    options: [{ key: 'mock', label: '3 add-ons', recommended: false }, { key: 'spec', label: '2 add-ons', recommended: true }] }],
  notes: [],
  needsYou: [{ kind: 'question', item: 'cart-3', text: 'Mock or spec?' }],
  tasks: [
    { id: 'cart-1', title: 'Cart page', status: 'DONE', stage: 'done', origin: 'plan', criteria: 3, starts: 1, failedAttempts: 0, lastVerify: { passed: true, ts: 'x' }, blockReason: null },
    { id: 'cart-4', title: 'Checkout totals', status: 'IN_PROGRESS', stage: 'implement', origin: 'split', criteria: 2, starts: 1, failedAttempts: 0, lastVerify: null, blockReason: null },
  ],
  milestones: [{ id: 'cart', name: 'Customers can pay', release: 'mvp', total: 5, counts: { DONE: 2 }, origins: { plan: 3, split: 2 }, approved: false, hardening: false }],
  config: [{ key: 'hardening', value: 'on', default: 'on', group: 'Hardening', what: 'v0.27: every release ends hardened', change: 'forge config set options.hardening off', risk: 'low' }],
}
const BAND = { plugin: 'forge', component: 'AbovePrompt', props: { hasSurvey: false, isCollapsed: false, isWorking: false, maxRows: 10, bodyColumns: 120, scroll: { offset: 0, bodyRows: 10 }, view: {} } } as const
const PANE = {
  plugin: 'forge', component: 'Pane', requestId: 'forge',
  props: { title: 'Forge', isFocused: true, bodyColumns: 100, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
} as const

const RUN = { origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 120 } } as const

// The engine beneath the mod: a Forge project whose CLI answers SNAP, and records every other forge command.
function engine(on: any, ran: string[][], opts: { forgeProject?: boolean } = {}) {
  on('command.register', () => ({ value: { command: 'forge' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_: unknown, e: any) => ({ cwd: e.cwd }))
  on('fs.stat', () => {
    if (opts.forgeProject === false) throw new Error('ENOENT')
    return { value: { isFile: true, isDirectory: false, size: 10, mtimeMs: 0 } }
  })
  on('agent.list', () => ({ value: [{ id: 'ag1', type: 'forge-implementer', description: 'Checkout totals', status: 'running', kind: 'local_agent',
    taskStatus: 'running', label: 'x', startTime: 0, cwd: '/p', tokenCount: 41000, tokenSamples: [], hasRow: true, model: 'claude-sonnet-5-5' }] }))
  on('process.run', (_: unknown, e: any) => {
    const args = e.argv.slice(2)
    if (args[0] === 'status') return { value: { exitCode: 0, stdout: JSON.stringify(SNAP), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    ran.push(args)
    return { value: { exitCode: 0, stdout: `ran: ${args.join(' ')}\n`, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('tool.call', () => ({ result: { text: 'ok' } }))
  on('ui.toast', () => ({ value: undefined }))
  on('clock.now', () => ({ value: Date.now() }))
  on('clock.every', () => ({ value: {} }))
}

test('the band shows the milestone, the work in progress and what needs the owner, on every surface', async ($, on) => {
  engine(on, [])
  await $.session.start({ cwd: '/p', surface: 'terminal', isInteractive: true })
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })
    expect((await ui.find({ type: 'Text', text: /^FORGE$/ }))?.text).toBe('FORGE')
    expect((await ui.find({ type: 'Text', text: /cart 2\/5/ }))?.text).toBe('cart 2/5')
    expect((await ui.find({ type: 'Text', text: /cart-4/ }))?.text).toBe('▸ cart-4 (forge-implementer)')
    expect((await ui.find({ type: 'Text', text: /needs you/ }))?.text).toBe('◆ 1 needs you')
    await ui.unmount()
  }
})

test('a question is answered from the pane with one forge command', async ($, on) => {
  const ran: string[][] = []
  engine(on, ran)
  await $.session.start({ cwd: '/p', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /Mock or spec\?/ }))?.text).toBe('Mock or spec?')
  await ui.press({ key: 'q-cart-3-spec' })
  expect(ran).toEqual([['question', 'answer', 'cart-3', '--choice', 'spec']])
  await ui.press({ key: 'ap-off' })
  expect(ran[1]).toEqual(['autopilot', 'off', '--reason', 'stopped from the cockpit'])
  await ui.unmount()
})

test('the tasks, workers, project and config views draw from the snapshot and the session agents', async ($, on) => {
  const ran: string[][] = []
  engine(on, ran)
  await $.session.start({ cwd: '/p', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: 'Bash', command: 'npm test' })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'view-tasks' })
  expect((await ui.find({ type: 'Text', text: /cart-4 {2}Checkout totals/ }))?.text).toMatch(/^implement +cart-4 {2}Checkout totals .* · split$/)
  expect((await ui.find({ type: 'Text', text: /→/ }))?.text).toBe('implement 1  →  done 1')
  await ui.press({ key: 'view-workers' })
  expect((await ui.find({ type: 'Text', text: /41k tokens/ }))?.text).toMatch(/^forge-implementer · running · .* · 41k tokens · claude-sonnet-5-5$/)
  expect((await ui.find({ type: 'Text', text: /Bash npm test/ }))?.text).toMatch(/ago {2}Bash npm test$/)
  await ui.press({ key: 'view-project' })
  expect((await ui.find({ type: 'Text', text: /\[mvp\]/ }))?.text).toBe('▸ cart [mvp]  2/5  +split 2')
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
