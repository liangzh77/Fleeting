# 部署验证记录：https://liangz77.cn/private/（2026-10-07）

目标：把 Fleeting 发布到 `49.232.129.114`（OpenCloudOS 9.4，VM-0-14-opencloudos），
公开地址 `https://liangz77.cn/private/`，且不影响同机 `go-sites` 主站。

## 1. 运行时

- 服务器原本没有 Node。安装 **Node v22.23.1** 到 `/usr/local`（腾讯镜像 release 包），
  `/usr/local/bin/{node,npm,npx}` 为符号链接；`node:sqlite` 在 22.23.1 上无需 flag（有 experimental 警告）。
- 服务账号 `fleeting`（系统用户，无 shell 登录），目录：
  - `/srv/apps/fleeting/releases/<YYYYmmddHHMMSS>`（发布版本，保留最近 5 个）
  - `/srv/apps/fleeting/current` → 指向当前版本的符号链接
  - `/srv/apps/fleeting/shared/config.local.json`（`0600 fleeting:fleeting`）
  - `/srv/apps/fleeting/shared/data/`、`shared/backups/`（`0750`）
- systemd 单元 `fleeting.service`：`User=fleeting`，`ExecStart=/usr/local/bin/node dist/server.js`，
  `Environment=FLEETING_CONFIG=/srv/apps/fleeting/shared/config.local.json PORT=3010 HOST=127.0.0.1`，
  `Restart=always`，`ProtectSystem=full` + `ReadWritePaths` 仅放开 shared/data。
  只监听 `127.0.0.1:3010`，不对公网暴露端口。
- 每日备份 `/etc/cron.d/fleeting-backup` 03:30 调用 `deploy/backup.mjs`（`node:sqlite` 在线 `backup()`，保留 14 份）。
  已以 `fleeting` 身份手动跑通一次：`fleeting-2026-10-07T06-04-51.sqlite`（0600，57344B，exit 0）。

远端配置由本地 `config.local.json` 派生，只改 `origin` → `https://liangz77.cn`、
`database` → `/srv/apps/fleeting/shared/data/fleeting.sqlite`，
`passwordHash` 与 `llm`（含 `reasoningEffort:"none"`）逐字段复制；传输与落盘全程 0600，
脚本只打印键名与布尔值，绝不打印口令哈希、API Key 或原文。

## 2. 反向代理（go-sites 仓库的 Caddyfile 是唯一来源）

`/etc/caddy/Caddyfile` 导入 `/etc/caddy/sites-enabled/*.caddy`；
`go-sites` 的 `deploy.ps1` 每次发布都会把仓库里的 `Caddyfile` 覆盖到
`/etc/caddy/sites-enabled/liangz77.cn.caddy`，因此改动必须落回仓库。

改动（`(main_site_routes)` 内，位于 `@tab_routes` 之前，并从 `@tab_routes` 移除 `/private`）：

```caddyfile
handle /private {
    redir * /private/ permanent
}

handle_path /private/* {
    reverse_proxy 127.0.0.1:3010
}
```

Fleeting 全部使用根绝对路径（`/api`、`/style.css`、`/app.js`、`/favicon.svg`），
`handle_path` 剥掉 `/private` 前缀后应用无需知道子路径。

> 踩坑：`redir /private/ permanent` 会被 Caddy 当成「`/private/` 是匹配器」，
> 适配成 `Location: permanent` + 302，`/private` 不跳转而是 404。
> 必须写成 `redir * /private/ permanent`（或 `redir /private /private/ permanent`）。
> 部署后用 `curl http://127.0.0.1:2019/config/` 核对适配结果。

生效流程：备份 `/srv/backups/liangz77.cn.caddy.bak-20261007140115` → 覆盖文件 →
`caddy validate` 通过 → `systemctl reload caddy`（未重启、未中断现有站点）。

安全头由 Fleeting（HTTPS origin）下发：
`content-security-policy: default-src 'self'; ...; frame-ancestors 'none'`、
`strict-transport-security`、`x-frame-options: DENY`、`referrer-policy: no-referrer`、`cache-control: no-store`。

## 3. 联外验证（从公网发起，2026-10-07 14:0x）

