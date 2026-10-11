#!/usr/bin/env node
// Every hook event but SessionStart (the bloobies plugin): pass Claude Code's hook input on to the bridge on this
// machine (127.0.0.1:5318), which turns it into the world's events. It runs in the background (async in hooks.json),
// prints nothing, and always exits 0: a stopped bridge never holds Claude Code up or changes what it does.
const PORT = 5318

let input = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (d) => (input += d))
process.stdin.on('end', async () => {
  try {
    await fetch(`http://127.0.0.1:${PORT}/hook`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-bloobies': 'hook' },
      body: input,
      signal: AbortSignal.timeout(1500),
    })
  } catch {
    // (no bridge running: nothing to show)
  }
  process.exit(0)
})
