/**
 * Offset pagination with completeness accounting, shared by source adapters.
 *
 * A query is complete only when the source's own total has been reached or a short page came back. When the page
 * budget for a run runs out first, the outcome says where to resume (nextOffset) so the next run continues the same
 * partition instead of starting again at offset 0 and never seeing the tail. A failure part-way keeps the pages
 * already fetched and reports the offset that failed.
 */
export interface SourcePage<T> {
  records: T[];
  /** Rows the source returned on this page, before any adapter filtering. */
  rawReturned: number;
  /** The source's reported total for the query, when it gives one. */
  totalRecords: number | null;
}

export interface PaginationOutcome<T> {
  records: T[];
  pagesFetched: number;
  startOffset: number;
  nextOffset: number;
  totalRecords: number | null;
  rawReturned: number;
  complete: boolean;
  error?: unknown;
}

export async function paginateOffsets<T>(options: {
  pageSize: number;
  maxPages: number;
  startOffset?: number;
  fetchPage: (offset: number) => Promise<SourcePage<T>>;
}): Promise<PaginationOutcome<T>> {
  const pageSize = Math.max(1, Math.floor(options.pageSize));
  const maxPages = Math.max(1, Math.floor(options.maxPages));
  const startOffset = Math.max(0, Math.floor(options.startOffset ?? 0));
  const records: T[] = [];
  let offset = startOffset;
  let totalRecords: number | null = null;
  let rawReturned = 0;
  let pagesFetched = 0;
  while (pagesFetched < maxPages) {
    let page: SourcePage<T>;
    try {
      page = await options.fetchPage(offset);
    } catch (error) {
      return { records, pagesFetched, startOffset, nextOffset: offset, totalRecords, rawReturned, complete: false, error };
    }
    pagesFetched += 1;
    records.push(...page.records);
    rawReturned += page.rawReturned;
    if (page.totalRecords != null && Number.isFinite(page.totalRecords)) totalRecords = page.totalRecords;
    offset += page.rawReturned;
    const reachedTotal = totalRecords != null && offset >= totalRecords;
    if (page.rawReturned < pageSize || reachedTotal) {
      return { records, pagesFetched, startOffset, nextOffset: offset, totalRecords, rawReturned, complete: true };
    }
  }
  return { records, pagesFetched, startOffset, nextOffset: offset, totalRecords, rawReturned, complete: false };
}
