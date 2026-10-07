# 独立复验：证据落地 R1 修复

日期：2026-10-07  
结论：**approve**  
范围：原独立验收报告中的 R1，以及证据边界与既有回归。**R1 已关闭，未发现新的阻断项。**

## 方法与操作边界

- 实际阅读修复后的 `src/ai.ts`：`normalized()`、`groundQuote()`、`evidence()`、各条目校验、叶回顾/层级聚合/压缩路径、结构修复、拆分与预算、任务登记与落库；完整阅读新增正式回归 `tests/ai-grounding-candidates.test.ts`。
- 实际阅读并重跑原独立探针 `tests/review-grounding-probe.ts`，没有改变其预期成功断言；另外自行新增 `tests/review-grounding-rereview-probe.ts` 补测边界。所有探针都通过公开 `Ai.generate()` → Store 路径，不复制、替换或直接调用匹配函数。
- 实际阅读相关裁剪/围栏/修复/截断/并行/调度测试及 `src/scheduler.ts`；核对 `web/app.ts` 字段隐藏与 epoch/scope/request 隔离、`tests/browser-report-errors.ts` 的故障注入。
- 每轮命令均清除继承的 `LLM_*`、`APP_*`、`FLEETING_*`、`PASSWORD_HASH`、`DATABASE_PATH`、`PORT`、`HOST`、`NODE_OPTIONS`；显式将 `FLEETING_CONFIG` 指向临时目录中的不存在文件，数据库回退路径也指向该隔离目录。配置/生产测试只使用自己创建的临时合成配置；测试数据库仅 `:memory:` 或临时目录。
- 模型全部注入 mock fetch；浏览器/生产测试只访问自行启动的随机本机端口，结束后关闭。**未读取或修改真实私有配置/数据库，未调用真实模型，未连接、重启现有服务。** 格式检查沿用现有私有文件排除规则，未扩大读取范围。
- 未修改产品代码、正式回归或原独立探针；保留原 `needs_changes` 报告及历史输出。本次新增复验报告、完整运行输出和额外探针。必跑 build 正常重新生成构建产物。

## R1 代码核对

定位：`src/ai.ts:92–195`；调用与供给链路：`src/ai.ts:612–778`。

1. **供给校验进入候选搜索。** `evidence()` 先在生成范围内的完整 `entries` 中按 ID 找原文，再将接受谓词传入 `groundQuote()`：候选必须包含于同 ID 的某一实际供给切片。未知 ID 仍抛来源错误。
2. **策略继续搜索。** 精确命中但谓词拒绝时，不再结束搜索；接着执行空白、空白加标点两级策略。每级用 `indexOf(needle, at + 1)` 枚举，包括重叠命中；前一个候选未供给时继续找后一个，当前级全拒绝后继续下一级。
3. **精确路径没有遗漏合法位置。** 精确出现多次时每处切片字节内容相同，而供给谓词只按 ID 和切片内容判断。因此一次 `includes(quote) && accepts(quote)` 等价于逐个检查所有精确出现；失败后继续归一化即可。此处返回的 quote 已被证明与原文连续子串完全相等，不是返回归一化文本。
4. **归一化只用于定位。** `normalized()` 保留每个 UTF-16 单元的原文 starts/ends；连续空白更新映射终点，代理对映射保持原字符范围。命中后仍从完整原文 `text.slice(starts[at], ends[...])` 取值，再检验供给，未返回 `original.value` 或规范化 needle。
5. **没有放宽聚合引用。** `supplied.some(s => s.id === id && s.text.includes(slice))` 仍在；既不能借其他 ID 的切片通过，也不能拼接多个供给切片扩大引用。叶阶段使用完整 entries 校验；层级聚合、压缩回顾、压缩聚合都把实际传给模型的 `data.originals` 作为供给约束。原文没有被同 ID 分片覆写。
6. 无可接受候选仍返回 null，丢弃证据及空条目；最终最低洞察门槛、一次结构修复、失败保留旧 ready 均未移除。替换/丢弃日志仍仅输出阶段、字段路径及固定诊断，不打印原文。

## R1 三例与负例：实际复跑

