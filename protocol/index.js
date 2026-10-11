// The runtime half of the protocol (types and docs: index.d.ts). Plain JS so the bridge runs on bare Node.

export const PROTOCOL_VERSION = 1

export const EVENT_TYPES = [
  'agent.spawned',
  'agent.retired',
  'task.assigned',
  'task.status',
  'task.progress',
  'task.handoff',
  'task.done',
  'task.paused',
  'task.file',
  'task.failed',
  'agent.needs_input',
  'agent.idle',
  'agent.usage',
  'agent.said',
  'limits.update',
]

export const STATION_KINDS = ['build', 'research', 'test', 'review', 'ship', 'design']

export const NAMES = ['PIP', 'MOSS', 'DOT', 'FIG', 'JUNO', 'REX', 'KIT', 'BEA', 'OZZY', 'NIB', 'TAM', 'LUX']

const KEYWORDS = [
  ['ship', /\b(ship|deploy|release|publish|launch|staging|prod|hotfix)/i],
  ['test', /\b(tests?|testing|e2e|specs?|fuzz|flaky|coverage|qa)\b/i],
  ['review', /\b(review|audit|check|prs?|diff|approve)\b/i],
  ['design', /\b(design|sketch|icons?|colou?rs?|type scale|layout|mock ?up|figma|ui)\b/i],
  ['research', /\b(research|compare|benchmark|read|find|investigate|explore|look into|why)\b/i],
]

export function stationFor(text) {
  return KEYWORDS.find(([, re]) => re.test(text))?.[0] ?? 'build'
}

export function shortLabel(text) {
  const words = String(text).trim().replace(/\s+/g, ' ').split(' ')
  let out = ''
  for (const w of words) {
    if ((out + ' ' + w).trim().length > 22) break
    out = (out + ' ' + w).trim()
  }
  out = out || (words[0] ?? '').slice(0, 22)
  return out.charAt(0).toUpperCase() + out.slice(1)
}
