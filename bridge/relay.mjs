// The hosted relay, the machine's half (phase 8 part B, docs/phases/8-relay.md). The bridge sends the world's events
// to your private Supabase Realtime channel, and your bloobies.ai tab listens there, so the page never has to reach
// this machine (no browser local-network prompt, and it works on phones).
//
// What leaves this machine is decided here, in `Sanitizer`, before anything is sent: the same rules as share links.
// Only who works, in what state, at which station, and plan usage as percentages. Never prompts, messages, file names,
// paths, commands or error text. Task labels are the station's verb ("Building") unless you turn labels on.
//
// It sends only while one of your bloobies.ai tabs is open (Realtime presence says so), at most one batch every two
// seconds, and a fresh snapshot whenever a tab arrives.
import fs from 'node:fs'
import path from 'node:path'
import { randomBytes } from 'node:crypto'

const STATIONS = new Set(['build', 'research', 'test', 'review', 'ship', 'design'])
const VERB = { build: 'Building', research: 'Researching', test: 'Testing', review: 'Reviewing', ship: 'Shipping', design: 'Designing' }
const text = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '')
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
const pct = (v) => Math.min(100, Math.max(0, num(v)))

/**
 * Turns the bridge's events into what may leave the machine. Stateful: each agent and task gets a random id for the
 * life of this bridge (never a session id), and each task remembers its station for its verb.
 */
export class Sanitizer {
  constructor({ labels = false } = {}) {
    this.labels = labels
    this.ids = new Map()
    this.stationOf = new Map()
  }

  id(kind, raw) {
    const k = kind + String(raw)
    if (!this.ids.has(k)) this.ids.set(k, kind + randomBytes(5).toString('hex'))
    return this.ids.get(k)
  }

  /** One event, cleaned; null for what never leaves (messages, files). */
  clean(e) {
    if (!e || typeof e !== 'object' || typeof e.type !== 'string') return null
    const t = num(e.t)
    const st = (v, fallback = 'build') => (STATIONS.has(v) ? v : fallback)
    const label = (raw, s) => (this.labels && text(raw, 22).trim()) || VERB[s]
    const a = (v) => this.id('a', v)
    const k = (v) => this.id('t', v)
    switch (e.type) {
      case 'agent.spawned':
        return { type: e.type, t, agentId: a(e.agentId), name: text(e.name, 16) || 'Bloobie', lead: !!e.lead, ...(/^[a-z0-9-]{1,24}$/.test(e.source) ? { source: e.source } : {}), ...(e.crew ? { crew: a(e.crew) } : {}), ...(e.project && e.role && !e.lead ? { project: text(e.project, 80) } : {}), ...(e.role && !e.lead ? { role: text(e.role, 24) } : {}) } // (a lead's role names your project folder: never sent)
      case 'agent.retired':
      case 'agent.idle':
        return { type: e.type, t, agentId: a(e.agentId) }
      case 'agent.usage':
        return { type: e.type, t, agentId: a(e.agentId), context: Math.min(1, Math.max(0, num(e.context))) }
      case 'agent.needs_input':
        return { type: e.type, t, agentId: a(e.agentId), kind: e.kind === 'question' ? 'question' : 'permission', text: e.kind === 'question' ? 'Has a question' : 'Wants approval' }
      case 'task.assigned': {
        const s = st(e.station)
        this.stationOf.set(e.taskId, s)
        return { type: e.type, t, taskId: k(e.taskId), agentId: a(e.agentId), station: s, label: label(e.label, s), ...(e.total ? { total: num(e.total) } : {}) }
      }
      case 'task.handoff': {
        const s = st(e.station)
        this.stationOf.set(e.taskId, s)
        return { type: e.type, t, taskId: k(e.taskId), from: a(e.from), to: a(e.to), station: s, label: label(e.label, s), ...(e.total ? { total: num(e.total) } : {}) }
      }
      case 'task.status': {
        const s = st(e.station, this.stationOf.get(e.taskId) ?? 'build')
        if (e.station) this.stationOf.set(e.taskId, s)
        return { type: e.type, t, taskId: k(e.taskId), label: label(e.label, s), ...(e.station ? { station: s } : {}), ...(e.eta ? { eta: num(e.eta) } : {}) }
      }
      case 'task.progress':
        return { type: e.type, t, taskId: k(e.taskId), done: num(e.done), total: num(e.total) }
      case 'task.done':
        return { type: e.type, t, taskId: k(e.taskId) }
      case 'task.paused':
        return { type: e.type, t, taskId: k(e.taskId), paused: !!e.paused }
      case 'task.failed':
        return { type: e.type, t, taskId: k(e.taskId), reason: e.kind === 'blocked' ? 'Stopped' : 'Hit a snag', kind: e.kind === 'blocked' ? 'blocked' : 'error' }
      case 'limits.update': {
        const service = e.service === 'codex' ? 'codex' : 'claude'
        const out = { type: e.type, t, service }
        if (e.h5 !== undefined) out.h5 = pct(e.h5)
        if (e.h5Reset !== undefined) out.h5Reset = num(e.h5Reset)
        if (e.wk !== undefined) out.wk = pct(e.wk)
        if (e.wkReset !== undefined) out.wkReset = num(e.wkReset)
        return out
      }
      // never sent: agent.said (messages), task.file (paths), and anything unknown
      default:
        return null
    }
  }
}

