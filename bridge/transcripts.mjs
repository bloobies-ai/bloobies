// Sessions that were already running when the bridge started never loaded the plugin's hooks, so they send nothing.
// Claude Code writes every session's transcript (~/.claude/projects/<project>/<session>.jsonl) as it goes, though, so
// this follows the recently written ones and turns each new line into the same payload a hook would have posted.
// Read-only, and only on this machine: the lines go straight into the adapter, which keeps the same privacy line.
// A session that does send real hooks is skipped (seen(), called from the hook route), so nothing is counted twice.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const TAIL = 512 * 1024 // how far back to look for the current turn when a file is first picked up
const READ_MAX = 2 * 1024 * 1024 // per file per tick

export const projectsDir = () => path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'projects')

const QUIET = new Set(['Read', 'Grep', 'Glob', 'LS', 'TodoWrite', 'TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet', 'ToolSearch', 'Skill', 'ScheduleWakeup', 'ReadNotifications', 'AskUserQuestion', 'ExitPlanMode'])
const EDITS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])
const ASK_AFTER = 5000 // a tool call with no result this long, that the person's rules don't allow, is waiting on them

const readJson = (f) => {
  try {
    return JSON.parse(fs.readFileSync(f, 'utf8'))
  } catch {
    return null
  }
}

/** The allow rules Claude Code would apply to a session in this folder (user, project, project-local settings). */
export function allowRules(cwd, configDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude')) {
  const files = [path.join(configDir, 'settings.json'), ...(cwd ? [path.join(cwd, '.claude', 'settings.json'), path.join(cwd, '.claude', 'settings.local.json')] : [])]
  return files.flatMap((f) => readJson(f)?.permissions?.allow ?? []).filter((r) => typeof r === 'string')
}

