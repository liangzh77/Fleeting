# 独立复核：整理范围并发修复（2026-10-07）

## 结论：approve

上一轮 P2「保存回今天后，旧日期轮询覆盖当前整理」已修复。本次未发现阻塞问题。结论来自直接完整阅读修复后的 `web/app.ts`、`tests/browser.ts`，独立重跑全部验证，以及额外的延迟响应 / 乱序 / 会话隔离实验；未依据执行方验证文档作结论。

## 代码证据

- `web/app.ts:27–36`：独立 `reportScope` 与 `reportRequest`。`invalidateReport()` 递增范围版本、清除定时器并置空 `refreshReport`。
- `web/app.ts:206,281,85`：全页重渲染、同页保存切回今天、清除私有会话，均撤销旧整理范围。保存没有重建输入区，也没有清理未提交草稿或重置待确认提交的机制。
- `web/app.ts:550–575`：进入 `report()` 先验证页面及范围；请求各自取得递增版本。响应返回后，必须同时匹配页面 `epoch`、范围 `reportScope` 和最新请求 `reportRequest`，才更新刷新闭包和 DOM。因此旧响应既不能绘制，也不能把 `refreshReport` 改回旧日期；同范围乱序响应同样被挡住。
- `web/app.ts:578–611,639–645`：生成按钮检查当前有效性，生成后的即时刷新及递归轮询传递原范围令牌；任务结束调用的是当前 `refreshReport`，不是旧任务的 period 闭包。旧轮询执行前也检查有效性。
- `web/app.ts:67–125,250–305`：`clearPrivate` 仍递增认证版本并中止请求；`api()` 仍校验认证版本。保存仍用 `pendingText` 和原幂等键确认旧提交，成功后才轮换键；401 保留内存草稿，主动退出清除。现有回归与独立补测均通过。

## 新增回归审查

`tests/browser.ts:650–737` 的确构造了旧日慢生成，而非只检查静态页面：保存后检查服务端落库日期、日期控件、原文标题/正文/日期、整理元信息及正文；连续 11 轮、每轮等待 300ms，跨过 2.5 秒旧轮询周期；释放旧任务后等待今天的结果请求并再检查一致性。

该仓库回归主要覆盖定时器路径，未主动扣住旧 `/api/result` 响应。本次因此独立补测以下路径，不把定时器通过等同于全部异步路径通过。

## 独立补测及实际结果

在临时 SQLite、随机本地端口、独立 Chrome context 和阻塞 mock 模型中执行：

1. **原始复现路径**：旧日重新生成 → 同页保存回今天 → 连续检查 3.6 秒 → 释放模型 → 验证最终刷新今天。日期、原文及整理均正确；保存后新输入的草稿保留。
2. **旧在途响应**：等待旧日轮询真的发出，用 Playwright 扣住已获取的 `running` 响应；保存回今天后才放回旧响应。旧响应被丢弃，接下来 3.6 秒没有派生新的旧日请求；模型完成仍刷新今天。MutationObserver 未记录任何旧日整理回写（0 次）。
3. **同范围响应乱序**：扣住旧 `running` 轮询响应，先让生成完成并呈现新 `ready` 响应，再交付旧响应。新生成时间保留，没有恢复 running 提示，重新生成按钮保持可用。
4. **会话隔离**：扣住旧日结果响应 → 使测试会话过期 → 401 清私有 UI → 重新登录今天 → 交付旧响应。旧整理没有重新绘制，草稿恢复，浏览器 pageerror 为空。
5. 重跑上一轮的服务端独立补测：日/月删除来源后 SQL `results.data` 字符串逐字不变；running/failed 保留成功数据及正确元信息；分段漏覆盖、空白/超长正文、空/跨日期来源拒绝，去重及排序正确。

仓库浏览器回归另外实际验证了丢响应重试、待确认正文与幂等键一致、失败后新草稿保留、保存/后台两条 401 路径、主动退出清除、跨午夜、320/390/1280 布局与 XSS。

## 实际命令

以下六项全部退出 **0**，单元/API 测试 **15/15** 通过：

```sh
npm run typecheck
npm test
npm run build
npm run test:production
CHROME_PATH='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' npm run test:browser
npm run format:check
```

独立补测退出 **0**：

```sh
./node_modules/.bin/tsx /tmp/fleeting-scope-rereview/extra.mts
```

原始脚本和日志保留在 `/tmp/fleeting-scope-rereview/`。本次只新增此复核文档，未修改应用或测试源码；build 更新了构建产物，未重启用户现有服务。未访问真实配置、私人数据库或真实模型。真实模型语义质量与 HTTPS 代理部署不在此次实测范围。

