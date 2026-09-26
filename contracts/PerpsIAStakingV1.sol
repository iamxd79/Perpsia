// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IERC20Minimal {
    function balanceOf(address account) external view returns (uint256);
    function transfer(address recipient, uint256 amount) external returns (bool);
    function transferFrom(address sender, address recipient, uint256 amount) external returns (bool);
}

/// @notice Minimal non-upgradeable staking vault for a fixed PERPSIA token.
/// @dev Intended for testnet review only. It has no rewards, fees, inflation, or admin withdrawal of staked tokens.
contract PerpsIAStakingV1 {
    IERC20Minimal public immutable stakingToken;
    address public owner;
    address public pendingOwner;
    bool public paused;
    uint256 public totalStaked;
    mapping(address => uint256) public stakedBalance;
    uint256 private _lock = 1;

    event Staked(address indexed account, uint256 amount);
    event Unstaked(address indexed account, uint256 amount);
    event Paused(address indexed account);
    event Unpaused(address indexed account);
    event OwnershipTransferStarted(address indexed previousOwner, address indexed newOwner);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    modifier onlyOwner() { require(msg.sender == owner, "NOT_OWNER"); _; }
    modifier nonReentrant() { require(_lock == 1, "REENTRANT"); _lock = 2; _; _lock = 1; }
    modifier whenNotPaused() { require(!paused, "PAUSED"); _; }

    constructor(address token) {
        require(token != address(0), "ZERO_TOKEN");
        stakingToken = IERC20Minimal(token);
        owner = msg.sender;
        emit OwnershipTransferred(address(0), msg.sender);
    }

    function stake(uint256 amount) external whenNotPaused nonReentrant {
        require(amount > 0, "ZERO_AMOUNT");
        uint256 beforeBalance = stakingToken.balanceOf(address(this));
        require(stakingToken.transferFrom(msg.sender, address(this), amount), "TRANSFER_FROM_FAILED");
        uint256 received = stakingToken.balanceOf(address(this)) - beforeBalance;
        require(received == amount, "FEE_ON_TRANSFER_UNSUPPORTED");
        stakedBalance[msg.sender] += amount;
        totalStaked += amount;
        emit Staked(msg.sender, amount);
    }

    function unstake(uint256 amount) external whenNotPaused nonReentrant {
        require(amount > 0, "ZERO_AMOUNT");
        require(stakedBalance[msg.sender] >= amount, "INSUFFICIENT_STAKE");
        stakedBalance[msg.sender] -= amount;
        totalStaked -= amount;
        require(stakingToken.transfer(msg.sender, amount), "TRANSFER_FAILED");
        emit Unstaked(msg.sender, amount);
    }

    function pause() external onlyOwner { paused = true; emit Paused(msg.sender); }
    function unpause() external onlyOwner { paused = false; emit Unpaused(msg.sender); }

    function transferOwnership(address newOwner) external onlyOwner {
        require(newOwner != address(0), "ZERO_OWNER");
        pendingOwner = newOwner;
        emit OwnershipTransferStarted(owner, newOwner);
    }

    function acceptOwnership() external {
        require(msg.sender == pendingOwner, "NOT_PENDING_OWNER");
        address previousOwner = owner;
        owner = msg.sender;
        pendingOwner = address(0);
        emit OwnershipTransferred(previousOwner, msg.sender);
    }

    function rescueERC20(address token, address recipient, uint256 amount) external onlyOwner {
        require(token != address(stakingToken), "STAKING_TOKEN_PROTECTED");
        require(recipient != address(0), "ZERO_RECIPIENT");
        require(IERC20Minimal(token).transfer(recipient, amount), "RESCUE_FAILED");
    }
}
