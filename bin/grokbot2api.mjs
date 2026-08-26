#!/usr/bin/env node

import { startServer } from "../src/server.mjs";

try {
  const server = await startServer();
  const address = server.address();
  const host = typeof address === "object" && address ? address.address : process.env.HOST || "127.0.0.1";
  const port = typeof address === "object" && address ? address.port : process.env.PORT || "8793";
  console.log(`grokbot2api listening on ${host}:${port}`);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(JSON.stringify({ event: "grokbot2api_start_failed", message }));
  process.exitCode = 1;
}
