// Runs (phase 5): the bridge starting agents, not just watching them. The page asks (over its token-checked
// WebSocket) for a task in a folder with a permission mode; the bridge starts the program there, headless, and
// the run's bloobies come in on the bus like any other.
//
// Claude Code runs (`claude -p`) get their own hooks, pointed at this bridge with a per-run secret and a long
// timeout, so the bridge can hold a hook open and decide: a permission request waits for your approve / deny from
// the world (PermissionRequest), a paused agent waits at its next tool call, and a stopped helper is turned away at
// its next one (PreToolUse). In master-agent mode the lead is asked to hand the work to subagents, and each one is
// a bloobie handed its task by the lead. The lead stays in the world after a run, waiting for the next task, which
// continues the same conversation (`--resume`).
//
// Codex CLI and Cursor CLI runs are followed from their JSON output (streams.mjs); they can't be asked anything or
// paused mid-run, only stopped.
//
// Safety: only the page holding the bridge's token can start anything; every run states its program, folder and
// permission mode (in the launch form, the reply, the bridge's log and the side panel); the most permissive modes
// (skipping permissions) are never offered; tasks go to the program on stdin or as one argument, never via a shell.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { command } from './find.mjs'
import { HOOK_EVENTS, home, mcpConfig } from './setup.mjs'
import { StreamAgent, codexLine, cursorLine } from './streams.mjs'

/** What each program may be started with, in plain words (shown in the launch form and stated on launch). */
export const MODES = {
  claude: [
    { id: 'default', title: 'Asks you', says: 'asks you before it edits files or runs commands' },
    { id: 'acceptEdits', title: 'Edits freely', says: 'edits files in the folder on its own and asks you before running commands' },
    { id: 'plan', title: 'Plan first', says: 'reads and plans, and changes nothing until you approve the plan' },
    { id: 'auto', title: 'Auto', says: "decides on its own with Claude Code's safety check and asks you only about risky steps" },
  ],
  codex: [
    { id: 'read-only', title: 'Looks only', says: "reads the folder and changes nothing (Codex runs sandboxed and can't ask you)" },
    { id: 'workspace-write', title: 'Edits the folder', says: "edits files inside the folder only, without asking (Codex can't ask you)" },
  ],
  cursor: [
    { id: 'propose', title: 'Proposes only', says: 'suggests changes and writes nothing' },
    { id: 'force', title: 'Edits and runs', says: 'writes files and runs commands without asking' },
  ],
}

const TITLES = { claude: 'Claude Code', codex: 'Codex', cursor: 'Cursor' }

/** How long a held hook may wait for you (seconds). Past it Claude Code gives up: a permission is then denied. */
const HOLD_S = 3600

const TEAM_PROMPT =
  'You are the lead of a small team, shown live as little workers ("bloobies") in a world the person is watching. ' +
  'Plan the work, then hand self-contained parts to subagents with the Agent tool (several at once when they ' +
  'don\'t touch the same files) and coordinate them; do quick things yourself. Give each subagent a short, plain ' +
  'description: it becomes its label in the world. When you start something new, call the bloobies status tool ' +
  'with a 2–3 word label. There is no terminal: the person approves or denies permission requests from the world.'
const SOLO_PROMPT =
  'You are shown live as a little worker ("bloobie") in a world the person is watching. When you start something ' +
  'new, call the bloobies status tool with a 2–3 word label. There is no terminal: the person approves or denies ' +
  'permission requests from the world.'

const STOPPED = 'Stopped by the person watching in bloobies. Stop working now and report back what you have so far.'
const DENIED = 'The person watching in bloobies said no to this.'
const UNANSWERED = 'The person watching chose not to answer. Pick the option you think is best and say which one you picked.'

const clip = (s, n) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim()
  return t.length > n ? t.slice(0, n - 1) + '…' : t
}

/** A message for the thread: trimmed, line breaks kept, at most 4000 characters (the protocol's limit). */
const body = (s) => {
  const t = String(s ?? '').replace(/\r\n?/g, '\n').trim()
  return t.length > 4000 ? t.slice(0, 3999) + '…' : t
}

const same = (a, b) => {
  const x = Buffer.from(String(a))
  const y = Buffer.from(String(b))
  return x.length === y.length && timingSafeEqual(x, y)
}