/** Which earlier event in the same batch a newer one replaces (only states, never arrivals or endings). */
const slot = (e) =>
  e.type === 'task.status' || e.type === 'task.progress' ? `${e.type}:${e.taskId}` : e.type === 'agent.usage' ? `u:${e.agentId}` : e.type === 'limits.update' ? `l:${e.service}` : null

/** Coalesce a batch: a later status, progress, usage or limits update replaces the earlier one in place. */
export function coalesce(events) {
  const out = []
  const at = new Map()
  for (const e of events) {
    const s = slot(e)
    if (s && at.has(s)) out[at.get(s)] = e
    else {
      if (s) at.set(s, out.length)
      out.push(e)
    }
  }
  return out
}

const CHUNK = 400 // events per broadcast: well under the free plan's 256 KB payload
const RELINK_MS = 10 * 60_000 // how long before this computer asks to link again

/**
 * Start the uplink. Quiet and best-effort: if anything fails it retries later, and the local bridge works regardless.
 * @param {object} o
 * @param {string} o.site            https://bloobies.ai (or the dev server)
 * @param {string} o.dir             where the machine key is kept (the plugin's data folder)
 * @param {(fn: (e: any) => void) => void} o.listen   every event the bridge publishes
 * @param {() => any[]} o.snapshot   the bridge's current state as events
 * @param {(url: string) => void} [o.open]   open a page in the browser (to link this machine)
 * @param {(line: string) => void} [o.log]
 */
