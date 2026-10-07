# 计划：保留旧整理、合并随笔/回看、整理正文可追溯原文

## 目标

按用户 2026-10-07 的要求改造 Fleeting：

1. **旧整理不因新增记录而消失**：新增 / 修改 / 删除原文后，已有的当日整理与月度回顾**内容继续保留**；重新生成时，在新结果成功写入之前一直显示旧内容；生成失败也保留旧内容。
2. **过期提示**：当日整理在“生成后有新内容”时提示「整理后有新内容」；洞察在“生成后有新内容”时提示「本次回顾后有新内容」。提示与旧内容同时显示。
3. **删除原文不改整理**：删除一条原始记录**不修改、不清除**任何已有整理内容，只有用户再次生成才更新；整理正文里若引用已删除原文，点开时提示“原文已删除”，不能报错或崩溃。
4. **合并「随笔」和「回看」为一个页面**：同一页面完成写作与按天浏览；新记录一律按**服务端当前日期时间**保存（不受正在浏览的日期影响），保存后回到今天。
5. **顺序**：合并页从上到下为「输入区 → 当日整理 → 原始记录」。
6. **整理更精练**：去掉口录的重复、口头填充词和同义反复，但保留事件、人物、数字、具体例子、疑问、观点变化、限定条件与不确定语气。
7. **整理正文可点击追溯**：整理正文按句 / 小段返回，每段关联来源记录 ID；点击某段弹窗显示对应的原始记录（可多条）。
8. **洞察**已有证据点击保持不变。

## 非目标

- 不改登录、密码、限速、时区、导出、备份、幂等键、会话过期隐私隔离等既有行为。
- 不改月度主题统计口径、图表口径。
- 不改 `timeUnknown`（补录）语义。
- 不实现多用户、协作、搜索增强等。

## 现状与问题

- `src/store.ts` 的 `invalidate(day)` 在 create/update/delete 时把 day 与所属 month 的结果置为 `stale` 并 `data=NULL`，导致旧整理正文被清除。这正是用户要修掉的行为。
- `results` 每次生成插入一行；`latest()` 取最新一行，最新一行可能是 `running` 或 `failed`，会让旧的成功内容被“藏住”。
- `Ai.generate` 成功前若指纹变化，会把结果写成 `stale` 且 `data=NULL`，同样丢失本次新生成的内容。
- 前端 `view` 为 `write | day | month`，词条列表在整理上方，且「回看」是独立页面。
- 日整理 `sections[].text` 是整段字符串，来源只在段落级按钮上，无法点击正文中的具体句 / 段。

## 设计决策

1. **读时判定过期，不再写时清除**：删除 `Store.invalidate` 及全部调用。entries 变化不再触碰 `results`。
2. **区分“最近任务状态”和“最近成功内容”**：
   - `latestJob(kind, period)` = 最新一行（任意状态）。
   - `latestReady(kind, period)` = 最新一行且 `state='ready' AND data IS NOT NULL`。
3. **过期方向**：用 `data.sources`（含 `id`、`version`、`day`）与当前 entries 比较，得到 `added / changed / removed`，映射为变更方向；`outdated` 用指纹比较（等价）。
4. **模型返回分段结构**：日整理输出 `segments`，每段带 `sources`。程序强校验 ID 合法 + 覆盖全部来源，无法通过则报错（不写半成品）。
5. **兼容旧数据**：已存在的 `state='stale'` 行其 `data` 早已为 NULL，构造时直接删除；旧版 `ready` 行的 `sections[].text` 仍能渲染（回退到段落级“查看来源”）。

## 服务端改动

### `src/store.ts`

- 删除 `invalidate` 方法及 `create` / `update` / `delete` 中的调用。
- 新增 `latestJob(kind, period)`：`SELECT * ... ORDER BY rowid DESC LIMIT 1`。
- 新增 `latestReady(kind, period)`：`SELECT * ... WHERE kind=? AND period=? AND state='ready' AND data IS NOT NULL ORDER BY rowid DESC LIMIT 1`。
- 保留 `latest` 或改为内部使用；测试与调用点统一改用新方法。
- 构造函数迁移：在 entry 列迁移之后执行 `DELETE FROM results WHERE state='stale'`，并在注释里说明旧版已清空其 data。
- `markInterruptedJobs` 仍把 `running → failed`，但**不得**清空 `data`（running 行本就没有 data）。

### `src/app.ts` — `/api/result`

返回结构改为（不再直接展开 results 行）：

