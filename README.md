# Fleeting · 随笔（Go 版）

单人自托管的中文随笔应用：打开即写，按天回看；手动日整理与月度回顾。原文与 AI 结果独立保存。

本仓库已从 Node.js / Express 版迁移为 **Go 单文件后端**，前端是不需要构建的原生 HTML / CSS / JavaScript。数据库、scrypt 密码哈希、Cookie 名和会话表与旧版完全兼容，可原地升级，不需要导出导入。迁移与验证记录见 [`docs/migration-go-2026-11-02.md`](docs/migration-go-2026-11-02.md)。

## 技术选型

- **Go 1.26+**、`net/http`、单一进程同时提供 API 与静态前端；不依赖 Node / npm。
- SQLite（`modernc.org/sqlite`，纯 Go、无 cgo）：WAL、单实例、持久磁盘。schema 与旧版一致。
- 纯 Go 交叉编译：`CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build ./cmd/fleeting`。
- 前端原生 TypeScript 产物（`web/app.js`，已提交）：无框架、无第三方分析、无 CDN；所有文字用 DOM `textContent` 渲染，不执行 HTML / Markdown。
- 密码使用 scrypt（N=16384, r=8, p=1，与旧 Node 默认参数和 `scrypt:盐:哈希` 格式一致）；服务端 SQLite 会话（浏览器只持有随机令牌，库中保存令牌 SHA-256），7 天到期；CSRF 令牌 + 严格 Origin 校验。
- 单文件二进制 + 静态目录 + systemd + Caddy，与 `go-sites` 的部署方式一致。

## 本机开始

```sh
cp config.example.json config.local.json
# 生成密码哈希（从标准输入读取，不把明文放在命令行参数里）
printf '%s\n' '你的密码' | go run ./cmd/fleeting password
# 把输出的 scrypt:... 写入 config.local.json 的 passwordHash

go run ./cmd/fleeting
```

打开 **http://localhost:3000**。默认绑定 `127.0.0.1:3000`。不要换成 `127.0.0.1` 访问，除非同步修改配置中的 `origin`（Origin 校验按单值精确匹配）。

- 也可以直接在 `config.local.json` 写 `"password": "你的新密码"`（可与已有 `passwordHash` 同时存在，优先使用新的 password）。**启动时**服务会在监听前把它哈希化、写入 `passwordHash` 并删除明文字段；密码不合格或写入失败则拒绝启动。仅用可信编辑器修改该文件，权限设为 0600。
- 忘记密码：停止服务，在 `config.local.json` 写新 `password`（或重新生成 `passwordHash`），再启动。密码哈希改变会撤销所有旧会话。`PASSWORD_HASH` 环境变量若已设置会覆盖文件中的哈希。
- 私有配置文件路径可用 `FLEETING_CONFIG=/绝对路径/config.json`；应用不会自动读取 `.env`，用服务管理器注入环境变量。

配置与环境变量（环境优先）：

| 配置字段 | 环境变量 | 含义 |
| --- | --- | --- |
| origin | APP_ORIGIN | 精确的浏览器 origin，无尾斜杠、无路径 |
| timezone | APP_TIMEZONE | IANA 时区，默认 Asia/Shanghai |
| database | DATABASE_PATH | 默认 ./data/fleeting.sqlite |
| password | — | 配置文件中一次性输入明文新密码，启动时转为哈希并移除 |
| passwordHash | PASSWORD_HASH | `scrypt:盐:哈希`；兼容旧 Node 版 |
| llm.baseUrl | LLM_BASE_URL | OpenAI-compatible 基础地址，通常以 /v1 结尾 |
| llm.apiKey | LLM_API_KEY | 服务端私有密钥 |
| llm.model | LLM_MODEL | 服务商实际支持的模型名称 |
| llm.reasoningEffort | LLM_REASONING_EFFORT | 可选，发送为 `reasoning_effort`，空字符串不发送 |
| llm.extraBody | LLM_EXTRA_BODY | 可选 JSON 字符串，最多 2000 字符；非法配置启动报错 |
| — | PORT / HOST | 监听端口 / 地址 |
| — | STATIC_ROOT | 静态文件目录，默认 `web` |

