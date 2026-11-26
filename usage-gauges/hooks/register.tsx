import { atom, read, update } from 'claude-code'
import type { Register, SessionContextUsage, SessionRateLimit } from 'claude-code'

import type { Gauge, Usage } from '../types'

// A row above the prompt:  ◕ Ctx 68%  |  ◔ 5h 18% (2h 14m)  |  ◑ 7d 42% (4d 6h)
// Wheel and percentage are colored: green under 50%, yellow 50-79%, red 80%+.
// Missing values (a fresh session, before the first reply) show dim as "○ Ctx --%".

const usage = atom({ plugin: 'usage-gauges', key: 'usage' } as const, null)

function wheel(pct: number): string {
  if (pct <= 0) return '○'
  if (pct <= 25) return '◔'
  if (pct <= 50) return '◑'
  if (pct <= 85) return '◕'
  return '●'
}

// Fixed colors, so each ring (drawn as an image) and its percentage match exactly.
const GREEN = '#8cc265'
const YELLOW = '#e5b143'
const RED = '#e5534b'
const TRACK = 'rgba(255,255,255,0.18)'

function color(pct: number): string {
  if (pct < 50) return GREEN
  if (pct < 80) return YELLOW
  return RED
}

// A progress ring in the style of the app's own: a faint full circle with a
// colored arc from 12 o'clock, clockwise. pct null draws the track alone.
const RING_PX = 18

function ring(pct: number | null): string {
  const r = 6.5
  const circ = 2 * Math.PI * r
  const track = `<circle cx="9" cy="9" r="${r}" fill="none" stroke="${TRACK}" stroke-width="2.5"/>`
  if (pct === null || pct <= 0) {
    return `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 18 18">${track}</svg>`
  }
  const arc =
    pct >= 100
      ? `<circle cx="9" cy="9" r="${r}" fill="none" stroke="${color(pct)}" stroke-width="2.5"/>`
      : `<circle cx="9" cy="9" r="${r}" fill="none" stroke="${color(pct)}" stroke-width="2.5" stroke-linecap="round" stroke-dasharray="${((circ * pct) / 100).toFixed(2)} ${circ.toFixed(2)}" transform="rotate(-90 9 9)"/>`
  return `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 18 18">${track}${arc}</svg>`
}

function remaining(resetsAt: string | null, now: number): string {
  if (!resetsAt) return ''
  const at = Date.parse(resetsAt)
  if (Number.isNaN(at)) return ''
  const secs = Math.floor((at - now) / 1000)
  if (secs <= 0) return ' (now)'
  const d = Math.floor(secs / 86400)
  const h = Math.floor((secs % 86400) / 3600)
  const m = Math.floor((secs % 3600) / 60)
  if (d >= 1) return ` (${d}d ${h}h)`
  if (h >= 1) return ` (${h}h ${m}m)`
  return ` (${m}m)`
}

function toGauge(percent: number | undefined, resetsAt?: string): Gauge {
  if (percent == null || Number.isNaN(percent)) return { percent: null, resetsAt: null }
  return { percent: Math.round(Math.min(100, Math.max(0, percent))), resetsAt: resetsAt ?? null }
}

function snapshot(context: SessionContextUsage | undefined, limits: SessionRateLimit[]): Usage {
  const five = limits.find(l => l.kind === 'five_hour')
  const seven = limits.find(l => l.kind === 'seven_day')
  return {
    ctx: toGauge(context?.percent),
    five: toGauge(five?.percentUsed, five?.resetsAt),
    seven: toGauge(seven?.percentUsed, seven?.resetsAt),
    at: Date.now(),
  }
}

// Tool-call count for the bottom status bar ("tools: N"). Saved in the mod's
// store so it keeps counting across sessions and reloads. Loaded once, then
// kept in memory so tool calls that run at the same time each add exactly 1.
const COUNT_KEY = 'toolCount'
let countLoaded: Promise<number> | undefined
let toolCalls = 0

