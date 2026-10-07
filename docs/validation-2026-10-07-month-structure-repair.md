# 月度结构修复：完整验证输出

最终代码全量验证，仅 mock 模型、内存/临时数据库与测试服务；未访问私有配置/数据库，未调用真实模型，未重启现有服务。format 使用 .prettierignore 排除私有配置。独立验收尚待执行。


## `npm run typecheck`

```text

> fleeting@1.0.0 typecheck
> tsc --noEmit


```

Exit code: 0

## `npm test`

```text

> fleeting@1.0.0 test
> tsx --test tests/*.test.ts

TAP version 13
# (node:26452) ExperimentalWarning: SQLite is an experimental feature and might change at any time
# (Use `node --trace-warnings ...` to show where the warning was created)
# Subtest: 日第二阶段截断也重新完成两阶段，全字符不丢
ok 1 - 日第二阶段截断也重新完成两阶段，全字符不丢
  ---
  duration_ms: 34.938458
  type: 'test'
  ...
# Subtest: 月聚合截断：压缩双方并有限重试，失败保留旧成功与完整分类
ok 2 - 月聚合截断：压缩双方并有限重试，失败保留旧成功与完整分类
  ---
  duration_ms: 7.402334
  type: 'test'
  ...
# (node:26453) ExperimentalWarning: SQLite is an experimental feature and might change at any time
# (Use `node --trace-warnings ...` to show where the warning was created)
# Subtest: 截断自动拆分：日长单条与多条完整顺序、补录语义、月分类全覆盖与证据
ok 3 - 截断自动拆分：日长单条与多条完整顺序、补录语义、月分类全覆盖与证据
  ---
  duration_ms: 56.583125
  type: 'test'
  ...
# Subtest: 不可恢复截断有界失败、旧结果不清除
ok 4 - 不可恢复截断有界失败、旧结果不清除
  ---
  duration_ms: 16.308834
  type: 'test'
  ...
# Subtest: day/month 同时 running，同范围互斥；一方失败不影响另一方
ok 5 - day/month 同时 running，同范围互斥；一方失败不影响另一方
  ---
  duration_ms: 4.774125
  type: 'test'
  ...
# Subtest: 日历昨天：年/月/闰日边界
ok 6 - 日历昨天：年/月/闰日边界
  ---
  duration_ms: 0.067833
  type: 'test'
  ...
# Subtest: 时区 00:59 跳过、01:00 一次、重启幂等、旧成功跳过、无配置/无记录
ok 7 - 时区 00:59 跳过、01:00 一次、重启幂等、旧成功跳过、无配置/无记录
  ---
  duration_ms: 4.960333
  type: 'test'
  ...
# Subtest: 自动失败持久幂等，手动冲突不消费机会，月任务不阻塞，DST 非本机时区
ok 8 - 自动失败持久幂等，手动冲突不消费机会，月任务不阻塞，DST 非本机时区
  ---
  duration_ms: 5.146916
  type: 'test'
  ...
# (node:26454) ExperimentalWarning: SQLite is an experimental feature and might change at any time
# (Use `node --trace-warnings ...` to show where the warning was created)
# Subtest: quote超长裁剪后仍是连续子串；裸代码围栏也可解析
ok 9 - quote超长裁剪后仍是连续子串；裸代码围栏也可解析
  ---
  duration_ms: 36.459416
  type: 'test'
  ...
# Subtest: 叶回顾不得引用其他批原文，即使来源ID在整月合法；修复仍错给出字段且不泄密
ok 10 - 叶回顾不得引用其他批原文，即使来源ID在整月合法；修复仍错给出字段且不泄密
  ---
  duration_ms: 4.080334
  type: 'test'
  ...
# (node:26455) ExperimentalWarning: SQLite is an experimental feature and might change at any time
# (Use `node --trace-warnings ...` to show where the warning was created)
# Subtest: 月软上限裁剪、围栏、超长文本不拆代理对，主题统计与保留项一致
ok 11 - 月软上限裁剪、围栏、超长文本不拆代理对，主题统计与保留项一致
  ---
  duration_ms: 21.029792
  type: 'test'
  ...
# Subtest: 一次结构修复成功：classification，发送该次输出/错误/任务且默认无推理参数
ok 12 - 一次结构修复成功：classification，发送该次输出/错误/任务且默认无推理参数
  ---
  duration_ms: 1.220208
  type: 'test'
  ...
# Subtest: 一次结构修复成功：leaf，发送该次输出/错误/任务且默认无推理参数
ok 13 - 一次结构修复成功：leaf，发送该次输出/错误/任务且默认无推理参数
  ---
  duration_ms: 0.811875
  type: 'test'
  ...
# Subtest: 一次结构修复成功：aggregate，发送该次输出/错误/任务且默认无推理参数
ok 14 - 一次结构修复成功：aggregate，发送该次输出/错误/任务且默认无推理参数
  ---
  duration_ms: 2.163042
  type: 'test'
  ...
# Subtest: 一次结构修复成功：daily-first，发送该次输出/错误/任务且默认无推理参数
ok 15 - 一次结构修复成功：daily-first，发送该次输出/错误/任务且默认无推理参数
  ---
  duration_ms: 1.182083
  type: 'test'
  ...
# Subtest: 一次结构修复成功：daily-check，发送该次输出/错误/任务且默认无推理参数
ok 16 - 一次结构修复成功：daily-check，发送该次输出/错误/任务且默认无推理参数
  ---
  duration_ms: 0.681292
  type: 'test'
  ...
# Subtest: 少给/空值/缺证据不伪造成功，修复后成功：overview
ok 17 - 少给/空值/缺证据不伪造成功，修复后成功：overview
  ---
  duration_ms: 0.647958
  type: 'test'
  ...
# Subtest: 少给/空值/缺证据不伪造成功，修复后成功：limitation
ok 18 - 少给/空值/缺证据不伪造成功，修复后成功：limitation
  ---
  duration_ms: 1.206791
  type: 'test'
  ...
# Subtest: 少给/空值/缺证据不伪造成功，修复后成功：question
ok 19 - 少给/空值/缺证据不伪造成功，修复后成功：question
  ---
  duration_ms: 0.763959
  type: 'test'
  ...
# Subtest: 少给/空值/缺证据不伪造成功，修复后成功：evidence
ok 20 - 少给/空值/缺证据不伪造成功，修复后成功：evidence
  ---
  duration_ms: 0.76625
  type: 'test'
  ...
# Subtest: 少给/空值/缺证据不伪造成功，修复后成功：insights
ok 21 - 少给/空值/缺证据不伪造成功，修复后成功：insights
  ---
  duration_ms: 0.522084
  type: 'test'
  ...
# Subtest: 少给/空值/缺证据不伪造成功，修复后成功：size
ok 22 - 少给/空值/缺证据不伪造成功，修复后成功：size
  ---
  duration_ms: 0.777084
  type: 'test'
  ...
# Subtest: 少给/空值/缺证据不伪造成功，修复后成功：hard-array
ok 23 - 少给/空值/缺证据不伪造成功，修复后成功：hard-array
  ---
  duration_ms: 0.627958
  type: 'test'
  ...
# Subtest: 修复后仍失败：阶段/字段可诊断、原文不泄漏、旧 ready 保留
ok 24 - 修复后仍失败：阶段/字段可诊断、原文不泄漏、旧 ready 保留
  ---
  duration_ms: 1.565166
  type: 'test'
  ...
# Subtest: 非结构错误不修复：network
ok 25 - 非结构错误不修复：network
  ---
  duration_ms: 0.48975
  type: 'test'
  ...
# Subtest: 非结构错误不修复：timeout
ok 26 - 非结构错误不修复：timeout
  ---
  duration_ms: 0.428667
  type: 'test'
  ...
# Subtest: 非结构错误不修复：http500
ok 27 - 非结构错误不修复：http500
  ---
  duration_ms: 0.411125
  type: 'test'
  ...
# Subtest: 非结构错误不修复：http401
ok 28 - 非结构错误不修复：http401
  ---
  duration_ms: 0.549833
  type: 'test'
  ...
# Subtest: 非结构错误不修复：http400
ok 29 - 非结构错误不修复：http400
  ---
  duration_ms: 0.490125
  type: 'test'
  ...
# Subtest: 修复调用截断仍拆分；拆分父步骤不被结构修复吞掉
ok 30 - 修复调用截断仍拆分；拆分父步骤不被结构修复吞掉
  ---
  duration_ms: 0.916125
  type: 'test'
  ...
# Subtest: 修复共享512预算：持续拆分+坏结构至上限后停止
ok 31 - 修复共享512预算：持续拆分+坏结构至上限后停止
  ---
  duration_ms: 26.899541
  type: 'test'
  ...
# Subtest: 配置推理参数仅按需发送、extraBody合并与禁止键/非法JSON/长度启动报错
ok 32 - 配置推理参数仅按需发送、extraBody合并与禁止键/非法JSON/长度启动报错
  ---
  duration_ms: 3.839333
  type: 'test'
  ...
# Subtest: API真实响应沿用error字段，修复失败仍返回旧成功内容
ok 33 - API真实响应沿用error字段，修复失败仍返回旧成功内容
  ---
  duration_ms: 70.08325
  type: 'test'
  ...
# (node:26456) ExperimentalWarning: SQLite is an experimental feature and might change at any time
# (Use `node --trace-warnings ...` to show where the warning was created)
# Subtest: 允许短密码但拒绝空密码
ok 34 - 允许短密码但拒绝空密码
  ---
  duration_ms: 48.986333
  type: 'test'
  ...
# Subtest: 时区午夜边界、合法日期与服务端记录日期
ok 35 - 时区午夜边界、合法日期与服务端记录日期
  ---
  duration_ms: 11.937167
  type: 'test'
  ...
# Subtest: 旧数据库迁移和按日期补录：不编造时间，重复导入不重复，AI 仍可整理
ok 36 - 旧数据库迁移和按日期补录：不编造时间，重复导入不重复，AI 仍可整理
  ---
  duration_ms: 86.084833
  type: 'test'
  ...
# Subtest: 全私有接口鉴权、Origin、CSRF、会话 Cookie 与退出
ok 37 - 全私有接口鉴权、Origin、CSRF、会话 Cookie 与退出
  ---
  duration_ms: 80.879083
  type: 'test'
  ...
# Subtest: HTTPS Cookie、安全响应头与密码变更撤销会话
ok 38 - HTTPS Cookie、安全响应头与密码变更撤销会话
  ---
  duration_ms: 72.241291
  type: 'test'
  ...
# Subtest: 数据库重开保持原文，时区禁止静默更换，重启将未完成任务标失败
ok 39 - 数据库重开保持原文，时区禁止静默更换，重启将未完成任务标失败
  ---
  duration_ms: 24.771417
  type: 'test'
  ...
# Subtest: AI 超限在上传前拒绝
ok 40 - AI 超限在上传前拒绝
  ---
  duration_ms: 26.313083
  type: 'test'
  ...
# Subtest: 登录限速对并行失败请求生效
ok 41 - 登录限速对并行失败请求生效
  ---
  duration_ms: 112.853209
  type: 'test'
  ...
# Subtest: 保存原文、幂等重试、版本冲突、搜索、导出、重启与备份恢复
ok 42 - 保存原文、幂等重试、版本冲突、搜索、导出、重启与备份恢复
  ---
  duration_ms: 71.085584
  type: 'test'
  ...
# Subtest: 缺 AI 配置和模型错误不影响记录；错误不泄漏原文/密钥
ok 43 - 缺 AI 配置和模型错误不影响记录；错误不泄漏原文/密钥
  ---
  duration_ms: 104.038459
  type: 'test'
  ...
# Subtest: mock 日整理、月度证据与数值口径；新增/修改/删除保留旧文本并报告变更方向
ok 44 - mock 日整理、月度证据与数值口径；新增/修改/删除保留旧文本并报告变更方向
  ---
  duration_ms: 79.087333
  type: 'test'
  ...
# Subtest: 重新生成期间和失败后保留最近成功的日/月内容
ok 45 - 重新生成期间和失败后保留最近成功的日/月内容
  ---
  duration_ms: 59.242916
  type: 'test'
  ...
# Subtest: 主题统计按来源去重，多标签非百分比
ok 46 - 主题统计按来源去重，多标签非百分比
  ---
  duration_ms: 0.087958
  type: 'test'
  ...
# Subtest: 生成期间继续写，来源快照失效，避免旧报告被当成最新
ok 47 - 生成期间继续写，来源快照失效，避免旧报告被当成最新
  ---
  duration_ms: 50.856167
  type: 'test'
  ...
# Subtest: 模型坏 JSON / 不合法引用 / 伪造摘录被拒绝，长材料分块覆盖
ok 48 - 模型坏 JSON / 不合法引用 / 伪造摘录被拒绝，长材料分块覆盖
  ---
  duration_ms: 30.682
  type: 'test'
  ...
# (node:26457) ExperimentalWarning: SQLite is an experimental feature and might change at any time
# (Use `node --trace-warnings ...` to show where the warning was created)
# Subtest: 调度实际归档：跨年、闰日、DST 回拨的重复 01:00 不重复调用
ok 49 - 调度实际归档：跨年、闰日、DST 回拨的重复 01:00 不重复调用
  ---
  duration_ms: 35.999875
  type: 'test'
  ...
1..49
# tests 49
# suites 0
# pass 49
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 1098.262459

```

