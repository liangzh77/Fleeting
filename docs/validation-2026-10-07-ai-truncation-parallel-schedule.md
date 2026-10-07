# 最终验证：自动拆分、并行生成、01:00 调度

## 范围与安全边界

- 改动：`src/ai.ts`、新增 `src/scheduler.ts`、`src/server.ts`、`web/app.ts`、README 与测试。
- 仅使用内存/临时 SQLite、测试专用配置、mock fetch；未访问真实私有配置/数据库，未调用真实模型，未重启现有本地服务。
- build 会更新被 git 忽略的 `dist/`、`public/` 产物，不代表已部署新服务端。
- 自动整理上线后会按配置时区每天 01:00 向配置服务商发送昨天的私人原文；README 已说明，手动确认保留。
- 真实模型质量未实测。本记录仅为执行方验证，**不是独立验收 approve**；独立代码复核仍待完成，禁止据此部署。

## 调整说明

- 日任务输入分片完整串接，保留 ID、补录语义和顺序；两个阶段任一截断均拆分并重做两阶段。128 字符及以下停止拆分，512 次调用封顶。
- 月分类按成功叶任务汇总，同一原始 ID 的主题取并集、统计去重。全部叶片进入带证据回顾，逐对层级归纳；聚合截断后各半压缩一次并重试一次。中间回顾/请求大小有限，逐字原文证据校验未移除。
- 同范围 running 检查与任务登记在 BEGIN IMMEDIATE 内同步完成；自动尝试标识同事务登记。失败不清除最近成功。
- 前端任务 Set 按 kind+period；旧范围完成不再刷新当前页或更新当前消息。原范围隔离回归相应改为确认旧完成不改当前状态，保留超过轮询周期的观察。
- 原长材料测试调用数从 4 改为 14（更小分片，两阶段不减少）；mock 分类输出调整到明确的 1000 字预算。原结构、伪造证据、来源覆盖回归保留。

## 完整最终命令输出

以下为同一最终工作区依次执行的六项命令 stdout/stderr 与退出码（初步执行发现并修正了旧测试的固定分块调用数、mock 信息点预算、旧完成回调刷新预期；不作为最终通过记录）。


### `npm run typecheck`

```text

> fleeting@1.0.0 typecheck
> tsc --noEmit


Exit code: 0
```

### `npm test`

