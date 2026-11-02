# 部署：https://liangz77.cn/fleeting/

Go 单文件二进制 + SQLite，部署方式与 `go-sites` 一致：本地交叉编译、上传 release、切换 `current` 软链、systemd 托管、Caddy 反代。**不需要 Node 运行时**。

| 项目 | 值 |
| --- | --- |
| 服务器 | `49.232.129.114`（OpenCloudOS 9.4） |
| 公网地址 | `https://liangz77.cn/fleeting/` |
| 代码目录 | `/srv/apps/fleeting/releases/<时间戳>`，`current` 软链指向在用版本，`previous` 指向上一个版本 |
| 私有数据 | `/srv/apps/fleeting/shared/`（`config.local.json` 0600、`data/fleeting.sqlite`、`backups/`） |
| 监听 | `127.0.0.1:3010`（仅回环，公网只能经 Caddy） |
| 服务账号 | `fleeting`（系统账号，无登录 shell） |
| systemd | `fleeting.service`（`ExecStart=/srv/apps/fleeting/current/fleeting`） |
| 备份 | `/etc/cron.d/fleeting-backup` 每日 03:30，调用二进制 `fleeting backup`，保留 14 份 |

## 首次上线 / 新服务器

```bash
# 1. 服务器初始化（root；幂等；只建账号、目录、unit、cron，不装 Node）
scp deploy/bootstrap.sh deploy/fleeting.service root@49.232.129.114:/tmp/
ssh root@49.232.129.114 'install -d /srv/apps/fleeting/shared && cp /tmp/bootstrap.sh /tmp/fleeting.service /srv/apps/fleeting/shared/ 2>/dev/null; bash /tmp/bootstrap.sh'

# 2. 写入私有配置（0600 fleeting:fleeting）
#    origin 必须是 https://liangz77.cn；timezone=Asia/Shanghai；database 指向 shared/data/fleeting.sqlite
#    passwordHash 可复用旧 Node 版的 scrypt 哈希（格式与默认参数完全一致）
#    模型配置可选；没有 llm 三项时 AI 自动关闭。
#    本地生成哈希：printf '%s\n' '你的新密码' | go run ./cmd/fleeting password

# 3. 发布
pwsh deploy/deploy.ps1
```

## 从旧 Node 版原地升级

数据库 schema、scrypt 哈希、会话 Cookie 名和会话表完全兼容，因此不需要导出/导入：

1. 先停掉旧服务或直接发布（发布脚本会在切换前用新二进制对共享数据库做一次 `VACUUM INTO` 一致性快照）。
2. `deploy.ps1` 切换 `current`、安装新 unit、重启并探活；失败会自动回滚到 `previous` 并恢复旧 unit/cron。
3. 旧会话（浏览器登录状态）保留，密码不变。
4. 旧 release 仍保留在 `releases/`（默认保留 5 个），可手动回滚。

手动回滚：

```bash
ln -sfn "$(readlink -f /srv/apps/fleeting/previous)" /srv/apps/fleeting/current
cp /srv/apps/fleeting/shared/systemd/fleeting.service.<旧release> /etc/systemd/system/fleeting.service  # 若需要旧 unit
systemctl daemon-reload
systemctl restart fleeting
curl -fsS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3010/
```

## Caddy

反向代理片段见 `deploy/caddy-fleeting.snippet`。实际生效的是
`/etc/caddy/sites-enabled/liangz77.cn.caddy`，由 `go-sites` 的 `deploy.ps1` 发布时维护。
`handle_path` 剥掉 `/fleeting` 前缀；页面使用相对资源路径，`web/app.js` 从 `location` 推导 API 前缀；
目录式 URL 必须跳转到末尾斜杠。修改后：

```bash
caddy validate --config /etc/caddy/Caddyfile
systemctl reload caddy
```

## 日常发布

```powershell
pwsh deploy/deploy.ps1                 # 构建 + 备份 + 上传 + 切换 + 探活 + 清理旧 release
pwsh deploy/deploy.ps1 -Keep 3
pwsh deploy/deploy.ps1 -SkipBackup     # 不额外做切换前备份
```

发布脚本在健康检查或鉴权探活失败时会自动回滚，并输出 systemd 状态。

## 运维

```bash
ssh root@49.232.129.114
systemctl status fleeting          # 服务状态
journalctl -u fleeting -n 50       # 日志（不记录原文与凭据）

# 手动一致性备份（数据库运行中也可执行）
FLEETING_CONFIG=/srv/apps/fleeting/shared/config.local.json \
  /srv/apps/fleeting/current/fleeting backup \
  -dir /srv/apps/fleeting/shared/backups -keep 14

# 查看数据摘要（可选；直接只读查询 SQLite）
```

恢复步骤：

1. 停止 `fleeting`，备份当前数据库文件。
2. 删除旧数据库旁的 `-wal` / `-shm`（只在服务停止后）。
3. 用备份覆盖 `shared/data/fleeting.sqlite`，检查权限 0600、属主 fleeting。
4. 如备份来源不完全可信，重设密码后再启动；登录核对日期和条数。

## 公网暴露注意事项

- 服务只监听 `127.0.0.1`，公网流量必须经过 Caddy 的 HTTPS。
- `origin` 必须是 `https://liangz77.cn`，否则 Secure Cookie 与跨站请求校验会拒绝。
- 登录限速只信任回环代理附加的 `X-Forwarded-For`；直连 3010 无法伪造客户端地址。
- AI 整理会把所选范围的原文发送给配置的模型服务商；未配置 `llm` 时全部 AI 功能关闭。
- SQLite、备份和导出都是未加密的私人数据，不放在静态目录；请使用加密磁盘和受控备份生命周期。