数据库第一次打开时固定归档时区；后续换时区会拒绝启动，避免旧日期与新日期混用。时间存 UTC，日归属按配置时区计算，不按浏览器或服务器本地时区。编辑保持原始记录时间及日归属。

## 界面与数据行为

- 中文响应式随笔（写作与按天浏览合并）、洞察两个页面；当前页导航有 `aria-current="page"`。手机竖版标题与「随笔 / 洞察 / 退出」同一行。
- 输入区、当日整理、原始记录依次排列；可查看/搜索旧日期，今日/回看记录采用紧凑列表，选中后通过「修改 / 删除」入口操作。密码登录，无注册。`Cmd/Ctrl+Enter` 保存，普通 Enter 换行。
- 保存使用幂等标识，丢响应重试不重复；版本冲突保护；原文永不删除、编辑保留 `createdAt` 与日归属；删除是永久删除，导出/备份不受影响。
- 今日记录（恢复可见/焦点及每分钟向服务端校准日期，跨午夜保留草稿）、选日期、已有记录日期列表、精确子串搜索（最多 200 条）、全部 JSON / 当日 Markdown 导出。
- 页面内存草稿随导航保留，刷新/关闭会丢失；不往 localStorage 写私人文字。
- 新增/修改/删除后已有日/月整理内容不变，读时按来源快照判定过期并提示新增/修改或删除；重新生成期间及失败后仍显示旧内容，成功才替换。删除原文不会清除已有整理里的派生文字；只有再次生成才更新当前展示。

## AI 整理

配置 `baseUrl/apiKey/model` 三项即启用；未配置时记录、回看、搜索、导出不受影响，AI 明确不可用。

- **日整理**：当日全部原文按时间排序；每块最多 4000 字符，长单条按 2000 字符片段完整拆分；两阶段（整理 + 对照原文核对）；粗时间段由服务端依据来源记录时间计算；短句/小段可点击查看关联原文；截断自动拆半重试；去口录重复但保留具体细节。
- **月度回顾**：分块抽取信息点与多标签分类；每个片段先生成带精确证据的回顾，再层级归纳全部回顾和证据；阶段概括、主题条形图、事实/推测分离的洞察、思考变化、可能联系、开放问题与日期/原文证据。图表由程序按结构化分类的**唯一记录 ID**计数，不相信模型的日期/数字/计数；分类标签可能误判，频次不是生活占比。
- **证据校验**：模型输出经过结构、来源 ID、摘录连续子串校验；无法落地的证据丢弃并记录诊断，达不到最低洞察数则失败，不保存捏造内容。聚合阶段只能引用上一层提供的精确证据，不能扩展到未提供的原文部分。
- **状态**：来源版本、模型、提示词版本、生成时间持久化；同一类型和范围只允许一个任务，不同范围可并行；服务重启把未完成任务标为失败；自动尝试每天最多一次，失败保留原文和旧结果。
- **隐私**：手动整理需确认；每个自然日 **01:00（配置时区）** 自动向配置的模型服务商发送**昨天**的私人原文做日整理，服务需运行；离线错过时当天 01:00 后启动可补做昨天，不追溯更早日期；无记录/未配置模型/已有相同来源成功结果时跳过。自托管不等于不出服务器，服务商如何保存输入由其政策决定。
- **限制**：每条 8000 字符；单次范围 500 条 / 12 万字符；每任务最多 512 次调用，单个请求材料最多 60000 字符；128 字符及以下不再拆分；模型需支持 `POST /chat/completions`、`response_format: {"type":"json_object"}` 和 `max_tokens`（上限 8192）；每次调用 90 秒超时。模型输出不是“不丢信息”的数学保证，必须对照原文。

