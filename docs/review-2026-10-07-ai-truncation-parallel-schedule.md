# Fleeting 独立验收：截断、并行与每日自动整理

日期：2026-10-07  
**结论：needs_changes**

六项必跑检查全部退出 0（单元/API 测试 24/24），但额外 Chrome 故障注入复现了两个前端阻塞项：**旧范围刷新失败污染当前任务消息；切页回来后一次轮询失败会永久停更任务状态**。因此不能以既有测试通过判定 approve。

## 验收方式与安全边界

- 直接阅读 `src/ai.ts`、`src/scheduler.ts`、`src/server.ts`、`src/store.ts`、`src/app.ts`、`src/config.ts`、`web/app.ts`、全部相关测试及 README；未依赖执行方验证报告或自述。
- 模型调用全部注入 mock；数据全部为合成文本，使用 `:memory:` 或系统临时目录 SQLite。浏览器与生产冒烟只访问测试创建的随机 loopback 端口。未读取真实私有配置/数据库，未调用真实模型、未访问或重启既有服务。
- 仅新增本报告、原始输出及两个独立探针脚本；未修改产品代码、既有测试。必跑 build 更新了 `dist/`、`public/` 构建文件，**不代表部署验收通过**。
- 原始输出：[review-2026-10-07-ai-truncation-parallel-schedule-output.txt](review-2026-10-07-ai-truncation-parallel-schedule-output.txt)。运行环境 Node v22.23.1、本机 Chrome。

## 必须修复

### R1 / P2：旧日整理的最终刷新失败，会覆盖当前月任务消息

**位置：`web/app.ts:611–614`、`web/app.ts:60`。**

生成操作的 `finally` 在请求开始前核对 `epoch/reportScope`，随后 `await report(...)`。如果等待过程中用户切页，而该请求随后返回 503 或网络错误，异常从 `finally` 直接逃出，最终进入通用 `button()` 的无条件 `message(e.message)`。`report()` 的 `current()` 只在 API 成功返回后检查，不能隔离这条异常路径。

**独立复现（已重复运行）：**

1. 启动日任务并完成模型 mock。
2. 暂停其 `finally` 发出的 `/api/result?kind=day&...` 请求。
3. 切到洞察并启动被 gate 挂起的月任务；确认月任务仍为 `running`。
4. 释放旧日刷新，返回合成错误 `503 {error:"REVIEW_OLD_DAY_REFRESH_FAILED"}`。

实际输出：

```json
{"reproduced":true,"before":"正在生成，可继续写随笔。本次仅发送所选范围的原文。","after":"REVIEW_OLD_DAY_REFRESH_FAILED","currentView":"month","monthState":"running"}
```

月度正文没有被旧日正文覆盖，草稿也未丢；但当前月任务消息被旧日错误替换，违反计划 B 对“各自消息只属于其范围、旧响应不可覆盖当前范围”的要求。

**修复方向：**最终刷新及其他 report 异常路径都要在响应/异常处理时检查所属范围与请求版本；过期错误必须被消费，不能泄漏到无范围保护的通用按钮 catch。补充“最终 GET 已发出 → 切页启动另一任务 → 旧 GET 失败”的回归，而非只覆盖 POST 完成或 GET 成功。

### R2 / P2：切页回来后，一次轮询失败会使生成按钮永久停在禁用状态

**位置：`web/app.ts:560–564`、`web/app.ts:651–655`，以及 `web/app.ts:613–614` 的旧页面完成隔离。**

旧轮询回调调用 `report()` 后，后者立即递增全局 `reportRequest`。若新请求失败，外层 `.catch()` 却调用**上一次请求闭包的** `current()`，此时比较必然为 false，因此连错误也不显示。失败路径又没有重新安排轮询。用户切页回来时，原 POST 闭包的 `mine` 已过期，其完成回调正确地不刷新新页面，但这使已中止的轮询没有其他恢复渠道。

**独立复现（已重复运行）：**

1. 开始一个被模型 gate 挂起的日任务。
2. 切到洞察，再切回随笔；当前报告显示 running。
3. 仅让下一次定时 `/api/result` 返回一次 503，后续网络请求全部允许成功。
4. 释放日任务，数据库变为 `ready`；再等待 5600 ms，超过两个 2500 ms 轮询周期。

