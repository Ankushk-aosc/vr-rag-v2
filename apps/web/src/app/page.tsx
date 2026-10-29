"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { Loader2 } from "lucide-react";
import { Header } from "../components/Header";
import { RegulatoryBanner } from "../components/RegulatoryBanner";
import { SpatialScene } from "../components/SpatialScene";
import { AetherCommandBar } from "../components/AetherCommandBar";
import { ChatHUD } from "../components/ChatHUD";
import { ThinkingPanel } from "../components/ThinkingPanel";
import { LedgerView } from "../components/LedgerView";
import { DocumentDrawer } from "../components/DocumentDrawer";
import { CitationInspector } from "../components/CitationInspector";
import { VrLaunchModal } from "../components/VrLaunchModal";
import { StereoViewer } from "../components/StereoViewer";
import { DashboardPanel } from "../components/DashboardPanel";
import { TableViewerModal } from "../components/TableViewerModal";
import { AuthGateway } from "../components/AuthGateway";
import { useAetherDashboards } from "../lib/useAetherDashboards";
import { useVoiceEngineSetup } from "../lib/useVoiceEngineSetup";
import { VoiceEngine } from "../lib/voice/VoiceEngine";
import {
  ChatMessage,
  CitationItem,
  DocumentRecord,
  ThinkingStage,
} from "../types";
import { fetchDocuments, fetchDocumentSuggestions, streamQuery, StreamEvent } from "../lib/api";
import { isDashboardRequest } from "../lib/charts/intent";
import { enterImmersiveVr } from "../lib/webxr";
import { useVoiceSnapshot, voiceStore } from "../lib/voice/voiceStore";
import { EMPTY_SPATIAL_STATE, SpatialState } from "../lib/spatial/spatialPanels";
import { spatialLayout } from "../lib/spatial/spatialLayout";
import { layoutStore, useLayoutState } from "../lib/layout/layoutStore";
import { getAuthToken, fetchCurrentUser, setAuthToken, UserProfile } from "../lib/auth";
import { now, buildHistory, docCitation } from "../lib/chatHelpers";

