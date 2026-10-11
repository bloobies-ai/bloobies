// The bridge's memory of the world: just enough state, kept from the event stream, to bring a page that connects
// late (or reloads) up to now. snapshot() replays the current state as a short list of events, stamped with when
// things really happened, so ETAs and "joined 5 min ago" still come out right.

/** How many messages of each agent's thread a late page is brought up to date with. */
const CHAT = 50

export class Tracker {
  constructor() {
    this.agents = new Map()
    this.tasks = new Map()
    /** The last plan limits per service (limits.update). */
    this.limits = new Map()
  }

  apply(e) {
    const { agents, tasks } = this
    switch (e.type) {
      case 'agent.spawned':
        agents.set(e.agentId, { spawned: e, task: null, need: null, usage: null, chat: [] })
        break
      case 'agent.retired': {
        const a = agents.get(e.agentId)
        if (a?.task) tasks.delete(a.task)
        agents.delete(e.agentId)
        break
      }
      case 'task.assigned':
      case 'task.handoff': {
        const to = e.type === 'task.assigned' ? e.agentId : e.to
        const a = agents.get(to)
        if (!a) break
        if (a.task) tasks.delete(a.task)
        a.task = e.taskId
        a.need = null
        tasks.set(e.taskId, {
          id: e.taskId,
          agentId: to,
          station: e.station,
          title: e.label,
          total: e.total,
          startedAt: e.t,
          progress: null,
          status: null,
          paused: null,
          files: [],
        })
        break
      }
      case 'task.status': {
        const t = this.tasks.get(e.taskId)
        if (!t) break
        if (e.station) t.station = e.station
        // (the agent's own ETA is kept as an end time, so it survives later statuses that don't repeat it)
        const claimEnd = e.eta !== undefined ? e.t + e.eta * 1000 : t.status?.claimEnd
        t.status = { t: e.t, label: e.label, detail: e.detail, claimEnd }
        const a = agents.get(t.agentId)
        if (a) a.need = null
        break
      }
      case 'task.progress': {
        const t = this.tasks.get(e.taskId)
        if (!t) break
        if (!t.progress || t.progress.done !== e.done || t.progress.total !== e.total) t.progress = { t: e.t, done: e.done, total: e.total }
        const a = agents.get(t.agentId)
        if (a) a.need = null
        break
      }
      case 'task.paused': {
        const t = this.tasks.get(e.taskId)
        if (t) t.paused = e.paused ? e : null
        break
      }
      case 'task.file': {
        const t = this.tasks.get(e.taskId)
        if (t) t.files = [e, ...t.files.filter((f) => f.path !== e.path)].slice(0, 8)
        break
      }
      case 'task.done':
      case 'task.failed': {
        const t = this.tasks.get(e.taskId)
        if (!t) break
        this.tasks.delete(e.taskId)
        const a = agents.get(t.agentId)
        if (a?.task === e.taskId) {
          a.task = null
          a.need = null
        }
        break
      }
      case 'agent.needs_input': {
        const a = agents.get(e.agentId)
        if (a) a.need = e
        break
      }
      case 'agent.idle': {
        const a = agents.get(e.agentId)
        if (!a) break
        if (a.task) tasks.delete(a.task)
        a.task = null
        a.need = null
        break
      }
      case 'agent.usage': {
        const a = agents.get(e.agentId)
        if (a) a.usage = e
        break
      }
      case 'limits.update':
        this.limits.set(e.service, e)
        break
      case 'agent.said': {
        // (a thread: the last CHAT messages, oldest first; the same id is the same message, replaced in place)
        const a = agents.get(e.agentId)
        if (!a) break
        const i = e.id ? a.chat.findIndex((m) => m.id === e.id) : -1
        if (i >= 0) a.chat[i] = { ...e, t: a.chat[i].t }
        else a.chat = [...a.chat, e].slice(-CHAT)
        break
      }
    }
  }

  names() {
    return new Set([...this.agents.values()].map((a) => a.spawned.name))
  }

  /** The current world as events, oldest first. */
  snapshot() {
    const out = [...this.limits.values()]
    for (const a of this.agents.values()) {
      out.push(a.spawned)
      if (a.usage) out.push(a.usage)
      for (const m of a.chat) out.push(m)
      const t = a.task && this.tasks.get(a.task)
      if (t) {
        out.push({ type: 'task.assigned', t: t.startedAt, taskId: t.id, agentId: t.agentId, station: t.station, label: t.title, total: t.total })
        if (t.progress) out.push({ type: 'task.progress', t: t.progress.t, taskId: t.id, done: t.progress.done, total: t.progress.total })
        if (t.status) {
          const s = t.status
          const eta = s.claimEnd !== undefined ? Math.max(0, Math.round((s.claimEnd - s.t) / 1000)) : undefined
          out.push({ type: 'task.status', t: s.t, taskId: t.id, label: s.label, detail: s.detail, eta })
        }
        for (const f of [...t.files].reverse()) out.push(f)
        if (t.paused) out.push(t.paused)
      }
      if (a.need) out.push(a.need)
    }
    return out
  }
}
