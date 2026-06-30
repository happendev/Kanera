import { users } from "@kanera/shared/schema";
import { and, eq, inArray, ne } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { db } from "../db.js";
import { env } from "../env.js";
import type { InviteAcceptedEmailParams } from "./email-templates/index.js";

export async function notifyAdminsOrgInviteAccepted(
  app: FastifyInstance,
  params: {
    acceptedUserId: string;
    acceptedByName: string;
    acceptedByEmail: string;
    clientId: string;
    orgName: string;
    orgRole: string;
  },
) {
  await notifyClientAdmins(app, {
    clientId: params.clientId,
    acceptedUserId: params.acceptedUserId,
    buildData: (recipient) => ({
      context: "org",
      displayName: recipient.displayName,
      acceptedByName: params.acceptedByName,
      acceptedByEmail: params.acceptedByEmail,
      orgName: params.orgName,
      orgRole: params.orgRole,
      membersUrl: `${env.WEB_ORIGIN}/settings/users`,
    }),
  });
}

export async function notifyAdminsBoardInviteAccepted(
  app: FastifyInstance,
  params: {
    acceptedUserId: string;
    acceptedByName: string;
    acceptedByEmail: string;
    hostClientId: string;
    orgName: string;
    boardId: string;
    boardName: string;
    boardRole: string;
  },
) {
  await notifyClientAdmins(app, {
    clientId: params.hostClientId,
    acceptedUserId: params.acceptedUserId,
    buildData: (recipient) => ({
      context: "board",
      displayName: recipient.displayName,
      acceptedByName: params.acceptedByName,
      acceptedByEmail: params.acceptedByEmail,
      orgName: params.orgName,
      boardName: params.boardName,
      boardRole: params.boardRole,
      boardUrl: `${env.WEB_ORIGIN}/b/${params.boardId}`,
    }),
  });
}

async function notifyClientAdmins(
  app: FastifyInstance,
  params: {
    clientId: string;
    acceptedUserId: string;
    buildData: (recipient: { displayName: string }) => InviteAcceptedEmailParams;
  },
) {
  const recipients = await db
    .select({ id: users.id, email: users.email, displayName: users.displayName })
    .from(users)
    .where(
      and(
        eq(users.clientId, params.clientId),
        inArray(users.clientRole, ["owner", "admin"]),
        ne(users.id, params.acceptedUserId),
      ),
    );

  await Promise.all(
    recipients.map((recipient) => app.mailer.sendInviteAccepted(recipient.email, params.buildData(recipient))),
  );
}
