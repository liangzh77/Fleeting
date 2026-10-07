# 阻塞项修复验证：整理范围异步隔离

## 改动范围

- `web/app.ts`：独立 reportScope 范围令牌；渲染、保存刷新和会话清理时撤销旧轮询及 refreshReport。在途结果绘制前核对页面、范围与请求版本；递归轮询和刷新闭包显式携带范围令牌，旧范围不再发起请求或绘制。
- `tests/browser.ts`：旧日期已有整理 → 阻塞重新生成 → 同页保存到服务端今天 → 连续检查 3.3 秒（超过 2.5 秒轮询）→ 释放生成并等待今天刷新，再核对日期、原文标题/列表及整理全部属于今天。
- 未改服务端或保存幂等/待确认正文逻辑。既有草稿、丢响应重试和会话过期隔离回归通过。
- 测试仅使用临时数据库与 mock 模型；未访问真实配置/私人数据库，未重启现有服务。构建产物已更新。

## 实际命令

```sh
npx prettier --write web/app.ts tests/browser.ts
npm run typecheck
npm test
npm run build
npm run test:production
CHROME_PATH='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' npm run test:browser
npm run format:check
```

全部退出码 0。Prettier 输出：

```text
web/app.ts 89ms (unchanged)
tests/browser.ts 75ms
```

其余完整实际输出：

```text

> fleeting@1.0.0 typecheck
> tsc --noEmit


> fleeting@1.0.0 test
> tsx --test tests/*.test.ts

TAP version 13
# (node:15831) ExperimentalWarning: SQLite is an experimental feature and might change at any time
# (Use `node --trace-warnings ...` to show where the warning was created)
# Subtest: 允许短密码但拒绝空密码
ok 1 - 允许短密码但拒绝空密码
  ---
  duration_ms: 43.818292
  type: 'test'
  ...
# Subtest: 时区午夜边界、合法日期与服务端记录日期
ok 2 - 时区午夜边界、合法日期与服务端记录日期
  ---
  duration_ms: 10.249792
  type: 'test'
  ...
# Subtest: 旧数据库迁移和按日期补录：不编造时间，重复导入不重复，AI 仍可整理
ok 3 - 旧数据库迁移和按日期补录：不编造时间，重复导入不重复，AI 仍可整理
  ---
  duration_ms: 81.432916
  type: 'test'
  ...
# Subtest: 全私有接口鉴权、Origin、CSRF、会话 Cookie 与退出
ok 4 - 全私有接口鉴权、Origin、CSRF、会话 Cookie 与退出
  ---
  duration_ms: 79.062667
  type: 'test'
  ...
# Subtest: HTTPS Cookie、安全响应头与密码变更撤销会话
ok 5 - HTTPS Cookie、安全响应头与密码变更撤销会话
  ---
  duration_ms: 72.105
  type: 'test'
  ...
# Subtest: 数据库重开保持原文，时区禁止静默更换，重启将未完成任务标失败
ok 6 - 数据库重开保持原文，时区禁止静默更换，重启将未完成任务标失败
  ---
  duration_ms: 24.594667
  type: 'test'
  ...
# Subtest: AI 超限在上传前拒绝
ok 7 - AI 超限在上传前拒绝
  ---
  duration_ms: 26.20625
  type: 'test'
  ...
# Subtest: 登录限速对并行失败请求生效
ok 8 - 登录限速对并行失败请求生效
  ---
  duration_ms: 118.435542
  type: 'test'
  ...
# Subtest: 保存原文、幂等重试、版本冲突、搜索、导出、重启与备份恢复
ok 9 - 保存原文、幂等重试、版本冲突、搜索、导出、重启与备份恢复
  ---
  duration_ms: 73.084125
  type: 'test'
  ...
# Subtest: 缺 AI 配置和模型错误不影响记录；错误不泄漏原文/密钥
ok 10 - 缺 AI 配置和模型错误不影响记录；错误不泄漏原文/密钥
  ---
  duration_ms: 104.625958
  type: 'test'
  ...
# Subtest: mock 日整理、月度证据与数值口径；新增/修改/删除保留旧文本并报告变更方向
ok 11 - mock 日整理、月度证据与数值口径；新增/修改/删除保留旧文本并报告变更方向
  ---
  duration_ms: 75.267916
  type: 'test'
  ...
# Subtest: 重新生成期间和失败后保留最近成功的日/月内容
ok 12 - 重新生成期间和失败后保留最近成功的日/月内容
  ---
  duration_ms: 61.603417
  type: 'test'
  ...
# Subtest: 主题统计按来源去重，多标签非百分比
ok 13 - 主题统计按来源去重，多标签非百分比
  ---
  duration_ms: 0.105917
  type: 'test'
  ...
# Subtest: 生成期间继续写，来源快照失效，避免旧报告被当成最新
ok 14 - 生成期间继续写，来源快照失效，避免旧报告被当成最新
  ---
  duration_ms: 50.346541
  type: 'test'
  ...
# Subtest: 模型坏 JSON / 不合法引用 / 伪造摘录被拒绝，长材料分块覆盖
ok 15 - 模型坏 JSON / 不合法引用 / 伪造摘录被拒绝，长材料分块覆盖
  ---
  duration_ms: 31.734875
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
# duration_ms 990.450083

> fleeting@1.0.0 build
> tsc -p tsconfig.server.json && esbuild web/app.ts --bundle --format=esm --outfile=public/app.js && cp web/index.html web/style.css web/favicon.svg public/


  public/app.js  23.9kb

⚡ Done in 8ms

> fleeting@1.0.0 test:production
> npm run build && tsx tests/production.ts


> fleeting@1.0.0 build
> tsc -p tsconfig.server.json && esbuild web/app.ts --bundle --format=esm --outfile=public/app.js && cp web/index.html web/style.css web/favicon.svg public/


  public/app.js  23.9kb

⚡ Done in 1ms
(node:15892) ExperimentalWarning: SQLite is an experimental feature and might change at any time
(Use `node --trace-warnings ...` to show where the warning was created)
PASS 编译后的服务：明文密码自动哈希并擦除、重设撤销旧会话、原文持久化与在线备份恢复

> fleeting@1.0.0 test:browser
> npm run build && tsx tests/browser.ts


> fleeting@1.0.0 build
> tsc -p tsconfig.server.json && esbuild web/app.ts --bundle --format=esm --outfile=public/app.js && cp web/index.html web/style.css web/favicon.svg public/


  public/app.js  23.9kb

⚡ Done in 1ms
(node:15967) ExperimentalWarning: SQLite is an experimental feature and might change at any time
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

> fleeting@1.0.0 format:check
> prettier --check 'src/**/*.ts' 'web/**/*.{ts,html,css}' 'scripts/**/*.ts' 'tests/**/*.ts' '*.json'

Checking formatting...
All matched files use Prettier code style!

```
