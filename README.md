# SelfCodingProjects

Just creating things using Claude Code (or any other agents if I get access to them in the future).

## Mods

### usage-gauges

A Claude Code mod that shows how much of your limits you've used, in a row above the prompt:

- **Cont. Window**: how full the context window is (left)
- **5-Hour Limit**: your 5-hour usage, with time until it resets (centre)
- **Week Limit**: your weekly usage, with time until it resets (right)

Each one is a progress ring, colored green under 50%, yellow from 50% to 79%, and red at 80% or more. Before the first reply of a session they show `--%`.

It also puts a running tool-call count (`tools: N`) in the status bar, saved across sessions.

In the desktop app the gauges are drawn rings; in the terminal they're text wheels (`○ ◔ ◑ ◕ ●`).

#### Install

At the prompt of a Claude Code terminal session:

```
/plugin install usage-gauges --marketplace NobleSeven7/SelfCodingProjects
```

Answer `y` to add the marketplace, then press Enter to install for your user. It starts working right away.

From a shell:

```
claude plugin install usage-gauges --marketplace NobleSeven7/SelfCodingProjects
```

In the desktop app, where `/plugin` doesn't run: click **+** next to the prompt box, then **Plugins**, **Add marketplace** with `NobleSeven7/SelfCodingProjects`, then **Add plugin**.

## Status line (Windows PowerShell)

[`statusline/statusline.ps1`](statusline/statusline.ps1) is a Claude Code status line for the **terminal** (the desktop app doesn't run status line scripts; use the usage-gauges mod there). It shows:

```
Model | ◕ Ctx 68% | ◔ 5h 18% (2h 14m) | ◑ 7d 42% (4d 6h)
```

- A pie wheel for each: `○` 0%, `◔` 1–25%, `◑` 26–50%, `◕` 51–85%, `●` 86–100%
- Wheel and percentage colored green under 50%, yellow 50–79%, red 80% and up
- Time left until the 5-hour and weekly limits reset
- `○ --%` when a value isn't known yet (a new session, before the first reply)

#### Set up

1. Save `statusline.ps1` into your Claude config folder, `%USERPROFILE%\.claude\` (or the folder `CLAUDE_CONFIG_DIR` points to, if you set it).
2. Add this to `settings.json` in that same folder, changing the path to where you saved the script:

   ```json
   "statusLine": {
     "type": "command",
     "command": "powershell.exe -NoProfile -ExecutionPolicy Bypass -File \"C:\\Users\\YOU\\.claude\\statusline.ps1\"",
     "padding": 0
   }
   ```

3. Start a new Claude Code session in a terminal.

The script uses Windows PowerShell 5.1, which comes with Windows; nothing else to install.