/** A folder a run may start in: a full path to a directory that exists, not a whole drive or the home folder. */
export function checkFolder(f) {
  const raw = typeof f === 'string' ? f.trim().replace(/^["']|["']$/g, '') : ''
  if (!raw) return [null, 'Pick a folder for it to work in']
  if (!path.isAbsolute(raw)) return [null, `Use the full path to the folder (${process.platform === 'win32' ? 'C:\\code\\my-app' : '/home/you/code/my-app'})`]
  const p = path.resolve(raw)
  let st
  try {
    st = fs.statSync(p)
  } catch {
    return [null, `There's no folder at ${p}`]
  }
  if (!st.isDirectory()) return [null, `${p} is a file, not a folder`]
  if (path.parse(p).root === p) return [null, 'Not a whole drive: pick a project folder']
  if (p === os.homedir()) return [null, 'Not your whole home folder: pick a project folder']
  return [p, null]
}

/** Why a Claude Code run ended badly, in a few words (the ground label), from its result line or its stderr. */
function claudeReason(text, subtype) {
  const t = String(text ?? '')
  if (/not logged in|\/login|log ?in|authenticat|credential/i.test(t)) return ['Claude Code not signed in', 'blocked']
  if (/usage limit|rate limit|quota|overloaded/i.test(t)) return ['Usage limit reached', 'blocked']
  if (subtype === 'error_max_turns') return ['Hit the turn limit', 'error']
  if (subtype === 'error_max_budget_usd') return ['Hit the budget limit', 'blocked']
  return [clip(t, 40) || 'Claude Code error', 'error']
}

function killTree(child) {
  if (!child?.pid) return
  if (process.platform === 'win32') spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }).on('error', () => child.kill())
  else {
    try {
      process.kill(-child.pid, 'SIGTERM')
    } catch {
      child.kill('SIGTERM')
    }
  }
}

/** Lines of a child's stdout, one at a time. */
function lines(stream, fn) {
  let buf = ''
  stream.setEncoding('utf8')
  stream.on('data', (d) => {
    buf += d
    if (buf.length > 4 << 20) buf = buf.slice(-(1 << 20)) // (a runaway line: keep the tail)
    let i
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim()
      buf = buf.slice(i + 1)
      if (!line) continue
      let m
      try {
        m = JSON.parse(line)
      } catch {
        continue
      }
      fn(m)
    }
  })
}

export class Runs {
  /**
   * @param {object} o
   * @param {import('./claude.mjs').ClaudeAdapter} o.claude
   * @param {(e: object) => void} o.publish     protocol events out
   * @param {() => number} o.port              the bridge's port (for the runs' hooks)
   * @param {{ [k: string]: object | null }} o.programs  from find.mjs
   * @param {() => string} o.pickName
   * @param {() => void} [o.changed]           the runs list changed (the server tells the pages)
   * @param {(line: string) => void} [o.log]
   * @param {() => number} [o.now]
   * @param {string} [o.dir]                   where run files and recent folders live (~/.bloobies)
   * @param {string[]} [o.folders]             folders to offer (the bridge's own working folder, --folder)
   */
  constructor({ claude, publish, port, programs, pickName, changed = () => {}, log = () => {}, now = Date.now, dir = home(), folders = [] }) {
    Object.assign(this, { claude, publish, port, programs, pickName, changed, log, now, dir })
    this.offered = folders
    this.runs = new Map()
  }

  emit(e) {
    this.publish({ t: this.now(), ...e })
  }

  // ---- the thread with a run's lead (agent.said): what you sent, and what it answered ----

  /** Your message to the lead, as it is now: waiting its turn (queued), handed over (sent) or never sent (dropped). */
  youSaid(run, msg, state) {
    this.emit({ type: 'agent.said', agentId: msg.agentId ?? run.leadId, id: msg.id, from: 'you', text: msg.text, state })
  }

  /** A message of yours: it goes in the thread at once. */
  newYou(run, text, state, agentId = run.leadId) {
    const msg = { id: `${run.id}-u${++run.msgs}`, text: body(text), agentId }
    this.youSaid(run, msg, state)
    return msg
  }

