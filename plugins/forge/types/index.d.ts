// The Forge cockpit's state contract (v0.28; v0.32 boards): what its band and pane draw from.
// The snapshot is `forge status --json`, typed only as far as the cockpit reads it.

export type NeedsYou = {
  kind: string
  text: string
  item?: string
  release?: string
  session?: string
  milestone?: string
  count?: number
}
export type QuestionOption = { key: string; label: string; recommended: boolean }
export type Question = { id: string; title: string; question: string; options: QuestionOption[]; since: string | null }
export type TaskRow = {
  id: string
  title: string
  status: string
  stage: string
  origin: string
  criteria: number
  starts: number
  failedAttempts: number
  lastVerify: { passed: boolean; ts: string } | null
  blockReason: string | null
  worker?: string | null
}
export type MilestoneRow = {
  id: string
  name: string | null
  release: string | null
  total: number
  counts: Record<string, number>
  origins: Record<string, number>
  approved: boolean
  hardening: boolean
}
export type ConfigRow = {
  key: string
  value: string | number | boolean | null
  default: string
  group: string
  what: string
  change: string
  risk: string
}
// v0.32: the Gate board — where the milestone stands on its way out
export type GateState = {
  milestone: string
  name: string | null
  done: number
  total: number
  complete: boolean
  gateAt: string
  hasGate: boolean
  fullRun: { state: string; ts?: string | null; since?: string | null; expectedMs?: number | null; failed?: string[]; changedSince?: boolean; retry?: boolean } | null
  security: { agent: string; ts: string } | null
  securityOff: boolean
  approved: boolean
  ship: { pr: string | null; ts: string } | null
  perMilestone: boolean
}
export type RecentEvent = { ts: string; text: string; tone: string }
export type Snapshot = {
  schema: number
  forge: string
  project: string
  phase: string | null
  counts: Record<string, number>
  milestone: { id: string; name?: string | null; total: number; counts: Record<string, number> } | null
  inProgress: { id: string; title: string; milestone?: string | null; worker: { agent: string | null; since: string } | null }[]
  verify: { item: string | null; since: string | null; alive: boolean | null; expectedMs?: number | null } | null
  autopilot: { on: boolean; next?: string | null; stop?: { kind: string; reason: string } | null }
  questions: Question[]
  notes: { n: number; text: string; for: string }[]
  needsYou: NeedsYou[]
  tasks: TaskRow[]
  milestones: MilestoneRow[]
  config: ConfigRow[]
  gate?: GateState | null
  recent?: RecentEvent[]
}
// One tool call, as the Running board lists it: already said in plain words.
export type Call = { tool: string; what: string; at: number }
export type Worker = {
  id: string
  type: string
  description: string
  status: string
  tokens: number
  model: string | null
  startTime: number
}
export type View = 'now' | 'tasks' | 'running' | 'gate' | 'project' | 'steer' | 'config'

declare module 'claude-code' {
  interface PluginState {
    forge: {
      snapshot: Shaped<Snapshot | null>
      calls: Shaped<Record<string, Call[]>>
      workers: Shaped<Worker[]>
      view: View
      flash: string | null
    }
  }
}
