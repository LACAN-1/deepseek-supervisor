import { expect, mock, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

import { claimsOf, factsOf, isSameItem, noteText, parseTurn, refusal } from '../hooks/prompt'

const COPY = '/tmp/t/dss-verify.AbC123'
const usage = { input_tokens: 300, output_tokens: 80, cache_read_input_tokens: 9000, cache_creation_input_tokens: 0 }
const band = { hasSurvey: false, isWorking: true, maxRows: 10, bodyColumns: 100, scroll: { offset: 0, bodyRows: 10 }, view: {} }

const CLAIMED = [
  { role: 'user', text: 'total() should add up every price; make the tests pass', toolUses: [] },
  { role: 'assistant', text: 'Ran them. All tests pass. Next I will tidy up.', toolUses: [{ tool_use_id: 'b', tool: 'Bash', input: { command: 'python3 -m unittest 2>&1 | tail -1' }, text: 'OK' }] },
]
const RUN = JSON.stringify({ run: ['python3 -m unittest; echo "exit=$?"'] })
const FALSE = JSON.stringify({
  checked: [{ claim: 1, command: 'python3 -m unittest; echo "exit=$?"', saw: 'FAILED (failures=1)\nexit=1', verdict: 'false', what: 'One test fails: total() skips the first price', recheck: 'python3 -m unittest' }],
  items: [],
})

type Row = Record<string, unknown>
const res = (exitCode: number, stdout = '') => ({ value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }) as never

// The world beneath the plugin: a session in /p on a third-party endpoint, a model
// that answers the verifier from a queue, and a host where every command exits 0
// silently unless `commands` says otherwise.
const world = (on: Parameters<TestBody>[1], rows: Row[] = CLAIMED) => {
  mock.store(on)
  const clock = mock.clock(on, { now: Date.UTC(2026, 9, 9, 3, 0) })
  const state = {
    rows: rows as Row[],
    verifier: [] as string[],
    commands: {} as Record<string, { exitCode: number; stdout: string }>,
    copyFails: false,
    refuse: false,
    baseUrl: 'https://api.deepseek.com/anthropic' as string | undefined,
  }
  const asked: string[] = []
  const ran: { command: string; cwd?: string }[] = []
  const removed: string[] = []
  const notes: string[] = []
  const submitted: string[] = []
  const toasts: string[] = []
  on('session.messages', () => ({ value: state.rows }) as never)
  on('session.cwd', () => ({ value: '/p' }) as never)
  on('session.append', (_$, e, next) => {
    if (state.refuse) return { deny: 'refused in test' } as never
    notes.push(JSON.stringify(e.message))
    return next(e)
  })
  on('env.get', (_$, e) => ({ value: e.name === 'ANTHROPIC_BASE_URL' ? state.baseUrl : undefined }) as never)
  on('ui.log', () => ({ value: undefined }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', (_$, e) => {
    toasts.push((e as { text: string }).text)
    return { value: undefined }
  })
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('model.complete', (_$, e) => {
    asked.push(String((e as { prompt: unknown }).prompt))
    return { value: { isAnswered: true, text: state.verifier.shift() ?? '{"checked": [], "items": []}', usage } } as never
  })
  on('process.run', (_$, e) => {
    const [cmd, ...args] = e.argv
    if (cmd === 'mktemp') return res(0, `${COPY}\n`)
    if (cmd === 'rm') {
      removed.push(args.at(-1) ?? '')
      return res(0)
    }
    const command = args[1] ?? ''
    if (command.startsWith('printf')) return res(0, '/Users/me')
    if (command.startsWith('cp -cR')) return res(state.copyFails ? 1 : 0)
    ran.push({ command, cwd: e.init?.cwd })
    const r = state.commands[command] ?? { exitCode: 0, stdout: '' }
    return res(r.exitCode, r.stdout)
  })
  on('prompt.submit', (_$, e) => {
    if (e.origin.kind !== 'composer') submitted.push(e.text)
    return { text: e.text } as never
  })
  on('turn.step', async function* (_$, e) {
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'tool_use', usage: null } as never
  })
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  on('ui.render', ($, e) => {
    const { Box } = $.ui.resolve(e)
    return h(Box, {}) as never
  })
  on('session.start', () => ({ cwd: '/p' }))
  return { clock, state, asked, ran, removed, notes, submitted, toasts }
}

