# 整理历史与合并页：实施验证

## 改动

- `src/store.ts`：移除原文变更时清除结果，分开查询最近任务/成功内容；迁移旧 stale 行，重启不清空结果内容。
- `src/app.ts`：结果接口返回最近任务状态与旧成功内容，以快照计算 outdated 和 none/added/removed/mixed。
- `src/ai.ts`：分段结构、来源合法性及覆盖校验、精练保真提示词、promptVersion=2；生成期间原文变化仍保留成功快照。
- `web/app.ts`、`web/index.html`、`web/style.css`：随笔与按天浏览合并，输入→整理→原文；保留旧结果并显示状态提示；正文分段点击显示多来源，404 显示原文已删除；旧版 text 段落兼容。
- `tests/app.test.ts`、`tests/browser.ts`：更新语义并增加保留历史、变更方向、生成并发/失败、旧库迁移、来源校验、多来源/删除、浏览旧日期写作与布局回归。
- `README.md`：同步页面和删除原文后派生文字仍保留的行为说明。

## 验证范围

以下为最终完整串行运行的实际输出，总退出码 0，耗时 13.2 秒。15 个 API/单元测试通过；生产冒烟与 Chrome 浏览器全部通过（覆盖 320/390/1280 宽度）。模型调用使用 mock，未验证真实模型语义质量或真实 HTTPS 代理部署。未读取真实密码、密钥或私人正文；未重启现有本地服务。构建产物已更新，现有服务需重启加载新后端再刷新页面（刷新前保存内存草稿）。

首次浏览器执行因旧断言在保留成功内容后仍等待“手动生成”而失败；已改为等待“重新生成”，修正后完整重跑通过，最终又补充生成失败保留旧正文用例并完整运行以下命令。

## 命令

```sh
npx prettier --write README.md src/store.ts src/app.ts src/ai.ts web/app.ts web/index.html web/style.css tests/app.test.ts tests/browser.ts && npm run typecheck && npm test && npm run build && npm run test:production && CHROME_PATH='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' npm run test:browser && npm run format:check
```

## 完整输出

```text
README.md 52ms (unchanged)
src/store.ts 47ms (unchanged)
src/app.ts 34ms (unchanged)
src/ai.ts 28ms (unchanged)
web/app.ts 35ms (unchanged)
web/index.html 15ms (unchanged)
web/style.css 25ms (unchanged)
tests/app.test.ts 42ms
tests/browser.ts 50ms

> fleeting@1.0.0 typecheck
> tsc --noEmit


> fleeting@1.0.0 test
> tsx --test tests/*.test.ts

TAP version 13
# (node:14205) ExperimentalWarning: SQLite is an experimental feature and might change at any time
# (Use `node --trace-warnings ...` to show where the warning was created)
# Subtest: 允许短密码但拒绝空密码
ok 1 - 允许短密码但拒绝空密码
  ---
  duration_ms: 45.785542
  type: 'test'
  ...
# Subtest: 时区午夜边界、合法日期与服务端记录日期
ok 2 - 时区午夜边界、合法日期与服务端记录日期
  ---
  duration_ms: 11.171667
  type: 'test'
  ...
# Subtest: 旧数据库迁移和按日期补录：不编造时间，重复导入不重复，AI 仍可整理
ok 3 - 旧数据库迁移和按日期补录：不编造时间，重复导入不重复，AI 仍可整理
  ---
  duration_ms: 90.175375
  type: 'test'
  ...
# Subtest: 全私有接口鉴权、Origin、CSRF、会话 Cookie 与退出
ok 4 - 全私有接口鉴权、Origin、CSRF、会话 Cookie 与退出
  ---
  duration_ms: 79.885875
  type: 'test'
  ...
# Subtest: HTTPS Cookie、安全响应头与密码变更撤销会话
ok 5 - HTTPS Cookie、安全响应头与密码变更撤销会话
  ---
  duration_ms: 70.79025
  type: 'test'
  ...
# Subtest: 数据库重开保持原文，时区禁止静默更换，重启将未完成任务标失败
ok 6 - 数据库重开保持原文，时区禁止静默更换，重启将未完成任务标失败
  ---
  duration_ms: 24.866667
  type: 'test'
  ...
# Subtest: AI 超限在上传前拒绝
ok 7 - AI 超限在上传前拒绝
  ---
  duration_ms: 26.836125
  type: 'test'
  ...
# Subtest: 登录限速对并行失败请求生效
ok 8 - 登录限速对并行失败请求生效
  ---
  duration_ms: 109.507458
  type: 'test'
  ...
# Subtest: 保存原文、幂等重试、版本冲突、搜索、导出、重启与备份恢复
ok 9 - 保存原文、幂等重试、版本冲突、搜索、导出、重启与备份恢复
  ---
  duration_ms: 69.600708
  type: 'test'
  ...
# Subtest: 缺 AI 配置和模型错误不影响记录；错误不泄漏原文/密钥
ok 10 - 缺 AI 配置和模型错误不影响记录；错误不泄漏原文/密钥
  ---
  duration_ms: 107.470375
  type: 'test'
  ...
# Subtest: mock 日整理、月度证据与数值口径；新增/修改/删除保留旧文本并报告变更方向
ok 11 - mock 日整理、月度证据与数值口径；新增/修改/删除保留旧文本并报告变更方向
  ---
  duration_ms: 77.038875
  type: 'test'
  ...
# Subtest: 重新生成期间和失败后保留最近成功的日/月内容
ok 12 - 重新生成期间和失败后保留最近成功的日/月内容
  ---
  duration_ms: 57.70075
  type: 'test'
  ...
# Subtest: 主题统计按来源去重，多标签非百分比
ok 13 - 主题统计按来源去重，多标签非百分比
  ---
  duration_ms: 0.093
  type: 'test'
  ...
# Subtest: 生成期间继续写，来源快照失效，避免旧报告被当成最新
ok 14 - 生成期间继续写，来源快照失效，避免旧报告被当成最新
  ---
  duration_ms: 49.720417
  type: 'test'
  ...
# Subtest: 模型坏 JSON / 不合法引用 / 伪造摘录被拒绝，长材料分块覆盖
ok 15 - 模型坏 JSON / 不合法引用 / 伪造摘录被拒绝，长材料分块覆盖
  ---
  duration_ms: 29.777292
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
# duration_ms 1041.324417

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
(node:14263) ExperimentalWarning: SQLite is an experimental feature and might change at any time
(Use `node --trace-warnings ...` to show where the warning was created)
PASS 编译后的服务：明文密码自动哈希并擦除、重设撤销旧会话、原文持久化与在线备份恢复

> fleeting@1.0.0 test:browser
> npm run build && tsx tests/browser.ts


> fleeting@1.0.0 build
> tsc -p tsconfig.server.json && esbuild web/app.ts --bundle --format=esm --outfile=public/app.js && cp web/index.html web/style.css web/favicon.svg public/


  public/app.js  23.3kb

⚡ Done in 2ms
(node:14336) ExperimentalWarning: SQLite is an experimental feature and might change at any time
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
