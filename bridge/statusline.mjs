#!/usr/bin/env node
// Claude Code's status line command, for the usage billboard. Claude Code pipes the session's status as JSON to this on
// every update; when it carries `rate_limits` (Pro/Max plans, after the first reply), the two windows are kept in
// ~/.bloobies/claude-limits.json for the bridge (limits.mjs). Only those numbers are kept, nothing else from the status.
//
// It prints a short status line of its own ("5h 62% · week 38%"). If a status line command was set up before bloobies,
// it is passed as the arguments and runs instead (same input), so its output is what shows:
//   node statusline.mjs [previous command…]
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execSync } from 'node:child_process'

const home = process.env.BLOOBIES_HOME || path.join(os.homedir(), '.bloobies')

let input = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (d) => (input += d))
process.stdin.on('end', () => {
  let status = null
  try {
    status = JSON.parse(input)
  } catch {}
  const rl = status?.rate_limits
  const keep = (w) => (w && typeof w.used_percentage === 'number' ? { used_percentage: w.used_percentage, resets_at: w.resets_at ?? null } : null)
  const row = rl ? { five_hour: keep(rl.five_hour), seven_day: keep(rl.seven_day), at: Date.now() } : null
  if (row && (row.five_hour || row.seven_day)) {
    try {
      fs.mkdirSync(home, { recursive: true })
      const file = path.join(home, 'claude-limits.json')
      const tmp = `${file}.${process.pid}.tmp`
      fs.writeFileSync(tmp, JSON.stringify(row) + '\n', { mode: 0o600 })
      fs.renameSync(tmp, file)
    } catch {}
  }

  const previous = process.argv.slice(2).join(' ').trim()
  if (previous) {
    try {
      process.stdout.write(execSync(previous, { input, timeout: 2500, encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] }))
    } catch {}
    return
  }
  const pct = (w) => (w ? `${Math.round(w.used_percentage)}%` : '–')
  const model = status?.model?.display_name
  const parts = [model, row && `5h ${pct(row.five_hour)} · week ${pct(row.seven_day)}`].filter(Boolean)
  process.stdout.write(parts.join(' · '))
})
