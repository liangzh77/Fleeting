# 独立验收：保留历史整理与合并页面（2026-10-07）

## 结论：needs_changes

服务端历史结果保留、接口语义、分段来源校验与基础页面行为符合计划；但发现并实际复现一个前端并发范围错误，阻塞整体验收。现有自动化全部通过，不能覆盖此问题。

本次直接阅读 `src/store.ts`、`src/ai.ts`、`src/app.ts`、`web/app.ts`、`web/index.html`、`web/style.css`、三份测试与 README，并重新执行测试；没有依赖上一执行方的验证文档。仓库尚无提交，文件均未跟踪，无法提供相对上一版本的 git diff，也不能绝对证明非目标代码未曾变化；下述结论针对当前工作区实现。

## 必须修复：P2 保存回到今天后，旧日期轮询覆盖当前整理

**位置**：`web/app.ts:267–275`、`:553–556`、`:619–625`，另见 `:589–591`。

**复现**（独立 Chrome + 临时 SQLite + 阻塞 mock 模型，未访问真实配置/私人数据）：

1. 今天与旧日期 `2020-01-02` 都已有成功日整理。
2. 浏览旧日期，点击「重新生成」，让模型保持进行中超过 2.5 秒。
3. 在同页输入新记录并点击「完成」。记录正确保存到服务端今天，日期控件、原文列表、整理暂时全部切回今天。
4. 等旧日期的轮询触发：日期控件与原文标题仍为今天，但整理变回 `2020-01-02`。
5. 释放模型任务后，错日期整理仍未恢复。

**实际采样**：

```json
{"selected":"2026-10-07","heading":"2026-10-07 · 原始记录","reportMeta":"2020-01-02 · 2 条来源 · mock · 2026/10/7 09:56:09 · AI 整理，须对照原文","segments":["OLD_DAY_SENTINEL","SECOND_SOURCE"]}
```

**原因**：保存切日期复用原 `mine/epoch` 和 `reportRoot`；旧日期定时器仅校验 `mine === epoch`，因此仍然合法，调用闭包内旧 `period` 的 `report()` 并覆盖当前 DOM，同时把 `refreshReport` 改回旧日期。任务结束时再次调用该回调，延续错误。

**影响**：违背计划「保存后回到今天并重新加载当日整理」，可能让用户将旧日内容误认为今天；错误报告的「重新生成」也继续绑定旧日期。此次未发现数据库内容因此损坏。

**修复要求**：日期范围改变时，使旧范围的定时器、在途响应和刷新回调失效；可使用独立 report 范围/请求版本或安全的全页重新渲染，须保留现有草稿、幂等与会话隔离行为。补回归：旧日慢生成 → 同页保存 → 等待至少一次旧轮询 → 生成完成，整个后半程的日期、原文和整理范围必须一致。

## 其他重点核对

- **删除后 data 逐字不变：通过。** `src/store.ts:135–165` 的修改/删除仅修改 entries，latestReady 单独读取成功行。独立补测对 day/month 都直接比较 SQLite `results.data` 字符串删除前后相等（不仅是 JSON deepEqual），同时核对 API 旧对象不变及 `change=removed/outdated=true`。
- **进行中/失败保留：通过。** `src/ai.ts:163–176,345–370` 新建任务行，只更新自身；成功不再因快照变化清空；失败不改早先 ready。独立补测覆盖删除后的 running/failed，旧 data/model/generatedAt 保留，包括新任务模型名称不同的情况。重启及生成期间修改由现有测试验证。
- **接口语义：通过。** `src/app.ts:231–262` 的 state/error 来自 latestJob；data/model/generatedAt 来自 latestReady（model 无成功时回退 job）；指纹计算 outdated；新增/版本变更、删除映射 added/removed/mixed。无成功内容时 false/none。现有测试加独立补测均通过。
- **分段校验：通过。** `src/ai.ts:209–289` 对最终核对结果执行非空结构、1–4000 字符正文、batch 合法 ID、去重、覆盖和排序校验；时间带由全部来源计算，未知时间不猜测。独立补测用同 batch 两条短记录确认漏掉一条明确报「日整理未覆盖全部来源」，另测空白正文、4001 字、空来源、其他日期 ID 拒绝，以及来源去重/排序。提示词保留要求明确，promptVersion=2；真实模型语义质量未实测。
- **页面与追溯基础行为：通过，存在上述并发例外。** `web/index.html:15–17` 仅随笔/洞察/退出；`web/app.ts:312–384` 输入、日期控件、整理、原文顺序正确；`:482–509,648–669` 支持多来源、404「原文已删除」、旧 sections.text 回退。使用 textContent，无 innerHTML。实际浏览器回归覆盖布局、分段多来源、404、旧内容保留、XSS 和浏览旧日期写入今天。
- **隐私与非目标回归**：鉴权、CSRF、幂等、短密码、会话过期隔离、timeUnknown、导出/备份、布局等现有测试通过；未读写用户私有配置/数据库，未调用真实模型，未重启用户现有服务。build 更新了本地构建产物。HTTPS 反向代理部署不在此次实测范围。