  /**
   * The lead's own words. An assistant message is a message as it comes; the run's `result` then repeats the last one
   * (so it only marks that one as the end of the turn) or, if it differs, adds the closing message.
   */
  leadSaid(run, text, final) {
    const t = body(text)
    if (!t) return
    if (final && run.lastSaid?.text === t) {
      this.emit({ type: 'agent.said', agentId: run.leadId, id: run.lastSaid.id, text: t, final: true })
    } else {
      const id = `${run.id}-a${++run.msgs}`
      this.emit({ type: 'agent.said', agentId: run.leadId, id, text: t, ...(final && { final: true }) })
      run.lastSaid = { id, text: t }
    }
    if (final) run.lastSaid = null
  }

  // ---- what the page is told ----

  info() {
    const programs = Object.fromEntries(Object.entries(TITLES).map(([k, title]) => [k, this.programs[k] ? { title } : null]))
    return { programs, modes: MODES, folders: this.folders() }
  }

  list() {
    return [...this.runs.values()].map((r) => {
      const mode = MODES[r.program].find((m) => m.id === r.mode)
      return {
        id: r.id,
        program: r.program,
        title: TITLES[r.program],
        folder: r.folder,
        mode: r.mode,
        modeTitle: mode?.title ?? r.mode,
        says: mode?.says ?? '',
        team: r.team,
        leadId: r.leadId,
        working: !!r.child,
        queued: r.queue.length,
        error: r.error,
        canPause: r.program === 'claude',
        canAsk: r.program === 'claude',
      }
    })
  }

  folders() {
    const seen = new Set()
    const out = []
    const add = (f) => {
      if (!f || seen.has(f) || out.length >= 12) return
      seen.add(f)
      if (checkFolder(f)[0]) out.push(f)
    }
    for (const f of this.recent()) add(f)
    for (const f of this.offered) add(path.resolve(f))
    for (const s of this.claude.sessions.values()) add(s.cwd)
    return out
  }

  recent() {
    try {
      const list = JSON.parse(fs.readFileSync(path.join(this.dir, 'folders.json'), 'utf8'))
      return Array.isArray(list) ? list.filter((f) => typeof f === 'string') : []
    } catch {
      return []
    }
  }

  remember(folder) {
    try {
      fs.mkdirSync(this.dir, { recursive: true })
      fs.writeFileSync(path.join(this.dir, 'folders.json'), JSON.stringify([folder, ...this.recent().filter((f) => f !== folder)].slice(0, 8), null, 2) + '\n')
    } catch {}
  }

  /** The run an agent belongs to: its lead, or (Claude Code) one of the lead's helpers. */
  runOf(agentId) {
    for (const r of this.runs.values()) if (agentId === r.leadId || agentId.startsWith(r.leadId + '-')) return r
    return null
  }

  /** Hooks from a launched session also come in through the person's own installed hooks: those are ignored. */
  ownsSession(sessionId) {
    for (const r of this.runs.values()) if (r.sid === sessionId) return true
    return false
  }

  name(agentId) {
    const r = this.runOf(agentId)
    if (r && r.program !== 'claude') return r.agent.name
    return this.claude.agent(agentId)?.name ?? 'It'
  }

  // ---- what the page can do ----

