"use client";

import React, { useState } from "react";
import { ChevronDown, ChevronUp, ShieldCheck } from "lucide-react";

interface RegulatoryBannerProps {
  theme?: "dark" | "light";
}

export function RegulatoryBanner({ theme = "light" }: RegulatoryBannerProps) {
  const [collapsed, setCollapsed] = useState(true);
  const isLight = theme === "light";

  return (
    <div
      className={`w-full relative z-50 border-b px-4 py-1.5 sm:py-2 text-xs transition-all ${
        isLight
          ? "bg-slate-50 border-slate-200 text-slate-700"
          : "bg-[#090C12] border-slate-800 text-slate-400"
      }`}
    >
      <div className="max-w-7xl mx-auto flex items-center justify-between gap-2">
        <div className="flex items-start sm:items-center gap-2 min-w-0">
          <ShieldCheck className={`w-3.5 h-3.5 flex-shrink-0 mt-0.5 sm:mt-0 ${isLight ? "text-blue-600" : "text-blue-400"}`} aria-hidden />
          <span className={`hidden md:inline text-[11px] font-semibold tracking-wide uppercase flex-shrink-0 ${isLight ? "text-amber-700" : "text-amber-400"}`}>
            ASIC RG 244 & Privacy Act 1988:
          </span>
          {/* Wraps instead of truncating so the "not advice" statement is always readable */}
          <span className={`text-[11px] leading-snug md:truncate ${isLight ? "text-slate-600" : "text-slate-400"}`}>
            Factual summaries derived strictly from authorized records. Not personal financial product advice.
          </span>
        </div>
        <button
          onClick={() => setCollapsed(!collapsed)}
          aria-expanded={!collapsed}
          className={`flex items-center space-x-1 text-[11px] font-medium flex-shrink-0 transition-colors ${
            isLight ? "text-slate-500 hover:text-slate-800" : "text-slate-400 hover:text-white"
          }`}
        >
          <span>{collapsed ? "Details" : "Close"}</span>
          {collapsed ? <ChevronDown className="w-3 h-3" /> : <ChevronUp className="w-3 h-3" />}
        </button>
      </div>

      {!collapsed && (
        <div
          className={`max-w-7xl mx-auto mt-2 pt-2 border-t text-[11px] leading-relaxed animate-in fade-in duration-200 ${
            isLight ? "border-slate-200 text-slate-600" : "border-slate-800 text-slate-400"
          }`}
        >
          This system operates strictly as an evidence-grounded financial document retrieval assistant for family governance. Information presented is synthesized directly from verified source records (ATO notices, bank statements, superannuation trusts) without external extrapolation. All monetary balances are displayed in Australian Dollars ($AUD) with tabular banking precision.
        </div>
      )}
    </div>
  );
}