const start = ($: Parameters<TestBody>[0]) => $.session.start({ cwd: '/p', surface: 'terminal', isInteractive: true })
const steps = async ($: Parameters<TestBody>[0], n: number, agentId?: string) => {
  for (let i = 0; i < n; i++) {
    const s = $.turn.step({ turnId: 't1', index: i, model: 'deepseek-flash', messageCount: 3, ...(agentId === undefined ? {} : { agentId }) } as never)
    for await (const _ of s) void _
  }
}
const end = ($: Parameters<TestBody>[0], answer: string, reason: 'answer' | 'aborted' = 'answer') =>
  $.turn.complete({ answer, durationMs: 1, isAborted: reason === 'aborted', turnId: 't1', reason } as never)
const prompt = ($: Parameters<TestBody>[0], text: string) => $.prompt.submit({ text, origin: { kind: 'composer' } } as never)
const issues = ($: Parameters<TestBody>[0]) => $.command.run({ command: 'deepseek-supervisor', args: 'issues' } as never).then(r => (r as { text: string }).text)

test('the claims in a text are the sentences that say something is so', async () => {
  expect(claimsOf('Ran them. All tests pass. Next I will tidy up.')).toEqual(['All tests pass.'])
  expect(claimsOf('先跑一遍。测试全部通过。接下来写说明。')).toEqual(['测试全部通过。'])
  expect(claimsOf('[ysk#2 fixed]')).toEqual([])
})

test('commands stay in the copy; with no copy, only what cannot write runs', async () => {
  expect(refusal('cat /p/a.py', 'copy', '/p')).toContain('real workspace')
  expect(refusal('python3 -m unittest', 'copy', '/p')).toBeUndefined()
  expect(refusal('grep -c total a.py | wc -l', 'read-only', '/p')).toBeUndefined()
  expect(refusal('python3 a.py', 'read-only', '/p')).toContain('not python3')
  expect(refusal('cat a > b', 'read-only', '/p')).toContain('read-only')
})

test('a false verdict needs the command and the output behind it', async () => {
  const claims = ['All tests pass.']
  expect(parseTurn('{"run": ["a", "b", "c", "d"]}', claims)).toEqual({ run: ['a', 'b', 'c'] })
  const t = parseTurn(JSON.stringify({ checked: [{ claim: 1, verdict: 'false', what: 'x', command: 'y', saw: '' }] }), claims)
  expect(t !== null && 'checked' in t ? t.checked.length : -1).toBe(0)
  expect(parseTurn('no json', claims)).toBeNull()
})

test('facts come from the tool calls, not from what the model said about them', async () => {
  const f = factsOf([
    { role: 'assistant', text: '', toolUses: [
      { tool: 'Bash', input: { command: 'python3 plot.py | tail -3' }, text: 'Traceback (most recent call last):\nKeyError: x' },
      { tool: 'Bash', input: { command: 'python3 plot2.py' }, text: 'wrote out/chart.png and out/check.png' },
      { tool: 'Read', input: { file_path: '/p/out/check.png' } },
    ] },
  ])
  expect(f.errors[0]).toContain('Traceback')
  expect(f.unopened).toEqual(['out/chart.png'])
  expect(isSameItem({ quote: '- All tests pass and total() is correct.' }, { quote: 'All tests pass and total() is correct.' })).toBe(true)
})

