// Forge cockpit (v0.28; boards v0.32): Forge inside Claude Code — a band above the prompt and a /forge pane whose
// boards say in plain words what the terminal is doing. Its rules, which the cockpit test holds it to:
//   - It reads `forge status --json` (no lock, no trace) and this session's agents; it never writes state itself.
//   - Its only actions are the owner's clicks and typing, each one `forge` CLI command (answer a question, set a
//     switch, pause or start autopilot, add or drop a note) — the CLI validates and records them like any other.
//   - Nothing reaches the model: no prompt sections, no injected context, no permission decisions.
//   - Its tool.call hook only notes the call (in plain words) for the Running board and hands it on at once.
//   - userConfig `cockpit: false` turns all of it off; Forge itself works the same without it.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Call, Snapshot, TaskRow, View, Worker } from '../types'

const PANE = 'forge'
const POLL_MS = 4000
const snapshot = atom({ plugin: 'forge', key: 'snapshot' } as const, null, { shape: 'snapshot-1' })
const calls = atom({ plugin: 'forge', key: 'calls' } as const, {}, { shape: 'calls-1' })
const workers = atom({ plugin: 'forge', key: 'workers' } as const, [], { shape: 'workers-1' })
const view = atom({ plugin: 'forge', key: 'view' } as const, 'now')
const flash = atom({ plugin: 'forge', key: 'flash' } as const, null)

// The boards, in the order the keys 1–7 press them.
const VIEWS: { id: View; label: string }[] = [
  { id: 'now', label: 'Now' },
  { id: 'tasks', label: 'Tasks' },
  { id: 'running', label: 'Running' },
  { id: 'gate', label: 'Gate' },
  { id: 'project', label: 'Project' },
  { id: 'steer', label: 'Steer' },
  { id: 'config', label: 'Config' },
]
const STAGES = ['todo', 'brief', 'cto', 'prepare', 'implement', 'test', 'verify', 'review', 'blocked', 'done']
const STAGE_LABEL: Record<string, string> = {
  todo: 'to do', brief: 'briefing', cto: 'briefing', prepare: 'preparing', implement: 'building', test: 'testing',
  verify: 'checking', review: 'reviewing', done: 'done', blocked: 'waiting', cancelled: 'cancelled',
}
const STAGE_COLOR: Record<string, string> = {
  implement: 'blue', test: 'blue', verify: 'cyan', review: 'magenta', prepare: 'blue', brief: 'blue', cto: 'blue',
  blocked: 'yellow', done: 'green',
}
const TONE: Record<string, string> = { good: 'green', bad: 'red', warn: 'yellow', info: 'blue' }

