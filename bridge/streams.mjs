// Codex CLI and Cursor CLI runs (phase 5): both print one JSON object per line while they work (`codex exec
// --json`, `cursor-agent -p --output-format stream-json`). A run is one bloobie; each line moves it between stations,
// names what it's doing, and counts its todo list, the same way Claude Code's hooks do.
//
// The line shapes follow each tool's docs (Oct 2026): Codex documents thread/turn/item events; Cursor documents the
// event types (system, assistant, tool_call, result) but not every field, so the Cursor reader is forgiving and
// skips what it doesn't recognise. Neither has been run against the real program on this machine yet.
import path from 'node:path'
import { shortLabel, stationFor } from '../protocol/index.js'
import { commandGist, stationOfTool } from './claude.mjs'

const clip = (s, n) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim()
  return t.length > n ? t.slice(0, n - 1) + '…' : t
}

/** One bloobie following one CLI run. `emit` is the bridge's publish. */
export class StreamAgent {
  constructor({ id, name, role, source, emit, now = Date.now, cwd }) {
    this.id = id
    this.name = name
    this.out = emit
    this.now = now
    this.cwd = cwd
    this.task = null
    this.seq = 0
    this.station = null
    this.label = ''
    this.detail = ''
    this.detailAt = 0
    this.movedAt = 0
    this.cand = null
    this.progress = ''
    this.emit({ type: 'agent.spawned', agentId: id, name, role, source, project: cwd ? clip(path.basename(cwd), 80) : undefined })
  }

  emit(e) {
    this.out({ t: this.now(), ...e })
  }

  start(text) {
    this.end()
    this.task = `${this.id}-t${++this.seq}`
    this.station = stationFor(text)
    this.label = shortLabel(text) || 'Working'
    this.movedAt = this.now()
    this.cand = null
    this.progress = ''
    this.emit({ type: 'task.assigned', taskId: this.task, agentId: this.id, station: this.station, label: this.label })
  }

  /** Same rule as the Claude adapter: a new station needs two votes and 8 s since the last move (or five votes). */
  work(station, detail, weight = 1) {
    if (!this.task) return
    let moved
    if (station && station !== this.station) {
      this.cand = this.cand?.station === station ? { station, n: this.cand.n + weight } : { station, n: weight }
      if ((this.cand.n >= 2 && this.now() - this.movedAt > 8000) || this.cand.n >= 5) {
        moved = this.station = station
        this.movedAt = this.now()
        this.cand = null
      }
    } else if (station) this.cand = null
    detail = clip(detail, 120)
    if (moved || (detail && detail !== this.detail && this.now() - this.detailAt > 1500)) {
      this.detail = detail
      this.detailAt = this.now()
      this.emit({ type: 'task.status', taskId: this.task, label: this.label, detail: detail || undefined, station: moved })
    }
  }

  file(p, op) {
    if (!this.task || !p) return
    let f = String(p)
    if (this.cwd && path.isAbsolute(f)) {
      const r = path.relative(this.cwd, f)
      if (!r.startsWith('..')) f = r
    }
    this.emit({ type: 'task.file', taskId: this.task, path: f.replace(/\\/g, '/').slice(-200), op })
  }

  todos(items) {
    if (!this.task || !items.length) return
    const done = items.filter((t) => t.done).length
    const key = `${done}/${items.length}`
    if (key !== this.progress) {
      this.progress = key
      this.emit({ type: 'task.progress', taskId: this.task, done, total: items.length })
    }
    const now = items.find((t) => !t.done)
    if (now?.text) {
      const label = shortLabel(now.text)
      if (label && label !== this.label) {
        this.label = label
        this.emit({ type: 'task.status', taskId: this.task, label })
      }
    }
  }

  usage(tokens, window = 0) {
    if (!(tokens > 0)) return
    const context = window > 0 ? Math.min(1, tokens / window) : 0
    this.emit({ type: 'agent.usage', agentId: this.id, context: Math.round(context * 1000) / 1000, tokens })
  }

  done() {
    if (!this.task) return
    this.emit({ type: 'task.done', taskId: this.task })
    this.task = null
  }

  fail(reason, kind = 'error') {
    if (!this.task) return
    this.emit({ type: 'task.failed', taskId: this.task, reason: clip(reason, 40), kind })
    this.task = null
  }

  /** (a new task, or the run ended without saying how) */
  end() {
    if (this.task) this.done()
  }

  retire() {
    this.end()
    this.emit({ type: 'agent.retired', agentId: this.id })
  }
}

// ---------------------------------------------------------------------------------------------------- Codex

const errText = (e) => clip(typeof e === 'string' ? e : (e?.message ?? e?.error?.message ?? 'Codex error'), 40)

