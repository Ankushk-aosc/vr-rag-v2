"use client";

import React, { useEffect, useState } from "react";
import { Glasses, QrCode, Smartphone, X, CheckCircle, ExternalLink, Sparkles } from "lucide-react";

interface VrLaunchModalProps {
  isOpen: boolean;
  onClose: () => void;
  onEnterWebXr: () => void;
}

export function VrLaunchModal({ isOpen, onClose, onEnterWebXr }: VrLaunchModalProps) {
  const [webxrSupported, setWebxrSupported] = useState<boolean>(false);
  const [sessionUrl, setSessionUrl] = useState<string>("");

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
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/75 backdrop-blur-md animate-in fade-in duration-200">
      <div className="aurora-glass border border-aurora-cyan/50 w-full max-w-lg rounded-2xl shadow-cyan-glow overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-aurora-border/40 bg-aurora-panel/90">
          <div className="flex items-center space-x-2.5">
            <Glasses className="w-5 h-5 text-aurora-cyan animate-pulse" />
            <h3 className="font-space font-bold text-white text-base tracking-wide">
              VIEW IN VR (Spatial Immersion)
            </h3>
          </div>
          <button
            onClick={onClose}
            className="text-aurora-muted hover:text-white p-1 rounded-lg transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Body */}
        <div className="p-6 space-y-6">
          {webxrSupported ? (
            /* Direct WebXR Session Ready (Meta Quest / Vision Pro Browser) */
            <div className="text-center space-y-4">
              <div className="w-16 h-16 mx-auto rounded-full bg-aurora-cyan/20 border-2 border-aurora-cyan flex items-center justify-center text-aurora-cyan shadow-cyan-glow">
                <Glasses className="w-8 h-8" />
              </div>
              <div>
                <h4 className="font-space font-bold text-white text-lg">
                  WebXR Headset Detected!
                </h4>
                <p className="text-xs text-aurora-muted mt-1 max-w-sm mx-auto">
                  Your device supports immersive spatial VR. Enter full 6DoF mode to explore floating financial evidence panels and speak naturally with hand/controller tracking.
                </p>
              </div>

              <button
                onClick={() => {
                  onEnterWebXr();
                  onClose();
                }}
                className="w-full py-3 rounded-xl bg-gradient-to-r from-aurora-cyan to-aurora-violet text-black font-space font-bold text-sm tracking-wider uppercase shadow-cyan-glow hover:opacity-90 transition-all"
              >
                Launch Immersive VR Session
              </button>
            </div>
          ) : (
            /* Companion Headset Launch Pattern (YouTube-style Desktop/Mobile Handoff) */
            <div className="space-y-5">
              <div className="text-center space-y-1">
                <h4 className="font-space font-bold text-white text-sm">
                  Launch in Meta Quest or Apple Vision Pro
                </h4>
                <p className="text-xs text-aurora-muted">
                  Just like YouTube's "View in VR", open this session inside your headset's browser to experience the 3D room in full spatial scale.
                </p>
              </div>

              {/* QR Code Simulation & URL */}
              <div className="bg-aurora-void/90 p-4 rounded-xl border border-aurora-border/60 flex flex-col items-center justify-center space-y-3">
                {/* Visual SVG QR representation */}
                <div className="w-40 h-40 bg-white p-2.5 rounded-lg flex items-center justify-center shadow-lg">
                  <div className="w-full h-full border-4 border-black p-1 flex flex-col justify-between">
                    <div className="flex justify-between">
                      <div className="w-8 h-8 bg-black rounded-sm" />
                      <div className="w-4 h-4 bg-black" />
                      <div className="w-8 h-8 bg-black rounded-sm" />
                    </div>
                    <div className="text-center text-[9px] font-mono font-bold text-black tracking-tight">
                      SCAN IN HEADSET
                    </div>
                    <div className="flex justify-between items-end">
                      <div className="w-8 h-8 bg-black rounded-sm" />
                      <div className="w-4 h-4 bg-black" />
                      <div className="w-8 h-8 bg-black rounded-sm" />
                    </div>
                  </div>
                </div>

                <div className="w-full text-center">
                  <p className="text-[11px] text-aurora-muted font-space">
                    Headset Browser Direct Link:
                  </p>
                  <code className="text-xs font-mono text-aurora-cyan bg-aurora-panel/80 px-2 py-1 rounded block mt-1 truncate border border-aurora-border">
                    {sessionUrl}
                  </code>
                </div>
              </div>

              {/* Step by Step Headset Instructions */}
              <div className="space-y-2 text-xs text-aurora-muted font-sans">
                <div className="flex items-start space-x-2">
                  <CheckCircle className="w-4 h-4 text-aurora-cyan flex-shrink-0 mt-0.5" />
                  <span>
                    <strong>Meta Quest 2/3/Pro:</strong> Put on headset, open Meta Quest Browser, and visit the link or scan code.
                  </span>
                </div>
                <div className="flex items-start space-x-2">
                  <CheckCircle className="w-4 h-4 text-aurora-violet flex-shrink-0 mt-0.5" />
                  <span>
                    <strong>Apple Vision Pro:</strong> Open Safari in visionOS, navigate to the link, and tap "Enter VR" to enter spatial mode.
                  </span>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-3 border-t border-aurora-border/40 bg-aurora-panel/80 flex justify-between items-center text-xs">
          <span className="text-aurora-muted">
            Desktop 3D Orbit Controls are always active in background
          </span>
          <button
            onClick={onClose}
            className="px-3.5 py-1.5 rounded-lg font-space text-xs text-white bg-aurora-surface hover:bg-aurora-surface/80 border border-aurora-border transition-colors"
          >
            Dismiss
          </button>
        </div>
      </div>
    </div>
  );
}
