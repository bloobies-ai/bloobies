// The `bloobies` MCP server (stdio): one tool, status(label, eta?), so an agent can name its own task in 2–3 words.
// It doesn't talk to the bridge itself. The call shows up in Claude Code's PreToolUse hook like any other tool,
// already tagged with which agent made it, and the adapter turns it into a task.status.
import readline from 'node:readline'

const VERSION = '0.1.0'

const TOOLS = [
  {
    name: 'status',
    title: 'Show what you are doing',
    description:
      'Show the person watching what you are working on, as a 2–3 word label on your workstation (for example ' +
      '"Writing tests", "Fixing login"). Call it when you start something new. Optionally say how many minutes ' +
      'you expect it to take. Costs nothing and has no side effects.',
    inputSchema: {
      type: 'object',
      properties: {
        label: { type: 'string', description: '2–3 words, e.g. "Refactoring auth"', maxLength: 40 },
        eta: { type: 'number', description: 'Your best guess of minutes left (optional)', minimum: 0 },
      },
      required: ['label'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  },
]

const INSTRUCTIONS =
  'This session is shown live as a little world of workers. When you start a new piece of work, call the ' +
  'bloobies status tool with a 2–3 word label (and minutes left if you can guess), so the person watching can ' +
  'follow along. Keep labels short and plain.'

export function runMcp(input = process.stdin, output = process.stdout) {
  const write = (msg) => output.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n')
  const rl = readline.createInterface({ input })
  rl.on('line', (line) => {
    let m
    try {
      m = JSON.parse(line)
    } catch {
      return write({ id: null, error: { code: -32700, message: 'Parse error' } })
    }
    if (m.id === undefined || m.id === null) return // notifications (initialized, cancelled…) need no answer
    switch (m.method) {
      case 'initialize':
        return write({
          id: m.id,
          result: {
            protocolVersion: m.params?.protocolVersion ?? '2025-06-18',
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: 'bloobies', version: VERSION },
            instructions: INSTRUCTIONS,
          },
        })
      case 'ping':
        return write({ id: m.id, result: {} })
      case 'tools/list':
        return write({ id: m.id, result: { tools: TOOLS } })
      case 'tools/call': {
        if (m.params?.name !== 'status') return write({ id: m.id, error: { code: -32602, message: `Unknown tool ${m.params?.name}` } })
        const label = String(m.params?.arguments?.label ?? '').trim()
        if (!label) return write({ id: m.id, result: { isError: true, content: [{ type: 'text', text: 'label is required' }] } })
        return write({ id: m.id, result: { content: [{ type: 'text', text: `Showing "${label.slice(0, 40)}".` }] } })
      }
      default:
        return write({ id: m.id, error: { code: -32601, message: `Method not found: ${m.method}` } })
    }
  })
  return rl
}
