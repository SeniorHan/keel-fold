// Preloaded by `npm test` (see package.json): keep the suite away from the
// developer's real ~/.pi. Without it, every test that logs writes into the real
// ~/.pi/acp.log, and tests that read user config see the real ~/.pi/acp.json.
// os.homedir() reads USERPROFILE on Windows and HOME elsewhere, so set both.
// Child test processes inherit the environment; tests that need a specific
// home or log file still set their own and restore this one afterwards.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "acp-test-home-"));
process.env.HOME = home;
process.env.USERPROFILE = home;
process.env.ACP_LOG_FILE = join(home, "acp.log");
process.on("exit", () => rmSync(home, { recursive: true, force: true }));
