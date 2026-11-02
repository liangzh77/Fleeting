# Go 迁移记录（2026-11-02）

## 结论

2026-11-02 将 `liangz77.cn/fleeting/` 的后端从 Node.js/Express 原地替换为 Go 单文件服务，URL、端口、Caddy 配置和数据库文件均保持不变。生产数据 21 条原文、30 条 AI 结果、13 个记录日、原登录会话全部保留；公网验证与真实浏览器验证通过。

## 迁移前数据

- 源库：`/srv/apps/fleeting/shared/data/fleeting.sqlite`（Node `node:sqlite`，WAL）。
- 使用旧版 `deploy/backup.mjs` 做在线一致性备份，拉到本地：
  `data/pulled/fleeting-2026-11-02T06-18-00.sqlite`（已被 `.gitignore` 忽略，未提交）。
- 迁移期间读取私有配置确认 origin / timezone / 模型名 / scrypt 哈希格式；**本地不保留含 API key 的配置副本**，密钥只在服务器。
- 迁移前统计：entries **21**、results **30**、sessions **1**、distinct days **13**；会话 hash 为 `3699faf2…412f`，密码摘要为 `5d67aa93…247`。
- 本地还导出了全部原文 JSON / Markdown 方便离线核对（同目录，未提交）。

## 新架构

```text
cmd/fleeting/            进程入口：serve / backup / password / version
internal/config/         私有 JSON + 环境变量、origin/时区/extraBody 校验、明文密码一次性迁移
internal/auth/           scrypt、SHA-256、随机 token、UUID
internal/store/          SQLite schema/事务/幂等/会话/限速/结果/VACUUM INTO 备份
internal/ai/             日整理、月度分类与层级归纳、证据落地、截断拆分、结构修复、512 调用预算
internal/scheduler/      每日 01:00 自动整理昨天
internal/server/         net/http API、Cookie/CSRF/Origin、静态文件、安全响应头
web/                     免构建静态前端（index.html / app.js / style.css / favicon.svg）
deploy/                  deploy.ps1、systemd unit、bootstrap.sh、Caddy 片段
```

运行时只依赖单个 Linux 二进制（`modernc.org/sqlite` 为纯 Go，无 cgo）。systemd 的 `ExecStart=/srv/apps/fleeting/current/fleeting`，静态目录 `/srv/apps/fleeting/current/web`，监听 `127.0.0.1:3010`；Caddy 的 `handle_path /fleeting/*` 保持不变。

## 兼容性设计

- **数据库 schema 完全一致**：`meta/entries/requests/sessions/attempts/results` 表结构、列名、索引不变；启动时只做旧库 `timeUnknown` 列补齐、`stale` 结果清理、`running` 任务标失败，与 Node 版一致。
- **密码哈希兼容**：Node 默认 `crypto.scrypt(password, salt, 64)` 的参数是 N=16384、r=8、p=1，salt 为十六进制字符串本身；Go 用 `scrypt.Key([]byte(password), []byte(saltHex), 16384, 8, 1, 64)`，格式仍为 `scrypt:盐:哈希`。用 Node 生成的固定哈希做了 Go 验证测试，生产哈希无需重置。
- **会话兼容**：Cookie 名（HTTPS 下 `__Host-fleeting`）、`sessions(hash,csrf,expires)` 表、令牌 SHA-256 和 7 天过期不变，所以浏览器登录状态保留。
- **API 兼容**：所有路径、请求/响应字段、错误文案、状态码、幂等/版本冲突、导出格式、`/api/result` 的 `state/error/data/model/generatedAt/outdated/change` 语义均按旧实现移植；旧结果 JSON 原样返回。
- **AI 兼容**：系统提示词、日/月各阶段指令、字段软上限、UTF-16 长度口径、证据连续子串与空白/标点归一化、来源覆盖校验、截断拆分/压缩、结构修复一次、提示词版本 `3`、自动整理 `auto-day:<日期>` 幂等标记均保持一致。
- **前端**：原 TypeScript 前端（仅类型导入）用 esbuild 转成可直接部署的 `web/app.js`，行为不变；删除了 Node 构建链，部署不再需要 Node。

## 验证记录

### 1. Go 静态检查与测试

```text
go vet ./...        通过
go test ./...       通过（cmd/fleeting、config、auth、store、ai、scheduler、server）
```

覆盖：Node scrypt 哈希验证、配置优先级与 origin/时区/extraBody 校验、明文密码迁移、午夜/闰日/时区边界、旧库迁移、按日期补录、幂等重放/冲突、版本冲突、备份恢复、登录限速与代理地址、HTTPS Cookie/HSTS/CSRF/Origin、密码变更撤销会话、日/月生成、证据规范化与伪造证据丢弃、聚合证据边界、截断拆分与压缩、512 调用预算、自动整理幂等与 DST。备份清理回归测试 `TestPruneBackupsRemovesOldestOnly` 覆盖“只删最旧、保留最新”。

### 2. 旧 Node 版 vs 新 Go 版逐项对比

用同一份生产数据库的两个副本，同时启动旧 Node release（`20261007165400`）和 Go 版：

