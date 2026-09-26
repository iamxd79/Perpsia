// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

contract MockPerpsIA {
    string public constant name = "Mock PerpsIA";
    string public constant symbol = "PERPSIA_TEST";
    uint8 public constant decimals = 18;
    uint256 public totalSupply;
    address public owner;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);
    modifier onlyOwner() { require(msg.sender == owner, "NOT_OWNER"); _; }
    constructor() { owner = msg.sender; }
    function mint(address to, uint256 amount) external onlyOwner { require(to != address(0), "ZERO_RECIPIENT"); totalSupply += amount; balanceOf[to] += amount; emit Transfer(address(0), to, amount); }
    function approve(address spender, uint256 amount) external returns (bool) { allowance[msg.sender][spender] = amount; emit Approval(msg.sender, spender, amount); return true; }
    function transfer(address to, uint256 amount) external returns (bool) { _transfer(msg.sender, to, amount); return true; }
    function transferFrom(address from, address to, uint256 amount) external returns (bool) { uint256 allowed = allowance[from][msg.sender]; require(allowed >= amount, "ALLOWANCE"); if (allowed != type(uint256).max) allowance[from][msg.sender] = allowed - amount; _transfer(from, to, amount); return true; }
    function _transfer(address from, address to, uint256 amount) internal { require(to != address(0), "ZERO_RECIPIENT"); require(balanceOf[from] >= amount, "BALANCE"); balanceOf[from] -= amount; balanceOf[to] += amount; emit Transfer(from, to, amount); }
}
