#!/usr/bin/env bash
set -e

echo "==============================="
echo "  AI Web3 Planner Dev Setup"
echo "==============================="

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
echo "Project root: $ROOT_DIR"
echo

### 1) contracts 依赖
echo "[1/4] Installing contracts dependencies..."
cd "$ROOT_DIR/contracts"
npm install
echo "✅ contracts done."
echo

### 2) backend 依赖
echo "[2/4] Installing backend dependencies..."
cd "$ROOT_DIR/backend"
npm install
echo "✅ backend done."
echo

### 3) frontend 依赖
echo "[3/4] Installing frontend dependencies..."
cd "$ROOT_DIR/frontend"
npm install
echo "✅ frontend done."
echo

### 4) 处理 frontend/.env
ENV_EXAMPLE="$ROOT_DIR/frontend/.env.example"
ENV_FILE="$ROOT_DIR/frontend/.env"

echo "[4/4] Checking frontend .env ..."
if [ -f "$ENV_FILE" ]; then
  echo "✅ frontend/.env already exists (不会覆盖你本地的 secret)。"
elif [ -f "$ENV_EXAMPLE" ]; then
  cp "$ENV_EXAMPLE" "$ENV_FILE"
  echo "✅ Created frontend/.env from .env.example."
else
  echo "⚠️ frontend/.env.example 不存在，帮不了你自动创建 .env。"
  echo "   你可以手动在 frontend 目录建一个 .env 文件。"
fi

echo
echo "🎉 Dev setup finished."
echo "下一步一般是："
echo "  1) cd contracts && npx hardhat node"
echo "  2) 另开终端：./deploy_local.sh   # 自动部署 + 写入 .env 地址（见下面脚本）"
echo "  3) 另开终端：cd backend && npm run dev"
echo "  4) 另开终端：cd frontend && npm run dev"
echo
