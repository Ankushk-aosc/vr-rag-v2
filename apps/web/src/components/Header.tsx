"use client";

import React, { useEffect, useState } from "react";
import { Eye, FileText, Glasses, Layers, ShieldCheck, Sparkles, Upload } from "lucide-react";
import { FamilyEntity } from "../types";

interface HeaderProps {
  selectedEntity: string;
  onSelectEntity: (entityId: string) => void;
  onOpenDocuments: () => void;
  onOpenVrModal: () => void;
}

export function Header({
  selectedEntity,
  onSelectEntity,
  onOpenDocuments,
  onOpenVrModal,
}: HeaderProps) {
  const [webxrAvailable, setWebxrAvailable] = useState<boolean | null>(null);

  useEffect(() => {
    if (typeof window !== "undefined" && "xr" in navigator) {
      // @ts-ignore
      navigator.xr
        ?.isSessionSupported("immersive-vr")
        .then((supported: boolean) => setWebxrAvailable(supported))
        .catch(() => setWebxrAvailable(false));
    } else {
      setWebxrAvailable(false);
    }
  }, []);

  return (
    <header className="aurora-glass border-b border-aurora-border/40 sticky top-0 z-40 px-4 py-3">
      <div className="max-w-7xl mx-auto flex items-center justify-between">
        {/* Brand & Cockpit Telemetry */}
        <div className="flex items-center space-x-3">
          <div className="relative flex items-center justify-center w-10 h-10 rounded-lg bg-aurora-panel border border-aurora-cyan/40 shadow-cyan-glow">
            <Sparkles className="w-5 h-5 text-aurora-cyan" />
            <div className="absolute -top-1 -right-1 w-2.5 h-2.5 rounded-full bg-aurora-cyan animate-ping" />
          </div>
          <div>
            <div className="flex items-center space-x-2">
              <h1 className="font-space font-bold text-lg tracking-wider text-white">
                AURORA <span className="text-aurora-cyan">SPATIAL</span>
              </h1>
              <span className="text-[10px] uppercase font-space px-1.5 py-0.5 rounded bg-aurora-cyan/15 text-aurora-cyan border border-aurora-cyan/30">
                AUD $
              </span>
            </div>
            <p className="text-xs text-aurora-muted font-sans">
              Australian Family Office RAG Assistant
            </p>
          </div>
        </div>

        {/* Entity Switcher & Actions */}
        <div className="flex items-center space-x-3">
          {/* Family Entity Selector */}
          <div className="hidden sm:flex items-center space-x-1.5 bg-aurora-panel/80 border border-aurora-border/60 rounded-lg px-3 py-1.5 text-xs">
            <Layers className="w-3.5 h-3.5 text-aurora-cyan" />
            <select
              value={selectedEntity}
              onChange={(e) => onSelectEntity(e.target.value)}
              className="bg-transparent text-aurora-text font-space focus:outline-none cursor-pointer"
            >
              <option value="default_family" className="bg-aurora-panel text-white">
                Smith Family Trust (ABN 48 123 456)
              </option>
              <option value="personal_portfolio" className="bg-aurora-panel text-white">
                Personal Super & Accounts (AUD)
              </option>
            </select>
          </div>

          {/* Manage Documents Button */}
          <button
            onClick={onOpenDocuments}
            className="flex items-center space-x-1.5 px-3 py-1.5 rounded-lg aurora-glass-interactive text-xs font-space font-medium text-white hover:text-aurora-cyan"
          >
            <FileText className="w-4 h-4 text-aurora-cyan" />
            <span className="hidden md:inline">Documents</span>
          </button>

          {/* YouTube-Style "VIEW IN VR" Action Button */}
          <button
            onClick={onOpenVrModal}
            className="relative group flex items-center space-x-2 px-3.5 py-1.5 rounded-lg bg-gradient-to-r from-aurora-cyan/20 to-aurora-violet/20 hover:from-aurora-cyan/35 hover:to-aurora-violet/35 border border-aurora-cyan/50 text-white shadow-cyan-glow transition-all duration-300 font-space text-xs font-bold uppercase tracking-wider"
          >
            <Glasses className="w-4 h-4 text-aurora-cyan animate-pulse" />
            <span>View in VR</span>
            <div className="w-1.5 h-1.5 rounded-full bg-aurora-cyan animate-ping" />
            
            {/* Tooltip badge indicating runtime WebXR status */}
            <span className="hidden group-hover:block absolute -bottom-7 right-0 whitespace-nowrap bg-aurora-panel text-[10px] text-aurora-cyan px-2 py-0.5 rounded border border-aurora-border shadow-lg">
              {webxrAvailable ? "WebXR Headset Ready" : "3D Spatial Mode Active"}
            </span>
          </button>
        </div>
      </div>
    </header>
  );
}
