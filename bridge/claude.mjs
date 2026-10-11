// Claude Code adapter: hook payloads in (the http hooks from `bloobies hooks`), protocol events out.
//
// One Claude Code session is a lead bloobie; every subagent it starts is another bloobie, handed its task by the
// lead and picked up by the shuttle when it stops. A prompt gives the lead a task, finishing the turn (Stop)
// finishes it. Tool calls move the work between stations, TodoWrite / the task tools are the progress (and so the
// ETA), permission prompts and questions raise the yellow flag, and the `bloobies` MCP status tool lets an agent
// name its own task.
//
// Privacy: nothing here leaves the machine, and tool inputs are summarised (a file name, a program name), never
// passed on in full. Prompts become a ground label of at most 22 characters.
import path from 'node:path'
import { NAMES, shortLabel, stationFor } from '../protocol/index.js'

const READS = new Set(['Read', 'Grep', 'Glob', 'LS', 'WebSearch', 'WebFetch', 'NotebookRead'])
const EDITS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit'])
const SHELLS = new Set(['Bash', 'PowerShell'])
const DELEGATE = new Set(['Agent', 'Task'])
const STATUS_TOOL = 'mcp__bloobies__status'

const DESIGN_FILE = /\.(css|scss|sass|less|svg|png|jpe?g|gif|webp|fig|sketch)$|tailwind\.config|(^|[\\/])(styles?|theme|tokens?|design)([\\/.]|$)/i
const TEST_FILE = /([._\\/-](test|spec)s?[._\\/-])|__tests__|(^|[\\/])tests?[\\/]/i
const SHIP_CMD = /\b(git push|deploy|publish|release|vercel|netlify|docker push|gh release)\b/i
const TEST_CMD = /\b(test|tests|jest|vitest|mocha|pytest|playwright|cypress|rspec|phpunit|tsc|typecheck|lint|eslint|check)\b/i
const REVIEW_CMD = /\b(git (diff|log|show|status|blame)|gh pr)\b/i
// (fetching a page is looking too; kept apart from LOOK_CMD, whose alternation reads like a pipe to a scanner)
const FETCH_CMD = /^\s*curl\s/i
const LOOK_CMD = /^\s*(ls|dir|cat|type|head|tail|find|grep|rg|tree|wc|less|which|where|pwd|get-childitem|get-content|select-string)\b/i

/** Where a tool call happens, or null for calls that don't say (bookkeeping, MCP tools…). */
export function stationOfTool(name, input) {
  if (READS.has(name)) return 'research'
  if (EDITS.has(name)) {
    const f = String(input.file_path ?? input.notebook_path ?? '')
    return DESIGN_FILE.test(f) ? 'design' : TEST_FILE.test(f) ? 'test' : 'build'
  }
  if (SHELLS.has(name)) {
    const c = String(input.command ?? '')
    if (SHIP_CMD.test(c)) return 'ship'
    if (TEST_CMD.test(c)) return 'test'
    if (REVIEW_CMD.test(c)) return 'review'
    if (LOOK_CMD.test(c) || FETCH_CMD.test(c)) return 'research'
    return 'build'
  }
  return null
}

/** Where a subagent starts, from its type and the lead's description of the job. */
function stationOfAgent(type, desc) {
  const t = String(type).toLowerCase()
  if (/review/.test(t)) return 'review'
  if (/test|qa/.test(t)) return 'test'
  if (/design|art/.test(t)) return 'design'
  const s = stationFor(desc)
  if (s !== 'build') return s
  return /explore|plan|research|scout|search|guide/.test(t) ? 'research' : 'build'
}

/** A file path as the panel shows it: relative to the project, forward slashes. */
function rel(file, cwd) {
  if (!file) return ''
  let f = String(file)
  if (cwd && path.isAbsolute(f)) {
    const r = path.relative(cwd, f)
    if (!r.startsWith('..') && !path.isAbsolute(r)) f = r
  }
  return f.replace(/\\/g, '/').slice(-200)
}

