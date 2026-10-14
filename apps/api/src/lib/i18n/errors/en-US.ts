import type { ErrorCatalog } from "./source.js";

// US English differs from the UK source only in spelling (GLOSSARY.md); every other key falls back
// to the source text unchanged.
export const enUS: Partial<ErrorCatalog> = {
  "AI agent access is turned off for this organisation":
    "AI agent access is turned off for this organization",
  "Billing cancellation could not be confirmed, so the organisation was not deleted. Please try again.":
    "Billing cancellation could not be confirmed, so the organization was not deleted. Please try again.",
  "Board syncing requires Pro in both participating organisations.":
    "Board syncing requires Pro in both participating organizations.",
  "GitHub manifest state did not match this organisation":
    "GitHub manifest state did not match this organization",
  "MCP policy applies to hosted organisations only":
    "MCP policy applies to hosted organizations only",
  "MFA is required by this organisation":
    "MFA is required by this organization",
  "MFA is required by your organisation":
    "MFA is required by your organization",
  "No Stripe customer exists for this organisation":
    "No Stripe customer exists for this organization",
  "No Stripe subscription exists for this organisation":
    "No Stripe subscription exists for this organization",
  "Organisation members are added directly to the board, not invited as guests.":
    "Organization members are added directly to the board, not invited as guests.",
  "no active organisation membership":
    "no active organization membership",
  "only pending emails can be cancelled":
    "only pending emails can be canceled",
  "only pending outbox events can be cancelled":
    "only pending outbox events can be canceled",
  "only pending push notifications can be cancelled":
    "only pending push notifications can be canceled",
  "only pending webhook deliveries can be cancelled":
    "only pending webhook deliveries can be canceled",
  "only user sessions can create an organisation":
    "only user sessions can create an organization",
  "only user sessions can delete an organisation":
    "only user sessions can delete an organization",
  "organisation is unavailable for billing":
    "organization is unavailable for billing",
  "organisation membership is not active":
    "organization membership is not active",
  "organisation membership not found":
    "organization membership not found",
  "organisation name does not match":
    "organization name does not match",
  "organisation not found":
    "organization not found",
  "organisation owners and admins already inherit standalone board access":
    "organization owners and admins already inherit standalone board access",
  "organisation owners and admins are always workspace admins":
    "organization owners and admins are always workspace admins",
  "organisation owners and admins cannot be removed from a workspace":
    "organization owners and admins cannot be removed from a workspace",
  "share target must be an active user in your organisation":
    "share target must be an active user in your organization",
  "switch organisation to access this resource":
    "switch organization to access this resource",
  "use the leave organisation action to remove yourself":
    "use the leave organization action to remove yourself",
  "users already associated with this organisation cannot accept board guest invites":
    "users already associated with this organization cannot accept board guest invites",
  "users already in this organisation cannot accept board guest invites":
    "users already in this organization cannot accept board guest invites",
  "workspace not in your organisation":
    "workspace not in your organization",
  "you are already a member of this organisation":
    "you are already a member of this organization",
  "your membership of this organisation is suspended":
    "your membership of this organization is suspended",
  "push messages are disabled for this organisation":
    "push messages are disabled for this organization",
  "This organisation is on the Free plan, which allows your AI agents and API keys {limit} requests per second on its boards, and the request queue is full. Retry shortly; Kanera Pro raises these limits.":
    "This organization is on the Free plan, which allows your AI agents and API keys {limit} requests per second on its boards, and the request queue is full. Retry shortly; Kanera Pro raises these limits.",
  "This organisation is on the Free plan, which allows your AI agents and API keys {limit} requests per minute on its boards. Retry shortly; Kanera Pro raises these limits.":
    "This organization is on the Free plan, which allows your AI agents and API keys {limit} requests per minute on its boards. Retry shortly; Kanera Pro raises these limits.",
  "Your organisation has used its {quota} storage allowance. Upgrade the plan or remove files to upload more.":
    "Your organization has used its {quota} storage allowance. Upgrade the plan or remove files to upload more.",
};
