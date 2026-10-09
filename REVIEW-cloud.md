# deepseek-supervisor 云端审查（cloud-review 分支）

审查范围：`hooks/`、`types/`、`tests/`、`eval/`、两份 README，包括作者未完成的 WIP 提交 `dc8aec1`。
环境：Linux 云容器，Node 22.22，Claude Code 2.1.295（有 `claude` CLI），**没有 macOS `sandbox-exec`**。

## 总体评价

代码整体干净，状态模型清楚（条目编号放在 `$.state`、`isSameItem` 去重、`race.test.ts` 覆盖并发），测试比较扎实。
真正的问题集中在**命令执行的安全边界**：

- **只读模式的过滤器可以被绕过，绕过后能执行任意命令**（最严重，已修）。在 Linux 上验证者的命令永远走只读模式，而且直接跑在**真实工作区、没有任何沙箱**，所以这个过滤器就是唯一的防线。验证者模型读到的是项目里的命令输出，项目内容里的提示注入可以借此在用户机器上执行命令。
- macOS 沙箱的禁写路径没有做 realpath（已修，未在 macOS 上验证）。
- 复查命令（recheck）没有过 `refusal()`（已修）。

除此之外没发现正确性 bug。不为凑数列风格问题。

## 发现（按严重度）

| # | 严重度 | 位置 | 问题 | 失败场景 | 状态 | 验证 |
|---|---|---|---|---|---|---|
| 1 | **高** | `hooks/prompt.ts:140-147`（修前） | 只读模式的 `refusal()` 只检查按 `\| && \|\| ;` 切开后每段的第一个词。换行、单个 `&`、`$(…)`、反引号、`<(…)` 都能夹带第二条命令；白名单里的工具本身也有写文件/执行程序的参数：`find -execdir/-ok/-fprint/-fls`、`sort -o`/`--compress-program`、`rg --pre`、`file -C`、`uniq in out`。 | Linux 上（或 macOS 克隆失败时），验证者回 `{"run": ["cat a\npython3 -c '…'"]}`，在**真实工作区、无沙箱**下跑了 python。12 种绕过修前全部返回 `undefined`（放行）。 | 已修 `7f97346`、`74c928e` | **已验证**。反证：「如果这些命令被拒，这条就是假的」。修前用 `node --experimental-strip-types` 直接调 `refusal()` 跑 12 个用例，全部 ALLOWED；`bash -c $'cat /dev/null\ntouch pwned'` 确实建出了 `pwned`。修后同一脚本 12/12 被拒。新增的断言在旧 `prompt.ts` 上失败（`git checkout HEAD -- hooks/prompt.ts` 后 `claude plugin test .`：15 pass 1 fail），修后通过。 |
| 2 | 中 | `hooks/register.ts:118-123, 164-165`（修前） | 沙箱配置里克隆路径同时给了原路径和 `realpath`（作者显然知道 sandbox 按解析后的路径匹配），但**禁写的家目录和真实工作区只给了原路径**。 | macOS 上工作区是 `/tmp/proj`（实为 `/private/tmp/proj`）或通过家目录外的符号链接进入：`(deny file-write* (subpath "/tmp/proj"))` 匹配不到 `/private/tmp/proj`，项目脚本写绝对路径就能写进真实工作区。 | 已修 `2823592`（禁写路径也同时放原路径和 realpath） | **未验证**（云端没有 `sandbox-exec`，无法实测 SBPL 的匹配行为；依据是作者对克隆路径已经这么做了，以及 macOS 上 `/tmp → /private/tmp` 的已知行为）。生成的配置字符串由已有测试断言。 |
| 3 | 中低 | `hooks/register.ts:170-174`（修前） | 复查命令是验证者模型给的，但没经过 `refusal()`。README 说「命令里写了你真实工作区路径的，一律拒跑」。 | 复查命令写成 `cd /p && python3 -m unittest`：它在真实工作区里跑，条目按真实文件的状态关闭，写操作只靠 macOS 沙箱挡。 | 已修 `b6d61e7`（被拒的复查记进 `ran`，条目保持 open） | **已验证**。新测试在旧 `register.ts` 上失败（`git stash -- hooks/register.ts` 后：16 pass 1 fail），修后通过。 |
| 4 | 中 | `hooks/prompt.ts` `READERS` + 只读模式 | 只读模式（Linux 上一直是它）对**读**没有任何限制：`cat ~/.ssh/id_rsa`、`cat .env` 都放行，输出原样进下一轮提示，发给第三方端点（DeepSeek）。提示词里「不要把密钥抄进字段」挡不住它进 transcript。 | 项目里的提示注入让验证者去读 `~/.aws/credentials`，内容随下一轮请求发到第三方端点。 | **未修**：README 写了「读取不受限制」，是作者的取舍；要改得设计（例如只读模式只允许工作区内的相对路径）。 | 已验证（读代码：`refusal()` 只看写/执行；`register.ts:209` 把输出拼进 transcript）。 |
| 5 | 低 | `eval/run.mjs:88-99`、`eval/pressure.mjs:208` | 评测脚本按旧版（0.4.0）的日志格式统计插件活动：`$.model.fork (deepseek-supervisor)`、`WATCH {…}.fresh`、`[plugin_model_fork] finished`。现在的代码调 `$.model.complete`，日志行是 `CHECK {…found…}`。 | 用当前版本跑 `node eval/run.mjs`，`passes`/`items`/token 全是 0，「plugin got a look in」列永远 0/N。 | **未修**：`model.complete` 在 debug 日志里的格式我不知道，只能修一半；而且不确定作者是否打算沿用这些指标。 | 已验证：`grep -rn "WATCH\|model.fork" hooks/` 无结果，`register.ts:301` 只写 `CHECK`。 |
| 6 | 低 | `eval/README.md:20,44`、`eval/tasks.mjs:7` | 写的是「reviewer 每 6 步看一次」，现在代码是每 3 步（`MIN_GAP = 3`）。结果表应该是旧版插件跑出来的，但 README 没标版本。 | 读者会以为表里的数据对应 0.6.0。 | **未修**：不确定那些结果用的是哪个版本，建议作者标注。 | 已验证（`grep -n "every 6" eval/`；`register.ts:19`）。 |
| 7 | 低 | `hooks/prompt.ts` `refusal()` 的 `>` 规则 | 只读模式拒绝一切含 `>` 的命令，包括 `2>&1`、`2>/dev/null`，以及 `grep '->'` 这类参数。 | 验证者常用的写法被拒，只读模式能查的东西更少。只是可用性问题，不影响安全。 | 未修（放宽要仔细设计，不是小改动） | 已验证：`refusal('grep x a 2>/dev/null','read-only','/p')` 返回拒绝。 |
| 8 | 低 | `README.md:114`、`README.zh-CN.md:114` | 写的「15 个测试」，WIP 提交时实际已经 16 个。 | — | 已修 `b804d25`（改成 17，含本分支新增的 1 个） | 已验证：`claude plugin test .` → `Ran 17 tests`。 |

