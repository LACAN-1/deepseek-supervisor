# deepseek-supervisor 云端审查报告（cloud-review 分支）

审查范围：`cloud-review` 分支 dc8aec1（含作者未完成的 WIP）上的全部代码：`hooks/`、`types/`、`tests/`、`eval/`、两份 README。审查环境为 Linux 云容器（没有 macOS `sandbox-exec`），所以「副本里执行」这条路径只能读代码判断。

## 总体评价

代码短，结构清楚，测试也按行为写。纯文本处理的部分（`prompt.ts` 的声明抽取、解析、去重）没有发现正确性问题，测试全部通过（审查前 16 个，修复后 17 个）。

> 说明：这次审查由同一个定时任务的两个会话并行完成，两边独立发现了第 1、2 条并各自修复，之后用一次普通的 merge 提交合并（没有 force push）。合并时保留了覆盖面更大的实现：第 1 条额外拦住 `sort --compress-program`（会执行任意程序），第 2 条把家目录也加了 realpath；另外补上第 14 条（复查命令绕过 `refusal()`）。主要问题在**安全边界**上：

- 在 Linux（以及任何没有沙箱的机器）上，插件一直处在「只读模式」：命令不进沙箱，直接在**真实工作区**里用 `bash -c` 执行。这时唯一的防线是 `refusal()` 这个过滤器，但它只检查按 `| && || ;` 切开后每一段的第一个词，用换行、`&`、`$(…)`、反引号都能绕过去，验证者因此可以在真实工作区里跑任意命令。验证者是第三方模型，它会读到项目文件的内容，项目文件里的文字可以引导它（提示注入）。**这一条已修。**
- macOS 沙箱只禁写工作区「传入的路径」，没有禁写它解析后的真实路径。**已修**（只加了禁写规则，没有放宽任何东西）。
- 有几处 README 说的和代码实际做的不一致（模型调用预算、沙箱能限制什么）。**已修。**
- eval 统计插件活动用的日志格式只有 0.4.0 才写，换成 0.6.0 跑会把插件活动统计成 0。**已修。**

## 发现（按严重度排）

「已验证」表示我做过一次能推翻该结论的观察，具体做法写在「验证」列。

