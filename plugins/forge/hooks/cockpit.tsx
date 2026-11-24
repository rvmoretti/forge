// Forge cockpit (v0.28): Forge inside Claude Code — a band above the prompt, a /forge pane, notices when Forge
// needs the owner. Its rules, which the cockpit test holds it to:
//   - It reads `forge status --json` (no lock, no trace) and this session's agents; it never writes state itself.
//   - Its only actions are the owner's clicks, each one `forge` CLI command (answer a question, set a switch,
//     stop autopilot, add a note) — the CLI validates and records them like any other.
//   - Nothing reaches the model: no prompt sections, no injected context, no permission decisions.
//   - Its tool.call hook only notes the call for the Workers view and hands it on at once.
//   - userConfig `cockpit: false` turns all of it off; Forge itself works the same without it.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Call, Snapshot, View, Worker } from '../types'

const PANE = 'forge'
const POLL_MS = 4000
const snapshot = atom({ plugin: 'forge', key: 'snapshot' } as const, null, { shape: 'snapshot-1' })
const calls = atom({ plugin: 'forge', key: 'calls' } as const, {}, { shape: 'calls-1' })
const workers = atom({ plugin: 'forge', key: 'workers' } as const, [], { shape: 'workers-1' })
const view = atom({ plugin: 'forge', key: 'view' } as const, 'overview')
const flash = atom({ plugin: 'forge', key: 'flash' } as const, null)

const VIEWS: { id: View; label: string }[] = [
  { id: 'overview', label: 'Needs you' },
  { id: 'tasks', label: 'Tasks' },
  { id: 'workers', label: 'Workers' },
  { id: 'project', label: 'Project' },
  { id: 'config', label: 'Config' },
]
const STAGES = ['todo', 'brief', 'cto', 'prepare', 'implement', 'test', 'verify', 'review', 'done']
const STAGE_LABEL: Record<string, string> = {
  todo: 'to do', brief: 'brief', cto: 'CTO', prepare: 'prepare', implement: 'implement', test: 'test',
  verify: 'verify', review: 'review', done: 'done', blocked: 'blocked', cancelled: 'cancelled',
}