表内 `\t` / `\n` 表示实际制表符/换行。

| 变体 | earlier（未供给） | supplied（实际供给） | 模型 quote | 结果 |
| --- | --- | --- | --- | --- |
| 空白首匹配 | `甲 \t乙` | `甲\n乙` | `甲 乙` | 成功，存库严格等于 supplied |
| 标点首匹配 | `甲，乙！` | `甲,乙！` | `甲,乙!` | 成功，存库严格等于 supplied |
| 精确命中抢先 | `甲 乙` | `甲\n乙` | `甲 乙` | 成功，存库严格等于 supplied |

- 原独立探针三例均由原先失败转为成功（完整探针 **16/16**）。先精确引用成功，再仅修改聚合 quote；供给材料保持不变。
- 正式 `tests/ai-grounding-candidates.test.ts` 三变体 × 普通/压缩路径共 **6/6**：断言聚合与压缩输入全为指定 ID 的 supplied，输出 quote 全等、长度相等、完整原文 includes；合法变体无结构修复；压缩路径确实经过两次压缩回顾和一次压缩聚合，并检查压缩结果已保留精确证据。
- 每项正式回归随后引用原文中实际存在的 `真正未供给`：普通/压缩路径均丢弃；修复一次仍不足则失败；旧 ready 的 ID 和数据逐字不变，旧结果不含该越界引文。压缩负例额外确认中间回顾洞察已被丢弃，不是仅靠最后一步拦截。
- 原独立探针的另一未供给原文负例也继续被拒绝；未知 ID、其他月份的已有 ID 仍按来源错误处理。

## 本次额外独立边界探针

文件：`tests/review-grounding-rereview-probe.ts`，**8/8**。

每例均覆盖普通层级聚合与强制截断后的压缩路径；同时检查 insights / changes / connections / questions，共四类证据调用点。

| 新探针 | 验证结果 |
| --- | --- |
| 重叠候选：原文尾部 `甲 \t甲\n甲`，只供给后面的 `甲\n甲`，模型引用 `甲 甲` | 第一个归一化命中未供给，仍找到与它重叠的第二个；保存后者原文切片 |
| 空白策略向标点策略回退：原文尾部 `甲\t乙!隔甲\n乙！`，供给 `甲\n乙！`，模型引用 `甲 乙!` | 空白级候选被拒绝后仍进入标点级，保存 supplied，不保存模型规范化串 |
| 多切片不得拼接：分别供给 `甲\n乙` 和 `丙！`，模型引用原文真实存在的 `甲 乙丙!` | 即使完整原文中连续存在且归一化可匹配，也因不包含于任何单个供给切片而丢弃 |
| 同形文本跨 ID：两个原文都有候选文字，但只有另一 ID 供给该文字 | 不能借另一 ID 的供给通过；目标 ID 的越界证据被丢弃 |

所有输出均断言 ID/day、quote 全等、长度、完整原文 includes 及同 ID 单个 supplied includes。两个负例保留另一项合法洞察，确认条目级丢弃不会误使整份报告失败。压缩输出在后续聚合输入处再次检查；全部无需结构修复。

## A–C 与上一轮回归核对

