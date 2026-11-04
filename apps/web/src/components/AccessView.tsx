"use client";

import React, { useState } from "react";
import { Check, Copy, Minus } from "lucide-react";
import { UserProfile } from "../lib/auth";
import { createInvite } from "../lib/api";
import { friendlyError } from "../lib/apiErrors";
import { FamilyRole, ROLE_LABEL, can, entityName, roleFor } from "../lib/roles";
import { formatDateTime } from "../lib/format";
import { UserInvite } from "../types";
import { ErrorState } from "./StateViews";

interface AccessViewProps {
  currentUser: UserProfile | null;
  selectedEntity: string;
  theme?: "dark" | "light";
}

/** What each role may do. This mirrors, and never replaces, the API's own checks. */
const PERMISSIONS: { label: string; roles: FamilyRole[] }[] = [
  { label: "View documents shared with the family", roles: ["family_admin", "family_member", "read_only_adviser"] },
  { label: "Ask questions and see cited evidence", roles: ["family_admin", "family_member", "read_only_adviser"] },
  { label: "Upload documents", roles: ["family_admin", "family_member"] },
  { label: "View admin-only documents", roles: ["family_admin"] },
  { label: "Delete documents", roles: ["family_admin"] },
  { label: "View the entity audit trail", roles: ["family_admin"] },
  { label: "Invite members and advisers", roles: ["family_admin"] },
];
const ROLES: FamilyRole[] = ["family_admin", "family_member", "read_only_adviser"];

