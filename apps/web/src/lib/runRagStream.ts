import React from "react";
import { ChatMessage, CitationItem, ThinkingStage } from "../types";
import { streamQuery, StreamEvent } from "./api";
import { friendlyError } from "./apiErrors";
import { buildHistory, now } from "./chatHelpers";
import { VoiceEngine } from "./voice/VoiceEngine";

interface RunRagStreamOptions {
  text: string;
  mode: "text" | "voice";
  entityId: string;
  /** Conversation so far, for follow-up context. */
  messages: ChatMessage[];
  engine: VoiceEngine | null;
  abortRef: React.MutableRefObject<AbortController | null>;
  setMessages: React.Dispatch<React.SetStateAction<ChatMessage[]>>;
  setIsProcessing: (v: boolean) => void;
  onSessionExpired: () => void;
}

/**
 * Ask one question over POST /api/query/stream and fold the SSE events into the conversation.
 * A new question aborts the previous stream, so there is never more than one open connection;
 * aborting (Stop, sign-out, entity switch) closes it immediately.
 */
export async function runRagStream({
  text,
  mode,
  entityId,
  messages,
  engine,
  abortRef,
  setMessages,
  setIsProcessing,
  onSessionExpired,
}: RunRagStreamOptions): Promise<void> {
  abortRef.current?.abort();
  const controller = new AbortController();
  abortRef.current = controller;
  const speak = mode === "voice" && !!engine?.inConversation;

  const history = buildHistory(messages);
  const astId = `ast-${Date.now()}`;
  setMessages((prev) => [
    ...prev.map((m) => (m.streaming ? { ...m, streaming: false } : m)),
    { id: `user-${Date.now()}`, sender: "user", content: text, timestamp: now(), mode },
    {
      id: astId,
      sender: "assistant",
      content: "",
      timestamp: now(),
      streaming: true,
      thinking_trace: [],
      reasoning: "",
      mode,
    },
  ]);
  setIsProcessing(true);
  if (speak) engine!.beginResponse();

  // Tokens arrive far faster than React should re-render; batch them every ~50ms.
  const buf = { answer: "", stages: [] as ThinkingStage[], sources: [] as CitationItem[] };
  let timer: ReturnType<typeof setTimeout> | null = null;
  const flush = () => {
    timer = null;
    const snapshot = { content: buf.answer, thinking_trace: [...buf.stages], sources: buf.sources };
    setMessages((prev) => prev.map((m) => (m.id === astId ? { ...m, ...snapshot } : m)));
  };
  const schedule = () => {
    if (!timer) timer = setTimeout(flush, 50);
  };

  let final: Extract<StreamEvent, { type: "done" }> | null = null;
  let failure: string | null = null;
  try {
    await streamQuery(
      { question: text, entityId, history, mode },
      (ev) => {
        switch (ev.type) {
          case "stage": {
            // Pipelines report "active" or "running" while a step is in flight; anything not done is in progress
            const stage: ThinkingStage = {
              id: ev.id ?? ev.stage,
              title: ev.title,
              status: ev.status === "done" ? "done" : "active",
              details: ev.detail,
              duration_ms: ev.duration_ms,
            };
            const i = buf.stages.findIndex((s) => s.id === stage.id);
            if (i >= 0) buf.stages[i] = stage;
            else buf.stages.push(stage);
            break;
          }
          case "sources":
            buf.sources = ev.citations;
            break;
          case "answer":
            buf.answer += ev.delta;
            if (speak) engine!.pushResponseText(ev.delta);
            break;
          case "done":
            final = ev;
            break;
          case "error":
            failure = ev.message;
            break;
        }
        schedule();
      },
      controller.signal
    );
  } catch (err) {
    if ((err as Error)?.name !== "AbortError") {
      const friendly = friendlyError(err, "answer that question");
      failure = `${friendly.title}. ${friendly.body}`;
      if (friendly.sessionExpired) setTimeout(onSessionExpired, 1500);
    }
  } finally {
    if (timer) clearTimeout(timer);
  }

  const aborted = controller.signal.aborted;
  const done = final as Extract<StreamEvent, { type: "done" }> | null;
  setMessages((prev) => {
    const next = prev.map((m) => {
      if (m.id !== astId) return m;
      if (done) {
        return {
          ...m,
          content: done.answer,
          structured_data: done.structured_data,
          thinking_trace: done.thinking_trace.map((s, i) => ({ ...s, id: buf.stages[i]?.id })),
          citations: done.citations,
          sources: buf.sources,
          grounded: done.grounded,
          total_latency_ms: done.total_latency_ms,
          streaming: false,
        };
      }
      return {
        ...m,
        content: buf.answer || (aborted ? "_Stopped._" : ""),
        thinking_trace: buf.stages.map((s) => ({ ...s, status: "done" as const })),
        sources: buf.sources,
        streaming: false,
      };
    });
    const cleaned = next.filter((m) => !(m.id === astId && !m.content));
    return failure
      ? [...cleaned, { id: `err-${Date.now()}`, sender: "system" as const, content: failure, timestamp: now() }]
      : cleaned;
  });
  if (abortRef.current === controller) {
    abortRef.current = null;
    setIsProcessing(false);
  }

  if (speak && !aborted) {
    if (failure) engine!.failResponse("Sorry, I couldn't get an answer just then. Please try again.");
    else engine!.endResponse();
  }
}
