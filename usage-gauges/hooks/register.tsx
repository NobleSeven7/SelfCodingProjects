import { atom, read, update } from 'claude-code'
import type { Register, SessionContextUsage, SessionRateLimit, TurnUsage } from 'claude-code'

import type { CacheReading, Gauge, Usage } from '../types'

// A row above the prompt with four gauges:
//   Cont. Window 15% | 5-Hour Limit 6% (4h 38m) | Week Limit 61% (2d 8h) | Prompt Cache 96% (warm)
// Usage gauges: green under 50%, yellow 50-79%, red 80%+ (high is bad).
// Prompt Cache is inverted (high is good): green 80%+ and warm, yellow 50-79%,
// red under 50% or cold.
// Missing values (a fresh session, before the first reply) show dim as "--%".

const usage = atom({ plugin: 'usage-gauges', key: 'usage' } as const, null)
const cache = atom({ plugin: 'usage-gauges', key: 'cache' } as const, null)

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

/** For usage against a limit: more is worse. */
function usageColor(pct: number): string {
  if (pct < 50) return GREEN
  if (pct < 80) return YELLOW
  return RED
}

/** For the prompt cache hit rate: more is better, and a cold cache is red. */
function cacheColor(pct: number, isWarm: boolean): string {
  if (!isWarm || pct < 50) return RED
  if (pct < 80) return YELLOW
  return GREEN
}

// A progress ring in the style of the app's own: a faint full circle with a
// colored arc from 12 o'clock, clockwise. pct null draws the track alone.
const RING_PX = 18

