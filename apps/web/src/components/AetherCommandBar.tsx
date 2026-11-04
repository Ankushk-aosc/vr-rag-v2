"use client";

import React, { useEffect, useRef, useState } from "react";
import { Mic, Send, X, Square, CornerDownLeft, Hand, Loader2 } from "lucide-react";
import { LevelBars } from "./LevelBars";
import { VoiceSettings } from "./VoiceSettings";
import { useVoiceSnapshot } from "../lib/voice/voiceStore";

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
        {voiceOn && voice.phase === "listening" && voice.interim && (
          <button
            type="button"
            onClick={onFinishUtterance}
            className={`h-9 px-3 rounded-md text-[13px] font-medium flex items-center gap-1.5 ${
              isLight ? "bg-slate-100 text-slate-800 hover:bg-slate-200" : "bg-slate-800 text-slate-100"
            }`}
          >
            <CornerDownLeft className="w-3.5 h-3.5" aria-hidden /> Send
          </button>
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
          onTestSpeaker={onTestSpeaker}
        />

        <button
          type="button"
          onClick={onToggleVoice}
          aria-label={voiceOn ? "End voice conversation" : "Ask by voice"}
          aria-pressed={voiceOn}
          title={voiceOn ? "End voice conversation" : "Ask by voice"}
          className={`${iconBtn} ${
            voiceOn
              ? "bg-rose-600 text-white hover:bg-rose-700"
              : isLight
              ? "text-slate-600 hover:bg-slate-100 hover:text-slate-900"
              : "text-slate-300 hover:bg-slate-800"
          }`}
        >
          {voiceOn ? <X className="w-4 h-4" /> : <Mic className="w-4 h-4" />}
        </button>

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

  if (inline) return bar;

  return <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-40 w-full max-w-2xl px-4">{bar}</div>;
}
