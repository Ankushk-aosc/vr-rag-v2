"use client";

import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Search, RefreshCw, Download } from "lucide-react";
import { AuditEvent } from "../types";
import { fetchAuditEvents } from "../lib/api";
import { friendlyError } from "../lib/apiErrors";
import { FamilyRole, can } from "../lib/roles";
import { formatDateTime, humanizeAction } from "../lib/format";
import { EmptyState, ErrorState, SkeletonRows } from "./StateViews";

interface AuditViewProps {
  entityId: string;
  entityLabel?: string;
  currentUserId?: string;
  theme?: "dark" | "light";
  userRole: FamilyRole;
}

const PAGE_SIZE = 25;

/** Outcome is read from the backend's action name (e.g. LOGIN_FAILED); it is never invented. */
function outcomeOf(action: string): "Failed" | "Denied" | "Success" {
  const a = action.toUpperCase();
  if (a.includes("DENIED") || a.includes("FORBIDDEN") || a.includes("UNAUTHORIZED")) return "Denied";
  if (a.includes("FAIL") || a.includes("ERROR") || a.includes("REJECT")) return "Failed";
  return "Success";
}

/** Spreadsheet apps execute cells that start with = + - @; neutralise them in exports. */
function csvCell(v: string) {
  const safe = /^[=+\-@\t\r]/.test(v) ? `'${v}` : v;
  return `"${safe.replace(/"/g, '""')}"`;
}