仓库尚无提交、文件未跟踪，不能提供相对上一轮的可靠 git diff；本次结论针对实际工作区。以下文件 SHA-256 在验证前后相同：

```text
a9b61eff82acc4b63a1410a280e1b401b0132cb32f32a3ef0bbbe3183e96ce35  web/app.ts
b817c1bf21a03b18d549b9142fff470bfc213c62f460b80c49edb9fefb65e24f  tests/browser.ts
5771630bfa61705f6a12e7e6e6c588459dbe0395ba2b60e5aa2c21d8fa8489a0  src/store.ts
39e5d8b2c6727c9bd05ec298cc3d8cfebf0b7b003b17319e94652f1795eb17fa  src/app.ts
6df6b79a5be53e6dacc1ad70dea60d53681cf17842c57307437d1fbe4116efa7  src/ai.ts
```

## 常规验证完整输出

```text

> fleeting@1.0.0 typecheck
> tsc --noEmit

EXIT typecheck=0

> fleeting@1.0.0 test
> tsx --test tests/*.test.ts

TAP version 13
# (node:16277) ExperimentalWarning: SQLite is an experimental feature and might change at any time
# (Use `node --trace-warnings ...` to show where the warning was created)
# Subtest: 允许短密码但拒绝空密码
ok 1 - 允许短密码但拒绝空密码
  ---
  duration_ms: 42.57425
  type: 'test'
  ...
# Subtest: 时区午夜边界、合法日期与服务端记录日期
ok 2 - 时区午夜边界、合法日期与服务端记录日期
  ---
  duration_ms: 9.932625
  type: 'test'
  ...
# Subtest: 旧数据库迁移和按日期补录：不编造时间，重复导入不重复，AI 仍可整理
ok 3 - 旧数据库迁移和按日期补录：不编造时间，重复导入不重复，AI 仍可整理
  ---
  duration_ms: 74.540625
  type: 'test'
  ...
# Subtest: 全私有接口鉴权、Origin、CSRF、会话 Cookie 与退出
ok 4 - 全私有接口鉴权、Origin、CSRF、会话 Cookie 与退出
  ---
  duration_ms: 76.987375
  type: 'test'
  ...
# Subtest: HTTPS Cookie、安全响应头与密码变更撤销会话
ok 5 - HTTPS Cookie、安全响应头与密码变更撤销会话
  ---
  duration_ms: 68.877875
  type: 'test'
  ...
# Subtest: 数据库重开保持原文，时区禁止静默更换，重启将未完成任务标失败
ok 6 - 数据库重开保持原文，时区禁止静默更换，重启将未完成任务标失败
  ---
  duration_ms: 23.800542
  type: 'test'
  ...
# Subtest: AI 超限在上传前拒绝
ok 7 - AI 超限在上传前拒绝
  ---
  duration_ms: 25.638541
  type: 'test'
  ...
# Subtest: 登录限速对并行失败请求生效
ok 8 - 登录限速对并行失败请求生效
  ---
  duration_ms: 106.74875
  type: 'test'
  ...
# Subtest: 保存原文、幂等重试、版本冲突、搜索、导出、重启与备份恢复
ok 9 - 保存原文、幂等重试、版本冲突、搜索、导出、重启与备份恢复
  ---
  duration_ms: 67.914042
  type: 'test'
  ...
# Subtest: 缺 AI 配置和模型错误不影响记录；错误不泄漏原文/密钥
ok 10 - 缺 AI 配置和模型错误不影响记录；错误不泄漏原文/密钥
  ---
  duration_ms: 99.825208
  type: 'test'
  ...
# Subtest: mock 日整理、月度证据与数值口径；新增/修改/删除保留旧文本并报告变更方向
ok 11 - mock 日整理、月度证据与数值口径；新增/修改/删除保留旧文本并报告变更方向
  ---
  duration_ms: 72.481541
  type: 'test'
  ...
# Subtest: 重新生成期间和失败后保留最近成功的日/月内容
ok 12 - 重新生成期间和失败后保留最近成功的日/月内容
  ---
  duration_ms: 56.840917
  type: 'test'
  ...
# Subtest: 主题统计按来源去重，多标签非百分比
ok 13 - 主题统计按来源去重，多标签非百分比
  ---
  duration_ms: 0.077875
  type: 'test'
  ...
# Subtest: 生成期间继续写，来源快照失效，避免旧报告被当成最新
ok 14 - 生成期间继续写，来源快照失效，避免旧报告被当成最新
  ---
  duration_ms: 48.42625
  type: 'test'
  ...
# Subtest: 模型坏 JSON / 不合法引用 / 伪造摘录被拒绝，长材料分块覆盖
ok 15 - 模型坏 JSON / 不合法引用 / 伪造摘录被拒绝，长材料分块覆盖
  ---
  duration_ms: 27.511625
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
# duration_ms 902.7405
EXIT test=0

> fleeting@1.0.0 build
> tsc -p tsconfig.server.json && esbuild web/app.ts --bundle --format=esm --outfile=public/app.js && cp web/index.html web/style.css web/favicon.svg public/


  public/app.js  23.9kb

⚡ Done in 1ms
EXIT build=0

> fleeting@1.0.0 test:production
> npm run build && tsx tests/production.ts


> fleeting@1.0.0 build
> tsc -p tsconfig.server.json && esbuild web/app.ts --bundle --format=esm --outfile=public/app.js && cp web/index.html web/style.css web/favicon.svg public/


  public/app.js  23.9kb

⚡ Done in 1ms
(node:16334) ExperimentalWarning: SQLite is an experimental feature and might change at any time
(Use `node --trace-warnings ...` to show where the warning was created)
PASS 编译后的服务：明文密码自动哈希并擦除、重设撤销旧会话、原文持久化与在线备份恢复
EXIT production=0

> fleeting@1.0.0 test:browser
> npm run build && tsx tests/browser.ts


> fleeting@1.0.0 build
> tsc -p tsconfig.server.json && esbuild web/app.ts --bundle --format=esm --outfile=public/app.js && cp web/index.html web/style.css web/favicon.svg public/


  public/app.js  23.9kb

⚡ Done in 1ms
(node:16423) ExperimentalWarning: SQLite is an experimental feature and might change at any time
(Use `node --trace-warnings ...` to show where the warning was created)
PASS 浏览器 390×844：登录、保存丢响应重试、XSS、回看、编辑、缺模型、退出、无横向溢出
PASS 浏览器 1280×900：登录、保存丢响应重试、XSS、回看、编辑、缺模型、退出、无横向溢出
PASS 浏览器 mock AI：布局顺序、分段多来源/已删除弹窗、生成中与失败保留旧正文、月度图表、模型 XSS、删除后日/月保留
PASS 独立审查回归：失败后继续编辑不丢草稿、退出取消延迟来源请求、跨午夜首页/日整理更新且保留草稿
PASS 浏览器认证过期 save 401：私有界面隐藏、请求禁用、草稿/待确认正文/幂等键恢复、主动退出清除
PASS 浏览器认证过期 background 401：私有界面隐藏、请求禁用、草稿/待确认正文/幂等键恢复、主动退出清除
PASS 慢生成范围隔离：旧日生成中保存回今天，超过旧轮询周期及生成完成后日期/原文/整理始终一致
PASS 合并页：旧日期写作按服务端今天保存、返回今天；新增后日/月提示且保留旧正文
PASS 浏览器日期补录：按指定日期回看，不显示编造的记录时刻
EXIT browser=0

> fleeting@1.0.0 format:check
> prettier --check 'src/**/*.ts' 'web/**/*.{ts,html,css}' 'scripts/**/*.ts' 'tests/**/*.ts' '*.json'

Checking formatting...
All matched files use Prettier code style!
EXIT format=0
```

