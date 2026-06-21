// SPDX-License-Identifier: GPL-3.0
pragma solidity 0.8.17;

/**
 * @title TREXImports
 * @notice This file imports the official Tokeny T-REX (ERC-3643) and ONCHAINID
 *         contracts so Hardhat compiles them and emits artifacts/typechain
 *         bindings. Nothing here is deployed directly; the TS TrexDeployer wires
 *         these contracts into a full suite at runtime. Kept on solc 0.8.17 (the
 *         version both vendor packages pin) — our own contracts stay on 0.8.24.
 */

// T-REX implementations
import "@tokenysolutions/t-rex/contracts/token/Token.sol";
import "@tokenysolutions/t-rex/contracts/registry/implementation/ClaimTopicsRegistry.sol";
import "@tokenysolutions/t-rex/contracts/registry/implementation/TrustedIssuersRegistry.sol";
import "@tokenysolutions/t-rex/contracts/registry/implementation/IdentityRegistryStorage.sol";
import "@tokenysolutions/t-rex/contracts/registry/implementation/IdentityRegistry.sol";
import "@tokenysolutions/t-rex/contracts/compliance/modular/ModularCompliance.sol";

// A real compliance module to demonstrate modular compliance.
import "@tokenysolutions/t-rex/contracts/compliance/modular/modules/CountryAllowModule.sol";

// T-REX proxy + implementation authority
import "@tokenysolutions/t-rex/contracts/proxy/authority/TREXImplementationAuthority.sol";
import "@tokenysolutions/t-rex/contracts/proxy/TokenProxy.sol";
import "@tokenysolutions/t-rex/contracts/proxy/ClaimTopicsRegistryProxy.sol";
import "@tokenysolutions/t-rex/contracts/proxy/TrustedIssuersRegistryProxy.sol";
import "@tokenysolutions/t-rex/contracts/proxy/IdentityRegistryStorageProxy.sol";
import "@tokenysolutions/t-rex/contracts/proxy/IdentityRegistryProxy.sol";
import "@tokenysolutions/t-rex/contracts/proxy/ModularComplianceProxy.sol";

// ONCHAINID — investor identities + trusted claim issuer + identity factory
import "@onchain-id/solidity/contracts/Identity.sol";
import "@onchain-id/solidity/contracts/ClaimIssuer.sol";
import "@onchain-id/solidity/contracts/factory/IdFactory.sol";
import "@onchain-id/solidity/contracts/proxy/ImplementationAuthority.sol";