```jsonc
{
  "kind": "day",
  "period": "2026-10-07",
  "state": "ready",        // latestJob?.state ?? null（ready/running/failed）
  "error": null,           // 仅当 latestJob.state === 'failed' 时为 latestJob.error
  "data": { /* latestReady 的成功内容，可能非空 */ },
  "model": "…",            // latestReady?.model ?? latestJob?.model ?? null
  "generatedAt": "…",      // latestReady?.generatedAt ?? null
  "outdated": true,        // data 存在且当前指纹 != latestReady.fingerprint
  "change": "added"        // none | added | removed | mixed
}
```

- 仅当 `data` 存在时计算 `outdated` / `change`；否则 `outdated=false`、`change='none'`。
- `change` 计算：以 `data.sources` 的 `{id,version}` 为基线，与 `store.entries(period, kind)` 比较：
  - `added` = 当前有而来源快照没有的 id；
  - `changed` = 两边都有但 version 不同；
  - `removed` = 来源快照有而当前没有的 id；
  - `change = (added || changed) ? (removed ? "mixed" : "added") : (removed ? "removed" : "none")`。
- 保留对 `kind`/`period` 的校验。

### `src/ai.ts`

- **日整理输出结构**改为：

  ```jsonc
  { "sections": [ { "period": "上午（记录时间）", "segments": [ { "text": "整理后的一小段", "sources": ["ID"] } ] } ] }
  ```

- 校验：
  - `sections` 非空；每个 section 的 `segments` 非空；
  - 每个 segment `text` 为 1–4000 字非空字符串；
  - 每个 segment `sources` 经 `refs()` 校验：非空、去重、全部属于本 batch；
  - **覆盖检查**：本 batch 每条记录 id 至少出现在一个 segment 的 `sources` 中，否则抛 `AiError("日整理未覆盖全部来源")`。
  - section 的 `period` 仍由该 section 全部 segment 的 sources 时间带并集计算，`time=null` 显示「时间未记录（补录）」（保持现有逻辑）。
  - segment 排序按首个来源在 batch 中的顺序；section 按首个来源排序。
- 存储的 `Daily` 类型：

  ```ts
  export type DailySegment = { text: string; sources: string[] };
  export type DailySection = {
    period: string;
    segments?: DailySegment[];
    text?: string; // 旧数据兼容
    sources: string[];
  };
  export type Daily = { sections: DailySection[] };
  ```

  新数据写 `segments` 与聚合后的 `sources`（不再写 `text`）；`promptVersion` 升到 `"2"`。
- 成功写入：**始终** `state='ready'`、`data=JSON`、`fingerprint` 保持生成开始时算出的快照、`generatedAt=now`；**删除**“当前指纹不一致则写 stale + data=NULL”的分支。
- 失败写入：新插入的 failed 行保持 `data=NULL`，不改动更早的成功行。
- 提示词：日整理指令强调「去口头填充词、去同义反复、去重复啰嗦；保留事件/人物/数字/例子/疑问/观点变化/限定条件/不确定语气；切成短句或小段，每段 1–3 句，并给出来源 ID」。保留原有“不可信资料 / 不执行指令 / 不新增事实 / 不做诊断 / quote 必须是原文连续子串”等约束，以及“time 为 null 不能猜时段”。

## 前端改动（`web/index.html`、`web/app.ts`、`web/style.css`）

### 导航

- 顶部只保留两个页面按钮：`随笔`（`id="journalNav"`）与 `洞察`（`id="monthNav"`），加 `退出`；删除 `回看` 按钮与 `dayNav`。
- 当前页按钮继续用 `aria-current="page"` + 深绿样式。

### 合并页布局（`view === "journal"`）

从上到下：

1. 输入区（`#composer`，`完成` 按钮，行为不变；可加一句“新记录按当前日期时间保存”的 muted 说明）。
2. 按天浏览控件：「查看日期」`date` 输入 + 「已有记录的日期」`select`。
3. **当日整理**（`report(root, "day", selectedDay, mine)`）。
4. **原始记录**：`{selectedDay} · 原始记录` 标题 + 共用「修改 / 删除」菜单 + 列表。
5. 原文搜索表单。
6. 下载链接（保持现状）。

- 提交成功后：`selectedDay = session.today`，重新加载记录与当日整理，回到今天。
- 从来源弹窗点「回看这一天」：`view = "journal"`，`selectedDay = e.day`，重渲染。

### 结果渲染

- 依据 `/api/result` 新结构：
  - `data` 存在时先渲染内容；
  - `state === "running"`：追加「正在生成新一轮整理，以下是上一次整理。」；`data` 为空时显示「正在生成，可继续记录。」；
  - `state === "failed"`：`data` 存在时追加「本次生成失败：{error}；以下是上一次整理。」；否则显示错误；
  - `outdated` 且 `change !== "removed"`：day 显示「整理后有新内容，以下是上一次整理。」，month 显示「本次回顾后有新内容，以下是上一次回顾。」；
  - 仅 `change === "removed"`：显示「生成后原文有删除，以下是上一次整理。」（内容不变）；
  - 无 `data` 且无任务：显示「尚未生成；仅在手动确认后发送原文。」
