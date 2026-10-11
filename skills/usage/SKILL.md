---
name: usage
description: Show your Claude plan's usage (5-hour and weekly) on the bloobies board. Sets your status line, keeping any you already have. Add "off" to undo.
disable-model-invocation: true
---

Turn on the bloobies usage reader. Run this exact command with the Bash tool (the user approves it), then tell the user
the line it prints, and nothing more:

```
node "${CLAUDE_PLUGIN_ROOT}/bridge/usage-reader.mjs" $ARGUMENTS
```

What it does, if the user asks: Claude Code gives the plan's usage only to the status line command, so this sets the
status line in ~/.claude/settings.json to bloobies' reader (copied to ~/.bloobies/statusline.mjs). A status line they
already had keeps running through it and still shows. It works where Claude Code runs status lines (a terminal); the
Claude desktop app doesn't run them, so there the board's Claude row stays empty. It keeps only the two percentages and their reset times, in
~/.bloobies/claude-limits.json, and backs up settings.json first. `/bloobies:usage off` puts everything back.
