/** Regenerate tests/fixtures/pi-system-prompt-default.txt (golden file for
 *  surface-config.test.ts). Run: npx tsx scripts/regen-prompt-fixture.ts */
import { writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { defaultPrompts } from "acp-kernel";
import { buildAcpSystemPrompt } from "../src/system-prompt.js";

const fixture = join(dirname(fileURLToPath(import.meta.url)), "..", "tests", "fixtures", "pi-system-prompt-default.txt");
writeFileSync(fixture, buildAcpSystemPrompt(defaultPrompts));
console.log("regenerated", fixture);