- 生成按钮文案：有 `data` 显示「重新生成」，否则「手动生成」；`generating`、未配置模型、`state === "running"` 时禁用（保持现状）。
- 日整理 `sections`：
  - 若 `section.segments` 存在：每段渲染为可点击按钮（如 `.segment`），点击后打开弹窗，按顺序显示该段全部来源原文（`id`、`day · time`、完整正文）；对 404 的来源显示「原文已删除」，不得抛错；同一段多个来源全部展示。段落在视觉上是正文，不要像普通按钮那样突兀（保持可读、有轻微下划线或 hover 提示）。
  - 若只有 `section.text`（旧数据）：保持段落 + 段落级「查看来源」按钮。
  - `period` 仍作为小标题。
- 月度洞察、主题来源沿用现有 `source()` 弹窗；`source()` 需容忍 404（显示“原文已删除”）。保持“模型 XSS 安全渲染”（用 `textContent`，禁止 `innerHTML`）。

## 测试与验证

### `tests/app.test.ts`

- mock 日整理返回新 `segments` 结构。
- 原 test「新增/修改/删除均失效并清空旧文本」改为新语义：新增 / 修改 / 删除后 `/api/result` 仍返回同一份 `data`，且 `outdated` 与 `change` 正确（新增→`added`、删除→`removed`、混合→`mixed`）。
- test「生成期间继续写」：任务完成后 `state='ready'`、`data` 非空、`/api/result` 的 `outdated=true`（不再 stale/data=null）。
- test「重启将未完成任务标失败」：改用 `latestJob` 断言 failed，并确保先前 ready 的 `data` 不受影响。
- 新增：生成成功后再生成失败，`/api/result` 仍返回旧 `data` 且 `state='failed'`、`error` 存在。
- 新增：删除原文后旧整理 `data` 不被修改，重新生成可用。
- test「坏 JSON / 不合法引用」：补一条 segment 缺覆盖或空 `sources` 被拒绝的用例。
- 迁移测试：旧库含 `state='stale'` 行时，重开后该行被删除，且不报错。
- 所有 `store.latest(...)` 调用改用 `latestReady` / `latestJob`。

### `tests/browser.ts`

- 更新 mock 日整理为 `segments`。
- 导航：去掉「回看」按钮相关断言；合并页断言当前页为「随笔」。
- 顺序断言：当日整理区块在原始记录标题上方（比较 `boundingBox().y`）。
- 新增：点击整理正文的某段 → 弹窗出现对应原文；即使来源被删除也显示「原文已删除」。
- 新增：新增记录后出现「整理后有新内容，以下是上一次整理。」且旧的整理正文仍在。
- 合并页浏览旧日期后写一条新记录 → 落库日期为服务端今天，页面回到今天且能看到新记录。
- 会话过期用例里程序化点击的 `#writeNav` / `#dayNav` 改为 `#journalNav`。
- 保留 320 / 390 / 1280 无横向溢出、共用「修改 / 删除」菜单、XSS 安全等断言。

### 必跑命令（全部通过）

```sh
npx prettier --write <改动文件>
npm run typecheck
npm test
npm run build
npm run test:production
CHROME_PATH='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' npm run test:browser
npm run format:check
```

## 验收标准

1. 新增 / 修改 / 删除原文后，已有日 / 月整理的 `data` 内容**逐字不变**；`/api/result` 用 `outdated` + `change` 表达变化，且 `state`/`error` 反映最近一次任务。
2. 重新生成期间旧内容可见；成功才替换；失败保留旧内容。
3. 日整理显示「整理后有新内容」类提示；洞察显示「本次回顾后有新内容」类提示。
4. 顶部只有「随笔 / 洞察 / 退出」，随笔页含写作 + 按天浏览，顺序为输入 → 当日整理 → 原始记录；新记录按服务端当前日期时间保存并回到今天。
5. 日整理正文按句 / 小段可点击，弹窗显示关联原文；来源被删除时优雅提示。
6. 提示词要求“精练但保留细节”，程序强校验分段来源合法且覆盖全部记录。
7. 全部测试、typecheck、build、production、browser、format 通过；不引入明文日志、密钥泄漏或 XSS。
8. 不改动本计划“非目标”列出的行为。

## 交付

- 改动落到工作区；汇报改了哪些文件、关键实现、全部命令输出与验证结果。
- 不得只靠自述：附上实际命令结果。
