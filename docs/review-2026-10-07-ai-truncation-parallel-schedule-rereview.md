# Fleeting 独立复验：截断、并行与每日自动整理

日期：2026-10-07  
**结论：approve**

上一轮 **R1/R2 均已修复**。本次直接阅读修复后的产品代码和 Chrome 故障注入测试，独立执行六项必跑验证、后端边界探针，以及改为正向断言并扩展的 Chrome 探针（连续两轮通过）。未发现阻塞项；结论不是仅依据执行方报告或既有测试通过。

## 审查范围与安全边界

- 阅读 `web/app.ts`、`tests/browser-report-errors.ts`、`tests/browser.ts`，以及 `src/ai.ts`、`src/scheduler.ts`、`src/server.ts`、`src/store.ts`、`src/app.ts`、`src/config.ts`、相关单元/API/生产测试、README 和上一轮两个独立探针。
- 数据为合成文本；SQLite 仅 `:memory:` 或测试创建的系统临时目录；模型请求全部注入 mock。生产冒烟显式指定临时配置，清空相关环境覆盖，仅启动/停止自己的随机 loopback 端口测试进程。
- **未读取或修改私人配置/数据库，未调用真实模型，未访问或重启现有服务。** 必跑 build 更新 `dist/`、`public/` 构建产物，不等同于后端部署。
- 本次仅新增本报告、原始输出及正向 Chrome 探针，未修改产品代码或正式测试。旧版负向探针保留作历史复现材料；本次不把“复现缺陷退出 0”算作通过。

## R1：旧范围最终 GET 失败不再污染当前月任务 — 通过

**代码依据：`web/app.ts:552–600, 635–638`。**

`report()` 在发出 GET 时记录本次 `request`，成功和异常路径均核对 `epoch + reportScope + reportRequest`。GET 的 fetch/HTTP/JSON 错误在本函数内消费；旧范围异常直接返回，不再从生成操作的 `finally` 泄漏到通用按钮的无范围 `message()`。`finally` 本身仍检查范围。

**独立 Chrome 证据：**完成日任务、拦住最终日 GET；切到洞察启动月任务；再释放日 GET 为 503。等待 5600 ms（超过两个轮询间隔）后：

```json
{"passed":true,"before":"正在生成，可继续写随笔。本次仅发送所选范围的原文。","after":"正在生成，可继续写随笔。本次仅发送所选范围的原文。","currentView":"month","monthState":"running"}
```

月页标题、月任务 running 状态不变；返回随笔草稿仍保留。正式 `tests/browser-report-errors.ts` 也覆盖此时序，已随 Chrome 正式回归实跑通过。

## R2：临时轮询错误可自动恢复 — 通过

**代码依据：`web/app.ts:558–597, 644, 660–674`。**

失败现在使用**本次请求**的 `current()`，不再由上一轮轮询闭包检查错误。当前请求失败显示非破坏性提示，每 2500 ms 重试，最多额外 3 次；成功读取 running 后以默认 0 重新建立失败计数，读到 ready 不安排下一次轮询。GET 失败不会清空旧正文或草稿。

**独立 Chrome 证据：**日任务 gate 挂起 → 切页再返回（原 POST 闭包已过期）→ 下一次 GET 单独返回 503 → 放行模型。无需导航或刷新，页面自动恢复：

```json
{"passed":true,"case":"transient poll failure after returning to day","backend":"ready","buttonDisabled":false,"followupPolls":1,"status":"","waitedMs":5600}
```

旧 running 提示消失，按钮恢复；ready 后停止轮询。正式回归另断言重试提示、旧内容与草稿保留。

## 额外故障探针：有界、再次恢复、切页/退出隔离

新增 [正向 Chrome 探针](review-2026-10-07-ai-truncation-parallel-schedule-rereview-browser-probe.mjs)，基于旧复现场景改为期望行为，并增加原正式测试未完整覆盖的故障组合。两次完整运行均退出 0，无 `pageerror`。

