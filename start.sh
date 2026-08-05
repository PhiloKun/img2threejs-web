#!/usr/bin/env bash
# 一键启动 img2threejs Web 应用（macOS / Linux）
set -e
cd "$(dirname "$0")"

echo "==> 安装依赖（仅首次需要，可跳过）"
npm --prefix web install

echo ""
echo "==> 启动开发服务器 → http://localhost:5173"
echo "    按 Ctrl+C 停止"
echo ""
npm --prefix web run dev