## 本次实际命令与输出

常规验证串行执行，退出码 **0**：

```sh
npm run typecheck
npm test
npm run build
npm run test:production
CHROME_PATH='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' npm run test:browser
npm run format:check
```

以下为本次完整输出（没有修改应用代码或运行 prettier --write）：

```text

> fleeting@1.0.0 typecheck
> tsc --noEmit


> fleeting@1.0.0 test
> tsx --test tests/*.test.ts

TAP version 13
# (node:14928) ExperimentalWarning: SQLite is an experimental feature and might change at any time
# (Use `node --trace-warnings ...` to show where the warning was created)
# Subtest: 允许短密码但拒绝空密码
ok 1 - 允许短密码但拒绝空密码
  ---
  duration_ms: 44.234125
  type: 'test'
  ...
# Subtest: 时区午夜边界、合法日期与服务端记录日期
ok 2 - 时区午夜边界、合法日期与服务端记录日期
  ---
  duration_ms: 10.265167
  type: 'test'
  ...
# Subtest: 旧数据库迁移和按日期补录：不编造时间，重复导入不重复，AI 仍可整理
ok 3 - 旧数据库迁移和按日期补录：不编造时间，重复导入不重复，AI 仍可整理
  ---
  duration_ms: 79.807792
  type: 'test'
  ...
# Subtest: 全私有接口鉴权、Origin、CSRF、会话 Cookie 与退出
ok 4 - 全私有接口鉴权、Origin、CSRF、会话 Cookie 与退出
  ---
  duration_ms: 78.79025
  type: 'test'
  ...
# Subtest: HTTPS Cookie、安全响应头与密码变更撤销会话
ok 5 - HTTPS Cookie、安全响应头与密码变更撤销会话
  ---
  duration_ms: 71.118083
  type: 'test'
  ...
# Subtest: 数据库重开保持原文，时区禁止静默更换，重启将未完成任务标失败
ok 6 - 数据库重开保持原文，时区禁止静默更换，重启将未完成任务标失败
  ---
  duration_ms: 24.401375
  type: 'test'
  ...
# Subtest: AI 超限在上传前拒绝
ok 7 - AI 超限在上传前拒绝
  ---
  duration_ms: 25.582791
  type: 'test'
  ...
# Subtest: 登录限速对并行失败请求生效
ok 8 - 登录限速对并行失败请求生效
  ---
  duration_ms: 111.490875
  type: 'test'
  ...
# Subtest: 保存原文、幂等重试、版本冲突、搜索、导出、重启与备份恢复
ok 9 - 保存原文、幂等重试、版本冲突、搜索、导出、重启与备份恢复
  ---
  duration_ms: 70.417458
  type: 'test'
  ...
# Subtest: 缺 AI 配置和模型错误不影响记录；错误不泄漏原文/密钥
ok 10 - 缺 AI 配置和模型错误不影响记录；错误不泄漏原文/密钥
  ---
  duration_ms: 101.26125
  type: 'test'
  ...
# Subtest: mock 日整理、月度证据与数值口径；新增/修改/删除保留旧文本并报告变更方向
ok 11 - mock 日整理、月度证据与数值口径；新增/修改/删除保留旧文本并报告变更方向
  ---
  duration_ms: 75.132709
  type: 'test'
  ...
# Subtest: 重新生成期间和失败后保留最近成功的日/月内容
ok 12 - 重新生成期间和失败后保留最近成功的日/月内容
  ---
  duration_ms: 58.456708
  type: 'test'
  ...
# Subtest: 主题统计按来源去重，多标签非百分比
ok 13 - 主题统计按来源去重，多标签非百分比
  ---
  duration_ms: 0.10175
  type: 'test'
  ...
# Subtest: 生成期间继续写，来源快照失效，避免旧报告被当成最新
ok 14 - 生成期间继续写，来源快照失效，避免旧报告被当成最新
  ---
  duration_ms: 49.286041
  type: 'test'
  ...
# Subtest: 模型坏 JSON / 不合法引用 / 伪造摘录被拒绝，长材料分块覆盖
ok 15 - 模型坏 JSON / 不合法引用 / 伪造摘录被拒绝，长材料分块覆盖
  ---
  duration_ms: 28.230083
  type: 'test'
  ...
1..15
# tests 15
# suites 0
# pass 15
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 952.496208

> fleeting@1.0.0 build
> tsc -p tsconfig.server.json && esbuild web/app.ts --bundle --format=esm --outfile=public/app.js && cp web/index.html web/style.css web/favicon.svg public/


  public/app.js  23.3kb

⚡ Done in 8ms

> fleeting@1.0.0 test:production
> npm run build && tsx tests/production.ts


> fleeting@1.0.0 build
> tsc -p tsconfig.server.json && esbuild web/app.ts --bundle --format=esm --outfile=public/app.js && cp web/index.html web/style.css web/favicon.svg public/


  public/app.js  23.3kb

⚡ Done in 1ms
(node:14985) ExperimentalWarning: SQLite is an experimental feature and might change at any time
(Use `node --trace-warnings ...` to show where the warning was created)
PASS 编译后的服务：明文密码自动哈希并擦除、重设撤销旧会话、原文持久化与在线备份恢复

> fleeting@1.0.0 test:browser
> npm run build && tsx tests/browser.ts


> fleeting@1.0.0 build
> tsc -p tsconfig.server.json && esbuild web/app.ts --bundle --format=esm --outfile=public/app.js && cp web/index.html web/style.css web/favicon.svg public/


  public/app.js  23.3kb

⚡ Done in 1ms
(node:15058) ExperimentalWarning: SQLite is an experimental feature and might change at any time
(Use `node --trace-warnings ...` to show where the warning was created)
PASS 浏览器 390×844：登录、保存丢响应重试、XSS、回看、编辑、缺模型、退出、无横向溢出
PASS 浏览器 1280×900：登录、保存丢响应重试、XSS、回看、编辑、缺模型、退出、无横向溢出
PASS 浏览器 mock AI：布局顺序、分段多来源/已删除弹窗、生成中与失败保留旧正文、月度图表、模型 XSS、删除后日/月保留
PASS 独立审查回归：失败后继续编辑不丢草稿、退出取消延迟来源请求、跨午夜首页/日整理更新且保留草稿
PASS 浏览器认证过期 save 401：私有界面隐藏、请求禁用、草稿/待确认正文/幂等键恢复、主动退出清除
PASS 浏览器认证过期 background 401：私有界面隐藏、请求禁用、草稿/待确认正文/幂等键恢复、主动退出清除
PASS 合并页：旧日期写作按服务端今天保存、返回今天；新增后日/月提示且保留旧正文
PASS 浏览器日期补录：按指定日期回看，不显示编造的记录时刻

> fleeting@1.0.0 format:check
> prettier --check 'src/**/*.ts' 'web/**/*.{ts,html,css}' 'scripts/**/*.ts' 'tests/**/*.ts' '*.json'

Checking formatting...
All matched files use Prettier code style!
```

