// Connecting Claude Code: the hooks (http, straight to the bridge) and the MCP status server.
//
// Two ways in:
//   - per run: `bloobies` writes these to ~/.bloobies/ and prints a `claude --settings … --mcp-config …` line, so
//     nothing in your Claude Code setup changes;
//   - always: `bloobies install` merges the hooks into a Claude Code settings file (a .bak copy is kept) and adds
//     the MCP server to the project's .mcp.json (for the user scope it prints the `claude mcp add` line instead).
//     It also sets the status line (statusline.mjs) that feeds the usage billboard; a status line you already have is
//     chained, not replaced, and `--remove` puts it back exactly.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), 'cli.mjs')
export const STATUSLINE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'statusline.mjs')

/** The Claude Code hook events the adapter listens to. (SessionStart only takes command hooks; the lead shows up
 *  on its first prompt instead.) */
export const HOOK_EVENTS = [
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'PermissionRequest',
  'Notification',
  'SubagentStart',
  'SubagentStop',
  'Stop',
  'StopFailure',
  'PostCompact',
  'TaskCreated',
  'TaskCompleted',
  'SessionEnd',
]

const isOurs = (h) => h?.type === 'http' && h.headers?.['X-Bloobies'] === 'hook'

/** The settings block: an http hook per event (2 s timeout: a stopped bridge never holds Claude Code up). */
export function claudeSettings(port) {
  const hook = { type: 'http', url: `http://127.0.0.1:${port}/hook`, timeout: 2, headers: { 'X-Bloobies': 'hook' } }
  return {
    permissions: { allow: ['mcp__bloobies__status'] },
    hooks: Object.fromEntries(HOOK_EVENTS.map((e) => [e, [{ hooks: [hook] }]])),
  }
}

export function mcpConfig() {
  return { mcpServers: { bloobies: { type: 'stdio', command: process.execPath, args: [CLI, 'mcp'] } } }
}

export const home = () => process.env.BLOOBIES_HOME || path.join(os.homedir(), '.bloobies')

/** The per-run files (`claude --settings <a> --mcp-config <b>`). */
export function writeRunFiles(port, dir = home()) {
  fs.mkdirSync(dir, { recursive: true })
  const settings = path.join(dir, 'claude-settings.json')
  const mcp = path.join(dir, 'mcp.json')
  fs.writeFileSync(settings, JSON.stringify(claudeSettings(port), null, 2) + '\n')
  fs.writeFileSync(mcp, JSON.stringify(mcpConfig(), null, 2) + '\n')
  return { settings, mcp }
}

const readJson = (file) => (fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8') || '{}') : {})

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  if (fs.existsSync(file)) fs.copyFileSync(file, file + '.bak')
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n')
}

/** The status line command: ours, with the status line that was there before (if any) as its arguments. */
const statusCommand = (previous) => `node "${STATUSLINE}"${previous ? ` ${previous}` : ''}`

/**
 * If `command` is bloobies' status line (this checkout's, or the same package since moved), the command it chains to
 * ('' when it chains nothing); otherwise null. The chained command is everything after `node "<path>" `, verbatim.
 */
export function chainedStatusLine(command) {
  const m = /^node "([^"]+)"(?: ([\s\S]*))?$/.exec(command ?? '')
  if (!m || path.basename(m[1]) !== 'statusline.mjs') return null
  if (path.resolve(m[1]) !== STATUSLINE && !/bloobies/i.test(m[1])) return null
  return m[2] ?? ''
}

/**
 * Settings with our hooks taken out (and, unless `remove`, put back for this port). Other hooks are untouched.
 * The status line (which feeds the usage billboard) is handled the same way: set, chained in front of an existing
 * command one, re-pointed (never wrapped twice) when it is already ours, and on `remove` given back exactly as it was
 * (or taken out when there was none). `opts.statusLine: false` leaves it alone on install; `opts.inheritStatusLine`
 * (a project file whose user settings already have one) does not add a second that would shadow it.
 */
