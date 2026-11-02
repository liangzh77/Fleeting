[CmdletBinding()]
param(
    [string]$RemoteHost = "49.232.129.114",
    [string]$User = "root",
    [int]$Port = 22,
    [string]$IdentityFile = "C:\Users\EDY\.ssh\keychain_deploy_ed25519",
    [int]$Keep = 5,
    [string]$Version = "",
    [switch]$SkipBackup
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$AppRoot = "/srv/apps/fleeting"
$Domain = "liangz77.cn"
$RepoRoot = Split-Path -Parent $PSScriptRoot
$ReleaseId = if ($Version) { $Version.Trim() } else { Get-Date -Format "yyyyMMdd-HHmmss" }
if ($ReleaseId -notmatch '^[0-9A-Za-z][0-9A-Za-z.-]{0,63}$') {
    throw "Invalid release id: $ReleaseId"
}

function Require-Command {
    param([string]$Name)
    if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
        throw "Missing required command: $Name"
    }
}

function Invoke-RemoteScript {
    param(
        [string]$Target,
        [int]$RemotePort,
        [string]$KeyFile,
        [string]$Script
    )

    $normalized = $Script -replace "`r`n", "`n"
    $sshArgs = @("-p", "$RemotePort")
    if ($KeyFile) {
        $sshArgs += @("-i", $KeyFile, "-o", "IdentitiesOnly=yes")
    }
    $normalized | & ssh @sshArgs $Target "bash -s"
    if ($LASTEXITCODE -ne 0) {
        throw "Remote script failed."
    }
}

Require-Command "ssh"
Require-Command "scp"
Require-Command "tar"
Require-Command "go"
Require-Command "curl"

$resolvedIdentity = (Resolve-Path -LiteralPath $IdentityFile).Path
$target = "$User@$RemoteHost"
$releaseDir = "$AppRoot/releases/$ReleaseId"
$remoteArchive = "/tmp/fleeting-$ReleaseId.tgz"
$archivePath = Join-Path ([System.IO.Path]::GetTempPath()) "fleeting-$ReleaseId.tgz"
$stagingDir = Join-Path ([System.IO.Path]::GetTempPath()) ("fleeting-stage-" + [guid]::NewGuid().ToString("N"))
$skipBackupFlag = if ($SkipBackup) { "1" } else { "0" }