/** Does an allow rule like Bash(git status:*), Edit, or mcp__x cover this call? */
export function allowed(rules, name, input) {
  const text = String(input?.command ?? input?.file_path ?? input?.url ?? input?.path ?? '')
  return rules.some((r) => {
    const m = r.match(/^([^(]+)(?:\((.*)\))?$/)
    if (!m) return false
    const [, tool, spec] = m
    if (tool !== name && !(name.startsWith('mcp__') && name.startsWith(tool) && (tool.endsWith('__') || tool.split('__').length < name.split('__').length))) return false
    if (spec === undefined || spec === '' || spec === '*') return true
    if (spec.endsWith(':*')) return text.startsWith(spec.slice(0, -2))
    if (spec.endsWith('*')) return text.startsWith(spec.slice(0, -1))
    return text === spec
  })
}

/** The words someone typed in a user line, or null when the line is a tool result, a meta line or a sidechain. */
function promptOf(o) {
  if (o.type !== 'user' || o.isSidechain || o.isMeta) return null
  const c = o.message?.content
  if (typeof c === 'string') return c
  if (Array.isArray(c) && !c.some((b) => b?.type === 'tool_result')) {
    const t = c.filter((b) => b?.type === 'text').map((b) => b.text).join(' ')
    return t || null
  }
  return null
}

/** Transcript lines -> hook payloads (what ClaudeAdapter.handle takes). `tools` remembers each tool call until its result. */
export function payloadsOf(o, file, tools) {
  if (!o || typeof o !== 'object' || o.isSidechain || typeof o.sessionId !== 'string') return []
  const base = { session_id: o.sessionId, cwd: o.cwd, transcript_path: file }
  const prompt = promptOf(o)
  if (prompt !== null) return /^\s*<(local-command|command-name)/.test(prompt) && !/<command-name>/.test(prompt) ? [] : [{ ...base, hook_event_name: 'UserPromptSubmit', prompt }]
  const c = o.message?.content
  if (!Array.isArray(c)) return []
  const out = []
  if (o.type === 'assistant') {
    for (const b of c)
      if (b?.type === 'tool_use' && b.id) {
        tools.set(b.id, { name: b.name, input: b.input ?? {}, at: Date.parse(o.timestamp) || Date.now(), asked: false, ...base })
        out.push({ ...base, hook_event_name: 'PreToolUse', tool_name: b.name, tool_input: b.input ?? {} })
      }
    if (o.message?.stop_reason === 'end_turn') out.push({ ...base, hook_event_name: 'Stop' })
  } else if (o.type === 'user') {
    for (const b of c)
      if (b?.type === 'tool_result') {
        const t = tools.get(b.tool_use_id)
        if (!t) continue
        tools.delete(b.tool_use_id)
        const text = typeof b.content === 'string' ? b.content : JSON.stringify(b.content ?? '')
        const interrupted = b.is_error && /interrupted by user/i.test(text)
        out.push({
          ...base,
          hook_event_name: b.is_error ? 'PostToolUseFailure' : 'PostToolUse',
          tool_name: t.name,
          tool_input: t.input,
          ...(interrupted && { is_interrupt: true }),
        })
      }
  }
  return out
}

/**
 * @param {object} o
 * @param {(p: object) => void} o.handle      takes one hook-shaped payload
 * @param {string} [o.root]                   the projects folder
 * @param {number} [o.recentMs]               only files written this recently are followed
 * @param {number} [o.every]                  scan interval
 * @param {(line: string) => void} [o.log]
 */
export function startTranscriptWatch({ handle, root = projectsDir(), recentMs = 10 * 60_000, every = 2000, log = () => {}, now = Date.now }) {
  const files = new Map() // path -> { offset, rest, tools, sid }
  const real = new Map() // session id -> when a real hook last came
  let stopped = false

  const feed = (file, st, text, replay) => {
    const lines = (st.rest + text).split('\n')
    st.rest = lines.pop() ?? ''
    const parsed = []
    for (const l of lines) {
      if (!l.trim()) continue
      try {
        parsed.push(JSON.parse(l))
      } catch {}
    }
    let from = 0
    if (replay) {
      // a file just picked up: start at the person's last prompt, so the turn in progress shows
      for (let i = parsed.length - 1; i >= 0; i--) if (promptOf(parsed[i]) !== null) { from = i; break }
      if (from === 0 && !parsed.some((p) => promptOf(p) !== null)) from = parsed.length // (no prompt in the tail: wait for the next one)
    }
    for (const line of parsed) if (line?.permissionMode) st.mode = line.permissionMode
    for (const line of parsed.slice(from)) {
      for (const p of payloadsOf(line, file, st.tools)) {
        st.sid = p.session_id
        if (real.has(p.session_id) && now() - real.get(p.session_id) < 120_000) continue
        try {
          handle(p)
        } catch (err) {
          log(`transcript error: ${err?.message ?? err}`)
        }
      }
    }
  }

  const read = (file, st, from, size, replay) => {
    const fd = fs.openSync(file, 'r')
    try {
      const len = Math.min(size - from, READ_MAX)
      const buf = Buffer.alloc(len)
      fs.readSync(fd, buf, 0, len, from)
      st.offset = from + len
      let text = buf.toString('utf8')
      if (replay && from > 0) text = text.slice(text.indexOf('\n') + 1) // (the first line is cut)
      feed(file, st, text, replay)
    } finally {
      fs.closeSync(fd)
    }
  }

  const scan = () => {
    if (stopped) return
    let dirs = []
    try {
      dirs = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory())
    } catch {
      return
    }
    const t = now()
    for (const d of dirs) {
      let names = []
      try {
        names = fs.readdirSync(path.join(root, d.name)).filter((n) => n.endsWith('.jsonl'))
      } catch {
        continue
      }
      for (const n of names) {
        const file = path.join(root, d.name, n)
        try {
          const stat = fs.statSync(file)
          const st = files.get(file)
          if (!st) {
            if (t - stat.mtimeMs > recentMs) continue
            const s = { offset: 0, rest: '', tools: new Map(), sid: null }
            files.set(file, s)
            read(file, s, Math.max(0, stat.size - TAIL), stat.size, true)
          } else if (stat.size > st.offset) read(file, st, st.offset, stat.size, false)
          else if (stat.size < st.offset) st.offset = stat.size // (rewritten: start over from the end)
        } catch {}
      }
    }
    // a tool call still without a result, that nothing the person set up lets through, is waiting for their yes
    for (const st of files.values()) {
      if (st.mode === 'bypassPermissions') continue
      for (const call of st.tools.values()) {
        if (call.asked || t - call.at < ASK_AFTER || QUIET.has(call.name)) continue
        if (st.mode === 'acceptEdits' && EDITS.has(call.name)) continue
        if (real.has(call.session_id) && t - real.get(call.session_id) < 120_000) continue
        if (allowed(allowRules(call.cwd), call.name, call.input)) continue
        call.asked = true
        try {
          handle({ session_id: call.session_id, cwd: call.cwd, transcript_path: call.transcript_path, hook_event_name: 'PermissionRequest', tool_name: call.name, tool_input: call.input })
        } catch (err) {
          log(`transcript error: ${err?.message ?? err}`)
        }
      }
    }
    // forget files that went quiet
    for (const [file] of files) {
      try {
        if (t - fs.statSync(file).mtimeMs > recentMs * 3) files.delete(file)
      } catch {
        files.delete(file)
      }
    }
  }

  scan()
  const timer = setInterval(scan, every)
  timer.unref?.()
  return {
    /** A real hook arrived for this session: the transcript stays out of it. */
    seen(sessionId) {
      if (sessionId) real.set(sessionId, now())
    },
    close() {
      stopped = true
      clearInterval(timer)
    },
  }
}