1. **两轮连续故障，中间成功重置额度。** 注入 `route.abort("failed")`、503、200 非 JSON，连续三次失败后成功读取 running；再连续三次网络/503 失败，第 8 次读取 ready。实际 `reads=8`，按钮可用，提示清空，草稿和旧内容保留，再等 2800 ms 无新读取。证明不仅支持 HTTP 错误，也处理 fetch 拒绝与 JSON 解析失败；成功读取确实重置重试额度。
2. **重试耗尽后仍可恢复。** 返回正在生成的日页，交替注入断网/503，共 **4 次读取（首次 + 3 次重试）** 后显示“已停止自动重试”。后台随后 ready，再等 5600 ms 仍为 4 次，无无限请求。解除故障并按提示切页返回，自动读取 ready、按钮恢复、草稿保留；接着可再次发起生成。
3. **已发出的 GET 在离开后才失败。** 分别挂住正在生成页面的下一次轮询，切到月页或退出后再拒绝 fetch，同时完成后台日任务。各等待 5600 ms，旧日读取均保持 **1 次**，当前消息不被污染，没有复活的重试。返回日页可正常 ready；退出后无私有报告，重新登录草稿为空且生成按钮正常。
4. **已安排但尚未发出的重试。** 正式 `tests/browser-report-errors.ts` 覆盖失败后切页/退出，再等待 2800 ms 无旧日请求；读取上限为 4；均已实跑。对应实现为 `invalidateReport()` 清定时器并递增 scope，`clearPrivate()` 同时递增 epoch、取消在途请求。

**恢复语义说明：**连续四次读取都失败后会停止自动恢复，页面明确提示切页或刷新；本次确认网络恢复后切页即可恢复，且不会丢草稿。没有声称重试耗尽后网络一恢复就会自行继续，也不建议有未保存草稿时直接刷新。重试上限针对连续读取失败，不是任务整个生命周期的总轮询次数。

## 原计划 A/B/C 未退化的复核

### A. 自动拆分、完整输入、证据与上限

重新阅读分片/截断处理、月度层级归纳、证据校验、预算和结果写入路径。`src/ai.ts` SHA-256 与上一轮相同；同时独立重新运行后端探针，不只比较指纹：

- **日 24000 字符：**3 条各 8000 字符，含序号、首尾、中文及 emoji；第一阶段截断 14 次、第二阶段 24 次，总调用 158 次。成功核对输入及最终日正文逐 ID、逐字符、按顺序拼回完整原文，代理对完整。
- **月 120000 字符：**15 条各 8000 字符；分类和成功叶回顾输入分别完整拼回全部原文。376 次调用，单次材料最大 4181 字符，聚合截断后压缩两次；total、activeDays、主题去重计数均 15。聚合层伪造 quote 被拒，旧成功结果保留。
- **硬上限：**部分叶任务成功后，在第 512 次真实调用停止深拆分树；最终 failed，不用部分报告替换旧 ready。现有日不可恢复/月聚合不可恢复、非法来源/漏来源/结构/摘录测试也通过。
- 原文不会被模型覆盖；成功结果仅完整校验后保存。字符预算不等于服务商 token 预算；mock 全字符覆盖不代表真实模型语义无遗漏。

### B. 前后端并行与范围隔离

- `Ai.generate()` 仍在 `BEGIN IMMEDIATE` 事务内再次检查同一 kind+period 并登记 running；不同范围可并行。`latestJob/latestReady` 继续分别提供任务状态与旧成功内容。
- gate 测试实跑：day/month 同时 running，同范围重复被拒且任务总数仍为 2；日失败时月继续 running 并最终成功。
- 前端 `Set<kind:period>` 保留，各页面按钮独立。正式 Chrome 实跑日/月并行、后台月先完成不覆盖日、返回月看到最终结果、草稿保留；旧日期保存回今天后跨越 3.3 秒旧轮询窗口及旧任务完成的范围一致性回归也通过。
- R1/R2 和上述额外错误路径通过，补足上一轮缺口。来源弹窗、补录、导出、登录/CSRF、幂等保存、会话过期隔离与样式布局既有回归未失败。