/** A shell command as a program name and, if harmless looking, its subcommand. Never arguments or values. */
export function commandGist(cmd) {
  // (`cd "<folder>" && wc -l notes.txt` is about wc: skip a leading change of folder)
  const main = String(cmd).trim().replace(/^(cd|set-location|pushd)\s+("[^"]*"|'[^']*'|\S+)\s*(&&|;|\|\|)\s*/i, '')
  const words = main.split(/\s+/)
  const prog = path.basename((words[0] ?? '').replace(/^["']|["']$/g, '')) || 'shell'
  const sub = words[1] && /^[a-z][\w:.-]{0,20}$/i.test(words[1]) ? ` ${words[1]}` : ''
  return `${prog}${sub}`.slice(0, 40)
}

export function detailOf(name, input, cwd) {
  if (name === 'Read') return `Reading ${path.basename(String(input.file_path ?? ''))}`
  if (EDITS.has(name)) return `${name === 'Write' ? 'Writing' : 'Editing'} ${path.basename(String(input.file_path ?? input.notebook_path ?? ''))}`
  if (name === 'Grep') return 'Searching the code'
  if (name === 'Glob' || name === 'LS') return 'Looking for files'
  if (name === 'WebSearch') return 'Searching the web'
  if (name === 'WebFetch') {
    try {
      return `Reading ${new URL(String(input.url)).hostname}`
    } catch {
      return 'Reading a web page'
    }
  }
  if (SHELLS.has(name)) return `$ ${commandGist(input.command)}`
  if (name.startsWith('mcp__')) return name.split('__').slice(1).join(' · ').slice(0, 60)
  return name.slice(0, 40)
}

/** What a permission prompt is asking, in a few words. */
function askOf(name, input, cwd) {
  if (SHELLS.has(name)) return `Run ${commandGist(input.command)}?`
  if (EDITS.has(name)) return `${name === 'Write' ? 'Write' : 'Edit'} ${path.basename(String(input.file_path ?? input.notebook_path ?? ''))}?`
  if (name === 'WebFetch') return `${detailOf(name, input, cwd)}?`
  if (name.startsWith('mcp__')) return `Use ${name.split('__').slice(1).join(' ')}?`
  return `Use ${name}?`
}

/** Prompts come with pasted blocks, reminders and command wrappers: keep the words the person typed. */
function promptText(p) {
  let s = String(p ?? '')
  const cmd = s.match(/<command-name>\/?([^<]+)<\/command-name>/)
  if (cmd) return cmd[1].replace(/[-_:]/g, ' ')
  s = s
    .replace(/<(pasted_content|system-reminder|command-message|command-args|local-command-stdout)[^>]*>[\s\S]*?<\/\1>/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return s
}

const clip = (s, n) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim()
  return t.length > n ? t.slice(0, n - 1) + '…' : t
}

/** Context window size: 1M for the long-context models (or once a session is past 200k), else 200k. */
const windowFor = (model, tokens) => (/\[1m\]|-1m\b/i.test(model ?? '') || tokens > 200_000 ? 1_000_000 : 200_000)

export class ClaudeAdapter {
  /**
   * @param {object} o
   * @param {(e: object) => void} o.emit       protocol events out
   * @param {() => number} [o.now]             clock (ms)
   * @param {(file: string) => ({ tokens: number, model?: string } | null)} [o.readUsage]  context from a transcript
   * @param {(ms: number, fn: () => void) => void} [o.later]  timers (tests pass a fake)
   * @param {() => Set<string>} [o.namesInUse] names other sources already gave out
   */
  constructor({ emit, now = Date.now, readUsage = () => null, later = (ms, fn) => setTimeout(fn, ms).unref?.(), namesInUse = () => new Set() }) {
    this.out = emit
    this.now = now
    this.readUsage = readUsage
    this.later = later
    this.namesInUse = namesInUse
    this.sessions = new Map()
    this.agents = new Map()
    this.nextName = 0
    this.seq = 0
  }

  emit(e) {
    this.out({ t: this.now(), ...e })
  }

  /** One hook payload (the JSON Claude Code posts). Unknown events are ignored. */
  handle(p) {
    if (!p || typeof p !== 'object' || typeof p.session_id !== 'string') return
    const ev = p.hook_event_name
    const s = this.session(p)
    s.lastAt = this.now()
    switch (ev) {
      case 'SessionStart':
        return
      case 'SessionEnd':
        return this.endSession(p.session_id)
      case 'UserPromptSubmit':
        return this.prompt(s, p)
      case 'PreToolUse':
        return this.preTool(this.agentFor(s, p), p)
      case 'PostToolUse':
        return this.postTool(this.agentFor(s, p), p, true)
      case 'PostToolUseFailure':
        return this.postTool(this.agentFor(s, p), p, false)
      case 'PermissionRequest': {
        const a = this.agentFor(s, p)
        // (a question or a plan raised the flag at PreToolUse already, with better words)
        if ((p.tool_name === 'AskUserQuestion' || p.tool_name === 'ExitPlanMode') && a.need) return
        return this.need(a, 'permission', askOf(p.tool_name ?? '', p.tool_input ?? {}, s.cwd))
      }
      case 'Notification': {
        const a = this.agentFor(s, p)
        // (the PermissionRequest hook already raised the flag on whichever agent asked: this one is the
        // terminal's own notice for the same prompt, sent from the session)
        const raised = [s.lead, ...s.subs.values()].some((x) => x?.need)
        if (p.notification_type === 'permission_prompt' && !raised) this.need(a, 'permission', clip(p.message || 'Needs your permission', 80))
        else if (/elicitation_dialog|agent_needs_input/.test(p.notification_type ?? '')) this.need(a, 'question', clip(p.message || 'Has a question', 80))
        return
      }
      case 'SubagentStart':
        return this.subStart(s, p)
      case 'SubagentStop':
        return this.subStop(s, p)
      case 'Stop':
        return this.stop(this.lead(s), p)
      case 'StopFailure': {
        const a = this.lead(s)
        if (!a.task) return
        const reason = clip(p.error || 'API error', 40)
        this.emit({ type: 'task.failed', taskId: a.task, reason, kind: /rate|limit|quota|overload/i.test(reason) ? 'blocked' : 'error' })
        return this.taskEnded(a)
      }
      case 'PostCompact': {
        const a = this.agentFor(s, p)
        a.context = Math.min(a.context, 0.1)
        return this.emit({ type: 'agent.usage', agentId: a.id, context: a.context })
      }
      case 'TaskCreated':
      case 'TaskCompleted': {
        const a = this.agentFor(s, p)
        const id = String(p.task_id ?? '')
        if (!id) return
        const prev = a.todos.get(id)
        a.todos.set(id, {
          text: p.task_subject ?? prev?.text ?? '',
          active: prev?.active,
          status: ev === 'TaskCompleted' ? 'completed' : (prev?.status ?? 'pending'),
        })
        return this.progress(a)
      }
    }
  }

  // ---- who ----

  session(p) {
    let s = this.sessions.get(p.session_id)
    if (!s) {
      s = { id: p.session_id, cwd: p.cwd ?? '', lead: null, subs: new Map(), pending: [], lastAt: this.now(), transcript: p.transcript_path }
      this.sessions.set(p.session_id, s)
    }
    if (p.transcript_path) s.transcript = p.transcript_path
    return s
  }

  lead(s) {
    if (!s.lead) {
      const id = `cc-${s.id.slice(0, 8)}`
      const project = path.basename(String(s.cwd || '')) || 'session'
      s.lead = this.spawn(s, id, null, clip(`lead · ${project}`, 40), true)
    }
    return s.lead
  }

  agentFor(s, p) {
    const lead = this.lead(s)
    if (!p.agent_id) return lead
    let a = s.subs.get(p.agent_id)
    // (a hook from a subagent whose start we missed, e.g. the bridge started mid-session)
    if (!a) a = this.spawnSub(s, p.agent_id, p.agent_type ?? 'subagent')
    return a
  }

  pickName() {
    const used = new Set([...this.agents.values()].map((a) => a.name))
    for (const n of this.namesInUse()) used.add(n)
    for (let i = 0; i < NAMES.length; i++) {
      const n = NAMES[(this.nextName + i) % NAMES.length]
      if (!used.has(n)) {
        this.nextName += i + 1
        return n
      }
    }
    return `${NAMES[this.nextName++ % NAMES.length]}${Math.floor(this.nextName / NAMES.length) + 1}`
  }

  spawn(s, id, sub, role, lead = false) {
    const a = {
      id,
      sid: s.id,
      sub,
      name: this.pickName(),
      lead,
      task: null,
      station: null,
      label: '',
      detail: '',
      detailAt: 0,
      cand: null,
      movedAt: 0,
      todos: new Map(),
      progress: '',
      need: false,
      context: 0,
      usageAt: 0,
      transcript: null,
    }
    this.agents.set(id, a)
    this.emit({ type: 'agent.spawned', agentId: id, name: a.name, lead: lead || undefined, role })
    return a
  }

  spawnSub(s, agentId, type) {
    const a = this.spawn(s, `cc-${s.id.slice(0, 8)}-${String(agentId).slice(-8)}`, agentId, clip(type, 40))
    s.subs.set(agentId, a)
    return a
  }

  // ---- what ----

  newTask(a, station, label, total) {
    a.task = `${a.id}-t${++this.seq}`
    a.station = station
    a.label = label
    a.detail = ''
    a.cand = null
    a.movedAt = this.now()
    a.todos = new Map()
    a.progress = ''
    this.emit({ type: 'task.assigned', taskId: a.task, agentId: a.id, station, label, total })
  }

  ensureTask(a, station, label) {
    if (!a.task) this.newTask(a, station ?? 'build', label ?? 'Working')
  }

  taskEnded(a) {
    a.task = null
    a.need = false
    a.cand = null
  }

  prompt(s, p) {
    const a = this.lead(s)
    const text = promptText(p.prompt) || 'New request'
    const label = shortLabel(text)
    if (a.task) {
      a.label = label
      this.status(a, { label })
    } else this.newTask(a, stationFor(text), label)
  }

  /** A task.status with whatever changed; `force` sends it even if nothing did (it clears a raised flag). */
  status(a, { label = a.label, detail = a.detail, station, eta, force = false } = {}) {
    if (!a.task) return
    label = clip(label, 60)
    detail = clip(detail, 120)
    const changed = label !== a.label || detail !== a.detail || station || eta !== undefined
    a.label = label
    a.detail = detail
    if (!changed && !force) return
    a.detailAt = this.now()
    this.emit({ type: 'task.status', taskId: a.task, label, detail: detail || undefined, station: station || undefined, eta })
  }

  need(a, kind, text) {
    a.need = true
    this.emit({ type: 'agent.needs_input', agentId: a.id, kind, text: clip(text, 100) })
  }

  /** The flag comes down once the agent gets going again. */
  clearNeed(a) {
    if (!a.need) return
    a.need = false
    if (a.task) this.status(a, { force: true })
  }

  /**
   * Work moves stations only on evidence: the same new station twice in a row (an edit counts double), and not
   * within 8 s of the last move, so one stray `ls` doesn't send a bloobie across the map.
   */
  vote(a, station, weight) {
    if (!station || !a.task) return null
    if (station === a.station) {
      a.cand = null
      return null
    }
    a.cand = a.cand?.station === station ? { station, n: a.cand.n + weight } : { station, n: weight }
    const settled = this.now() - a.movedAt > 8000
    if ((a.cand.n >= 2 && settled) || a.cand.n >= 5) {
      a.station = station
      a.movedAt = this.now()
      a.cand = null
      return station
    }
    return null
  }

  preTool(a, p) {
    const name = String(p.tool_name ?? '')
    const input = p.tool_input && typeof p.tool_input === 'object' ? p.tool_input : {}
    const cwd = p.cwd ?? this.sessions.get(a.sid)?.cwd
    if (name !== 'AskUserQuestion' && name !== 'ExitPlanMode') this.clearNeed(a)

    if (name === STATUS_TOOL) {
      this.ensureTask(a, null, shortLabel(promptText(input.label)))
      const mins = Number(input.eta)
      return this.status(a, {
        label: shortLabel(promptText(input.label)) || a.label,
        eta: Number.isFinite(mins) && mins > 0 ? Math.round(mins * 60) : undefined,
      })
    }
    if (DELEGATE.has(name)) {
      const type = String(input.subagent_type ?? 'general-purpose')
      this.sessions.get(a.sid)?.pending.push({ type, desc: String(input.description ?? input.prompt ?? type), at: this.now() })
      this.ensureTask(a, 'build', 'Delegating')
      return this.status(a, { detail: `Briefing ${clip(type, 24)}` })
    }
    if (name === 'TodoWrite') {
      a.todos = new Map((Array.isArray(input.todos) ? input.todos : []).map((t, i) => [String(i), { text: t.content, active: t.activeForm, status: t.status }]))
      return this.progress(a)
    }
    if (name === 'TaskUpdate') {
      const id = String(input.taskId ?? input.task_id ?? '')
      const prev = a.todos.get(id) ?? { text: input.subject ?? '', status: 'pending' }
      if (input.status === 'deleted') a.todos.delete(id)
      else a.todos.set(id, { text: input.subject ?? prev.text, active: input.activeForm ?? prev.active, status: input.status ?? prev.status })
      return this.progress(a)
    }
    if (name === 'AskUserQuestion') {
      const q = input.questions?.[0]?.question ?? input.question ?? 'Has a question'
      this.ensureTask(a, null, null)
      return this.need(a, 'question', clip(q, 100))
    }
    if (name === 'ExitPlanMode') {
      this.ensureTask(a, 'design', 'Planning')
      return this.need(a, 'permission', 'Approve the plan?')
    }

    const where = stationOfTool(name, input)
    this.ensureTask(a, where, null)
    // (an edit, or a test / deploy run, is the work itself: it counts double)
    const strong = EDITS.has(name) || (SHELLS.has(name) && (where === 'test' || where === 'ship'))
    const moved = this.vote(a, where, strong ? 2 : 1)
    const detail = detailOf(name, input, cwd)
    if (moved || (detail !== a.detail && this.now() - a.detailAt > 1500)) this.status(a, { detail, station: moved })
    if (name === 'Read' && input.file_path && a.task) this.emit({ type: 'task.file', taskId: a.task, path: rel(input.file_path, cwd), op: 'read' })
  }

  postTool(a, p, ok) {
    const name = String(p.tool_name ?? '')
    const input = p.tool_input && typeof p.tool_input === 'object' ? p.tool_input : {}
    const cwd = p.cwd ?? this.sessions.get(a.sid)?.cwd
    this.clearNeed(a)
    if (!ok && p.is_interrupt && a.task) {
      // (Esc in the terminal: the turn ends here, with no Stop)
      this.emit({ type: 'task.failed', taskId: a.task, reason: 'Interrupted', kind: 'blocked' })
      this.taskEnded(a)
      return
    }
    if (ok && EDITS.has(name) && a.task) {
      const f = input.file_path ?? input.notebook_path
      const op = name === 'Write' && p.tool_response?.type === 'create' ? 'create' : 'edit'
      if (f) this.emit({ type: 'task.file', taskId: a.task, path: rel(f, cwd), op })
    }
    if (ok && name === 'TaskCreate') {
      const r = p.tool_response ?? {}
      const id = String(r.task?.id ?? r.id ?? r.taskId ?? `new-${a.todos.size}`)
      if (!a.todos.has(id)) a.todos.set(id, { text: input.subject ?? r.task?.subject ?? '', active: input.activeForm, status: 'pending' })
      this.progress(a)
    }
    this.usage(a, p)
  }

  /** The todo list (TodoWrite, or the newer task tools): progress for the ETA, and the current item as the label. */
  progress(a) {
    const items = [...a.todos.values()]
    if (!items.length) return
    this.ensureTask(a, null, null)
    const done = items.filter((t) => t.status === 'completed').length
    const key = `${done}/${items.length}`
    if (key !== a.progress) {
      a.progress = key
      this.emit({ type: 'task.progress', taskId: a.task, done, total: items.length })
    }
    const now = items.find((t) => t.status === 'in_progress')
    if (now) this.status(a, { label: shortLabel(promptText(now.active || now.text)) || a.label })
  }

  subStart(s, p) {
    const lead = this.lead(s)
    const type = String(p.agent_type ?? 'subagent')
    const a = s.subs.get(p.agent_id) ?? this.spawnSub(s, p.agent_id, type)
    // the lead's Agent call carried the description: match it by type, oldest first
    const i = s.pending.findIndex((d) => d.type === type)
    const job = s.pending.splice(i >= 0 ? i : 0, 1)[0]
    const desc = job?.desc ?? type
    this.ensureTask(lead, 'build', 'Delegating')
    a.task = `${a.id}-t${++this.seq}`
    a.station = stationOfAgent(type, desc)
    a.label = shortLabel(promptText(desc)) || type
    a.movedAt = this.now()
    this.emit({ type: 'task.handoff', taskId: a.task, from: lead.id, to: a.id, station: a.station, label: a.label })
  }

  subStop(s, p) {
    const a = s.subs.get(p.agent_id)
    if (!a) return
    if (p.agent_transcript_path) a.transcript = p.agent_transcript_path
    this.usage(a, p, true)
    if (a.task) {
      this.emit({ type: 'task.done', taskId: a.task })
      this.taskEnded(a)
    }
    s.subs.delete(p.agent_id)
    // (long enough for the done beat at the station, then the shuttle comes)
    this.later(7000, () => this.retire(a))
  }

  stop(a, p) {
    this.usage(a, p, true)
    if (!a.task) return
    this.emit({ type: 'task.done', taskId: a.task })
    this.taskEnded(a)
  }

  retire(a) {
    if (!this.agents.has(a.id)) return
    this.agents.delete(a.id)
    this.emit({ type: 'agent.retired', agentId: a.id })
  }

  endSession(sid) {
    const s = this.sessions.get(sid)
    if (!s) return
    for (const a of s.subs.values()) this.retire(a)
    if (s.lead) this.retire(s.lead)
    this.sessions.delete(sid)
  }

  /** Sessions that went quiet for this long are gone (a closed terminal sends no SessionEnd). Sessions the
   *  bridge launched (`kept`) stay: their lead waits at HQ for the next task. */
  sweep(maxIdleMs = 30 * 60_000) {
    for (const s of [...this.sessions.values()]) if (!s.kept && this.now() - s.lastAt > maxIdleMs) this.endSession(s.id)
  }

  // ---- for sessions the bridge launched (runs.mjs) ----

  /** A launched session's lead, in the world from the moment it starts (before its first hook). */
  adopt(sessionId, cwd) {
    const s = this.session({ session_id: sessionId, cwd })
    s.kept = true
    return this.lead(s)
  }

  agent(id) {
    return this.agents.get(id)
  }

  /** The agent a hook payload is about (spawning it if it's new), without handling the hook. */
  who(p) {
    return this.agentFor(this.session(p), p)
  }

  /** End an agent's task as failed (stopped by you, the run crashed, not signed in…). */
  failTask(a, reason, kind = 'blocked') {
    if (!a?.task) return
    this.emit({ type: 'task.failed', taskId: a.task, reason: clip(reason, 40), kind })
    this.taskEnded(a)
  }

  /** The run is over: its helpers go home (after their beat), the lead stays. */
  endSubs(sessionId, reason = 'Stopped') {
    const s = this.sessions.get(sessionId)
    if (!s) return
    for (const a of s.subs.values()) {
      this.failTask(a, reason)
      this.later(4000, () => this.retire(a))
    }
    s.subs.clear()
    s.pending = []
  }

  /** Forget a launched session entirely (its lead goes home too). */
  release(sessionId) {
    this.endSession(sessionId)
  }

  /** How full the context is, read from the transcript Claude Code writes anyway (at most every 4 s). */
  usage(a, p, force = false) {
    if (!force && this.now() - a.usageAt < 4000) return
    a.usageAt = this.now()
    const main = p.transcript_path ?? this.sessions.get(a.sid)?.transcript
    const file = a.sub ? (a.transcript ?? (main ? path.join(main.replace(/\.jsonl$/, ''), 'subagents', `agent-${a.sub}.jsonl`) : null)) : main
    if (!file) return
    const u = this.readUsage(file)
    if (!u) return
    const context = Math.min(1, u.tokens / windowFor(u.model, u.tokens))
    if (Math.abs(context - a.context) < 0.01) return
    a.context = context
    this.emit({ type: 'agent.usage', agentId: a.id, context: Math.round(context * 1000) / 1000, tokens: u.tokens })
  }
}
