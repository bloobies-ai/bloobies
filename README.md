# bloobies for Claude Code

Watch your Claude Code agents work as a little crew at [bloobies.ai](https://bloobies.ai).

![A crew of bloobies at work: build, research, test, review, ship and design stations around a tree, with the usage board behind](https://bloobies.ai/media/crew.gif)

## Install

In Claude Code:

```text
/plugin install bloobies --marketplace yungprimer/bloobies
```

Then open [bloobies.ai](https://bloobies.ai) and sign in. It finds your agents by itself.

## What you get

<table>
  <tr>
    <td width="50%"><img src="media/design.jpg" alt="A bloobie painting at the design station, its task written on the floor"></td>
    <td width="50%"><img src="media/emotes.jpg" alt="Bloobies reacting: a pls no sign, a flag, a headband"></td>
  </tr>
  <tr>
    <td>Every agent and subagent is a bloobie, working at the station for what it's doing, with its task on the floor.</td>
    <td>They show how it's going: a "pls no" sign when blocked, a flag when one needs you, a headband when it's urgent.</td>
  </tr>
  <tr>
    <td><img src="media/board.jpg" alt="The usage board: 5-hour and weekly limits as a dot-matrix billboard"></td>
    <td><img src="media/night.jpg" alt="The world at night, each bloobie in its own pool of light"></td>
  </tr>
  <tr>
    <td>Your plan's 5-hour and weekly limits, and when they reset, on the board.</td>
    <td>Day turns to night with your own clock.</td>
  </tr>
</table>

## What it runs, reads and sends

In short: a small bridge runs on your machine, listens on `127.0.0.1` only, and streams what your agents are doing
to your bloobies.ai tab. Your prompts, code, file contents and keys stay on your machine. The plugin sends nothing
to bloobies.ai's servers.

### What it runs

- **At each session start**, `scripts/start.mjs` (the SessionStart hook, about 100 ms, prints nothing) checks for the
  bridge on `127.0.0.1:5318`, and starts `bridge/cli.mjs` in the background if it isn't running. The bridge listens
  on `127.0.0.1` only, so nothing outside this machine can reach it. It stops by itself after 30 idle minutes.
- **On every other hook event**, `scripts/hook.mjs` runs in the background, so it never slows Claude Code down. It
  passes the hook's JSON to the bridge at `http://127.0.0.1:5318/hook`, and does nothing else. If no bridge is
  running, it quietly exits.
- **Once, the first time**, if no bloobies.ai tab has connected within 8 seconds, the bridge opens
  `https://bloobies.ai` in your browser. It notes that it did (in the plugin's data folder) and never does it again.
- **It never starts agents on its own.** The bridge can start a Claude Code, Codex or Cursor run only when asked by a
  page that holds the bridge's private token. The plugin never gives that token to bloobies.ai, so from bloobies.ai
  you watch, and you direct your agents in Claude Code itself.

### What it reads (on this machine only; nothing it reads is uploaded)

- **The hook JSON** that Claude Code passes to each hook: the session id, the event, the tool's name and input, and
  the working folder. The bridge boils this down to the world's events: which agent, what state it's in, which
  station it's at, and a short task label.
- **The end of each session's transcript** (the last 256 KB of the file Claude Code names in the hook JSON), for the
  context-size meter. Only the token counts are kept, never message text.
- **Codex's session logs** (`~/.codex/sessions`), for their token-count rows only, to show Codex's limits on the
  usage board.
- **`~/.bloobies/claude-limits.json`**, if it exists, for your Claude plan's 5-hour and weekly limits. This plugin
  doesn't write it; the optional bloobies status line does.
- **Your `PATH` and the usual install folders**, to see which agent programs (Claude Code, Codex, Cursor CLI) you
  have.

### What it writes

- **The plugin's data folder:** `bridge.log`, and the marker that bloobies.ai was opened once.
- **`~/.bloobies`:** a list of recent project folders, and the hook and MCP settings files that runs started by the
  bridge use.
- **It never changes your Claude Code settings or permissions.**

### What it sends, and to whom

- **World events go to pages connected to the bridge**, over a WebSocket on `127.0.0.1`. Those pages are open in your
  own browser, so the events travel from your machine to your tab, not through bloobies.ai's servers.
- **Who can connect:** only pages from `https://bloobies.ai` and pages served from this machine. Any other website is
  refused.
  - A bloobies.ai page can only watch. It can't start, direct or answer agents, and it never sees your folder list.
  - Directing takes the bridge's token, which only a link made on this machine carries.
- **The website itself** keeps your account (your GitHub id and name) and your plan's time. While your tab is open
  it tells bloobies.ai whether any agent is working, to count trial time. That's the website, not this plugin; see
  the [Terms](https://bloobies.ai/?view=terms).

To stop it: `/plugin disable bloobies`, or uninstall it from `/plugin`.

© 2026 bloobies.ai. All rights reserved: see [LICENSE](LICENSE). [Terms](https://bloobies.ai/?view=terms)
