const hre = require("hardhat");

async function main() {
  const TaskManager = await hre.ethers.getContractFactory("TaskManager");
  const tm = await TaskManager.deploy();
  await tm.waitForDeployment();
  console.log("TaskManager deployed to:", await tm.getAddress());
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
