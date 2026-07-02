import { z } from "zod";

export const deletionImpactResponse = z.object({
  cardCount: z.number().int().nonnegative(),
});
export type DeletionImpactResponse = z.infer<typeof deletionImpactResponse>;
