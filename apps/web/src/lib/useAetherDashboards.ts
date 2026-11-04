"use client";

import { useCallback, useRef, useState } from "react";
import { ChatMessage, Dashboard, DashboardStatus } from "../types";
import { createDashboard } from "./api";
import { hasOwnTopic, isDashboardRequest } from "./charts/intent";
import { VoiceEngine } from "./voice/VoiceEngine";
import { now } from "./chatHelpers";

interface UseAetherDashboardsOptions {
  selectedEntity: string;
  activeView: string;
  messagesRef: React.MutableRefObject<ChatMessage[]>;
  engineRef: React.MutableRefObject<VoiceEngine | null>;
  setMessages: React.Dispatch<React.SetStateAction<ChatMessage[]>>;
  setIsDialogueOpen: React.Dispatch<React.SetStateAction<boolean>>;
}

export function useAetherDashboards({
  selectedEntity,
  activeView,
  messagesRef,
  engineRef,
  setMessages,
  setIsDialogueOpen,
}: UseAetherDashboardsOptions) {
  const [dashboards, setDashboards] = useState<Dashboard[]>([]);
  const [activeDashboardId, setActiveDashboardId] = useState<string | null>(null);
  const [dashboardStatus, setDashboardStatus] = useState<Record<string, DashboardStatus>>({});
  const [isDashboardOpen, setIsDashboardOpen] = useState(false);
  const [showDashboardIn3D, setShowDashboardIn3D] = useState(true);
  const [dashboardFocus, setDashboardFocus] = useState(0);

  const dashboardSourceRef = useRef<Record<string, { question: string; answer: string }>>({});
  const ackIdsRef = useRef<Set<string>>(new Set());

  const buildDashboard = useCallback(
    async (opts: { msgId: string; question?: string; answer?: string; speak?: boolean; ack?: boolean }) => {
      const list = messagesRef.current;
      const idx = list.findIndex((m) => m.id === opts.msgId);
      const msg = idx >= 0 ? list[idx] : null;
      const remembered = dashboardSourceRef.current[opts.msgId];
      const question =
        opts.question ||
        remembered?.question ||
        [...list.slice(0, Math.max(0, idx))].reverse().find((m) => m.sender === "user")?.content ||
        msg?.content ||
        "";
      if (!question) return;
      const answer = opts.answer ?? remembered?.answer ?? msg?.content ?? "";
      dashboardSourceRef.current[opts.msgId] = { question, answer };
      const setAck = (content: string) =>
        opts.ack && setMessages((prev) => prev.map((m) => (m.id === opts.msgId ? { ...m, content } : m)));
      setDashboardStatus((prev) => ({ ...prev, [opts.msgId]: { state: "loading" } }));
      try {
        const d = await createDashboard({ question, answer, entityId: selectedEntity });
        setAck(`Created dashboard **${d.title}** for: ${question}`);
        setDashboards((prev) => [...prev.filter((x) => x.id !== d.id), d].slice(-8));
        setActiveDashboardId(d.id);
        setShowDashboardIn3D(true);
        setDashboardFocus((n) => n + 1);
        if (activeView === "spatial") {
          setIsDashboardOpen(false);
        } else {
          setIsDashboardOpen(true);
        }
        setDashboardStatus((prev) => ({ ...prev, [opts.msgId]: { state: "ready", dashboardId: d.id } }));
        if (opts.speak) engineRef.current?.say(`Here is your dashboard: ${d.title}.`);
      } catch (err: any) {
        const message = err?.message || "Could not build a dashboard.";
        setAck(`I couldn't build a dashboard for: ${question}`);
        setDashboardStatus((prev) => ({ ...prev, [opts.msgId]: { state: "error", message } }));
        if (opts.speak) engineRef.current?.say("Sorry, I couldn't build a dashboard for that.");
      }
    },
    [selectedEntity, activeView, messagesRef, engineRef, setMessages]
  );

  const lastAnswer = useCallback(
    () => [...messagesRef.current].reverse().find((m) => m.sender === "assistant" && !m.streaming && m.content) || null,
    [messagesRef]
  );

  const handleDashboardRequest = useCallback(
    (text: string, mode: "text" | "voice") => {
      const own = hasOwnTopic(text);
      const previous = lastAnswer();
      if (!own && !previous) return false;
      const ackId = `ast-${Date.now()}`;
      ackIdsRef.current.add(ackId);
      const subject = own ? text : (previous && [...messagesRef.current].reverse().find((m) => m.sender === "user")?.content) || text;
      const ack: ChatMessage = {
        id: ackId,
        sender: "assistant",
        content: `Building a dashboard for: **${subject}**`,
        timestamp: now(),
        mode,
      };
      const userMsg: ChatMessage = { id: `user-${Date.now()}`, sender: "user", content: text, timestamp: now(), mode };
      messagesRef.current = [...messagesRef.current, userMsg, ack];
      setMessages(messagesRef.current);
      setIsDialogueOpen(true);
      if (mode === "voice") engineRef.current?.beginResponse();
      buildDashboard({
        msgId: ackId,
        question: own ? text : subject,
        answer: own ? "" : previous?.content,
        speak: mode === "voice",
        ack: true,
      });
      return true;
    },
    [buildDashboard, lastAnswer, messagesRef, engineRef, setMessages, setIsDialogueOpen]
  );

  return {
    dashboards,
    setDashboards,
    activeDashboardId,
    setActiveDashboardId,
    dashboardStatus,
    setDashboardStatus,
    isDashboardOpen,
    setIsDashboardOpen,
    showDashboardIn3D,
    setShowDashboardIn3D,
    dashboardFocus,
    setDashboardFocus,
    buildDashboard,
    lastAnswer,
    handleDashboardRequest,
    ackIdsRef,
  };
}