实际输出：

```json
{"reproduced":true,"case":"transient poll failure after returning to day","backend":"ready","buttonDisabled":true,"followupPolls":0,"status":"","waitedMs":5600}
```

页面一直显示“正在生成新一轮整理，以下是上一次整理”，没有后续请求、没有错误提示，重新生成按钮禁用。只有再导航或刷新才能恢复。这不是模型任务失败，也不是持续断网；只是一次短暂读取失败。

**修复方向：**由本次请求自己的令牌处理失败；当前范围轮询失败后应可恢复（例如范围安全的退避重试，并显示非破坏性状态）。切页/退出仍需取消旧重试。回归需验证：仅一次 503 后，无需用户导航/刷新，最终显示成功结果并恢复按钮；旧范围重试不能复活。

## 对计划重点的实际复核

### A. 截断全覆盖、月度真实性与预算：本次未发现阻塞项

- 长单条在调用前按最多 2000 UTF-16 code units 分片、批次正文最多 4000；重复来源 ID 不共批。`textBoundary()` 避免拆断代理对。截断父任务不写部分结果，拆出的子任务按顺序插入并重新完整处理；日第一/第二阶段的截断均受处理。
- 每个成功日叶批次检查合法来源与来源覆盖；月分类检查批内 ID 唯一/全覆盖，跨片段按原 ID 合并主题，计数按 ID 去重，不采用模型自报计数。
- 月分类完成的所有片段都进入叶回顾。层级归纳每次最多两个回顾及其证据，不重新附带全部原文；截断后压缩两半并重试。每层经 `validateReview()`，quote 必须是对应**完整原记录**的连续子串，日期由记录填充。
- 存在独立硬限制：每任务最多 512 次真实调用、每次 JSON 材料最多 60000 字符、原始中间回顾最多 12000 字符，单条重拆到不超过 128 字符仍截断则失败。超预算或校验失败不保存部分报告，旧 ready 保留。字符限制不是对所有服务商 token/context 限制的保证。
- 新增独立探针：3 条各 8000 字符材料，含可区分序号、首尾、中文及 emoji；日任务第一阶段截断 14 次、第二阶段 24 次，总调用 158 次，最终正文及成功核对输入均逐 ID/逐字符/按顺序等于完整原文。
- 新增独立探针：15 条各 8000 字符、共 120000 字符月材料；分类与成功叶回顾的输入分别完整拼回全部原文，不只核对 ID。包含分类/叶截断和聚合截断，376 次调用，实际最大 JSON 材料 4181 字符，压缩两次；最终 total/activeDays/主题计数均为 15。聚合层注入原文不存在的 quote 被拒绝，旧成功不替换。
- 新增独立探针：500 条记录触发部分成功的深拆分树，第 512 次真实调用后停止，任务 failed，保留旧 ready。
- 这些结果证明程序没有丢弃输入片段、证据校验有效；**不证明真实模型的语义概括无遗漏**。最终月回顾允许压缩与选择证据，不能将“来源覆盖”解释为每个事实都在最后正文出现。

### B. 并行：后端及正常路径通过，异常路径因 R1/R2 不通过

- 后端在 `BEGIN IMMEDIATE` 中再次核对同一 `kind+period` 并同步插入 running，才进入模型 await；不同范围不会被全局锁挡住。
- 重新运行 gate 测试：day/month 同时为 running，同范围重复请求拒绝且总任务数仍为 2；日失败时月仍 running 并最终成功。
- 既有真实 Chrome 集成用例通过：启动日 → 切页启动月、切回草稿保留、后台月先完成不覆盖日、返回月可见最终结果；两范围按钮状态独立。旧日期保存回今天的 3.3 秒范围检查也通过。
- 但既有用例没有注入 R1/R2 的 **GET 失败**；不能覆盖上述两个已复现边界。

### C. 01:00、时区与持久幂等：本次未发现阻塞项

