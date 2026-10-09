import { expect, mock, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

const band = { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 120, scroll: { offset: 0, bodyRows: 10 }, view: {} }

// The world beneath the mod: a context window whose fill the test sets, and
// another plugin's band drawn below this one.
const world = (on: Parameters<TestBody>[1]) => {
  mock.store(on)
  const fill = { tokens: 36_100 }
  on('session.usage', () => ({ value: { startedAt: 0, rateLimits: [], context: { tokens: fill.tokens, window: 200_000, percent: Math.round(fill.tokens / 2_000) } } }) as never)
  on('session.start', () => ({ cwd: '/' }))
  on('turn.complete', () => ({ text: '' }) as never)
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return h(Text, {}, 'band beneath') as never
  })
  return fill
}

const turn = ($: Parameters<TestBody>[0], agentId?: string) =>
  $.turn.complete({ reason: 'answer', answer: 'ok', durationMs: 1, ...(agentId === undefined ? {} : { agentId }) } as never)

test('the band reads the window, tracks the last turn, and keeps the band beneath it', async ($, on) => {
  const fill = world(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  for (const surface of ['terminal', 'desktop'] as const) {
    const drawn = await $.ui.mount({ plugin: 'deepseek-supervisor', surface, component: 'AbovePrompt', props: band } as never)
    expect(await drawn.find({ text: /Clear/ })).toBeDefined()
    expect(await drawn.find({ text: /band beneath/ })).toBeDefined()
  }

  fill.tokens = 134_400
  await turn($, 'sub-1') // a subagent's turn takes no reading
  const before = await $.ui.mount({ plugin: 'deepseek-supervisor', surface: 'terminal', component: 'AbovePrompt', props: band } as never)
  expect(await before.find({ text: /Clear/ })).toBeDefined()

  await turn($)
  const drawn = await $.ui.mount({ plugin: 'deepseek-supervisor', surface: 'terminal', component: 'AbovePrompt', props: band } as never)
  expect(await drawn.find({ text: /Showers/ })).toBeDefined()
  expect(await drawn.find({ text: /67% of context/ })).toBeDefined()
  expect(await drawn.find({ text: /▲ \+98\.3k last turn/ })).toBeDefined()
  expect(await drawn.find({ text: /band beneath/ })).toBeDefined()

  // Narrow, it keeps the forecast and drops the sparkline.
  const narrow = await $.ui.mount({ plugin: 'deepseek-supervisor', surface: 'terminal', component: 'AbovePrompt', props: { ...band, bodyColumns: 50 } } as never)
  expect(await narrow.find({ text: /Showers/ })).toBeDefined()
  expect(await narrow.find({ text: /last turn/ })).toBeUndefined()
})

test('a survey takes the spot: the band steps aside', async ($, on) => {
  world(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const drawn = await $.ui.mount({ plugin: 'deepseek-supervisor', surface: 'terminal', component: 'AbovePrompt', props: { ...band, hasSurvey: true } } as never)
  expect(await drawn.find({ text: /Clear/ })).toBeUndefined()
  expect(await drawn.find({ text: /band beneath/ })).toBeDefined()
})
