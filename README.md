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