export default function SovereignPavilionApp() {
  const [theme, setTheme] = useState<"dark" | "light">("light");
  const [selectedEntity, setSelectedEntity] = useState<string>("default_family");
  const [activeView, setActiveView] = useState<"spatial" | "ledger">("spatial");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [documents, setDocuments] = useState<DocumentRecord[]>([]);
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [isProcessing, setIsProcessing] = useState(false);
  const [isDialogueOpen, setIsDialogueOpen] = useState(false);
  const [isThinkingOpen, setIsThinkingOpen] = useState(false);
  const [selectedCitation, setSelectedCitation] = useState<CitationItem | null>(null);
  const [selectedTableDoc, setSelectedTableDoc] = useState<DocumentRecord | null>(null);
  const [isDocDrawerOpen, setIsDocDrawerOpen] = useState(false);
  const [isVrModalOpen, setIsVrModalOpen] = useState(false);
  const [isStereoOpen, setIsStereoOpen] = useState(false);
  const [currentUser, setCurrentUser] = useState<UserProfile | null>(null);
  const [isAuthLoading, setIsAuthLoading] = useState<boolean>(true);

  const voice = useVoiceSnapshot();
  const layout = useLayoutState();
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const messagesRef = useRef<ChatMessage[]>([]);
  const abortRef = useRef<AbortController | null>(null);
  const engineRef = useRef<VoiceEngine | null>(null);
  const startedAtRef = useRef(0);
  const spatialStateRef = useRef<SpatialState>(EMPTY_SPATIAL_STATE);
  messagesRef.current = messages;

  const {
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
  } = useAetherDashboards({
    selectedEntity,
    activeView,
    messagesRef,
    engineRef,
    setMessages,
    setIsDialogueOpen,
  });

  // ---------------------------------------------------------------- authentication & theme
  useEffect(() => {
    async function initAuth() {
      const token = getAuthToken();
      if (!token) {
        setIsAuthLoading(false);
        return;
      }
      try {
        const user = await fetchCurrentUser();
        if (user) {
          setCurrentUser(user);
          const firstEntity = user.memberships?.[0]?.family_entity_id;
          if (firstEntity) {
            setSelectedEntity(firstEntity);
          }
        } else {
          setAuthToken(null);
        }
      } catch {
        setAuthToken(null);
      } finally {
        setIsAuthLoading(false);
      }
    }
    initAuth();
  }, []);

  const handleSignOut = () => {
    setAuthToken(null);
    setCurrentUser(null);
    setDocuments([]);
    setMessages([]);
  };

  useEffect(() => {
    let saved: "dark" | "light" | null = null;
    try {
      saved = localStorage.getItem("sovereign_theme") as "dark" | "light" | null;
    } catch {
      /* storage blocked */
    }
    const active = saved || "light";
    setTheme(active);
    document.documentElement.classList.toggle("light", active === "light");
    setIsThinkingOpen(window.innerWidth >= 1100);
  }, []);

  const handleToggleTheme = () => {
    const next = theme === "dark" ? "light" : "dark";
    setTheme(next);
    try {
      localStorage.setItem("sovereign_theme", next);
    } catch {
      /* storage blocked */
    }
    document.documentElement.classList.toggle("light", next === "light");
  };

  const loadDocuments = useCallback(async () => {
    setDocuments(await fetchDocuments());
  }, []);

  useEffect(() => {
    if (!currentUser) return;
    loadDocuments();
    fetchDocumentSuggestions(selectedEntity).then((s) => s.length && setSuggestions(s)).catch(() => {});
  }, [currentUser, selectedEntity, loadDocuments]);

  const handleSelectDocument = useCallback((doc: DocumentRecord) => {
    const isTabular = Boolean(doc.is_table || doc.columns?.length || /\.(csv|xlsx|xls)$/i.test(doc.original_name));
    if (isTabular) {
      setSelectedTableDoc(doc);
    } else {
      setSelectedCitation(docCitation(doc));
    }
  }, []);

  // ---------------------------------------------------------------- querying

  const runQuery = useCallback(
    async (text: string, mode: "text" | "voice") => {
      if (isDashboardRequest(text) && handleDashboardRequest(text, mode)) return;
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      const engine = engineRef.current;
      const speak = mode === "voice" && !!engine?.inConversation;

      const history = buildHistory(messagesRef.current);
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
      setIsDialogueOpen(true);
      startedAtRef.current = performance.now();
      if (speak) engine!.beginResponse();

      // Tokens arrive far faster than React should re-render; batch them every ~50ms.
      const buf = { answer: "", reasoning: "", stages: [] as ThinkingStage[], sources: [] as CitationItem[] };
      let timer: ReturnType<typeof setTimeout> | null = null;
      const flush = () => {
        timer = null;
        const snapshot = { content: buf.answer, reasoning: buf.reasoning, thinking_trace: [...buf.stages], sources: buf.sources };
        setMessages((prev) => prev.map((m) => (m.id === astId ? { ...m, ...snapshot } : m)));
      };
      const schedule = () => {
        if (!timer) timer = setTimeout(flush, 50);
      };

      let final: Extract<StreamEvent, { type: "done" }> | null = null;
      let failure: string | null = null;
      try {
        await streamQuery(
          { question: text, entityId: selectedEntity, history, mode },
          (ev) => {
            switch (ev.type) {
              case "stage": {
                const stage: ThinkingStage = {
                  id: ev.id,
                  title: ev.title,
                  status: ev.status,
                  details: ev.detail,
                  duration_ms: ev.duration_ms,
                };
                const i = buf.stages.findIndex((s) => s.id === ev.id);
                if (i >= 0) buf.stages[i] = stage;
                else buf.stages.push(stage);
                break;
              }
              case "sources":
                buf.sources = ev.citations;
                break;
              case "reasoning":
                buf.reasoning += ev.delta;
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
      } catch (err: any) {
        if (err?.name !== "AbortError") failure = err?.message || "Could not reach the API. Is the backend running on port 8000?";
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
              reasoning: done.reasoning,
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
            reasoning: buf.reasoning,
            thinking_trace: buf.stages.map((s) => ({ ...s, status: "done" as const })),
            sources: buf.sources,
            streaming: false,
          };
        });
        const cleaned = next.filter((m) => !(m.id === astId && !m.content));
        return failure
          ? [...cleaned, { id: `err-${Date.now()}`, sender: "system", content: failure, timestamp: now() }]
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
    },
    [selectedEntity, handleDashboardRequest]
  );

  const runQueryRef = useRef(runQuery);
  runQueryRef.current = runQuery;

  const handleSendMessage = useCallback((text: string) => {
    engineRef.current?.stopSpeaking();
    runQueryRef.current(text, "text");
  }, []);

  const handleStopGenerating = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setIsProcessing(false);
    engineRef.current?.stopSpeaking();
  }, []);

  // ---------------------------------------------------------------- voice
  const {
    speakingMessageId,
    toggleVoice,
    handleOrbTap,
    handleSpeakMessage,
  } = useVoiceEngineSetup({
    engineRef,
    runQuery,
    setIsDialogueOpen,
    abortRef,
    setIsProcessing,
    enabled: Boolean(currentUser),
  });

  // ---------------------------------------------------------------- 3D state feed

  useEffect(() => {
    const lastUser = [...messages].reverse().find((m) => m.sender === "user");
    const lastAst = [...messages].reverse().find((m) => m.sender === "assistant");
    const lastErr = messages.length && messages[messages.length - 1].sender === "system" ? messages[messages.length - 1] : null;
    spatialStateRef.current = {
      question: lastUser?.content || "",
      answer: lastAst?.content || "",
      streaming: !!lastAst?.streaming,
      stages: lastAst?.thinking_trace || [],
      reasoning: lastAst?.reasoning || "",
      citations: (lastAst?.citations?.length ? lastAst.citations : lastAst?.sources) || [],
      phase: voice.phase,
      conversation: voice.conversation,
      interim: voice.interim,
      error: voice.error || lastErr?.content || null,
      startedAt: startedAtRef.current,
      dashboard: showDashboardIn3D ? dashboards.find((d) => d.id === activeDashboardId) || null : null,
      dashboardState: !lastAst || lastAst.streaming || !lastAst.content
        ? "none"
        : (dashboardStatus[lastAst.id]?.state as SpatialState["dashboardState"]) || "available",
      dashboardFocus,
    };
  }, [messages, voice, dashboards, activeDashboardId, dashboardStatus, showDashboardIn3D, dashboardFocus]);

  const createDashboardForLast = useCallback(() => {
    const last = lastAnswer();
    if (last) buildDashboard({ msgId: last.id, speak: voiceStore.get().conversation });
  }, [buildDashboard, lastAnswer]);

  const lastAssistant = [...messages].reverse().find((m) => m.sender === "assistant") || null;
  const isLight = theme === "light";

  if (isAuthLoading) {
    return (
      <div className="fixed inset-0 bg-[#09090B] flex flex-col items-center justify-center space-y-4 text-zinc-400">
        <Loader2 className="w-8 h-8 animate-spin text-[#D4AF37]" />
        <span className="text-xs uppercase tracking-widest font-mono text-zinc-500">
          Initializing Sovereign Security Perimeter...
        </span>
      </div>
    );
  }

  if (!currentUser) {
    return (
      <AuthGateway
        onAuthenticated={(user, mode) => {
          setCurrentUser(user);
          setActiveView(mode);
          const firstEntity = user.memberships?.[0]?.family_entity_id;
          if (firstEntity) {
            setSelectedEntity(firstEntity);
          }
        }}
      />
    );
  }

  return (
    <div
      className={`relative w-screen h-screen overflow-hidden transition-colors duration-300 ${
        isLight ? "bg-[#F5F5F7] text-[#1D1D1F]" : "bg-black text-[#F5F5F7]"
      }`}
    >
      <RegulatoryBanner theme={theme} />

      <Header
        selectedEntity={selectedEntity}
        onSelectEntity={setSelectedEntity}
        onOpenDocuments={() => setIsDocDrawerOpen(true)}
        onOpenVrModal={() => setIsVrModalOpen(true)}
        activeView={activeView}
        onSelectView={setActiveView}
        messageCount={messages.filter((m) => m.sender !== "system").length}
        onToggleDialogue={() => setIsDialogueOpen((v) => !v)}
        isDialogueOpen={isDialogueOpen}
        theme={theme}
        onToggleTheme={handleToggleTheme}
        isThinkingOpen={isThinkingOpen}
        onToggleThinking={() => setIsThinkingOpen((v) => !v)}
        layoutLocked={layout.locked}
        onToggleLayoutLock={() => layoutStore.toggleLocked()}
        onResetLayout={() => {
          layoutStore.resetAll();
          spatialLayout.reset();
        }}
        userEmail={currentUser.email}
        onSignOut={handleSignOut}
      />

      <main className="w-full h-full relative">
        {activeView === "spatial" ? (
          <div className="w-full h-full absolute inset-0">
            <SpatialScene
              onRendererReady={(r) => (rendererRef.current = r)}
              onSelectDocument={handleSelectDocument}
              onOrbTap={handleOrbTap}
              onCreateDashboard={createDashboardForLast}
              onCloseDashboard={() => setShowDashboardIn3D(false)}
              theme={theme}
              documents={documents}
              stateRef={spatialStateRef}
              paused={isStereoOpen}
            />
          </div>
        ) : (
          <div className="w-full h-full overflow-y-auto">
            <LedgerView
              documents={documents}
              selectedEntity={selectedEntity}
              onOpenUpload={() => setIsDocDrawerOpen(true)}
              onSelectDocument={handleSelectDocument}
              theme={theme}
            />
          </div>
        )}
      </main>

      <AetherCommandBar
        onSendMessage={handleSendMessage}
        onStopGenerating={handleStopGenerating}
        isProcessing={isProcessing}
        hasMessages={messages.length > 0}
        onToggleDialogue={() => setIsDialogueOpen((v) => !v)}
        isDialogueOpen={isDialogueOpen}
        theme={theme}
        prompts={suggestions}
        onToggleVoice={toggleVoice}
        onFinishUtterance={() => engineRef.current?.finishUtterance("button")}
        onInterrupt={() => engineRef.current?.interrupt("button")}
        onSetBargeIn={(on) => engineRef.current?.setBargeIn(on)}
        onSetSttMode={(mode) => engineRef.current?.setSttMode(mode)}
        onTestSpeaker={() => engineRef.current?.testSpeaker()}
      />

      <ChatHUD
        isOpen={isDialogueOpen}
        onClose={() => setIsDialogueOpen(false)}
        messages={messages}
        onSendMessage={handleSendMessage}
        onStopGenerating={handleStopGenerating}
        onCitationClick={setSelectedCitation}
        isLoading={isProcessing}
        onClearMessages={() => {
          handleStopGenerating();
          setMessages([]);
        }}
        theme={theme}
        onToggleVoice={toggleVoice}
        onSpeakMessage={handleSpeakMessage}
        onStopSpeaking={() => engineRef.current?.stopSpeaking("button")}
        speakingMessageId={speakingMessageId}
        onCreateDashboard={(msg) => buildDashboard({ msgId: msg.id, ack: ackIdsRef.current.has(msg.id) })}
        onOpenDashboard={(id) => {
          setActiveDashboardId(id);
          setIsDashboardOpen(true);
        }}
        dashboardStatus={dashboardStatus}
      />

      <DashboardPanel
        isOpen={isDashboardOpen}
        dashboards={dashboards}
        activeId={activeDashboardId}
        onSelect={setActiveDashboardId}
        onRemove={(id) => {
          setDashboards((prev) => {
            const next = prev.filter((d) => d.id !== id);
            if (activeDashboardId === id) setActiveDashboardId(next.length ? next[next.length - 1].id : null);
            if (!next.length) setIsDashboardOpen(false);
            return next;
          });
        }}
        onClose={() => setIsDashboardOpen(false)}
        onViewIn3D={() => {
          if (activeView !== "spatial") setActiveView("spatial");
          setShowDashboardIn3D(true);
          setDashboardFocus((n) => n + 1);
          setIsDashboardOpen(false);
        }}
        theme={theme}
      />

      <ThinkingPanel
        isOpen={isThinkingOpen}
        onClose={() => setIsThinkingOpen(false)}
        message={lastAssistant}
        theme={theme}
      />

      <CitationInspector citation={selectedCitation} onClose={() => setSelectedCitation(null)} theme={theme} />

      <TableViewerModal
        document={selectedTableDoc}
        onClose={() => setSelectedTableDoc(null)}
        theme={theme}
      />

      <DocumentDrawer
        isOpen={isDocDrawerOpen}
        onClose={() => setIsDocDrawerOpen(false)}
        documents={documents}
        onDocumentUploaded={loadDocuments}
        selectedEntity={selectedEntity}
        theme={theme}
      />

      <VrLaunchModal
        isOpen={isVrModalOpen}
        onClose={() => setIsVrModalOpen(false)}
        onEnterWebXr={() => {
          if (activeView !== "spatial") setActiveView("spatial");
          if (rendererRef.current) {
            enterImmersiveVr(rendererRef.current).catch((err) => {
              console.warn("Immersive VR launch failed:", err);
              alert(`Could not start immersive VR: ${err.message}`);
            });
          }
        }}
        onLaunchStereo={() => setIsStereoOpen(true)}
        theme={theme}
      />

      <StereoViewer
        isOpen={isStereoOpen}
        onClose={() => setIsStereoOpen(false)}
        documents={documents}
        stateRef={spatialStateRef}
        onOrbTap={handleOrbTap}
        onSelectDocument={handleSelectDocument}
        onCreateDashboard={createDashboardForLast}
        onCloseDashboard={() => setShowDashboardIn3D(false)}
      />
    </div>
  );
}
