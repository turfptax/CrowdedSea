const hre = require("hardhat");

async function main() {
  const FEE_BPS = 250; // 2.5% protocol fee

  console.log("Deploying BountyPool with fee:", FEE_BPS, "bps");
  console.log("Network:", hre.network.name);

  const BountyPool = await hre.ethers.getContractFactory("BountyPool");
  const pool = await BountyPool.deploy(FEE_BPS);
  await pool.waitForDeployment();

  const address = await pool.getAddress();
  console.log("✅ BountyPool deployed to:", address);

  // Wait for a few confirmations before verifying
  if (hre.network.name !== "hardhat") {
    console.log("Waiting for 5 confirmations...");
    await pool.deploymentTransaction().wait(5);

    console.log("Verifying on Polygonscan...");
    try {
      await hre.run("verify:verify", {
        address,
        constructorArguments: [FEE_BPS],
      });
      console.log("✅ Contract verified!");
    } catch (err) {
      console.log("⚠️  Verification failed (may already be verified):", err.message);
    }
  }

  return address;
}

main()
  .then((addr) => {
    console.log("\n🎉 Done! Contract:", addr);
    process.exit(0);
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
