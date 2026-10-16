import { test } from "node:test";
import assert from "node:assert/strict";
import { homedir } from "node:os";
import * as path from "node:path";
import { CONFIG_DIR_NAME, acpJsonFiles } from "../src/config-dir.js";

test("config dir is Pi's .pi", () => {
  assert.equal(CONFIG_DIR_NAME, ".pi");
});

test("acpJsonFiles: global then project", () => {
  const cwd = path.resolve("/work/project");
  assert.deepEqual(acpJsonFiles(cwd), [path.join(homedir(), ".pi", "acp.json"), path.join(cwd, ".pi", "acp.json")]);
});
