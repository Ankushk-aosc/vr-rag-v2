"use client";

import React, { useRef, useState } from "react";
import { Mic, Send, Sparkles, ArrowUpRight, X, Square, Loader2, CornerDownLeft, Hand } from "lucide-react";
import { FloatingPanel } from "./FloatingPanel";
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
  onTestSpeaker: () => void;
}

const DEFAULT_PROMPTS = [
  "AAPL closing price & volume on 2020-04-01",
  "What happened on the next trading day?",
  "Summarise the AAPL records archive",
];

export function AetherCommandBar({
  onSendMessage,
  onStopGenerating,
  isProcessing,
  hasMessages,
  onToggleDialogue,
  isDialogueOpen,
  theme = "light",
  prompts,
  onToggleVoice,
  onFinishUtterance,
  onInterrupt,
  onSetBargeIn,
  onSetSttMode,
  onTestSpeaker,
}: AetherCommandBarProps) {
  const [inputText, setInputText] = useState("");
  const inputRef = useRef<HTMLInputElement | null>(null);
  const voice = useVoiceSnapshot();
  const isLight = theme === "light";
  const quickPrompts = prompts && prompts.length > 0 ? prompts : DEFAULT_PROMPTS;
  const voiceOn = voice.conversation;

  const handleSubmit = (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!inputText.trim() || isProcessing) return;
    onSendMessage(inputText.trim());
    setInputText("");
  };

  const muted = isLight ? "text-black/55" : "text-white/55";

  const voiceCenter = () => {
    switch (voice.phase) {
      case "listening":
        return (
          <div className="flex-1 flex items-center gap-3 px-3 min-w-0">
            <LevelBars source="mic" bars={7} />
            <span className={`text-[13px] truncate ${voice.interim ? (isLight ? "text-[#4C1D95]" : "text-[#DDD6FE]") : muted}`}>
              {voice.interim ? `“${voice.interim}”` : "Listening… just start talking"}
            </span>
            <span className={`hidden md:inline text-[10px] flex-shrink-0 ${muted}`}>
              {voice.sttEngine === "browser" ? "browser STT" : "Whisper"}
            </span>
          </div>
        );
      case "transcribing":
        return (
          <div className={`flex-1 flex items-center gap-2 px-3 text-[13px] ${muted}`}>
            <Loader2 className="w-3.5 h-3.5 animate-spin" /> Transcribing…
          </div>
        );
      case "thinking":
        return (
          <div className={`flex-1 flex items-center gap-2 px-3 text-[13px] min-w-0 ${muted}`}>
            <Sparkles className="w-3.5 h-3.5 animate-pulse text-[#8B5CF6] flex-shrink-0" />
            <span className="truncate">Thinking about “{voice.interim}”</span>
          </div>
        );
      case "speaking":
        return (
          <div className={`flex-1 flex items-center gap-3 px-3 text-[13px] ${muted}`}>
            <LevelBars source="output" bars={7} />
            <span className="truncate">{voice.bargeIn ? "Speaking — talk to interrupt" : "Speaking — press Interrupt to stop"}</span>
          </div>
        );
      default:
        return <div className={`flex-1 px-3 text-[13px] ${muted}`}>Starting microphone…</div>;
    }
  };

  return (
    <FloatingPanel
      id="command-bar"
      theme={theme}
      resize="x"
      showGrip
      minW={340}
      minH={56}
      ariaLabel="Command bar"
      defaultRect={(vw, vh) => {
        const w = Math.min(672, vw - 32);
        return { x: (vw - w) / 2, y: vh - (hasMessages ? 88 : 132), w, h: 56 };
      }}
    >
      <div className="relative w-full flex flex-col items-center">
        {!voiceOn && !hasMessages && (
          <div className="absolute bottom-full mb-3 w-full flex flex-wrap items-center justify-center gap-2">
            {quickPrompts.map((prompt, idx) => (
              <button
                key={idx}
                onClick={() => {
                  setInputText(prompt);
                  inputRef.current?.focus();
                }}
                className={`text-[11px] px-3.5 py-1.5 rounded-full border transition-all shadow-md flex items-center space-x-1.5 ${
                  isLight
                    ? "bg-white hover:bg-white text-black/75 hover:text-black border-black/10"
                    : "bg-[#16161C] hover:bg-[#1C1C24] text-white/70 hover:text-white border-white/10"
                }`}
              >
                <span>{prompt}</span>
                <ArrowUpRight className={`w-3 h-3 ${isLight ? "text-[#6D28D9]" : "text-[#A78BFA]"}`} />
              </button>
            ))}
          </div>
        )}

        <div className="relative w-full group">
          <div
            className={`absolute -inset-1 rounded-full blur-xl transition-all duration-700 pointer-events-none ${
              voiceOn
                ? "opacity-70 aether-wave-gradient"
                : isProcessing
                ? "opacity-50 bg-gradient-to-r from-[#6D28D9] via-[#8B5CF6] to-[#D4AF37] animate-pulse"
                : "opacity-0"
            }`}
          />
          <div
            data-drag-handle
            className={`relative z-10 w-full flex items-center px-2.5 py-2 rounded-full border transition-colors ${
              isLight ? "bg-white border-black/10 shadow-lg text-black" : "bg-[#16161C] border-white/15 shadow-2xl text-white"
            }`}
          >
            <button
              type="button"
              onClick={onToggleVoice}
              aria-label={voiceOn ? "End voice conversation" : "Start voice conversation"}
              title={voiceOn ? "End voice mode" : "Voice mode — talk hands-free, like ChatGPT/Claude voice"}
              className={`w-10 h-10 rounded-full flex items-center justify-center transition-all flex-shrink-0 ${
                voiceOn
                  ? "bg-red-500 text-white shadow-md"
                  : isLight
                  ? "bg-[#6D28D9]/10 hover:bg-[#6D28D9]/20 text-[#6D28D9] hover:scale-105"
                  : "bg-white/10 hover:bg-white/15 text-[#A78BFA] hover:scale-105"
              }`}
            >
              {voiceOn ? <X className="w-4 h-4" /> : <Mic className="w-4 h-4" />}
            </button>

            {voiceOn ? (
              voiceCenter()
            ) : (
              <form onSubmit={handleSubmit} className="flex-1 flex items-center px-3">
                <input
                  ref={inputRef}
                  type="text"
                  value={inputText}
                  onChange={(e) => setInputText(e.target.value)}
                  placeholder="Ask about your financial documents…"
                  className={`w-full bg-transparent text-sm focus:outline-none ${
                    isLight ? "text-black placeholder-black/40" : "text-white placeholder-white/40"
                  }`}
                />
              </form>
            )}

            <div className="flex items-center gap-2 flex-shrink-0">
              <VoiceSettings
                theme={theme}
                onSetBargeIn={onSetBargeIn}
                onSetSttMode={onSetSttMode}
                onTestSpeaker={onTestSpeaker}
              />
              {voiceOn && voice.phase === "listening" && voice.interim && (
                <button
                  type="button"
                  onClick={onFinishUtterance}
                  title="Send now"
                  className={`px-3 py-1.5 rounded-full text-xs font-semibold flex items-center gap-1 ${
                    isLight ? "bg-[#6D28D9]/10 text-[#6D28D9]" : "bg-[#7C3AED]/20 text-[#C4B5FD]"
                  }`}
                >
                  <CornerDownLeft className="w-3 h-3" /> Send
                </button>
              )}
              {voiceOn && voice.phase === "speaking" && (
                <button
                  type="button"
                  onClick={onInterrupt}
                  title="Interrupt and speak"
                  className={`px-3 py-1.5 rounded-full text-xs font-semibold flex items-center gap-1 ${
                    isLight ? "bg-black/5 text-black/70" : "bg-white/10 text-white/80"
                  }`}
                >
                  <Hand className="w-3 h-3" /> Interrupt
                </button>
              )}
              {!voiceOn &&
                (isProcessing ? (
                  <button
                    type="button"
                    onClick={onStopGenerating}
                    aria-label="Stop generating"
                    title="Stop generating"
                    className={`w-9 h-9 rounded-full flex items-center justify-center ${
                      isLight ? "bg-black text-white" : "bg-white text-black"
                    }`}
                  >
                    <Square className="w-3 h-3 fill-current" />
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={() => handleSubmit()}
                    disabled={!inputText.trim()}
                    aria-label="Submit inquiry"
                    className={`w-9 h-9 rounded-full flex items-center justify-center transition-all active:scale-95 shadow-md ${
                      isLight
                        ? "bg-[#581C87] text-white hover:bg-[#4C1D95] disabled:opacity-30"
                        : "bg-white text-black hover:bg-white/90 disabled:opacity-30"
                    }`}
                  >
                    <Send className="w-4 h-4" />
                  </button>
                ))}
              {hasMessages && (
                <button
                  type="button"
                  onClick={onToggleDialogue}
                  className={`hidden sm:block px-3 py-1.5 rounded-full text-xs font-medium border transition-all ${
                    isDialogueOpen
                      ? isLight
                        ? "bg-[#6D28D9]/15 text-[#6D28D9] border-[#6D28D9]/30"
                        : "bg-[#7C3AED]/20 text-[#A78BFA] border-[#7C3AED]/40"
                      : isLight
                      ? "bg-black/5 hover:bg-black/10 text-black/80 border-black/10"
                      : "bg-white/5 hover:bg-white/10 text-white/80 border-white/10"
                  }`}
                >
                  {isDialogueOpen ? "Hide" : "Show"} Dialogue
                </button>
              )}
            </div>
          </div>
        </div>
        {voice.error && (
          <p className="absolute top-full mt-2 text-[11px] px-3 py-1 rounded-full bg-red-500/10 text-red-600 border border-red-500/30 max-w-full truncate">
            {voice.error}
          </p>
        )}
      </div>
    </FloatingPanel>
  );
}
