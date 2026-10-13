// Model-facing footprint (tools + system-prompt additions) of upstream
// billion-context-pi vs this fork, measured inside a real Pi session by
// my-lean-pi-setup's worker. Tokens are ceil(characters / 4), not billing.
// Usage: npm run measure   (expects ../my-lean-pi-setup next to this package;
// set PI_CODING_AGENT_MODULE to measure against a specific Pi build)
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const UPSTREAM = "billion-context-pi@0.1.83";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const worker = path.resolve(root, "../my-lean-pi-setup/scripts/measure-extension-worker.mjs");
const piModule = process.env.PI_CODING_AGENT_MODULE
  ?? path.join(root, "node_modules/@earendil-works/pi-coding-agent/dist/index.js");
for (const required of [worker, piModule]) {
  if (!existsSync(required)) throw new Error(`Missing ${required}`);
}
const npm = process.platform === "win32" ? "npm.cmd" : "npm";

function measure(extensionPath, acpConfig) {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "bcpl-measure-"));
  try {
    const home = path.join(tmp, "home");
    const cwd = path.join(tmp, "cwd");
    const agentDir = path.join(home, ".pi", "agent");
    for (const dir of [cwd, agentDir]) mkdirSync(dir, { recursive: true });
    if (acpConfig) writeFileSync(path.join(home, ".pi", "acp.json"), JSON.stringify(acpConfig));
    const inputPath = path.join(tmp, "input.json");
    const resultPath = path.join(tmp, "result.json");
    writeFileSync(inputPath, JSON.stringify({ extensionPath, cwd, agentDir, resultPath }));
    const env = {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      XDG_CONFIG_HOME: path.join(home, ".config"),
      PI_CODING_AGENT_DIR: agentDir,
      PI_AGENT_DIR: agentDir,
      PI_CODING_AGENT_MODULE: piModule,
      ACP_LOG_FILE: path.join(tmp, "acp.log"),
    };
    const run = spawnSync(process.execPath, [worker, inputPath], { cwd, env, encoding: "utf8" });
    if (run.status !== 0) throw new Error(run.stderr || run.stdout);
    return JSON.parse(readFileSync(resultPath, "utf8"));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

const upstreamDir = mkdtempSync(path.join(os.tmpdir(), "bcpl-upstream-"));
try {
  const opts = { cwd: upstreamDir, encoding: "utf8", shell: process.platform === "win32" };
  const tgz = execFileSync(npm, ["pack", UPSTREAM, "--silent"], opts).trim().split(/\r?\n/).pop();
  execFileSync("tar", ["xzf", tgz], opts);
  const pkg = path.join(upstreamDir, "package");
  execFileSync(npm, ["install", "--omit=dev", "--ignore-scripts", "--silent"], { ...opts, cwd: pkg });

  const rows = [
    [`upstream ${UPSTREAM}`, measure(path.join(pkg, "dist/index.js"))],
    [`upstream ${UPSTREAM} (promptPack: lean)`, measure(path.join(pkg, "dist/index.js"), { compress: { promptPack: "lean" } })],
    ["billion-context-pi-lean", measure(path.join(root, "lean/index.ts"))],
  ];
  for (const [label, result] of rows) {
    const tools = result.tools.map((tool) => `${tool.name} ${tool.tokens}`).join(", ");
    console.log(`${label}: ${result.totalTokens} tokens = tools ${result.totalTokens - result.promptDeltaTokens} (${tools}) + prompt ${result.promptDeltaTokens}`);
  }
  const after = rows.at(-1)[1].totalTokens;
  for (const [label, result] of rows.slice(0, -1)) {
    const before = result.totalTokens;
    console.log(`saved vs ${label}: ${before - after} tokens (${Math.round((1 - after / before) * 100)}%)`);
  }
} finally {
  rmSync(upstreamDir, { recursive: true, force: true });
}
