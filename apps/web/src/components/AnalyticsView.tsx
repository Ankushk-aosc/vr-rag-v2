import React from "react";
import { DashboardView } from "./DashboardView";
import { DashboardEmptyState } from "./DashboardEmptyState";
import { Dashboard } from "../types";

interface AnalyticsViewProps {
  dashboards: Dashboard[];
  activeDashboardId: string | null;
  setActiveDashboardId: (id: string) => void;
  theme: "light" | "dark";
  onSendMessage: (text: string) => void;
  /** Number of tabular documents (spreadsheets / CSV) analytics can be computed from. */
  tabularDocumentCount: number;
  canUpload: boolean;
  onOpenUpload: () => void;
}

/**
 * Charts and KPIs here are computed by the API from the entity's indexed tables (POST /api/dashboards).
 * Nothing is drawn until such a dashboard exists; there are no sample or placeholder figures.
 */
export function AnalyticsView({
  dashboards,
  activeDashboardId,
  setActiveDashboardId,
  theme,
  onSendMessage,
  tabularDocumentCount,
  canUpload,
  onOpenUpload,
}: AnalyticsViewProps) {
  const isLight = theme === "light";
  const current = dashboards.find((d) => d.id === activeDashboardId) || dashboards[dashboards.length - 1];

  return (
    <div className="max-w-6xl mx-auto px-4 sm:px-6 py-6 sm:py-8 pb-28">
      <div className="mb-5">
        <h1 className="text-[24px] font-semibold tracking-tight">Analytics</h1>
        <p className={`text-[14px] mt-1 ${isLight ? "text-slate-500" : "text-slate-400"}`}>
          Figures computed directly from your authorised spreadsheets and tables.
        </p>
      </div>

      {dashboards.length > 1 && (
        <div role="tablist" aria-label="Dashboards" className={`flex flex-wrap gap-1 mb-4 border-b ${isLight ? "border-slate-200" : "border-slate-800"}`}>
          {dashboards.map((d) => {
            const active = d.id === current?.id;
            return (
              <button
                key={d.id}
                role="tab"
                aria-selected={active}
                onClick={() => setActiveDashboardId(d.id)}
                className={`px-3 py-2 -mb-px border-b-2 text-[13px] font-medium ${
                  active
                    ? `border-[#2563EB] ${isLight ? "text-[#0A2540]" : "text-white"}`
                    : `border-transparent ${isLight ? "text-slate-500 hover:text-slate-900" : "text-slate-400 hover:text-white"}`
                }`}
              >
                {d.title || "Dashboard"}
              </button>
            );
          })}
        </div>
      )}

      {current ? (
        <section aria-label={current.title}>
          <div className="mb-3">
            <h2 className="text-[16px] font-semibold">{current.title}</h2>
            {current.subtitle && <p className={`text-[13px] ${isLight ? "text-slate-500" : "text-slate-400"}`}>{current.subtitle}</p>}
          </div>
          <DashboardView dashboard={current} theme={theme} />
        </section>
      ) : (
        <DashboardEmptyState
          theme={theme}
          tabularDocumentCount={tabularDocumentCount}
          canUpload={canUpload}
          onOpenUpload={onOpenUpload}
          onSendMessage={onSendMessage}
        />
      )}
    </div>
  );
}
