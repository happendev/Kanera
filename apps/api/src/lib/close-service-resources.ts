import { pool } from "../db.js";
import { closeRedis } from "../redis.js";

/** Called only after HTTP, realtime and background work have drained. */
export async function closeServiceResources(): Promise<void> {
  try {
    await closeRedis();
  } finally {
    await pool.end();
  }
}
