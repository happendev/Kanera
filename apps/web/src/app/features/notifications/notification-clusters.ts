import type { NotificationRow } from "@kanera/shared/dto";
import { localDateKey } from "../../shared/day-key.util";

/** Precomputed action line for one notification, as the drawer renders it. */
export interface ActivityChangeSummary {
  icon: string;
  text: string;
  value?: string;
}

export interface NotificationClusterEntry {
  notification: NotificationRow;
  /**
   * Summarised once, here, rather than in the template: the entry line renders the icon, text and
   * value separately, so a template-side `changeSummary(n)` would re-run the ~130-line switch three
   * times per entry on every change-detection pass. Same rationale as `CardFeedView` in the card
   * activity feed.
   */
  summary: ActivityChangeSummary;
}

export interface NotificationCluster {
  key: string;
  /** Newest entry. Supplies the card, board, list and organisation context the header states once. */
  head: NotificationRow;
  /** Newest first, always length >= 2 — a lone notification must not gain block chrome. */
  entries: NotificationClusterEntry[];
  /**
   * Every notification id in the block. All unread by construction (only unread rows cluster), so
   * opening the card or hitting the block's dot marks exactly these in one request.
   */
  unreadIds: string[];
}

/**
 * One rendered position in the drawer's feed: either a plain notification row, or a card+day block.
 *
 * The unused side of each member is declared `?: undefined` so the template can read
 * `entry.cluster` / `entry.notification` and narrow with `@if (…; as x)`, rather than relying on
 * discriminant narrowing inside Angular control-flow blocks.
 */
export type NotificationFeedEntry =
  | { kind: "row"; key: string; notification: NotificationRow; cluster?: undefined }
  | { kind: "cluster"; key: string; cluster: NotificationCluster; notification?: undefined };

/** Rows sharing one card on one local day, in the stream position of their newest member. */
interface Bucket {
  /** `<cardId>|<YYYY-MM-DD>`, or null for a row that can never join a block. */
  key: string | null;
  rows: NotificationRow[];
}

/**
 * Projects a newest-first notification stream onto rendered feed entries, collapsing a run of unread
 * updates on the same card and the same local day into one block.
 *
 * Input must already be sorted newest first (the panel sorts before grouping): the first row seen for
 * a card+day is the block's head, and the block takes that row's position in the stream so relative
 * ordering by recency survives while later members are pulled up out of the flat list.
 */
export function buildFeedEntries(
  rows: readonly NotificationRow[],
  summarise: (row: NotificationRow) => ActivityChangeSummary,
): NotificationFeedEntry[] {
  const slots: Bucket[] = [];
  const byKey = new Map<string, Bucket>();

  for (const row of rows) {
    // Read rows keep rendering individually — the All tab is a history, not a burst — and a row
    // without a card has no card context to state once.
    if (row.readAt || !row.cardId) {
      slots.push({ key: null, rows: [row] });
      continue;
    }
    // Local day, never UTC: an evening notification must stay on the day the reader lived through,
    // and this is the same boundary the drawer's day headers use.
    const key = `${row.cardId}|${localDateKey(new Date(row.createdAt as unknown as string))}`;
    const existing = byKey.get(key);
    if (existing) {
      existing.rows.push(row);
      continue;
    }
    const bucket: Bucket = { key, rows: [row] };
    byKey.set(key, bucket);
    slots.push(bucket);
  }

  return slots.map((bucket) =>
    // A bucket that ended up with a single member degrades back to a plain row.
    bucket.key && bucket.rows.length > 1
      ? clusterEntry(bucket.key, bucket.rows, summarise)
      : rowEntry(bucket.rows[0]!),
  );
}

function rowEntry(notification: NotificationRow): NotificationFeedEntry {
  return { kind: "row", key: `row:${notification.id}`, notification };
}

function clusterEntry(
  bucketKey: string,
  rows: NotificationRow[],
  summarise: (row: NotificationRow) => ActivityChangeSummary,
): NotificationFeedEntry {
  return {
    kind: "cluster",
    key: `cluster:${bucketKey}`,
    cluster: {
      key: `cluster:${bucketKey}`,
      head: rows[0]!,
      entries: rows.map((notification) => ({ notification, summary: summarise(notification) })),
      unreadIds: rows.map((row) => row.id),
    },
  };
}
