import { expect, test } from 'claude-code/testing'

import { cacheSuffix, loginTtl } from '../hooks/register'

test('a Claude subscription keeps the cache an hour, an API key five minutes', async () => {
  expect(loginTtl('claude.ai')).toBe(3_600_000)
  expect(loginTtl('oauth-token')).toBe(3_600_000)
  expect(loginTtl('api-key')).toBe(300_000)
  expect(loginTtl('console')).toBe(300_000)
  expect(loginTtl(undefined)).toBe(300_000)
})

test('the countdown rounds up, never shows 0m, then turns cold', async () => {
  const c = { percent: 67, lastAt: 0, ttlMs: 3_600_000 }
  expect(cacheSuffix(c, 6 * 60_000)).toBe(' (warm · 54m)')
  expect(cacheSuffix(c, 3_600_000 - 1_000)).toBe(' (warm · 1m)')
  expect(cacheSuffix(c, 3_600_000)).toBe(' (cold)')
})

const BAND = {
  plugin: 'usage-gauges',
  component: 'AbovePrompt',
  requestId: 'band',
  props: { hasSurvey: false, bodyColumns: 140 },
} as const

const HINT = {
  plugin: 'usage-gauges',
  component: 'PromptHint',
  requestId: 'hint',
  props: { isDraft: true, isWorking: false, hint: '' },
} as const

// Stands for the app beneath the mod: its own hint line.
function appHint(on: any) {
  on('ui.render', ($: any, e: any) => {
    const { Text } = $.ui.resolve(e)
    return <Text>? for shortcuts</Text>
  })
}

function engine(on: any, box: { text: string }, model: { calls: unknown[]; reply: string | null }) {
  on('prompt.read', () => ({ value: { text: box.text, cursor: box.text.length } }))
  on('prompt.fill', (_: unknown, e: { text: string }) => {
    box.text = e.text
    return { isFilled: true, text: e.text, cursor: e.text.length }
  })
  on('model.complete', (_: unknown, e: unknown) => {
    model.calls.push(e)
    return {
      value:
        model.reply === null
          ? { isAnswered: false, reason: 'api-error', status: 529, error: { type: 'overloaded_error', message: 'busy' }, usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } }
          : { isAnswered: true, text: model.reply, usage: { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } },
    }
  })
  on('clock.every', () => ({ value: { cancel: () => undefined } }))
  on('ui.toast', () => ({ value: undefined }))
  appHint(on)
}

const run = ($: any, args: string) =>
  $.command.run({ command: 'enhance', args, origin: { kind: 'user' }, presentation: 'inline' } as never) as Promise<{ text?: string }>

test('/enhance rewrites the draft with Haiku, and Undo brings the original back', async ($, on) => {
  const box = { text: '' }
  const model = { calls: [] as any[], reply: 'Fix the login bug that breaks sign-in on Safari.\n\n- Find the cause\n- Keep other browsers working' }
  engine(on, box, model)

  const out = await run($, 'fix the login bug its broken on safari')
  expect(out.text).toContain('Enhanced prompt is in the box')
  expect(model.calls[0].model).toBe('haiku')
  expect(model.calls[0].prompt).toContain('fix the login bug its broken on safari')
  expect(box.text).toBe(model.reply)

  // A borderless Undo leads the gauge row until the next prompt is sent.
  const band = await $.ui.mount({ ...BAND, surface: 'desktop' } as never)
  expect(await band.find({ key: 'undo' })).toBeTruthy()
  await band.press({ key: 'undo' })
  expect(box.text).toBe('fix the login bug its broken on safari')
  expect(await band.find({ key: 'undo' })).toBeFalsy()
  await band.unmount()
})

test('/enhance undo works too, and says so when there is nothing to undo', async ($, on) => {
  const box = { text: '' }
  const model = { calls: [] as any[], reply: 'Add unit tests for the parser.' }
  engine(on, box, model)

  expect((await run($, 'undo')).text).toBe('Nothing to undo.')
  await run($, 'add tests for parser')
  expect(box.text).toBe('Add unit tests for the parser.')
  expect((await run($, 'undo')).text).toContain('original draft is back')
  expect(box.text).toBe('add tests for parser')
})

test('a failed rewrite leaves the draft alone', async ($, on) => {
  const box = { text: 'add tests' }
  const model = { calls: [] as any[], reply: null }
  engine(on, box, model)

  expect((await run($, 'add tests')).text).toBe('Enhance failed; nothing changed.')
  expect(box.text).toBe('add tests')
  const band = await $.ui.mount({ ...BAND, surface: 'desktop' } as never)
  expect(await band.find({ key: 'undo' })).toBeFalsy()
  await band.unmount()
})

test('no ✨ button anywhere: the gauge row holds only the gauges', async ($, on) => {
  appHint(on)
  for (const surface of ['desktop', 'terminal'] as const) {
    const band = await $.ui.mount({ ...BAND, surface } as never)
    expect(await band.findAll({ type: 'Button' })).toHaveLength(0)
    expect(await band.find({ type: 'Text', text: /5-Hour --%/ })).toBeTruthy()
    await band.unmount()
  }
})
