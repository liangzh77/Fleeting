# 首版实施与实际验证记录

日期：2026-10-07。源码、运行说明、测试均已写入工作区；未改变 `product-design.md` 原始设计。实现范围与限制见根目录 README。

## 执行环境与检查

- macOS，Node v22.23.1，npm 10.9.8，SQLite 为 Node 内置模块（实际运行有 ExperimentalWarning）。
- `npm install` / 后续补齐测试依赖：成功；锁文件已生成。
- `npm run typecheck`：通过。
- `npm test`：12 个 API/数据库测试通过（零失败、零跳过）。测试使用临时 SQLite 和 mock fetch。
- `npm run build`：TypeScript 服务端编译、esbuild 前端打包、静态文件复制通过。
- `CHROME_PATH='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' npm run test:browser`：通过手机 390×844、桌面 1280×900，及 mock AI 和独立审查缺陷回归场景。真实 headless Chrome 执行，不是静态截图验收。
- `npm run test:production`：通过。实际启动 `node dist/server.js`，验证静态资源、登录、原文存储，调用 `npm run backup` 在线备份，打开备份核对内容，再重启编译产物核对原文。
- `npm audit`：已执行，0 vulnerabilities。
- `git diff --check`：已执行，无输出。仓库最初文档与新增文件均未提交，该命令不替代自动化测试。
- `npm run format:check`：首次发现格式问题，已用 Prettier 修正；修复后的复跑通过（All matched files use Prettier code style）。

### 真实失败与修复（不隐瞒失败记录）

1. 第一轮 API 测试发现结果表 INSERT 占位符多一个，导致 AI 分支 500、竞态测试等待超时；已修正为 9 列对应 8 个参数与 NULL。
2. 后续测试发现 app 工厂未将注入 mock fetch 传给 Ai，导致失败分支错误；已修正。未配置任何真实模型 key；该次 example.invalid 请求没有真实模型服务验证意义。
3. 第一轮桌面浏览器检查因两条相同编辑文字导致测试 locator 非唯一而失败；限定 `.first()` 后复跑通过。
4. 独立模型第一轮发现三处真实前端缺陷，见下一节；修复并新增浏览器回归后已通过。

## 独立模型验收

验收模型：`openai-codex/gpt-6-astra`，high。独立进程，仅 read/bash 工具，不授予 edit/write；要求自行完整读实施计划、产品设计、README、源码和测试，不采信执行者自述。

第一轮结果：**needs_changes**。模型自行读代码，并在临时源码副本运行 typecheck、12/12 测试、构建和 Chrome 浏览器测试；同时通过独立浏览器复现发现：

- P1：退出后延迟的来源请求重新打开原文弹窗。
- P1：保存失败后继续编辑，旧 pendingText 覆盖新草稿。
- P2：跨午夜回到首页仍使用缓存的旧日期。
- 文档引用本验证记录时该文件尚未创建。

修复：

- 加入会话代际和 AbortController 集合；退出/过期时取消请求并清空 CSRF/敏感 DOM；来源弹窗同时检查页面与会话代际，旧回调不可再显示文字。
- 待确认提交和当前编辑草稿分别保存；先确认旧内容，新草稿保留，明确提示第二次提交。导航时也保留两者，不覆盖输入。
- 首页进入、焦点/可见恢复及周期检查向服务端校准日期；跨日重新加载今日记录/日整理范围，不清空草稿。
- 创建本记录，并补充 README 的真实行为。

新增浏览器回归实际通过：失败后编辑和确认旧提交、新草稿再保存；捕获来源响应后退出再释放，仍是未登录且无原文弹窗；模拟服务端日期跨日后首页仅显示新日期记录，日整理使用新日期且草稿保留。

随后正式 check-run 第一轮独立验收（`openai-codex/gpt-6-astra` high，`--tools read,bash`）结果为 **needs_changes**：会话过期使保存返回 401 时，未保存草稿被清空，违反保存失败保留输入。执行模型 `openai-codex/gpt-6.1-sol` medium 返工：会话过期隐藏私有界面、取消旧请求，但保留内存草稿、待确认正文和幂等键供重新登录后恢复；主动退出仍清除。新增保存 401、后台定时检查 401 浏览器回归，均通过。返工时首次浏览器运行因测试累计触发登录限速失败，隔离测试用例的限速计数后完整重跑通过，生产限速未修改。

最终第二轮独立验收：**approve**。检查模型独立审查代码和测试，另用临时浏览器脚本验证首次保存 401、后台检查 401、主动退出返回 200/401、已落库但响应迟到的并发保存等场景；实测 `npm run typecheck`、`npm test`（12/12）、`npm run format:check`、浏览器测试、生产测试均通过，并将构建产物与重新编译结果比较一致。本轮只读检查未修改仓库。正式验收输出分别在执行机 `/tmp/fleeting-check-run-verdict.txt` 和 `/tmp/fleeting-check-run-verdict2.txt`；这些文件不是应用运行依赖。

## 尚未验证 / 明确限制

- **未调用真实大模型**。只验证请求/结构/来源/计数/错误与 UI 链路；保真、细节覆盖和洞察的语义质量不声称已通过真实模型验收。
- 没有真实公网 HTTPS 代理部署；测试检查了 Secure Cookie/CSP/HSTS/Origin/CSRF，但没有真实 TLS 端到端。
- 浏览器检查覆盖基本键盘/焦点和纯文本安全，完整读屏及所有浏览器兼容性未专项验收。
- 未使用用户真实密码、API key 或私人日记。测试专用密码/模型标记只是临时占位符。
- 首版是单实例持久盘 SQLite；长月度原文最终综合需要模型足够上下文。不做自动备份调度、跨实例队列、自动云部署或文件级可靠擦除。
