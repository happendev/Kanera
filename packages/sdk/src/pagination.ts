import type { CursorPage } from "./types.js";

/**
 * Async iteration over paginated endpoints.
 *
 * Every list endpoint in Kanera is bounded — there is no "give me the whole board" call — so the
 * common integration bug is reading page one and silently treating it as the whole set. These
 * helpers make the loop the default shape rather than something each caller reimplements.
 */

export interface PageIterator<T> extends AsyncIterable<T> {
  /** Collect every page into one array. Only for sets you know are small. */
  all(limit?: number): Promise<T[]>;
}

function iterator<T>(pages: () => AsyncGenerator<T[], void, undefined>): PageIterator<T> {
  return {
    async *[Symbol.asyncIterator]() {
      for await (const page of pages()) yield* page;
    },
    async all(limit = Infinity) {
      const collected: T[] = [];
      for await (const page of pages()) {
        for (const item of page) {
          collected.push(item);
          if (collected.length >= limit) return collected;
        }
      }
      return collected;
    },
  };
}

/** For endpoints returning `{ items, nextCursor }`; the cursor is opaque and passed back unchanged. */
export function paginateCursor<T>(
  fetchPage: (cursor: string | undefined) => Promise<CursorPage<T>>,
): PageIterator<T> {
  return iterator<T>(async function* () {
    let cursor: string | undefined;
    do {
      const page: CursorPage<T> = await fetchPage(cursor);
      yield page.items;
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
  });
}

/** For endpoints returning a plain array with `limit`/`offset`. */
export function paginateOffset<T>(
  fetchPage: (limit: number, offset: number) => Promise<T[]>,
  pageSize = 50,
): PageIterator<T> {
  return iterator<T>(async function* () {
    let offset = 0;
    for (;;) {
      const rows = await fetchPage(pageSize, offset);
      if (rows.length === 0) return;
      yield rows;
      // A short page is the last page: the API has no total count to compare against.
      if (rows.length < pageSize) return;
      offset += rows.length;
    }
  });
}
