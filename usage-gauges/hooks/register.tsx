import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, SessionContextUsage, SessionRateLimit, TurnUsage } from 'claude-code'

import type { CacheReading, Gauge, Usage } from '../types'

// A row above the prompt with four gauges:
//   Context 15% | 5-Hour 6% (4h 38m) | Weekly 61% (2d 8h) | Cache 96% (warm · 54m)
// Usage gauges: green under 50%, yellow 50-79%, red 80%+ (high is bad).
// Cache is inverted (high is good): green 80%+ and warm, yellow 50-79%,
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

/**
 * The cache lifetime a login type implies, for when no reply has shown it yet:
 * 1 hour on a Claude subscription (claude.ai, or an OAuth token a host passed
 * in), 5 minutes otherwise (an API key, the Console, a cloud provider).
 */
export function loginTtl(kind: string | undefined): number {
  return kind === 'claude.ai' || kind === 'oauth-token' ? ONE_HOUR : FIVE_MIN
}

/** "(warm · 54m)" while warm, rounded up so it never reads 0m; "(cold)" after. */
export function cacheSuffix(c: CacheReading, now: number): string {
  const left = c.lastAt + c.ttlMs - now
  if (left <= 0) return ' (cold)'
  return ` (warm · ${Math.ceil(left / 60_000)}m)`
}

// Tool-call count for the bottom status bar ("tools: N"), one running total
// shared by every session and every copy of this mod (a dev copy and one
// installed from GitHub each get their own $.store, so that can't be used).
//
// The total lives in a small JSON file next to the plugins' data folders in
// the Claude config folder. Each tool call re-reads it, adds 1 and writes it
// back, so calls made in other sessions are kept too. Calls in this session
// run one after another through `chain`, so simultaneous calls each add 1.
// Falls back to this copy's own $.store if the file can't be reached.
const COUNT_KEY = 'toolCount'

let countFile: Promise<string | null> | undefined
let chain: Promise<unknown> = Promise.resolve()
let toolCalls = 0

/** The shared count file: beside this copy's own plugin data folder. */
export function sharedPathFrom(dataDir: string | undefined): string | null {
  if (!dataDir) return null
  const parent = dataDir.replace(/[\\/]+$/, '').replace(/[\\/][^\\/]*$/, '')
  return parent ? `${parent}/usage-gauges-shared/tool-count.json` : null
}

function sharedFile($: EngineInterface): Promise<string | null> {
  countFile ??= (async () => {
    try {
      const env = await $.process.hookEnv()
      return sharedPathFrom(env.CLAUDE_PLUGIN_DATA)
    } catch {
      return null
    }
  })()
  return countFile
}

async function readTotal($: EngineInterface): Promise<number> {
  const file = await sharedFile($)
  const own = Number((await $.store.get(COUNT_KEY).catch(() => 0)) ?? 0) || 0
  if (!file) return own
  try {
    const saved = JSON.parse(await $.fs.read(file)) as { count?: unknown }
    return Number(saved.count ?? 0) || 0
  } catch {
    // No shared file yet: start it from this copy's own saved count.
    return own
  }
}

async function writeTotal($: EngineInterface, total: number): Promise<void> {
  const file = await sharedFile($)
  if (file) await $.fs.write(file, JSON.stringify({ count: total }) + '\n').catch(() => undefined)
  await $.store.set(COUNT_KEY, total).catch(() => undefined)
}

/** Runs `step` after every earlier step of this session has finished. */
function serial<T>(step: () => Promise<T>): Promise<T> {
  const run = chain.then(step, step)
  chain = run.catch(() => undefined)
  return run
}

function addToolCall($: EngineInterface): Promise<number> {
  return serial(async () => {
    toolCalls = (await readTotal($)) + 1
    await writeTotal($, toolCalls)
    return toolCalls
  })
}

function loadCount($: EngineInterface): Promise<number> {
  return serial(async () => (toolCalls = await readTotal($)))
}