/** One line of `codex exec --json`. Returns { session } when it learns the thread id, { result } at the end, { said } for the agent's words. */
export function codexLine(m, a) {
  switch (m?.type) {
    case 'thread.started':
      return { session: m.thread_id }
    case 'item.started':
    case 'item.updated':
    case 'item.completed': {
      const it = m.item ?? {}
      const done = m.type === 'item.completed'
      if (it.type === 'command_execution') {
        a.work(stationOfTool('Bash', { command: it.command ?? '' }), `$ ${commandGist(it.command ?? '')}`, /test|ship/.test(stationOfTool('Bash', { command: it.command ?? '' }) ?? '') ? 2 : 1)
      } else if (it.type === 'file_change') {
        for (const c of Array.isArray(it.changes) ? it.changes : []) {
          a.work(stationOfTool('Edit', { file_path: c.path ?? '' }), `Editing ${path.basename(String(c.path ?? ''))}`, 2)
          if (done) a.file(c.path, c.kind === 'add' ? 'create' : 'edit')
        }
      } else if (it.type === 'todo_list') {
        a.todos((Array.isArray(it.items) ? it.items : []).map((t) => ({ text: t.text, done: !!t.completed })))
      } else if (it.type === 'web_search') {
        a.work('research', 'Searching the web')
      } else if (it.type === 'mcp_tool_call') {
        a.work(null, clip(`${it.server ?? ''} · ${it.tool ?? ''}`, 60))
      } else if (it.type === 'reasoning' && !done) {
        a.work(null, 'Thinking')
      } else if (it.type === 'error') {
        return { warn: errText(it) }
      } else if (it.type === 'agent_message' && done && typeof it.text === 'string') {
        return { said: it.text }
      }
      return null
    }
    case 'turn.completed': {
      const u = m.usage ?? {}
      a.usage(Number(u.input_tokens ?? 0) + Number(u.output_tokens ?? 0))
      return { result: { ok: true } }
    }
    case 'turn.failed':
      return { result: { ok: false, reason: errText(m.error) } }
    case 'error':
      return { result: { ok: false, reason: errText(m.message ?? m) } }
  }
  return null
}

// --------------------------------------------------------------------------------------------------- Cursor

/** Cursor names its tools `<kind>ToolCall` ({ readToolCall: { args: { path } } }) or `function` ({ name, arguments }). */
function cursorTool(tc) {
  const [key, body] = Object.entries(tc ?? {})[0] ?? []
  if (!key) return null
  if (key === 'function') {
    let args = body?.arguments
    try {
      if (typeof args === 'string') args = JSON.parse(args)
    } catch {}
    return { kind: String(body?.name ?? 'tool'), args: args ?? {} }
  }
  return { kind: key.replace(/ToolCall$/, ''), args: body?.args ?? {} }
}

/** One line of `cursor-agent -p --output-format stream-json`. Returns { session }, { result } like codexLine. */
export function cursorLine(m, a) {
  switch (m?.type) {
    case 'system':
      return m.session_id ? { session: m.session_id } : null
    case 'tool_call': {
      const t = cursorTool(m.tool_call)
      if (!t) return null
      const k = t.kind.toLowerCase()
      const file = t.args.path ?? t.args.file_path ?? t.args.target_file ?? ''
      const done = m.subtype === 'completed'
      if (/^(read|grep|glob|ls|list|search|codebase|semantic|websearch|fetch)/.test(k)) a.work('research', file ? `Reading ${path.basename(String(file))}` : 'Searching the code')
      else if (/^(write|edit|replace|delete|apply|patch)/.test(k)) {
        a.work(stationOfTool('Edit', { file_path: file }), `Editing ${path.basename(String(file))}`, 2)
        if (done && file) a.file(file, /^write/.test(k) ? 'create' : 'edit')
      } else if (/^(shell|run|terminal|bash|command)/.test(k)) {
        const cmd = t.args.command ?? t.args.cmd ?? ''
        const st = stationOfTool('Bash', { command: cmd })
        a.work(st, `$ ${commandGist(cmd)}`, st === 'test' || st === 'ship' ? 2 : 1)
      } else if (/todo/.test(k) && Array.isArray(t.args.todos)) {
        a.todos(t.args.todos.map((x) => ({ text: x.content ?? x.text, done: x.status === 'completed' || x.completed === true })))
      } else a.work(null, clip(t.kind, 40))
      return null
    }
    case 'result':
      return m.is_error
        ? { result: { ok: false, reason: clip(m.result || m.error || 'Cursor error', 40) } }
        : { result: { ok: true }, ...(typeof m.result === 'string' && m.result.trim() && { said: m.result, final: true }) }
  }
  return null
}
