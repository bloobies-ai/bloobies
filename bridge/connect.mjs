// Connecting Claude Code to the bridge for one run: the hooks (http, straight to the bridge) and the MCP status
// server, written to ~/.bloobies/ for `claude --settings … --mcp-config …`, so nothing in your Claude Code setup
// changes. (`bloobies install`, which does edit a settings file, is setup.mjs; the plugin ships without it.)
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), 'cli.mjs')

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
