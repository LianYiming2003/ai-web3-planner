#!/usr/bin/env bash
set -e

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "==============================="
echo "  Deploy TaskManager (localhost)"
echo "==============================="

cd "$ROOT_DIR/contracts"

# 编译一下，避免 artifacts 不更新
npx hardhat compile

# 部署，并从输出里抓 Contract address
echo "🚀 Deploying TaskManager to localhost..."
DEPLOY_OUTPUT=$(npx hardhat run scripts/deploy_taskmanager.js --network localhost)

echo "$DEPLOY_OUTPUT"

ADDR=$(echo "$DEPLOY_OUTPUT" | awk '/Contract address/ {print $3}' | tail -n1)

if [ -z "$ADDR" ]; then
  echo "❌ 没从输出里解析到 Contract address,检查一下 deploy 脚本输出格式。"
  exit 1
fi

echo "✅ Parsed contract address: $ADDR"

# 更新 frontend/.env 里的 VITE_TASK_MANAGER_ADDR
ENV_FILE="$ROOT_DIR/frontend/.env"
if [ ! -f "$ENV_FILE" ]; then
  echo "⚠️ frontend/.env 不存在，先跑一遍 ./dev_setup.sh 或自己建一个。"
  exit 1
fi

# Mac 的 sed 和 Linux 略有差异，这里照顾 macOS：-i 后跟空字符串
if grep -q '^VITE_TASK_MANAGER_ADDR=' "$ENV_FILE"; then
  # 替换原有行
  sed -i '' "s/^VITE_TASK_MANAGER_ADDR=.*/VITE_TASK_MANAGER_ADDR=$ADDR/" "$ENV_FILE"
else
  # 没有的话就追加一行
  echo "VITE_TASK_MANAGER_ADDR=$ADDR" >> "$ENV_FILE"
fi

echo "✅ Updated frontend/.env with VITE_TASK_MANAGER_ADDR=$ADDR"

# 顺便把最新 ABI 拷到前端
CONTRACT_ARTIFACT="$ROOT_DIR/contracts/artifacts/contracts/TaskManager.sol/TaskManager.json"
FRONTEND_ABI_DIR="$ROOT_DIR/frontend/src/abis"

if [ -f "$CONTRACT_ARTIFACT" ]; then
  mkdir -p "$FRONTEND_ABI_DIR"
  cp "$CONTRACT_ARTIFACT" "$FRONTEND_ABI_DIR/TaskManager.json"
  echo "✅ Copied latest TaskManager.json ABI to frontend/src/abis/"
else
  echo "⚠️ 没找到 TaskManager.json,可能编译有问题。"
fi

echo
echo "🎉 Deploy & env update done."
echo "记得在另外一个终端已经跑着:npx hardhat node"
echo
