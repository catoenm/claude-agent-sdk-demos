import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
export const root = new URL("../", import.meta.url);
export const git = (...args) =>
  execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
export const readState = () =>
  JSON.parse(
    readFileSync(new URL("../.runtime/state.json", import.meta.url), "utf8"),
  );
export function compose(args, state) {
  execFileSync(
    "docker",
    ["compose", "-p", "tracepath-chat-demo", "-f", "compose.yaml", ...args],
    {
      cwd: root,
      stdio: "inherit",
      timeout: 240000,
      env: {
        ...process.env,
        TRACEPATH_REVISION: state.revision,
        TRACEPATH_DEMO_TOKEN: state.token,
        AGENT_MODE: state.mode,
      },
    },
  );
}
