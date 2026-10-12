// The generic adapter (phase 5): anything that can send an HTTP POST can be a bloobie. A CI job, a cron script, an
// agent framework the bridge has no adapter for. One small JSON message per update, named by the sender's own id;
// the adapter keeps the state and turns it into protocol events.
//
//   curl -X POST http://127.0.0.1:5318/webhook -H "x-bloobies: 1" -H "content-type: application/json" \
//        -d '{"agent":"nightly","task":"Run the e2e suite","progress":[3,12]}'
//
// Fields (all but `agent` optional, any mix in one message):
//   agent     your id for it; the first message brings a bloobie in on the bus
//   name      a display name (otherwise one is picked), role  what kind of agent ("CI", "scraper"…)
//   source    tool / setup (lowercase letters, digits or hyphens, 1–24 chars; defaults to http)
//   crew      your id of its lead; project  project folder name (at most 80 chars)
//   task      starts a new task with this title (ends the one before)
//   status    a 2–3 word update for the running task, station  where it works (else guessed from the words)
//   progress  [done, total] or { done, total }, eta  seconds left (the agent's own guess)
//   file      a path it touched, needs  a question for you (raises the yellow flag)
//   done      true to finish the task, failed  a reason (the task failed), leave  true to send it home
import { STATION_KINDS, shortLabel, stationFor } from '../protocol/index.js'

const clip = (s, n) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim()
  return t.length > n ? t.slice(0, n - 1) + '…' : t
}

const agentId = (key) => `wh-${clip(key, 64).replace(/[^\w.-]/g, '_')}`

export class WebhookAdapter {
  /** @param {{ emit: (e: object) => void, now?: () => number, pickName: () => string }} o */
  constructor({ emit, now = Date.now, pickName }) {
    this.out = emit
    this.now = now
    this.pickName = pickName
    this.agents = new Map()
    this.seq = 0
  }

  emit(e) {
    this.out({ t: this.now(), ...e })
  }

  /** One message; returns an error string, or null when it was taken. */
  handle(m) {
    if (!m || typeof m !== 'object' || Array.isArray(m)) return 'expected a JSON object'
    const key = clip(m.agent, 64)
    if (!key) return '"agent" (your id for it) is required'
    if (m.source !== undefined && (typeof m.source !== 'string' || !/^[a-z0-9-]{1,24}$/.test(m.source))) return '"source" must be 1–24 lowercase letters, digits or hyphens'
    if (m.crew !== undefined && (typeof m.crew !== 'string' || !clip(m.crew, 64))) return '"crew" must be the id of its lead'
    if (m.project !== undefined && (typeof m.project !== 'string' || m.project.length > 80)) return '"project" must be at most 80 characters'
    const id = agentId(key)
    let a = this.agents.get(id)
    if (m.leave) {
      if (!a) return null
      if (a.task) this.emit({ type: 'task.done', taskId: a.task })
      this.agents.delete(id)
      this.emit({ type: 'agent.retired', agentId: id })
      return null
    }
    if (!a) {
      a = { id, task: null, label: '' }
      this.agents.set(id, a)
      this.emit({ type: 'agent.spawned', agentId: id, name: clip(m.name, 16) || this.pickName(), role: clip(m.role, 40) || undefined, source: m.source ?? 'http', crew: m.crew === undefined ? undefined : agentId(m.crew), project: m.project })
    }
    const station = STATION_KINDS.includes(m.station) ? m.station : undefined
    if (m.task) {
      if (a.task) this.emit({ type: 'task.done', taskId: a.task })
      a.task = `${id}-t${++this.seq}`
      a.label = shortLabel(clip(m.task, 200)) || 'Working'
      const p = progressOf(m.progress)
      this.emit({ type: 'task.assigned', taskId: a.task, agentId: id, station: station ?? stationFor(m.task), label: a.label, total: p?.total })
    }
    const start = () => {
      if (a.task) return
      a.task = `${id}-t${++this.seq}`
      a.label = shortLabel(clip(m.status, 200)) || 'Working'
      this.emit({ type: 'task.assigned', taskId: a.task, agentId: id, station: station ?? stationFor(m.status ?? ''), label: a.label })
    }
    if (m.status || m.eta !== undefined || (station && !m.task)) {
      start()
      const label = m.status ? shortLabel(clip(m.status, 200)) : a.label
      a.label = label
      const eta = Number(m.eta)
      this.emit({ type: 'task.status', taskId: a.task, label, station: m.task ? undefined : station, eta: Number.isFinite(eta) && eta >= 0 ? Math.round(eta) : undefined })
    }
    const p = progressOf(m.progress)
    if (p) {
      start()
      this.emit({ type: 'task.progress', taskId: a.task, ...p })
    }
    if (m.file) {
      start()
      this.emit({ type: 'task.file', taskId: a.task, path: clip(m.file, 200), op: 'edit' })
    }
    if (m.needs) this.emit({ type: 'agent.needs_input', agentId: id, kind: 'question', text: clip(m.needs, 100) })
    if (m.failed && a.task) {
      this.emit({ type: 'task.failed', taskId: a.task, reason: clip(m.failed === true ? 'Failed' : m.failed, 40), kind: 'error' })
      a.task = null
    } else if (m.done && a.task) {
      this.emit({ type: 'task.done', taskId: a.task })
      a.task = null
    }
    return null
  }
}

function progressOf(p) {
  const [done, total] = Array.isArray(p) ? p : p && typeof p === 'object' ? [p.done, p.total] : []
  const d = Number(done)
  const t = Number(total)
  if (!Number.isInteger(d) || !Number.isInteger(t) || t < 1 || d < 0) return null
  return { done: Math.min(d, t), total: t }
}
