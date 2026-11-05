/** Native assistant phases distinguish transient commentary from the answer. */
type Phase = 'commentary' | 'final_answer';
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const phase = (value: unknown): Phase | undefined =>
  value === 'commentary' || value === 'final_answer' ? value : undefined;
const textBlock = (value: unknown): value is Record<string, unknown> =>
  record(value) && ['text', 'input_text', 'output_text'].includes(String(value.type));

function signaturePhase(value: unknown): Phase | undefined {
  if (typeof value !== 'string' || !value.startsWith('{')) { return; }
  try {
    const parsed: unknown = JSON.parse(value);
    return record(parsed) && parsed.v === 1 ? phase(parsed.phase) : undefined;
  } catch { return; }
}

function messagePhase(value: unknown): Phase | undefined {
  if (!record(value)) { return; }
  const direct = phase(value.phase);
  if (direct) { return direct; }
  if (!Array.isArray(value.content)) { return; }
  const phases = new Set(value.content.filter(textBlock).map(b => signaturePhase(b.textSignature)).filter(Boolean));
  return phases.size === 1 ? [...phases][0] : undefined;
}

/** Matches native precedence without recursively interpreting arbitrary metadata. */
export function openClawAssistantPhase(value: unknown): Phase | undefined {
  if (!record(value)) { return; }
  return phase(value.phase) ?? messagePhase(value.message) ?? messagePhase(value.partial)
    ?? messagePhase(value.item) ?? messagePhase(value);
}

/** Final envelopes can contain strings or signed text blocks; never mix commentary into a reply. */
export function openClawVisibleText(value: unknown): string | undefined {
  if (!record(value)) { return; }
  const direct = phase(value.phase);
  if (direct === 'commentary') { return; }
  if (typeof value.text === 'string') { return value.text; }
  if (typeof value.content === 'string') { return value.content; }
  if (!Array.isArray(value.content)) { return; }
  const blocks = value.content.filter(textBlock);
  const explicitlyPhased = blocks.some(b => signaturePhase(b.textSignature));
  return blocks.filter(b => {
    const resolved = signaturePhase(b.textSignature) ?? (explicitlyPhased ? undefined : direct);
    return explicitlyPhased ? resolved === 'final_answer' : resolved !== 'commentary';
  }).map(b => typeof b.text === 'string' ? b.text : '').join('\n');
}
