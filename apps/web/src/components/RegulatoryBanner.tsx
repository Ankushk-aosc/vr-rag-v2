"use client";

import React, { useState } from "react";
import { ChevronDown, ChevronUp, ShieldCheck } from "lucide-react";

interface RegulatoryBannerProps {
  theme?: "dark" | "light";
}

export function RegulatoryBanner({ theme = "dark" }: RegulatoryBannerProps) {
  const [collapsed, setCollapsed] = useState(true);
  const isLight = theme === "light";

  return (
    <div
      className={`fixed top-0 left-0 right-0 z-50 border-b px-4 py-1.5 sm:py-2 text-xs backdrop-blur-xl transition-all shadow-sm ${
        isLight
          ? "bg-white/95 border-black/10 text-black/70"
          : "bg-[#0A0A0E]/95 border-white/[0.08] text-[#86868B]"
      }`}
    >
      <div className="max-w-7xl mx-auto flex items-center justify-between">
        <div className="flex items-center space-x-2">
          <ShieldCheck className={`w-3.5 h-3.5 flex-shrink-0 ${isLight ? "text-[#6D28D9]" : "text-[#A78BFA]"}`} />
          <span className="text-[#D4AF37] text-[11px] font-medium tracking-wide uppercase">
            Australia (Cth) Regulatory Disclosure:
          </span>
          <span className={`hidden md:inline text-[11px] ${isLight ? "text-black/60" : "text-[#A1A1A6]"}`}>
            Factual summaries derived strictly from authorized records under ASIC RG 244 & the Privacy Act 1988. Not personal financial product advice.
          </span>
        </div>
        <button
          onClick={() => setCollapsed(!collapsed)}
          className={`flex items-center space-x-1 text-[11px] transition-colors ${
            isLight ? "text-black/50 hover:text-black" : "text-[#86868B] hover:text-[#F5F5F7]"
          }`}
        >
          <span>{collapsed ? "Learn more" : "Collapse"}</span>
          {collapsed ? <ChevronDown className="w-3 h-3" /> : <ChevronUp className="w-3 h-3" />}
        </button>
      </div>

      {!collapsed && (
        <div
          className={`max-w-7xl mx-auto mt-2 pt-2 border-t text-[11px] leading-relaxed animate-in fade-in duration-200 ${
            isLight ? "border-black/5 text-black/70" : "border-white/[0.04] text-[#86868B]"
          }`}
        >
          This system operates strictly as an evidence-grounded financial document retrieval assistant for family governance. Information presented is synthesized directly from verified source records (ATO notices, bank statements, superannuation trusts) without external extrapolation. All monetary balances are displayed in Australian Dollars ($AUD) with tabular banking precision.
        </div>
      )}
    </div>
  );
}
