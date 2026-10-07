# 部署：https://liangz77.cn/fleeting/

部署方式参照 `go-sites`（同一台服务器、同一个 Caddy 入口）：本地构建、上传产物、远端只装生产依赖、systemd 托管、Caddy 反代。

| 项目 | 值 |
| --- | --- |
| 服务器 | `49.232.129.114`（OpenCloudOS 9.4） |
| 公网地址 | `https://liangz77.cn/fleeting/`（旧 `/private` 308 → 新地址） |
| 代码目录 | `/srv/apps/fleeting/releases/<时间戳>`，`current` 软链指向在用版本 |
| 私有数据 | `/srv/apps/fleeting/shared/`（`config.local.json` 0600、`data/fleeting.sqlite`、`backups/`） |
| 监听 | `127.0.0.1:3010`（仅回环，公网只能经 Caddy） |
| 服务账号 | `fleeting`（系统账号，无登录 shell） |
| 运行时 | `/usr/local/bin/node`（Node 22 LTS，来自腾讯云 Node 镜像） |
| systemd | `fleeting.service` |
| 备份 | `/etc/cron.d/fleeting-backup` 每日 03:30，保留 14 份 |

## 首次上线

```bash
# 1. 服务器初始化（以 root 运行，幂等）
scp deploy/bootstrap.sh deploy/fleeting.service root@49.232.129.114:/tmp/
ssh root@49.232.129.114 'install -d /srv/apps/fleeting/shared && cp /tmp/bootstrap.sh /tmp/fleeting.service /srv/apps/fleeting/shared/ 2>/dev/null; bash /tmp/bootstrap.sh'

# 2. 写入私有配置（含密码哈希与模型 API Key，权限 0600、属主 fleeting）
#    字段：origin（必须是 https://liangz77.cn）、timezone、database、passwordHash、llm
#    本地生成密码哈希：npm run password

# 3. 首次发布
bash deploy/deploy.sh
```

## Caddy

反向代理片段在 `deploy/caddy-fleeting.snippet`。实际生效的配置是
`/etc/caddy/sites-enabled/liangz77.cn.caddy`，它与 `go-sites` 仓库根目录的 `Caddyfile`
保持一致（`go-sites` 的 `deploy.ps1` 每次发布会覆盖该文件）。

要点：`handle_path` 会把 `/fleeting/*` 的前缀剥掉，Fleeting 因此看到根路径（`/`、`/style.css`、`/api/...`）。
但浏览器页面仍在 `/fleeting/` 下打开，所以 `web/index.html` 的资源引用是相对路径，`web/app.ts` 从
`location` 推导接口前缀（`apiBase`）；若用根绝对路径（`/style.css`、`/app.js`、`/api/...`），浏览器会到
站点根去取，落到 go-sites 上 404 —— 页面无样式且脚本不执行。目录式 URL 必须跳转到末尾斜杠
（`/fleeting` → `/fleeting/`），否则相对路径解析错误。
回归测试：`tsx tests/browser-base-path.ts`（本地起一个剥前缀代理，断言所有请求都在 `/fleeting/*`）。验证：

```bash
caddy validate --config /etc/caddy/Caddyfile
systemctl reload caddy
```

## 日常发布

```bash
bash deploy/deploy.sh                 # 构建 + 上传 + 重启 + 探活，保留最近 5 个版本
HOST=1.2.3.4 KEEP=3 bash deploy/deploy.sh
```

## 运维

```bash
ssh root@49.232.129.114
systemctl status fleeting          # 服务状态
journalctl -u fleeting -n 50       # 日志（不记录原文与凭据）
node /srv/apps/fleeting/current/deploy/backup.mjs   # 手动一致性备份
```

回滚：把 `current` 软链指回上一个 `releases/<时间戳>` 并 `systemctl restart fleeting`。

## 公网暴露的注意事项

- 服务只监听 `127.0.0.1`，公网流量必须经过 Caddy 的 HTTPS。
- `origin` 必须配置为 `https://liangz77.cn`，否则登录 Cookie 不会带 `Secure`，且跨站请求校验会拒绝。
- 应用设置为只信任回环代理（`trust proxy = loopback`）附加的 `X-Forwarded-For`，登录限速因此按真实客户端地址分桶；
  直接连到 3010 的请求无法伪造客户端地址。
- AI 生成的整理与洞察会把原文发送给配置的模型服务商，这是产品设计的一部分；未配置 `llm` 时全部 AI 功能自动关闭。
