// The Forge cockpit's state contract (v0.28): what its band and pane draw from.
// The snapshot is `forge status --json`, typed only as far as the cockpit reads it.

export type NeedsYou = {
  kind: string
  text: string
  item?: string
  release?: string
  session?: string
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
export type Snapshot = {
  schema: number
  forge: string
  project: string
  phase: string | null
  counts: Record<string, number>
  milestone: { id: string; total: number; counts: Record<string, number> } | null
  inProgress: { id: string; title: string; worker: { agent: string | null; since: string } | null }[]
  verify: { item: string | null; since: string | null; alive: boolean | null } | null
  autopilot: { on: boolean; next?: string | null; stop?: { kind: string; reason: string } | null }
  questions: Question[]
  notes: { n: number; text: string; for: string }[]
  needsYou: NeedsYou[]
  tasks: TaskRow[]
  milestones: MilestoneRow[]
  config: ConfigRow[]
}
// One tool call, as the Workers view lists it.
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
export type View = 'overview' | 'tasks' | 'workers' | 'project' | 'config'

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