export function startRelay({ site, dir, listen, snapshot, open = () => {}, log = () => {}, flushMs = 2000, WebSocketImpl = globalThis.WebSocket, labels = false }) {
  if (!WebSocketImpl) {
    log('relay: this Node has no WebSocket (needs Node 22 or newer); the world stays on the local bridge')
    return { close() {} }
  }
  const keyFile = path.join(dir, 'relay.json')
  const openedFile = path.join(dir, 'link-opened')
  const clean = new Sanitizer({ labels })
  let stopped = false
  let ws = null
  let topic = ''
  let ref = 0
  let joined = false
  let wait = 2000
  let timers = []
  let pending = []
  const presence = new Map() // key -> metas
  let watching = false
  const later = (ms, fn) => {
    const t = setTimeout(fn, ms)
    t.unref?.()
    timers.push(t)
    return t
  }

  const readKey = () => {
    try {
      return JSON.parse(fs.readFileSync(keyFile, 'utf8')).key || ''
    } catch {
      return ''
    }
  }
  const saveKey = (key) => {
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(keyFile, JSON.stringify({ key, site, linked: new Date().toISOString() }) + '\n', { mode: 0o600 })
  }

  // ---------------------------------------------------------------------------------------- linking, once
  const link = async () => {
    // open the browser at most once an hour, however often sessions start (a tab that was closed, or a button never
    // clicked, must not leave this computer unlinked all day)
    let recent = false
    try {
      recent = Date.now() - fs.statSync(openedFile).mtimeMs < 3600_000
    } catch {}
    if (recent) {
      log('relay: not linked yet (bloobies.ai asked in the last hour; it asks again after that)')
      return false
    }
    const r = await fetch(`${site}/api/link`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ start: true, os: process.platform }) })
    if (r.status === 503) throw Object.assign(new Error('the relay is not set up on the site'), { off: true })
    if (!r.ok) throw new Error(`link: ${r.status}`)
    const { code, poll, expires } = await r.json()
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(openedFile, new Date().toISOString())
    open(`${site}/?view=world&live=1#link=${code}`)
    log(`relay: asked to link this computer (code ${code})`)
    while (!stopped && Date.now() < expires) {
      await new Promise((done) => later(3000, done))
      const p = await fetch(`${site}/api/link?code=${encodeURIComponent(code)}&poll=${encodeURIComponent(poll)}`).catch(() => null)
      if (!p) continue
      if (p.status === 404) return false
      const out = await p.json().catch(() => ({}))
      if (out.key) {
        saveKey(out.key)
        log('relay: this computer is linked')
        return true
      }
    }
    return false
  }

  // ------------------------------------------------------------------------------------------ the channel
  const send = (event, payload) => {
    if (!ws || ws.readyState !== 1) return false
    ws.send(JSON.stringify({ topic: `realtime:${topic}`, event, payload, ref: String(++ref) }))
    return true
  }
  const broadcast = (kind, events) => send('broadcast', { type: 'broadcast', event: 'ev', payload: { kind, events } })

  const sendSnapshot = () => {
    const all = coalesce(snapshot().map((e) => clean.clean(e)).filter(Boolean))
    pending = []
    if (!all.length) return broadcast('snap', [])
    for (let i = 0; i < all.length; i += CHUNK) broadcast(i === 0 ? 'snap' : 'events', all.slice(i, i + CHUNK))
  }

  const tabs = () => [...presence.values()].some((metas) => metas.some((m) => m.kind === 'tab'))
  const presenceChanged = (joinedTab) => {
    const now = tabs()
    const was = watching
    watching = now
    if (now && (!was || joinedTab)) sendSnapshot()
    if (!now) pending = []
  }

  const token = async () => {
    const key = readKey()
    if (!key) return null
    const r = await fetch(`${site}/api/relay-token`, { method: 'POST', headers: { authorization: `Bearer ${key}` } })
    if (r.status === 401) {
      fs.rmSync(keyFile, { force: true }) // (unlinked from the account: link again)
      return null
    }
    if (r.status === 503) throw Object.assign(new Error('the relay is not set up on the site'), { off: true })
    if (!r.ok) throw new Error(`token: ${r.status}`)
    return r.json()
  }

  const connect = async () => {
    if (stopped) return
    let t
    try {
      t = await token()
      if (!t && !stopped) {
        if (!(await link())) {
          log('relay: not linked; the world stays on the local bridge (it asks again in ten minutes)')
          later(RELINK_MS, connect)
          return
        }
        t = await token()
      }
      if (!t) {
        later(RELINK_MS, connect)
        return
      }
    } catch (err) {
      if (err?.off) return log(`relay: ${err.message}; the world stays on the local bridge`)
      log(`relay: ${err?.message ?? err}; retrying`)
      later(wait, connect)
      wait = Math.min(wait * 2, 60_000)
      return
    }
    topic = t.topic
    const url = `${t.url.replace(/^http/, 'ws')}/realtime/v1/websocket?apikey=${encodeURIComponent(t.anonKey)}&vsn=1.0.0`
    ws = new WebSocketImpl(url)
    const mine = ws // (this attempt's socket: a timer left from an older one must not touch the new one)
    const me = `machine-${randomBytes(4).toString('hex')}`
    ws.onopen = () => {
      ws.send(
        JSON.stringify({
          topic: `realtime:${topic}`,
          event: 'phx_join',
          payload: { config: { broadcast: { self: false, ack: false }, presence: { key: me, enabled: true }, postgres_changes: [], private: true }, access_token: t.token },
          ref: String(++ref),
          join_ref: String(ref),
        }),
      )
    }
    ws.onmessage = (m) => {
      let msg
      try {
        msg = JSON.parse(String(m.data))
      } catch {
        return
      }
      if (msg.event === 'phx_reply' && !joined && msg.topic === `realtime:${topic}`) {
        if (msg.payload?.status !== 'ok') {
          log(`relay: the channel refused this computer (${msg.payload?.response?.reason ?? 'no reason'})`)
          return ws.close()
        }
        joined = true
        wait = 2000
        send('presence', { type: 'presence', event: 'track', payload: { kind: 'machine' } })
        log('relay: connected')
      } else if (msg.event === 'presence_state') {
        presence.clear()
        for (const [k, v] of Object.entries(msg.payload ?? {})) presence.set(k, v.metas ?? [])
        presenceChanged(false)
      } else if (msg.event === 'presence_diff') {
        let tabJoined = false
        for (const [k, v] of Object.entries(msg.payload?.leaves ?? {})) {
          const left = new Set((v.metas ?? []).map((x) => x.phx_ref))
          const keep = (presence.get(k) ?? []).filter((x) => !left.has(x.phx_ref))
          keep.length ? presence.set(k, keep) : presence.delete(k)
        }
        for (const [k, v] of Object.entries(msg.payload?.joins ?? {})) {
          if ((v.metas ?? []).some((x) => x.kind === 'tab')) tabJoined = true
          presence.set(k, [...(presence.get(k) ?? []), ...(v.metas ?? [])])
        }
        presenceChanged(tabJoined)
      } else if (msg.event === 'broadcast' && msg.payload?.event === 'cfg') {
        // a tab of yours turned task labels on or off
        clean.labels = !!msg.payload?.payload?.labels
        if (watching) sendSnapshot()
      } else if (msg.event === 'phx_error' || (msg.event === 'system' && msg.payload?.status === 'error')) {
        log(`relay: channel error ${JSON.stringify(msg.payload ?? {}).slice(0, 120)}`)
        // a cut-off channel (an expired token, say) never comes back by itself: start over with a fresh one
        ws?.close()
      }
    }
    ws.onclose = () => {
      ws = null
      joined = false
      watching = false
      presence.clear()
      if (stopped) return
      later(wait, connect)
      wait = Math.min(wait * 2, 60_000)
    }
    ws.onerror = () => {}
    // a fresh token before this one runs out, then again before that one does (a one-hour token, so this has to
    // keep going: when it stops the channel is cut off and the page goes quiet)
    const renew = () => {
      later(Math.max(60_000, t.exp - Date.now() - 5 * 60_000), async () => {
        if (stopped || !ws || ws !== mine) return
        try {
          const n = await token()
          if (n && send('access_token', { access_token: n.token })) t.exp = n.exp
        } catch {}
        renew()
      })
    }
    renew()
  }

  // ------------------------------------------------------------------------------ events in, batches out
  listen((e) => {
    const c = clean.clean(e) // (always: ids and stations stay consistent for the next snapshot)
    if (c && watching) pending.push(c)
  })
  const flush = setInterval(() => {
    if (!watching || !pending.length) return
    const batch = coalesce(pending)
    pending = []
    for (let i = 0; i < batch.length; i += CHUNK) broadcast('events', batch.slice(i, i + CHUNK))
  }, flushMs)
  flush.unref?.()
  const beat = setInterval(() => ws?.readyState === 1 && ws.send(JSON.stringify({ topic: 'phoenix', event: 'heartbeat', payload: {}, ref: String(++ref) })), 25_000)
  beat.unref?.()

  connect()
  return {
    close() {
      stopped = true
      clearInterval(flush)
      clearInterval(beat)
      for (const t of timers) clearTimeout(t)
      ws?.close()
    },
    get watching() {
      return watching
    },
  }
}
