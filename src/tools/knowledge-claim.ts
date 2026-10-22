/** Portable claim envelope: one atomic content write works before and after the nullable projection. */
export type ClaimSource = 'authored' | 'derived';
export interface ClaimFields { claim: string | null; claim_source: ClaimSource | null }
const ENVELOPE = /^\*\*Claim:\*\* ([^\n]+)\n\n\*\*Claim source:\*\* (authored|derived)\n\n/;
export function isSingleSentenceShaped(value: string): boolean {
  const text = value.trim();
  if (!text || text.split(/\s+/).length > 50) return false;
  const neutral = text.replace(/(\d)\.(?=\d)/g, '$1').replace(/\be\.g\.|\bi\.e\./gi, m => m.replace(/\./g, ''));
  return !/[.!?]/.test(neutral.replace(/[.!?]+\s*$/, ''));
}
export function validateClaimEntry(title: string, claim: string): void {
  for (const [field, value] of [['title', title], ['claim', claim]]) {
    if (!isSingleSentenceShaped(value)) throw new Error(`${field} must be one sentence of at most 50 words`);
  }
}
export function decodeClaim(content = ''): ClaimFields {
  const match = ENVELOPE.exec(content);
  return { claim: match?.[1] ?? null, claim_source: (match?.[2] as ClaimSource) ?? null };
}
export function claimFields(row: { content?: string | null; claim?: string | null; claim_source?: string | null }): ClaimFields {
  const decoded = decodeClaim(row.content ?? '');
  return row.claim && (row.claim_source === 'authored' || row.claim_source === 'derived')
    ? { claim: row.claim, claim_source: row.claim_source } : decoded;
}
export function stripClaim(content = ''): string { return content.replace(ENVELOPE, ''); }
export function encodeClaim(content: string, claim: string, source: ClaimSource = 'authored'): string {
  return `**Claim:** ${claim.trim().replace(/\s+/g, ' ')}\n\n**Claim source:** ${source}\n\n${stripClaim(content)}`;
}
/** An edit reuses an authored claim; confirming a proposal requires an explicit value. */
export function editedClaimContent(current: { title: string; content: string; claim?: string | null; claim_source?: string | null }, updates: { title?: string; content?: string; claim?: string }): string {
  const prior = claimFields(current);
  const claim = updates.claim ?? (prior.claim_source === 'authored' ? prior.claim : null);
  validateClaimEntry(updates.title ?? current.title, claim ?? '');
  return encodeClaim(updates.content ?? current.content, claim!);
}
export function plainText(content: string): string {
  return stripClaim(content).replace(/<[^>]*>/g, ' ').replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/[`*_#>|~]/g, '').replace(/\s+/g, ' ').trim();
}
export function matchedPassage(content: string, query: string): string | null {
  const text = [decodeClaim(content).claim, plainText(content)].filter(Boolean).join(' ');
  const terms = query.toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  const indexes = terms.map(term => text.toLocaleLowerCase().indexOf(term)).filter(i => i >= 0);
  if (!indexes.length) return null;
  const at = Math.min(...indexes), start = Math.max(0, at - 60), end = Math.min(text.length, start + 240);
  return `${start ? '…' : ''}${text.slice(start, end)}${end < text.length ? '…' : ''}`;
}
export function proposeClaim(content: string): string | null {
  if (decodeClaim(content).claim) return null;
  const lines = content.split('\n').filter(line => !/^\s*(?:_?Derived from|#{1,6}\s|\*\*(?:Question put to the human|Track|Reach|On accept|Context|Ratified asks):)/i.test(line));
  const text = plainText(lines.join('\n')).replace(/^Decision:\s*/i, '');
  // Sentence boundary ignores version dots and the two supported abbreviations.
  const candidates = text.match(/.*?[.!?](?=\s|$)|.+$/g) ?? [];
  let candidate = '';
  for (const part of candidates) {
    candidate += part;
    if (/\b(?:e\.g\.|i\.e\.)$/i.test(candidate.trim())) continue;
    const value = candidate.trim();
    if (isSingleSentenceShaped(value)) return value;
    return null;
  }
  return null;
}
