import { defineConfig } from "vitest/config";

// These are heavy integration tests: each file boots one or more full Fastify
// apps and seeds ~20 bcrypt-hashed users, and files run in parallel workers.
// The default 5s per-test timeout flakes under that load — give them room.
export default defineConfig({
  test: {
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