  launch(o = {}) {
    const program = typeof o.program === 'string' ? o.program : 'claude'
    if (!(program in TITLES)) return { ok: false, text: `Unknown program: ${clip(program, 20)}` }
    if (!this.programs[program]) return { ok: false, text: `${TITLES[program]} isn't installed on this machine (or not where the bridge looks)` }
    const mode = MODES[program].find((m) => m.id === o.mode)
    if (!mode) return { ok: false, text: `Pick how much ${TITLES[program]} may do on its own` }
    const [folder, bad] = checkFolder(o.folder)
    if (bad) return { ok: false, text: bad }
    const task = String(o.task ?? '').trim().slice(0, 4000)
    if (!task) return { ok: false, text: 'Say what it should do' }
    if (!command(this.programs[program])) return { ok: false, text: `Can't start ${TITLES[program]} from ${this.programs[program].path} without a shell` }

    const run = {
      id: randomBytes(6).toString('hex'),
      secret: randomBytes(18).toString('base64url'),
      program,
      folder,
      mode: mode.id,
      team: program === 'claude' && o.team !== false,
      sid: program === 'claude' ? randomUUID() : null,
      child: null,
      queue: [],
      asks: new Map(),
      held: [],
      paused: new Set(),
      stopped: new Set(),
      result: null,
      error: null,
      stderr: '',
      userStopped: false,
      leadId: '',
      agent: null,
      msgs: 0,
      lastSaid: null,
    }
    if (program === 'claude') {
      run.files = this.writeFiles(run)
      run.leadId = this.claude.adopt(run.sid, folder).id
    } else {
      run.leadId = `${program === 'codex' ? 'cx' : 'cu'}-${run.id}`
      run.agent = new StreamAgent({ id: run.leadId, name: this.pickName(), role: `${TITLES[program]} · ${path.basename(folder)}`, emit: this.publish, now: this.now, cwd: folder })
    }
    this.runs.set(run.id, run)
    this.remember(folder)
    this.newYou(run, task, 'sent')
    this.start(run, task, false)
    const who = this.name(run.leadId)
    this.log(`run ${run.id}: ${TITLES[program]}${run.team ? ' (lead + helpers)' : ''} in ${folder}, ${mode.title.toLowerCase()} (${mode.id})`)
    this.changed()
    return { ok: true, text: `${who} starts ${TITLES[program]} in ${path.basename(folder)}: ${mode.says}` }
  }

  assign(agentId, text) {
    const run = this.runOf(agentId)
    if (!run) return null
    const task = String(text ?? '').trim().slice(0, 4000)
    if (!task) return { ok: false, text: 'Say what it should do' }
    // An agent that is waiting on you (a permission request or a question) takes your words as the reply, not as a new task.
    if (run.asks.get(agentId)?.length) {
      this.newYou(run, task, 'sent', agentId)
      return this.decide(agentId, 'say', task)
    }
    const lead = this.name(run.leadId)
    if (agentId !== run.leadId) return { ok: false, text: `${this.name(agentId)} works for ${lead}: give the task to ${lead}` }
    if (run.child) {
      run.queue.push({ task, msg: this.newYou(run, task, 'queued') })
      this.changed()
      return { ok: true, text: `Queued: ${lead} starts it when this task is done` }
    }
    this.newYou(run, task, 'sent')
    this.start(run, task, run.program === 'claude')
    this.changed()
    return { ok: true, text: `${lead} is on it` }
  }

  answer(agentId, approve) {
    return this.decide(agentId, approve ? 'approve' : 'deny')
  }