// ── Prompt Master: rewrite the draft into a clearer prompt ──────────────────
//
// `/enhance <draft>` sends the draft to Haiku with the instructions below and
// puts the result in the prompt box. The original stays saved until the next
// prompt is sent: "↶ Undo" at the left of the gauge row, or `/enhance undo`,
// puts it back.

const ENHANCE_MODEL = 'haiku'
const SPINNER = ['◐', '◓', '◑', '◒']

const ENHANCE_SYSTEM = `You rewrite rough prompts for Claude Code, an AI coding agent, into clear, structured, high-precision prompts.

Rules:
- Keep the person's intent, scope and every concrete detail they gave (file names, paths, commands, numbers, names, error text, code). Never invent requirements, files or facts they did not give.
- Lead with the goal in one sentence. Then, only where the draft gives or clearly implies them: context, specific requirements as a short list, constraints (what not to change), and what "done" looks like.
- Resolve vague words ("it", "this", "fix it") only when the draft itself makes the meaning clear; otherwise keep the person's wording.
- Keep it as short as the task allows: a one-line draft for a small task stays a few lines. No headings for small tasks.
- Write in the person's voice, addressed to the agent ("Add...", "Find..."), in the draft's language.
- Output only the rewritten prompt: no preamble, no quotes, no explanation, no code fences around the whole thing.`

const enhanceBusy = atom({ plugin: 'usage-gauges', key: 'enhanceBusy' } as const, false)
const enhanceUndo = atom({ plugin: 'usage-gauges', key: 'enhanceUndo' } as const, null)
const spinFrame = atom({ plugin: 'usage-gauges', key: 'spinFrame' } as const, 0)

/** Rewrites `draft`; resolves the new prompt, or throws with a short reason. */
export async function rewritePrompt($: EngineInterface, draft: string): Promise<string> {
  const r = await $.model.complete({
    model: ENHANCE_MODEL,
    system: ENHANCE_SYSTEM,
    prompt: `Rewrite this draft prompt:\n\n<draft>\n${draft}\n</draft>`,
    maxTokens: 2048,
    timeoutMs: 60_000,
  })
  if (!r.isAnswered) throw new Error(r.reason)
  const text = r.text.trim().replace(/^<draft>\s*|\s*<\/draft>$/g, '').trim()
  if (!text) throw new Error('empty-reply')
  return text
}

/** Enhances `draft` (the prompt box's text when not given) and fills the box. */
async function enhance($: EngineInterface, given?: string): Promise<string | undefined> {
  if (await read($, enhanceBusy)) return undefined
  const draft = (given ?? (await $.prompt.read()).text).trim()
  if (!draft) {
    $.ui.toast('Type your draft after /enhance')
    return undefined
  }
  await update($, enhanceBusy, () => true)
  const spin = $.clock.every(150, () => update($, spinFrame, n => ((n ?? 0) + 1) % SPINNER.length))
  try {
    const better = await rewritePrompt($, draft)
    await update($, enhanceUndo, () => draft)
    await $.prompt.fill({ text: better, mode: 'replace' })
    return better
  } catch (err) {
    $.ui.toast(`Couldn't enhance the prompt (${err instanceof Error ? err.message : 'error'}). Your draft is unchanged.`)
    return undefined
  } finally {
    spin.cancel()
    await update($, enhanceBusy, () => false)
  }
}

async function undoEnhance($: EngineInterface): Promise<void> {
  const original = await read($, enhanceUndo)
  if (original == null) return
  await $.prompt.fill({ text: original, mode: 'replace' })
  await update($, enhanceUndo, () => null)
}

/**
 * What the row shows for /enhance, and only while there's something to show:
 * a dim spinner while a rewrite runs, then a borderless "↶ Undo" until the
 * next prompt is sent. Nothing at all the rest of the time.
 */
