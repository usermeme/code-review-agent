/**
 * Cheap token estimation used only for chunk budgeting — real tokenizers are
 * model-specific and we only need rough packing, so chars/4 is close enough.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
