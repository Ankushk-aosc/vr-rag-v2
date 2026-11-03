"use client";

import React, { useEffect, useRef, useState } from "react";
import { Settings2, Volume2 } from "lucide-react";
import { useVoiceSnapshot } from "../lib/voice/voiceStore";
import { LevelBars } from "./LevelBars";

interface VoiceSettingsProps {
  theme: "light" | "dark";
  onSetBargeIn: (on: boolean) => void;
  onSetSttMode: (mode: "auto" | "server") => void;
  onTestSpeaker: () => void;
}

/** Gear button + popover: voice options and a quick self-check (mic level, recogniser, speaker test). */
export function VoiceSettings({ theme, onSetBargeIn, onSetSttMode, onTestSpeaker }: VoiceSettingsProps) {
  const [open, setOpen] = useState(false);
  const voice = useVoiceSnapshot();
  const rootRef = useRef<HTMLDivElement | null>(null);
  const isLight = theme === "light";
  // Browser recognition sends audio to the browser vendor's cloud; only offered in cloud mode (I-26)
  const browserSttAllowed = voice.privacyMode === "cloud";

  useEffect(() => {
    if (!open) return;
    const close = (e: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("pointerdown", close);
    return () => window.removeEventListener("pointerdown", close);
  }, [open]);

  const row = "flex items-start justify-between gap-3";
  const muted = isLight ? "text-black/50" : "text-white/50";

  return (
    <div ref={rootRef} className="relative" data-no-drag>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label="Voice settings"
        title="Voice settings & test"
        className={`w-9 h-9 rounded-full flex items-center justify-center transition-colors ${
          isLight ? "text-black/55 hover:bg-black/5" : "text-white/60 hover:bg-white/10"
        }`}
      >
        <Settings2 className="w-4 h-4" />
      </button>
      {open && (
        <div
          role="dialog"
          aria-label="Voice settings"
          className={`absolute bottom-full right-0 mb-3 w-[300px] rounded-2xl border shadow-2xl p-3.5 space-y-3 text-[12px] z-50 ${
            isLight ? "bg-white border-black/10 text-black" : "bg-[#16161C] border-white/15 text-white"
          }`}
        >
          <div className="font-semibold text-[12.5px]">Voice</div>

          <label className={`${row} cursor-pointer`}>
            <span>
              Interrupt by talking
              <span className={`block text-[10.5px] ${muted}`}>
                Talk over the assistant to stop it. Best with headphones — laptop speakers can trigger it.
              </span>
            </span>
            <input
              type="checkbox"
              className="mt-1 accent-[#7C3AED]"
              checked={voice.bargeIn}
              onChange={(e) => onSetBargeIn(e.target.checked)}
            />
          </label>

          <div>
            <div className="mb-1">Speech recognition</div>
            {!browserSttAllowed && (
              <div className={`mb-1 text-[10.5px] leading-snug ${muted}`}>
                Private mode: speech is transcribed only by this deployment&apos;s own Whisper. Browser
                recognition and the &ldquo;Hey Aether&rdquo; wake word are off because browsers such as Chrome
                send that audio to their own cloud.
              </div>
            )}
            {(
              [
                ["auto", "Browser, with Whisper fallback", "Live words while you talk (Chrome / Edge)."],
                ["server", "Whisper only", "Use if the browser mishears or shows no words."],
              ] as const
            ).map(([mode, label, hint]) => (
              <label
                key={mode}
                className={`flex items-start gap-2 py-0.5 ${mode === "auto" && !browserSttAllowed ? "opacity-50 cursor-not-allowed" : "cursor-pointer"}`}
              >
                <input
                  type="radio"
                  name="stt-mode"
                  className="mt-1 accent-[#7C3AED]"
                  disabled={mode === "auto" && !browserSttAllowed}
                  checked={browserSttAllowed ? voice.sttMode === mode : mode === "server"}
                  onChange={() => onSetSttMode(mode)}
                />
                <span>
                  {label}
                  <span className={`block text-[10.5px] ${muted}`}>{hint}</span>
                </span>
              </label>
            ))}
          </div>

          <div className={`rounded-xl border p-2.5 space-y-1.5 ${isLight ? "border-black/10 bg-black/[0.02]" : "border-white/10 bg-white/[0.03]"}`}>
            <div className={row}>
              <span className={muted}>Microphone</span>
              {voice.conversation ? <LevelBars source="mic" bars={9} /> : <span className={muted}>off (start voice mode)</span>}
            </div>
            <div className={row}>
              <span className={muted}>Recogniser in use</span>
              <span>{voice.conversation ? (voice.sttEngine === "browser" ? "Browser" : "Whisper (server)") : "—"}</span>
            </div>
            {voice.error && <div className="text-red-500 text-[11px] leading-snug">{voice.error}</div>}
          </div>

          <button
            type="button"
            onClick={onTestSpeaker}
            className={`w-full flex items-center justify-center gap-1.5 py-2 rounded-xl font-semibold ${
              isLight ? "bg-[#6D28D9]/10 text-[#5B21B6] hover:bg-[#6D28D9]/15" : "bg-[#7C3AED]/20 text-[#DDD6FE] hover:bg-[#7C3AED]/30"
            }`}
          >
            <Volume2 className="w-3.5 h-3.5" /> Test speaker
          </button>
        </div>
      )}
    </div>
  );
}
