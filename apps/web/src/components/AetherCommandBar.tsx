"use client";

import React, { useEffect, useRef, useState } from "react";
import { Mic, Send, X, Square, CornerDownLeft, Hand, Loader2, Headphones, RotateCcw } from "lucide-react";
import { LevelBars } from "./LevelBars";
import { VoiceSettings } from "./VoiceSettings";
import { useVoiceSnapshot } from "../lib/voice/voiceStore";
import { Dictation, DictationSnapshot } from "../lib/voice/dictation";
import { transcribeAudio } from "../lib/api";
import { vlog } from "../lib/voice/voiceLog";

export interface AetherCommandBarProps {
  onSendMessage: (text: string) => void;
  onStopGenerating: () => void;
  isProcessing: boolean;
  hasMessages: boolean;
  onToggleDialogue: () => void;
  isDialogueOpen: boolean;
  theme?: "dark" | "light";
  prompts?: string[];
  onToggleVoice: () => void;
  /** End the user's turn now instead of waiting for the silence timeout. */
  onFinishUtterance: () => void;
  /** Stop the assistant talking and take the turn. */
  onInterrupt: () => void;
  onSetBargeIn: (on: boolean) => void;
  onSetSttMode: (mode: "auto" | "server") => void;
  onSetBrowserSpeechOptIn?: (optIn: boolean) => void;
  onSetWakeWord?: (on: boolean) => void;
  onSetVoice?: (voice: string | null) => void;
  onTestSpeaker: () => void;
  /** "floating": docked at the bottom of the viewport. "inline": part of the page (dashboard). */
  variant?: "floating" | "inline";
  autoFocus?: boolean;
}

