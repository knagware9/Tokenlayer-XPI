// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title VcRegistry
 * @notice Tamper-evidence and revocation status for Verifiable Credentials.
 *
 *         COMMITMENTS ONLY. This contract deliberately stores no DIDs, no
 *         credential types and no claims — only keccak256 commitments. An
 *         observer with RPC access learns that N credentials exist, when they
 *         were issued and expire, and which are revoked; nothing links a record
 *         to a person, an organization or a credential type. There is also no
 *         holder->credentials index: enumerating a subject's credentials is
 *         exactly the correlation surface this design exists to avoid.
 *
 *         The revocation REASON is intentionally not stored on-chain — it is
 *         free text and may be personal. It stays in the platform database.
 *
 *         The deploying platform address is the sole writer. Keys are custodial,
 *         so the platform already signs on every organization's behalf; a
 *         permissionless registry would let anyone anchor anything and would
 *         prove nothing. This contract therefore attests TAMPER-EVIDENCE AND
 *         STATUS. Issuer provenance is proved by the credential's own Ed25519
 *         signature, not by this registry.
 */
contract VcRegistry {
    struct VcRecord {
        bytes32 vcHash; // keccak256 of the VC-JWT string
        uint64 issuedAt;
        uint64 expiresAt;
        bool revoked;
        uint64 revokedAt;
        bool exists;
    }

    address public immutable operator;

    /// keccak256(credentialId) => record. Keyed by hash; ids are never stored in the clear.
    mapping(bytes32 => VcRecord) private _credentials;

    event VcAnchored(bytes32 indexed idHash, bytes32 vcHash);
    event VcRevoked(bytes32 indexed idHash, uint64 at);

    error NotOperator();
    error AlreadyAnchored();
    error NotAnchored();
    error AlreadyRevoked();

    modifier onlyOperator() {
        if (msg.sender != operator) revert NotOperator();
        _;
    }

    constructor() {
        operator = msg.sender;
    }

    function anchor(bytes32 idHash, bytes32 vcHash, uint64 issuedAt, uint64 expiresAt) external onlyOperator {
        if (_credentials[idHash].exists) revert AlreadyAnchored();
        _credentials[idHash] = VcRecord({
            vcHash: vcHash,
            issuedAt: issuedAt,
            expiresAt: expiresAt,
            revoked: false,
            revokedAt: 0,
            exists: true
        });
        emit VcAnchored(idHash, vcHash);
    }

    function revoke(bytes32 idHash) external onlyOperator {
        VcRecord storage rec = _credentials[idHash];
        if (!rec.exists) revert NotAnchored();
        if (rec.revoked) revert AlreadyRevoked();
        rec.revoked = true;
        rec.revokedAt = uint64(block.timestamp);
        emit VcRevoked(idHash, rec.revokedAt);
    }

    /**
     * @notice Status of a commitment.
     * @dev Callers MUST branch on `exists`. A zeroed record returns
     *      `revoked: false` simply because that is the zero value — it is NOT an
     *      assertion that the credential is valid.
     */
    function statusOf(bytes32 idHash)
        external
        view
        returns (bool exists, bool revoked, uint64 revokedAt, bytes32 vcHash, uint64 issuedAt, uint64 expiresAt)
    {
        VcRecord storage rec = _credentials[idHash];
        return (rec.exists, rec.revoked, rec.revokedAt, rec.vcHash, rec.issuedAt, rec.expiresAt);
    }
}
