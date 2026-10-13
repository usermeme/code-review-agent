/** Shared description of the four LLM-written sections, used by both synthesize prompts. */
export const SECTIONS_SPEC = `Return JSON with exactly these string fields (markdown inside each):
- "architecture": the overall architecture, services/layers and how they communicate.
- "modules": one short paragraph per module/directory, saying what lives there.
- "patterns": every internal pattern and convention a code reviewer should enforce, citing the files that establish it.
- "errorHandling": error-handling, logging and testing conventions, citing where they are established.`;