## 独立补测完整输出

```text
(node:16506) ExperimentalWarning: SQLite is an experimental feature and might change at any time
(Use `node --trace-warnings ...` to show where the warning was created)
PASS independent day: deleted-source SQL data byte-identical; API removed/outdated; running/failed keeps data/model/generatedAt and correct state/error
PASS independent month: deleted-source SQL data byte-identical; API removed/outdated; running/failed keeps data/model/generatedAt and correct state/error
PASS independent segments: same-batch omission, blank/4001-char/empty/foreign sources rejected; dedup and ordering verified
{"case":"old-timer","selected":"2026-10-07","reportMeta":"2026-10-07 · 1 条来源 · mock · 2026/10/7 10:02:41 · AI 整理，须对照原文","segments":["TODAY_SENTINEL"],"staleDomMutations":0}
PASS independent original 2.5s polling reproduction fixed; 3.6s continuous range checks, task completion and draft preservation
{"case":"late-old-response","selected":"2026-10-07","reportMeta":"2026-10-07 · 1 条来源 · mock · 2026/10/7 10:02:41 · AI 整理，须对照原文","segments":["TODAY_SENTINEL"],"staleDomMutations":0}
PASS independent in-flight old result discarded, no recursive old poll; 3.6s continuous range checks, task completion and draft preservation
PASS independent same-scope response ordering: late running poll cannot overwrite newer ready response
PASS independent session isolation: delayed old report across 401/relogin cannot paint; draft retained, private UI cleared
EXIT independent=0
```