| 请求 | 结果 |
| --- | --- |
| `GET /private` | 301 → `https://liangz77.cn/private/` |
| `GET /private/` | 200，`text/html`，`<title>Fleeting · 随笔</title>` |
| `GET /private/app.js` | 200，25736B，含 `AI \u6574\u7406`（esbuild 转义） |
| `GET /private/style.css` / `favicon.svg` | 200 |
| `GET /private/api/session` | 401 `{"error":"请先登录"}` |
| `GET /private/api/dates` | 401 |
| `GET /`、`GET /tools` | 200，290398B（主站 SPA 未受影响） |
| `POST /private/api/login`，`Origin: https://evil.example` | **403**（Origin 校验） |
| `POST /private/api/login`（错误口令，伪造 `X-Forwarded-For: 203.0.113.9`） | 401；`attempts` 记录的真实键为来访客户端公网 IP `183.241.173.27`，**不是**伪造值 |

最后一条同时验证了两件事：`app.set("trust proxy","loopback")` 只信任回环代理写入的
`X-Forwarded-For`，且登录限速按真实客户端地址分桶（已新增回归测试
`经可信代理时登录限速按客户端地址区分`）。

## 4. 本地私人数据迁移（2026-10-07 16:41）

用户确认“本地数据搬到云服务器”。步骤（全程未回显原文）：

1. 本地用 `npm run backup -- /tmp/fleeting-migrate-<stamp>.sqlite`（`node:sqlite` `backup()` 一致性快照，0600）导出运行中的真实库；`PRAGMA integrity_check` = ok。
2. 比对本地与远端 `sqlite_master` 建表语句：仅 `entries` 表的 `, timeUnknown` 多余一个空格（ALTER 遗留），语义一致。
3. 远端 `systemctl stop fleeting` → 备份原（空）库到 `shared/backups/fleeting-premigration-20261007164129.sqlite` → 删除旧 `-wal`/`-shm` → 装入快照（0600 `fleeting:fleeting`）→ 清空 `sessions`/`attempts`（口令不变，需重新登录）→ `systemctl start fleeting`。
4. 核验：远端 `entries` 按日与字符数与本地完全一致（`2026-10-04` 1 条 2539 字、`2026-10-05` 1 条 1067 字、`2026-10-07` 2 条 142 字），`results` 中已完成的日/月整理与洞察一并迁移，服务 `active`。

口令：**沿用同一份 `passwordHash`**（用户确认）。

## 5. 数据与回退

- **未迁移**本地私人记录，远端是全新空库（`entries` 为空）；迁移需要显式确认后再 `scp` 备份库并重启。
- 远端复用本地 `passwordHash`；建议之后用 `npm run password` 换成独立强口令。
- 回退：
  1. 换回上一版静态站点：`cp -a /srv/backups/liangz77.cn.caddy.bak-20261007140115 /etc/caddy/sites-enabled/liangz77.cn.caddy && systemctl reload caddy`；
  2. 停止应用：`systemctl disable --now fleeting`；
  3. 回退代码：把 `/srv/apps/fleeting/current` 指回上一个 `releases/<stamp>` 并 `systemctl restart fleeting`。

## 6. 已知边界

- 主站 SPA 的「我的」标签是 `pushState` 客户端路由（`<button>`，不是链接），站内点击仍渲染旧「我的」页；
  只有直接访问/刷新 `/private` 才进入 Fleeting。若要统一，需要在 go-sites 前端把该标签改为整页跳转（未做，等确认）。
- 未做真实浏览器登录后的完整链路实测（需要口令），未在公网发起真实模型生成请求。
- 证书仍由 Caddy 自动管理，本次未改动 TLS 配置。
> **后续（同日晚）**：用户决定改成路径部署 `https://liangz77.cn/fleeting/`（子域需要用户自己在阿里云加 A 记录），
> `/private` 改为 308 永久跳转。切换同时发现：本文记录的「应用无需支持子路径」是错误假设 ——
> 页面资源用根绝对路径时浏览器会到站点根取 `/style.css`、`/app.js`，落到 go-sites 上 404，
> 页面实际无样式无脚本（当时只用 curl 验证，漏掉了这一点）。修复与复验见
> `docs/validation-2026-10-07-deploy-fleeting-path.md`。