function loadCount($: { store: { get: (key: string) => Promise<unknown> } }): Promise<number> {
  countLoaded ??= $.store.get(COUNT_KEY).then(saved => {
    toolCalls = Number(saved ?? 0) || 0
    return toolCalls
  })
  return countLoaded
}

export const register: Register = on => {
  on('tool.call', async ($, e, next) => {
    await loadCount($).catch(() => 0)
    toolCalls += 1
    $.ui.status(`tools: ${toolCalls}`)
    // A failed save never blocks the tool itself.
    await $.store.set(COUNT_KEY, toolCalls).catch(() => undefined)
    return next(e)
  })

  on('session.start', async ($, e, next) => {
    const result = await next(e)
    $.ui.status(`tools: ${await loadCount($).catch(() => 0)}`)
    try {
      const u = await $.session.usage()
      await update($, usage, () => snapshot(u.context, u.rateLimits))
    } catch {
      await update($, usage, () => snapshot(undefined, []))
    }
    // Redraw once a minute so the countdowns stay current between replies.
    $.clock.every(60_000, () => update($, usage, prev => (prev ? { ...prev, at: Date.now() } : prev)))
    return result
  })

  on('session.measure', async ($, e, next) => {
    await update($, usage, () => snapshot(e.context, e.rateLimits))
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const u = (await read($, usage)) ?? snapshot(undefined, [])
    const ui = $.ui.resolve(e)
    const { Box, Text } = ui

    // Graphical surfaces (desktop, editor, phone) get drawn rings; the terminal
    // keeps the text wheels.
    if ('Svg' in ui) {
      const { Svg } = ui
      // Three equal columns: left, centre, right.
      const gauge = (
        key: string,
        label: string,
        g: Gauge,
        showReset: boolean,
        justify: 'flex-start' | 'center' | 'flex-end',
      ) => (
        <Box
          key={key}
          width="33%"
          flexGrow={1}
          flexDirection="row"
          alignItems="center"
          justifyContent={justify}
          gap="sm"
        >
          <Svg
            source={ring(g.percent)}
            alt={g.percent === null ? `${label} usage unknown` : `${label} ${g.percent}% used`}
            width={RING_PX}
            height={RING_PX}
          />
          {g.percent === null ? (
            <Text dimColor>{`${label} --%`}</Text>
          ) : (
            <Text>
              {`${label} `}
              <Text color={color(g.percent)} bold>
                {`${g.percent}%`}
              </Text>
              {showReset ? <Text dimColor>{remaining(g.resetsAt, u.at)}</Text> : null}
            </Text>
          )}
        </Box>
      )
      return (
        <Box width="100%" flexDirection="row" alignItems="center">
          {gauge('ctx', 'Cont. Window', u.ctx, false, 'flex-start')}
          {gauge('five', '5-Hour Limit', u.five, true, 'center')}
          {gauge('seven', 'Week Limit', u.seven, true, 'flex-end')}
        </Box>
      )
    }

    const cell = (key: string, label: string, g: Gauge, showReset: boolean) => {
      if (g.percent === null) {
        return (
          <Text key={key} dimColor>
            ○ {label} --%
          </Text>
        )
      }
      const c = color(g.percent)
      return (
        <Text key={key}>
          <Text color={c}>{wheel(g.percent)}</Text>
          {` ${label} `}
          <Text color={c} bold>
            {`${g.percent}%`}
          </Text>
          {showReset ? <Text dimColor>{remaining(g.resetsAt, u.at)}</Text> : null}
        </Text>
      )
    }

    return (
      <Box>
        <Text>
          {cell('ctx', 'Cont. Window', u.ctx, false)}
          <Text dimColor>{'  |  '}</Text>
          {cell('five', '5-Hour Limit', u.five, true)}
          <Text dimColor>{'  |  '}</Text>
          {cell('seven', 'Week Limit', u.seven, true)}
        </Text>
      </Box>
    )
  })
}
