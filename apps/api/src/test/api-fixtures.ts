import assert from "node:assert/strict";
import type { FastifyInstance } from "fastify";
import { boards, lists } from "@kanera/shared/schema";
import { and, asc, eq } from "drizzle-orm";
import { db } from "../db.js";

/**
 * Integration-test factories for the "sign up, get a workspace, get a board" preamble.
 *
 * Roughly 200 copies of this preamble were written by hand across the `.itest.ts` suites, which
 * made the actual assertions hard to find and meant a change to the signup or workspace-creation
 * contract had to be applied in ~50 files. These helpers assert the same status codes the inline
 * copies did, so a broken contract still fails loudly — just in one place.
 *
 * Deliberately thin: they return plain data, never hold state between tests, and do not wrap the
 * request under test. Only the setup collapses.
 */

/** The password every integration fixture uses; it only has to satisfy the signup policy. */
export const TEST_PASSWORD = "Abc12345";

/** The signup response shape, previously re-declared in most `.itest.ts` files. */
export interface SignupResponse {
  accessToken: string;
  user: { id: string; clientId: string; hasWorkspace: boolean; email: string; displayName: string };
}

export interface SignedUpOwner extends SignupResponse {
  /** Ready-to-spread request headers: `headers: owner.auth`. */
  auth: { authorization: string };
  email: string;
  orgName: string;
}

/**
 * Create an organisation and return its owner's credentials.
 *
 * Pass explicit `orgName`/`email` when a test asserts on them, or `seed` to derive both — email is
 * globally unique, so two tests sharing one address collide.
 */
export async function signupOwner(
  app: FastifyInstance,
  options: {
    orgName?: string;
    email?: string;
    displayName?: string;
    password?: string;
    seed?: string;
    /** Board-invite signup flow: accepts the invite as part of creating the account. */
    boardInviteToken?: string;
  } = {},
): Promise<SignedUpOwner> {
  const suffix = options.seed ? `-${options.seed}` : "";
  const orgName = options.orgName ?? `Acme${suffix ? ` ${options.seed}` : ""}`;
  const email = options.email ?? `owner${suffix}@example.com`;
  const response = await app.inject({
    method: "POST",
    url: "/auth/signup",
    payload: {
      orgName,
      email,
      password: options.password ?? TEST_PASSWORD,
      displayName: options.displayName ?? "Owner",
      ...(options.boardInviteToken ? { boardInviteToken: options.boardInviteToken } : {}),
    },
  });
  assert.equal(response.statusCode, 200);
  const { accessToken, user } = response.json<SignupResponse>();
  return { accessToken, auth: { authorization: `Bearer ${accessToken}` }, user, email, orgName };
}

export interface SeededWorkspace {
  id: string;
  cardKeyPrefix: string;
  /** The workspace's default board, created alongside it. */
  boardId: string;
  /** The workspace's first default list, in position order. */
  listId: string;
}

/**
 * Create a workspace and resolve the default board and first list the API seeds with it.
 *
 * Lists and boards are read straight from the database rather than a follow-up request: they are
 * created as a side effect of `POST /workspaces`, and the tests that use this only need their ids.
 * The list is ordered by position so `listId` is deterministically the leftmost one.
 */
export async function seedWorkspace(
  app: FastifyInstance,
  owner: Pick<SignedUpOwner, "auth">,
  name = "Delivery",
): Promise<SeededWorkspace> {
  const created = await app.inject({ method: "POST", url: "/workspaces", headers: owner.auth, payload: { name } });
  assert.equal(created.statusCode, 201);
  const workspace = created.json<{ id: string; cardKeyPrefix: string }>();

  const [list] = await db
    .select()
    .from(lists)
    .where(eq(lists.workspaceId, workspace.id))
    .orderBy(asc(lists.position))
    .limit(1);
  assert.ok(list, "workspace should be seeded with at least one list");

  const [board] = await db
    .select()
    .from(boards)
    .where(and(eq(boards.workspaceId, workspace.id)))
    .orderBy(asc(boards.position))
    .limit(1);
  assert.ok(board, "workspace should be seeded with a default board");

  return { id: workspace.id, cardKeyPrefix: workspace.cardKeyPrefix, boardId: board.id, listId: list.id };
}
