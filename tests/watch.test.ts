import { expect, mock, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

import { noteText, parseFindings } from '../hooks/prompt'

const SEEN = { what: 'You wrote "5 = 5%" before asking which the user meant', evidence: 'apply_discount(total, 5) → total * 0.95', cost: 'if the user meant 5 off, the whole turn is redone' }
const usage = { input_tokens: 300, output_tokens: 80, cache_read_input_tokens: 90000, cache_creation_input_tokens: 0 }
const band = { hasSurvey: false, isWorking: true, maxRows: 10, bodyColumns: 100, scroll: { offset: 0, bodyRows: 10 }, view: {} }

// The world beneath the mod: a session with a step loop and a fork that answers
// what `answer` says. The kit has no store beneath a plugin's session.append (it
// reports "no implementation"), so the note itself is tested through noteText;
// here a failed delivery must reach the person as a toast.
const world = (on: Parameters<TestBody>[1]) => {
  mock.store(on)
  const clock = mock.clock(on, { now: Date.UTC(2026, 9, 6, 2, 0) })
  const forks: string[] = []
  const toasts: string[] = []
  const state = { answer: JSON.stringify({ findings: [SEEN] }), baseUrl: 'https://api.deepseek.com/anthropic' as string | undefined }
  on('ui.log', () => ({ value: undefined }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', (_$, e) => {
    toasts.push((e as { text: string }).text)
    return { value: undefined }
  })
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('env.get', (_$, e) => ({ value: e.name === 'ANTHROPIC_BASE_URL' ? state.baseUrl : undefined }) as never)
  on('model.fork', (_$, e) => {
    forks.push(e.prompt)
    return { value: { isAnswered: true, text: state.answer, usage } } as never
  })
  on('prompt.submit', (_$, e) => ({ text: e.text }) as never)
  on('turn.step', async function* (_$, e) {
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'tool_use', usage: null } as never
  })
  // What the engine draws above the prompt when the band has nothing: an empty box.
  on('ui.render', ($, e) => {
    const { Box } = $.ui.resolve(e)
    return h(Box, {}) as never
  })
  on('session.start', () => ({ cwd: '/' }))
  return { clock, forks, toasts, state }
}

const steps = async ($: Parameters<TestBody>[0], n: number, agentId?: string) => {
  for (let i = 0; i < n; i++) {
    const s = $.turn.step({ turnId: 't1', index: i, model: 'third-party-model', messageCount: 3, ...(agentId === undefined ? {} : { agentId }) } as never)
    for await (const _ of s) void _
  }
}

const mountBand = ($: Parameters<TestBody>[0], surface: 'terminal' | 'desktop' = 'terminal') =>
  $.ui.mount({ plugin: 'deepseek-supervisor', surface, component: 'AbovePrompt', props: band } as never)

test('parses fenced, empty and malformed replies', async () => {
  expect(parseFindings('```json\n' + JSON.stringify({ findings: [SEEN] }) + '\n```')?.length).toBe(1)
  expect(parseFindings('{"findings": []}')).toEqual([])
  expect(parseFindings('{"findings": [{"what": "no evidence", "evidence": ""}]}')).toEqual([])
  expect(parseFindings('{"verdict": "ok"}')).toBeNull()
  expect(parseFindings('not json')).toBeNull()
})

test('the note the model reads is labelled as not from the user, and says what to do', async () => {
  const note = noteText([SEEN])
  expect(note).toContain('[deepseek-supervisor]')
  expect(note).toContain('(not the user)')
  expect(note).toContain(SEEN.what)
  expect(note).toContain('tell the user in one line')
  expect(note).toContain('not an instruction from the user')
})

