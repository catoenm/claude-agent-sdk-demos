import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { git, compose } from "./support.mjs";
if (existsSync(".env")) process.loadEnvFile(".env");
if (git("status", "--porcelain"))
  throw new Error(
    "Commit changes before starting to bind spans to a clean revision",
  );
const mode = process.env.AGENT_MODE ?? "mock";
if (!["mock", "claude"].includes(mode))
  throw new Error("Choose AGENT_MODE=mock or claude");
if (mode === "claude" && !process.env.ANTHROPIC_API_KEY)
  throw new Error("Configure ANTHROPIC_API_KEY in ignored .env first");
const state = { revision: git("rev-parse", "HEAD"), token: randomUUID(), mode };
mkdirSync(".runtime", { recursive: true, mode: 0o700 });
writeFileSync(".runtime/state.json", JSON.stringify(state), { mode: 0o600 });
compose(["up", "-d", "--build", "--wait", "--wait-timeout", "90"], state);
const health = await (await fetch("http://127.0.0.1:4420/health")).json();
if (health.revision !== state.revision || health.mode !== mode)
  throw new Error("Running image does not match this checkout");
console.log(
  `Chat app: http://127.0.0.1:4420 · ${mode} mode · ${state.revision}`,
);