- `Intl.DateTimeFormat(..., {timeZone: store.timezone, hourCycle:"h23"})` 取配置时区日历日期/小时；本地小时小于 1 不执行。`yesterday()` 仅对 YYYY-MM-DD 作 UTC 日历减一天，不用 instant 减 24 小时推本地昨天。
- 服务成功监听后 `start()` 立即补检，再每分钟 tick；因此是 01:00 起下一次 tick 执行，正常可有不足一分钟的检查粒度延迟，不是精确秒级 cron。定时器 unref，SIGTERM/SIGINT 停止定时器。
- 未配置/无记录/当前指纹已有成功均跳过；同范围手动 running 不消费自动机会。自动标识 `auto-day:<本地当天>` 与 running 行在同一事务中登记，失败后保留标识，重复 tick/同日重开不再调用。非同范围月任务可并行。
- 既有测试实跑覆盖 00:59/01:00/01:01、无配置/无记录、相同成功跳过、失败幂等与旧成功保留、手动冲突、月并行、跨年/闰日、Tokyo/Auckland/New_York 及 DST 重复 01:00。
- 新增探针在自动任务已登记且 mock 永不返回时，关闭并重新打开**临时 Store**，验证启动恢复将 running 标 failed、持久标识仍在；DST 第二次 01:00 模型调用为 0，下一自然日正常对新“昨天”调用两阶段共 2 次。这验证的是数据库重开恢复路径，不冒称真实模型在 OS 杀进程下的端到端测试。
- README 已说明自动发送昨天私人原文、服务需运行、配置时区、当日重启补做、跳过/失败手动重试；手动确认对话仍存在。

## 命令与复现材料

必跑命令均为本次独立执行，退出码均为 0：

```sh
npm run typecheck
npm test                        # 24/24
npm run build
npm run test:production
CHROME_PATH='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' npm run test:browser
npm run format:check
```

独立探针（先 build，全部仅合成数据/mock）：

```sh
node --test docs/review-2026-10-07-ai-truncation-parallel-schedule-probes.mjs
# 4/4，退出 0：日覆盖、月覆盖/证据、调用上限、重开幂等

node docs/review-2026-10-07-ai-truncation-parallel-schedule-browser-probe.mjs
# 退出 0 表示两个缺陷均成功复现，并非产品通过。
```

脚本：[后端边界探针](review-2026-10-07-ai-truncation-parallel-schedule-probes.mjs)、[Chrome 缺陷探针](review-2026-10-07-ai-truncation-parallel-schedule-browser-probe.mjs)。后者断言当前缺陷，修复后应将相应断言改为期望行为并纳入正式回归。

测试过程说明：独立后端探针首轮为 3/4；调用上限用例最初用 500 条短记录一次性建立旧成功，其候选 JSON 加原文先触发了 60000 字符材料保护，尚未进入目标上限场景。将 fixture 改为先用 1 条建立旧成功，再补到 500 条后，最终 4/4。没有因此改动产品代码；首轮输出一并保留。

## 复验门槛

修复 R1/R2，增加对应失败路径的浏览器回归并再次通过六项检查后重新独立验收。当前不批准部署或重启现有服务。真实服务商质量、token 兼容性及 HTTPS 反代仍未实测；部署时仍须明确提示每日自动外发原文的隐私影响。

## 审查代码指纹（SHA-256）

- `src/ai.ts`: `602d5723d7702ad48b295a7d2816942c7e965e371ca3f08efe37ca8544c8d0e6`
- `src/scheduler.ts`: `c3df2de431560c127fb28f675666081148186d34a02fb6929eaf6ebf429e9100`
- `src/server.ts`: `8521d6203625fa6cbd3647c7ad9f72f5888ae2f0bbc0430c1f464b9ff53e97dc`
- `src/store.ts`: `5771630bfa61705f6a12e7e6e6c588459dbe0395ba2b60e5aa2c21d8fa8489a0`
- `web/app.ts`: `4b21d007611d4454ab36fe9559a030de8df5f7dff73f2fb08802e6b02b0b90a5`
- `tests/browser.ts`: `afeb37dd3565f6a1801f0c079977a06f2bf77c9b9e9b61411f301e60fa5680ff`
