#!/usr/bin/env node
// /bloobies:usage (the plugin's opt-in command): put your Claude plan's usage on the world's billboard. Claude Code
// hands its status line command the plan's `rate_limits`, and nothing else gets them, so this sets the status line in
// your user settings to statusline.mjs, which keeps those two numbers in ~/.bloobies/claude-limits.json for the bridge.
//
// - A status line you already have is kept: it runs through ours, with the same input, and its output is what shows.
// - The script is copied to ~/.bloobies/statusline.mjs, so the setting survives plugin updates.
// - settings.json is backed up to settings.json.bak first, and nothing else in it changes.
// - `off` gives your status line back exactly as it was (or takes ours out), and deletes the saved numbers.
//
//   node usage-reader.mjs [off]
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const home = process.env.BLOOBIES_HOME || path.join(os.homedir(), '.bloobies')
const settingsFile = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'settings.json')
const script = path.join(home, 'statusline.mjs')
const off = process.argv.slice(2).some((a) => /^(off|--?off|remove|--remove)$/i.test(a))

/** If `command` is bloobies' status line, the command it chains to ('' for none); otherwise null. */
export function chained(command) {
  const m = /^node "([^"]+)"(?: ([\s\S]*))?$/.exec(command ?? '')
  if (!m || path.basename(m[1]) !== 'statusline.mjs' || !/bloobies/i.test(m[1])) return null
  return m[2] ?? ''
}

function main() {
  let settings = {}
  if (fs.existsSync(settingsFile)) {
    try {
      settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8') || '{}')
    } catch {
      return `${settingsFile} isn't valid JSON, so nothing was changed. Fix it, then run /bloobies:usage again.`
    }
  }
  const sl = settings.statusLine
  const prev = sl?.type === 'command' && typeof sl.command === 'string' ? chained(sl.command) : null
  const save = (next) => {
    fs.mkdirSync(path.dirname(settingsFile), { recursive: true })
    if (fs.existsSync(settingsFile)) fs.copyFileSync(settingsFile, settingsFile + '.bak')
    fs.writeFileSync(settingsFile, JSON.stringify(next, null, 2) + '\n')
  }

  if (off) {
    fs.rmSync(path.join(home, 'claude-limits.json'), { force: true })
    if (prev === null) return "The usage reader isn't on, so nothing changed."
    const next = { ...settings }
    if (prev) next.statusLine = { ...sl, command: prev }
    else delete next.statusLine
    save(next)
    return prev ? 'Usage reader off: your status line is back as it was.' : 'Usage reader off: the status line is removed.'
  }

  fs.mkdirSync(home, { recursive: true })
  fs.copyFileSync(path.join(here, 'statusline.mjs'), script)
  const yours = prev ?? (sl?.type === 'command' && typeof sl.command === 'string' ? sl.command.trim() : '')
  const command = `node "${script}"${yours ? ` ${yours}` : ''}`
  if (sl?.command === command) return 'The usage reader is already on.'
  save({ ...settings, statusLine: { ...(sl?.type === 'command' ? sl : {}), type: 'command', command } })
  return (
    (yours ? 'Usage reader on: your status line is kept and runs through it.' : 'Usage reader on: a status line shows your model and plan usage.') +
    " Your Claude plan's usage reaches the bloobies board after Claude's next reply (Pro and Max plans). Undo: /bloobies:usage off"
  )
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    console.log(main())
  } catch (e) {
    console.log(`Couldn't change the status line: ${e.message}`)
    process.exitCode = 1
  }
}