| # | 严重度 | 位置 | 问题 | 具体失败场景 | 状态 | 验证 |
|---|---|---|---|---|---|---|
| 1 | 高 | `hooks/prompt.ts:140-147`（修复前） | 只读模式的命令过滤器能绕过，导致命令注入 | Linux 上验证者回复 `{"run":["cat a.py\npython3 evil.py"]}`，第二行会在真实工作区里不受限地执行。`cat a & python3 x`、`cat $(python3 x)`、`` cat `python3 x` ``、`cat <(python3 x)` 同样能执行；`find -execdir/-ok/-fprint/-fls`、`rg --pre`、`sort -o`、`sort --compress-program=PROG`、`uniq IN OUT`、`file -C` 都能写文件或执行程序，但第一个词都在白名单里 | **已修** edaaf75 / 7f97346 / 74c928e（合并后采用 7f97346 的实现） | **已验证**：先用 `node --experimental-strip-types` 直接调用 `refusal()`，修复前 9 种写法都返回 ALLOWED；新加的测试在旧代码上失败（15 pass / 1 fail），修复后通过；另一会话独立复现：12 种写法修复前全部 ALLOWED，`bash -c $'cat /dev/null\ntouch pwned'` 真的建出了 `pwned`；`sort \| uniq -c; echo "exit=$?"`、`test -f x && echo`、`uniq -f 2 a`、`rg --pre-glob` 仍然放行 |
| 2 | 中 | `hooks/register.ts:118-123, 165`（修复前） | 沙箱只对 `input.cwd` 原样禁写，没有禁写它解析后的真实路径 | 工作区在 `/tmp/proj`（macOS 上实际是 `/private/tmp/proj`），或者工作区本身经过符号链接进入：sandbox-exec 按解析后的路径匹配，deny 规则匹配不上，项目脚本写绝对路径就能改到真实文件 | **已修** 55405cc / 2823592：cwd 和家目录都同时按原路径和 `realpath` 禁写（家目录本身是符号链接的情况较少，但修法相同） | **未验证**：Linux 上没有 sandbox-exec，无法实测。依据是作者已经因为同样的原因把克隆的 `realpath` 加进了 allow 规则（`register.ts:164`），能推翻这个判断的观察是「sandbox-exec 按未解析的路径匹配」，这个观察在这里做不了。这个修复只增加 deny 规则，不会放宽任何权限 |
| 3 | 中 | `hooks/register.ts:22, 277, 297-300` | `seen` 只保留最近 200 条，而 `newClaims` 每次都扫描全部 assistant 消息。被挤出 `seen` 的旧声明会重新算作「新声明」 | 长会话里出现超过 200 条匹配声明的句子以后（`CLAIM` 正则很宽，"done""完成"都算），之后每次 tick 都会把 12 条旧声明重新交给验证者：8 次预算花在已经查过的旧话上，可能对早已过时的「All tests pass」开出新条目 | **未修**（修法要改「哪些消息已经扫过」的记录方式，会动 Track 结构，需要作者决定） | **已验证**：把 `newClaims` 和 seen 的更新逻辑原样复制出来，模拟 250 条消息、40 次 tick。第 30 次以后每次 tick 都交出 12 条，内容是 "Step 82 done." 这类旧声明 |
| 4 | 中 | README.md:87、README.zh-CN.md:87、`register.ts:15-18`、`types/index.d.ts` Track.runs | 文档说「每次提示最多调用 8 次模型」，代码实际是每次提示最多 8 次**检查**，每次检查最多 6 次调用，加上重试最多 12 次 | 用户按 8 次调用估算成本，实际最坏是 96 次。现有测试的 mock 每次检查只调用一次模型，所以测试测不出这个差别 | **已修**（改的是文档，不是代码）8c661a3 | **已验证**：读 `register.ts:180-191`（每轮 1 次调用，加 1 次重试）和 `:276-277`（`runs` 每次检查只加 1） |
| 5 | 中 | `eval/run.mjs` pluginStats | 只匹配 0.4.0 的日志格式（`$.model.fork`、`WATCH {fresh}`）；0.6.0 写的是 `CHECK {claims, found}` | 用当前版本跑 eval，"plugin got a look in" 一列和 passes/items 永远是 0，看起来像插件什么都没做 | **已修** 116510b（同时识别 CHECK 行；0.6.0 的 token 用量没写进 debug 日志，所以 token 一列仍然是 0，注释里已写明） | **已验证**：用构造的日志测试，0.6.0 的日志旧代码统计出 {0,0}，新代码统计出 {passes:2, items:3}；0.4.0 的日志新旧代码结果相同 |
| 6 | 中 | README.md:21, 89；README.zh-CN.md:21, 89 | README 说「只能写克隆」，实际沙箱配置是 `(allow default)` 加禁写家目录和工作区 | `/tmp`、`/usr/local`、外接卷等都能写，README 说的范围比实际窄 | **已修** 8c661a3 | **已验证**：读 `boxOf` 生成的配置，和测试里断言的字符串一致 |
| 7 | 中（设计问题） | `boxOf` / README「读取不受限」 | 读取完全不受限，命令输出又会发给第三方模型接口 | 验证者被项目文件里的文字引导，跑了 `cat ~/.ssh/id_rsa` 或 `env`，输出就进了发往 DeepSeek 的请求。提示词里只写了「不要抄进字段」，但发出去的 transcript 里本身就带着完整输出 | 未修（README 已经说明读取不受限，是否收紧由作者决定） | 未验证（要有真实模型才能复现，这是按代码路径推出来的：`register.ts:211` 把输出拼进 transcript，`:182` 把 transcript 发出去） |
| 8 | 低 | README「How an item closes / fixed」 vs `register.ts:176, 195` | README 说「只有 recheck 退出 0 才算 fixed，模型说了不算」。但在只读模式下（所有 Linux 机器都是），带 recheck 的条目也会交给验证者模型，凭它回复 `items[].status: fixed` 就能关闭 | Linux 用户看到的 fixed，其实是第二个模型的判断，不是命令的退出码 | 未修（代码显然是有意这么写的，`mode !== 'copy' \|\| …`；建议在 README 里说明这一点） | **已验证**：读 `register.ts:176` 的 toRecheck 条件，以及 `:195` 只要 id 在 toRecheck 里就接受 |
| 9 | 低 | `prompt.ts:141` | 复制模式下用 `command.includes(real)` 判断命令有没有指向真实工作区：只按前缀匹配，有误伤，也很容易绕过 | `cat /Users/me/proj2/x` 在 real=`/Users/me/proj` 时会被拒（误伤）；`$OLDPWD`、`$HOME/proj`、`/Users/me/./proj` 都不会被拒。真正的保护靠沙箱，这一条只能起提示作用 | 未修 | **已验证**：直接调用 `refusal()`，`/Users/me/proj2/x` 被拒，`echo hi > "$OLDPWD/x"` 放行 |
| 10 | 低 | `register.ts:103` vs `:117` | 判断有没有沙箱时检查的是 `/usr/bin/sandbox-exec`，真正执行时却按 PATH 去找 `sandbox-exec` | PATH 里有一个同名程序抢在前面时，执行的就不是系统沙箱 | 未修（改起来要同时改测试 mock 里的 `cmd === 'sandbox-exec'`，收益小） | 已验证（读代码） |
| 11 | 低 | `copyOf`：`cp -R` | BSD `cp -R` 把符号链接原样复制成符号链接；克隆里如果有指向工作区外、家目录外的链接，往里写就会写到真实目标 | 项目里有 `data -> /Volumes/shared/data` 这样的链接，测试往 `data/` 写文件，会写到共享卷上 | 未修 | 未验证（macOS 上的行为，这里无法实测） |
| 12 | 低 | `eval/README.md` | 描述的是 0.4.0 的行为（"the reviewer looks every 6 steps"），结果日期 2026-10-08，和 0.4.0 提交是同一天；0.6.0 的 `MIN_GAP` 是 3 | 读者会以为这些结果是 0.6.0 跑出来的 | 未修（结果怎么表述该由作者定） | 已验证：`git log` 的日期，以及 `register.ts:19` |
| 14 | 中低 | `hooks/register.ts:170-174`（修复前） | 复查命令（recheck）也是验证者模型给的，但没经过 `refusal()`；README 说「命令里写了你真实工作区路径的，一律拒跑」 | recheck 写成 `cd /p && python3 -m unittest`，会在真实工作区里跑，条目按真实文件的状态关闭，写操作只靠 macOS 沙箱挡 | **已修** b6d61e7：先过 `refusal()`，被拒的记进 `ran`，条目保持 open | **已验证**：新测试在旧 `register.ts` 上失败（16 pass / 1 fail），修复后通过 |
| 15 | 低 | `prompt.ts` 的 `>` 规则 | 只读模式拒绝所有含 `>` 的命令，包括 `2>&1`、`2>/dev/null` | 验证者常用的写法被拒，只读模式下能查的东西更少。只影响可用性，不影响安全 | 未修（放宽需要仔细设计） | **已验证**：`refusal('grep x a 2>/dev/null','read-only','/p')` 返回拒绝 |
| 13 | 低 | README「It picks at most 3 claims」 | 这只是提示词里的要求，`parseTurn` 并不限制 `checked` 的条数 | 模型返回 10 条 false，就会一次开出 10 个条目 | 未修 | 已验证（读 `prompt.ts` parseTurn） |

