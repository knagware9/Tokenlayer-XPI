import { HardhatUserConfig } from "hardhat/config";
import "@nomicfoundation/hardhat-toolbox";

const optimizer = { enabled: true, runs: 200 };

const config: HardhatUserConfig = {
  solidity: {
    compilers: [
      // Our own compliance contracts.
      { version: "0.8.24", settings: { optimizer } },
      // Official T-REX (ERC-3643) + ONCHAINID vendor contracts pin solc 0.8.17.
      { version: "0.8.17", settings: { optimizer } },
    ],
  },
  networks: {
    localhost: { url: "http://127.0.0.1:8545" },
    hardhat: {
      // The full T-REX Token exceeds the mainnet bytecode limit; allow it in tests.
      allowUnlimitedContractSize: true,
    },
  },
};

export default config;