```text

> fleeting@1.0.0 test
> tsx --test tests/*.test.ts

TAP version 13
# (node:20276) ExperimentalWarning: SQLite is an experimental feature and might change at any time
# (Use `node --trace-warnings ...` to show where the warning was created)
# Subtest: 日第二阶段截断也重新完成两阶段，全字符不丢
ok 1 - 日第二阶段截断也重新完成两阶段，全字符不丢
  ---
  duration_ms: 28.382833
  type: 'test'
  ...
# Subtest: 月聚合截断：压缩双方并有限重试，失败保留旧成功与完整分类
ok 2 - 月聚合截断：压缩双方并有限重试，失败保留旧成功与完整分类
  ---
  duration_ms: 5.767125
  type: 'test'
  ...
# (node:20277) ExperimentalWarning: SQLite is an experimental feature and might change at any time
# (Use `node --trace-warnings ...` to show where the warning was created)
# Subtest: 截断自动拆分：日长单条与多条完整顺序、补录语义、月分类全覆盖与证据
ok 3 - 截断自动拆分：日长单条与多条完整顺序、补录语义、月分类全覆盖与证据
  ---
  duration_ms: 36.341292
  type: 'test'
  ...
# Subtest: 不可恢复截断有界失败、旧结果不清除
ok 4 - 不可恢复截断有界失败、旧结果不清除
  ---
  duration_ms: 15.081708
  type: 'test'
  ...
# Subtest: day/month 同时 running，同范围互斥；一方失败不影响另一方
ok 5 - day/month 同时 running，同范围互斥；一方失败不影响另一方
  ---
  duration_ms: 2.891166
  type: 'test'
  ...
# Subtest: 日历昨天：年/月/闰日边界
ok 6 - 日历昨天：年/月/闰日边界
  ---
  duration_ms: 0.057125
  type: 'test'
  ...
# Subtest: 时区 00:59 跳过、01:00 一次、重启幂等、旧成功跳过、无配置/无记录
ok 7 - 时区 00:59 跳过、01:00 一次、重启幂等、旧成功跳过、无配置/无记录
  ---
  duration_ms: 4.697416
  type: 'test'
  ...
# Subtest: 自动失败持久幂等，手动冲突不消费机会，月任务不阻塞，DST 非本机时区
ok 8 - 自动失败持久幂等，手动冲突不消费机会，月任务不阻塞，DST 非本机时区
  ---
  duration_ms: 4.221667
  type: 'test'
  ...
# (node:20278) ExperimentalWarning: SQLite is an experimental feature and might change at any time
# (Use `node --trace-warnings ...` to show where the warning was created)
# Subtest: 允许短密码但拒绝空密码
ok 9 - 允许短密码但拒绝空密码
  ---
  duration_ms: 44.686042
  type: 'test'
  ...
# Subtest: 时区午夜边界、合法日期与服务端记录日期
ok 10 - 时区午夜边界、合法日期与服务端记录日期
  ---
  duration_ms: 10.6135
  type: 'test'
  ...
# Subtest: 旧数据库迁移和按日期补录：不编造时间，重复导入不重复，AI 仍可整理
ok 11 - 旧数据库迁移和按日期补录：不编造时间，重复导入不重复，AI 仍可整理
  ---
  duration_ms: 82.404625
  type: 'test'
  ...
# Subtest: 全私有接口鉴权、Origin、CSRF、会话 Cookie 与退出
ok 12 - 全私有接口鉴权、Origin、CSRF、会话 Cookie 与退出
  ---
  duration_ms: 80.560042
  type: 'test'
  ...
# Subtest: HTTPS Cookie、安全响应头与密码变更撤销会话
ok 13 - HTTPS Cookie、安全响应头与密码变更撤销会话
  ---
  duration_ms: 71.537542
  type: 'test'
  ...
# Subtest: 数据库重开保持原文，时区禁止静默更换，重启将未完成任务标失败
ok 14 - 数据库重开保持原文，时区禁止静默更换，重启将未完成任务标失败
  ---
  duration_ms: 25.164166
  type: 'test'
  ...
# Subtest: AI 超限在上传前拒绝
ok 15 - AI 超限在上传前拒绝
  ---
  duration_ms: 27.191167
  type: 'test'
  ...
# Subtest: 登录限速对并行失败请求生效
ok 16 - 登录限速对并行失败请求生效
  ---
  duration_ms: 113.579292
  type: 'test'
  ...
# Subtest: 保存原文、幂等重试、版本冲突、搜索、导出、重启与备份恢复
ok 17 - 保存原文、幂等重试、版本冲突、搜索、导出、重启与备份恢复
  ---
  duration_ms: 71.497666
  type: 'test'
  ...
# Subtest: 缺 AI 配置和模型错误不影响记录；错误不泄漏原文/密钥
ok 18 - 缺 AI 配置和模型错误不影响记录；错误不泄漏原文/密钥
  ---
  duration_ms: 104.035042
  type: 'test'
  ...
# Subtest: mock 日整理、月度证据与数值口径；新增/修改/删除保留旧文本并报告变更方向
ok 19 - mock 日整理、月度证据与数值口径；新增/修改/删除保留旧文本并报告变更方向
  ---
  duration_ms: 77.960917
  type: 'test'
  ...
# Subtest: 重新生成期间和失败后保留最近成功的日/月内容
ok 20 - 重新生成期间和失败后保留最近成功的日/月内容
  ---
  duration_ms: 60.051375
  type: 'test'
  ...
# Subtest: 主题统计按来源去重，多标签非百分比
ok 21 - 主题统计按来源去重，多标签非百分比
  ---
  duration_ms: 0.101375
  type: 'test'
  ...
# Subtest: 生成期间继续写，来源快照失效，避免旧报告被当成最新
ok 22 - 生成期间继续写，来源快照失效，避免旧报告被当成最新
  ---
  duration_ms: 49.939834
  type: 'test'
  ...
# Subtest: 模型坏 JSON / 不合法引用 / 伪造摘录被拒绝，长材料分块覆盖
ok 23 - 模型坏 JSON / 不合法引用 / 伪造摘录被拒绝，长材料分块覆盖
  ---
  duration_ms: 31.002875
  type: 'test'
  ...
# (node:20279) ExperimentalWarning: SQLite is an experimental feature and might change at any time
# (Use `node --trace-warnings ...` to show where the warning was created)
# Subtest: 调度实际归档：跨年、闰日、DST 回拨的重复 01:00 不重复调用
ok 24 - 调度实际归档：跨年、闰日、DST 回拨的重复 01:00 不重复调用
  ---
  duration_ms: 33.109833
  type: 'test'
  ...
1..24
# tests 24
# suites 0
# pass 24
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 1074.225875

Exit code: 0
```

