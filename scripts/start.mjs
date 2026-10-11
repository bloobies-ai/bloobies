#!/usr/bin/env node
// SessionStart (the bloobies plugin): make sure the bridge is running on this machine, and start it in the
// background if not. It has to be quick and quiet: Claude Code waits for it, and anything printed here would be
// added to the session's context. The bridge stops by itself after 30 idle minutes; the next session starts it again.
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const PORT = 5318
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const data = process.env.CLAUDE_PLUGIN_DATA || path.join(os.homedir(), '.bloobies')

async function running() {
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/health`, { signal: AbortSignal.timeout(500) })
    return r.ok
  } catch {
    return false
  }
}

try {
  if (!(await running())) {
    fs.mkdirSync(data, { recursive: true })
    const log = fs.openSync(path.join(data, 'bridge.log'), 'a')
    const child = spawn(
      process.execPath,
      [path.join(root, 'bridge', 'cli.mjs'), 'start', '--port', String(PORT), '--idle-exit', '30', '--open-once', path.join(data, 'opened'), '--relay', 'https://bloobies.ai', '--relay-dir', data],
      { detached: true, stdio: ['ignore', log, log], windowsHide: true, cwd: os.homedir() },
    )
    child.unref()
  }
} catch {
  // (never get in the way of the session)
}