async function enhanceStatus($: EngineInterface, Text: any, Button: any) {
  if (await read($, enhanceBusy)) {
    const frame = (await read($, spinFrame)) ?? 0
    return (
      <Text key="enhancing" dimColor>
        {`${SPINNER[frame % SPINNER.length]} Enhancing…`}
      </Text>
    )
  }
  if ((await read($, enhanceUndo)) != null) {
    return <Button key="undo" plain dimColor label="↶ Undo" onPress={() => undoEnhance($)} />
  }
  return null
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

/** The cache lifetime the login implies; set at session start. */
let loginTtlMs: number | undefined

export const register: Register = on => {
  on('tool.call', async ($, e, next) => {
    // A failed count never blocks the tool itself.
    const total = await addToolCall($).catch(() => toolCalls)
    $.ui.status(`tools: ${total}`)
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
    // How this session is signed in sets the cache lifetime until a reply shows it.
    loginTtlMs = await $.session
      .identity()
      .then(id => loginTtl(id.kind))
      .catch(() => FIVE_MIN)
    // Redraw every 20 seconds so the countdowns and warm/cold stay current.
    $.clock.every(20_000, () => update($, usage, prev => (prev ? { ...prev, at: Date.now() } : prev)))
    await $.command
      .register({ name: 'enhance', description: 'Rewrite a rough prompt into a clear, structured one: /enhance <your draft>' })
      .catch(() => undefined)
    return result
  })

  // /enhance <draft>: rewrite the text after the command and put it in the box.
  // /enhance undo: put the draft from before the last rewrite back.
  on('command.run', { command: 'enhance' }, async ($, e) => {
    const draft = e.args.trim()
    if (draft.toLowerCase() === 'undo') {
      if ((await read($, enhanceUndo)) == null) return { text: 'Nothing to undo.' }
      await undoEnhance($)
      return { text: 'Your original draft is back in the box.' }
    }
    if (!draft) return { text: 'Type your draft after the command, like /enhance add a dark mode toggle.' }
    const better = await enhance($, draft)
    return { text: better ? 'Enhanced prompt is in the box: edit it or press Enter to send. /enhance undo puts your draft back.' : 'Enhance failed; nothing changed.' }
  })

  // Once a prompt is sent, there's no draft left to undo back to.
  on('prompt.submit', async ($, e, next) => {
    if (e.origin?.kind !== 'plugin') await update($, enhanceUndo, () => null).catch(() => undefined)
    return next(e)
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
      await update($, cache, prev => cacheReading(reply, Date.now(), prev?.ttlMs ?? loginTtlMs) ?? prev).catch(() => undefined)
    }
    return result
  })

  // The gauge row above the prompt.
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
      limit('ctx', 'Context', u.ctx, false),
      limit('five', '5-Hour', u.five, true),
      limit('seven', 'Weekly', u.seven, true),
      {
        key: 'cache',
        label: 'Cache',
        percent: c ? c.percent : null,
        color: c ? cacheColor(c.percent, warm) : TRACK,
        suffix: c ? cacheSuffix(c, now) : '',
      },
    ]

    const ui = $.ui.resolve(e)
    const { Box, Text, Button } = ui

    // Graphical surfaces (desktop, editor, phone) get drawn rings; the terminal
    // keeps the text wheels.
    if ('Svg' in ui) {
      const { Svg } = ui
      const status = await enhanceStatus($, Text, Button)
      // Four gauges spread edge to edge, each kept whole: short labels and
      // the dim extras one size smaller leave room for every countdown.
      // Right after /enhance, its spinner or Undo leads the row for a while.
      return (
        <Box width="100%" flexDirection="row" flexWrap="nowrap" alignItems="center" justifyContent="space-between" columnGap="md">
          {status}
          {items.map(it => (
            <Box key={it.key} flexDirection="row" flexShrink={0} alignItems="center" gap="xs">
              <Svg
                source={ring(it.percent, it.color)}
                alt={it.percent === null ? `${it.label} unknown` : `${it.label} ${it.percent}%`}
                width={RING_PX}
                height={RING_PX}
              />
              {it.percent === null ? (
                <Text dimColor>{`${it.label} --%`}</Text>
              ) : (
                <Text>
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

    const termStatus = await enhanceStatus($, Text, Button)
    return (
      <Box flexDirection="row" columnGap="md">
        {termStatus}
        <Text>{cells}</Text>
      </Box>
    )
  })
}
