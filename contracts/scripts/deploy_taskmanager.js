// scripts/deploy_taskmanager.js
const hre = require("hardhat");

async function main() {
  // ethers v6 推荐写法：直接用 deployContract
  const taskManager = await hre.ethers.deployContract("TaskManager");

  // 等待部署完成（v6 用 waitForDeployment，而不是 deployed()）
  await taskManager.waitForDeployment();

  // 获取合约地址（v6 用 getAddress() 或 target）
  const address = await taskManager.getAddress();

  console.log("TaskManager deployed to:", address);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

