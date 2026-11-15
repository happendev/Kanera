import { z } from "zod";

// ISO permits year zero but PostgreSQL's date/timestamp input does not. Calendar validation
// also rejects impossible month/day pairs before scheduling or persistence sees them.
export const calendarDate = z.iso.date().refine(value => !value.startsWith("0000-"));
export const isoTimestamp = z.iso.datetime().refine(value => new Date(value).getUTCFullYear() >= 1);
export const offsetTimestamp = z.iso.datetime({ offset: true }).refine(value => new Date(value).getUTCFullYear() >= 1);
