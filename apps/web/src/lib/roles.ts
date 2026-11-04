import { UserProfile, UserMembership } from "./auth";

export type FamilyRole = "family_admin" | "family_member" | "read_only_adviser";

/**
 * UI hints only. Every one of these actions is enforced again by the API, which decides from the
 * authenticated token, never from anything the browser sends. Hiding a control is not security.
 */
export function membershipFor(user: UserProfile | null | undefined, entityId: string): UserMembership | undefined {
  return user?.memberships?.find((m) => m.family_entity_id === entityId);
}

/** Unknown or missing roles get the most restrictive treatment. */
export function roleFor(user: UserProfile | null | undefined, entityId: string): FamilyRole {
  const role = membershipFor(user, entityId)?.role;
  return role === "family_admin" || role === "family_member" ? role : "read_only_adviser";
}

export const ROLE_LABEL: Record<FamilyRole, string> = {
  family_admin: "Family admin",
  family_member: "Family member",
  read_only_adviser: "Read-only adviser",
};

export const can = {
  upload: (r: FamilyRole) => r !== "read_only_adviser",
  delete: (r: FamilyRole) => r === "family_admin",
  invite: (r: FamilyRole) => r === "family_admin",
  viewEntityAudit: (r: FamilyRole) => r === "family_admin",
};

export function entityName(user: UserProfile | null | undefined, entityId: string): string {
  return membershipFor(user, entityId)?.entity_name || "Family entity";
}
