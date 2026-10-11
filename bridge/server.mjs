// The bridge: one local HTTP server on 127.0.0.1 that
//   - takes Claude Code's hook posts (POST /hook), protocol events from any other adapter (POST /event) and the
//     generic webhook's simple updates (POST /webhook),
//   - streams the world's events to the page over a WebSocket (GET /ws?token=…), and takes the page's commands
//     back on it (phase 5: start a run, give a task, approve / deny, pause, stop; see runs.mjs),
//   - serves the built app (dist/), so `npx bloobies` is all you need.
//
// Nothing listens beyond loopback and nothing is sent anywhere else. On disk: only ~/.bloobies (the per-run hook
// settings, deleted when the run goes, and the recent folders list).
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { accept } from './ws.mjs'
import { ClaudeAdapter } from './claude.mjs'
import { Tracker } from './tracker.mjs'
import { readUsage } from './usage.mjs'
import { readLimits } from './limits.mjs'
import { home as defaultHome } from './setup.mjs'
import { validate } from './validate.mjs'
import { Runs } from './runs.mjs'
import { findPrograms } from './find.mjs'
import { WebhookAdapter } from './webhook.mjs'
import { PROTOCOL_VERSION } from '../protocol/index.js'

const COMMANDS = new Set(['launch', 'assign', 'answer', 'pause', 'resume', 'stop'])

const LOOPBACK_HOST = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i
const LOOPBACK_ORIGIN = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i
const MAX_BODY = 16 * 1024 * 1024

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.mjs': 'text/javascript; charset=utf-8',
  '.wasm': 'application/wasm',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ico': 'image/x-icon',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
}

const same = (a, b) => {
  const x = Buffer.from(String(a))
  const y = Buffer.from(String(b))
  return x.length === y.length && timingSafeEqual(x, y)
}

/**
 * @param {object} o
 * @param {number} [o.port]   0 picks a free port
 * @param {string} [o.token]  the page's key to the stream (random if not given)
 * @param {string} [o.dist]   the built app to serve
 * @param {(line: string) => void} [o.log]
 * @param {boolean} [o.verbose]  log every event type (never contents)
 * @param {(ms: number, fn: () => void) => void} [o.later]  timers, for tests
 * @param {object} [o.programs]  the agent programs runs may start (find.mjs; tests pass stand-ins)
 * @param {string[]} [o.folders] folders to offer in the launch form
 * @param {string} [o.home]      where run files live (default ~/.bloobies)
 * @param {string[]} [o.origins] https page origins that may also open the stream (e.g. https://bloobies.ai), besides
 *                               loopback pages. Exact matches only. These need no token: a browser always sends
 *                               the page's real Origin, so only that site's pages get in (and the hosted world can
 *                               find the bridge by itself). Loopback pages and scripts still need the token.
 */
