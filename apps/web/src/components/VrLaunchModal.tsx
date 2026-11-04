"use client";

import React, { useEffect, useRef, useState } from "react";
import { X, Loader2 } from "lucide-react";

interface VrLaunchModalProps {
  isOpen: boolean;
  onClose: () => void;
  onEnterWebXr: () => void;
  onLaunchStereo?: () => void;
  onOpenSpatial?: () => void;
  theme?: "dark" | "light";
}

type XrSupport = "checking" | "supported" | "unsupported";

/** Detects immersive-vr support each time it opens; VR is optional and never required for any workflow. */
export function VrLaunchModal({ isOpen, onClose, onEnterWebXr, onLaunchStereo, onOpenSpatial, theme = "light" }: VrLaunchModalProps) {
  const [support, setSupport] = useState<XrSupport>("checking");
  const [pageUrl, setPageUrl] = useState("");
  const panelRef = useRef<HTMLDivElement | null>(null);
  const isLight = theme === "light";

  useEffect(() => {
    if (!isOpen) return;
    setPageUrl(window.location.origin);
    setSupport("checking");
    let live = true;
    const xr = (navigator as Navigator & { xr?: XRSystem }).xr;
    if (!xr?.isSessionSupported) {
      setSupport("unsupported");
    } else {
      xr.isSessionSupported("immersive-vr")
        .then((ok) => live && setSupport(ok ? "supported" : "unsupported"))
        .catch(() => live && setSupport("unsupported"));
    }
    panelRef.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    return () => {
      live = false;
      document.removeEventListener("keydown", onKey);
    };
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const muted = isLight ? "text-slate-500" : "text-slate-400";
  const secondary = `h-9 px-3.5 rounded-md border text-[13px] font-medium ${
    isLight ? "border-slate-300 hover:bg-slate-50" : "border-slate-600 hover:bg-slate-800"
  }`;
  const primary = "h-9 px-3.5 rounded-md bg-[#2563EB] text-white text-[13px] font-medium hover:bg-[#1D4ED8]";

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center p-4 bg-slate-900/40" onMouseDown={onClose}>
      <div
        ref={panelRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby="vr-title"
        onMouseDown={(e) => e.stopPropagation()}
        className={`w-full max-w-md rounded-lg border shadow-xl focus:outline-none ${
          isLight ? "bg-white border-slate-200 text-slate-900" : "bg-[#0F172A] border-slate-700 text-slate-100"
        }`}
      >
        <div className={`flex items-start justify-between gap-3 px-5 py-4 border-b ${isLight ? "border-slate-200" : "border-slate-800"}`}>
          <div>
            <h2 id="vr-title" className="text-[16px] font-semibold">
              View in VR
            </h2>
            <p className={`text-[13px] ${muted}`}>Optional. Every workflow is also available in the browser.</p>
          </div>
          <button onClick={onClose} aria-label="Close" className={`p-1.5 rounded ${isLight ? "text-slate-500 hover:bg-slate-100" : "text-slate-400 hover:bg-slate-800"}`}>
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="px-5 py-4 space-y-4 text-[14px]" aria-live="polite">
          {support === "checking" && (
            <p className={`flex items-center gap-2 ${muted}`}>
              <Loader2 className="w-4 h-4 animate-spin" aria-hidden /> Checking this device for VR support…
            </p>
          )}
          {support === "supported" && (
            <p className="leading-relaxed">
              This device supports immersive VR. Your documents, evidence and voice controls open around you in the Spatial Room.
            </p>
          )}
          {support === "unsupported" && (
            <>
              <div>
                <p className="font-medium">VR is unavailable on this device/browser.</p>
                <p className={`mt-1 leading-relaxed ${muted}`}>You can continue using Spatial Room in desktop mode.</p>
              </div>
              {pageUrl && (
                <p className={`text-[13px] leading-relaxed ${muted}`}>
                  To use a headset, open <code className={`px-1 py-0.5 rounded font-mono text-[12px] ${isLight ? "bg-slate-100 text-slate-800" : "bg-slate-800 text-slate-200"}`}>{pageUrl}</code> in the
                  headset&apos;s browser and sign in there.
                </p>
              )}
            </>
          )}
        </div>

        <div className={`flex flex-wrap justify-end gap-2 px-5 py-3 border-t ${isLight ? "border-slate-200" : "border-slate-800"}`}>
          {support === "unsupported" && onLaunchStereo && (
            <button
              type="button"
              className={secondary}
              onClick={() => {
                onLaunchStereo();
                onClose();
              }}
            >
              Stereo preview
            </button>
          )}
          {support !== "supported" && onOpenSpatial && (
            <button
              type="button"
              className={primary}
              onClick={() => {
                onOpenSpatial();
                onClose();
              }}
            >
              Open Spatial Room
            </button>
          )}
          {support === "supported" && (
            <button
              type="button"
              className={primary}
              onClick={() => {
                onEnterWebXr();
                onClose();
              }}
            >
              Enter VR
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
