import React, { useState } from "react";
import { EmptyState } from "./StateViews";
import { isDashboardRequest } from "../lib/charts/intent";

interface DashboardEmptyStateProps {
  theme: "light" | "dark";
  tabularDocumentCount: number;
  canUpload: boolean;
  onOpenUpload: () => void;
  onSendMessage: (text: string) => void;
}

export function DashboardEmptyState({ theme, tabularDocumentCount, canUpload, onOpenUpload, onSendMessage }: DashboardEmptyStateProps) {
  const [request, setRequest] = useState("");
  const isLight = theme === "light";

  if (tabularDocumentCount === 0) {
    return (
      <EmptyState
        theme={theme}
        title="Insufficient authorised data"
        body="Upload additional financial records, such as portfolio spreadsheets or bank statement exports, to generate this analysis."
        action={
          canUpload ? (
            <button
              type="button"
              onClick={onOpenUpload}
              className="h-9 px-3.5 rounded-md bg-[#2563EB] text-white text-[13px] font-medium hover:bg-[#1D4ED8]"
            >
              Upload documents
            </button>
          ) : undefined
        }
      />
    );
  }

  return (
    <EmptyState
      theme={theme}
      title="No analysis generated yet"
      body={`${tabularDocumentCount} spreadsheet${tabularDocumentCount === 1 ? "" : "s"} can be analysed. Describe the chart you need, for example a trend, allocation or comparison, and Aether will compute it from those records.`}
      action={
        <form
          className="flex w-full max-w-md gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            const text = request.trim();
            if (!text) return;
            // Phrased as a chart request so the page routes it to POST /api/dashboards
            onSendMessage(isDashboardRequest(text) ? text : `Create a chart of ${text}`);
            setRequest("");
          }}
        >
          <label htmlFor="analysis-request" className="sr-only">
            Describe the analysis
          </label>
          <input
            id="analysis-request"
            value={request}
            onChange={(e) => setRequest(e.target.value)}
            placeholder="e.g. allocation by asset class"
            className={`flex-1 h-9 rounded-md border px-3 text-[13px] ${isLight ? "bg-white border-slate-300" : "bg-slate-900 border-slate-700"}`}
          />
          <button type="submit" className="h-9 px-3.5 rounded-md bg-[#2563EB] text-white text-[13px] font-medium hover:bg-[#1D4ED8]">
            Generate
          </button>
        </form>
      }
    />
  );
}