### `npm run build`

```text

> fleeting@1.0.0 build
> tsc -p tsconfig.server.json && esbuild web/app.ts --bundle --format=esm --outfile=public/app.js && cp web/index.html web/style.css web/favicon.svg public/


  public/app.js  24.3kb

⚡ Done in 8ms

Exit code: 0
```

### `npm run test:production`

```text

> fleeting@1.0.0 test:production
> npm run build && tsx tests/production.ts


> fleeting@1.0.0 build
> tsc -p tsconfig.server.json && esbuild web/app.ts --bundle --format=esm --outfile=public/app.js && cp web/index.html web/style.css web/favicon.svg public/


  public/app.js  24.3kb

⚡ Done in 1ms
(node:20345) ExperimentalWarning: SQLite is an experimental feature and might change at any time
(Use `node --trace-warnings ...` to show where the warning was created)
PASS 编译后的服务：明文密码自动哈希并擦除、重设撤销旧会话、原文持久化与在线备份恢复

Exit code: 0
```

### `CHROME_PATH='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' npm run test:browser`

```text

> fleeting@1.0.0 test:browser
> npm run build && tsx tests/browser.ts


> fleeting@1.0.0 build
> tsc -p tsconfig.server.json && esbuild web/app.ts --bundle --format=esm --outfile=public/app.js && cp web/index.html web/style.css web/favicon.svg public/


  public/app.js  24.3kb

⚡ Done in 2ms
(node:20422) ExperimentalWarning: SQLite is an experimental feature and might change at any time
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
PASS 浏览器并行：日/月同时运行、切页按钮独立、旧完成与轮询不覆盖当前范围、草稿保留

Exit code: 0
```

### `npm run format:check`

```text

> fleeting@1.0.0 format:check
> prettier --check 'src/**/*.ts' 'web/**/*.{ts,html,css}' 'scripts/**/*.ts' 'tests/**/*.ts' '*.json'

Checking formatting...
All matched files use Prettier code style!

Exit code: 0
```

## 最后一处隐私文案调整后的完整复跑

手动生成提示改为“本次仅发送所选范围”，避免与每天自动整理昨天的授权产生矛盾。

### `npm run typecheck`

```text

> fleeting@1.0.0 typecheck
> tsc --noEmit


Exit code: 0
```

### `npm test`

