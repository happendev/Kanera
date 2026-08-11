import { pool } from "../db.js";
import {
  DEMO_SEED_LOGIN_EMAILS,
  DEV_SEED_SHARED_PASSWORD,
  seedDatabase,
} from "./seed-data.js";

try {
  const { summary } = await seedDatabase();
  console.log("dev seed complete");
  console.log("organisation: Happen Software");
  console.log(`users: ${summary.users}`);
  console.log(`workspaces: ${summary.workspaces}`);
  console.log(`boards: ${summary.boards}`);
  console.log(`cards: ${summary.cards}`);
  console.log(`card priorities: ${summary.cardPriorities}`);
  console.log(`comments: ${summary.comments}`);
  console.log(`separators: ${summary.separators}`);
  console.log(`attachments: ${summary.attachments}`);
  console.log(`card covers: ${summary.cardCovers}`);
  console.log(`card moves: ${summary.cardMoves}`);
  console.log(`notes: ${summary.notes}`);
  console.log(`scratchpad notes: ${summary.scratchpadNotes}`);
  console.log(`internal links: ${summary.internalLinks}`);
  console.log(`mentions: ${summary.mentions}`);
  console.log(`notifications: ${summary.notifications}`);
  console.log(`shared password: ${DEV_SEED_SHARED_PASSWORD}`);
  console.log(`login emails: ${DEMO_SEED_LOGIN_EMAILS.slice(0, -1).join(", ")}`);
  console.log(`guest login: ${DEMO_SEED_LOGIN_EMAILS.at(-1)}`);
  console.log("guest access: Mobile Experience (editor)");
} finally {
  await pool.end();
}