首版不做：注册、多用户、复杂队列、离线同步、自定义日期范围/周报告、图片生成、聊天、心理评分、人格诊断、分类纠正、删除撤销。仅提供月度范围。

## 导出、备份与恢复

```sh
# 全部原文 JSON / 当日 Markdown 也可在 UI 下载
# 一致性备份（可在服务运行时执行；VACUUM INTO，不直接复制活跃 WAL）
FLEETING_CONFIG=./config.local.json go run ./cmd/fleeting backup -dir ./backups -keep 14
# 或指定文件（目标必须不存在）
FLEETING_CONFIG=./config.local.json go run ./cmd/fleeting backup ./backups/fleeting-2026-11-02.sqlite
```

备份包含原文、派生元信息和会话；也应备份私有配置，但不要放在仓库。恢复步骤：

1. 停止服务，备份当前数据库供回滚。
2. 删除旧数据库旁的 `-wal` / `-shm`（只在服务已停止后），用备份替换 `DATABASE_PATH` 指向的主文件，检查权限（0600）。
3. 如备份来源不完全可信或希望撤销其会话，重设密码，再启动服务。
4. 登录检查日期/条数，导出 JSON 核对。

建议至少每日备份，自己设置保留期并定期验证恢复。删除主库原文并不会删除历史备份、已下载的导出或服务商留存；SQLite WAL/空闲页也可能包含旧字节。

## 部署

生产部署材料在 `deploy/`：`deploy.ps1`（本地交叉编译 + 备份 + 上传 + 切换 + 探活 + 自动回滚）、`fleeting.service`、`bootstrap.sh`、`caddy-fleeting.snippet`，说明见 [`deploy/README.md`](deploy/README.md)。

```powershell
pwsh deploy/deploy.ps1
```

公网参考部署：`https://liangz77.cn/fleeting/`，Caddy `handle_path` 把 `/fleeting/*` 交给 `127.0.0.1:3010`，页面资源使用相对路径，`web/app.js` 从 `location` 推导 API 前缀；`/fleeting` 无尾斜杠时重定向到 `/fleeting/`。主站 go-sites 的「我的」页里有一条指向该地址的应用条目。

**公网必须 HTTPS**。非本机 HTTP origin 会拒绝启动。生产进程以独立非 root 用户运行，私有配置 0600、数据/备份目录 0700；服务只监听回环，公网只能经 Caddy。登录限速只信任回环代理附加的 `X-Forwarded-For`；建议代理额外做连接限速。不要通过反向代理暴露多个实例：生成锁和自动尝试标记是单实例设计。

## 检查

```sh
go vet ./...
go test ./...
CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -ldflags "-s -w" -o /tmp/fleeting ./cmd/fleeting
```

Go 测试覆盖：scrypt 与旧 Node 哈希兼容、配置与环境优先级、时区/闰日/午夜边界、旧库迁移与按日期补录、幂等/版本冲突/备份恢复、登录限速与代理地址、HTTPS Cookie/CSRF/Origin/密码变更撤销会话、日/月 AI 结构校验、证据落地与规范化、截断拆分/压缩、512 调用预算、自动整理幂等与 DST。

迁移前还做了两类独立验证（记录见 `docs/migration-go-2026-11-02.md`）：

- 用同一份生产数据库副本同时启动旧 Node 版与新 Go 版，对全部日期/月份/搜索/导出/结果/负向错误/静态文件逐项对比，结果完全一致。
- Playwright + 本机 Chrome 在 `/fleeting/` 剥前缀代理拓扑下验证：样式/脚本/接口全走前缀、已有记录与月报渲染、保存、搜索、导出、无根路径请求、无控制台错误。

`docs/` 中 2026-10-07 前后的文档是 Node 版时期的产品设计、实施和验证记录，保留作历史；当前实现以本 README 和 Go 源码为准。
