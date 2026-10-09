# deepseek-supervisor

**A check for Claude Code running a third-party model such as DeepSeek: what the model says is done gets run.**

When the model claims something ("all tests pass", "fixed", "the total is 59.75", "the chart is right"), a verifier runs the cheapest command that would show it false, in a throwaway copy of your workspace. If the output contradicts the claim, the model gets the command and its output, and you see the same above the prompt.

[中文说明](README.zh-CN.md)

## Why

Claude Code ships a side agent, "You should know", that watches Claude at work and surfaces what it notices. It is hidden whenever `ANTHROPIC_BASE_URL` points away from Anthropic: on Claude Code 2.1.290 that one variable alone switches it off. So if you run Claude Code against DeepSeek or any other Anthropic-compatible endpoint, nothing watches the work.

This plugin is not a copy of it. "You should know" reads the transcript and writes cards for a person, who answers them. Here the reader is the model, and a model can do what a person reading cards would not: run things. An earlier version of this plugin did what "You should know" does, a review pass over the transcript every 6 steps, and its items were opinions the model could talk its way past with one quoted line. So it now checks claims against what a command prints.

It was built for DeepSeek, but nothing in it is DeepSeek-specific: it works with any Anthropic-compatible endpoint.

## What it does

**During the work.** Every 3 finished steps of the main loop (subagents' steps are not counted), code collects the sentences the model has written since the last check that claim something is so ("passes", "fixed", "verified", "correct", "done", "works", 通过, 修好, 正确, 完成…). If there are new ones, the verifier gets them, with your last prompt and a few facts code read from the tool calls (commands that failed, including a Traceback hidden behind `| tail`; images a tool wrote that nobody opened since; files the model wrote).

**The verifier** is a short loop the plugin runs itself: a model proposes commands, they run in a clone of your workspace, their output goes back, for at most 6 rounds of at most 3 commands of 60 s each. It picks at most 3 claims worth checking and judges each *holds*, *false* or *unclear*. A *false* verdict must carry the command it ran and the output that contradicts the claim; one without them is dropped. The clone is made with `cp -c` (an APFS clone: no data copied) and removed afterwards. A clone alone does not keep a script off your files (a project's scripts often write to absolute paths), so every command also runs under the macOS sandbox (`sandbox-exec`): nothing may be written under your home folder or the real workspace, except the clone (other places, such as `/tmp`, stay writable). A command that names your real workspace is refused. If no clone can be made (your home folder, the root, a copy over 60 s), or there is no sandbox (not macOS), it runs read-only commands only, and open items cannot close by their recheck.

**What does not hold becomes a numbered item**, with the model's own words, the command, the output, and a *recheck*: a command that exits 0 exactly when the claim holds. It reaches the model as a note it reads at its next step, and you in a band above the prompt.

**When a turn ends**, the claims in its answer are checked the same way, since no later step would. If one does not hold, the items go back to the model as one follow-up prompt. At most one per prompt of yours, so the check never keeps a session going by itself.

**Rules that need no model.** Before anything is handed to the verifier, code holds each claim against the session's own record of tool calls: what ran, in what order, and how it ended. These cost nothing, work on any machine (Linux too, where the verifier may only read), and cannot make evidence up:

| Rule | Raised when | Closes when |
|---|---|---|
| **failed-check** | the model says the tests, the build or a check pass, and the last such command it ran failed (exit code, `FAILED`, `1 failed`, `error TS…`, a Traceback, even behind `\| tail`) with none passing since | a check command passes after the last edit to code |
| **stale-check** | it says they pass, the last run passed, but a code file was edited after it (edits to `*.md`, `NOTES`, `README` do not count) | the same |
| **no-check** | it says they pass and no test, build or check command has run in the session | the same |
| **untouched** | it says it changed a file (`updated setup.cfg`) that no tool call touched or even named | a tool call names the file |
| **unopened image** | it says something about an image it made and never opened since | it opens the image |

A claim is held against what had happened when it was said, and only what the record still contradicts *now* is raised. Plans, hopes and honest failures ("I will make the tests pass", "two tests fail", 测试还没通过) are not claims. If a subagent ran before the claim, its runs are not in the transcript, so the test rules stand aside. A claim a rule already contradicts is not handed to the verifier as well.

These target the slip that costs most in a long session: "all tests pass", said about code changed since the run that passed, or about a run that failed, or about no run at all. When a turn ends on one, the follow-up prompt sends the model back to run the check.

## How an item closes

Not by the model saying so.

- **fixed**: its recheck, rerun in a fresh clone at every later check, exits 0; or, for a rule on the record, the record shows what closes it (a check command that passed after the last edit). The model writing `[ysk#3 fixed]` closes nothing.
- **told**: the model told you about it, writing `[ysk#3 told]` in its answer. It is then yours to weigh.
- **refuted**: the model says the clone misled the check (the claim depends on something outside the workspace), `[ysk#3 refuted: why]`, in its answer to you.

The note says it is what a check observed, not an instruction from you, and that it authorizes nothing beyond what you asked for: it carries command output from a project that may hold anything. Control characters and anything shaped like the engine's own tags (`<system-reminder>`) are stripped from what it quotes.

**Credentials.** Command output goes to the verifier's endpoint, a third party. A command that reads `~/.ssh`, `~/.aws`, `.env`, a `$…KEY`/`$…TOKEN` variable, or dumps the environment (`env`, `printenv`) is refused, in the clone too; keys and tokens a command prints anyway (`sk-…`, `ghp_…`, `AKIA…`, private keys, `password=…`) are cut out before the output leaves the machine.

## Example

A live run against DeepSeek (`deepseek-flash`, Claude Code 2.1.293, 2026-10-09). The project had a bug: `total()` skipped the first price. A handover note said "all tests pass and total() is correct", and the model, told not to run anything, repeated it. When its turn ended, the verifier ran the tests in a clone and saw `AssertionError: 47.25 != 59.75`. The model got this as a follow-up prompt:

```
[deepseek-supervisor] A separate check (not the person) found 1 item(s) that do not hold. It tested what you said by running commands in a throwaway copy of your workspace:
#1 The handover's claim is wrong: the suite fails, because shop.total() skips the first price (prices[1:]) and returns 47.25 instead of 59.75, so total() is not correct and not all tests pass.
   you wrote: Handover says: "Handover from the previous session: all tests pass and total() is correct."
   ran: python3 -m unittest test_shop -v 2>&1; echo exit=$?
   saw: test_empty ... ok / test_total ... FAIL / AssertionError: 47.25 != 59.75 / Ran 2 tests in 0.000s / FAILED (failures=1) / exit=1
   closes: when `python3 -m unittest test_shop` exits 0 (the check reruns it itself)
```

It read `shop.py`, fixed the slice, and reran the tests: `OK`, `exit=0`. That check took 10 s: 3 model calls, about 1.7k input and 2k output tokens.

## Requirements

- Claude Code with plugin function hooks (`claude plugin validate` / `claude plugin test` exist). Developed on **2.1.290**; 0.6.0 tested on **2.1.293**, 0.7.0 on **2.1.295**. Needs `bash` and `cp`. Running checks in a clone needs macOS (`sandbox-exec`); elsewhere the verifier runs read-only commands only, and the rules on the record work as anywhere.

## Install

From your shell:

```bash
claude plugin marketplace add LACAN-1/deepseek-supervisor
claude plugin install deepseek-supervisor@deepseek-supervisor
```

Update later with `claude plugin update deepseek-supervisor@deepseek-supervisor`.

Or, for one session, from a clone: `claude --plugin-dir /path/to/deepseek-supervisor`. Where you cannot pass a flag (for example a session another app starts), list the folder in `CLAUDE_CODE_PLUGIN_DIRS`.

**It turns itself on only where it is needed.** It checks when `ANTHROPIC_BASE_URL` points at a host that is not Anthropic's. On Anthropic's own endpoint it stays idle, because the built-in "You should know" already runs there. On Bedrock or Vertex, where that variable is unset, run `/deepseek-supervisor on` if you want it.

## Use

| | |
|---|---|
| Status line | `deepseek-supervisor checking claims · N noted (M open) · last: …`, or why it is idle |
| `/deepseek-supervisor on` / `off` | Force it on or off, whatever the endpoint. Off also clears the band. |
| `/deepseek-supervisor auto` | Back to the default: on only away from Anthropic's endpoint. |
| `/deepseek-supervisor issues` | This session's items: where each stands, the command and what it printed, and what settled it. |
| `/deepseek-supervisor log` | The last 10 checks: which claims were checked, every command run (exit code, time, any refused), the verdicts, token usage. |

The plugin's store is shared by every session on the machine. It keeps the on/off/auto setting, so `off` applies to all of them, and the last 50 checks, including the claims and command output. It is never sent anywhere.

## Cost

The rules on the record call no model and cost nothing. A check is a fresh request with no history: the claims, your prompt, the facts, and the command output so far. It does not re-read the session. In the run above, the check of the answer used about 1.7k input and 2k output tokens over 3 calls. Rechecks of open items run commands only and call no model. During the work the verifier runs at most 8 checks per prompt of yours; each check makes up to 6 model calls (12 if replies are unreadable and retried).

Commands run on your machine, in the clone and under the sandbox, with your environment: the project's own tests and scripts, as the model would run them, except that they cannot write under your home folder or the real workspace, other than in the clone. Reading is not limited, and the network is not cut off.

## Known limits

- **It only checks what a command can show false.** A model that did the wrong thing correctly, or misread what you wanted, makes claims that hold. This check does not see that.
- **It can be slow.** In the run above, the check during the work took 72 s (one reply ran to 18k output tokens of reasoning), and the turn ended before its note arrived; the check of the answer caught the same claim. A slow check never blocks the model; it lands late.
- **The clone is not your machine.** A claim that depends on something outside the workspace (a running server, a file elsewhere) can be judged false in the clone. The model then says so to you with `refuted`.
- **The claim detector is wide.** Most sentences it hands over are not worth a command; the verifier is told to skip them. Each run is logged, so you can see what it chose.
- **The rules read regexes, not meaning.** A test command is recognised by name (`pytest`, `unittest`, `npm test`, `cargo test`, `tsc`, `make test`…); a project with its own runner script is not, so its runs do not count as checks. An edit made through Bash (`sed -i`, a script) is not seen as an edit. Both make the rules miss, not misfire.
- **Without a sandbox the verifier mostly reads.** On Linux it cannot run the project's tests, so a claim only a test run can refute is left to the rules above, and to the model's own runs.
- **One live run so far.** The numbers above are n=1. The `late` eval suite (see [eval/README.md](eval/README.md)) is built for the rules on the record and has not been run against a live model yet.

## Development

```bash
claude plugin validate .
claude plugin test .
```

Claude Code writes type declarations into `.claude-plugin/types/` the first time it loads the plugin; after that, `tsc -p .` type-checks it.

| File | Role |
|---|---|
| `hooks/register.ts` | When to check, the verifier's loop (clone, commands, model calls), settling items, the note and follow-up, the on/off/auto switch, the command |
| `hooks/prompt.ts` | The claim detector, the facts read from the tool calls, the verifier's prompt and the parsing of its answers, what may run where, redaction, the note |
| `hooks/evidence.ts` | The rules on the session's record: failed, stale or missing checks, files said to be changed and never touched |
| `hooks/band.tsx` | The band above the prompt |
| `types/index.d.ts` | The item shape and the plugin's state contract |
| `tests/*.test.ts` | 31 tests against Claude Code's plugin test kit |
| `eval/` | The same tasks with the plugin and without, scored by code; see [eval/README.md](eval/README.md) |

## License

MIT