function ring(pct: number | null, stroke: string): string {
  const r = 6.5
  const circ = 2 * Math.PI * r
  const track = `<circle cx="9" cy="9" r="${r}" fill="none" stroke="${TRACK}" stroke-width="2.5"/>`
  if (pct === null || pct <= 0) {
    return `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 18 18">${track}</svg>`
  }
  const arc =
    pct >= 100
      ? `<circle cx="9" cy="9" r="${r}" fill="none" stroke="${stroke}" stroke-width="2.5"/>`
      : `<circle cx="9" cy="9" r="${r}" fill="none" stroke="${stroke}" stroke-width="2.5" stroke-linecap="round" stroke-dasharray="${((circ * pct) / 100).toFixed(2)} ${circ.toFixed(2)}" transform="rotate(-90 9 9)"/>`
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

// Prompt cache. Mods are not handed a `prompt_cache` object, so the hit rate is
// worked out from each main-thread reply's token counts:
//   cache_read / (cache_read + input + cache_creation)
// The cache entry lives 5 minutes (or 1 hour when written that way) after it
// was last used; past that it is cold.
const FIVE_MIN = 5 * 60_000
const ONE_HOUR = 60 * 60_000

export function cacheReading(u: TurnUsage, now: number, prevTtlMs: number | undefined): CacheReading | null {
  const read = u.cache_read_input_tokens || 0
  const total = read + (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0)
  if (total <= 0) return null
  // Which lifetime the cache is written with: from this reply's writes when it
  // made any, else what an earlier reply showed, else 5 minutes.
  let ttlMs = prevTtlMs ?? FIVE_MIN
  if ((u.ephemeral_1h_input_tokens ?? 0) > 0) ttlMs = ONE_HOUR
  else if ((u.ephemeral_5m_input_tokens ?? 0) > 0) ttlMs = FIVE_MIN
  return { percent: Math.round((read / total) * 100), lastAt: now, ttlMs }
}

export function isWarm(c: CacheReading, now: number): boolean {
  return now - c.lastAt < c.ttlMs
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

/** One gauge as the row draws it. */
type Item = {
  key: string
  label: string
  percent: number | null
  color: string
  /** Dim text after the percentage: a reset countdown, or (warm)/(cold). */
  suffix: string
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
    // Redraw once a minute so the countdowns and warm/cold stay current.
    $.clock.every(60_000, () => update($, usage, prev => (prev ? { ...prev, at: Date.now() } : prev)))
    return result
  })

  on('session.measure', async ($, e, next) => {
    await update($, usage, () => snapshot(e.context, e.rateLimits))
    return next(e)
  })

  // Each reply of the main conversation (not a subagent's) updates the cache gauge.
  // turn.step streams, so its hook is an async generator: pass every chunk on
  // untouched, then read the finished reply's token counts.
  on('turn.step', async function* ($, e, next) {
    const result = yield* next(e)
    if (!e.agentId && result.usage) {
      const reply = result.usage
      await update($, cache, prev => cacheReading(reply, Date.now(), prev?.ttlMs) ?? prev).catch(() => undefined)
    }
    return result
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const u = (await read($, usage)) ?? snapshot(undefined, [])
    const c = await read($, cache)
    const now = Math.max(u.at, Date.now())

    const limit = (key: string, label: string, g: Gauge, showReset: boolean): Item => ({
      key,
      label,
      percent: g.percent,
      color: g.percent === null ? TRACK : usageColor(g.percent),
      suffix: showReset ? remaining(g.resetsAt, now) : '',
    })
    const warm = c ? isWarm(c, now) : false
    const items: Item[] = [
      limit('ctx', 'Cont. Window', u.ctx, false),
      limit('five', '5-Hour Limit', u.five, true),
      limit('seven', 'Week Limit', u.seven, true),
      {
        key: 'cache',
        label: 'Prompt Cache',
        percent: c ? c.percent : null,
        color: c ? cacheColor(c.percent, warm) : TRACK,
        suffix: c ? (warm ? ' (warm)' : ' (cold)') : '',
      },
    ]

    const ui = $.ui.resolve(e)
    const { Box, Text } = ui

    // Graphical surfaces (desktop, editor, phone) get drawn rings; the terminal
    // keeps the text wheels.
    if ('Svg' in ui) {
      const { Svg } = ui
      // Four gauges spread edge to edge: first at the left, last at the right,
      // equal space between, never wrapping onto a second line.
      return (
        // Tight gaps, and the dim extras (reset times, warm/cold) one size
        // smaller, so all four fit. On a window too narrow even so, each gauge
        // may shrink and its text ends in "…" rather than running off the edge.
        <Box width="100%" flexDirection="row" flexWrap="nowrap" alignItems="center" justifyContent="space-between" columnGap="sm">
          {items.map(it => (
            <Box key={it.key} flexDirection="row" flexShrink={1} minWidth={0} alignItems="center" gap="xs">
              <Svg
                source={ring(it.percent, it.color)}
                alt={it.percent === null ? `${it.label} unknown` : `${it.label} ${it.percent}%`}
                width={RING_PX}
                height={RING_PX}
              />
              {it.percent === null ? (
                <Text dimColor wrap="truncate-end">{`${it.label} --%`}</Text>
              ) : (
                <Text wrap="truncate-end">
                  {`${it.label} `}
                  <Text color={it.color} bold>
                    {`${it.percent}%`}
                  </Text>
                  {it.suffix ? (
                    <Text dimColor size="footnote">
                      {it.suffix}
                    </Text>
                  ) : null}
                </Text>
              )}
            </Box>
          ))}
        </Box>
      )
    }

    const cells = items.map((it, i) => {
      const sep = i > 0 ? <Text dimColor>{'  |  '}</Text> : null
      if (it.percent === null) {
        return (
          <Text key={it.key}>
            {sep}
            <Text dimColor>{`○ ${it.label} --%`}</Text>
          </Text>
        )
      }
      return (
        <Text key={it.key}>
          {sep}
          <Text color={it.color}>{wheel(it.percent)}</Text>
          {` ${it.label} `}
          <Text color={it.color} bold>
            {`${it.percent}%`}
          </Text>
          {it.suffix ? <Text dimColor>{it.suffix}</Text> : null}
        </Text>
      )
    })

    return (
      <Box>
        <Text>{cells}</Text>
      </Box>
    )
  })
}