try {
    Write-Host "== 1/4 本地构建 Linux 单文件二进制（$ReleaseId）"
    New-Item -ItemType Directory -Path $stagingDir | Out-Null
    $oldGoos = $env:GOOS
    $oldGoarch = $env:GOARCH
    $oldCgo = $env:CGO_ENABLED
    try {
        $env:GOOS = "linux"
        $env:GOARCH = "amd64"
        $env:CGO_ENABLED = "0"
        & go build -trimpath -ldflags "-s -w" -o (Join-Path $stagingDir "fleeting") ./cmd/fleeting
        if ($LASTEXITCODE -ne 0) {
            throw "go build failed."
        }
    }
    finally {
        $env:GOOS = $oldGoos
        $env:GOARCH = $oldGoarch
        $env:CGO_ENABLED = $oldCgo
    }
    Copy-Item -LiteralPath (Join-Path $RepoRoot "web") -Destination $stagingDir -Recurse
    Copy-Item -LiteralPath (Join-Path $RepoRoot "deploy") -Destination $stagingDir -Recurse
    Copy-Item -LiteralPath (Join-Path $RepoRoot "config.example.json") -Destination $stagingDir
    if (Test-Path -LiteralPath (Join-Path $RepoRoot "README.md")) {
        Copy-Item -LiteralPath (Join-Path $RepoRoot "README.md") -Destination $stagingDir
    }

    Write-Host "== 2/4 打包并上传"
    & tar -czf $archivePath -C $stagingDir .
    if ($LASTEXITCODE -ne 0) {
        throw "Failed to create release archive."
    }
    $scpArgs = @("-P", "$Port", "-i", $resolvedIdentity, "-o", "IdentitiesOnly=yes")
    & scp @scpArgs $archivePath "${target}:$remoteArchive"
    if ($LASTEXITCODE -ne 0) {
        throw "Failed to upload release archive."
    }

    Write-Host "== 3/4 远端备份、切换 current、重启并探活"
    $deployScript = @'
set -euo pipefail
APP_ROOT='__APP_ROOT__'
RELEASES_DIR="$APP_ROOT/releases"
RELEASE='__RELEASE_DIR__'
SHARED="$APP_ROOT/shared"
CONFIG="$SHARED/config.local.json"
UNIT='/etc/systemd/system/fleeting.service'
CRON='/etc/cron.d/fleeting-backup'
ARCHIVE='__REMOTE_ARCHIVE__'
KEEP=__KEEP__

mkdir -p "$RELEASES_DIR"
if [[ -e "$RELEASE" ]]; then
  echo "release already exists: $RELEASE"
  rm -f "$ARCHIVE"
  exit 1
fi
mkdir -p "$RELEASE"
tar -xzf "$ARCHIVE" -C "$RELEASE"
rm -f "$ARCHIVE"
chown -R root:fleeting "$RELEASE"
find "$RELEASE" -type d -exec chmod 755 {} +
chmod 755 "$RELEASE/fleeting"

if [[ ! -f "$CONFIG" ]]; then
  echo "missing server config: $CONFIG"
  rm -rf "$RELEASE"
  exit 1
fi

# 在停止旧服务之前，用新二进制对现有数据库做一次一致性快照。
if [[ '__SKIP_BACKUP__' != '1' ]]; then
  FLEETING_CONFIG="$CONFIG" "$RELEASE/fleeting" backup -dir "$SHARED/backups" -keep 14
fi

# 保留旧 unit/cron 与 current，便于健康检查失败时自动回滚。
mkdir -p "$SHARED/systemd"
if [[ -f "$UNIT" ]]; then
  cp "$UNIT" "$SHARED/systemd/fleeting.service.__RELEASE_ID__"
fi
if [[ -f "$CRON" ]]; then
  cp "$CRON" "$SHARED/systemd/fleeting-backup.__RELEASE_ID__"
fi

cp "$RELEASE/deploy/fleeting.service" "$UNIT"
chmod 644 "$UNIT"
cat > "$CRON" <<'CRONEOF'
SHELL=/bin/bash
PATH=/usr/local/bin:/usr/bin:/bin
30 3 * * * fleeting FLEETING_CONFIG=/srv/apps/fleeting/shared/config.local.json /srv/apps/fleeting/current/fleeting backup -dir /srv/apps/fleeting/shared/backups -keep 14 >> /srv/apps/fleeting/shared/backup.log 2>&1
CRONEOF
chmod 644 "$CRON"

old_target=""
if [[ -L "$APP_ROOT/current" ]]; then
  old_target=$(readlink -f "$APP_ROOT/current")
  ln -sfn "$old_target" "$APP_ROOT/previous"
fi
ln -sfn "$RELEASE" "$APP_ROOT/current"

rollback() {
  echo "rolling back to: ${old_target:-<none>}"
  if [[ -n "$old_target" ]]; then
    ln -sfn "$old_target" "$APP_ROOT/current"
  fi
  if [[ -f "$SHARED/systemd/fleeting.service.__RELEASE_ID__" ]]; then
    cp "$SHARED/systemd/fleeting.service.__RELEASE_ID__" "$UNIT"
  fi
  if [[ -f "$SHARED/systemd/fleeting-backup.__RELEASE_ID__" ]]; then
    cp "$SHARED/systemd/fleeting-backup.__RELEASE_ID__" "$CRON"
  fi
  systemctl daemon-reload
  systemctl restart fleeting || true
  rm -rf "$RELEASE"
  exit 1
}

systemctl daemon-reload
systemctl enable fleeting >/dev/null
systemctl restart fleeting

healthy=0
for _ in $(seq 1 30); do
  if curl -fsS -o /dev/null "http://127.0.0.1:3010/"; then
    healthy=1
    break
  fi
  sleep 1
done
if [[ "$healthy" != '1' ]]; then
  echo "health check failed"
  systemctl --no-pager --lines=30 status fleeting || true
  rollback
fi

api_status=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:3010/api/session" || true)
if [[ "$api_status" != '401' ]]; then
  echo "unexpected /api/session status: $api_status"
  rollback
fi

systemctl --no-pager --lines=10 status fleeting || true

current_target=$(readlink -f "$APP_ROOT/current")
previous_target=""
if [[ -L "$APP_ROOT/previous" ]]; then
  previous_target=$(readlink -f "$APP_ROOT/previous")
fi
for dir in $(ls -1dt "$RELEASES_DIR"/* 2>/dev/null | tail -n +$((KEEP + 1))); do
  if [[ "$dir" == "$current_target" || "$dir" == "$previous_target" ]]; then
    continue
  fi
  rm -rf "$dir"
done

echo "deployed release: $RELEASE"
echo "current -> $current_target"
echo "previous -> ${previous_target:-<none>}"
'@
    $deployScript = $deployScript.Replace("__APP_ROOT__", $AppRoot).Replace("__RELEASE_DIR__", $releaseDir).Replace("__REMOTE_ARCHIVE__", $remoteArchive).Replace("__RELEASE_ID__", $ReleaseId).Replace("__KEEP__", "$Keep").Replace("__SKIP_BACKUP__", $skipBackupFlag)

    Invoke-RemoteScript -Target $target -RemotePort $Port -KeyFile $resolvedIdentity -Script $deployScript

    Write-Host "== 4/4 外网验证"
    $pageStatus = & curl.exe -sS -o NUL -w "%{http_code}" "https://$Domain/fleeting/"
    $appStatus = & curl.exe -sS -o NUL -w "%{http_code}" "https://$Domain/fleeting/app.js"
    Write-Host "https://$Domain/fleeting/ -> $pageStatus"
    Write-Host "https://$Domain/fleeting/app.js -> $appStatus"
    if ($pageStatus -ne "200" -or $appStatus -ne "200") {
        throw "External verification failed."
    }
    Write-Host "部署完成：$ReleaseId"
}
finally {
    if (Test-Path -LiteralPath $archivePath) {
        Remove-Item -LiteralPath $archivePath -Force
    }
    if (Test-Path -LiteralPath $stagingDir) {
        Remove-Item -LiteralPath $stagingDir -Recurse -Force
    }
}