没有发现值得报告的风格问题，所以没有报。

## 跑了哪些检查

| 检查 | 结果 |
|---|---|
| `claude plugin validate .`（Claude Code 2.1.295） | √ Validation passed（修复前后都是） |
| `claude plugin test .` | 修复前 16 pass / 0 fail；把新测试放到旧 `prompt.ts` 上跑是 15 pass / 1 fail（复现了问题 1）；全部修复并合并后 **17 pass / 0 fail**（第 14 条的测试在旧代码上同样先失败过） |
| `node eval/selftest.mjs` | all checks behave |
| `node eval/selftest-long.mjs` | all checks behave |
| `node eval/selftest-hard.mjs` | all checks behave |
| `node --check eval/run.mjs` | 语法正确 |
| 用 node 直接调用 `refusal()` 和模拟 seen 淘汰的临时脚本 | 输出见上表第 1、3、9 条 |

## 没跑的及原因

- **`npx tsc --noEmit`**：未运行成功。`tsconfig.json` 继承的是 `.claude-plugin/types/tsconfig.json`，这个文件要等 Claude Code 第一次加载插件时才会生成，仓库里没有，所以报 `TS5083 Cannot read file` 和 `Cannot find module 'claude-code'`。生成它需要一次能连上模型接口的真实会话，云端没有。
- **`eval/run.mjs`**（真实模型 A/B）：要用 DeepSeek 的 API，没跑。
- **macOS `sandbox-exec` 路径**：Linux 上没有，第 2、11 条只能读代码判断。

## 建议作者后续处理

1. **第 3 条（seen 淘汰）**：可以在 Track 里记一个「已扫描到第几条消息」，tick 时只扫新消息；或者用声明的哈希代替原文，去掉 200 条的上限。
2. **第 7 条（读取外泄）**：可以考虑在沙箱配置里加 `(deny file-read* (subpath "~/.ssh") (subpath "~/.aws") …)`，或者在发出去之前过滤掉看起来像密钥的输出。
3. **只读模式本身**：白名单过滤器终究是黑名单式的修补。如果要在 Linux 上跑得更稳，可以考虑 `bwrap` / `unshare` 只读挂载，或者干脆在 Linux 上关闭命令执行，只做规则检查。
4. **第 8 条**：在 README 里写明「没有沙箱时，fixed 可以由验证者模型的判断给出」。
5. **eval/README**：标注这些结果对应的插件版本，0.6.0 上重跑一遍。
6. 让测试里的 mock 每次检查多调用几次模型，把第 4 条描述的预算语义真正测起来。

## 提交

- `edaaf75` 关闭只读过滤器的命令注入
- `55405cc` 沙箱同时禁写工作区解析后的真实路径
- `8c661a3` README / 注释与代码对齐（预算、沙箱范围、测试数）
- `116510b` eval 识别 0.6.0 的日志格式
- `7f97346`、`74c928e` 只读过滤器（另一会话的独立实现，覆盖面更大，合并时采用）
- `2823592` 沙箱禁写路径（cwd 和家目录）都加 realpath
- `b6d61e7` 复查命令也过 `refusal()`
- `b804d25` README 测试数
- 合并提交：把两个会话的工作合到一起（普通 merge，不是 force push）

没有改 LICENSE、版本号和 main。

## PR

从 `cloud-review` 到 `main` 的 PR：https://github.com/LACAN-1/deepseek-supervisor/pull/1 （并行会话开的；本会话的提交经合并后也在里面）。没有合并。
