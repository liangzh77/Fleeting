# Fleeting：真实模型「模型结构校验失败」修复 + 可选推理档位

## 用户报告与边界

1. 洞察（月度）用真实模型生成一次，结果显示「模型结构校验失败」。要修好，让真实模型稍有不规范输出也能完成，而不是整月失败。
2. 用户问是否用了 medium/high thinking、能否试 off。**现状：`src/ai.ts` 的请求体只发送 `model` / `messages` / `response_format` / `max_tokens`，不含任何 `reasoning` / `thinking` / `reasoning_effort` 参数**，慢来自服务商默认。要提供可选开关让用户自行尝试关闭推理，默认行为不变。
3. 不改动已有入口、录入、来源弹窗、补录、导出、登录/CSRF、样式与已通过的截断/并行/调度行为。测试不得使用真实私有配置、真实数据库或真实模型；不得泄漏原文本。

## 已确认的根因（需要在代码中修正）

- `array(v, max)` 在 `v.length > max` 时抛 `AiError("模型结构校验失败")`。prompt 写的是上限语义（洞察 2–4 条、主题 1–5 个、changes/connections 各最多 6 条、questions 最多 4 条），真实模型很常见地多给一条，于是整月直接失败。**上限应是安全阀而非严格契约**：条数超限裁剪、超长文本按字段上限截断（不切断代理对），只有硬性上限（如单数组 >2000 项、缺字段、类型错误、必填为空）才报错。
- 模型少给/给空（`limitation`、`question`、`overview` 为空，或某条洞察没有合法证据）会让整个月失败，没有修复机会。
- 结构性错误**没有任何重试**：`call()` 只在 `finish_reason='length'` 时走拆分；`Truncated` 以外的 `AiError` 直接冒泡到 `generate` 的 catch，写成 failed。分类、叶回顾、层级聚合、日整理两阶段都缺同一步。
- 模型偶尔把 JSON 包在 ```json 代码块里 → `JSON.parse` 抛错 → 被 `call()` 归为「模型网络或格式错误」，同样直接失败。
- 错误信息只有一句「模型结构校验失败」，无法定位阶段/字段，用户和运维都无从判断。

## 实现要求

### A. 容错解析（上限 = 安全阀）

- 数组：`length > max` 时**裁剪到 max**（保留前 max 项）；仅在超过硬上限（如 2000）或不是数组时报错。裁剪语义要写清并用于所有 `insights/changes/connections/questions/themes` 调用点。
- 文本：超过该字段上限时**按该上限截断**（使用 `textBoundary` 避免拆断代理对），截断后为空才算错误。`quote` 截断后仍是原文连续子串，证据校验必须继续成立。
- 必填为空/类型错误/缺字段仍然报错（不能把「模型没给内容」当成功），但要能进入下面的修复重试。
- `call()` 解析 `message.content` 时先剥离首尾 Markdown 代码块围栏（``` / ```json）再 `JSON.parse`；剥离后仍非 JSON 才按结构错误处理（并保留原有网络/HTTP 错误分类，不要把 401/400/超时误报成结构问题）。
- `validateReview` 的「整个 JSON 超过 12000 字符」上限继续保留为有界性保护，但它属于可修复错误，走修复重试。

### B. 有界「结构修复」重试

- 新增一层包裹：当某次模型调用的输出未通过结构/来源/证据校验（即 `AiError`，但**不是**网络、HTTP、超时、超预算、`Truncated`）时，把**该次模型自己的输出**、**具体校验错误描述**、**期望 JSON 结构与该次任务要求**一起发回同一模型，要求「只输出修正后的 JSON」，再校验一次。最多修复 1 次（即同一逻辑步骤最多 2 次调用），仍失败才向上抛。
- 修复调用计入现有全局调用上限（512）与材料字符预算，不允许无限重试；`Truncated` 仍走原有拆分路径，二者不要互相吞并。
- 必须在四个位置生效：月度分类、月度叶回顾（含层级聚合）、日整理第一阶段、日整理核对阶段。层级聚合的「压缩重试」逻辑保持，与修复重试共存且顺序明确。
- 修复失败时保留旧 `ready` 结果（`UPDATE ... state='failed'` 的行为不变），用户可手动重试。

### C. 可诊断但不泄密

- 结构类错误信息包含**阶段/字段**（例如「月度回顾结构校验失败：insights[0].question 为空」「月度分类结构校验失败：entries 缺失」），不得包含原文摘录、模型返回正文或凭据。前端展示沿用现有 `error` 字段即可。
- 保持错误可被现有 UI 正常显示（不加长到不可读）。

### D. 可选推理档位（默认不变）

- `Config.llm` 增加可选字段（可空字符串）：`reasoningEffort`（发送为请求体 `reasoning_effort`）与 `extraBody`（JSON 对象，用于服务商特有写法，如 `{"thinking":{"type":"disabled"}}` 或 `{"enable_thinking":false}`）。二者仅在配置后发送，默认完全不发送，保持现状与兼容性。
- 来源优先级与现有配置一致：环境变量 `LLM_REASONING_EFFORT` / `LLM_EXTRA_BODY` 覆盖 `config.local.json` 的 `llm` 字段。`extraBody` 以 JSON 字符串配置，解析失败或非对象必须启动时报错（不能静默忽略）。
- `extraBody` 禁止覆盖 `model`、`messages`、`stream`、`tools`、`response_format` 等程序自有字段（冲突时启动报错或忽略并说明，选择一种并写清）；限制序列化长度（如 2000 字符）以防配置错误。
- 请求体合并顺序：程序字段 → `reasoning_effort` → `extraBody`，但被禁止的键不得生效。
- README 用一两句说明：Fleeting 默认不发送任何 thinking 参数，慢是服务商默认；想试关闭推理可按服务商选择 `reasoningEffort` 或 `extraBody`，provider 是否支持不保证。`config.example.json` 加上注释性示例（不写真实值）。

### E. 测试

- 新增/扩展单元与 API 测试（全部 mock，合成文本）：
  1. 分类阶段多给主题（如 7 个）与超出条数 → 裁剪后成功；整月结果 themes 计数与裁剪后一致。
  2. 洞察返回 5 条（超 4）、changes 7 条（超 6）→ 裁剪且成功。
  3. `limitation`/`question` 为空、某条洞察证据缺失 → 仍能成功（空字段按既定策略处理，缺证据条目的处理策略要明确写入计划执行结果）。
  4. 首次结构错误、修复调用返回合法 JSON → 生成成功（分别覆盖月度分类、叶回顾/聚合、日两阶段至少各一处）。
  5. 修复后仍错误 → failed，错误信息含阶段/字段、不含原文，旧 `ready` 保留。
  6. 返回 ```json 围栏内容 → 解析成功。
  7. 网络错误/HTTP 500/`finish_reason='length'` 不误判为结构错误、不被修复重试吞掉（截断仍走拆分）。
  8. 修复调用计入 512 上限：构造持续结构错误的输入不会无限调用。
  9. 配置：`reasoningEffort` 仅在配置时出现在请求体；`extraBody` 合并生效；禁止键无效；`LLM_EXTRA_BODY` 非法 JSON 启动报错；默认请求体不含这些字段（回归现有测试）。
- 既有 24 项测试、Chrome 浏览器回归、production、typecheck、build、format 必须全部继续通过。

## 验收与执行

- 必跑 `npm run typecheck`、`npm test`、`npm run build`、`npm run test:production`、`CHROME_PATH='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' npm run test:browser`、`npm run format:check`，记录真实输出到 `docs/validation-2026-10-07-month-structure-repair.md`。
- 独立验收必须实际阅读代码与测试并自行构造 mock 复现「多给/少给/围栏/修复成功/修复失败/截断不误判」，不能只依赖执行方自述。结论 approve/needs_changes，报告写 `docs/review-2026-10-07-month-structure-repair.md`。
- 禁止读取真实私有配置与数据库、禁止调用真实模型、禁止重启或改动现有本地服务；验收通过后由主会话决定备份与重启。
- 修复完成、服务重新部署后，用户对已失败的月份**直接点「重新生成」**即可；不需要删除旧结果。
