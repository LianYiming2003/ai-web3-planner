// scripts/deploy_planmanager.js
const hre = require("hardhat");

async function main() {
  const PlanManager = await hre.ethers.getContractFactory("PlanManager");
  const pm = await PlanManager.deploy();
  await pm.waitForDeployment();
  console.log("PlanManager deployed to:", await pm.getAddress());
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
