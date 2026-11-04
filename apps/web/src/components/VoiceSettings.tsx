"use client";

import React, { useEffect, useRef, useState } from "react";
import { Settings2, Volume2, AlertTriangle } from "lucide-react";
import { canUseBrowserSpeech, useVoiceSnapshot, voiceStore } from "../lib/voice/voiceStore";
import { readSettings, writeSettings } from "../lib/voice/voiceConfig";
import { fetchVoiceOptions, VoiceOptions } from "../lib/api";
import { LevelBars } from "./LevelBars";

interface VoiceSettingsProps {
  theme: "light" | "dark";
  onSetBargeIn: (on: boolean) => void;
  onSetSttMode: (mode: "auto" | "server") => void;
  onSetBrowserSpeechOptIn?: (optIn: boolean) => void;
  onSetWakeWord?: (on: boolean) => void;
  onSetVoice?: (voice: string | null) => void;
  onTestSpeaker: () => void;
  /** Which way the popover opens from the gear button. */
  placement?: "above" | "below";
}

/** "en-AU-NatashaNeural" -> "Natasha · en-AU" */
function voiceLabel(id: string): string {
  const m = /^([a-z]{2}-[A-Z]{2})-(.+?)(Neural)?$/.exec(id);
  return m ? `${m[2]} · ${m[1]}` : id;
}

function browserRecognitionSupported(): boolean {
  if (typeof window === "undefined") return false;
  const w = window as unknown as Record<string, unknown>;
  return Boolean(w.SpeechRecognition || w.webkitSpeechRecognition);
}

/**
 * Gear button + popover: speech recognition choice (Whisper by default, browser recognition only after
 * explicit consent), optional wake word, interruption, and a quick self-check.
 */
