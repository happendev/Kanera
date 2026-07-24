export const CLIENT_ROLES = ["owner", "admin", "member"] as const;
export type ClientRole = (typeof CLIENT_ROLES)[number];