```text

> fleeting@1.0.0 test
> tsx --test tests/*.test.ts

TAP version 13
# (node:20530) ExperimentalWarning: SQLite is an experimental feature and might change at any time
# (Use `node --trace-warnings ...` to show where the warning was created)
# Subtest: 日第二阶段截断也重新完成两阶段，全字符不丢
ok 1 - 日第二阶段截断也重新完成两阶段，全字符不丢
  ---
  duration_ms: 28.564667
  type: 'test'
  ...
# Subtest: 月聚合截断：压缩双方并有限重试，失败保留旧成功与完整分类
ok 2 - 月聚合截断：压缩双方并有限重试，失败保留旧成功与完整分类
  ---
  duration_ms: 7.465542
  type: 'test'
  ...
# (node:20531) ExperimentalWarning: SQLite is an experimental feature and might change at any time
# (Use `node --trace-warnings ...` to show where the warning was created)
# Subtest: 截断自动拆分：日长单条与多条完整顺序、补录语义、月分类全覆盖与证据
ok 3 - 截断自动拆分：日长单条与多条完整顺序、补录语义、月分类全覆盖与证据
  ---
  duration_ms: 34.353958
  type: 'test'
  ...
# Subtest: 不可恢复截断有界失败、旧结果不清除
ok 4 - 不可恢复截断有界失败、旧结果不清除
  ---
  duration_ms: 13.461209
  type: 'test'
  ...
# Subtest: day/month 同时 running，同范围互斥；一方失败不影响另一方
ok 5 - day/month 同时 running，同范围互斥；一方失败不影响另一方
  ---
  duration_ms: 3.902
  type: 'test'
  ...
# Subtest: 日历昨天：年/月/闰日边界
ok 6 - 日历昨天：年/月/闰日边界
  ---
  duration_ms: 0.072458
  type: 'test'
  ...
# Subtest: 时区 00:59 跳过、01:00 一次、重启幂等、旧成功跳过、无配置/无记录
ok 7 - 时区 00:59 跳过、01:00 一次、重启幂等、旧成功跳过、无配置/无记录
  ---
  duration_ms: 4.711458
  type: 'test'
  ...
# Subtest: 自动失败持久幂等，手动冲突不消费机会，月任务不阻塞，DST 非本机时区
ok 8 - 自动失败持久幂等，手动冲突不消费机会，月任务不阻塞，DST 非本机时区
  ---
  duration_ms: 4.081208
  type: 'test'
  ...
# (node:20532) ExperimentalWarning: SQLite is an experimental feature and might change at any time
# (Use `node --trace-warnings ...` to show where the warning was created)
# Subtest: 允许短密码但拒绝空密码
ok 9 - 允许短密码但拒绝空密码
  ---
  duration_ms: 45.745417
  type: 'test'
  ...
# Subtest: 时区午夜边界、合法日期与服务端记录日期
ok 10 - 时区午夜边界、合法日期与服务端记录日期
  ---
  duration_ms: 10.618333
  type: 'test'
  ...
# Subtest: 旧数据库迁移和按日期补录：不编造时间，重复导入不重复，AI 仍可整理
ok 11 - 旧数据库迁移和按日期补录：不编造时间，重复导入不重复，AI 仍可整理
  ---
  duration_ms: 79.263041
  type: 'test'
  ...
# Subtest: 全私有接口鉴权、Origin、CSRF、会话 Cookie 与退出
ok 12 - 全私有接口鉴权、Origin、CSRF、会话 Cookie 与退出
  ---
  duration_ms: 80.399875
  type: 'test'
  ...
# Subtest: HTTPS Cookie、安全响应头与密码变更撤销会话
ok 13 - HTTPS Cookie、安全响应头与密码变更撤销会话
  ---
  duration_ms: 72.564625
  type: 'test'
  ...
# Subtest: 数据库重开保持原文，时区禁止静默更换，重启将未完成任务标失败
ok 14 - 数据库重开保持原文，时区禁止静默更换，重启将未完成任务标失败
  ---
  duration_ms: 25.080667
  type: 'test'
  ...
# Subtest: AI 超限在上传前拒绝
ok 15 - AI 超限在上传前拒绝
  ---
  duration_ms: 26.615125
  type: 'test'
  ...
# Subtest: 登录限速对并行失败请求生效
ok 16 - 登录限速对并行失败请求生效
  ---
  duration_ms: 111.11625
  type: 'test'
  ...
# Subtest: 保存原文、幂等重试、版本冲突、搜索、导出、重启与备份恢复
ok 17 - 保存原文、幂等重试、版本冲突、搜索、导出、重启与备份恢复
  ---
  duration_ms: 72.134917
  type: 'test'
  ...
# Subtest: 缺 AI 配置和模型错误不影响记录；错误不泄漏原文/密钥
ok 18 - 缺 AI 配置和模型错误不影响记录；错误不泄漏原文/密钥
  ---
  duration_ms: 102.956834
  type: 'test'
  ...
# Subtest: mock 日整理、月度证据与数值口径；新增/修改/删除保留旧文本并报告变更方向
ok 19 - mock 日整理、月度证据与数值口径；新增/修改/删除保留旧文本并报告变更方向
  ---
  duration_ms: 78.66875
  type: 'test'
  ...
# Subtest: 重新生成期间和失败后保留最近成功的日/月内容
ok 20 - 重新生成期间和失败后保留最近成功的日/月内容
  ---
  duration_ms: 61.225541
  type: 'test'
  ...
# Subtest: 主题统计按来源去重，多标签非百分比
ok 21 - 主题统计按来源去重，多标签非百分比
  ---
  duration_ms: 0.101125
  type: 'test'
  ...
# Subtest: 生成期间继续写，来源快照失效，避免旧报告被当成最新
ok 22 - 生成期间继续写，来源快照失效，避免旧报告被当成最新
  ---
  duration_ms: 50.929375
  type: 'test'
  ...
# Subtest: 模型坏 JSON / 不合法引用 / 伪造摘录被拒绝，长材料分块覆盖
ok 23 - 模型坏 JSON / 不合法引用 / 伪造摘录被拒绝，长材料分块覆盖
  ---
  duration_ms: 29.169125
  type: 'test'
  ...
# (node:20533) ExperimentalWarning: SQLite is an experimental feature and might change at any time
# (Use `node --trace-warnings ...` to show where the warning was created)
# Subtest: 调度实际归档：跨年、闰日、DST 回拨的重复 01:00 不重复调用
ok 24 - 调度实际归档：跨年、闰日、DST 回拨的重复 01:00 不重复调用
  ---
  duration_ms: 31.44025
  type: 'test'
  ...
1..24
# tests 24
# suites 0
# pass 24
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 992.603792

Exit code: 0
```

