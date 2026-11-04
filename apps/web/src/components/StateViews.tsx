"use client";

import React from "react";
import { AlertCircle } from "lucide-react";

type Theme = "light" | "dark";

/** Explains what is empty, why, and what to do next. */
export function EmptyState({
  title,
  body,
  action,
  theme,
  compact = false,
}: {
  title: string;
  body: string;
  action?: React.ReactNode;
  theme: Theme;
  compact?: boolean;
}) {
  const isLight = theme === "light";
  return (
    <div
      className={`rounded-md border border-dashed ${compact ? "p-4" : "px-6 py-10 text-center"} ${
        isLight ? "border-slate-300 bg-white" : "border-slate-700 bg-slate-900/40"
      }`}
    >
      <h3 className="text-[14px] font-semibold">{title}</h3>
      <p className={`text-[13px] leading-relaxed mt-1 ${compact ? "" : "max-w-md mx-auto"} ${isLight ? "text-slate-500" : "text-slate-400"}`}>
        {body}
      </p>
      {action && <div className={`mt-4 ${compact ? "" : "flex justify-center"}`}>{action}</div>}
    </div>
  );
}

/** A calm failure message. Technical details stay in logs. */
export function ErrorState({
  title,
  body,
  onRetry,
  theme,
  compact = false,
}: {
  title: string;
  body: string;
  onRetry?: () => void;
  theme: Theme;
  compact?: boolean;
}) {
  const isLight = theme === "light";
  return (
    <div
      role="alert"
      className={`rounded-md border ${compact ? "p-3" : "p-5"} ${
        isLight ? "border-rose-200 bg-rose-50 text-rose-900" : "border-rose-900 bg-rose-950/30 text-rose-200"
      }`}
    >
      <div className="flex items-start gap-2.5">
        <AlertCircle className="w-4 h-4 mt-0.5 flex-shrink-0" aria-hidden />
        <div className="min-w-0">
          <h3 className="text-[14px] font-semibold">{title}</h3>
          <p className="text-[13px] leading-relaxed mt-0.5">{body}</p>
          {onRetry && (
            <button
              type="button"
              onClick={onRetry}
              className={`mt-3 h-8 px-3 rounded-md border text-[13px] font-medium ${
                isLight ? "border-rose-300 bg-white hover:bg-rose-100" : "border-rose-800 hover:bg-rose-900/40"
              }`}
            >
              Try again
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

export function SkeletonRows({ rows = 3, theme }: { rows?: number; theme: Theme }) {
  const bar = theme === "light" ? "bg-slate-200" : "bg-slate-800";
  return (
    <div className="space-y-3 animate-pulse" aria-busy="true" aria-label="Loading">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="space-y-1.5">
          <div className={`h-3 rounded ${bar}`} style={{ width: `${70 - (i % 3) * 12}%` }} />
          <div className={`h-2.5 rounded ${bar} w-1/3`} />
        </div>
      ))}
    </div>
  );
}
