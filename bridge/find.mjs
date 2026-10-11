// Finding the agent programs the bridge can launch: Claude Code, Codex and Cursor's CLI. Looks where each one is
// usually installed and on PATH; BLOOBIES_CLAUDE / BLOOBIES_CODEX / BLOOBIES_CURSOR (or --claude etc. on the
// command line) point at a specific one. Nothing is installed or changed: a missing program just isn't offered.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const WIN = process.platform === 'win32'

const isFile = (f) => {
  try {
    return fs.statSync(f).isFile()
  } catch {
    return false
  }
}

/** `name` on PATH (with the Windows extensions), first hit wins. */
export function onPath(name, env = process.env) {
  const dirs = String(env.PATH ?? env.Path ?? '').split(path.delimiter).filter(Boolean)
  const exts = WIN ? String(env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';').filter(Boolean) : ['']
  for (const d of dirs) for (const x of exts) {
    const f = path.join(d, name + x.toLowerCase())
    if (isFile(f)) return f
    const F = path.join(d, name + x)
    if (isFile(F)) return F
  }
  return null
}

/** Newest-first version folders under `dir` (e.g. the Claude desktop app's bundled CLI). */
function newest(dir) {
  try {
    return fs
      .readdirSync(dir)
      .filter((v) => /^\d+(\.\d+)*$/.test(v))
      .sort((a, b) => {
        const x = a.split('.').map(Number)
        const y = b.split('.').map(Number)
        for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (y[i] ?? 0) - (x[i] ?? 0)
        return 0
      })
      .map((v) => path.join(dir, v))
  } catch {
    return []
  }
}

/** Where Claude Code lives when it isn't on PATH: the native installer's bin, the old local install, the copy
 *  the Claude desktop app keeps (one folder per version, the binary one level further down). */
function claudeElsewhere(home = os.homedir(), env = process.env) {
  const exe = WIN ? 'claude.exe' : 'claude'
  const out = [path.join(home, '.local', 'bin', exe), path.join(home, '.claude', 'local', exe)]
  const appData = env.APPDATA ?? path.join(home, 'AppData', 'Roaming')
  // (the Windows desktop app is an MSIX package: what it writes to Roaming really lives in its package folder, and
  // only processes the app started see it at the usual path; a normal terminal has to look in the package)
  const local = env.LOCALAPPDATA ?? path.join(home, 'AppData', 'Local')
  let packaged = []
  if (WIN) {
    try {
      packaged = fs
        .readdirSync(path.join(local, 'Packages'))
        .filter((d) => /^Claude_/i.test(d))
        .map((d) => path.join(local, 'Packages', d, 'LocalCache', 'Roaming', 'Claude', 'claude-code'))
    } catch {}
  }
  const bundles = WIN
    ? [path.join(appData, 'Claude', 'claude-code'), ...packaged]
    : process.platform === 'darwin'
      ? [path.join(home, 'Library', 'Application Support', 'Claude', 'claude-code')]
      : [path.join(home, '.config', 'Claude', 'claude-code')]
  for (const b of bundles)
    for (const v of newest(b)) {
      out.push(path.join(v, exe))
      try {
        for (const sub of fs.readdirSync(v)) out.push(path.join(v, sub, exe))
      } catch {}
    }
  return out
}

export const PROGRAMS = {
  claude: { names: ['claude'], env: 'BLOOBIES_CLAUDE', title: 'Claude Code', elsewhere: claudeElsewhere },
  codex: { names: ['codex'], env: 'BLOOBIES_CODEX', title: 'Codex CLI', elsewhere: () => [] },
  cursor: { names: ['cursor-agent'], env: 'BLOOBIES_CURSOR', title: 'Cursor CLI', elsewhere: (home = os.homedir()) => [path.join(home, '.local', 'bin', 'cursor-agent')] },
}

/**
 * How to start a program without a shell. npm installs Windows commands as .cmd shims that run a script (or a
 * binary) from the package; the shim names it, so the bridge starts that directly and never hands a task's words
 * to cmd.exe. Returns { file, args } or null when a shim doesn't say.
 */
export function command(p) {
  if (p.file) return { file: p.file, args: p.args ?? [] } // (given outright: the checks' stand-in programs)
  if (!p.shell) return { file: p.path, args: [] }
  let text = ''
  try {
    text = fs.readFileSync(p.path, 'utf8')
  } catch {
    return null
  }
  const m = text.match(/"%~?dp0%?\\([^"%]+?\.(c?js|mjs|exe))"/i)
  if (!m) return null
  const target = path.join(path.dirname(p.path), m[1])
  if (!isFile(target)) return null
  return /\.exe$/i.test(target) ? { file: target, args: [] } : { file: process.execPath, args: [target] }
}

/**
 * The launchable programs: { claude: { path, shell } | null, … }. `shell` is set for Windows .cmd/.bat shims,
 * which Node can only start through cmd.exe (the bridge then passes only fixed, quoted arguments).
 * @param {{ [k: string]: string | undefined }} [override]  explicit paths (from the command line)
 */
export function findPrograms(override = {}, env = process.env) {
  const out = {}
  for (const [key, p] of Object.entries(PROGRAMS)) {
    const given = override[key] ?? env[p.env]
    const hit = given ? (isFile(given) ? given : null) : (p.names.map((n) => onPath(n, env)).find(Boolean) ?? p.elsewhere(os.homedir(), env).find(isFile) ?? null)
    out[key] = hit ? { path: hit, shell: WIN && /\.(cmd|bat)$/i.test(hit), title: p.title } : null
  }
  return out
}
