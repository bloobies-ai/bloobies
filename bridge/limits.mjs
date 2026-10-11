// The plan limits for the usage billboard: how much of the 5-hour and weekly allowance is used, for Claude and for
// ChatGPT (Codex). Nothing is asked of either service: both numbers come from files already on this machine.
//   - Claude: Claude Code hands its status line command the `rate_limits` block (Pro/Max plans, after the first reply).
//     `statusline.mjs` keeps the last one in ~/.bloobies/claude-limits.json, and this reads it back.
//   - Codex: every `token_count` row in its session logs (~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl) carries
//     `rate_limits`; the newest row wins. Only the tail of the newest few logs is read, and only the numbers are kept.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const TAIL = 512 * 1024
/** Older than this, a reading says nothing about now. */
const STALE = 8 * 24 * 3600e3

/** Epoch seconds, epoch ms or an ISO string → epoch ms (or null). */
function when(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return v < 1e12 ? v * 1000 : v
  if (typeof v === 'string') {
    const n = Date.parse(v)
    return Number.isFinite(n) ? n : null
  }
  return null
}

/**
 * One window: { pct, resetsAt } (pct 0–100, resetsAt epoch ms or null). A window whose reset time has passed is
 * empty again, so it reads 0 until the next reading comes in.
 */
function windowOf(pct, resets, now) {
  if (typeof pct !== 'number' || !Number.isFinite(pct)) return null
  const resetsAt = when(resets)
  if (resetsAt !== null && resetsAt <= now) return { pct: 0, resetsAt: null }
  return { pct: Math.max(0, Math.min(100, Math.round(pct))), resetsAt }
}

/** The last Claude reading (see statusline.mjs), or null. */
export function readClaude(home, now = Date.now()) {
  try {
    const row = JSON.parse(fs.readFileSync(path.join(home, 'claude-limits.json'), 'utf8'))
    if (!row || now - (row.at ?? 0) > STALE) return null
    const h5 = windowOf(row.five_hour?.used_percentage, row.five_hour?.resets_at, now)
    const wk = windowOf(row.seven_day?.used_percentage, row.seven_day?.resets_at, now)
    return h5 || wk ? { h5, wk, at: row.at } : null
  } catch {
    return null
  }
}

/** The newest few Codex session logs, newest first (walks the dated folders from the latest down). */
function codexLogs(root, want = 3) {
  const out = []
  const desc = (dir) => {
    try {
      return fs.readdirSync(dir).sort().reverse()
    } catch {
      return []
    }
  }
  for (const y of desc(root)) {
    for (const m of desc(path.join(root, y))) {
      for (const d of desc(path.join(root, y, m))) {
        const day = path.join(root, y, m, d)
        const files = desc(day)
          .filter((f) => f.startsWith('rollout-') && f.endsWith('.jsonl'))
          .map((f) => {
            const p = path.join(day, f)
            try {
              return { p, t: fs.statSync(p).mtimeMs }
            } catch {
              return null
            }
          })
          .filter(Boolean)
          .sort((a, b) => b.t - a.t)
        out.push(...files)
        if (out.length >= want) return out.sort((a, b) => b.t - a.t).slice(0, want)
      }
    }
  }
  return out.sort((a, b) => b.t - a.t)
}

/** The last `rate_limits` in one log's tail: { rl, at } or null. */
function lastLimits(file) {
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
      if (!line.includes('"token_count"') || !line.includes('"rate_limits"')) continue
      let row
      try {
        row = JSON.parse(line)
      } catch {
        continue // (the first line of the tail is usually cut in half)
      }
      const rl = row?.payload?.rate_limits
      if (row?.payload?.type === 'token_count' && rl?.primary) return { rl, at: when(row.timestamp) ?? 0 }
    }
    return null
  } catch {
    return null
  } finally {
    if (fd !== undefined) fs.closeSync(fd)
  }
}

/** The last Codex reading, or null. Windows are matched by length, not by name (300 min and a week). */
export function readCodex(root = path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'sessions'), now = Date.now()) {
  let best = null
  for (const { p } of codexLogs(root)) {
    const r = lastLimits(p)
    if (r && (!best || r.at > best.at)) best = r
  }
  if (!best || now - best.at > STALE) return null
  const wins = [best.rl.primary, best.rl.secondary].filter(Boolean)
  const pick = (mins) => wins.find((w) => Math.abs((w.window_minutes ?? 0) - mins) < mins * 0.1)
  const a = pick(300)
  const b = pick(10080)
  const h5 = a ? windowOf(a.used_percent, a.resets_at, now) : null
  const wk = b ? windowOf(b.used_percent, b.resets_at, now) : null
  return h5 || wk ? { h5, wk, at: best.at } : null
}

/** Both: { claude, codex } (either may be null). */
export function readLimits(home, now = Date.now()) {
  return { claude: readClaude(home, now), codex: readCodex(undefined, now) }
}
