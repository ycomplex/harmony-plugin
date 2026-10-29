// B-1203 — the exact name an operator is asked to save a Figma version under before editing. The edit round
// finds that version by this exact name (U+00B7 middle dots). The web repo pins the same two strings.
export function suggestedVersionName(ticket: string, iteration: number): string {
  return `Before · ${ticket} · round ${iteration}`;
}
