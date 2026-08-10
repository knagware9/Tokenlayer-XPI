// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title ComplianceToken3643
 * @notice A simplified ERC-3643 (T-REX) style permissioned security token. Like
 *         ComplianceToken, but the identity allowlist is *mandatory* (every
 *         holder must be registered) and the operator can perform a forced
 *         transfer for recovery — capturing T-REX's intent without the full
 *         ONCHAINID / modular-compliance suite.
 *
 *         It deliberately exposes the same fungible ABI as ComplianceToken
 *         (mint/transfer/burn/setFrozen/setAllowed/balanceOf/totalSupply/...),
 *         so the EVM adapter drives all fungible standards through one ABI.
 */
contract ComplianceToken3643 {
    string public name;
    string public symbol;
    /// @notice Indivisible — see ComplianceToken; the platform accounts in whole units.
    uint8 public constant decimals = 0;

    address public immutable operator;
    bool public constant allowlistEnabled = true; // identity registry is mandatory

    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => bool) public isFrozen;
    mapping(address => bool) public isAllowed; // identity-registered investors

    event Minted(address indexed to, uint256 amount);
    event Burned(address indexed from, uint256 amount);
    event Moved(address indexed from, address indexed to, uint256 amount);
    event ForcedTransfer(address indexed from, address indexed to, uint256 amount);
    event FrozenSet(address indexed account, bool frozen);
    event AllowedSet(address indexed account, bool allowed);

    error NotOperator();
    error NotAllowlisted(address account);
    error AccountFrozen(address account);
    error InsufficientBalance(address account);
    error ZeroAmount();

    modifier onlyOperator() {
        if (msg.sender != operator) revert NotOperator();
        _;
    }

    // `_allowlistEnabled` accepted for ABI parity with ComplianceToken; ignored.
    constructor(string memory _name, string memory _symbol, bool) {
        name = _name;
        symbol = _symbol;
        operator = msg.sender;
    }

    function mint(address to, uint256 amount) external onlyOperator {
        if (amount == 0) revert ZeroAmount();
        if (!isAllowed[to]) revert NotAllowlisted(to);
        if (isFrozen[to]) revert AccountFrozen(to);
        balanceOf[to] += amount;
        totalSupply += amount;
        emit Minted(to, amount);
    }

    function transfer(address from, address to, uint256 amount) external onlyOperator {
        if (amount == 0) revert ZeroAmount();
        if (isFrozen[from]) revert AccountFrozen(from);
        if (isFrozen[to]) revert AccountFrozen(to);
        if (!isAllowed[from]) revert NotAllowlisted(from);
        if (!isAllowed[to]) revert NotAllowlisted(to);
        if (balanceOf[from] < amount) revert InsufficientBalance(from);
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        emit Moved(from, to, amount);
    }

    /// @notice Recovery path: the agent moves tokens regardless of freeze state.
    function forcedTransfer(address from, address to, uint256 amount) external onlyOperator {
        if (amount == 0) revert ZeroAmount();
        if (!isAllowed[to]) revert NotAllowlisted(to);
        if (balanceOf[from] < amount) revert InsufficientBalance(from);
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        emit ForcedTransfer(from, to, amount);
    }

    function burn(address from, uint256 amount) external onlyOperator {
        if (amount == 0) revert ZeroAmount();
        if (balanceOf[from] < amount) revert InsufficientBalance(from);
        balanceOf[from] -= amount;
        totalSupply -= amount;
        emit Burned(from, amount);
    }

    function setFrozen(address account, bool frozen) external onlyOperator {
        isFrozen[account] = frozen;
        emit FrozenSet(account, frozen);
    }

    function setAllowed(address account, bool allowed) external onlyOperator {
        isAllowed[account] = allowed;
        emit AllowedSet(account, allowed);
    }
}