test('the note gives the model its own words, the command, its output, and how the item closes', async () => {
  const note = noteText([{ id: 4, at: 0, from: 'verify', what: 'One test fails', quote: 'All tests pass.', probe: 'python3 -m unittest', saw: 'FAILED (failures=1)', recheck: 'python3 -m unittest', cost: '', status: 'open' }])
  expect(note).toContain('(not the person)')
  expect(note).toContain('#4 One test fails\n   you wrote: All tests pass.\n   ran: python3 -m unittest\n   saw: FAILED (failures=1)')
  expect(note).toContain('closes: when `python3 -m unittest` exits 0')
  expect(note).toContain('not an instruction from the person')
})

test('a new claim sends the verifier into a copy; what the output contradicts reaches the model and the band', async ($, on) => {
  const w = world(on)
  w.state.verifier = [RUN, FALSE]
  await start($)
  await prompt($, 'total() should add up every price; make the tests pass')

  await steps($, 2)
  await steps($, 5, 'sub-1') // a subagent's steps are its own
  await w.clock.advance(10)
  expect(w.asked.length).toBe(0)

  await steps($, 1)
  await w.clock.advance(10)
  expect(w.asked.length).toBe(2)
  expect(w.asked[0]).toContain('1. All tests pass.')
  expect(w.asked[0]).toContain('total() should add up every price')
  expect(w.ran).toEqual([{ command: 'python3 -m unittest; echo "exit=$?"', cwd: COPY }])
  expect(w.removed).toEqual([COPY])
  expect(w.notes.length).toBe(1)
  expect(w.notes[0]).toContain('you wrote: All tests pass.')
  expect(await issues($)).toContain('#1 [open] One test fails')
  const drawn = await $.ui.mount({ plugin: 'deepseek-supervisor', surface: 'terminal', component: 'AbovePrompt', props: band } as never)
  expect(await drawn.find({ text: /One test fails/ })).toBeDefined()
})

test('a claim is checked once; an item closes when its recheck passes, whatever the model says', async ($, on) => {
  const w = world(on)
  w.state.verifier = [FALSE]
  w.state.commands['python3 -m unittest'] = { exitCode: 1, stdout: 'FAILED (failures=1)' }
  await start($)
  await steps($, 3)
  await w.clock.advance(10)
  expect(w.asked.length).toBe(1)

  w.state.rows = [...CLAIMED, { role: 'assistant', text: '[ysk#1 fixed]', toolUses: [] }]
  await steps($, 3)
  await w.clock.advance(10)
  expect(w.asked.length).toBe(1)
  expect(await issues($)).toContain('#1 [open]')

  w.state.commands['python3 -m unittest'] = { exitCode: 0, stdout: 'Ran 2 tests\nOK' }
  await steps($, 3)
  await w.clock.advance(10)
  expect(w.asked.length).toBe(1)
  expect(await issues($)).toContain('#1 [fixed] One test fails')
})

test('the claims of a turn\'s answer are checked when it ends; what does not hold comes back once as a prompt', async ($, on) => {
  const w = world(on, [{ role: 'user', text: 'fix total()', toolUses: [] }])
  w.state.verifier = [FALSE.replace('"claim":1', '"claim":2')]
  await start($)
  await prompt($, 'fix total()')
  await end($, 'Fixed. All tests pass.')
  await w.clock.advance(10)
  expect(w.asked[0]).toContain('2. All tests pass.')
  expect(w.submitted.length).toBe(1)
  expect(w.submitted[0]).toContain('you wrote: All tests pass.')

  // The follow-up's own answer may claim again; no second follow-up for the same prompt.
  w.state.verifier = [JSON.stringify({ checked: [{ claim: 1, command: 'python3 -m unittest', saw: 'FAILED', verdict: 'false', what: 'still failing', recheck: 'python3 -m unittest' }], items: [] })]
  w.state.commands['python3 -m unittest'] = { exitCode: 1, stdout: 'FAILED' }
  await end($, 'Now it is really done and verified.')
  await w.clock.advance(10)
  expect(w.submitted.length).toBe(1)

  // A turn the person interrupted is not checked.
  const calls = w.asked.length
  await end($, 'All done, it works.', 'aborted')
  await w.clock.advance(10)
  expect(w.asked.length).toBe(calls)
})