export function mergeSettings(current, port, remove = false, opts = {}) {
  const next = { ...current, hooks: { ...(current.hooks ?? {}) } }
  for (const [ev, groups] of Object.entries(next.hooks)) {
    const kept = (Array.isArray(groups) ? groups : [])
      .map((g) => ({ ...g, hooks: (g.hooks ?? []).filter((h) => !isOurs(h)) }))
      .filter((g) => g.hooks.length)
    if (kept.length) next.hooks[ev] = kept
    else delete next.hooks[ev]
  }
  const allow = new Set(current.permissions?.allow ?? [])
  if (remove) allow.delete('mcp__bloobies__status')
  else {
    for (const [ev, groups] of Object.entries(claudeSettings(port).hooks)) next.hooks[ev] = [...(next.hooks[ev] ?? []), ...groups]
    allow.add('mcp__bloobies__status')
  }
  next.permissions = { ...(current.permissions ?? {}), allow: [...allow] }
  if (!next.permissions.allow.length) delete next.permissions.allow
  if (!Object.keys(next.permissions).length) delete next.permissions
  if (!Object.keys(next.hooks).length) delete next.hooks

  const sl = current.statusLine
  const chained = typeof sl?.command === 'string' ? chainedStatusLine(sl.command) : null
  if (remove) {
    if (chained) next.statusLine = { ...sl, command: chained }
    else if (chained === '') delete next.statusLine
  } else if (opts.statusLine !== false) {
    if (chained !== null) next.statusLine = { ...sl, command: statusCommand(chained) }
    else if (sl === undefined) {
      if (!opts.inheritStatusLine) next.statusLine = { type: 'command', command: statusCommand('') }
    } else if (sl.type === 'command' && typeof sl.command === 'string' && sl.command.trim()) next.statusLine = { ...sl, command: statusCommand(sl.command) }
  }
  return next
}

/**
 * Install (or with `remove`, uninstall) for every session: `scope` is 'user' (~/.claude/settings.json) or a
 * project folder (its .claude/settings.local.json and .mcp.json). Returns what it changed, for the CLI to print.
 */
export function install({ scope, port, remove = false, statusLine = true, userHome = os.homedir() }) {
  const changed = []
  const userSettings = path.join(userHome, '.claude', 'settings.json')
  const settings = scope === 'user' ? userSettings : path.join(scope, '.claude', 'settings.local.json')
  const before = readJson(settings)
  // (a project's status line would shadow the user's own: only add one there when the user settings have none)
  const inheritStatusLine = scope !== 'user' && readJson(userSettings).statusLine !== undefined
  const after = mergeSettings(before, port, remove, { statusLine, inheritStatusLine })
  writeJson(settings, after)
  changed.push(settings)
  const ours = (s) => typeof s?.statusLine?.command === 'string' && chainedStatusLine(s.statusLine.command) !== null
  /** What happened to the status line, in a sentence for the CLI. */
  let statusNote = null
  if (remove) statusNote = ours(before) ? (ours(after) ? null : after.statusLine ? 'Status line: yours is back as it was.' : 'Status line: removed.') : null
  else if (ours(after)) statusNote = chainedStatusLine(after.statusLine.command) ? 'Status line: yours is kept and runs through the usage reader.' : 'Status line: added (it feeds the usage billboard).'
  else if (statusLine && inheritStatusLine && !before.statusLine) statusNote = 'Status line: your user settings have one, so none was added here. Run install --user to add the usage reader to it.'
  let mcpHint = null
  if (scope === 'user') {
    mcpHint = remove
      ? 'claude mcp remove --scope user bloobies'
      : `claude mcp add --scope user bloobies -- "${process.execPath}" "${CLI}" mcp`
  } else {
    const file = path.join(scope, '.mcp.json')
    const cur = readJson(file)
    const servers = { ...(cur.mcpServers ?? {}) }
    if (remove) delete servers.bloobies
    else Object.assign(servers, mcpConfig().mcpServers)
    writeJson(file, { ...cur, mcpServers: servers })
    changed.push(file)
  }
  return { changed, mcpHint, statusNote }
}
