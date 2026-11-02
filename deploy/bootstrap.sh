#!/usr/bin/env bash
# 一次性服务器初始化（在服务器上以 root 运行）：bash bootstrap.sh
# 幂等。只创建服务账号、目录、systemd 单元和每日备份；不安装 Node。
# 实际发布由本地 deploy.ps1 完成（构建 Linux 单文件二进制、上传、切换、探活）。
set -euo pipefail

APP_ROOT=/srv/apps/fleeting
UNIT="$(dirname "$0")/fleeting.service"

if [[ "${EUID}" -ne 0 ]]; then
  echo "请以 root 运行。" >&2
  exit 1
fi

echo "== 服务账号与目录"
id -u fleeting >/dev/null 2>&1 || useradd --system --home-dir "${APP_ROOT}" --shell /usr/sbin/nologin fleeting
install -d -m 755 -o root -g fleeting "${APP_ROOT}" "${APP_ROOT}/releases"
install -d -m 750 -o fleeting -g fleeting "${APP_ROOT}/shared" "${APP_ROOT}/shared/data" "${APP_ROOT}/shared/backups" "${APP_ROOT}/shared/systemd"

echo "== systemd 单元"
install -m 644 "${UNIT}" /etc/systemd/system/fleeting.service
systemctl daemon-reload
systemctl enable fleeting >/dev/null

echo "== 每日备份（03:30，保留 14 份；数据库一致性快照由 Go 二进制完成）"
cat >/etc/cron.d/fleeting-backup <<'EOF'
SHELL=/bin/bash
PATH=/usr/local/bin:/usr/bin:/bin
30 3 * * * fleeting FLEETING_CONFIG=/srv/apps/fleeting/shared/config.local.json /srv/apps/fleeting/current/fleeting backup -dir /srv/apps/fleeting/shared/backups -keep 14 >> /srv/apps/fleeting/shared/backup.log 2>&1
EOF
chmod 644 /etc/cron.d/fleeting-backup

echo "== 完成。下一步：放置 ${APP_ROOT}/shared/config.local.json（0600 fleeting:fleeting，"
echo "   passwordHash 可直接复用旧 Node 版的 scrypt 哈希），然后运行 deploy/deploy.ps1。"