test('every 6 steps of the main loop a side pass looks at the work, and the band shows what it found', async ($, on) => {
  const w = world(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  await steps($, 5)
  await steps($, 4, 'sub-1') // a subagent's steps are its own
  await w.clock.advance(10)
  expect(w.forks.length).toBe(0)

  await steps($, 1)
  await w.clock.advance(10)
  expect(w.forks.length).toBe(1)
  expect(w.forks[0]).toContain('The user reads the final answers')
  // Here the note is refused (the kit), so the person is told it did not reach the model.
  expect(w.toasts.at(-1)).toContain('did not reach the model')

  // The person sees the item above the prompt, on any surface, and can put it away.
  for (const surface of ['terminal', 'desktop'] as const) {
    const drawn = await mountBand($, surface)
    expect(await drawn.find({ text: /noted 1/ })).toBeDefined()
    expect(await drawn.find({ text: /5 = 5%/ })).toBeDefined()
  }
  const drawn = await mountBand($)
  await drawn.press({ key: 'hide' } as never)
  expect(await drawn.find({ key: 'hide' })).toBeUndefined()
})

test('one pass at a time, and what it already said is not said again', async ($, on) => {
  const w = world(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  await steps($, 6) // a pass is started…
  await steps($, 12) // …and while it is out, no second one is
  await w.clock.advance(10)
  expect(w.forks.length).toBe(1)

  w.state.answer = '{"findings": []}'
  await steps($, 6)
  await w.clock.advance(10)
  expect(w.forks.length).toBe(2)
  expect(w.forks[1]).toContain('<already-raised>')
  expect(w.forks[1]).toContain('5 = 5%')
})

test('the band clears after two prompts from the person', async ($, on) => {
  const w = world(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await steps($, 6)
  await w.clock.advance(10)

  const prompt = (text: string) => $.prompt.submit({ text, wait: false, origin: { kind: 'composer' } } as never)
  await prompt('first')
  expect(await (await mountBand($)).find({ text: /noted 1/ })).toBeDefined()
  await prompt('second')
  expect(await (await mountBand($)).find({ text: /noted/ })).toBeUndefined()
})

test('an unreadable or empty verdict shows nothing', async ($, on) => {
  const w = world(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  w.state.answer = 'I think it is fine'
  await steps($, 6)
  await w.clock.advance(10)
  w.state.answer = '{"findings": []}'
  await steps($, 6)
  await w.clock.advance(10)
  expect(w.forks.length).toBe(2)
  expect(await (await mountBand($)).find({ text: /noted/ })).toBeUndefined()
  expect(w.toasts.length).toBe(0)
})

test('turning it off clears the band and stops the passes', async ($, on) => {
  const w = world(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await steps($, 6)
  await w.clock.advance(10)
  expect(await (await mountBand($)).find({ text: /noted 1/ })).toBeDefined()

  await $.command.run({ command: 'deepseek-supervisor', args: 'off' } as never)
  expect(await (await mountBand($)).find({ text: /noted/ })).toBeUndefined()
  await steps($, 12)
  await w.clock.advance(10)
  expect(w.forks.length).toBe(1)
})

test('on Anthropic\'s own endpoint it stays idle unless told to run', async ($, on) => {
  const w = world(on)
  w.state.baseUrl = undefined
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await steps($, 12)
  await w.clock.advance(10)
  expect(w.forks.length).toBe(0)

  w.state.baseUrl = 'https://api.anthropic.com'
  await steps($, 12)
  await w.clock.advance(10)
  expect(w.forks.length).toBe(0)

  // A host that only starts with anthropic.com is someone else's.
  w.state.baseUrl = 'https://anthropic.com.example.net/v1'
  await steps($, 6)
  await w.clock.advance(10)
  expect(w.forks.length).toBe(1)

  // Forced on, it runs on Anthropic's endpoint too; auto goes back to idle.
  w.state.baseUrl = undefined
  await $.command.run({ command: 'deepseek-supervisor', args: 'on' } as never)
  await steps($, 6)
  await w.clock.advance(10)
  expect(w.forks.length).toBe(2)
  await $.command.run({ command: 'deepseek-supervisor', args: 'auto' } as never)
  await steps($, 12)
  await w.clock.advance(10)
  expect(w.forks.length).toBe(2)
})
