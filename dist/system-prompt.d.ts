import type { Prompts } from "acp-kernel";
import { type SectionOverride } from "acp-kernel";
export interface PiPromptSections {
    acpTags?: SectionOverride;
    summariesInContext?: SectionOverride;
    tools?: SectionOverride;
    whenToCompress?: SectionOverride;
    whenNotToCompress?: SectionOverride;
    multiTierIntro?: SectionOverride;
    decompressPhilosophy?: SectionOverride;
    contextBreakdown?: SectionOverride;
    throttleRetry?: SectionOverride;
    philosophy?: SectionOverride;
    howToCompress?: SectionOverride;
    tier2?: SectionOverride;
    tier3?: SectionOverride;
}
export declare const SECTION_KEYS: ReadonlySet<string>;
export declare function sanitizePromptSections(raw: unknown): Partial<PiPromptSections>;
export declare function buildAcpSystemPrompt(prompts: Prompts, sections?: Partial<PiPromptSections>): string;
