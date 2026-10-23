"use client";

import React, { useState } from "react";
import { AlertCircle, ChevronDown, ChevronUp, ShieldCheck } from "lucide-react";

export function RegulatoryBanner() {
  const [collapsed, setCollapsed] = useState(false);

  return (
    <div className="bg-aurora-void/90 border-b border-aurora-cyan/15 px-4 py-2 text-xs backdrop-blur-md">
      <div className="max-w-7xl mx-auto flex items-center justify-between">
        <div className="flex items-center space-x-2 text-aurora-muted">
          <ShieldCheck className="w-4 h-4 text-aurora-cyan flex-shrink-0" />
          <span className="font-space text-aurora-cyan uppercase tracking-wider font-semibold">
            Australia (Cth) Regulatory Disclosure:
          </span>
          <span className="hidden md:inline">
            Factual summaries derived strictly from authorized records under ASIC RG 244 & the Privacy Act 1988. Not personal financial product advice.
          </span>
        </div>
        <button
          onClick={() => setCollapsed(!collapsed)}
          className="text-aurora-muted hover:text-aurora-cyan flex items-center space-x-1 font-space transition-colors"
        >
          <span>{collapsed ? "Expand" : "Details"}</span>
          {collapsed ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronUp className="w-3.5 h-3.5" />}
        </button>
      </div>

      {!collapsed && (
        <div className="max-w-7xl mx-auto mt-2 pt-2 border-t border-aurora-border/40 text-[11px] text-aurora-muted/80 leading-relaxed">
          This system functions solely as an evidence-grounded document search and retrieval assistant. Information presented is extracted from uploaded source documents (ATO notices, bank statements, superannuation records) and must not be construed as investment, tax, or legal advice. All monetary values are rendered in Australian Dollars ($AUD) unless expressly designated otherwise.
        </div>
      )}
    </div>
  );
}