export function AetherCommandBar({
  onSendMessage,
  onStopGenerating,
  isProcessing,
  theme = "light",
  onToggleVoice,
  onFinishUtterance,
  onInterrupt,
  onSetBargeIn,
  onSetSttMode,
  onSetBrowserSpeechOptIn,
  onSetWakeWord,
  onSetVoice,
  onTestSpeaker,
  variant = "floating",
  autoFocus = false,
}: AetherCommandBarProps) {
  const [inputText, setInputText] = useState("");
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const voice = useVoiceSnapshot();
  const isLight = theme === "light";
  const voiceOn = voice.conversation;
  const inline = variant === "inline";

  // Push-to-talk dictation: the transcript goes into the box for the user to edit; nothing is auto-sent
  const dictationRef = useRef<Dictation | null>(null);
  const [dict, setDict] = useState<DictationSnapshot>({ state: "ready", message: null, transcript: "", startedAt: null });
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    const d = new Dictation({ transcribe: (blob, signal) => transcribeAudio(blob, signal), log: vlog });
    dictationRef.current = d;
    const off = d.subscribe(setDict);
    return () => {
      off();
      d.dispose(); // never leave a microphone track or recorder running
      dictationRef.current = null;
    };
  }, []);
  useEffect(() => {
    if (dict.state !== "recording" || !dict.startedAt) return;
    setElapsed(0);
    const t = setInterval(() => setElapsed(Date.now() - (dict.startedAt ?? Date.now())), 250);
    return () => clearInterval(t);
  }, [dict.state, dict.startedAt]);
  useEffect(() => {
    if (dict.state !== "completed" || !dict.transcript) return;
    setInputText((prev) => (prev.trim() ? `${prev.trimEnd()} ${dict.transcript}` : dict.transcript));
    dictationRef.current?.reset();
    requestAnimationFrame(() => inputRef.current?.focus());
  }, [dict.state, dict.transcript]);
  const recording = dict.state === "recording";
  const dictBusy = ["requesting", "recording", "processing", "transcribing"].includes(dict.state);
  const toggleDictation = () => {
    const d = dictationRef.current;
    if (!d) return;
    if (d.snapshot.state === "recording") void d.stop();
    else if (!d.busy) void d.start();
  };
  const mmss = (ms: number) => `${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, "0")}`;

  useEffect(() => {
    if (autoFocus) inputRef.current?.focus();
  }, [autoFocus]);

  // Grow with the text up to a few lines
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, inline ? 160 : 120)}px`;
  }, [inputText, inline]);

  // Set synchronously so two Enter presses in the same frame (before isProcessing re-renders) send once
  const submittingRef = useRef(false);
  const submit = () => {
    const text = inputText.trim();
    if (!text || isProcessing || submittingRef.current) return;
    submittingRef.current = true;
    setTimeout(() => (submittingRef.current = false), 300);
    onSendMessage(text);
    setInputText("");
  };

  const muted = isLight ? "text-slate-500" : "text-slate-400";

  const voiceStatus = () => {
    switch (voice.phase) {
      case "listening": {
        const switching = !!voice.statusText?.includes("Switching to Whisper");
        const text = switching
          ? "Browser recognition failed. Switching to Whisper…"
          : voice.interim
          ? `“${voice.interim}”`
          : "Listening…";
        return (
          <>
            <LevelBars source="mic" bars={7} />
            <span className={`text-[14px] truncate ${voice.interim ? (isLight ? "text-slate-900" : "text-white") : muted}`}>{text}</span>
            <span className={`hidden md:inline text-[12px] flex-shrink-0 ${muted}`}>
              {switching || voice.sttEngine !== "browser" ? "Whisper" : "Browser"}
            </span>
          </>
        );
      }
      case "transcribing":
        return (
          <>
            <Loader2 className="w-4 h-4 animate-spin text-blue-600" aria-hidden />
            <span className={`text-[14px] ${muted}`}>Transcribing…</span>
          </>
        );
      case "thinking":
        return (
          <>
            <Loader2 className="w-4 h-4 animate-spin text-blue-600" aria-hidden />
            <span className={`text-[14px] ${muted}`}>Searching authorised records…</span>
          </>
        );
      case "speaking":
        return (
          <>
            <LevelBars source="output" bars={7} />
            <span className={`text-[14px] ${muted}`}>Speaking…</span>
          </>
        );
      default:
        return <span className={`text-[14px] ${muted}`}>{voice.error || "Starting microphone…"}</span>;
    }
  };

  const iconBtn = "w-9 h-9 rounded-md flex items-center justify-center flex-shrink-0 transition-colors";

  const bar = (
    <div
      className={`w-full flex items-end gap-1.5 p-2 rounded-lg border ${
        isLight ? "bg-white border-slate-300 text-slate-900" : "bg-[#0F172A] border-slate-700 text-white"
      } ${inline ? "shadow-sm focus-within:border-blue-500 focus-within:ring-2 focus-within:ring-blue-100" : "shadow-lg"}`}
    >
      {voiceOn ? (
        <div className="flex-1 flex items-center gap-3 px-2 min-h-[36px] min-w-0" role="status" aria-live="polite">
          {voiceStatus()}
        </div>
      ) : (
        <form
          className="flex-1 min-w-0"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <label htmlFor={`ask-aether-${variant}`} className="sr-only">
            Ask Aether
          </label>
          <textarea
            id={`ask-aether-${variant}`}
            ref={inputRef}
            rows={1}
            value={inputText}
            onChange={(e) => setInputText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                submit();
              }
            }}
            placeholder="What would you like to understand?"
            className={`block w-full resize-none bg-transparent px-2 py-2 text-[14px] leading-5 focus:outline-none ${
              isLight ? "placeholder-slate-400" : "placeholder-slate-500"
            }`}
          />
        </form>
      )}

      <div className="flex items-center gap-1 flex-shrink-0">
        {voiceOn && voice.phase === "listening" && (
          // Always available: ends the turn even when voice detection or live words never fire
          <button
            type="button"
            onClick={onFinishUtterance}
            className={`h-9 px-3 rounded-md text-[13px] font-medium flex items-center gap-1.5 ${
              isLight ? "bg-slate-100 text-slate-800 hover:bg-slate-200" : "bg-slate-800 text-slate-100"
            }`}
          >
            <CornerDownLeft className="w-3.5 h-3.5" aria-hidden /> Done speaking
          </button>
        )}
        {!voiceOn && recording && (
          <>
            <span className={`text-[12px] tabular-nums px-1 ${isLight ? "text-rose-700" : "text-rose-300"}`} aria-hidden>
              <span className="inline-block w-2 h-2 rounded-full bg-rose-600 mr-1.5 align-middle" />
              {mmss(elapsed)}
            </span>
            <button
              type="button"
              onClick={() => dictationRef.current?.cancel()}
              className={`h-9 px-2.5 rounded-md text-[13px] font-medium ${isLight ? "text-slate-600 hover:bg-slate-100" : "text-slate-300 hover:bg-slate-800"}`}
            >
              Cancel
            </button>
          </>
        )}
        {voiceOn && voice.phase === "speaking" && (
          <button
            type="button"
            onClick={onInterrupt}
            className={`h-9 px-3 rounded-md text-[13px] font-medium flex items-center gap-1.5 ${
              isLight ? "bg-slate-100 text-slate-800 hover:bg-slate-200" : "bg-slate-800 text-slate-100"
            }`}
          >
            <Hand className="w-3.5 h-3.5" aria-hidden /> Interrupt
          </button>
        )}

        <VoiceSettings
          theme={theme}
          placement={inline ? "below" : "above"}
          onSetBargeIn={onSetBargeIn}
          onSetSttMode={onSetSttMode}
          onSetBrowserSpeechOptIn={onSetBrowserSpeechOptIn}
          onSetWakeWord={onSetWakeWord}
          onSetVoice={onSetVoice}
          onTestSpeaker={onTestSpeaker}
        />

        {!dictBusy && (
          <button
            type="button"
            onClick={onToggleVoice}
            aria-label={voiceOn ? "End voice conversation" : "Start hands-free voice conversation"}
            aria-pressed={voiceOn}
            title={voiceOn ? "End voice conversation" : "Hands-free voice conversation"}
            className={`${iconBtn} ${
              voiceOn
                ? "bg-rose-600 text-white hover:bg-rose-700"
                : isLight
                ? "text-slate-600 hover:bg-slate-100 hover:text-slate-900"
                : "text-slate-300 hover:bg-slate-800"
            }`}
          >
            {voiceOn ? <X className="w-4 h-4" /> : <Headphones className="w-4 h-4" />}
          </button>
        )}

        {!voiceOn && (
          <button
            type="button"
            onClick={toggleDictation}
            disabled={dict.state === "requesting" || dict.state === "processing" || dict.state === "transcribing"}
            aria-label={recording ? "Stop recording and transcribe" : "Dictate your question"}
            aria-pressed={recording}
            title={recording ? "Stop recording" : "Dictate (click again to stop)"}
            className={`${iconBtn} disabled:opacity-60 ${
              recording
                ? "bg-rose-600 text-white hover:bg-rose-700"
                : isLight
                ? "text-slate-600 hover:bg-slate-100 hover:text-slate-900"
                : "text-slate-300 hover:bg-slate-800"
            }`}
          >
            {recording ? (
              <Square className="w-3.5 h-3.5 fill-current" />
            ) : dictBusy ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <Mic className="w-4 h-4" />
            )}
          </button>
        )}

        {!voiceOn &&
          (isProcessing ? (
            <button
              type="button"
              onClick={onStopGenerating}
              aria-label="Stop generating"
              title="Stop generating"
              className={`${iconBtn} border ${isLight ? "border-slate-300 text-slate-700 hover:bg-slate-100" : "border-slate-600 text-slate-200 hover:bg-slate-800"}`}
            >
              <Square className="w-3.5 h-3.5 fill-current" />
            </button>
          ) : (
            <button
              type="button"
              onClick={submit}
              disabled={!inputText.trim()}
              aria-label="Send question"
              className={`${iconBtn} ${
                inputText.trim()
                  ? "bg-[#2563EB] text-white hover:bg-[#1D4ED8]"
                  : isLight
                  ? "bg-slate-100 text-slate-400 cursor-not-allowed"
                  : "bg-slate-800 text-slate-600 cursor-not-allowed"
              }`}
            >
              <Send className="w-4 h-4" />
            </button>
          ))}
      </div>
    </div>
  );

  const statusText =
    !voiceOn && dict.state === "requesting"
      ? "Requesting microphone permission…"
      : !voiceOn && dict.state === "recording"
      ? "Recording. Click the stop button when you have finished."
      : !voiceOn && dict.state === "processing"
      ? "Processing voice…"
      : !voiceOn && dict.state === "transcribing"
      ? "Transcribing…"
      : !voiceOn && dict.state === "error"
      ? dict.message
      : voiceOn
      ? voice.error || voice.statusText || null
      : null;
  const isError = (!voiceOn && dict.state === "error") || (voiceOn && !!voice.error);
  const status = (
    <div role="status" aria-live="polite" className="min-h-[1.25rem] mt-1.5 px-1 flex items-center gap-2 text-[12px]">
      {statusText && (
        <>
          <span className={isError ? (isLight ? "text-rose-700" : "text-rose-300") : muted}>{statusText}</span>
          {!voiceOn && dict.state === "error" && (
            <button
              type="button"
              onClick={() => {
                dictationRef.current?.reset();
                void dictationRef.current?.start();
              }}
              className="inline-flex items-center gap-1 font-medium text-blue-700 dark:text-blue-400 hover:underline"
            >
              <RotateCcw className="w-3 h-3" aria-hidden /> Try again
            </button>
          )}
        </>
      )}
    </div>
  );

  if (inline)
    return (
      <div>
        {bar}
        {status}
      </div>
    );

  return (
    <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-40 w-full max-w-2xl px-4">
      {bar}
      {statusText && <div className={`mt-1 rounded-md px-2 ${isLight ? "bg-white/95" : "bg-[#0F172A]/95"}`}>{status}</div>}
    </div>
  );
}
