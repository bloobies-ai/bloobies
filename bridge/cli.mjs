#!/usr/bin/env node
// npx bloobies [start]                          run the bridge and print the page link + how to connect Claude Code
// npx bloobies hooks                            print the Claude Code settings block (hooks + permission)
// npx bloobies install [--user | --project D]   add the hooks + MCP server + usage status line for every session
//                                               (--remove undoes it; --no-statusline leaves your status line alone)
// npx bloobies mcp                              the MCP status server (Claude Code starts this itself)
//
// Options: --port N (default 5318), --dev N (also print a link for the Vite dev server on port N), --open,
// --verbose (log each event's type, never its contents), --folder D (offer D in the launch form; repeatable),
// --claude P / --codex P / --cursor P (start that program file instead of the one found on this machine),
// --origin URL (also let the https page at URL open the stream, e.g. the reach probe; repeatable, or
// BLOOBIES_ORIGIN=a,b). https://bloobies.ai is always allowed unless --no-hosted. --idle-exit MIN (stop after MIN
// minutes with no agent and no page: the Claude Code plugin starts the bridge this way, and starts it again).
import fs from 'node:fs'
import path from 'node:path'
import { exec } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { startBridge } from './server.mjs'
import { runMcp } from './mcp.mjs'
import { claudeSettings, writeRunFiles } from './connect.mjs'
import { findPrograms } from './find.mjs'

const args = process.argv.slice(2)
const cmd = args[0] && !args[0].startsWith('--') ? args.shift() : 'start'
const flag = (name) => args.includes(`--${name}`)
const opt = (name, d) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 && args[i + 1] ? args[i + 1] : d
}
const port = Number(opt('port', process.env.BLOOBIES_PORT ?? 5318))
const many = (name) => args.flatMap((a, i) => (a === `--${name}` && args[i + 1] ? [args[i + 1]] : []))

const here = path.dirname(fileURLToPath(import.meta.url))
const openUrl = (u) => exec(process.platform === 'win32' ? `start "" "${u}"` : `${process.platform === 'darwin' ? 'open' : 'xdg-open'} "${u}"`)
const dist = [path.resolve(here, 'app'), path.resolve(here, '../../dist')].find((d) => fs.existsSync(path.join(d, 'index.html')))

if (cmd === 'mcp') {
  runMcp()
} else if (cmd === 'hooks') {
  process.stdout.write(JSON.stringify(claudeSettings(port), null, 2) + '\n')
} else if (cmd === 'install') {
  // (not in the Claude Code plugin, which sets its own hooks: there is no setup.mjs there)
  const { install } = await import('./setup.mjs').catch(() => ({}))
  if (!install) {
    console.error('The bloobies plugin sets up Claude Code by itself: nothing to install.')
    process.exit(1)
  }
  const scope = flag('user') ? 'user' : path.resolve(opt('project', process.cwd()))
  const { changed, mcpHint, statusNote } = install({ scope, port, remove: flag('remove'), statusLine: !flag('no-statusline') })
  console.log(`${flag('remove') ? 'Removed bloobies from' : 'Added bloobies to'}:\n${changed.map((f) => `  ${f}`).join('\n')}`)
  if (statusNote) console.log(`\n${statusNote}`)
  if (mcpHint) console.log(`\nFor the MCP status tool, run:\n  ${mcpHint}`)
  console.log('\n(A .bak copy of each file was kept.)')
} else if (cmd === 'start') {
  const dev = opt('dev', null)
  const programs = findPrograms({ claude: opt('claude'), codex: opt('codex'), cursor: opt('cursor') })
  const folders = [process.cwd(), ...many('folder').map((f) => path.resolve(f))]
  const HOSTED = 'https://bloobies.ai'
  const origins = [...(flag('no-hosted') ? [] : [HOSTED]), ...many('origin'), ...(process.env.BLOOBIES_ORIGIN ?? '').split(',')].map((o) => o.trim()).filter(Boolean).map((o) => {
    let u
    try {
      u = new URL(o)
    } catch {}
    // (only a bare https origin: a page anywhere else could be anyone's)
    if (!u || u.protocol !== 'https:' || u.origin !== o.replace(/\/$/, '')) {
      console.error(`--origin takes an https origin like https://bloobies.ai, not ${o}`)
      process.exit(1)
    }
    return u.origin
  })
  const bridge = await startBridge({ port, dist, programs, folders, verbose: flag('verbose'), origins, log: (l) => console.log(`  · ${l}`) }).catch((err) => {
    console.error(err.code === 'EADDRINUSE' ? `Port ${port} is taken (another bridge?). Try --port ${port + 1}.` : err.message)
    process.exit(1)
  })
  const files = writeRunFiles(bridge.port)
  const q = `view=world&live=1&token=${bridge.token}`
  const page = `http://127.0.0.1:${bridge.port}/?${q}`
  console.log(`\n  bloobies bridge · listening on 127.0.0.1:${bridge.port} (this machine only)\n`)
  // (bloobies.ai finds the bridge by itself on the default port; any other port rides in the #fragment)
  const hosted = (o) => `${o}/?view=world&live=1${bridge.port === 5318 ? '' : `#bridge=${bridge.port}`}`
  if (origins.includes(HOSTED)) console.log(`  Open your world: ${hosted(HOSTED)}`)
  if (dist) console.log(`  This machine:    ${page}`)
  if (dev) console.log(`  Dev server:      http://localhost:${dev}/?${q}&bridge=${bridge.port}`)
  for (const o of origins) if (o !== HOSTED) console.log(`  Allowed page:    ${hosted(o)}`)
  console.log(`\n  Connect a Claude Code session (nothing in your setup changes):`)
  console.log(`    claude --settings "${files.settings}" --mcp-config "${files.mcp}"`)
  console.log(`\n  Or connect every session:  npx bloobies install --user   (undo: --remove)`)
  const found = Object.entries(programs).map(([k, p]) => (p ? `${p.title} ✓` : `${k} (not found)`))
  console.log(`\n  Start runs from the world (+ new run, or H):  ${found.join(' · ')}\n`)
  if (flag('open') && dist) openUrl(page)
  const quit = () => bridge.close().then(() => process.exit(0))
  // --open-once FILE: the first time ever (no FILE yet), open your world, unless a page found the bridge by itself
  const once = opt('open-once', null)
  if (once && origins.includes(HOSTED) && !fs.existsSync(once))
    setTimeout(() => {
      if (fs.existsSync(once)) return
      fs.writeFileSync(once, new Date().toISOString())
      if (!bridge.pages()) openUrl(hosted(HOSTED))
    }, 8000).unref()
  const idle = Number(opt('idle-exit', 0)) * 60_000
  if (idle > 0) {
    // stop once nothing has used the bridge for a while (no live agent, no page): the plugin starts it again
    let quiet = Date.now()
    setInterval(() => {
      const h = { agents: bridge.tracker.agents.size, pages: bridge.pages() }
      if (h.agents || h.pages) quiet = Date.now()
      else if (Date.now() - quiet > idle) quit()
    }, 30_000).unref()
  }
  process.on('SIGINT', quit)
  process.on('SIGTERM', quit)
} else {
  console.error(`Unknown command: ${cmd}. Try: start, hooks, install, mcp.`)
  process.exit(1)
}
