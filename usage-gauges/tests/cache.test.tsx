import { expect, test } from 'claude-code/testing'

import { cacheReading, isWarm } from '../hooks/register'

const usage = (read: number, input: number, write: number, extra: Record<string, number> = {}) => ({
  input_tokens: input,
  output_tokens: 100,
  cache_read_input_tokens: read,
  cache_creation_input_tokens: write,
  model: 'claude-opus-5-5',
  ...extra,
})

test('hit rate is cache_read over all input tokens', async () => {
  const c = cacheReading(usage(9600, 100, 300), 1000, undefined)
  expect(c?.percent).toBe(96)
  expect(cacheReading(usage(0, 0, 0), 1000, undefined)).toBe(null)
})

test('lifetime follows the writes, else the last one seen, else 5 minutes', async () => {
  expect(cacheReading(usage(10, 1, 5, { ephemeral_1h_input_tokens: 5, ephemeral_5m_input_tokens: 0 }), 0, undefined)?.ttlMs).toBe(3_600_000)
  expect(cacheReading(usage(10, 1, 0), 0, 3_600_000)?.ttlMs).toBe(3_600_000)
  expect(cacheReading(usage(10, 1, 0), 0, undefined)?.ttlMs).toBe(300_000)
})

test('warm until the lifetime passes', async () => {
  const c = { percent: 96, lastAt: 0, ttlMs: 300_000 }
  expect(isWarm(c, 299_999)).toBe(true)
  expect(isWarm(c, 300_000)).toBe(false)
})

const BAND = {
  plugin: 'usage-gauges',
  component: 'AbovePrompt',
  requestId: 'band',
  props: { hasSurvey: false, bodyColumns: 120 },
} as const

test('the row shows the cache gauge, warm and cold, on every surface', async ($, on) => {
  const now = Date.now()
  let cache: unknown = { percent: 96, lastAt: now, ttlMs: 300_000 }
  on('state.get', (_, e) => {
    const key = (e as { key: string }).key
    if (key === 'cache') return { value: { value: cache, version: 1 } }
    return { value: { value: null, version: 0 } }
  })

  for (const surface of ['desktop', 'terminal'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface } as never)
    expect((await ui.find({ type: 'Text', text: /Prompt Cache 96% \(warm\)/ }))?.text).toContain('Prompt Cache 96% (warm)')
    expect(await ui.find({ type: 'Text', text: /Cont\. Window --%/ })).toBeTruthy()
    await ui.unmount()
  }

  cache = { percent: 96, lastAt: now - 600_000, ttlMs: 300_000 }
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' } as never)
  expect((await ui.find({ type: 'Text', text: /Prompt Cache 96% \(cold\)/ }))?.text).toContain('Prompt Cache 96% (cold)')
  await ui.unmount()

  cache = null
  const empty = await $.ui.mount({ ...BAND, surface: 'desktop' } as never)
  expect(await empty.find({ type: 'Text', text: /Prompt Cache --%/ })).toBeTruthy()
  await empty.unmount()
})