### C. 01:00、时区、持久幂等与失败

`src/scheduler.ts`、`src/server.ts`、`src/store.ts` 指纹与上一轮相同，代码复核仍符合：配置时区的当地日期/小时；昨天按日历减一天；启动补检与每分钟 unref 检查；SIGTERM/SIGINT 停止定时器。

- 实跑覆盖 00:59 不调用、01:00/01:01 一次；无模型/无记录/当前来源已有成功跳过；只补昨天；跨年/闰日、Tokyo/Auckland/New_York 及 DST 重复 01:00。
- 自动尝试标识与 running 行同事务登记；手动同范围冲突不消费自动机会，月任务不阻塞；自动失败持久幂等并保留旧内容，仍可手动重试。
- 独立临时库重开探针：自动 running 已登记时重开 Store，任务恢复为 failed、标识仍在；DST 第二次 01:00 调用为 0，下一自然日新“昨天”正常两阶段调用 2 次。此为数据库恢复路径验证，不冒称真实服务商下 OS 强杀进程端到端验收。
- README 自动外发隐私说明和手动同意弹窗仍存在。调度是 01:00 起下一次 tick 执行，通常有不足一分钟粒度延迟，并非精确秒级 cron。

## 本次实际执行与证据

完整 stdout/stderr 与每条命令退出码：[原始输出](review-2026-10-07-ai-truncation-parallel-schedule-rereview-output.txt)。环境 Node v22.23.1、本机 Google Chrome。

```sh
npm run typecheck                     # 0
npm test                              # 0，24/24
npm run build                         # 0
npm run test:production               # 0
CHROME_PATH='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' npm run test:browser
                                      # 0，含正式 R1/R2 故障注入
npm run format:check                  # 0
node --test docs/review-2026-10-07-ai-truncation-parallel-schedule-probes.mjs
                                      # 0，4/4
node docs/review-2026-10-07-ai-truncation-parallel-schedule-rereview-browser-probe.mjs
                                      # 0，两次完整运行均通过
```

没有失败轮次被省略；新增探针首次运行即通过，格式化后再次完整运行通过。批准本次实现/修复验收；**没有执行部署或重启**，备份及部署仍由主会话决定。部署时须提醒：每日按配置时区 01:00 自动发送昨天私人原文到配置的模型服务；真实模型质量、token 兼容性和 HTTPS 反代仍未实测。

## 审查代码指纹（SHA-256）

- `src/ai.ts`: `602d5723d7702ad48b295a7d2816942c7e965e371ca3f08efe37ca8544c8d0e6`
- `src/scheduler.ts`: `c3df2de431560c127fb28f675666081148186d34a02fb6929eaf6ebf429e9100`
- `src/server.ts`: `8521d6203625fa6cbd3647c7ad9f72f5888ae2f0bbc0430c1f464b9ff53e97dc`
- `src/store.ts`: `5771630bfa61705f6a12e7e6e6c588459dbe0395ba2b60e5aa2c21d8fa8489a0`
- `src/app.ts`: `39e5d8b2c6727c9bd05ec298cc3d8cfebf0b7b003b17319e94652f1795eb17fa`
- `web/app.ts`: `642bfd3b9505d8dbb16cea031b7b07aca3755d62faa0d656756e3350555e45d5`
- `tests/browser.ts`: `01395f16dcd9192390e48cee5ffa08da4bf68c70a237dddcf4d8604c6601e95d`
- `tests/browser-report-errors.ts`: `cccefda2510173db1641397b85994047516162ea6f95deb1c2ab42a5cdced98b`