### `npm run build`

```text

> fleeting@1.0.0 build
> tsc -p tsconfig.server.json && esbuild web/app.ts --bundle --format=esm --outfile=public/app.js && cp web/index.html web/style.css web/favicon.svg public/


  public/app.js  24.4kb

⚡ Done in 1ms

Exit code: 0
```

### `npm run test:production`

```text

> fleeting@1.0.0 test:production
> npm run build && tsx tests/production.ts


> fleeting@1.0.0 build
> tsc -p tsconfig.server.json && esbuild web/app.ts --bundle --format=esm --outfile=public/app.js && cp web/index.html web/style.css web/favicon.svg public/


  public/app.js  24.4kb

⚡ Done in 1ms
(node:20594) ExperimentalWarning: SQLite is an experimental feature and might change at any time
(Use `node --trace-warnings ...` to show where the warning was created)
PASS 编译后的服务：明文密码自动哈希并擦除、重设撤销旧会话、原文持久化与在线备份恢复

Exit code: 0
```

### `CHROME_PATH='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' npm run test:browser`

```text

> fleeting@1.0.0 test:browser
> npm run build && tsx tests/browser.ts


> fleeting@1.0.0 build
> tsc -p tsconfig.server.json && esbuild web/app.ts --bundle --format=esm --outfile=public/app.js && cp web/index.html web/style.css web/favicon.svg public/


  public/app.js  24.4kb

⚡ Done in 1ms
(node:20673) ExperimentalWarning: SQLite is an experimental feature and might change at any time
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
PASS 浏览器并行：日/月同时运行、切页按钮独立、旧完成与轮询不覆盖当前范围、草稿保留

Exit code: 0
```

### `npm run format:check`

```text

> fleeting@1.0.0 format:check
> prettier --check 'src/**/*.ts' 'web/**/*.{ts,html,css}' 'scripts/**/*.ts' 'tests/**/*.ts' '*.json'

Checking formatting...
All matched files use Prettier code style!

Exit code: 0
```