export function AccessView({ currentUser, selectedEntity, theme = "light" }: AccessViewProps) {
  const [roleToInvite, setRoleToInvite] = useState<"family_member" | "read_only_adviser">("family_member");
  const [expiresInHours, setExpiresInHours] = useState(72);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [createdInvite, setCreatedInvite] = useState<UserInvite | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isLight = theme === "light";
  const muted = isLight ? "text-slate-500" : "text-slate-400";
  const role = roleFor(currentUser, selectedEntity);
  const entity = entityName(currentUser, selectedEntity);

  const handleCreateInvite = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!can.invite(role) || isSubmitting) return;
    setIsSubmitting(true);
    setError(null);
    setCreatedInvite(null);
    setCopied(false);
    try {
      setCreatedInvite(await createInvite({ family_entity_id: selectedEntity, role: roleToInvite, expires_in_hours: expiresInHours }));
    } catch (err) {
      setError(friendlyError(err, "create the invitation").body);
    } finally {
      setIsSubmitting(false);
    }
  };

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    } catch {
      /* clipboard blocked: the token stays selectable */
    }
  };

  const panel = `rounded-md border ${isLight ? "bg-white border-slate-200" : "bg-slate-900/40 border-slate-800"}`;
  const control = `h-9 rounded-md border px-3 text-[13px] ${isLight ? "bg-white border-slate-300" : "bg-slate-900 border-slate-700"}`;
  const th = `px-4 py-2.5 text-[12px] font-semibold ${muted}`;

  return (
    <div className="max-w-6xl mx-auto px-4 sm:px-6 py-6 sm:py-8 pb-28">
      <div className="mb-6">
        <h1 className="text-[24px] font-semibold tracking-tight">Access</h1>
        <p className={`text-[14px] mt-1 ${muted}`}>Who can see and change {entity}&apos;s records.</p>
      </div>

      <div className="grid gap-8 lg:grid-cols-5">
        <div className="lg:col-span-3 space-y-8 min-w-0">
          <section aria-label="Your access">
            <h2 className="text-[16px] font-semibold mb-3">Your access</h2>
            <dl className={`${panel} divide-y ${isLight ? "divide-slate-100" : "divide-slate-800"} text-[13px]`}>
              {[
                ["Name", currentUser?.full_name || "—"],
                ["Email", currentUser?.email || "—"],
                ["Family entity", entity],
                ["Role", ROLE_LABEL[role]],
              ].map(([k, v]) => (
                <div key={k} className="grid grid-cols-3 gap-4 px-4 py-2.5">
                  <dt className={muted}>{k}</dt>
                  <dd className="col-span-2 break-words">{v}</dd>
                </div>
              ))}
            </dl>
          </section>

          <section aria-label="Role permissions">
            <h2 className="text-[16px] font-semibold mb-1">Role permissions</h2>
            <p className={`text-[13px] mb-3 ${muted}`}>Enforced by the server for every request, whatever the interface shows.</p>
            <div className={`${panel} overflow-x-auto`}>
              <table className="w-full min-w-[520px] text-[13px]">
                <caption className="sr-only">Permissions by role</caption>
                <thead className={`border-b ${isLight ? "bg-slate-50 border-slate-200" : "bg-slate-900 border-slate-800"}`}>
                  <tr>
                    <th scope="col" className={`${th} text-left`}>Action</th>
                    {ROLES.map((r) => (
                      <th key={r} scope="col" className={`${th} text-center ${r === role ? (isLight ? "text-[#0A2540]" : "text-white") : ""}`}>
                        {ROLE_LABEL[r]}
                        {r === role && <span className="sr-only"> (your role)</span>}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className={`divide-y ${isLight ? "divide-slate-100" : "divide-slate-800"}`}>
                  {PERMISSIONS.map((p) => (
                    <tr key={p.label}>
                      <th scope="row" className="px-4 py-2.5 text-left font-normal">
                        {p.label}
                      </th>
                      {ROLES.map((r) => (
                        <td key={r} className="px-4 py-2.5 text-center">
                          {p.roles.includes(r) ? (
                            <Check className="w-4 h-4 inline text-emerald-600" aria-label="Allowed" />
                          ) : (
                            <Minus className={`w-4 h-4 inline ${muted}`} aria-label="Not allowed" />
                          )}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </div>

        <section aria-label="Invite" className="lg:col-span-2 min-w-0">
          <h2 className="text-[16px] font-semibold mb-3">Invite someone</h2>
          {!can.invite(role) ? (
            <p className={`text-[13px] leading-relaxed ${muted}`}>
              Only family admins can invite members or advisers. Ask an admin of {entity} if someone needs access.
            </p>
          ) : (
            <form onSubmit={handleCreateInvite} className={`${panel} p-4 space-y-4`}>
              <fieldset>
                <legend className="text-[13px] font-medium mb-1.5">Role</legend>
                <div className="space-y-1.5 text-[13px]">
                  {(["family_member", "read_only_adviser"] as const).map((r) => (
                    <label key={r} className="flex items-start gap-2 cursor-pointer">
                      <input
                        type="radio"
                        name="invite-role"
                        className="mt-1 accent-[#2563EB]"
                        checked={roleToInvite === r}
                        onChange={() => setRoleToInvite(r)}
                      />
                      <span>
                        {ROLE_LABEL[r]}
                        <span className={`block text-[12px] ${muted}`}>
                          {r === "family_member" ? "Can view, query and upload shared documents." : "Can view and query only. Cannot upload or delete."}
                        </span>
                      </span>
                    </label>
                  ))}
                </div>
              </fieldset>
              <label className="block text-[13px]">
                <span className="font-medium">Invitation expires after</span>
                <select value={expiresInHours} onChange={(e) => setExpiresInHours(Number(e.target.value))} className={`${control} mt-1 w-full`}>
                  <option value={24}>24 hours</option>
                  <option value={72}>72 hours</option>
                  <option value={168}>7 days</option>
                </select>
              </label>
              {error && <ErrorState theme={theme} title="Invitation not created" body={error} compact />}
              <button
                type="submit"
                disabled={isSubmitting}
                className="h-9 px-3.5 rounded-md bg-[#2563EB] text-white text-[13px] font-medium hover:bg-[#1D4ED8] disabled:opacity-50"
              >
                {isSubmitting ? "Creating…" : "Create invitation"}
              </button>

              {createdInvite && (
                <div className={`pt-4 border-t ${isLight ? "border-slate-200" : "border-slate-800"}`} role="status">
                  <div className="text-[13px] font-medium">Invitation created</div>
                  <p className={`text-[12px] mt-0.5 ${muted}`}>
                    {ROLE_LABEL[createdInvite.role]} · single use · expires {formatDateTime(createdInvite.expires_at)}. Share it privately; anyone with
                    this token can join {entity}.
                  </p>
                  <div className="mt-2 flex gap-2">
                    <label htmlFor="invite-token" className="sr-only">
                      Invitation token
                    </label>
                    <input
                      id="invite-token"
                      readOnly
                      value={createdInvite.invite_token}
                      onFocus={(e) => e.currentTarget.select()}
                      className={`${control} flex-1 min-w-0 font-mono text-[12px]`}
                    />
                    <button type="button" onClick={() => copy(createdInvite.invite_token)} className={`${control} inline-flex items-center gap-1.5`}>
                      {copied ? <Check className="w-4 h-4 text-emerald-600" aria-hidden /> : <Copy className="w-4 h-4" aria-hidden />}
                      {copied ? "Copied" : "Copy"}
                    </button>
                  </div>
                </div>
              )}
            </form>
          )}
          <p className={`text-[12px] leading-relaxed mt-4 ${muted}`}>
            A member directory with invitation status is not yet provided by the API, so it is not shown here.
          </p>
        </section>
      </div>
    </div>
  );
}
