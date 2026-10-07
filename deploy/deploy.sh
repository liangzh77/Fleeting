#!/usr/bin/env bash
# Fleeting 一键发布（本地 macOS → liangz77.cn 服务器，参照 go-sites 的发布方式）：
#   1. 本地构建（tsc + esbuild）
#   2. 上传构建产物到 /srv/apps/fleeting/releases/<版本>
#   3. 远端只安装生产依赖（express）
#   4. 切换 current 软链并重启 systemd 服务
#   5. 本机探活，保留最近 5 个版本
# 一次性服务器初始化见 deploy/bootstrap.sh；Caddy 配置见 deploy/caddy-private.snippet。
set -euo pipefail

: "${LANG:=en_US.UTF-8}"
HOST="${HOST:-49.232.129.114}"
REMOTE_USER="${REMOTE_USER:-root}"
SSH_KEY="${SSH_KEY:-$HOME/.ssh/keychain_deploy_ed25519}"
REMOTE_ROOT="${REMOTE_ROOT:-/srv/apps/fleeting}"
PORT="${PORT:-3010}"
KEEP="${KEEP:-5}"
REGISTRY="${REGISTRY:-https://registry.npmmirror.com}"

cd "$(dirname "$0")/.."
REPO_DIR="$(pwd)"
VERSION="$(date +%Y%m%d%H%M%S)"
SSH=(ssh -i "$SSH_KEY" -o IdentitiesOnly=yes -o BatchMode=yes "$REMOTE_USER@$HOST")
SCP=(scp -i "$SSH_KEY" -o IdentitiesOnly=yes -o BatchMode=yes)

echo "== 1/5 本地构建（${REPO_DIR}）"
npm run build

STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
cp -R dist public deploy package.json package-lock.json "$STAGE/"

echo "== 2/5 上传到 ${REMOTE_ROOT}/releases/${VERSION}"
"${SSH[@]}" "install -d -m 755 -o root -g fleeting $REMOTE_ROOT/releases $REMOTE_ROOT/releases/$VERSION"
"${SCP[@]}" -r "$STAGE/." "$REMOTE_USER@$HOST:$REMOTE_ROOT/releases/$VERSION/"

echo "== 3/5 远端安装生产依赖"
"${SSH[@]}" "cd $REMOTE_ROOT/releases/$VERSION && npm ci --omit=dev --registry=$REGISTRY --no-audit --no-fund && chown -R root:fleeting . && find . -type d -exec chmod 755 {} +"

echo "== 4/5 切换 current 并重启"
"${SSH[@]}" "ln -sfn $REMOTE_ROOT/releases/$VERSION $REMOTE_ROOT/current && systemctl restart fleeting && sleep 2 && systemctl is-active fleeting"

echo "== 5/5 探活与版本清理"
"${SSH[@]}" "curl -fsS -o /dev/null -w 'http://127.0.0.1:$PORT/ -> %{http_code}\n' http://127.0.0.1:$PORT/ && \
  ls -1dt $REMOTE_ROOT/releases/* | tail -n +\$(( $KEEP + 1 )) | xargs -r rm -rf && \
  ls -1dt $REMOTE_ROOT/releases/* | head -n $KEEP"

echo "发布完成：版本 ${VERSION}"
echo "外网验证：curl -sS -o /dev/null -w '%{http_code}\\n' https://liangz77.cn/private/"