function short(text: string, n: number): string {
  const t = text.replace(/\s+/g, ' ').trim()
  return t.length > n ? `${t.slice(0, Math.max(1, n - 1))}…` : t
}
function ago(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.round(s / 60)}m` : `${(s / 3600).toFixed(1)}h`
}
function kTokens(n: number): string {
  return n >= 1000 ? `${Math.round(n / 1000)}k` : String(n)
}
// What a tool call was about, in a few words: the command, the file, the pattern or the task.
function callWhat(e: Record<string, unknown>): string {
  for (const k of ['command', 'file_path', 'pattern', 'description', 'url', 'query']) {
    const v = e[k]
    if (typeof v === 'string' && v) return v
  }
  return ''
}
// A button's work runs after the press returns: its failure is reported, never left unhandled.
function quiet(p: Promise<unknown>): void {
  p.catch(() => undefined)
}
function isToggle(v: unknown): v is string | boolean {
  return v === true || v === false || v === 'on' || v === 'off' || v === 'true' || v === 'false'
}
function toggled(v: string | boolean): string {
  return v === true || v === 'true' ? 'false' : v === false || v === 'false' ? 'true' : v === 'on' ? 'off' : 'on'
}

// The project folder: session.start sets it, and sets it again after a reload.
let cwd = ''
// Every action and every read goes through the forge CLI, run from the project folder.
async function forge($: EngineInterface, args: string[]) {
  return $.process.run(['node', `${$.plugin.root}/bin/forge.js`, ...args], { cwd, timeoutMs: 20000 })
}

export const register: Register = (on, options) => {
  if (options.cockpit === false) return
  let seen = new Set<string>()

  on('session.start', async ($, e, next) => {
    cwd = e.cwd
    await $.command.register({
      name: 'forge',
      description: 'Forge cockpit: open the pane, or `/forge note <text>` for the next task',
      argumentHint: '[note <text> | status]',
      immediate: true,
    })
    const refresh = async () => {
      let snap: Snapshot | null = null
      try {
        await $.fs.stat(`${cwd}/forge/config.json`)
        const r = await forge($, ['status', '--json'])
        if (r.exitCode === 0) snap = JSON.parse(r.stdout) as Snapshot
      } catch {
        snap = null // not a Forge project, or Forge could not answer: draw nothing
      }
      await update($, snapshot, () => snap)
      if (!snap) return
      // A notice once per new thing that needs the owner.
      const now = new Set(snap.needsYou.map(n => `${n.kind}:${n.item ?? n.release ?? n.session ?? ''}`))
      for (const n of snap.needsYou) {
        const k = `${n.kind}:${n.item ?? n.release ?? n.session ?? ''}`
        if (!seen.has(k) && n.kind !== 'claude') $.ui.toast(`Forge: ${short(n.text, 120)}`)
      }
      seen = now
      const agents = await $.agent.list()
      const live = (st: string) => ['running', 'pending', 'waiting'].includes(st)
      const list: Worker[] = agents
        .map(a => ({ id: a.id, type: a.type, description: a.description, status: a.status, tokens: a.tokenCount,
          model: a.model ?? a.usage?.[a.usage.length - 1]?.model ?? null, startTime: a.startTime }))
        .sort((a, b) => Number(live(b.status)) - Number(live(a.status)) || b.startTime - a.startTime)
        .slice(0, 12)
      await update($, workers, () => list)
    }
    await refresh()
    $.clock.every(POLL_MS, () => quiet(refresh()))
    return next(e)
  })

  // Observe only: note the call for the Workers view, hand it on at once, never wait on the note.
  on('tool.call', ($, e, next) => {
    const ran = next(e)
    const who = (e as { agentId?: string }).agentId ?? 'main'
    const what = short(callWhat(e as unknown as Record<string, unknown>), 70)
    void (async () => {
      try {
        const at = await $.clock.now()
        await update($, calls, all => {
          const mine = [...(all[who] ?? []), { tool: String(e.tool), what, at } as Call].slice(-6)
          const keys = Object.keys(all).filter(k => k !== who).slice(-19)
          const next2: Record<string, Call[]> = {}
          for (const k of keys) next2[k] = all[k] ?? []
          next2[who] = mine
          return next2
        })
      } catch {
        // a lost note costs nothing
      }
    })()
    return ran
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'forge' }, async ($, e) => {
    const args = e.args.trim()
    if (args.startsWith('note ')) {
      const r = await forge($, ['note', 'add', args.slice(5).trim()])
      return { text: (r.stdout || r.stderr).trim(), isTextDisplayOnly: true }
    }
    if (args === 'status') {
      const s = await read($, snapshot)
      return { text: s ? s.needsYou.map(n => `• ${n.text}`).join('\n') || 'Forge needs nothing from you.' : 'Not a Forge project.', isTextDisplayOnly: true }
    }
    const r = await $.ui.open({ id: PANE, title: 'Forge' })
    return { text: r.isPlaced ? 'Forge cockpit opened.' : `Forge cockpit could not open here (${r.reason}). Try /forge status.`, isTextDisplayOnly: true }
  })

  // The band: one line, always current.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const s = await read($, snapshot)
    if (!s || e.props.hasSurvey) return next(e)
    const { Box, Button, Text } = $.ui.resolve(e)
    const m = s.milestone
    const running = s.inProgress.map(t => `▸ ${t.id}${t.worker ? ` (${t.worker.agent ?? 'worker'})` : ''}`).join(' ')
    const need = s.needsYou.length
    return (
      <Box flexDirection="row" gap={1}>
        <Text bold>FORGE</Text>
        {m && <Text>{m.id} {m.counts.DONE ?? 0}/{m.total}</Text>}
        {running && <Text color="blue" wrap="truncate">{running}</Text>}
        {s.verify && s.verify.item && <Text dimColor>verify {s.verify.item}</Text>}
        {need > 0 && <Text color="yellow" bold>◆ {need} need{need === 1 ? 's' : ''} you</Text>}
        {s.autopilot.on && <Text dimColor>autopilot</Text>}
        <Button key="open" label="Open" plain onPress={() => quiet($.ui.open({ id: PANE, title: 'Forge' }))} />
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const s = await read($, snapshot)
    if (!s) return <Text dimColor>Not a Forge project (no forge/config.json here), or Forge did not answer.</Text>
    const v = await read($, view)
    const msg = await read($, flash)
    const width = Math.max(30, e.props.bodyColumns)
    const act = async (args: string[]) => {
      const r = await forge($, args)
      const line = (r.exitCode === 0 ? r.stdout : r.stderr || r.stdout).trim().split('\n')[0] ?? ''
      await update($, flash, () => short(line, 200))
    }
    const tabs = (
      <Box flexDirection="row" gap={1}>
        {VIEWS.map(t => (
          <Button key={`view-${t.id}`} label={t.label} variant={t.id === v ? 'primary' : 'secondary'}
            onPress={() => quiet(update($, view, () => t.id))} />
        ))}
      </Box>
    )
    let body
    if (v === 'overview') {
      body = (
        <Box flexDirection="column" gap={1}>
          {s.needsYou.length === 0 && <Text dimColor>Nothing needs you.</Text>}
          {s.questions.map(q => (
            <Box key={`q-${q.id}`} flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1}>
              <Text bold>◆ {q.id} — {short(q.title, width - 8)}</Text>
              <Text>{q.question}</Text>
              <Box flexDirection="row" gap={1} flexWrap="wrap">
                {q.options.map(o => (
                  <Button key={`q-${q.id}-${o.key}`} label={`${o.label}${o.recommended ? ' (recommended)' : ''}`}
                    variant={o.recommended ? 'primary' : 'secondary'}
                    onPress={() => quiet(act(['question', 'answer', q.id, '--choice', o.key]))} />
                ))}
                {q.options.length === 0 && <Text dimColor>Answer in the session, or: forge question answer {q.id} --note "…"</Text>}
              </Box>
            </Box>
          ))}
          {s.needsYou.filter(n => n.kind !== 'question').map(n => (
            <Text key={`n-${n.kind}-${n.item ?? n.release ?? n.session ?? ''}`} color={n.kind === 'claude' ? 'cyan' : 'yellow'}>
              {n.kind === 'claude' ? '● session waits: ' : '◆ '}{short(n.text, width - 20)}
            </Text>
          ))}
          {s.autopilot.on && (
            <Box flexDirection="row" gap={1}>
              <Text>Autopilot on{s.autopilot.stop ? ` — stopped: ${short(s.autopilot.stop.reason, 60)}` : s.autopilot.next ? `, next ${s.autopilot.next}` : ''}</Text>
              <Button key="ap-off" label="Stop autopilot" onPress={() => quiet(act(['autopilot', 'off', '--reason', 'stopped from the cockpit']))} />
            </Box>
          )}
          {s.notes.length > 0 && <Text dimColor>Notes waiting for the next brief: {s.notes.map(n => short(n.text, 40)).join(' · ')}</Text>}
          <Text dimColor>Leave a note for the next task: /forge note &lt;text&gt;</Text>
        </Box>
      )
    } else if (v === 'tasks') {
      const per: Record<string, number> = {}
      for (const t of s.tasks) per[t.stage] = (per[t.stage] ?? 0) + 1
      body = (
        <Box flexDirection="column">
          <Text>{s.milestone ? `Milestone ${s.milestone.id}` : 'No active milestone'}</Text>
          <Text dimColor>{STAGES.filter(st => per[st]).map(st => `${STAGE_LABEL[st]} ${per[st]}`).join('  →  ') || '—'}</Text>
          {s.tasks.map(t => (
            <Text key={`t-${t.id}`} color={t.status === 'IN_PROGRESS' ? 'blue' : t.status === 'BLOCKED' ? 'yellow' : undefined}
              dimColor={t.status === 'DONE' || t.status === 'CANCELLED'} wrap="truncate">
              {`${(STAGE_LABEL[t.stage] ?? t.stage).padEnd(10)}${t.id}  ${t.title}  · ${t.criteria} criteria · ${t.starts} start${t.starts === 1 ? '' : 's'}${t.lastVerify ? ` · verify ${t.lastVerify.passed ? '✓' : '✗'}` : ''}${t.origin !== 'plan' ? ` · ${t.origin}` : ''}`}
            </Text>
          ))}
        </Box>
      )
    } else if (v === 'workers') {
      const ws = await read($, workers)
      const cs = await read($, calls)
      const now = Date.now()
      body = (
        <Box flexDirection="column" gap={1}>
          <Box key="w-main" flexDirection="column">
            <Text bold>CTO (this session)</Text>
            {(cs.main ?? []).map((c, i) => <Text key={`c-main-${i}`} dimColor wrap="truncate">{`${ago(now - c.at)} ago  ${c.tool} ${c.what}`}</Text>)}
          </Box>
          {ws.length === 0 && <Text dimColor>No workers in this session.</Text>}
          {ws.map(wk => (
            <Box key={`w-${wk.id}`} flexDirection="column">
              <Text bold color={wk.status === 'running' ? 'blue' : undefined}>
                {`${wk.type} · ${wk.status} · ${ago(now - wk.startTime)} · ${kTokens(wk.tokens)} tokens${wk.model ? ` · ${wk.model}` : ''}`}
              </Text>
              <Text wrap="truncate">{wk.description}</Text>
              {(cs[wk.id] ?? []).map((c, i) => <Text key={`c-${wk.id}-${i}`} dimColor wrap="truncate">{`${ago(now - c.at)} ago  ${c.tool} ${c.what}`}</Text>)}
            </Box>
          ))}
        </Box>
      )
    } else if (v === 'project') {
      const total = s.milestones.reduce((n, m) => n + m.total, 0)
      const added = s.milestones.reduce((n, m) => n + m.total - (m.origins.plan ?? 0), 0)
      body = (
        <Box flexDirection="column">
          <Text>{`${s.project} · ${s.milestones.length} milestones · ${total} tasks (${added} added after planning) · ${s.milestones.filter(m => m.approved).length} approved`}</Text>
          {s.milestones.map(m => {
            const grew = Object.entries(m.origins).filter(([o]) => o !== 'plan').map(([o, n]) => `${o} ${n}`).join(', ')
            return (
              <Text key={`m-${m.id}`} dimColor={m.approved} color={s.milestone?.id === m.id ? 'blue' : undefined} wrap="truncate">
                {`${m.approved ? '✓' : s.milestone?.id === m.id ? '▸' : ' '} ${m.id}${m.release ? ` [${m.release}]` : ''}  ${m.counts.DONE ?? 0}/${m.total}${grew ? `  +${grew}` : ''}${m.hardening ? '  hardening' : ''}`}
              </Text>
            )
          })}
        </Box>
      )
    } else {
      body = (
        <Box flexDirection="column">
          {s.config.map(c => (
            <Box key={`cfg-${c.key}`} flexDirection="row" gap={1}>
              {isToggle(c.value)
                ? <Button key={`cfg-${c.key}-toggle`} label={`${c.key} = ${String(c.value)}`}
                    onPress={() => quiet(act(['config', 'set', `options.${c.key}`, toggled(c.value as string | boolean)]))} />
                : <Text>{`${c.key} = ${c.value === null ? `(default: ${c.default})` : String(c.value)}`}</Text>}
              <Text dimColor wrap="truncate">{short(c.what.replace(/^v[\d.]+: /, ''), Math.max(20, width - 40))}</Text>
            </Box>
          ))}
        </Box>
      )
    }
    return (
      <Box flexDirection="column" gap={1}>
        {tabs}
        {msg && <Text color="green" wrap="truncate">{msg}</Text>}
        {body}
      </Box>
    )
  })
}