- **A / 精确落地及跨片：** 原独立探针重新验证 CRLF、tab、全角空格、NBSP、emoji、弯引号/全半角标点和组合归一化。跨 2000 边界例确认任何单个模型分片都没有完整引用，仍经过 3 个叶回顾、2 次聚合成功，落库严格等于预设连续原文切片。
- **B / 容错与最低门槛：** 有效/伪造混合仅保留有效证据；缺失、空、全不可落地条目被丢弃；两条记录一个洞察成功、零洞察失败并保留旧 ready；单条允许零洞察；fact 和问题 text 仍必填。诊断路径与隐私断言继续通过。
- **C / 前端：** 原独立 Chrome 探针实际验证缺失/空白/有值三类字段：事实与精确证据均保留，仅有值项显示解释/局限/追问；弹窗显示完整合成原文、无 pageerror。正式 Chrome 也通过。
- **裁剪/围栏：** 正式测试重新验证数组软裁剪及 2000 硬上限、文本裁剪不拆代理对、JSON/裸围栏、超长 quote 裁剪后仍是原文子串。
- **结构修复：** 日第一/核对阶段、月分类/叶/聚合各仅修复一次；修复输入包含任务、候选和路径错误；网络/超时/HTTP 非结构错误不修复；再次失败不清除旧 ready。
- **截断与预算：** 日多条/长单条、第二阶段重新完成两阶段、月分类/叶拆分、月聚合压缩重试全部通过；完整字符与来源覆盖断言仍在；持续拆分加坏结构的正式测试准确停在 **512 次**模型调用。代码中的 60000 材料预算仍在。
- **并行/前端隔离：** 同 kind+period 互斥、日/月同时 running、一方失败不影响另一方；Chrome 重跑旧范围最终 GET 503 隔离、临时轮询错误恢复、ready 停轮询、持续错误最多 3 次重试、切页/退出取消及草稿/旧内容保留。
- **调度：** 实际代码仍按配置时区 01:00 起检查昨天，事务内登记持久尝试标识；正式测试验证 00:59/01:00、重开幂等、失败不自动反复调用、手动冲突不消费机会、月任务不阻塞、无配置/无记录/指纹相同跳过、跨年/闰日/DST 重复 01:00。

在上述代码检查及重新运行覆盖范围内，**未发现裁剪、围栏、修复重试、截断、并行、调度退化**。这不是以全绿代替 R1 复现：R1 正负例和补充边界已单独实际验证。

## 本次完整命令结果

完整 stdout/stderr 与 exit code：`docs/review-2026-10-07-evidence-grounding-rereview-validation.txt`。全部为本次运行，未引用执行方历史验证作为通过依据。

| 命令 | 结果 |
| --- | --- |
| `npm run typecheck` | exit 0 |
| `npm test` | exit 0，61/61，无跳过 |
| `npm run build` | exit 0 |
| `npm run test:production` | exit 0 |
| `CHROME_PATH='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' npm run test:browser` | exit 0 |
| `npm run format:check` | exit 0 |
| `CHROME_PATH='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' ./node_modules/.bin/tsx --test tests/review-grounding-probe.ts` | exit 0，16/16，无跳过 |
| `./node_modules/.bin/tsx --test tests/review-grounding-rereview-probe.ts` | exit 0，8/8，无跳过 |

新增独立探针后再次执行 typecheck / format:check，均 exit 0，输出已追加在同一文件。两份独立探针不匹配 `tests/*.test.ts`，须按表中命令显式运行，不计入正式 61 项。

## 被验文件 SHA-256

以下产品文件在本次检查前后指纹一致；原探针与原报告记录的指纹一致。

```text
191c65201db6025dae12fcad1cbb804c4d74ea6d20e705f078a3c26b666eb761  src/ai.ts
565029f997d6aba341f5bf0e7eab55b82c5e70ea8985b06cf8e9fe783ae1bce8  src/config.ts
c3df2de431560c127fb28f675666081148186d34a02fb6929eaf6ebf429e9100  src/scheduler.ts
1575d06f0e88cebf3eb04b18863ba56a636f49c2a066054eb55dec1ebf4f18d6  web/app.ts
62dc80ede73694b44465227daebf21315615d045fae57e380849f99691e9fa29  tests/ai-grounding-candidates.test.ts
76534ab23bff2bc461d5e88cb55694d3b66834a7d01e68988dc48d3fc130ef13  tests/review-grounding-probe.ts
97c30c13facd7a021c4681c068d7f22e5aa312e67b4d18f84f48edd4f115deaa  tests/review-grounding-rereview-probe.ts
```

## 最终结论与后续边界

**approve。** R1 的三类合法证据误拒绝已修复，普通与压缩路径均保留完整原文精确连续切片；未供给、跨 ID、拼接供给范围扩张仍被拒绝。

本结论仅是代码及合成测试验收通过，不代表已部署或已验证真实服务商质量/延迟。主会话可按原计划另行安排真实日整理与 2026-10 洞察复测，并决定是否设置 `llm.reasoningEffort`；本次没有执行这些操作，也未修改私有配置。