export function AuditView({ entityId, entityLabel, currentUserId, theme = "light", userRole }: AuditViewProps) {
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [actionFilter, setActionFilter] = useState("ALL");
  const [page, setPage] = useState(1);
  const isLight = theme === "light";
  const muted = isLight ? "text-slate-500" : "text-slate-400";
  const entityWide = can.viewEntityAudit(userRole);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      setIsLoading(true);
      setError(null);
      try {
        // Admins get the entity trail; others get their own events (the API enforces both)
        const data = await fetchAuditEvents(entityWide ? entityId : undefined, signal);
        if (!signal?.aborted) setEvents(data.filter((e) => !e.family_entity_id || e.family_entity_id === entityId));
      } catch (err) {
        if (!signal?.aborted) setError(friendlyError(err, "load the audit trail").body);
      } finally {
        if (!signal?.aborted) setIsLoading(false);
      }
    },
    [entityId, entityWide]
  );

  useEffect(() => {
    const ctrl = new AbortController();
    load(ctrl.signal);
    return () => ctrl.abort();
  }, [load]);

  const actionTypes = useMemo(() => Array.from(new Set(events.map((e) => e.action))).sort(), [events]);

  const filtered = useMemo(() => {
    const q = searchQuery.toLowerCase().trim();
    return events.filter(
      (ev) =>
        (actionFilter === "ALL" || ev.action === actionFilter) &&
        (!q || [ev.action, ev.details, ev.user_id, ev.resource_id].some((f) => f && f.toLowerCase().includes(q)))
    );
  }, [events, actionFilter, searchQuery]);

  useEffect(() => setPage(1), [searchQuery, actionFilter, entityId]);
  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const visible = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  const actor = (id: string | null) => (!id ? "System" : id === currentUserId ? "You" : `User ${id.slice(0, 8)}`);

  const exportCsv = () => {
    if (!filtered.length) return;
    const header = ["Timestamp", "Actor user ID", "Action", "Resource", "Result", "Details"];
    const rows = filtered.map((e) =>
      [e.timestamp, e.user_id || "System", e.action, e.resource_id || "", outcomeOf(e.action), e.details || ""].map(csvCell).join(",")
    );
    const blob = new Blob([[header.map(csvCell).join(","), ...rows].join("\n")], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `aether_audit_${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  };

  const control = `h-9 rounded-md border px-3 text-[13px] ${
    isLight ? "bg-white border-slate-300 text-slate-900" : "bg-slate-900 border-slate-700 text-slate-100"
  }`;
  const th = `px-4 py-2.5 text-left text-[12px] font-semibold ${muted}`;
  const td = "px-4 py-3 text-[13px] align-top";

  return (
    <div className="max-w-6xl mx-auto px-4 sm:px-6 py-6 sm:py-8 pb-28">
      <div className="flex flex-wrap items-end justify-between gap-4 mb-5">
        <div>
          <h1 className="text-[24px] font-semibold tracking-tight">Audit</h1>
          <p className={`text-[14px] mt-1 ${muted}`}>
            {entityWide
              ? `All recorded access and changes for ${entityLabel || "this family entity"}.`
              : "Your own recorded activity. Family admins can view the full entity trail."}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button type="button" onClick={() => load()} disabled={isLoading} className={`${control} inline-flex items-center gap-1.5 disabled:opacity-50`}>
            <RefreshCw className={`w-4 h-4 ${isLoading ? "animate-spin" : ""}`} aria-hidden /> Refresh
          </button>
          <button
            type="button"
            onClick={exportCsv}
            disabled={!filtered.length}
            className={`${control} inline-flex items-center gap-1.5 disabled:opacity-50`}
          >
            <Download className="w-4 h-4" aria-hidden /> Export CSV
          </button>
        </div>
      </div>

      {error ? (
        <ErrorState theme={theme} title="We couldn't load the audit trail" body={error} onRetry={() => load()} />
      ) : isLoading && !events.length ? (
        <SkeletonRows rows={6} theme={theme} />
      ) : !events.length ? (
        <EmptyState
          theme={theme}
          title="No audit events recorded"
          body="Sign-ins, uploads, deletions, invitations and queries for this family entity will be listed here as they happen."
        />
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2 mb-3">
            <div className="relative flex-1 min-w-[200px] max-w-sm">
              <Search className={`w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 ${muted}`} aria-hidden />
              <label htmlFor="audit-search" className="sr-only">
                Search audit trail
              </label>
              <input
                id="audit-search"
                type="search"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search action, actor or resource"
                className={`${control} w-full pl-9`}
              />
            </div>
            <label htmlFor="audit-action" className="sr-only">
              Filter by action
            </label>
            <select id="audit-action" value={actionFilter} onChange={(e) => setActionFilter(e.target.value)} className={control}>
              <option value="ALL">All actions</option>
              {actionTypes.map((a) => (
                <option key={a} value={a}>
                  {humanizeAction(a)}
                </option>
              ))}
            </select>
            <span className={`ml-auto text-[13px] ${muted}`}>
              {filtered.length} event{filtered.length === 1 ? "" : "s"}
            </span>
          </div>

          <div className={`rounded-md border overflow-x-auto ${isLight ? "bg-white border-slate-200" : "bg-slate-900/40 border-slate-800"}`}>
            <table className="w-full min-w-[760px]">
              <caption className="sr-only">Audit events</caption>
              <thead className={`border-b ${isLight ? "bg-slate-50 border-slate-200" : "bg-slate-900 border-slate-800"}`}>
                <tr>
                  <th scope="col" className={th}>Timestamp</th>
                  <th scope="col" className={th}>Actor</th>
                  <th scope="col" className={th}>Action</th>
                  <th scope="col" className={th}>Resource</th>
                  <th scope="col" className={th}>Result</th>
                </tr>
              </thead>
              <tbody className={`divide-y ${isLight ? "divide-slate-100" : "divide-slate-800"}`}>
                {visible.map((e) => {
                  const outcome = outcomeOf(e.action);
                  return (
                    <tr key={e.id}>
                      <td className={`${td} whitespace-nowrap tabular-nums ${muted}`}>{formatDateTime(e.timestamp)}</td>
                      <td className={`${td} whitespace-nowrap`} title={e.user_id || undefined}>
                        {actor(e.user_id)}
                      </td>
                      <td className={td}>
                        <div className="font-medium">{humanizeAction(e.action)}</div>
                        {e.details && <div className={`text-[12px] mt-0.5 break-words max-w-[380px] ${muted}`}>{e.details}</div>}
                      </td>
                      <td className={`${td} font-mono text-[12px] ${muted}`} title={e.resource_id || undefined}>
                        {e.resource_id ? `${e.resource_id.slice(0, 12)}${e.resource_id.length > 12 ? "…" : ""}` : "—"}
                      </td>
                      <td className={td}>
                        <span className="inline-flex items-center gap-1.5">
                          <span
                            aria-hidden
                            className={`w-1.5 h-1.5 rounded-full ${outcome === "Success" ? "bg-emerald-600" : outcome === "Denied" ? "bg-amber-500" : "bg-rose-600"}`}
                          />
                          {outcome}
                        </span>
                      </td>
                    </tr>
                  );
                })}
                {!visible.length && (
                  <tr>
                    <td colSpan={5} className={`px-4 py-8 text-center text-[13px] ${muted}`}>
                      No events match these filters.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          {pageCount > 1 && (
            <div className={`flex items-center justify-end gap-2 mt-3 text-[13px] ${muted}`}>
              <span className="tabular-nums">
                Page {page} of {pageCount}
              </span>
              <button type="button" disabled={page <= 1} onClick={() => setPage((p) => p - 1)} className={`${control} h-8 disabled:opacity-40`}>
                Previous
              </button>
              <button type="button" disabled={page >= pageCount} onClick={() => setPage((p) => p + 1)} className={`${control} h-8 disabled:opacity-40`}>
                Next
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
