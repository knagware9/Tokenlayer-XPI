// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title ComplianceNFT
 * @notice An operator-mediated, compliance-aware ERC-721-style non-fungible
 *         token. Mirrors ComplianceToken's operator model and compliance rules
 *         (allowlist + freeze) but tracks ownership by token id with per-token
 *         URIs and owner enumeration. The same rules are mirrored by the
 *         off-chain SimulatedLedger so NFTs behave identically across DLTs.
 */
contract ComplianceNFT {
    string public name;
    string public symbol;

    address public immutable operator;
    bool public immutable allowlistEnabled;

    uint256 public totalSupply;
    mapping(uint256 => address) private _owner;
    mapping(uint256 => string) public tokenURI;
    mapping(address => uint256[]) private _owned;
    mapping(uint256 => uint256) private _ownedIndex;

    mapping(address => bool) public isFrozen;
    mapping(address => bool) public isAllowed;

    event Minted(address indexed to, uint256 indexed tokenId);
    event Burned(uint256 indexed tokenId);
    event Moved(address indexed from, address indexed to, uint256 indexed tokenId);
    event FrozenSet(address indexed account, bool frozen);
    event AllowedSet(address indexed account, bool allowed);

    error NotOperator();
    error NotAllowlisted(address account);
    error AccountFrozen(address account);
    error TokenExists(uint256 tokenId);
    error NoSuchToken(uint256 tokenId);
    error NotOwner(address account, uint256 tokenId);

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

    function ownerOf(uint256 tokenId) external view returns (address) {
        return _owner[tokenId];
    }

    function balanceOf(address account) external view returns (uint256) {
        return _owned[account].length;
    }

    function tokensOf(address account) external view returns (uint256[] memory) {
        return _owned[account];
    }

    function mintToken(address to, uint256 tokenId, string calldata uri) external onlyOperator {
        if (_owner[tokenId] != address(0)) revert TokenExists(tokenId);
        if (allowlistEnabled && !isAllowed[to]) revert NotAllowlisted(to);
        if (isFrozen[to]) revert AccountFrozen(to);
        _owner[tokenId] = to;
        tokenURI[tokenId] = uri;
        _addToOwner(to, tokenId);
        totalSupply += 1;
        emit Minted(to, tokenId);
    }

    function transferToken(address from, address to, uint256 tokenId) external onlyOperator {
        if (_owner[tokenId] != from) revert NotOwner(from, tokenId);
        if (isFrozen[from]) revert AccountFrozen(from);
        if (isFrozen[to]) revert AccountFrozen(to);
        if (allowlistEnabled && !isAllowed[from]) revert NotAllowlisted(from);
        if (allowlistEnabled && !isAllowed[to]) revert NotAllowlisted(to);
        _removeFromOwner(from, tokenId);
        _owner[tokenId] = to;
        _addToOwner(to, tokenId);
        emit Moved(from, to, tokenId);
    }

    function burnToken(uint256 tokenId) external onlyOperator {
        address holder = _owner[tokenId];
        if (holder == address(0)) revert NoSuchToken(tokenId);
        _removeFromOwner(holder, tokenId);
        delete _owner[tokenId];
        delete tokenURI[tokenId];
        totalSupply -= 1;
        emit Burned(tokenId);
    }

    function setFrozen(address account, bool frozen) external onlyOperator {
        isFrozen[account] = frozen;
        emit FrozenSet(account, frozen);
    }

    function setAllowed(address account, bool allowed) external onlyOperator {
        isAllowed[account] = allowed;
        emit AllowedSet(account, allowed);
    }

    function _addToOwner(address to, uint256 tokenId) private {
        _ownedIndex[tokenId] = _owned[to].length;
        _owned[to].push(tokenId);
    }

    function _removeFromOwner(address from, uint256 tokenId) private {
        uint256 lastIndex = _owned[from].length - 1;
        uint256 idx = _ownedIndex[tokenId];
        uint256 lastToken = _owned[from][lastIndex];
        _owned[from][idx] = lastToken;
        _ownedIndex[lastToken] = idx;
        _owned[from].pop();
        delete _ownedIndex[tokenId];
    }
}