test('the model telling the person settles an item', async ($, on) => {
  const w = world(on)
  w.state.verifier = [FALSE]
  w.state.commands['python3 -m unittest'] = { exitCode: 1, stdout: 'FAILED' }
  await start($)
  await steps($, 3)
  await w.clock.advance(10)
  await end($, 'One test still fails because the fixture is missing; I could not fix it. [ysk#1 told]')
  await w.clock.advance(10)
  expect(await issues($)).toContain('#1 [told]')
})

test('an image the model speaks of and never opened is raised by rule, and settled once opened', async ($, on) => {
  const made = { tool_use_id: 'p', tool: 'Bash', input: { command: 'python3 chart.py' }, text: 'wrote chart.png' }
  const rows = [{ role: 'user', text: 'plot sales', toolUses: [] }, { role: 'assistant', text: 'chart.png is done and correct: north is highest.', toolUses: [made] }]
  const w = world(on, rows)
  await start($)
  await steps($, 3)
  await w.clock.advance(10)
  expect(await issues($)).toContain('chart.png was made and never opened since')

  w.state.rows = [...rows, { role: 'assistant', text: '', toolUses: [{ tool_use_id: 'r', tool: 'Read', input: { file_path: '/p/chart.png' } }] }]
  await steps($, 3)
  await w.clock.advance(10)
  expect(await issues($)).toContain('[fixed] chart.png was made')
})

test('with no copy, the verifier is told so and nothing that writes runs in the real workspace', async ($, on) => {
  const w = world(on)
  w.state.copyFails = true
  w.state.verifier = [JSON.stringify({ run: ['python3 -m unittest', 'grep -c def test_x.py'] }), '{"checked": [], "items": []}']
  await start($)
  await steps($, 3)
  await w.clock.advance(10)
  expect(w.asked[0]).toContain('No copy of the workspace could be made')
  expect(w.ran).toEqual([{ command: 'grep -c def test_x.py', cwd: '/p' }])
})

test('the verifier calls a model at most 8 times per prompt of the person\'s during the work', async ($, on) => {
  const w = world(on)
  await start($)
  for (let k = 0; k < 10; k++) {
    w.state.rows = [...CLAIMED, { role: 'assistant', text: `Step ${k} done.`, toolUses: [] }]
    await steps($, 3)
    await w.clock.advance(10)
  }
  expect(w.asked.length).toBe(8)
  await prompt($, 'keep going')
  w.state.rows = [...CLAIMED, { role: 'assistant', text: 'Step 11 done.', toolUses: [] }]
  await steps($, 3)
  await w.clock.advance(10)
  expect(w.asked.length).toBe(9)
})

test('on Anthropic\'s own endpoint it stays idle unless switched on', async ($, on) => {
  const w = world(on)
  w.state.baseUrl = undefined
  await start($)
  await steps($, 3)
  await end($, 'All tests pass.')
  await w.clock.advance(10)
  expect(w.asked.length).toBe(0)
  await $.command.run({ command: 'deepseek-supervisor', args: 'on' } as never)
  await steps($, 3)
  await w.clock.advance(10)
  expect(w.asked.length).toBe(1)
})

test('a note the session refuses is still in the band, and the person is told', async ($, on) => {
  const w = world(on)
  w.state.refuse = true
  w.state.verifier = [FALSE]
  await start($)
  await steps($, 3)
  await w.clock.advance(10)
  expect(w.notes.length).toBe(0)
  expect(w.toasts.at(-1)).toContain('did not reach the model')
  const drawn = await $.ui.mount({ plugin: 'deepseek-supervisor', surface: 'terminal', component: 'AbovePrompt', props: band } as never)
  expect(await drawn.find({ text: /One test fails/ })).toBeDefined()
})