Exit code: 0

## `npm run build`

```text

> fleeting@1.0.0 build
> tsc -p tsconfig.server.json && esbuild web/app.ts --bundle --format=esm --outfile=public/app.js && cp web/index.html web/style.css web/favicon.svg public/


  public/app.js  25.0kb

⚡ Done in 1ms

```

Exit code: 0

## `npm run test:production`

```text

> fleeting@1.0.0 test:production
> npm run build && tsx tests/production.ts


> fleeting@1.0.0 build
> tsc -p tsconfig.server.json && esbuild web/app.ts --bundle --format=esm --outfile=public/app.js && cp web/index.html web/style.css web/favicon.svg public/


  public/app.js  25.0kb

⚡ Done in 1ms
(node:26541) ExperimentalWarning: SQLite is an experimental feature and might change at any time
(Use `node --trace-warnings ...` to show where the warning was created)
PASS 编译后的服务：明文密码自动哈希并擦除、重设撤销旧会话、原文持久化与在线备份恢复

```

Exit code: 0

## `CHROME_PATH='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' npm run test:browser`

```text

> fleeting@1.0.0 test:browser
> npm run build && tsx tests/browser.ts


> fleeting@1.0.0 build
> tsc -p tsconfig.server.json && esbuild web/app.ts --bundle --format=esm --outfile=public/app.js && cp web/index.html web/style.css web/favicon.svg public/


  public/app.js  25.0kb

⚡ Done in 1ms
(node:26618) ExperimentalWarning: SQLite is an experimental feature and might change at any time
(Use `node --trace-warnings ...` to show where the warning was created)
PASS 浏览器 390×844：登录、保存丢响应重试、XSS、回看、编辑、缺模型、退出、无横向溢出
PASS 浏览器 1280×900：登录、保存丢响应重试、XSS、回看、编辑、缺模型、退出、无横向溢出
PASS 浏览器 mock AI：布局顺序、分段多来源/已删除弹窗、生成中与失败保留旧正文、月度图表、模型 XSS、删除后日/月保留
PASS 独立审查回归：失败后继续编辑不丢草稿、退出取消延迟来源请求、跨午夜首页/日整理更新且保留草稿
PASS 浏览器认证过期 save 401：私有界面隐藏、请求禁用、草稿/待确认正文/幂等键恢复、主动退出清除
PASS 浏览器认证过期 background 401：私有界面隐藏、请求禁用、草稿/待确认正文/幂等键恢复、主动退出清除
PASS 慢生成范围隔离：旧日生成中保存回今天，超过旧轮询周期及生成完成后日期/原文/整理始终一致
PASS 切页保留日期：洞察返回随笔仍在原查看日期
PASS 合并页：旧日期写作按服务端今天保存、返回今天；新增后日/月提示且保留旧正文
PASS 浏览器日期补录：按指定日期回看，不显示编造的记录时刻
PASS 浏览器并行：日/月同时运行、切页按钮独立、旧完成与轮询不覆盖当前范围、草稿保留
PASS Chrome R1/R2：旧最终GET 503隔离、一次轮询503自动恢复、ready停轮询、持续失败最多3次重试、切页/退出取消、旧内容与草稿保留

```

Exit code: 0

## `npm run format:check`

```text

> fleeting@1.0.0 format:check
> prettier --check 'src/**/*.ts' 'web/**/*.{ts,html,css}' 'scripts/**/*.ts' 'tests/**/*.ts' '*.json'

Checking formatting...
All matched files use Prettier code style!

```

Exit code: 0