独立补测命令：

```sh
./node_modules/.bin/tsx /tmp/fleeting-independent-review/extra.mts
```

退出码 **0** 表示脚本的服务端断言通过，并成功断言存在上述前端错误；不是整体验收通过。临时脚本和原始日志位于 `/tmp/fleeting-independent-review/`。

```text
(node:15208) ExperimentalWarning: SQLite is an experimental feature and might change at any time
(Use `node --trace-warnings ...` to show where the warning was created)
PASS independent day: deleted-source SQL data byte-identical; API removed/outdated; running/failed keeps data/model/generatedAt and correct state/error
PASS independent month: deleted-source SQL data byte-identical; API removed/outdated; running/failed keeps data/model/generatedAt and correct state/error
PASS independent segments: same-batch omission, blank/4001-char/empty/foreign sources rejected; dedup and ordering verified
PASS independent concurrency intermediate: save switched date/report to today
{"selected":"2026-10-07","heading":"2026-10-07 · 原始记录","reportMeta":"2020-01-02 · 2 条来源 · mock · 2026/10/7 09:56:09 · AI 整理，须对照原文","segments":["OLD_DAY_SENTINEL","SECOND_SOURCE"]}
REPRODUCED BUG: old-day polling overwrites today report after save; date selector and records remain today
REPRODUCED BUG persists after generation completes
```
