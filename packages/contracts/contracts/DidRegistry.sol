// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title DidRegistry
 * @notice The on-chain trust list of ORGANIZATION parent DIDs.
 *
 *         SCOPE: organization DIDs only — never member sub-DIDs. An org's DID is
 *         already public (it is the `iss` of every credential that org signs), so
 *         registering it discloses nothing new. A member's sub-DID is personal and
 *         stays off-chain.
 *
 *         NO PUBLIC KEY IS STORED. Our DIDs are did:key — the public key IS the
 *         DID string, resolvable offline with no chain and no database. Storing it
 *         would be pure redundancy. What this registry adds is the two things a
 *         did:key cannot express by itself: DEACTIVATION of a compromised org DID,
 *         and an enumerable list of who is registered.
 *
 *         Enumeration is deliberate here: a trust list is meant to be listable.
 *         (Enumerating a HOLDER's credentials would be a privacy leak — see
 *         VcRegistry, which has no such index.)
 *
 *         The deploying platform address is the sole writer: keys are custodial,
 *         and a permissionless registry would allow permanent DID squatting.
 */
contract DidRegistry {
    struct DidRecord {
        string did;
        address controller;
        bool active;
        uint64 registeredAt;
        uint64 deactivatedAt;
    }

    address public immutable operator;

    /// keccak256(did) => record
    mapping(bytes32 => DidRecord) private _dids;
    bytes32[] private _index;

    event DidRegistered(bytes32 indexed didHash, string did);
    event DidDeactivated(bytes32 indexed didHash, uint64 at);

    error NotOperator();
    error AlreadyRegistered();
    error NotRegistered();

    modifier onlyOperator() {
        if (msg.sender != operator) revert NotOperator();
        _;
    }

    constructor() {
        operator = msg.sender;
    }

    function registerDid(string calldata did) external onlyOperator {
        bytes32 key = keccak256(bytes(did));
        if (_dids[key].registeredAt != 0) revert AlreadyRegistered();
        _dids[key] = DidRecord({
            did: did,
            controller: msg.sender,
            active: true,
            registeredAt: uint64(block.timestamp),
            deactivatedAt: 0
        });
        _index.push(key);
        emit DidRegistered(key, did);
    }

    /// @notice Deactivate a registered DID. The record survives — it is not deleted.
    function deactivateDid(string calldata did) external onlyOperator {
        bytes32 key = keccak256(bytes(did));
        DidRecord storage rec = _dids[key];
        if (rec.registeredAt == 0 || !rec.active) revert NotRegistered();
        rec.active = false;
        rec.deactivatedAt = uint64(block.timestamp);
        emit DidDeactivated(key, rec.deactivatedAt);
    }

    function isActive(string calldata did) external view returns (bool) {
        return _dids[keccak256(bytes(did))].active;
    }

    function resolve(string calldata did) external view returns (DidRecord memory) {
        return _dids[keccak256(bytes(did))];
    }

    function resolveByHash(bytes32 didHash) external view returns (DidRecord memory) {
        return _dids[didHash];
    }

    function count() external view returns (uint256) {
        return _index.length;
    }

    function didAt(uint256 i) external view returns (bytes32) {
        return _index[i];
    }
}
