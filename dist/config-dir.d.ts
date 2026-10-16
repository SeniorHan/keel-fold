import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
/** Pi's config directory name (".pi"); every path here is `<home|cwd>/.pi/…`. */
export { CONFIG_DIR_NAME };
/** `<root>/.pi/<segments>` for a user-authored file (acp.json, prompt packs). */
export declare function userConfigPath(root: string, ...segments: string[]): string;
/** Global then project acp.json; later entries override earlier ones. */
export declare function acpJsonFiles(cwd: string): string[];
