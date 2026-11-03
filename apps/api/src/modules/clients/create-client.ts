import type { dto } from "@kanera/shared";
import { clientMembers, clients } from "@kanera/shared/schema";
import type { AuthClaims } from "../../auth/plugin.js";
import { db } from "../../db.js";
import { env } from "../../env.js";
import { getConfiguredS3StorageConfig } from "../../lib/storage/index.js";

/** Creates an organisation owned by the acting user and returns its id. */
export async function createClient({ auth, body }: { auth: AuthClaims; body: dto.CreateClientBody }): Promise<string> {
  return db.transaction(async (tx) => {
    const [client] = await tx.insert(clients).values({
      name: body.name,
      createdByUserId: auth.sub,
      storageConfig: getConfiguredS3StorageConfig() ?? { kind: "local" },
      // Each hosted organisation starts and is billed independently; no subscription state is
      // inherited from whichever organisation was active when this one was created.
      ...(env.KANERA_DEPLOYMENT_MODE === "hosted"
        ? {
          pushEnabled: true,
          plan: "paid" as const,
          billingStatus: "trialing" as const,
          currentPeriodEnd: new Date(Date.now() + env.HOSTED_TRIAL_DAYS * 86_400_000),
        }
        : {}),
    }).returning({ id: clients.id });
    await tx.insert(clientMembers).values({
      clientId: client!.id,
      userId: auth.sub,
      clientRole: "owner",
      createdById: auth.sub,
    });
    return client!.id;
  });
}
