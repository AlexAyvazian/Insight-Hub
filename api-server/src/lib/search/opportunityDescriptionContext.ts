/**
 * Sample beginning, evidence-bearing sections, and end of long descriptions.
 * This is NOT a substitute for retrieving all solicitation attachments.
 */
import { getRelevanceProfile, type RelevanceProfile } from "./relevanceProfile";

export function opportunityDescriptionContext(
  description: string | null | undefined,
  budget = 12_000,
  profile: RelevanceProfile = getRelevanceProfile(),
): string {
  const source = (description ?? "").trim();
  if (source.length <= budget) return source;
  const head = Math.floor(budget * 0.34);
  const tail = Math.floor(budget * 0.17);
  const middleBudget = Math.max(0, budget - head - tail - 200);
  const remainingStart = head;
  const remainingEnd = source.length - tail;
  const phrases = Array.from(new Set([
    ...profile.generalExplicit,
    ...profile.categories.filter((c) => !c.adjacentOnly)
      .flatMap((c) => [...c.explicit, ...c.component.filter((term) => term.includes(" "))]),
  ]))
    .filter((term) => term.length >= 8)
    .sort((a, b) => b.length - a.length);
  const positions: number[] = [];
  for (const phrase of phrases) {
    const position = source.toLowerCase().indexOf(phrase.toLowerCase(), remainingStart);
    if (position < remainingStart || position >= remainingEnd) continue;
    if (positions.some((existing) => Math.abs(existing - position) < 800)) continue;
    positions.push(position);
  }
  positions.sort((a, b) => a - b);
  const windows: string[] = [];
  const size = Math.max(500, Math.floor(middleBudget / 4));
  for (const position of positions.slice(0, 4)) {
    const start = Math.max(remainingStart, position - Math.floor(size / 3));
    const end = Math.min(remainingEnd, start + size);
    windows.push(source.slice(start, end));
  }
  if (windows.length === 0) {
    const middle = Math.floor((remainingStart + remainingEnd) / 2);
    windows.push(source.slice(Math.max(remainingStart, middle - middleBudget / 2), middle + middleBudget / 2));
  }
  return [
    source.slice(0, head),
    `[Document excerpt: source has ${source.length} characters; omitted material is not proof of irrelevance.]`,
    ...windows,
    source.slice(-tail),
  ].join("\n\n[SECTION BREAK]\n\n");
}
