#!/bin/bash

set -euo pipefail

LABEL="com.lecturebridge.server"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
USER_LIBRARY="${HOME:?}/Library"
LAUNCH_AGENTS_DIR="$USER_LIBRARY/LaunchAgents"
LOG_DIR="$USER_LIBRARY/Logs/Lecture Bridge"
INSTALL_DIR="$USER_LIBRARY/Application Support/Lecture Bridge"
PLIST_PATH="$LAUNCH_AGENTS_DIR/$LABEL.plist"
NODE_BIN="$(command -v node || true)"
NPM_BIN="$(command -v npm || true)"
GUI_DOMAIN="gui/$(id -u)"
SERVICE_TARGET="$GUI_DOMAIN/$LABEL"

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "此安装脚本仅支持 macOS。" >&2
  exit 1
fi

if [[ -z "$NODE_BIN" || -z "$NPM_BIN" ]]; then
  echo "没有找到 Node.js 或 npm。请先安装 Node.js 20 或更高版本。" >&2
  exit 1
fi

echo "正在构建 Lecture Bridge…"
cd "$PROJECT_DIR"
"$NPM_BIN" run build

mkdir -p "$LAUNCH_AGENTS_DIR" "$LOG_DIR" "$INSTALL_DIR"

# LaunchAgents cannot reliably read projects inside ~/Documents under macOS privacy controls.
# Install the production-only runtime in Application Support instead.
/usr/bin/ditto "$PROJECT_DIR/dist" "$INSTALL_DIR/dist"
/usr/bin/ditto "$PROJECT_DIR/dist-app-server" "$INSTALL_DIR/dist-app-server"
if [[ ! -f "$INSTALL_DIR/.env" && -f "$PROJECT_DIR/.env" ]]; then
  /usr/bin/ditto "$PROJECT_DIR/.env" "$INSTALL_DIR/.env"
  chmod 600 "$INSTALL_DIR/.env"
fi

TEMP_PLIST="$(mktemp "${TMPDIR:-/tmp}/lecture-bridge-plist.XXXXXX")"
trap 'rm -f "$TEMP_PLIST"' EXIT

plutil -create xml1 "$TEMP_PLIST"
plutil -insert Label -string "$LABEL" "$TEMP_PLIST"
plutil -insert ProgramArguments -json '[]' "$TEMP_PLIST"
plutil -insert ProgramArguments.0 -string "$NODE_BIN" "$TEMP_PLIST"
plutil -insert ProgramArguments.1 -string "$INSTALL_DIR/dist-app-server/index.mjs" "$TEMP_PLIST"
plutil -insert WorkingDirectory -string "$INSTALL_DIR" "$TEMP_PLIST"
plutil -insert RunAtLoad -bool true "$TEMP_PLIST"
plutil -insert KeepAlive -bool true "$TEMP_PLIST"
plutil -insert ProcessType -string Background "$TEMP_PLIST"
plutil -insert ThrottleInterval -integer 10 "$TEMP_PLIST"
plutil -insert EnvironmentVariables -json '{}' "$TEMP_PLIST"
plutil -insert EnvironmentVariables.PATH -string "$(dirname "$NODE_BIN"):/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin" "$TEMP_PLIST"
plutil -insert StandardOutPath -string "$LOG_DIR/server.log" "$TEMP_PLIST"
plutil -insert StandardErrorPath -string "$LOG_DIR/server-error.log" "$TEMP_PLIST"
chmod 600 "$TEMP_PLIST"
mv "$TEMP_PLIST" "$PLIST_PATH"
trap - EXIT

if launchctl print "$SERVICE_TARGET" >/dev/null 2>&1; then
  launchctl bootout "$SERVICE_TARGET"
  for _ in {1..20}; do
    if ! launchctl print "$SERVICE_TARGET" >/dev/null 2>&1; then
      break
    fi
    sleep 0.1
  done
fi
launchctl enable "$SERVICE_TARGET"
launchctl bootstrap "$GUI_DOMAIN" "$PLIST_PATH"
launchctl kickstart -k "$SERVICE_TARGET"

READY=false
for _ in {1..20}; do
  if curl --silent --fail http://127.0.0.1:8787/api/health >/dev/null; then
    READY=true
    break
  fi
  sleep 0.25
done

if [[ "$READY" != "true" ]]; then
  echo "后台服务已注册，但尚未响应。请运行 npm run app:status 查看状态。" >&2
  exit 1
fi

echo "Lecture Bridge 后台服务已安装，并会在登录 macOS 后自动启动。"
echo "服务地址：http://127.0.0.1:8787"
echo "下一步：在打开的 Chrome 页面点击“安装应用”，然后固定到 Dock。"

if [[ "${1:-}" != "--no-open" ]]; then
  if [[ -d "/Applications/Google Chrome.app" || -d "$HOME/Applications/Google Chrome.app" ]]; then
    /usr/bin/open -a "Google Chrome" "http://127.0.0.1:8787"
  else
    /usr/bin/open "http://127.0.0.1:8787"
  fi
fi
