/**
 * Testing-type grouping for the Opportunities list.
 *
 * The server assigns each opportunity a primary testing type (`relevance.category`) and the full list it evidences
 * (`relevance.testingTypes`). The UI never infers a type itself; it only groups, orders and filters by what the
 * server sent.
 */

export const UNCATEGORIZED_GROUP = "Uncategorized";

export interface OpportunityGroup<T> {
  type: string;
  items: T[];
}

interface GroupableOpportunity {
  relevance?: { category?: unknown; testingTypes?: unknown } | null;
}

export function primaryTestingType(opp: GroupableOpportunity): string {
  const category = opp.relevance?.category;
  return typeof category === "string" && category.trim()
    ? category.trim()
    : UNCATEGORIZED_GROUP;
}

/** Other testing types the notice also covers (everything except the primary), as strings only. */
export function additionalTestingTypes(opp: GroupableOpportunity): string[] {
  const primary = primaryTestingType(opp);
  const all = opp.relevance?.testingTypes;
  if (!Array.isArray(all)) return [];
  return all.filter(
    (type): type is string =>
      typeof type === "string" && type.trim() !== "" && type !== primary,
  );
}

/**
 * Groups opportunities by primary testing type. Larger groups come first so the busiest testing types lead the page;
 * ties keep first-seen (rank) order, and "Uncategorized" is always last. Order inside a group is the server's rank.
 */
export function groupByTestingType<T extends GroupableOpportunity>(
  opportunities: readonly T[],
  activeType: string | null = null,
): Array<OpportunityGroup<T>> {
  const groups = new Map<string, T[]>();
  for (const opp of opportunities) {
    const type = primaryTestingType(opp);
    const items = groups.get(type);
    if (items) items.push(opp);
    else groups.set(type, [opp]);
  }
  const ordered = Array.from(groups.entries())
    .map(([type, items], firstSeen) => ({ type, items, firstSeen }))
    .sort((a, b) => {
      if (a.type === UNCATEGORIZED_GROUP) return b.type === UNCATEGORIZED_GROUP ? 0 : 1;
      if (b.type === UNCATEGORIZED_GROUP) return -1;
      return b.items.length - a.items.length || a.firstSeen - b.firstSeen;
    })
    .map(({ type, items }) => ({ type, items }));
  return activeType ? ordered.filter((group) => group.type === activeType) : ordered;
}