  /**
   * Answer the oldest request an agent is waiting on. 'approve' / 'deny' are the buttons. 'say' is free text from the
   * composer: for a question it is the answer; for a permission it is "no, do this instead" (a deny that carries the
   * person's words to the agent, which reads them as the reason).
   */
  decide(agentId, how, said = '') {
    const run = this.runOf(agentId)
    if (!run) return null
    const list = run.asks.get(agentId)
    const ask = list?.shift()
    if (!ask) return { ok: false, text: run.program === 'claude' ? 'Nothing to answer right now' : `${TITLES[run.program]} can't ask you anything mid-run` }
    const question = ask.tool === 'AskUserQuestion'
    const qs = question && Array.isArray(ask.input.questions) ? ask.input.questions : []
    let decision
    if (how === 'say' && question) {
      // your words answer every question it asked
      decision = { behavior: 'allow', updatedInput: { ...ask.input, answers: Object.fromEntries(qs.map((q) => [String(q.question ?? ''), said])) } }
    } else if (how === 'say') decision = { behavior: 'deny', message: `${DENIED} They want this instead: ${said}` }
    else if (how === 'deny') decision = { behavior: 'deny', message: question ? UNANSWERED : DENIED }
    else if (question) {
      // "Go ahead" = its own first (recommended) option for every question
      const answers = Object.fromEntries(qs.map((q) => [String(q.question ?? ''), String(q.options?.[0]?.label ?? 'Your call')]))
      decision = { behavior: 'allow', updatedInput: { ...ask.input, answers } }
    } else decision = { behavior: 'allow', updatedInput: ask.input }
    ask.reply({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision } })
    const a = this.claude.agent(agentId)
    if (a) {
      this.claude.clearNeed(a)
      // (another request from the same agent was waiting behind this one)
      if (list.length) this.claude.need(a, 'permission', `Use ${list[0].tool}?`)
    }
    const who = this.name(agentId)
    if (how === 'say') return { ok: true, text: question ? `${who} has your answer` : `Told ${who} no, and what to do instead` }
    return { ok: true, text: `${how === 'approve' ? 'Approved' : 'Denied'}: ${who} carries on` }
  }

  pause(agentId) {
    const run = this.runOf(agentId)
    if (!run) return null
    if (run.program !== 'claude') return { ok: false, text: `${TITLES[run.program]} runs can't pause: stop it instead` }
    const a = this.claude.agent(agentId)
    if (!a?.task || !run.child) return { ok: false, text: 'Nothing to pause' }
    if (run.paused.has(agentId)) return { ok: false, text: 'Already paused' }
    run.paused.add(agentId)
    this.emit({ type: 'task.paused', taskId: a.task, paused: true })
    return { ok: true, text: `${a.name} stops at its next step` }
  }

  resume(agentId) {
    const run = this.runOf(agentId)
    if (!run) return null
    if (!run.paused.delete(agentId)) return { ok: false, text: 'It isn\'t paused' }
    const a = this.claude.agent(agentId)
    if (a?.task) this.emit({ type: 'task.paused', taskId: a.task, paused: false })
    this.release(run, agentId, false)
    return { ok: true, text: `${a?.name ?? 'It'} picks it back up` }
  }

  stop(agentId) {
    const run = this.runOf(agentId)
    if (!run) return null
    const who = this.name(agentId)
    if (agentId === run.leadId) {
      if (!run.child) {
        this.forget(run)
        return { ok: true, text: `${who} goes home` }
      }
      run.userStopped = true
      this.dropQueue(run)
      killTree(run.child)
      if (run.program === 'claude') {
        for (const id of [...run.asks.keys()]) this.denyAll(run, id, STOPPED)
        for (const id of new Set(run.held.map((h) => h.agentId))) this.release(run, id, true)
        run.paused.clear()
        this.claude.failTask(this.claude.agent(run.leadId), 'Stopped')
        this.claude.endSubs(run.sid, 'Stopped')
      } else run.agent.fail('Stopped', 'blocked')
      this.changed()
      return { ok: true, text: `Stopped ${who}'s run` }
    }
    // a helper: turned away at its next step, so it reports back to the lead and the run carries on
    run.stopped.add(agentId)
    run.paused.delete(agentId)
    this.denyAll(run, agentId, STOPPED)
    this.release(run, agentId, true)
    this.claude.failTask(this.claude.agent(agentId), 'Stopped')
    return { ok: true, text: `${who} wraps up at its next step` }
  }

  /** Tasks waiting behind the current one are let go (stop): their messages say they were never sent. */
  dropQueue(run) {
    for (const q of run.queue) this.youSaid(run, q.msg, 'dropped')
    run.queue = []
  }

  // ---- hooks from the runs' own sessions ----

  /**
   * One hook post for a run. `reply(body?)` answers it (no body = carry on), `reply(403)` refuses it. Permission
   * requests and a paused agent's tool calls are held: answered later, from answer() / resume() / stop().
   */
  hook(runId, secret, p, reply) {
    const run = this.runs.get(runId)
    if (!run || !secret || !same(secret, run.secret) || !p || typeof p.session_id !== 'string') return reply(403)
    const ev = p.hook_event_name
    // A run's task is the one it was started with, and it ends when the process exits. So the session's own
    // prompts and stops don't count: helpers run in the background, the lead's turn stops while they still work,
    // and their reports come back as new turns (a UserPromptSubmit with a notification, then another Stop).
    // SessionEnd doesn't send the lead home either: it stays for the next task.
    if (ev === 'SessionEnd' || ev === 'UserPromptSubmit' || ev === 'Stop') return reply()
    // (posts already on their way from a run you stopped: they mustn't start the lead on a new task)
    if (!run.child || run.userStopped)
      return reply(ev === 'PreToolUse' ? { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: STOPPED } } : undefined)
    if (ev === 'PreToolUse') {
      const a = this.claude.who(p)
      if (run.stopped.has(a.id)) return reply({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: STOPPED } })
      if (run.paused.has(a.id)) {
        run.held.push({ agentId: a.id, p, reply })
        return
      }
    }
    if (ev === 'PermissionRequest') {
      const a = this.claude.who(p)
      if (run.stopped.has(a.id)) return reply({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'deny', message: STOPPED } } })
      this.claude.handle(p)
      const list = run.asks.get(a.id) ?? []
      list.push({ tool: String(p.tool_name ?? ''), input: p.tool_input && typeof p.tool_input === 'object' ? p.tool_input : {}, reply })
      run.asks.set(a.id, list)
      return
    }
    this.claude.handle(p)
    reply()
  }

  /** A held hook's connection closed before it was answered (Claude Code's timeout: it denies the request). */
  gone(reply) {
    for (const run of this.runs.values()) {
      run.held = run.held.filter((h) => h.reply !== reply)
      for (const [id, list] of run.asks) {
        const i = list.findIndex((x) => x.reply === reply)
        if (i < 0) continue
        list.splice(i, 1)
        const a = this.claude.agent(id)
        if (a && !list.length) this.claude.clearNeed(a)
        this.log(`a permission request waited too long and was denied`)
      }
    }
  }

  denyAll(run, agentId, message) {
    for (const ask of run.asks.get(agentId) ?? []) ask.reply({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'deny', message } } })
    run.asks.delete(agentId)
  }

  /** Let a paused agent's held tool calls go (or, `deny`, turn them away). */
  release(run, agentId, deny) {
    const mine = run.held.filter((h) => h.agentId === agentId)
    run.held = run.held.filter((h) => h.agentId !== agentId)
    for (const h of mine) {
      if (deny) h.reply({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: STOPPED } })
      else {
        this.claude.handle(h.p)
        h.reply()
      }
    }
  }

  // ---- processes ----

  writeFiles(run) {
    const dir = path.join(this.dir, 'runs', run.id)
    fs.mkdirSync(dir, { recursive: true })
    const base = `http://127.0.0.1:${this.port()}/hook?run=${run.id}`
    const hold = new Set(['PreToolUse', 'PermissionRequest'])
    const settings = {
      permissions: { allow: ['mcp__bloobies__status'] },
      hooks: Object.fromEntries(
        HOOK_EVENTS.map((e) => [e, [{ hooks: [{ type: 'http', url: base, timeout: hold.has(e) ? HOLD_S : 10, headers: { 'X-Bloobies': 'hook', 'X-Bloobies-Run': run.secret } }] }]]),
      ),
    }
    const files = { dir, settings: path.join(dir, 'settings.json'), mcp: path.join(dir, 'mcp.json') }
    fs.writeFileSync(files.settings, JSON.stringify(settings, null, 2) + '\n', { mode: 0o600 })
    fs.writeFileSync(files.mcp, JSON.stringify(mcpConfig(), null, 2) + '\n', { mode: 0o600 })
    return files
  }

  args(run, task, resume) {
    if (run.program === 'claude')
      return {
        args: [
          '-p',
          '--output-format', 'stream-json',
          '--verbose',
          '--permission-mode', run.mode,
          '--settings', run.files.settings,
          '--mcp-config', run.files.mcp,
          '--append-system-prompt', run.team ? TEAM_PROMPT : SOLO_PROMPT,
          ...(resume ? ['--resume', run.sid] : ['--session-id', run.sid]),
        ],
        input: task,
      }
    if (run.program === 'codex') return { args: ['exec', '--json', '--cd', run.folder, '--sandbox', run.mode, '--skip-git-repo-check', '--', task], input: '' }
    return { args: ['-p', '--output-format', 'stream-json', ...(run.mode === 'force' ? ['--force'] : []), '--', task], input: '' }
  }

  start(run, task, resume) {
    run.result = null
    run.error = null
    run.stderr = ''
    run.userStopped = false
    run.stopped.clear()
    run.paused.clear()
    if (run.program === 'claude') {
      // (the task shows at once; the session's own UserPromptSubmit then only confirms it)
      this.claude.handle({ session_id: run.sid, cwd: run.folder, hook_event_name: 'UserPromptSubmit', prompt: task })
    } else run.agent.start(task)

    const cmd = command(this.programs[run.program])
    const { args, input } = this.args(run, task, resume)
    let child
    try {
      child = spawn(cmd.file, [...cmd.args, ...args], {
        cwd: run.folder,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        detached: process.platform !== 'win32',
        env: { ...process.env, BLOOBIES_RUN: run.id },
      })
    } catch (err) {
      return this.ended(run, null, `Couldn't start ${TITLES[run.program]}: ${err.message}`)
    }
    run.child = child
    let over = false
    const end = (code, err) => {
      if (over) return
      over = true
      this.ended(run, code, err)
    }
    child.on('error', (err) => end(null, `Couldn't start ${TITLES[run.program]}: ${err.message}`))
    child.on('close', (code) => end(code))
    child.stdin.on('error', () => {})
    child.stdin.end(input)
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (d) => (run.stderr = (run.stderr + d).slice(-4000)))
    lines(child.stdout, (m) => this.line(run, m))
  }

  line(run, m) {
    if (run.program === 'claude') {
      // The lead's words (a helper's own messages carry parent_tool_use_id: the lead relays what matters)
      if (m.type === 'assistant' && !m.parent_tool_use_id) {
        const parts = Array.isArray(m.message?.content) ? m.message.content : []
        this.leadSaid(run, parts.filter((p) => p?.type === 'text' && typeof p.text === 'string').map((p) => p.text).join('\n\n'), false)
      } else if (m.type === 'result') {
        const text = typeof m.result === 'string' ? m.result : Array.isArray(m.errors) ? m.errors.join(' ') : ''
        const ok = !m.is_error && m.subtype === 'success'
        run.result = ok ? { ok: true } : { ok: false, text, subtype: m.subtype }
        if (ok) this.leadSaid(run, text, true)
        else run.lastSaid = null
      }
      return
    }
    const out = (run.program === 'codex' ? codexLine : cursorLine)(m, run.agent)
    if (out?.said) this.leadSaid(run, out.said, !!out.final)
    if (out?.session) run.sid2 = out.session
    if (out?.result) run.result = out.result.ok ? { ok: true } : { ok: false, text: out.result.reason }
  }

  ended(run, code, startError) {
    run.child = null
    if (!this.runs.has(run.id)) return
    const failed = startError ?? (run.result && !run.result.ok ? run.result.text || 'error' : !run.result && code !== 0 && !run.userStopped ? lastLine(run.stderr) || `exited with code ${code}` : null)
    if (run.program === 'claude') {
      const lead = this.claude.agent(run.leadId)
      if (!run.userStopped) {
        if (failed) {
          const [reason, kind] = claudeReason(failed, run.result?.subtype)
          run.error = /not signed in/i.test(reason) ? 'Claude Code is not signed in on this machine. Run `claude auth login` once in a terminal, then try again.' : clip(failed, 300)
          this.claude.failTask(lead, reason, kind)
        } else if (lead?.task) this.claude.stop(lead, {}) // (finished: the process exiting is the run's end)
      }
      for (const id of [...run.asks.keys()]) this.denyAll(run, id, STOPPED)
      run.held = []
      this.claude.endSubs(run.sid, failed ? 'Run ended' : 'Done')
    } else if (!run.userStopped) {
      if (failed) {
        run.error = clip(failed, 300)
        run.agent.fail(clip(failed, 40))
      } else run.agent.done()
    }
    this.log(`run ${run.id}: ${run.userStopped ? 'stopped' : failed ? `failed (${clip(failed, 80)})` : 'finished'}`)
    run.userStopped = false
    if (run.queue.length && !failed) {
      const next = run.queue.shift()
      this.youSaid(run, next.msg, 'sent')
      this.start(run, next.task, run.program === 'claude')
    }
    this.changed()
  }

  /** Send a run's lead home and forget the run. */
  forget(run) {
    if (run.child) {
      run.userStopped = true
      killTree(run.child)
    }
    this.runs.delete(run.id)
    if (run.program === 'claude') this.claude.release(run.sid)
    else run.agent.retire()
    if (run.files) fs.rmSync(run.files.dir, { recursive: true, force: true })
    this.changed()
  }

  /** The bridge is closing: every run stops, and its files go. */
  closeAll() {
    for (const run of [...this.runs.values()]) {
      if (run.child) {
        run.userStopped = true
        killTree(run.child)
      }
      if (run.files) fs.rmSync(run.files.dir, { recursive: true, force: true })
    }
    this.runs.clear()
  }
}

const lastLine = (s) =>
  String(s ?? '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .pop() ?? ''
