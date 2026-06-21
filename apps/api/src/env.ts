export interface Env {
  port: number;
  jwtSecret: string;
  evmRpcUrl?: string;
  evmOperatorKey?: string;
}

export const env: Env = {
  port: Number(process.env.PORT ?? 4000),
  jwtSecret: process.env.JWT_SECRET ?? "dev-secret-change-me",
  evmRpcUrl: process.env.EVM_RPC_URL,
  evmOperatorKey: process.env.EVM_OPERATOR_KEY,
};
