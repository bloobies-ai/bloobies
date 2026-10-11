// How full an agent's context is, from the transcript Claude Code already writes (one JSON object per line).
// Only the tail is read, and only the usage numbers are kept: no message text leaves this function.
import fs from 'node:fs'

const TAIL = 256 * 1024

/** The context size at the agent's last reply: { tokens, model }, or null if there's nothing to go on yet. */
export function readUsage(file) {
  let fd
  try {
    fd = fs.openSync(file, 'r')
    const size = fs.fstatSync(fd).size
    const start = Math.max(0, size - TAIL)
    const buf = Buffer.alloc(size - start)
    fs.readSync(fd, buf, 0, buf.length, start)
    const lines = buf.toString('utf8').split('\n')
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i]
      if (!line.includes('"usage"')) continue
      let row
      try {
        row = JSON.parse(line)
      } catch {
        continue // (the first line of the tail is usually cut in half)
      }
      const u = row?.message?.usage
      if (row?.type !== 'assistant' || !u) continue
      const tokens =
        (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.output_tokens ?? 0)
      if (tokens > 0) return { tokens, model: row.message.model }
    }
    return null
  } catch {
    return null
  } finally {
    if (fd !== undefined) fs.closeSync(fd)
  }
}
