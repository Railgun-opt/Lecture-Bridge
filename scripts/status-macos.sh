#!/bin/bash

set -euo pipefail

LABEL="com.lecturebridge.server"
SERVICE_TARGET="gui/$(id -u)/$LABEL"

if launchctl print "$SERVICE_TARGET" >/dev/null 2>&1; then
  echo "后台服务：已注册并由 macOS 管理"
else
  echo "后台服务：未安装"
fi

if curl --silent --fail http://127.0.0.1:8787/api/health >/dev/null; then
  echo "健康检查：正常（http://127.0.0.1:8787）"
else
  echo "健康检查：无法连接"
  exit 1
fi
