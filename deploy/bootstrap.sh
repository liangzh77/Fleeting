#!/usr/bin/env bash
# 一次性服务器初始化（在服务器上以 root 运行）：
#   bash bootstrap.sh
# 幂等：可重复执行。安装了 Node 运行时、服务账号、目录、systemd 单元与每日备份定时任务。
# Caddy 反向代理配置由 go-sites 仓库的 Caddyfile 提供（见 deploy/caddy-private.snippet）。
set -euo pipefail

NODE_VERSION="${NODE_VERSION:-22.23.1}"
NODE_MIRROR="${NODE_MIRROR:-https://mirrors.cloud.tencent.com/nodejs-release}"
NODE_PREFIX=/usr/local
APP_ROOT=/srv/apps/fleeting
NODE_ARCH="linux-$(uname -m | sed 's/x86_64/x64/; s/aarch64/arm64/')"

if [[ "${EUID}" -ne 0 ]]; then
  echo "请以 root 运行。" >&2
  exit 1
fi

echo "== Node ${NODE_VERSION}"
if [[ ! -x "${NODE_PREFIX}/bin/node" ]]; then
  tmp="$(mktemp -d)"
  tarball="node-v${NODE_VERSION}-${NODE_ARCH}.tar.xz"
  curl -fsSL "${NODE_MIRROR}/v${NODE_VERSION}/${tarball}" -o "${tmp}/${tarball}"
  tar -xJf "${tmp}/${tarball}" -C "${tmp}"
  cp -R "${tmp}/node-v${NODE_VERSION}-${NODE_ARCH}/." "${NODE_PREFIX}/"
  rm -rf "${tmp}"
fi
"${NODE_PREFIX}/bin/node" -v
for bin in node npm npx; do
  target="/usr/local/bin/${bin}"
  [ -e "${target}" ] || ln -s "${NODE_PREFIX}/bin/${bin}" "${target}"
done

echo "== 服务账号与目录"
id -u fleeting >/dev/null 2>&1 || useradd --system --home-dir "${APP_ROOT}" --shell /usr/sbin/nologin fleeting
install -d -m 755 -o root -g fleeting "${APP_ROOT}" "${APP_ROOT}/releases"
install -d -m 750 -o fleeting -g fleeting "${APP_ROOT}/shared" "${APP_ROOT}/shared/data" "${APP_ROOT}/shared/backups"

echo "== systemd 单元"
install -m 644 "$(dirname "$0")/fleeting.service" /etc/systemd/system/fleeting.service
systemctl daemon-reload
systemctl enable fleeting >/dev/null

echo "== 每日备份（03:30，保留 14 份）"
cat >/etc/cron.d/fleeting-backup <<EOF
SHELL=/bin/bash
PATH=/usr/local/bin:/usr/bin:/bin
30 3 * * * fleeting FLEETING_CONFIG=${APP_ROOT}/shared/config.local.json /usr/local/bin/node ${APP_ROOT}/current/deploy/backup.mjs >> ${APP_ROOT}/shared/backup.log 2>&1
EOF
chmod 644 /etc/cron.d/fleeting-backup

echo "== 完成。下一步：放置 ${APP_ROOT}/shared/config.local.json（0600 fleeting:fleeting）后"
echo "   systemctl start fleeting && curl -fsS -o /dev/null -w '%{http_code}\\n' http://127.0.0.1:3010/"
