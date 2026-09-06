#!/bin/bash

set -euo pipefail

LABEL="com.lecturebridge.server"
USER_LIBRARY="${HOME:?}/Library"
PLIST_PATH="$USER_LIBRARY/LaunchAgents/$LABEL.plist"
SERVICE_TARGET="gui/$(id -u)/$LABEL"

if launchctl print "$SERVICE_TARGET" >/dev/null 2>&1; then
  launchctl bootout "$SERVICE_TARGET"
fi

if [[ -f "$PLIST_PATH" ]]; then
  rm -f "$PLIST_PATH"
fi

echo "Lecture Bridge 后台服务已卸载。"
echo "项目、模型配置、日志和浏览器中的字幕均未删除。"
echo "如需移除 PWA，请在 Chrome 的 Lecture Bridge 应用菜单中选择“卸载 Lecture Bridge”。"
