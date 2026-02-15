// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title CrowdedSea BountyPool
 * @notice CrowdedSea — Crypto-backed bounty escrow for AI-agent-funded GitHub repo maintenance.
 *         Agents deposit tokens to fund tasks; funds release only after merge + tests pass.
 * @dev    Deploy on Polygon Amoy testnet first, then mainnet.
 */
contract BountyPool {
    // ──────────────────────────────────────────────
    //  Types
    // ──────────────────────────────────────────────
    enum BountyStatus { Open, Claimed, Completed, Refunded }

    struct Bounty {
        uint256 id;
        address depositor;      // who funded the bounty
        address claimant;       // agent/dev who claimed it
        uint256 amount;         // wei locked
        string  issueUri;       // e.g. "owner/repo#42"
        BountyStatus status;
        uint256 createdAt;
        uint256 claimedAt;
    }

    // ──────────────────────────────────────────────
    //  State
    // ──────────────────────────────────────────────
    address public owner;
    uint256 public nextBountyId;
    uint256 public protocolFeeBps; // basis points (default 250 = 2.5%)

    mapping(uint256 => Bounty) public bounties;
    mapping(address => uint256) public pendingWithdrawals;

    uint256 public constant MAX_CLAIM_DURATION = 7 days;

    // ──────────────────────────────────────────────
    //  Events
    // ──────────────────────────────────────────────
    event BountyCreated(uint256 indexed id, address indexed depositor, uint256 amount, string issueUri);
    event BountyClaimed(uint256 indexed id, address indexed claimant);
    event BountyCompleted(uint256 indexed id, address indexed claimant, uint256 payout, uint256 fee);
    event BountyRefunded(uint256 indexed id, address indexed depositor, uint256 amount);
    event Withdrawal(address indexed to, uint256 amount);

    // ──────────────────────────────────────────────
    //  Modifiers
    // ──────────────────────────────────────────────
    modifier onlyOwner() {
        require(msg.sender == owner, "Not owner");
        _;
    }

    // ──────────────────────────────────────────────
    //  Constructor
    // ──────────────────────────────────────────────
    constructor(uint256 _feeBps) {
        require(_feeBps <= 1000, "Fee too high"); // max 10%
        owner = msg.sender;
        protocolFeeBps = _feeBps;
    }

    // ──────────────────────────────────────────────
    //  Core: Deposit → Claim → Complete / Refund
    // ──────────────────────────────────────────────

    /**
     * @notice Fund a new bounty tied to a GitHub issue URI.
     * @param issueUri  e.g. "user/repo#42"
     */
    function deposit(string calldata issueUri) external payable returns (uint256 bountyId) {
        require(msg.value > 0, "Must send ETH");
        require(bytes(issueUri).length > 0, "Empty issue URI");

        bountyId = nextBountyId++;
        bounties[bountyId] = Bounty({
            id: bountyId,
            depositor: msg.sender,
            claimant: address(0),
            amount: msg.value,
            issueUri: issueUri,
            status: BountyStatus.Open,
            createdAt: block.timestamp,
            claimedAt: 0
        });

        emit BountyCreated(bountyId, msg.sender, msg.value, issueUri);
    }

    /**
     * @notice Agent claims an open bounty (locks it to their address).
     */
    function claim(uint256 bountyId) external {
        Bounty storage b = bounties[bountyId];
        require(b.status == BountyStatus.Open, "Not open");
        require(b.depositor != msg.sender, "Cannot claim own bounty");

        b.claimant = msg.sender;
        b.status = BountyStatus.Claimed;
        b.claimedAt = block.timestamp;

        emit BountyClaimed(bountyId, msg.sender);
    }

    /**
     * @notice Owner marks bounty complete after merge + tests pass.
     *         Pays claimant minus protocol fee.
     */
    function complete(uint256 bountyId) external onlyOwner {
        Bounty storage b = bounties[bountyId];
        require(b.status == BountyStatus.Claimed, "Not claimed");

        uint256 fee = (b.amount * protocolFeeBps) / 10_000;
        uint256 payout = b.amount - fee;

        b.status = BountyStatus.Completed;

        // Pull pattern: credit balances instead of direct transfer
        pendingWithdrawals[b.claimant] += payout;
        pendingWithdrawals[owner] += fee;

        emit BountyCompleted(bountyId, b.claimant, payout, fee);
    }

    /**
     * @notice Refund an open bounty back to the depositor.
     *         Also auto-refunds expired claims (> MAX_CLAIM_DURATION).
     */
    function refund(uint256 bountyId) external {
        Bounty storage b = bounties[bountyId];

        bool isOpen = b.status == BountyStatus.Open && msg.sender == b.depositor;
        bool isExpiredClaim = b.status == BountyStatus.Claimed
            && block.timestamp > b.claimedAt + MAX_CLAIM_DURATION;

        require(isOpen || isExpiredClaim, "Cannot refund");

        b.status = BountyStatus.Refunded;
        pendingWithdrawals[b.depositor] += b.amount;

        emit BountyRefunded(bountyId, b.depositor, b.amount);
    }

    /**
     * @notice Withdraw any credited balance (payouts or refunds).
     */
    function withdraw() external {
        uint256 amount = pendingWithdrawals[msg.sender];
        require(amount > 0, "Nothing to withdraw");

        pendingWithdrawals[msg.sender] = 0;
        (bool ok, ) = payable(msg.sender).call{value: amount}("");
        require(ok, "Transfer failed");

        emit Withdrawal(msg.sender, amount);
    }

    // ──────────────────────────────────────────────
    //  Views
    // ──────────────────────────────────────────────

    function getBounty(uint256 bountyId) external view returns (Bounty memory) {
        return bounties[bountyId];
    }

    function getPoolBalance() external view returns (uint256) {
        return address(this).balance;
    }

    // ──────────────────────────────────────────────
    //  Admin
    // ──────────────────────────────────────────────

    function setFeeBps(uint256 _feeBps) external onlyOwner {
        require(_feeBps <= 1000, "Fee too high");
        protocolFeeBps = _feeBps;
    }

    function transferOwnership(address newOwner) external onlyOwner {
        require(newOwner != address(0), "Zero address");
        owner = newOwner;
    }

    receive() external payable {}
}
