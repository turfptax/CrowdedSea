const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

describe("BountyPool", function () {
  let pool, owner, depositor, agent, other;
  const FEE_BPS = 250; // 2.5%
  const ONE_ETH = ethers.parseEther("1.0");
  const SMALL   = ethers.parseEther("0.001");

  beforeEach(async () => {
    [owner, depositor, agent, other] = await ethers.getSigners();
    const Factory = await ethers.getContractFactory("BountyPool");
    pool = await Factory.deploy(FEE_BPS);
  });

  // ── Deposit ────────────────────────────────────
  describe("deposit", () => {
    it("creates a bounty and emits BountyCreated", async () => {
      await expect(pool.connect(depositor).deposit("user/repo#1", { value: SMALL }))
        .to.emit(pool, "BountyCreated")
        .withArgs(0, depositor.address, SMALL, "user/repo#1");

      const b = await pool.getBounty(0);
      expect(b.depositor).to.equal(depositor.address);
      expect(b.amount).to.equal(SMALL);
      expect(b.status).to.equal(0); // Open
    });

    it("reverts on zero value", async () => {
      await expect(pool.deposit("x", { value: 0 })).to.be.revertedWith("Must send ETH");
    });

    it("reverts on empty URI", async () => {
      await expect(pool.deposit("", { value: SMALL })).to.be.revertedWith("Empty issue URI");
    });

    it("increments bounty IDs", async () => {
      await pool.connect(depositor).deposit("a", { value: SMALL });
      await pool.connect(depositor).deposit("b", { value: SMALL });
      expect(await pool.nextBountyId()).to.equal(2);
    });
  });

  // ── Claim ──────────────────────────────────────
  describe("claim", () => {
    beforeEach(async () => {
      await pool.connect(depositor).deposit("user/repo#1", { value: ONE_ETH });
    });

    it("lets an agent claim an open bounty", async () => {
      await expect(pool.connect(agent).claim(0))
        .to.emit(pool, "BountyClaimed")
        .withArgs(0, agent.address);

      const b = await pool.getBounty(0);
      expect(b.claimant).to.equal(agent.address);
      expect(b.status).to.equal(1); // Claimed
    });

    it("prevents depositor from claiming own bounty", async () => {
      await expect(pool.connect(depositor).claim(0)).to.be.revertedWith("Cannot claim own bounty");
    });

    it("prevents double-claim", async () => {
      await pool.connect(agent).claim(0);
      await expect(pool.connect(other).claim(0)).to.be.revertedWith("Not open");
    });
  });

  // ── Complete ───────────────────────────────────
  describe("complete", () => {
    beforeEach(async () => {
      await pool.connect(depositor).deposit("user/repo#1", { value: ONE_ETH });
      await pool.connect(agent).claim(0);
    });

    it("pays claimant minus fee", async () => {
      await expect(pool.connect(owner).complete(0)).to.emit(pool, "BountyCompleted");

      const fee = (ONE_ETH * BigInt(FEE_BPS)) / 10000n;
      const payout = ONE_ETH - fee;

      expect(await pool.pendingWithdrawals(agent.address)).to.equal(payout);
      expect(await pool.pendingWithdrawals(owner.address)).to.equal(fee);
    });

    it("only owner can complete", async () => {
      await expect(pool.connect(agent).complete(0)).to.be.revertedWith("Not owner");
    });
  });

  // ── Refund ─────────────────────────────────────
  describe("refund", () => {
    beforeEach(async () => {
      await pool.connect(depositor).deposit("user/repo#1", { value: ONE_ETH });
    });

    it("depositor can refund an open bounty", async () => {
      await expect(pool.connect(depositor).refund(0))
        .to.emit(pool, "BountyRefunded")
        .withArgs(0, depositor.address, ONE_ETH);

      expect(await pool.pendingWithdrawals(depositor.address)).to.equal(ONE_ETH);
    });

    it("anyone can refund an expired claim", async () => {
      await pool.connect(agent).claim(0);
      await time.increase(7 * 24 * 60 * 60 + 1); // 7 days + 1s

      await pool.connect(other).refund(0);
      expect(await pool.pendingWithdrawals(depositor.address)).to.equal(ONE_ETH);
    });

    it("cannot refund an active claim before expiry", async () => {
      await pool.connect(agent).claim(0);
      await expect(pool.connect(depositor).refund(0)).to.be.revertedWith("Cannot refund");
    });
  });

  // ── Withdraw ───────────────────────────────────
  describe("withdraw", () => {
    it("transfers credited balance", async () => {
      await pool.connect(depositor).deposit("x", { value: ONE_ETH });
      await pool.connect(depositor).refund(0);

      const before = await ethers.provider.getBalance(depositor.address);
      const tx = await pool.connect(depositor).withdraw();
      const receipt = await tx.wait();
      const gas = receipt.gasUsed * receipt.gasPrice;
      const after = await ethers.provider.getBalance(depositor.address);

      expect(after - before + gas).to.equal(ONE_ETH);
    });

    it("reverts when nothing to withdraw", async () => {
      await expect(pool.connect(agent).withdraw()).to.be.revertedWith("Nothing to withdraw");
    });
  });

  // ── Admin ──────────────────────────────────────
  describe("admin", () => {
    it("owner can update fee", async () => {
      await pool.setFeeBps(500);
      expect(await pool.protocolFeeBps()).to.equal(500);
    });

    it("rejects fee > 10%", async () => {
      await expect(pool.setFeeBps(1001)).to.be.revertedWith("Fee too high");
    });

    it("transfers ownership", async () => {
      await pool.transferOwnership(agent.address);
      expect(await pool.owner()).to.equal(agent.address);
    });
  });
});
