import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import { homedir } from "node:os";
import * as path from "node:path";

/** Pi's config directory name (".pi"); every path here is `<home|cwd>/.pi/…`. */
export { CONFIG_DIR_NAME };

/** `<root>/.pi/<segments>` for a user-authored file (acp.json, prompt packs). */
export function userConfigPath(root: string, ...segments: string[]): string {
  return path.join(root, CONFIG_DIR_NAME, ...segments);
}

/** Global then project acp.json; later entries override earlier ones. */
export function acpJsonFiles(cwd: string): string[] {
  return [userConfigPath(homedir(), "acp.json"), userConfigPath(cwd, "acp.json")];
}
