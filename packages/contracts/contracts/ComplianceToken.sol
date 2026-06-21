// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title ComplianceToken
 * @notice A platform-operated, compliance-aware token. The deploying platform
 *         address is the sole operator ("transfer agent"): it mints, moves, and
 *         burns tokens on behalf of holders, and maintains the freeze list and
 *         (optionally) an allowlist. This models enterprise tokenization where
 *         the issuer/transfer-agent mediates transfers rather than holders
 *         transacting peer-to-peer.
 *
 *         The same rules are mirrored by the off-chain MockLedgerAdapter, so the
 *         platform behaves identically whether an asset lives on this contract
 *         or on the mock chain.
 */
contract ComplianceToken {
    string public name;
    string public symbol;
    uint8 public constant decimals = 18;

    address public immutable operator;
    bool public immutable allowlistEnabled;

    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => bool) public isFrozen;
    mapping(address => bool) public isAllowed;

    event Minted(address indexed to, uint256 amount);
    event Burned(address indexed from, uint256 amount);
    event Moved(address indexed from, address indexed to, uint256 amount);
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

    constructor(string memory _name, string memory _symbol, bool _allowlistEnabled) {
        name = _name;
        symbol = _symbol;
        allowlistEnabled = _allowlistEnabled;
        operator = msg.sender;
    }

    function mint(address to, uint256 amount) external onlyOperator {
        if (amount == 0) revert ZeroAmount();
        if (allowlistEnabled && !isAllowed[to]) revert NotAllowlisted(to);
        if (isFrozen[to]) revert AccountFrozen(to);
        balanceOf[to] += amount;
        totalSupply += amount;
        emit Minted(to, amount);
    }

    function transfer(address from, address to, uint256 amount) external onlyOperator {
        if (amount == 0) revert ZeroAmount();
        if (isFrozen[from]) revert AccountFrozen(from);
        if (isFrozen[to]) revert AccountFrozen(to);
        if (allowlistEnabled && !isAllowed[from]) revert NotAllowlisted(from);
        if (allowlistEnabled && !isAllowed[to]) revert NotAllowlisted(to);
        if (balanceOf[from] < amount) revert InsufficientBalance(from);
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        emit Moved(from, to, amount);
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
