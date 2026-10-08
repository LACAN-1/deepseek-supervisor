# deepseek-supervisor

**"You should know" for Claude Code running a third-party model such as DeepSeek.**

Every few steps, a side pass reviews the session's work so far. When it notices something the model should act on now, it tells the model directly and shows you the same items above the prompt.

[中文说明](README.zh-CN.md)

## Why

Claude Code ships a side agent, "You should know", that watches Claude at work and surfaces what it notices. It is hidden whenever `ANTHROPIC_BASE_URL` points away from Anthropic: on Claude Code 2.1.290 that one variable alone switches it off. So if you run Claude Code against DeepSeek or any other Anthropic-compatible endpoint, nothing watches the work.

deepseek-supervisor fills that gap. It was built for DeepSeek, but nothing in it is DeepSeek-specific: it works with any Anthropic-compatible endpoint.

## What it does

After every 6 finished steps of the main loop (the same interval as "You should know"; subagents' steps are not counted), it forks the session for one review pass. The pass looks only for these:

- **A reading picked silently**: your request allows two readings that change the result, and the model is building on one without asking.
- **A problem noticed and not raised**: it saw something wrong and moved on without telling you.
- **A claim with nothing behind it**: "verified", "works" or "looks right" with no command, number or file behind it, or an image described but never opened.
- **"Can't do X" without trying X.**
- **Scope that grew** without being said.
- **Guessing**: several changes with no effect and no measurement between them.
- **Files changed after it said it was done**, without saying which.

It defaults to saying nothing. It reports at most 2 items per pass and skips anything it has already raised. Its findings go two places:

- **To the model**, as a note it reads at its next step. The note says it is a reviewer's observation, not an instruction from you, and that it authorizes nothing beyond what you asked for. This matters because the reviewer reads a transcript that may contain text from the web.
- **To you**, in a band above the prompt, with a **Hide** button. The band clears after two prompts from you, as "You should know" cards do.

## Example

A real run against DeepSeek. The request was 「会员打 5 折扣」. In Chinese that can mean "50% off" or, read loosely, "5% off". The file already implemented it. Six steps in, the model received this note:

```
[deepseek-supervisor] A separate pass over your work so far (not the user) found 2 item(s) to handle now:
1. 会员折扣已经在 shop.py 里实现了，说完再动手改，别把已有代码当没写。
   evidence: shop.py 第 1、7 行 `MEMBER_DISCOUNT = 0.5` …；test_shop.py 已有 `test_member_gets_half_off`。
2. 确认「打 5 折扣」是打 5 折（×0.5）还是 5% off（×0.95），这两种读法结果差一倍。
   evidence: 请求原文「会员打 5 折扣」；代码现在按 ×0.5 实现，但没跟用户对过。
```

Item 1 says the discount already exists in `shop.py`, so don't rewrite it. Item 2 asks it to confirm which reading the user meant. The model then left the existing code alone, ran the tests, and ended by asking which reading was meant.

## Requirements

- Claude Code with plugin function hooks (`claude plugin validate` / `claude plugin test` exist). Developed and tested on **2.1.290**.

## Install

From your shell:

```bash
claude plugin marketplace add LACAN-1/deepseek-supervisor
claude plugin install deepseek-supervisor@deepseek-supervisor
```

Update later with `claude plugin update deepseek-supervisor@deepseek-supervisor`.

Or, for one session, from a clone: `claude --plugin-dir /path/to/deepseek-supervisor`. Where you cannot pass a flag (for example a session another app starts), list the folder in `CLAUDE_CODE_PLUGIN_DIRS`.

**It turns itself on only where it is needed.** It watches when `ANTHROPIC_BASE_URL` points at a host that is not Anthropic's. On Anthropic's own endpoint it stays idle, because the built-in "You should know" already runs there. On Bedrock or Vertex, where that variable is unset, run `/deepseek-supervisor on` if you want it.

## Use

| | |
|---|---|
| Status line | `deepseek-supervisor watching · N noted · last: …`, or why it is idle |
| `/deepseek-supervisor on` / `off` | Force it on or off, whatever the endpoint. Off also clears the band. |
| `/deepseek-supervisor auto` | Back to the default: on only away from Anthropic's endpoint. |
| `/deepseek-supervisor log` | The last 10 passes, with findings and token usage. |

The plugin's store is shared by every session on the machine. It keeps the on/off/auto setting, so `off` applies to all of them, and the last 50 passes, including the evidence each finding quotes from the conversation. It is never sent anywhere.

## Cost

Each pass forks the whole session, so it re-reads the full context, mostly as cache hits. On a large session that is hundreds of thousands of cached tokens per pass. On a model with cheap cache reads, such as DeepSeek, that is small. On an expensive model, count it before you turn it on.

## Known limits

- **It is not quiet.** In the author's use it seldom returned an empty list, even with "default to an empty list" in its prompt. Most items were concrete and evidenced, but expect a note every few minutes during busy work.
- **Its memory is short.** It remembers only its last 12 items, so the same point is sometimes raised twice.
- **Its state does not survive a reload.** The step count and the "already raised" list live in memory, so a reload starts them over.

## Development

```bash
claude plugin validate .
claude plugin test .
```

Claude Code writes type declarations into `.claude-plugin/types/` the first time it loads the plugin; after that, `tsc -p .` type-checks it.

| File | Role |
|---|---|
| `hooks/register.ts` | The step counter, the review pass, the note, the on/off/auto switch, the command |
| `hooks/prompt.ts` | The review prompt and the parsing of its answer |
| `hooks/band.tsx` | The band above the prompt |
| `types/index.d.ts` | The finding shape and the plugin's state contract |
| `tests/watch.test.ts` | 8 tests against Claude Code's plugin test kit |

## License

MIT