function short(text: string, n: number): string {
  const t = String(text ?? '').replace(/[\r\n\t]+/g, ' ').trimEnd() // runs of spaces stay: they align columns
  return t.length > n ? `${t.slice(0, Math.max(1, n - 1))}…` : t
}
function col(text: string, n: number): string {
  return short(text, n).padEnd(n)
}
function ago(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.round(s / 60)}m` : `${(s / 3600).toFixed(1)}h`
}
function clock(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}
function hhmm(iso: string | null | undefined): string {
  return iso ? String(iso).slice(11, 16) : ''
}
function kTokens(n: number): string {
  return n >= 1000 ? `${Math.round(n / 1000)}k` : String(n)
}
function base(p: string): string {
  return String(p).split('/').filter(Boolean).pop() ?? String(p)
}
// A shell command in a few plain words: no `cd …&&`, variables, function definitions, heredoc bodies or paths.
function humanBash(cmd: string): string {
  let c = String(cmd).split(/<<-?\s*['"]?[A-Za-z_]+['"]?/)[0] ?? ''
  c = c.replace(/\b[A-Za-z_][\w-]*\(\)\s*\{[^}]*\}\s*;?/g, ' ')
  const segs = c.split(/&&|\|\||;|\|/).map(x => x.trim()).filter(Boolean)
    .map(x => x.replace(/^([A-Za-z_]\w*=("[^"]*"|'[^']*'|\S*)\s+)+/, '').replace(/^(rtk proxy|env|time|command)\s+/, '').trim())
    .filter(x => x && !/^(cd|export|set|source|\.|echo|true)\b/.test(x) && !/^[A-Za-z_]\w*=/.test(x))
  const main = segs.find(x => /forge(\.js)?["']?\s+[a-z]|playwright|vitest|jest|npm|pnpm|psql|supabase|git\b|gh\b|tsc|eslint|grep|rg\b|curl/.test(x)) ?? segs[0] ?? c.trim()
  let m: RegExpMatchArray | null
  if ((m = main.match(/forge(?:\.js)?["']?\s+([a-z-]+)(?:\s+([a-z-]+))?(?:\s+([\w.:-]+))?/))) return `forge ${[m[1], m[2], m[3]].filter(Boolean).join(' ')}`
  if ((m = main.match(/playwright\s+test\s*([^\s|>]*)/))) return m[1] && !m[1].startsWith('-') ? `e2e ${base(m[1])}` : 'e2e suite'
  if (/vitest|jest|npm (run )?test\b|pnpm test/.test(main)) return 'unit tests'
  if (/tsc\b|typecheck/.test(main)) return 'typecheck'
  if (/eslint|npm run lint/.test(main)) return 'lint'
  if (/vite build|npm run build/.test(main)) return 'build'
  if (/psql|supabase (db|migration)|pg_dump/.test(main)) return 'database query'
  if ((m = main.match(/^(?:grep|rg)\s+(?:-\S+\s+)*("[^"]*"|'[^']*'|\S+)/))) return `search ${short((m[1] ?? '').replace(/^["']|["']$/g, ''), 40)}`
  if (/^(git|gh)\b/.test(main)) return short(main, 50)
  return short(main.replace(/\/(?:[\w.@-]+\/)+([\w.@-]+)/g, '$1'), 60)
}
// What a tool call did, in plain words.
function humanCall(tool: string, e: Record<string, unknown>): string {
  const s = (k: string) => (typeof e[k] === 'string' ? (e[k] as string) : '')
  if (tool === 'Bash') return humanBash(s('command'))
  if (tool === 'Read') return `read ${base(s('file_path'))}`
  if (['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(tool)) return `edit ${base(s('file_path') || s('notebook_path'))}`
  if (tool === 'Grep') return `search "${short(s('pattern'), 40)}"`
  if (tool === 'Glob') return `find ${short(s('pattern'), 40)}`
  if (tool === 'Agent' || tool === 'Task') return `start a worker: ${short(s('description'), 50)}`
  if (tool === 'WebFetch' || tool === 'WebSearch') return `web: ${short(s('url') || s('query'), 50)}`
  if (tool === 'TodoWrite' || tool === 'TaskCreate' || tool === 'TaskUpdate') return 'update the task list'
  return tool
}
// The Forge task a worker is on: the longest task id its description names.
function taskOf(desc: string, ids: string[]): string | null {
  let best: string | null = null
  for (const id of ids) if (desc.includes(id) && (!best || id.length > best.length)) best = id
  return best
}
function autopilotLine(s: Snapshot): string {
  if (!s.autopilot.on) return 'Autopilot is off: tasks start when you or the session start them.'
  const st = s.autopilot.stop
  if (!st) return `Autopilot is on${s.autopilot.next ? `: next up ${s.autopilot.next}` : ''}.`
  const why: Record<string, string> = {
    gate: 'it is waiting for your review of the finished milestone',
    question: 'it is waiting for your answer to a question',
    waiting: 'it is waiting for the tasks in progress to finish',
    limit: 'it reached its run limit',
    done: 'every planned milestone is complete',
  }
  return `Autopilot is paused: ${why[st.kind] ?? st.reason}.`
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
      description: 'Forge cockpit: open the boards, or `/forge note <text>` for the next task',
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
      const now = new Set(snap.needsYou.map(n => `${n.kind}:${n.item ?? n.release ?? n.session ?? n.milestone ?? ''}`))
      for (const n of snap.needsYou) {
        const k = `${n.kind}:${n.item ?? n.release ?? n.session ?? n.milestone ?? ''}`
        if (!seen.has(k) && n.kind !== 'claude' && n.kind !== 'autopilot') $.ui.toast(`Forge: ${short(n.text, 120)}`)
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

  // Observe only: note the call, in plain words, for the Running board; hand it on at once, never wait on the note.
  on('tool.call', ($, e, next) => {
    const ran = next(e)
    const who = (e as { agentId?: string }).agentId ?? 'main'
    const what = short(humanCall(String(e.tool), e as unknown as Record<string, unknown>), 80)
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

  // The band: one line in a fixed order that fits the width — the least important parts go first when it does not —
  // and, while a question waits, a second line that says so.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const s = await read($, snapshot)
    if (!s || e.props.hasSurvey) return next(e)
    const { Box, Button, Text } = $.ui.resolve(e)
    const cols = Math.max(40, e.props.bodyColumns ?? 100)
    const m = s.milestone
    const need = s.needsYou.filter(n => n.kind !== 'autopilot').length
    type Part = { key: string; text: string; color?: string; bold?: boolean; dim?: boolean; drop: number }
    const parts: Part[] = []
    if (m) parts.push({ key: 'm', text: `${m.id} ${m.counts.DONE ?? 0}/${m.total}`, drop: 9 })
    const n = s.inProgress.length
    if (n) parts.push({ key: 'w', text: n === 1 ? `▸ ${s.inProgress[0]?.id ?? ''}` : `▸ ${n} in progress`, color: 'blue', drop: 6 })
    if (s.verify && s.verify.item) parts.push({ key: 'v', text: s.verify.item.startsWith('milestone:') ? '▸ full run' : `▸ checking ${s.verify.item}`, color: 'cyan', drop: 4 })
    else if (s.gate?.fullRun?.state === 'red') parts.push({ key: 'r', text: '✗ full run red', color: 'red', drop: 7 })
    if (need) parts.push({ key: 'n', text: `◆ ${need} need${need === 1 ? 's' : ''} you`, color: 'yellow', bold: true, drop: 10 })
    parts.push({ key: 'a', text: s.autopilot.on ? (s.autopilot.stop ? 'autopilot paused' : 'autopilot on') : 'autopilot off', dim: true, drop: 2 })
    const room = cols - 'FORGE '.length - ' /forge'.length - 2
    const width = (ps: Part[]) => ps.reduce((w, p) => w + p.text.length + 3, 0)
    let shown = parts
    while (shown.length > 1 && width(shown) > room) {
      const low = shown.reduce((a, b) => (b.drop < a.drop ? b : a))
      shown = shown.filter(p => p !== low)
    }
    const q = s.questions[0]
    return (
      <Box flexDirection="column">
        <Box flexDirection="row" gap={1}>
          <Text bold color="redBright">FORGE</Text>
          {shown.map((p, i) => (
            <Text key={`band-${p.key}`} color={p.color} bold={p.bold} dimColor={p.dim} wrap="truncate">{`${i ? '│ ' : ''}${short(p.text, Math.max(8, room - 6))}`}</Text>
          ))}
          <Button key="open" label="/forge" plain onPress={() => quiet($.ui.open({ id: PANE, title: 'Forge' }))} />
        </Box>
        {q && <Text color="yellow" wrap="truncate">{short(`◆ Forge needs a decision: ${q.question} — /forge to answer`, cols)}</Text>}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Input, Progress, Text } = $.ui.resolve(e)
    const s = await read($, snapshot)
    if (!s) return <Text dimColor>Not a Forge project (no forge/config.json here), or Forge did not answer.</Text>
    const stored = await read($, view)
    const v: View = VIEWS.some(x => x.id === stored) ? stored : 'now'
    const msg = await read($, flash)
    const W = Math.max(40, e.props.bodyColumns)
    const now = Date.now()
    const act = async (args: string[]) => {
      const r = await forge($, args)
      const line = (r.exitCode === 0 ? r.stdout : r.stderr || r.stdout).trim().split('\n')[0] ?? ''
      await update($, flash, () => short(line, 200))
    }
    const m = s.milestone
    const mName = m ? (m.name ? `${m.name} (${m.id})` : m.id) : null
    const header = (
      <Box flexDirection="row" gap={1}>
        <Text bold color="redBright">FORGE</Text>
        <Text wrap="truncate">{short(`${s.project}${mName ? ` · ${mName} ${m?.counts.DONE ?? 0}/${m?.total ?? 0}` : ''} · ${s.autopilot.on ? (s.autopilot.stop ? 'autopilot paused' : 'autopilot on') : 'autopilot off'}`, W - 8)}</Text>
      </Box>
    )
    const need = s.needsYou.filter(n => n.kind !== 'autopilot').length
    const tabs = (
      <Box flexDirection="row" gap={1} flexWrap="wrap">
        {VIEWS.map((t, i) => (
          <Button key={`view-${t.id}`} hotkey={String(i + 1)} label={`${i + 1} ${t.label}${t.id === 'now' && need ? ` ◆${need}` : ''}`}
            variant={t.id === v ? 'primary' : 'secondary'} onPress={() => quiet(update($, view, () => t.id))} />
        ))}
      </Box>
    )
    const ids = Array.from(new Set([...s.tasks.map(t => t.id), ...s.inProgress.map(t => t.id)]))
    let body
    if (v === 'now') {
      // In plain words: what is happening, what needs you, what happened.
      const inProg = s.inProgress.length
      const summary = [
        m ? `Milestone ${mName}: ${m.counts.DONE ?? 0} of ${m.total} tasks done.` : s.phase === 'spec' ? 'Spec phase: the specification is being written in the session — there are no tasks yet.' : 'No active milestone.',
        inProg ? `${inProg} task${inProg === 1 ? ' is' : 's are'} in progress: ${short(s.inProgress.map(t => t.id).join(', '), W - 30)}.` : 'No task is in progress.',
        s.verify && s.verify.item ? (s.verify.item.startsWith('milestone:') ? 'The milestone’s full test run is going.' : `Checking ${s.verify.item} now.`) : '',
        autopilotLine(s),
      ].filter(Boolean)
      const others = s.needsYou.filter(n => n.kind !== 'question' && n.kind !== 'autopilot')
      const recent = (s.recent ?? []).slice(-8).reverse()
      body = (
        <Box flexDirection="column" gap={1}>
          <Box flexDirection="column">
            {summary.map((line, i) => <Text key={`sum-${i}`}>{line}</Text>)}
          </Box>
          {s.autopilot.stop && !['gate', 'question', 'waiting', 'limit', 'done'].includes(s.autopilot.stop.kind) && (
            <Text dimColor wrap="truncate">{short(`Why: ${s.autopilot.stop.reason}`, W)}</Text>
          )}
          {need === 0 && <Text color="green">Nothing needs you right now.</Text>}
          {s.questions.map(q => (
            <Box key={`q-${q.id}`} flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1}>
              <Text bold color="yellow">◆ {q.id} — {short(q.title, W - 12)}</Text>
              <Text>{q.question}</Text>
              <Box flexDirection="row" gap={1} flexWrap="wrap">
                {q.options.map(o => (
                  <Button key={`q-${q.id}-${o.key}`} label={`${o.label}${o.recommended ? ' (recommended)' : ''}`}
                    variant={o.recommended ? 'primary' : 'secondary'}
                    onPress={() => quiet(act(['question', 'answer', q.id, '--choice', o.key]))} />
                ))}
                {q.options.length === 0 && <Text dimColor>Answer it in the session.</Text>}
              </Box>
            </Box>
          ))}
          {others.map(n => (
            <Text key={`n-${n.kind}-${n.item ?? n.release ?? n.session ?? n.milestone ?? ''}`} color={n.kind === 'claude' ? 'cyan' : 'yellow'} wrap="truncate">
              {short(`${n.kind === 'claude' ? '● A Claude session is waiting: ' : '◆ '}${n.text}`, W)}
            </Text>
          ))}
          {recent.length > 0 && (
            <Box flexDirection="column">
              <Text dimColor>What happened</Text>
              {recent.map((r, i) => <Text key={`ev-${i}`} color={TONE[r.tone]} wrap="truncate">{short(`${hhmm(r.ts)}  ${r.text}`, W)}</Text>)}
            </Box>
          )}
        </Box>
      )
    } else if (v === 'tasks') {
      const rows = s.tasks.filter(t => t.status !== 'CANCELLED')
      const cancelled = s.tasks.length - rows.length
      const per: Record<string, number> = {}
      for (const t of rows) per[t.stage] = (per[t.stage] ?? 0) + 1
      const idW = Math.min(30, Math.max(8, ...rows.map(t => t.id.length)))
      const titleW = Math.max(12, W - 11 - idW - 2 - 20 - 9)
      const line = (t: TaskRow) => `${col(STAGE_LABEL[t.stage] ?? t.stage, 11)}${col(t.id, idW + 2)}${col(t.title, titleW)}${col(t.worker ?? '', 20)}${t.lastVerify ? (t.lastVerify.passed ? '✓ passed' : '✗ failed') : ''}`
      body = (
        <Box flexDirection="column">
          <Text>{m ? `Milestone ${mName} — ${m.counts.DONE ?? 0} of ${m.total} done` : 'No active milestone'}</Text>
          <Text dimColor>{STAGES.filter(st => per[st]).map(st => `${STAGE_LABEL[st]} ${per[st]}`).join('  →  ') || '—'}</Text>
          <Text dimColor>{`${col('step', 11)}${col('task', idW + 2)}${col('what', titleW)}${col('who', 20)}checks`}</Text>
          {rows.map(t => (
            <Text key={`t-${t.id}`} color={STAGE_COLOR[t.stage]} dimColor={t.stage === 'done'} wrap="truncate">{line(t)}</Text>
          ))}
          {cancelled > 0 && <Text dimColor>{`${cancelled} cancelled task${cancelled === 1 ? '' : 's'} not shown`}</Text>}
        </Box>
      )
    } else if (v === 'running') {
      const ws = await read($, workers)
      const cs = await read($, calls)
      const liveWs = ws.filter(w => ['running', 'pending', 'waiting'].includes(w.status))
      const vfy = s.verify && s.verify.item ? s.verify : null
      const vEl = vfy && vfy.since ? now - Date.parse(vfy.since) : 0
      const callLines = (list: Call[] | undefined, k: string) => (list ?? []).slice().reverse().map((c, i) => (
        <Text key={`c-${k}-${i}`} dimColor={i > 0} wrap="truncate">{short(`${i === 0 ? 'now  ' : `${ago(now - c.at).padStart(3)}  `}${c.what}`, W - 2)}</Text>
      ))
      body = (
        <Box flexDirection="column" gap={1}>
          {vfy && (
            <Box flexDirection="column">
              <Text bold color="cyan">{vfy.item?.startsWith('milestone:') ? `Full test run of ${vfy.item.slice(10)}` : `Checking ${vfy.item}`}</Text>
              <Progress label={`checks of ${vfy.item}`} value={vEl} max={vfy.expectedMs ?? undefined}
                valueText={vfy.expectedMs ? `${clock(vEl)} of about ${clock(vfy.expectedMs)}` : `${clock(vEl)} so far`} />
            </Box>
          )}
          <Box flexDirection="column">
            <Text bold>Orchestrator (this session)</Text>
            {callLines(cs.main, 'main')}
            {!(cs.main ?? []).length && <Text dimColor>No tool calls seen yet.</Text>}
          </Box>
          {liveWs.length === 0 && <Text dimColor>{s.inProgress.length ? `No worker of this session is running; ${s.inProgress.length} task(s) are in progress (a worker of another session, or between steps).` : 'No worker is running.'}</Text>}
          {liveWs.map(wk => {
            const task = taskOf(wk.description, ids)
            return (
              <Box key={`w-${wk.id}`} flexDirection="column">
                <Text bold color="blue" wrap="truncate">{short(`${wk.type.replace(/^forge:/, '')} → ${task ?? short(wk.description, 40)}`, W)}</Text>
                <Text dimColor wrap="truncate">{short(`${wk.status} · ${ago(now - wk.startTime)} · ${kTokens(wk.tokens)} tokens${wk.model ? ` · ${wk.model}` : ''}`, W)}</Text>
                {callLines(cs[wk.id], wk.id)}
              </Box>
            )
          })}
        </Box>
      )
    } else if (v === 'gate') {
      const g = s.gate
      if (!g) {
        body = <Text dimColor>No milestone is on its way out yet.</Text>
      } else {
        const fr = g.fullRun
        const frText = !g.hasGate ? 'no slow test lanes (gate.*) are set up — nothing extra to run'
          : !fr || fr.state === 'none' ? (g.gateAt === 'ship' ? 'not started — it starts by itself when the last task closes, while you review' : `not started — forge milestone verify ${g.milestone}`)
          : fr.state === 'running' ? 'running now'
          : fr.state === 'green' ? `passed at ${hhmm(fr.ts)}${fr.retry ? ' (re-run of what failed)' : ''}${fr.changedSince ? ' — the code changed since, so it runs again' : ''}`
          : `failed at ${hhmm(fr.ts)}: ${(fr.failed ?? []).join(', ')} — fix it; the next run re-runs only what failed`
        const frRunEl = fr && fr.state === 'running' && fr.since ? now - Date.parse(fr.since) : 0
        type Step = { key: string; done: boolean; bad?: boolean; title: string; text: string }
        const steps: Step[] = [
          { key: 'tasks', done: g.complete, title: 'Tasks', text: `${g.done} of ${g.total} closed` },
          ...(g.hasGate ? [{ key: 'full', done: fr?.state === 'green' && !fr.changedSince, bad: fr?.state === 'red', title: 'Full test run', text: frText }] : []),
          { key: 'security', done: !!g.security || g.securityOff, title: 'Security pass', text: g.securityOff ? 'off for this project' : g.security ? `done by ${g.security.agent}` : 'a reviewer checks the milestone’s changes before you approve' },
          { key: 'review', done: g.approved, title: 'Your review', text: g.approved ? 'approved' : g.complete ? `try it, then approve: forge milestone approve ${g.milestone}` : 'when the tasks are closed' },
          ...(g.perMilestone ? [{ key: 'ship', done: !!g.ship, title: 'Ship', text: g.ship ? `pull request opened${g.ship.pr ? `: ${g.ship.pr}` : ''}` : `forge milestone ship ${g.milestone}${g.hasGate && g.gateAt === 'ship' ? ' — needs the full test run green' : ''}` }] : []),
        ]
        const firstOpen = steps.findIndex(st => !st.done)
        body = (
          <Box flexDirection="column" gap={1}>
            <Text>{`Milestone ${g.name ? `${g.name} (${g.milestone})` : g.milestone} on its way out`}</Text>
            <Box flexDirection="column">
              {steps.map((st, i) => (
                <Text key={`g-${st.key}`} color={st.bad ? 'red' : st.done ? 'green' : i === firstOpen ? 'yellow' : undefined} dimColor={!st.done && !st.bad && i !== firstOpen} wrap="truncate">
                  {short(`${st.bad ? '✗' : st.done ? '✓' : i === firstOpen ? '▸' : '○'} ${col(st.title, 15)}${st.text}`, W)}
                </Text>
              ))}
            </Box>
            {fr && fr.state === 'running' && (
              <Progress label="full test run" value={frRunEl} max={fr.expectedMs ?? undefined}
                valueText={fr.expectedMs ? `${clock(frRunEl)} of about ${clock(fr.expectedMs)}` : `${clock(frRunEl)} so far`} />
            )}
          </Box>
        )
      }
    } else if (v === 'project') {
      const total = s.milestones.reduce((n, x) => n + x.total, 0)
      const added = s.milestones.reduce((n, x) => n + x.total - (x.origins.plan ?? 0), 0)
      const approved = s.milestones.filter(x => x.approved)
      const ahead = s.milestones.filter(x => !x.approved).slice(0, 6)
      const nameW = Math.min(28, Math.max(10, ...ahead.map(x => (x.name ?? x.id).length)))
      const bar = (d: number, t: number) => { const n = t ? Math.round((d / t) * 16) : 0; return `${'█'.repeat(n)}${'░'.repeat(16 - n)}` }
      body = (
        <Box flexDirection="column" gap={1}>
          <Text>{`${approved.length} of ${s.milestones.length} milestones approved · ${total} tasks, ${total ? Math.round((100 * added) / total) : 0}% added after planning · ${s.questions.length} open question${s.questions.length === 1 ? '' : 's'}`}</Text>
          <Box flexDirection="column">
            <Text dimColor>Now and next</Text>
            {ahead.map(x => {
              const grew = Object.entries(x.origins).filter(([o]) => o !== 'plan').map(([o, k]) => `${o} ${k}`).join(', ')
              const cur = m?.id === x.id
              return (
                <Text key={`m-${x.id}`} color={cur ? 'blue' : undefined} wrap="truncate">
                  {short(`${cur ? '▸' : ' '} ${col(x.name ?? x.id, nameW)}  ${bar(x.counts.DONE ?? 0, x.total)} ${`${x.counts.DONE ?? 0}/${x.total}`.padStart(7)}${x.release ? `  [${x.release}]` : ''}${grew ? `  grew: ${grew}` : ''}`, W)}
                </Text>
              )
            })}
            {ahead.length === 0 && <Text dimColor>Every milestone is approved.</Text>}
          </Box>
          {approved.length > 0 && <Text dimColor>{short(`Approved: ${approved.map(x => x.id).join(', ')}`, W * 2)}</Text>}
        </Box>
      )
    } else if (v === 'steer') {
      const paused = !s.autopilot.on
      body = (
        <Box flexDirection="column" gap={1}>
          <Text>{autopilotLine(s)}</Text>
          <Box flexDirection="row" gap={1}>
            {!paused && <Button key="ap-off" label="Pause autopilot after the current task" onPress={() => quiet(act(['autopilot', 'off', '--reason', 'paused from the cockpit']))} />}
            {paused && <Button key="ap-on" label="Start autopilot" variant="primary" onPress={() => quiet(act(['autopilot', 'on']))} />}
          </Box>
          <Box flexDirection="column">
            <Input key="note" label="Note for the next task: " placeholder="e.g. keep totals in integer cents" submitLabel="queue"
              onSubmit={value => { const t = value.trim(); if (t) quiet(act(['note', 'add', t])) }} />
            <Text dimColor>The next task’s brief carries it; it never interrupts a turn.</Text>
          </Box>
          <Box flexDirection="column">
            <Text dimColor>{s.notes.length ? 'Queued notes' : 'No notes queued.'}</Text>
            {s.notes.map(n => (
              <Box key={`note-${n.n}`} flexDirection="row" gap={1}>
                <Text wrap="truncate">{short(`▸ ${n.text} → ${n.for}`, W - 12)}</Text>
                <Button key={`note-drop-${n.n}`} label="drop" plain onPress={() => quiet(act(['note', 'drop', String(n.n)]))} />
              </Box>
            ))}
          </Box>
        </Box>
      )
    } else {
      const groups: Record<string, typeof s.config> = {}
      for (const c of s.config) (groups[c.group] ??= []).push(c)
      body = (
        <Box flexDirection="column" gap={1}>
          {Object.entries(groups).map(([gname, rows]) => (
            <Box key={`cg-${gname}`} flexDirection="column">
              <Text bold>{gname}</Text>
              {rows.slice().sort((a, b) => Number(isToggle(b.value)) - Number(isToggle(a.value))).map(c => (
                <Box key={`cfg-${c.key}`} flexDirection="row" gap={1}>
                  {isToggle(c.value)
                    ? <Button key={`cfg-${c.key}-toggle`} label={`${c.key}: ${String(c.value)}`}
                        onPress={() => quiet(act(['config', 'set', `options.${c.key}`, toggled(c.value as string | boolean)]))} />
                    : <Text>{`${c.key}: ${c.value === null ? `default (${short(c.default, 20)})` : short(String(c.value), 30)}`}</Text>}
                  <Text dimColor wrap="truncate">{short(c.what.replace(/^v[\d.]+(\s*\([^)]*\))?:\s*/, ''), Math.max(20, W - 40))}</Text>
                </Box>
              ))}
            </Box>
          ))}
        </Box>
      )
    }
    return (
      <Box flexDirection="column" gap={1}>
        {header}
        {tabs}
        {msg && <Text color="green" wrap="truncate">{msg}</Text>}
        {body}
      </Box>
    )
  })
}