看过、没发现问题的：`isAnthropic` 的 host 解析（`api.anthropic.com.evil.com` 不会被当成 Anthropic），`drop()` 只删 `dss-verify.*`，克隆失败会回退到只读并删掉半成品，`parseTurn` 处理非法 claim 序号，`atAnswer` 和 `tick` 并发（有 `race.test.ts` 覆盖），每次提示最多一次追加提示。

## 跑过的检查

| 检查 | 结果 |
|---|---|
| `claude plugin validate .` | `√ Validation passed`（修前修后都是）。有一条提示 `gating hook without .catch: prompt.submit`，是校验器的信息行，不是失败。 |
| `claude plugin test .` | 修前 16 pass / 0 fail；修后 **17 pass / 0 fail**（新增 1 个测试，并在已有测试里加了断言）。 |
| `node eval/selftest.mjs` / `selftest-long.mjs` / `selftest-hard.mjs` | 三个都输出 `all checks behave`，没有 FAIL 行（修复之前跑的；修复没碰 eval/）。 |
| 反证脚本（`refusal()` 的 12 个绕过用例，`node --experimental-strip-types`） | 修前 12/12 放行，修后 12/12 拒绝。 |
| 新断言在旧代码上的表现 | 修复 1、3 的测试都在旧代码上失败过，确认测试真能抓住问题。 |

## 没跑的及原因

- **`npx tsc --noEmit`：未运行成功。** `tsconfig.json` 继承 `.claude-plugin/types/tsconfig.json`，这个文件要 Claude Code 第一次加载插件时才生成，云端没有，所以 tsc 报 `TS5083 Cannot read file` 和 `Cannot find module 'claude-code'`，结果不能用。`claude plugin test .` 能编译并运行全部 TS 文件，可以作为间接证据。
- **macOS 沙箱（`sandbox-exec`）下的克隆路径：未运行。** 云端是 Linux。发现 2 的修复只做了代码审读和配置字符串的测试。
- **`eval/run.mjs`、`eval/pressure.mjs`（真实模型 A/B）：未运行。** 需要真实端点和 API key，任务也明确说不跑。

## 建议作者后续处理

1. **在 macOS 上实测发现 2**：工作区放在 `/tmp/x` 下，跑一条 `touch /tmp/x/pwned` 和一条 `touch /private/tmp/x/pwned`，确认都被拒。
2. **只读模式的读权限（发现 4）**：考虑只允许工作区内的相对路径（拒绝 `/`、`~`、`..` 开头的参数），或者至少在 README 的 Linux 说明里写明：Linux 上命令是在真实工作区、无沙箱下跑的，能读家目录。
3. **只读过滤器是黑名单加白名单，本质上脆弱。** 这次把已知的绕过都堵上了，但更稳的做法是不经 `bash -c`：自己把命令切成 argv 直接 exec，只允许白名单工具和白名单参数。这个改动比较大，我没动。
4. **eval 统计（发现 5、6）**：按 `CHECK {…}` 行重写 `pluginStats`，并在 `eval/README.md` 里标明结果对应的插件版本。

## PR

如果有权限，会从 `cloud-review` 开一个到 `main` 的 PR（不合并），链接见提交后的会话记录。没有权限的话，这里会写明。
