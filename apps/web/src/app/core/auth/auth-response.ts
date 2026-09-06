interface AuthResponse {
  accessToken: string;
  user: {
    id: string;
    clientId: string;
    email: string;
    displayName: string;
    avatarUrl: string | null;
    orgName: string;
    logoUrl: string | null;
    deploymentMode: "self_hosted" | "hosted";
    kaneraEnvironment: "development" | "test" | "staging" | "production";
    hasWorkspace: boolean;
    isClientAdmin?: boolean;
    boardInviteRedirect?: string | null;
    role: "owner" | "admin" | "member";
    timezone: string;
    storageUsage: {
      usedBytes: number;
      quotaBytes: number | null;
      remainingBytes: number | null;
      limited: boolean;
      maxFileBytes: number;
    };
    analyticsExcluded?: boolean;
  };
}

export function parseAuthResponse(value: unknown): AuthResponse {
  if (!value || typeof value !== "object") throw new Error("Invalid auth response");
  const response = value as Partial<AuthResponse>;
  if (typeof response.accessToken !== "string" || !isAuthUser(response.user)) {
    throw new Error("Invalid auth response");
  }
  return { accessToken: response.accessToken, user: response.user };
}

function isAuthUser(value: unknown): value is AuthResponse["user"] {
  if (!value || typeof value !== "object") return false;
  const user = value as Partial<AuthResponse["user"]>;
  return (
    typeof user.id === "string" &&
    typeof user.clientId === "string" &&
    typeof user.email === "string" &&
    typeof user.displayName === "string" &&
    (typeof user.avatarUrl === "string" || user.avatarUrl === null) &&
    typeof user.orgName === "string" &&
    (typeof user.logoUrl === "string" || user.logoUrl === null) &&
    (user.deploymentMode === "self_hosted" || user.deploymentMode === "hosted") &&
    (user.kaneraEnvironment === "development" || user.kaneraEnvironment === "test" || user.kaneraEnvironment === "staging" || user.kaneraEnvironment === "production") &&
    typeof user.hasWorkspace === "boolean" &&
    typeof user.timezone === "string" &&
    isStorageUsage(user.storageUsage) &&
    (user.role === "owner" || user.role === "admin" || user.role === "member")
    // boardInviteRedirect and isClientAdmin are optional — no strict check needed
  );
}

function isStorageUsage(value: unknown): value is AuthResponse["user"]["storageUsage"] {
  if (!value || typeof value !== "object") return false;
  const usage = value as Partial<AuthResponse["user"]["storageUsage"]>;
  return (
    typeof usage.usedBytes === "number" &&
    (typeof usage.quotaBytes === "number" || usage.quotaBytes === null) &&
    (typeof usage.remainingBytes === "number" || usage.remainingBytes === null) &&
    typeof usage.limited === "boolean" &&
    typeof usage.maxFileBytes === "number"
  );
}
