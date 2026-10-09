import { expect, mock, test } from 'claude-code/testing'

const usage = { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
const FALSE = JSON.stringify({ checked: [{ claim: 1, command: 'python3 -m unittest', saw: 'FAILED', verdict: 'false', what: 'fails', recheck: 'python3 -m unittest' }], items: [] })
const res = (exitCode: number, stdout = '') => ({ value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }) as never

// A check during the work and the check of a turn's answer can be out at the same
// time; both write the same items, and neither may number or raise one twice.
test('two checks out at once raise one claim once', async ($, on) => {
  mock.store(on)
  const clock = mock.clock(on, { now: 0 })
  let release: (() => void) | undefined
  let calls = 0
  on('session.messages', () => ({ value: [{ role: 'assistant', text: 'All tests pass.', toolUses: [] }] }) as never)
  on('session.cwd', () => ({ value: '/p' }) as never)
  on('session.append', (_$, e, next) => next(e))
  on('env.get', () => ({ value: 'https://api.deepseek.com' }) as never)
  on('ui.log', () => ({ value: undefined }))
  on('ui.status', () => ({ value: undefined }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('model.complete', async () => {
    calls += 1
    if (calls === 1) await new Promise<void>(r => { release = r })
    return { value: { isAnswered: true, text: FALSE, usage } } as never
  })
  on('process.run', (_$, e) => (e.argv[0] === 'mktemp' ? res(0, '/tmp/t/dss-verify.A1\n') : res(1, 'FAILED')))
  on('prompt.submit', (_$, e) => ({ text: e.text }) as never)
  on('turn.step', async function* (_$, e) {
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'tool_use', usage: null } as never
  })
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  on('session.start', () => ({ cwd: '/p' }))
  await $.session.start({ cwd: '/p', surface: 'terminal', isInteractive: true })
  for (let i = 0; i < 3; i++) for await (const _ of $.turn.step({ turnId: 't', index: i, model: 'm', messageCount: 1 } as never)) void _
  await clock.advance(10)
  await $.turn.complete({ answer: 'All tests pass.', durationMs: 1, isAborted: false, turnId: 't', reason: 'answer' } as never)
  await clock.advance(10)
  release?.()
  await clock.advance(10)
  await clock.advance(10)
  const t = (await $.command.run({ command: 'receipts', args: 'issues' } as never)) as { text: string }
  expect(t.text.match(/#\d+ \[/g)?.length).toBe(1)
})