- 登录、`/api/session`（除随机 csrf）、`/api/dates`、全部日期的 `/api/entries`、全部日/月 `/api/result`、中文搜索、全部 JSON/Markdown 导出、静态 `index.html/style.css/favicon.svg`：**逐项深比较完全一致**。
- 负向路径：未登录、错误 Origin、缺 CSRF、空/超长搜索、非法日期/月份、未知接口、不存在原文：状态码与错误体一致。
- 写入路径：创建 201、幂等重放 200、冲突 409、更新 200、删除 200，响应字段与值一致（仅实例 id/时间戳不同）。
- 未配置模型时 `/api/generate` 均为 503 且文案一致。
- 结果：`PARITY OK: all compared responses match`。

### 3. 浏览器回归

- **本地 `/fleeting/` 子路径拓扑**（Node 代理剥前缀，Playwright + Chrome，390×844）：样式/脚本/接口全部走前缀、无根路径请求；登录；已有记录渲染；2026-10 月报与 47 个主题渲染；保存、搜索、两个导出链接均正常；无控制台错误。
- **生产 `https://liangz77.cn/fleeting/`**（注入一次性只读会话，验证后删除）：2 条当日记录、月报 47 个主题、证据/来源控件渲染；无根路径请求、无控制台错误。

### 4. 真实模型端到端（合成文本）

使用独立临时数据库和**合成测试文本**（不含真实笔记），复用生产模型的配置（Volcengine Ark / `deepseek-v4-1-flash-260910` / `reasoning_effort=none`）：

```text
create 201
generate 200 elapsed 3s
state=ready error=null model=deepseek-v4-1-flash-260910
sections=1 segments=1 sources=1 promptVersion=3 outdated=false
```

说明 Go 版能真实完成两阶段日整理、结构/来源校验并落库；临时数据库随后删除。

### 5. 备份与部署

- 部署脚本在切换前用新二进制执行 `VACUUM INTO`；三次发布各生成一份切换前备份，最新为 `fleeting-2026-11-02T07-21-54.sqlite`（entries 21 / results 30，`-rw------- fleeting fleeting`）。
- 发现并修复备份清理 bug：旧实现按 mtime 降序删除，会误删**最新**备份；改为升序删除最旧，并加回归测试。修复后发布为 `20261102-151654`。
- 以 `fleeting` 用户执行 cron 同款命令：生成 `fleeting-2026-11-02T07-17-14.sqlite`，保留 14 份，权限 0600，打开核对 entries **21**、results **30**。
- 最终发布：`current -> releases/20261102-152148`，`previous -> releases/20261102-151654`（上一版为备份修复版）；`systemctl is-active fleeting` = active，enabled；日志只有启动信息。
- 发布后数据：entries **21**、results **30**、sessions **1**、originalSessionPresent **true**；临时验证会话删除后 `/api/session` 返回 401。
- 公网：`/fleeting/`、`/app.js`、`/style.css`、`/favicon.svg` 均 200；未登录 `/fleeting/api/session` 401；CSP/HSTS/nosniff/X-Frame-Options/Cache-Control 均存在；`/private` 仍 200，`go-sites-demo` 仍 active。
- `/etc/cron.d/fleeting-backup` 已改为调用 Go 二进制 `fleeting backup -dir ... -keep 14`。

## 回滚

- 快速回滚到上一个 Go release：

  ```bash
  ln -sfn "$(readlink -f /srv/apps/fleeting/previous)" /srv/apps/fleeting/current
  systemctl restart fleeting
  curl -fsS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3010/
  ```

- 回到旧 Node release（数据 schema 仍兼容）：
  - 释放目录：`/srv/apps/fleeting/releases/20261007165400`
  - 旧 unit 备份：`/srv/apps/fleeting/shared/systemd/fleeting.service.20261102-151424`
  - 旧 cron 备份：`/srv/apps/fleeting/shared/systemd/fleeting-backup.20261102-151424`
  - 把 `current` 指回该 release，恢复 unit/cron，`systemctl daemon-reload && systemctl restart fleeting`。Node 运行时仍在服务器上，但新版不再依赖它。

## 后续变更（2026-11-02）

月度“洞察”的主题分类改为固定 10 类、每条最多 2 个标签，图表主题数硬限制 ≤10（含“其他”）；每条分类新增一句话简介（gist），洞察的“可能解释”改为“AI 对我的建议”，追问改为建议驱动，重复问题合并。2026-10 已重新生成，从 47 类降到 9 类，promptVersion 5。详见 [`monthly-theme-taxonomy.md`](monthly-theme-taxonomy.md)。

## 已知差异（不影响功能）

- 主题并列计数时的排序：Node 用 `localeCompare`，Go 用字节序；只影响同计数主题的显示顺序。
- HEAD 请求的 API 路由：Express 的 GET 路由自动响应 HEAD，Go 的 API 路由对 HEAD 返回 404 JSON；应用和测试都不使用 HEAD。
- 静态文件响应头的 `charset` 大小写、`Last-Modified` 细节由 net/http 决定；页面内容与行为一致。
- 新建结果 JSON 的字段顺序由 Go 的 map 编码决定（前端不依赖顺序）；旧结果原样返回。
