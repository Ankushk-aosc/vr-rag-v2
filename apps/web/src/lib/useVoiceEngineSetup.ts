"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ChatMessage } from "../types";
import { VoiceEngine } from "./voice/VoiceEngine";
import { useVoiceSnapshot, voiceStore } from "./voice/voiceStore";

interface UseVoiceEngineSetupProps {
  engineRef: React.MutableRefObject<VoiceEngine | null>;
  runQuery: (text: string, mode: "text" | "voice") => void;
  setIsDialogueOpen: React.Dispatch<React.SetStateAction<boolean>>;
  abortRef: React.MutableRefObject<AbortController | null>;
  setIsProcessing: React.Dispatch<React.SetStateAction<boolean>>;
  enabled?: boolean;
}

export function useVoiceEngineSetup({
  engineRef,
  runQuery,
  setIsDialogueOpen,
  abortRef,
  setIsProcessing,
  enabled = true,
}: UseVoiceEngineSetupProps) {
  const [speakingMessageId, setSpeakingMessageId] = useState<string | null>(null);
  const voice = useVoiceSnapshot();
  const runQueryRef = useRef(runQuery);
  runQueryRef.current = runQuery;

  useEffect(() => {
    if (!enabled) return;

    const engine = new VoiceEngine({
      onUtterance: (text) => runQueryRef.current(text, "voice"),
      onInterrupt: () => {
        abortRef.current?.abort();
        abortRef.current = null;
        setIsProcessing(false);
      },
    });
    engineRef.current = engine;

    engine.startStandby().catch(() => {});

    const onUserGesture = () => {
      engine.unlockAudio();
    };
    window.addEventListener("pointerdown", onUserGesture, { once: true });
    window.addEventListener("keydown", onUserGesture, { once: true });

    return () => {
      window.removeEventListener("pointerdown", onUserGesture);
      window.removeEventListener("keydown", onUserGesture);
      engine.dispose();
      engineRef.current = null;
    };
  }, [abortRef, setIsProcessing, enabled]);

  useEffect(() => {
    if (voice.wakeWordDetected) {
      setIsDialogueOpen(true);
    }
  }, [voice.wakeWordDetected, setIsDialogueOpen]);

  const toggleVoice = useCallback(() => {
    const engine = engineRef.current;
    if (!engine) return;
    if (!engine.inConversation) {
      setIsDialogueOpen(true);
      abortRef.current?.abort();
    }
    engine.toggleConversation();
  }, [abortRef, setIsDialogueOpen]);

  const handleOrbTap = useCallback(() => {
    const engine = engineRef.current;
    if (!engine) return;
    const { conversation, phase } = voiceStore.get();
    if (!conversation) return toggleVoice();
    if (phase === "speaking") return engine.interrupt("orb");
    engine.endConversation("orb");
  }, [toggleVoice]);

  const handleSpeakMessage = useCallback((msg: ChatMessage) => {
    setSpeakingMessageId(msg.id);
    engineRef.current?.speakText(msg.content);
  }, []);

  useEffect(() => {
    if (!voice.readingAloud && voice.phase !== "speaking") {
      setSpeakingMessageId(null);
    }
  }, [voice.readingAloud, voice.phase]);

  return {
    engineRef,
    speakingMessageId,
    toggleVoice,
    handleOrbTap,
    handleSpeakMessage,
  };
}