export function startBridge({ port = 5318, token = randomBytes(12).toString('base64url'), dist, log = () => {}, verbose = false, now, later, programs = findPrograms(), folders = [process.cwd()], home, origins = [] } = {}) {
  const peers = new Set()
  const tracker = new Tracker()
  let events = 0

  const publish = (e) => {
    const bad = validate(e)
    if (bad) {
      log(`dropped an event: ${bad}`)
      return
    }
    events++
    tracker.apply(e)
    if (verbose) log(`${e.type}${e.agentId ? ' ' + e.agentId : ''}${e.taskId ? ' ' + e.taskId : ''}`)
    const msg = JSON.stringify({ kind: 'events', events: [e] })
    for (const p of peers) p.send(msg)
  }

  const claude = new ClaudeAdapter({ emit: publish, readUsage, namesInUse: () => tracker.names(), ...(now && { now }), ...(later && { later }) })
  const pickName = () => claude.pickName()
  const webhook = new WebhookAdapter({ emit: publish, pickName, ...(now && { now }) })
  let actualPort = port
  const broadcast = (msg) => {
    const text = JSON.stringify(msg)
    for (const p of peers) p.send(text)
  }
  const runs = new Runs({
    claude,
    publish,
    pickName,
    programs,
    folders,
    port: () => actualPort,
    log,
    changed: () => broadcast({ kind: 'runs', runs: runs.list() }),
    ...(now && { now }),
    ...(home && { dir: home }),
  })

  /** A command from the page (it holds the token: the socket was checked when it opened). */
  const command = (peer, raw) => {
    let m
    try {
      m = JSON.parse(raw)
    } catch {
      return
    }
    if (m?.kind !== 'cmd' || !COMMANDS.has(m.cmd)) return
    const answer = (r) => peer.send(JSON.stringify({ kind: 'reply', id: m.id, ok: !!r.ok, text: String(r.text ?? '') }))
    const id = typeof m.agentId === 'string' ? m.agentId : ''
    let r
    try {
      if (m.cmd === 'launch') r = runs.launch(m)
      else if (m.cmd === 'assign') r = runs.assign(id, m.text)
      else if (m.cmd === 'answer') r = runs.answer(id, !!m.approve)
      else r = runs[m.cmd](id)
    } catch (err) {
      log(`command error: ${err?.message ?? err}`)
      r = { ok: false, text: 'The bridge hit an error doing that' }
    }
    // (null: not one of the bridge's runs, i.e. a session started in a terminal)
    answer(r ?? { ok: false, text: m.cmd === 'answer' ? 'Started in a terminal: answer it there' : m.cmd === 'assign' ? 'Started in a terminal: type it there' : 'Started in a terminal: do that there' })
  }

  /** Requests from a web page (an Origin header) or for another host name (DNS rebinding) are turned away. */
  const local = (req) => LOOPBACK_HOST.test(req.headers.host ?? '')

  const body = (req) =>
    new Promise((resolve, reject) => {
      const chunks = []
      let size = 0
      req.on('data', (c) => {
        size += c.length
        if (size > MAX_BODY) {
          reject(new Error('too large'))
          req.destroy()
        } else chunks.push(c)
      })
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
      req.on('error', reject)
    })

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const send = (code, text = '', type = 'text/plain; charset=utf-8') => {
      res.writeHead(code, { 'content-type': type, 'x-content-type-options': 'nosniff', 'cache-control': 'no-store' })
      res.end(text)
    }
    if (!local(req)) return send(403, 'loopback only')

    if (req.method === 'POST' && (url.pathname === '/hook' || url.pathname === '/event' || url.pathname === '/webhook')) {
      // Agents post from the command line, never from a page: a browser always sends an Origin on a cross-site
      // POST, and can't add the custom header without a CORS preflight, which this server never answers.
      if (req.headers.origin || !req.headers['x-bloobies']) return send(403, 'not from a page')
      let data
      try {
        data = JSON.parse(await body(req))
      } catch {
        return send(400)
      }
      const run = url.pathname === '/hook' && url.searchParams.get('run')
      if (run) {
        // A launched run's own hooks: the answer may be a decision, and may come much later (runs.mjs)
        const reply = (out) => {
          if (res.writableEnded || res.destroyed) return
          if (out === 403) return send(403)
          if (out) send(200, JSON.stringify(out), 'application/json')
          else send(200)
        }
        res.on('close', () => runs.gone(reply))
        try {
          runs.hook(run, req.headers['x-bloobies-run'], data, reply)
        } catch (err) {
          log(`run hook error: ${err?.message ?? err}`)
          reply()
        }
        return
      }
      if (url.pathname === '/webhook') {
        const bad = (Array.isArray(data) ? data : [data]).map((m) => webhook.handle(m)).find(Boolean)
        return send(bad ? 400 : 200, bad ?? '')
      }
      // (an empty 200 tells Claude Code "carry on as normal": sessions started in a terminal are only watched)
      send(200)
      try {
        if (url.pathname === '/hook') {
          // (a launched run's hooks also arrive here through the person's installed hooks: it already has its own)
          if (!runs.ownsSession(data?.session_id)) claude.handle(data)
        } else for (const e of Array.isArray(data) ? data : [data]) publish({ t: Date.now(), ...e })
      } catch (err) {
        log(`adapter error: ${err?.message ?? err}`)
      }
      return
    }

    if (req.method === 'GET' && url.pathname === '/health') {
      return send(200, JSON.stringify({ ok: true, protocol: PROTOCOL_VERSION, agents: tracker.agents.size, events, pages: peers.size }), 'application/json')
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') return send(405)
    if (!dist) return send(404, 'No app build to serve: run `npm run build` in the bloobies folder, or use the dev server.')
    const rel = decodeURIComponent(url.pathname).replace(/^\/+/, '') || 'index.html'
    const file = path.resolve(dist, rel)
    if (!file.startsWith(path.resolve(dist) + path.sep)) return send(403)
    const target = fs.existsSync(file) && fs.statSync(file).isFile() ? file : path.join(dist, 'index.html')
    if (!fs.existsSync(target)) return send(404)
    res.writeHead(200, {
      'content-type': TYPES[path.extname(target).toLowerCase()] ?? 'application/octet-stream',
      'x-content-type-options': 'nosniff',
      'cache-control': target.endsWith('index.html') ? 'no-store' : 'public, max-age=3600',
    })
    if (req.method === 'HEAD') return res.end()
    fs.createReadStream(target).pipe(res)
  })

  server.on('upgrade', (req, socket) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const origin = req.headers.origin
    const site = !!origin && origins.includes(origin)
    const keyed = (!origin || LOOPBACK_ORIGIN.test(origin)) && same(url.searchParams.get('token') ?? '', token)
    if (!local(req) || url.pathname !== '/ws' || !(site || keyed)) {
      socket.end('HTTP/1.1 403 Forbidden\r\n\r\n')
      return
    }
    const peer = accept(req, socket)
    if (!peer) return socket.destroy()
    peers.add(peer)
    peer.onclose = () => peers.delete(peer)
    peer.onmessage = (text) => command(peer, text)
    peer.send(JSON.stringify({ kind: 'hello', protocol: PROTOCOL_VERSION, now: Date.now(), can: runs.info() }))
    peer.send(JSON.stringify({ kind: 'runs', runs: runs.list() }))
    peer.send(JSON.stringify({ kind: 'events', events: tracker.snapshot() }))
  })

  // The usage billboard: your plan limits, read from files already on this machine (limits.mjs) every 20 s, and sent
  // on whenever a number changes (a window resetting counts). Both services are always sent once, so a page can tell
  // "no data" from "not read yet".
  const sentLimits = new Map()
  const pollLimits = () => {
    const read = readLimits(home ?? defaultHome())
    for (const service of ['claude', 'codex']) {
      const r = read[service]
      const e = { type: 'limits.update', t: Date.now(), service }
      if (r?.h5) Object.assign(e, { h5: r.h5.pct }, r.h5.resetsAt !== null && { h5Reset: r.h5.resetsAt })
      if (r?.wk) Object.assign(e, { wk: r.wk.pct }, r.wk.resetsAt !== null && { wkReset: r.wk.resetsAt })
      const key = JSON.stringify({ ...e, t: 0 })
      if (sentLimits.get(service) === key) continue
      sentLimits.set(service, key)
      publish(e)
    }
  }
  pollLimits()
  const limitsTimer = setInterval(pollLimits, 20_000)
  limitsTimer.unref()

  const ping = setInterval(() => {
    for (const p of peers) p.send('{"kind":"ping"}')
    claude.sweep()
  }, 25_000)
  ping.unref()

  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => {
      const actual = (actualPort = server.address().port)
      resolve({
        port: actual,
        token,
        claude,
        tracker,
        runs,
        publish,
        pages: () => peers.size,
        close: () =>
          new Promise((done) => {
            clearInterval(ping)
            clearInterval(limitsTimer)
            runs.closeAll()
            for (const p of peers) p.close()
            server.close(() => done())
            server.closeAllConnections?.()
          }),
      })
    })
  })
}
