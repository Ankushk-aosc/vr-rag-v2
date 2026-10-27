"use client";

import React, { useEffect, useState } from "react";
import {
  FileText,
  Glasses,
  Sparkles,
  MessageSquare,
  Box,
  Sun,
  Moon,
  Brain,
  Lock,
  Unlock,
  LayoutGrid,
} from "lucide-react";
import { FloatingPanel } from "./FloatingPanel";

interface HeaderProps {
  selectedEntity?: string;
  onSelectEntity?: (entityId: string) => void;
  onOpenDocuments: () => void;
  onOpenVrModal: () => void;
  activeView: "spatial" | "ledger";
  onSelectView: (view: "spatial" | "ledger") => void;
  messageCount: number;
  onToggleDialogue: () => void;
  isDialogueOpen: boolean;
  theme: "dark" | "light";
  onToggleTheme: () => void;
  isThinkingOpen: boolean;
  onToggleThinking: () => void;
  layoutLocked: boolean;
  onToggleLayoutLock: () => void;
  onResetLayout: () => void;
}

export function Header({
  selectedEntity,
  onSelectEntity,
  onOpenDocuments,
  onOpenVrModal,
  activeView,
  onSelectView,
  messageCount,
  onToggleDialogue,
  isDialogueOpen,
  theme,
  onToggleTheme,
  isThinkingOpen,
  onToggleThinking,
  layoutLocked,
  onToggleLayoutLock,
  onResetLayout,
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

  const isLight = theme === "light";

  return (
    <FloatingPanel
      id="header"
      theme={theme}
      resize="x"
      showGrip
      minW={360}
      minH={52}
      ariaLabel="Navigation"
      defaultRect={(vw) => {
        const w = Math.min(1024, vw - 32);
        return { x: (vw - w) / 2, y: 44, w, h: 56 };
      }}
    >
    <header className="w-full">
      <div
        data-drag-handle
        className={`rounded-full px-4 sm:px-5 py-2.5 flex items-center justify-between border shadow-xl transition-colors ${
          isLight
            ? "border-black/10 bg-white text-black"
            : "border-white/10 bg-[#141418] text-white"
        }`}
      >
        {/* Brand Seal & Entity */}
        <div className="flex items-center space-x-3">
          <div className="w-8 h-8 rounded-full bg-gradient-to-br from-[#4C1D95] via-[#6D28D9] to-[#2E1065] border border-white/20 flex items-center justify-center shadow-md">
            <span className="text-[#D4AF37] font-semibold text-xs tracking-tighter">
              AE
            </span>
          </div>
          <div>
            <div className="flex items-center space-x-2">
              <span className="font-semibold text-xs sm:text-sm tracking-tight">
                Aether{" "}
                <span className={isLight ? "text-[#6D28D9] font-normal" : "text-[#A78BFA] font-normal"}>
                  Sovereign
                </span>
              </span>
              <span
                className={`hidden sm:inline text-[9px] uppercase font-mono font-semibold px-2 py-0.5 rounded-full border ${
                  isLight
                    ? "bg-[#6D28D9]/10 text-[#6D28D9] border-[#6D28D9]/20"
                    : "bg-[#7C3AED]/15 text-[#A78BFA] border-[#7C3AED]/30"
                }`}
              >
                AUD $
              </span>
            </div>
          </div>
        </div>

        {/* Center View Switcher */}
        <div
          className={`flex items-center rounded-full p-1 space-x-1 border ${
            isLight
              ? "bg-black/5 border-black/5"
              : "bg-black/40 border-white/10"
          }`}
        >
          <button
            onClick={() => onSelectView("spatial")}
            className={`flex items-center space-x-1.5 px-3 py-1 rounded-full text-xs font-medium transition-all ${
              activeView === "spatial"
                ? isLight
                  ? "bg-black text-white shadow-md"
                  : "bg-white text-black shadow-md"
                : isLight
                ? "text-black/60 hover:text-black"
                : "text-white/60 hover:text-white"
            }`}
          >
            <Box className="w-3.5 h-3.5" />
            <span className="hidden sm:inline">Spatial Room</span>
          </button>

          <button
            onClick={() => onSelectView("ledger")}
            className={`flex items-center space-x-1.5 px-3 py-1 rounded-full text-xs font-medium transition-all ${
              activeView === "ledger"
                ? isLight
                  ? "bg-black text-white shadow-md"
                  : "bg-white text-black shadow-md"
                : isLight
                ? "text-black/60 hover:text-black"
                : "text-white/60 hover:text-white"
            }`}
          >
            <FileText className="w-3.5 h-3.5" />
            <span className="hidden sm:inline">Ledger Vault</span>
          </button>
        </div>

        {/* Right Actions & Theme Switch */}
        <div className="flex items-center space-x-1.5 sm:space-x-2">
          {/* Live reasoning window */}
          <button
            onClick={onToggleThinking}
            title={isThinkingOpen ? "Hide reasoning window" : "Show reasoning window"}
            className={`hidden md:flex items-center space-x-1.5 px-3 py-1.5 rounded-full border text-xs font-medium transition-all ${
              isThinkingOpen
                ? isLight
                  ? "bg-[#6D28D9]/15 text-[#6D28D9] border-[#6D28D9]/40"
                  : "bg-[#7C3AED]/20 text-[#A78BFA] border-[#7C3AED]/50"
                : isLight
                ? "bg-black/5 hover:bg-black/10 text-black/80 border-black/10"
                : "bg-white/5 hover:bg-white/10 text-white/80 border-white/10"
            }`}
          >
            <Brain className="w-3.5 h-3.5" />
            <span className="hidden lg:inline">Reasoning</span>
          </button>

          {/* Layout: lock / reset every movable panel (2D and 3D) */}
          <div
            className={`flex items-center rounded-full border ${
              isLight ? "border-black/10 bg-black/5" : "border-white/10 bg-white/5"
            }`}
          >
            <button
              onClick={onToggleLayoutLock}
              title={layoutLocked ? "Unlock layout (allow moving panels)" : "Lock layout (prevent accidental moves)"}
              className={`p-2 rounded-full transition-all ${
                layoutLocked ? "text-[#D4AF37]" : isLight ? "text-black/60 hover:text-black" : "text-white/60 hover:text-white"
              }`}
            >
              {layoutLocked ? <Lock className="w-3.5 h-3.5" /> : <Unlock className="w-3.5 h-3.5" />}
            </button>
            <button
              onClick={onResetLayout}
              title="Reset all panel positions (2D and 3D)"
              className={`p-2 rounded-full transition-all ${isLight ? "text-black/60 hover:text-black" : "text-white/60 hover:text-white"}`}
            >
              <LayoutGrid className="w-3.5 h-3.5" />
            </button>
          </div>

          {/* Dialogue Toggle Button */}
          <button
            onClick={onToggleDialogue}
            aria-label="Toggle dialogue panel"
            className={`relative flex items-center space-x-1.5 px-3 py-1.5 rounded-full border text-xs font-medium transition-all ${
              isDialogueOpen
                ? isLight
                  ? "bg-[#6D28D9]/15 text-[#6D28D9] border-[#6D28D9]/40"
                  : "bg-[#7C3AED]/20 text-[#A78BFA] border-[#7C3AED]/50"
                : isLight
                ? "bg-black/5 hover:bg-black/10 text-black/80 border-black/10"
                : "bg-white/5 hover:bg-white/10 text-white/80 border-white/10"
            }`}
          >
            <MessageSquare className="w-3.5 h-3.5" />
            <span className="hidden sm:inline">Dialogue</span>
            {messageCount > 0 && (
              <span className="w-4 h-4 rounded-full bg-[#7C3AED] text-white font-mono text-[9px] font-bold flex items-center justify-center">
                {messageCount}
              </span>
            )}
          </button>

          {/* Dark / Light Mode Switcher */}
          <button
            onClick={onToggleTheme}
            aria-label={isLight ? "Switch to dark mode" : "Switch to light mode"}
            title={isLight ? "Dark Mode" : "Light Mode"}
            className={`p-2 rounded-full border transition-all hover:scale-105 active:scale-95 ${
              isLight
                ? "bg-black/5 hover:bg-black/10 border-black/10 text-black"
                : "bg-white/10 hover:bg-white/15 border-white/10 text-yellow-300"
            }`}
          >
            {isLight ? (
              <Moon className="w-3.5 h-3.5 text-[#581C87]" />
            ) : (
              <Sun className="w-3.5 h-3.5 text-[#D4AF37]" />
            )}
          </button>

          {/* Apple Vision Pro "View in VR" Button */}
          <button
            onClick={onOpenVrModal}
            className={`flex items-center space-x-1.5 px-3.5 py-1.5 rounded-full font-semibold text-xs tracking-tight transition-all active:scale-95 shadow-md ${
              isLight
                ? "bg-[#581C87] text-white hover:bg-[#4C1D95]"
                : "bg-white text-black hover:bg-white/90"
            }`}
          >
            <Glasses className="w-3.5 h-3.5" />
            <span className="hidden sm:inline">View in VR</span>
            <span
              className={`w-1.5 h-1.5 rounded-full ${
                webxrAvailable ? "bg-[#30D158]" : "bg-[#7C3AED]"
              }`}
            />
          </button>
        </div>
      </div>
    </header>
    </FloatingPanel>
  );
}
