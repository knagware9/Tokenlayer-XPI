import { runAdapterContractTests } from "../src/testing/adapter-suite.js";
import { CantonLedgerAdapter, FabricLedgerAdapter, MockLedgerAdapter } from "../src/simulated-adapter.js";

const accounts: [string, string, string] = ["alice", "bob", "carol"];

// The same behavioural suite runs against every simulated DLT.
runAdapterContractTests("MockLedgerAdapter", { accounts, makeAdapter: () => new MockLedgerAdapter() });
runAdapterContractTests("FabricLedgerAdapter", { accounts, makeAdapter: () => new FabricLedgerAdapter() });
runAdapterContractTests("CantonLedgerAdapter", { accounts, makeAdapter: () => new CantonLedgerAdapter() });
