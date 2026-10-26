"use client";

import React, { useEffect, useState } from "react";
import { Glasses, Smartphone, X, CheckCircle, Monitor, ArrowRight } from "lucide-react";
import { isMobileDevice } from "../lib/webxr";

interface VrLaunchModalProps {
  isOpen: boolean;
  onClose: () => void;
  onEnterWebXr: () => void;
  onLaunchStereo?: () => void;
  theme?: "dark" | "light";
}

export function VrLaunchModal({
  isOpen,
  onClose,
  onEnterWebXr,
  onLaunchStereo,
  theme = "light",
}: VrLaunchModalProps) {
  const [webxrSupported, setWebxrSupported] = useState<boolean>(false);
  const [sessionUrl, setSessionUrl] = useState<string>("");
  const isLight = theme === "light";

  useEffect(() => {
    if (typeof window !== "undefined") {
      setSessionUrl(window.location.href);
      if ("xr" in navigator) {
        // @ts-ignore
        navigator.xr?.isSessionSupported("immersive-vr").then((supported: boolean) => {
          setWebxrSupported(supported);
        }).catch(() => setWebxrSupported(false));
      }
    }
  }, []);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-2xl animate-in fade-in duration-200">
      <div
        className={`apple-glass w-full max-w-lg rounded-3xl shadow-2xl overflow-hidden flex flex-col border transition-all ${
          isLight ? "bg-white/95 border-black/10 text-black shadow-xl" : "border-white/10 text-white"
        }`}
      >
        {/* Apple Vision Pro Modal Header */}
        <div
          className={`flex items-center justify-between px-6 py-4 border-b ${
            isLight ? "border-black/10 bg-black/[0.02]" : "border-white/10 bg-black/40"
          }`}
        >
          <div className="flex items-center space-x-3">
            <div className="w-8 h-8 rounded-full bg-[#7C3AED]/15 border border-[#7C3AED]/30 flex items-center justify-center">
              <Glasses className={`w-4 h-4 ${isLight ? "text-[#6D28D9]" : "text-[#A78BFA]"}`} />
            </div>
            <div>
              <h3 className="font-semibold text-sm sm:text-base tracking-tight">
                Aether Sovereign VR
              </h3>
              <p className={`text-[11px] ${isLight ? "text-black/50" : "text-white/50"}`}>
                Spatial Portfolio Immersion • Apple Vision Pro & Meta Quest
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            aria-label="Close modal"
            className={`p-2 rounded-full transition-colors ${
              isLight ? "text-black/60 hover:text-black hover:bg-black/5" : "text-white/60 hover:text-white hover:bg-white/10"
            }`}
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Modal Body */}
        <div className="p-6 space-y-5">
          {webxrSupported ? (
            /* Direct WebXR Session Ready */
            <div className="text-center space-y-4 py-2">
              <div className="w-16 h-16 mx-auto rounded-full bg-[#7C3AED]/20 border border-[#7C3AED]/50 flex items-center justify-center text-[#7C3AED] shadow-xl">
                <Glasses className="w-8 h-8" />
              </div>
              <div className="space-y-1">
                <h4 className="font-semibold text-base">
                  Spatial Headset Detected
                </h4>
                <p className={`text-xs max-w-sm mx-auto leading-relaxed ${isLight ? "text-black/60" : "text-white/60"}`}>
                  Your device supports native WebXR. Enter full 6DoF spatial immersion to walk around your floating document slabs with natural hand tracking.
                </p>
              </div>

              <button
                onClick={() => {
                  onEnterWebXr();
                  onClose();
                }}
                className={`w-full py-3 px-4 rounded-full font-semibold text-xs tracking-tight transition-all shadow-lg active:scale-95 flex items-center justify-center space-x-2 ${
                  isLight
                    ? "bg-[#581C87] text-white hover:bg-[#4C1D95]"
                    : "bg-white text-black hover:bg-white/90"
                }`}
              >
                <span>Enter Immersive Spatial Session</span>
                <ArrowRight className="w-4 h-4" />
              </button>
            </div>
          ) : (
            /* Companion Headset Launch Pattern */
            <div className="space-y-4">
              <div className="text-center space-y-1">
                <h4 className="font-semibold text-sm">
                  Launch Inside Your Spatial Headset
                </h4>
                <p className={`text-xs leading-relaxed ${isLight ? "text-black/50" : "text-white/50"}`}>
                  Experience your Australian financial portfolio in full scale inside Apple Vision Pro Safari or Meta Quest Browser.
                </p>
              </div>

              {/* Mobile Cardboard Option */}
              {onLaunchStereo && (
                <button
                  onClick={() => {
                    onLaunchStereo();
                    onClose();
                  }}
                  className={`w-full py-3 px-4 rounded-2xl border text-xs font-medium flex items-center justify-center space-x-2 transition-all ${
                    isLight
                      ? "bg-black/[0.03] hover:bg-black/[0.06] border-black/10 text-black"
                      : "bg-white/[0.04] hover:bg-white/[0.08] border-white/10 text-white"
                  }`}
                >
                  <Smartphone className={`w-4 h-4 ${isLight ? "text-[#6D28D9]" : "text-[#A78BFA]"}`} />
                  <span>Launch Mobile Cardboard Split-Screen Mode</span>
                </button>
              )}

              {/* QR Code & Direct Link */}
              <div
                className={`p-5 rounded-2xl border flex flex-col items-center justify-center space-y-3 ${
                  isLight ? "bg-[#F5F5FA] border-black/10" : "bg-[#0A0A0E] border-white/10"
                }`}
              >
                <div className="w-32 h-32 bg-white p-2.5 rounded-xl flex items-center justify-center shadow-lg">
                  <div className="w-full h-full border-2 border-black p-1 flex flex-col justify-between">
                    <div className="flex justify-between">
                      <div className="w-6 h-6 bg-black rounded-sm" />
                      <div className="w-2.5 h-2.5 bg-black" />
                      <div className="w-6 h-6 bg-black rounded-sm" />
                    </div>
                    <div className="text-center text-[7px] font-mono font-bold text-black tracking-tight">
                      HEADSET SCAN
                    </div>
                    <div className="flex justify-between items-end">
                      <div className="w-6 h-6 bg-black rounded-sm" />
                      <div className="w-2.5 h-2.5 bg-black" />
                      <div className="w-6 h-6 bg-black rounded-sm" />
                    </div>
                  </div>
                </div>

                <div className="w-full text-center">
                  <span className={`text-[10px] uppercase tracking-wider block font-medium ${isLight ? "text-black/40" : "text-white/40"}`}>
                    Headset Safari / Quest URL:
                  </span>
                  <code
                    className={`text-xs font-mono px-3 py-1.5 rounded-xl block mt-1.5 truncate border ${
                      isLight
                        ? "bg-black/5 text-[#6D28D9] border-black/5"
                        : "bg-white/5 text-[#A78BFA] border-white/5"
                    }`}
                  >
                    {sessionUrl}
                  </code>
                </div>
              </div>

              {/* Step instructions */}
              <div className={`space-y-2 text-xs ${isLight ? "text-black/60" : "text-white/60"}`}>
                <div className="flex items-start space-x-2">
                  <CheckCircle className={`w-3.5 h-3.5 flex-shrink-0 mt-0.5 ${isLight ? "text-[#6D28D9]" : "text-[#A78BFA]"}`} />
                  <span>
                    <strong className={isLight ? "text-black font-semibold" : "text-white font-medium"}>
                      Apple Vision Pro:
                    </strong>{" "}
                    Open Safari, navigate to this URL, and tap "View in VR" for visionOS spatial placement.
                  </span>
                </div>
                <div className="flex items-start space-x-2">
                  <CheckCircle className="w-3.5 h-3.5 text-[#D4AF37] flex-shrink-0 mt-0.5" />
                  <span>
                    <strong className={isLight ? "text-black font-semibold" : "text-white font-medium"}>
                      Meta Quest 2 / 3:
                    </strong>{" "}
                    Open Meta Quest Browser, enter the link, and enter full 6DoF immersion.
                  </span>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Modal Footer */}
        <div
          className={`px-6 py-4 border-t flex justify-between items-center text-xs ${
            isLight ? "border-black/10 bg-black/[0.02]" : "border-white/10 bg-black/40"
          }`}
        >
          <span className={`text-[11px] flex items-center space-x-1.5 ${isLight ? "text-black/40" : "text-white/40"}`}>
            <Monitor className="w-3.5 h-3.5" />
            <span>Desktop orbit controls active in background</span>
          </span>
          <button
            onClick={onClose}
            className={`px-4 py-1.5 rounded-full text-xs font-medium border transition-all ${
              isLight
                ? "bg-black/5 hover:bg-black/10 border-black/10 text-black/80"
                : "bg-white/5 hover:bg-white/10 border-white/10 text-white/80 hover:text-white"
            }`}
          >
            Dismiss
          </button>
        </div>
      </div>
    </div>
  );
}