export function VoiceSettings({
  theme,
  onSetBargeIn,
  onSetSttMode,
  onSetBrowserSpeechOptIn,
  onSetWakeWord,
  onSetVoice,
  onTestSpeaker,
  placement = "above",
}: VoiceSettingsProps) {
  const [voiceOptions, setVoiceOptions] = useState<VoiceOptions | null>(null);
  const [open, setOpen] = useState(false);
  const [showPrivacyNotice, setShowPrivacyNotice] = useState(false);
  const voice = useVoiceSnapshot();
  const rootRef = useRef<HTMLDivElement | null>(null);
  const isLight = theme === "light";

  const browserSupported = browserRecognitionSupported();
  const serverForbids = voice.serverAllowsBrowserSpeech === false;
  const browserAllowed = canUseBrowserSpeech();
  const usingBrowser = browserAllowed && voice.sttMode === "auto";

  const setOptIn = (optIn: boolean) => {
    if (onSetBrowserSpeechOptIn) {
      onSetBrowserSpeechOptIn(optIn);
    } else {
      voiceStore.set({ browserSpeechOptIn: optIn });
      writeSettings({ ...readSettings(), browserSpeechOptIn: optIn });
    }
  };

  // Voices come from the server's allow-list, so changing the voice never needs a code change
  useEffect(() => {
    if (!open || voiceOptions || !onSetVoice) return;
    const ctrl = new AbortController();
    fetchVoiceOptions(ctrl.signal).then(setVoiceOptions).catch(() => {});
    return () => ctrl.abort();
  }, [open, voiceOptions, onSetVoice]);

  useEffect(() => {
    if (!open) return;
    const close = (e: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
        setShowPrivacyNotice(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        setShowPrivacyNotice(false);
      }
    };
    window.addEventListener("pointerdown", close);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const muted = isLight ? "text-slate-500" : "text-slate-400";
  const divider = isLight ? "border-slate-200" : "border-slate-700";
  const notice = isLight
    ? "bg-amber-50 border-amber-200 text-amber-900"
    : "bg-amber-950/40 border-amber-800 text-amber-200";
  const whisperWhere =
    voice.privacyMode === "cloud"
      ? "Transcribed by this deployment's configured Whisper service."
      : "Transcribed by this deployment's own Whisper service.";

  return (
    <div ref={rootRef} className="relative" data-no-drag>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label="Voice settings"
        aria-expanded={open}
        aria-haspopup="dialog"
        title="Voice settings"
        className={`w-9 h-9 rounded-md flex items-center justify-center transition-colors ${
          isLight ? "text-slate-500 hover:bg-slate-100 hover:text-slate-900" : "text-slate-400 hover:bg-slate-800 hover:text-white"
        }`}
      >
        <Settings2 className="w-4 h-4" />
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="Voice settings"
          className={`absolute right-0 ${placement === "above" ? "bottom-full mb-2" : "top-full mt-2"} w-[min(340px,calc(100vw-32px))] max-h-[70vh] overflow-y-auto rounded-lg border shadow-lg p-4 space-y-4 text-[13px] z-50 text-left ${
            isLight ? "bg-white border-slate-200 text-slate-900" : "bg-[#0F172A] border-slate-700 text-slate-100"
          }`}
        >
          <div className="text-sm font-semibold">Voice settings</div>

          {/* Speech recognition */}
          <fieldset className="space-y-3">
            <legend className="text-xs font-semibold uppercase tracking-wide mb-2 text-slate-500">Speech recognition</legend>

            <label className="flex items-start gap-2.5 cursor-pointer">
              <input
                type="radio"
                name="stt-mode"
                className="mt-1 accent-[#2563EB]"
                checked={!usingBrowser}
                onChange={() => onSetSttMode("server")}
              />
              <span>
                <span className="font-medium">Whisper</span>
                <span className={`ml-1.5 text-xs ${muted}`}>Default</span>
                <span className={`block text-xs mt-0.5 ${muted}`}>{whisperWhere}</span>
              </span>
            </label>

            <label className={`flex items-start gap-2.5 ${browserSupported && !serverForbids ? "cursor-pointer" : "cursor-not-allowed opacity-60"}`}>
              <input
                type="radio"
                name="stt-mode"
                className="mt-1 accent-[#2563EB]"
                disabled={!browserSupported || serverForbids}
                checked={usingBrowser}
                onChange={() => (browserAllowed ? onSetSttMode("auto") : setShowPrivacyNotice(true))}
              />
              <span>
                <span className="font-medium">Browser speech recognition</span>
                <span className={`block text-xs mt-0.5 ${muted}`}>
                  Shows words as you speak. Falls back to Whisper automatically if it fails.
                </span>
              </span>
            </label>

            {!browserSupported && (
              <p className={`text-xs leading-relaxed rounded-md border p-2.5 ${notice}`}>
                Browser speech recognition is unavailable in this browser. Whisper is available instead.
              </p>
            )}
            {browserSupported && serverForbids && (
              <p className={`text-xs leading-relaxed rounded-md border p-2.5 ${notice}`}>
                Browser speech recognition is disabled by this deployment&apos;s privacy policy. Whisper is available instead.
              </p>
            )}

            {showPrivacyNotice && (
              <div className={`rounded-md border p-3 space-y-2 ${notice}`} role="alertdialog" aria-label="Browser speech recognition">
                <div className="text-xs font-semibold flex items-center gap-1.5">
                  <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0" aria-hidden />
                  Browser speech recognition
                </div>
                <p className="text-xs leading-relaxed">
                  Your browser may transmit speech to a third-party speech service depending on browser implementation.
                </p>
                <p className="text-xs leading-relaxed">Whisper remains available as the privacy-focused alternative.</p>
                <div className="flex items-center gap-2 pt-1">
                  <button
                    type="button"
                    onClick={() => {
                      setOptIn(true);
                      onSetSttMode("auto");
                      setShowPrivacyNotice(false);
                    }}
                    className="px-3 py-1.5 text-xs font-medium rounded-md bg-[#2563EB] text-white hover:bg-[#1D4ED8]"
                  >
                    Enable browser recognition
                  </button>
                  <button
                    type="button"
                    onClick={() => setShowPrivacyNotice(false)}
                    className={`px-3 py-1.5 text-xs font-medium rounded-md border ${
                      isLight ? "border-slate-300 bg-white hover:bg-slate-50" : "border-slate-600 hover:bg-slate-800"
                    }`}
                  >
                    Keep Whisper
                  </button>
                </div>
              </div>
            )}

            {browserAllowed && (
              <button
                type="button"
                onClick={() => {
                  setOptIn(false);
                  onSetSttMode("server");
                }}
                className="text-xs font-medium text-rose-600 hover:underline"
              >
                Withdraw browser recognition consent
              </button>
            )}
          </fieldset>

          {/* Wake word: needs browser recognition and keeps the mic open, so it is a separate opt-in */}
          {onSetWakeWord && (
            <label className={`flex items-start justify-between gap-3 pt-3 border-t ${divider} ${browserAllowed ? "cursor-pointer" : "opacity-60 cursor-not-allowed"}`}>
              <span>
                <span className="font-medium">&ldquo;Hey Aether&rdquo; wake word</span>
                <span className={`block text-xs mt-0.5 ${muted}`}>
                  {browserAllowed
                    ? "Keeps the microphone open and listens for the wake word using browser recognition."
                    : "Requires browser speech recognition to be enabled first."}
                </span>
              </span>
              <input
                type="checkbox"
                className="mt-1 accent-[#2563EB]"
                disabled={!browserAllowed}
                checked={browserAllowed && voice.wakeWordEnabled}
                onChange={(e) => onSetWakeWord(e.target.checked)}
              />
            </label>
          )}

          <label className={`flex items-start justify-between gap-3 pt-3 border-t ${divider} cursor-pointer`}>
            <span>
              <span className="font-medium">Interrupt by talking</span>
              <span className={`block text-xs mt-0.5 ${muted}`}>
                Speak over Aether to stop it. Best with headphones.
              </span>
            </span>
            <input
              type="checkbox"
              className="mt-1 accent-[#2563EB]"
              checked={voice.bargeIn}
              onChange={(e) => onSetBargeIn(e.target.checked)}
            />
          </label>

          <dl className={`pt-3 border-t ${divider} space-y-1.5 text-xs`}>
            <div className="flex items-center justify-between gap-3">
              <dt className={muted}>Microphone</dt>
              <dd>{voice.conversation ? <LevelBars source="mic" bars={9} /> : <span className={muted}>Off</span>}</dd>
            </div>
            <div className="flex items-center justify-between gap-3">
              <dt className={muted}>Recogniser in use</dt>
              <dd className="font-medium text-right">
                {voice.conversation ? (voice.sttEngine === "browser" ? "Browser" : "Whisper") : "—"}
              </dd>
            </div>
            {voice.error && <div className="text-rose-600 leading-snug">{voice.error}</div>}
          </dl>

          {onSetVoice && voiceOptions && voiceOptions.voices.length > 0 && (
            <label className={`block pt-3 border-t ${divider}`}>
              <span className="font-medium">Assistant voice</span>
              <select
                value={voice.ttsVoice ?? voiceOptions.default}
                onChange={(e) => onSetVoice(e.target.value === voiceOptions.default ? null : e.target.value)}
                className={`mt-1 block w-full h-9 rounded-md border px-2 text-[13px] ${
                  isLight ? "bg-white border-slate-300" : "bg-slate-900 border-slate-700"
                }`}
              >
                {voiceOptions.voices.map((v) => (
                  <option key={v} value={v}>
                    {voiceLabel(v)}
                    {v === voiceOptions.default ? " (default)" : ""}
                  </option>
                ))}
              </select>
            </label>
          )}

          <button
            type="button"
            onClick={onTestSpeaker}
            className={`w-full flex items-center justify-center gap-1.5 py-2 rounded-md border text-xs font-medium ${
              isLight ? "border-slate-300 hover:bg-slate-50" : "border-slate-600 hover:bg-slate-800"
            }`}
          >
            <Volume2 className="w-3.5 h-3.5" aria-hidden /> Test speaker
          </button>
        </div>
      )}
    </div>
  );
}
