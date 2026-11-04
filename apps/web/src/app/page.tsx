"use client";

import { AppModals } from "../components/AppModals";

import React, { useCallback, useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { Loader2 } from "lucide-react";
import { Header, SovereignNavView } from "../components/Header";
import { HomeView } from "../components/HomeView";
import { AuditView } from "../components/AuditView";
import { AccessView } from "../components/AccessView";
import { AnalyticsView } from "../components/AnalyticsView";
import { RegulatoryBanner } from "../components/RegulatoryBanner";
import { SpatialScene } from "../components/SpatialScene";
import { AetherCommandBar } from "../components/AetherCommandBar";
import { ChatHUD } from "../components/ChatHUD";
import { ThinkingPanel } from "../components/ThinkingPanel";
import { LedgerView } from "../components/LedgerView";
import { CitationInspector } from "../components/CitationInspector";
import { DocumentPreview } from "../components/DocumentPreview";
import { DashboardPanel } from "../components/DashboardPanel";
import { AuthGateway } from "../components/AuthGateway";
import { useAetherDashboards } from "../lib/useAetherDashboards";
import { useVoiceEngineSetup } from "../lib/useVoiceEngineSetup";
import { VoiceEngine } from "../lib/voice/VoiceEngine";
import { ChatMessage, CitationItem, DocumentRecord } from "../types";
import { fetchDocuments, fetchDocumentSuggestions } from "../lib/api";
import { runRagStream } from "../lib/runRagStream";
import { isDashboardRequest } from "../lib/charts/intent";
import { useVoiceSnapshot, voiceStore } from "../lib/voice/voiceStore";
import { EMPTY_SPATIAL_STATE, SpatialState } from "../lib/spatial/spatialPanels";
import { spatialLayout } from "../lib/spatial/spatialLayout";
import { layoutStore, useLayoutState } from "../lib/layout/layoutStore";
import { getAuthToken, fetchCurrentUser, logout, setAuthToken, UserProfile } from "../lib/auth";
import { friendlyError } from "../lib/apiErrors";
import { roleFor } from "../lib/roles";
import { isTabularDoc } from "../lib/format";

function applyTheme(theme: "dark" | "light") {
  const root = document.documentElement;
  root.classList.toggle("dark", theme === "dark");
  root.classList.toggle("light", theme === "light");
}

export default function SovereignPavilionApp() {
  const [theme, setTheme] = useState<"dark" | "light">("light");
  const [selectedEntity, setSelectedEntity] = useState<string>("default_family");
  const [activeView, setActiveView] = useState<SovereignNavView>("home");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [documents, setDocuments] = useState<DocumentRecord[]>([]);
  const [documentsLoading, setDocumentsLoading] = useState(false);
  const [documentsError, setDocumentsError] = useState<string | null>(null);
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [isProcessing, setIsProcessing] = useState(false);
  const [isDialogueOpen, setIsDialogueOpenState] = useState(false);
  const [isThinkingOpen, setIsThinkingOpen] = useState(false);
  const [selectedCitation, setSelectedCitation] = useState<CitationItem | null>(null);
  const [selectedTableDoc, setSelectedTableDoc] = useState<DocumentRecord | null>(null);
  const [previewDoc, setPreviewDoc] = useState<DocumentRecord | null>(null);
  const [isDocDrawerOpen, setIsDocDrawerOpen] = useState(false);
  const [isVrModalOpen, setIsVrModalOpen] = useState(false);
  const [isStereoOpen, setIsStereoOpen] = useState(false);
  const [currentUser, setCurrentUser] = useState<UserProfile | null>(null);
  const [isAuthLoading, setIsAuthLoading] = useState<boolean>(true);
  const [notice, setNotice] = useState<string | null>(null);

  const voice = useVoiceSnapshot();
  const layout = useLayoutState();
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const messagesRef = useRef<ChatMessage[]>([]);
  const abortRef = useRef<AbortController | null>(null);
  const engineRef = useRef<VoiceEngine | null>(null);
  const startedAtRef = useRef(0);
  const spatialStateRef = useRef<SpatialState>(EMPTY_SPATIAL_STATE);
  const activeViewRef = useRef(activeView);
  messagesRef.current = messages;
  activeViewRef.current = activeView;

  // The dashboard shows the conversation inline, so automatic "open the dialogue" requests
  // (a new question, voice mode, wake word) only open the floating panel on other views.
  const setIsDialogueOpen = useCallback<React.Dispatch<React.SetStateAction<boolean>>>((v) => {
    if (v === true && activeViewRef.current === "home") return;
    setIsDialogueOpenState(v);
  }, []);

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

  const handleSignOut = useCallback(() => {
    abortRef.current?.abort();
    engineRef.current?.endConversation("sign-out", true);
    // Revoke the token server-side as well as forgetting it locally
    logout().catch(() => setAuthToken(null));
    setCurrentUser(null);
    setDocuments([]);
    setMessages([]);
    setActiveView("home");
  }, []);

  useEffect(() => {
    let saved: "dark" | "light" | null = null;
    try {
      saved = localStorage.getItem("sovereign_theme") as "dark" | "light" | null;
    } catch {
      /* storage blocked */
    }
    const active = saved === "dark" ? "dark" : "light";
    setTheme(active);
    applyTheme(active);
  }, []);

  const handleToggleTheme = () => {
    const next = theme === "dark" ? "light" : "dark";
    setTheme(next);
    try {
      localStorage.setItem("sovereign_theme", next);
    } catch {
      /* storage blocked */
    }
    applyTheme(next);
  };

  const docsAbortRef = useRef<AbortController | null>(null);
  const loadDocuments = useCallback(async () => {
    docsAbortRef.current?.abort();
    const ctrl = new AbortController();
    docsAbortRef.current = ctrl;
    setDocumentsLoading(true);
    setDocumentsError(null);
    try {
      // Always scoped to the selected entity so records from different families never mix
      const docs = await fetchDocuments(selectedEntity, ctrl.signal);
      if (!ctrl.signal.aborted) setDocuments(docs);
    } catch (err) {
      if (ctrl.signal.aborted) return;
      setDocuments([]);
      setDocumentsError(friendlyError(err, "load your documents").body);
    } finally {
      if (!ctrl.signal.aborted) setDocumentsLoading(false);
    }
  }, [selectedEntity]);

  useEffect(() => {
    if (!currentUser) return;
    loadDocuments();
    setSuggestions([]);
    let live = true;
    fetchDocumentSuggestions(selectedEntity).then((s) => live && setSuggestions(s)).catch(() => {});
    return () => {
      live = false;
      docsAbortRef.current?.abort();
    };
  }, [currentUser, selectedEntity, loadDocuments]);

  // Switching family entity starts a clean conversation so answers and citations never mix
  const prevEntityRef = useRef(selectedEntity);
  useEffect(() => {
    if (prevEntityRef.current === selectedEntity) return;
    prevEntityRef.current = selectedEntity;
    abortRef.current?.abort();
    setMessages([]);
    setSelectedCitation(null);
    setSelectedTableDoc(null);
    setPreviewDoc(null);
  }, [selectedEntity]);

  const handleSelectDocument = useCallback((doc: DocumentRecord) => {
    if (isTabularDoc(doc)) {
      setSelectedTableDoc(doc);
    } else {
      setPreviewDoc(doc);
    }
  }, []);

  const runQuery = useCallback(
    async (text: string, mode: "text" | "voice") => {
      if (isDashboardRequest(text) && handleDashboardRequest(text, mode)) return;
      setIsDialogueOpen(true);
      startedAtRef.current = performance.now();
      await runRagStream({
        text,
        mode,
        entityId: selectedEntity,
        messages: messagesRef.current,
        engine: engineRef.current,
        abortRef,
        setMessages,
        setIsProcessing,
        onSessionExpired: () => handleSignOutRef.current(),
      });
    },
    [selectedEntity, handleDashboardRequest, setIsDialogueOpen]
  );

  const handleSignOutRef = useRef(handleSignOut);
  handleSignOutRef.current = handleSignOut;
  // The 3D renderer only exists while the Spatial Room is mounted; never hand out a disposed one
  useEffect(() => {
    if (activeView !== "spatial") rendererRef.current = null;
  }, [activeView]);

  const closeCitation = useCallback(() => setSelectedCitation(null), []);
  const closePreview = useCallback(() => setPreviewDoc(null), []);
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
      <div className="fixed inset-0 bg-[#F8FAFC] flex flex-col items-center justify-center gap-3 text-slate-600" role="status">
        <Loader2 className="w-6 h-6 animate-spin text-[#2563EB]" aria-hidden />
        <span className="text-[13px]">Checking your session…</span>
      </div>
    );
  }

  const role = currentUser ? roleFor(currentUser, selectedEntity) : "read_only_adviser";
  const commandBarProps = {
    onSendMessage: handleSendMessage,
    onStopGenerating: handleStopGenerating,
    isProcessing,
    hasMessages: messages.length > 0,
    onToggleDialogue: () => setIsDialogueOpenState((v) => !v),
    isDialogueOpen,
    theme,
    prompts: suggestions,
    onToggleVoice: toggleVoice,
    onFinishUtterance: () => engineRef.current?.finishUtterance("button"),
    onInterrupt: () => engineRef.current?.interrupt("button"),
    onSetBargeIn: (on: boolean) => engineRef.current?.setBargeIn(on),
    onSetSttMode: (mode: "auto" | "server") => engineRef.current?.setSttMode(mode),
    onSetBrowserSpeechOptIn: (optIn: boolean) => engineRef.current?.setBrowserSpeechOptIn(optIn),
    onSetWakeWord: (on: boolean) => engineRef.current?.setWakeWordEnabled(on),
    onTestSpeaker: () => engineRef.current?.testSpeaker(),
  };
  const clearMessages = () => {
    handleStopGenerating();
    setMessages([]);
  };

  if (!currentUser) {
    return (
      <AuthGateway
        onAuthenticated={(user) => {
          setCurrentUser(user);
          setActiveView("home");
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
      className={`flex flex-col w-screen h-screen overflow-hidden transition-colors duration-300 ${
        isLight ? "bg-[#F8FAFC] text-slate-900" : "bg-[#0A0D14] text-white"
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
        onToggleDialogue={() => setIsDialogueOpenState((v) => !v)}
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
        currentUser={currentUser}
        onSignOut={handleSignOut}
      />

      {notice && (
        <div role="status" className="relative z-30 flex items-start justify-between gap-3 px-4 sm:px-6 py-2.5 border-b text-[13px] bg-amber-50 border-amber-200 text-amber-900">
          <span>{notice}</span>
          <button type="button" onClick={() => setNotice(null)} className="font-medium hover:underline flex-shrink-0">
            Dismiss
          </button>
        </div>
      )}

      <main id="main" className="w-full flex-1 relative overflow-hidden">
        {activeView === "home" && (
          <div className="w-full h-full overflow-y-auto">
            <HomeView
              theme={theme}
              currentUser={currentUser}
              selectedEntity={selectedEntity}
              role={role}
              messages={messages}
              documents={documents}
              documentsLoading={documentsLoading}
              documentsError={documentsError}
              onRetryDocuments={loadDocuments}
              prompts={suggestions}
              isProcessing={isProcessing}
              onSendMessage={handleSendMessage}
              onCitationClick={setSelectedCitation}
              onSelectDocument={handleSelectDocument}
              onOpenUpload={() => setIsDocDrawerOpen(true)}
              onOpenLedger={() => setActiveView("ledger")}
              onOpenAudit={() => setActiveView("audit")}
              onClearMessages={clearMessages}
              onSpeakMessage={handleSpeakMessage}
              onStopSpeaking={() => engineRef.current?.stopSpeaking("button")}
              speakingMessageId={speakingMessageId}
              askBar={<AetherCommandBar {...commandBarProps} variant="inline" />}
            />
          </div>
        )}

        {activeView === "spatial" && (
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
        )}

        {activeView === "ledger" && (
          <div className="w-full h-full overflow-y-auto">
            <LedgerView
              documents={documents}
              selectedEntity={selectedEntity}
              entityLabel={currentUser.memberships?.find((m) => m.family_entity_id === selectedEntity)?.entity_name}
              loading={documentsLoading}
              error={documentsError}
              onRetry={loadDocuments}
              role={role}
              onOpenUpload={() => setIsDocDrawerOpen(true)}
              onSelectDocument={handleSelectDocument}
              onDocumentsChanged={loadDocuments}
              theme={theme}
            />
          </div>
        )}

        {activeView === "analytics" && (
          <div className="w-full h-full overflow-y-auto">
          <AnalyticsView
            dashboards={dashboards}
            activeDashboardId={activeDashboardId}
            setActiveDashboardId={setActiveDashboardId}
            theme={theme}
            onSendMessage={handleSendMessage}
            tabularDocumentCount={documents.filter(isTabularDoc).length}
            canUpload={role !== "read_only_adviser"}
            onOpenUpload={() => setIsDocDrawerOpen(true)}
          />
          </div>
        )}

        {activeView === "audit" && (
          <div className="w-full h-full overflow-y-auto">
            <AuditView
              entityId={selectedEntity}
              entityLabel={currentUser.memberships?.find((m) => m.family_entity_id === selectedEntity)?.entity_name}
              currentUserId={currentUser.id}
              theme={theme}
              userRole={role}
            />
          </div>
        )}

        {activeView === "access" && (
          <div className="w-full h-full overflow-y-auto">
            <AccessView
              currentUser={currentUser}
              selectedEntity={selectedEntity}
              theme={theme}
            />
          </div>
        )}
      </main>

      {activeView !== "home" && <AetherCommandBar {...commandBarProps} />}

      <ChatHUD
        isOpen={isDialogueOpen}
        onClose={() => setIsDialogueOpen(false)}
        messages={messages}
        onSendMessage={handleSendMessage}
        onStopGenerating={handleStopGenerating}
        onCitationClick={setSelectedCitation}
        isLoading={isProcessing}
        onClearMessages={clearMessages}
        prompts={suggestions}
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

      <CitationInspector citation={selectedCitation} onClose={closeCitation} theme={theme} />
      <DocumentPreview document={previewDoc} onClose={closePreview} onAsk={handleSendMessage} theme={theme} />

      <AppModals
        theme={theme}
        selectedTableDoc={selectedTableDoc}
        onCloseTableDoc={() => setSelectedTableDoc(null)}
        isDocDrawerOpen={isDocDrawerOpen}
        onCloseDocDrawer={() => setIsDocDrawerOpen(false)}
        documents={documents}
        onDocumentUploaded={loadDocuments}
        selectedEntity={selectedEntity}
        entityLabel={currentUser.memberships?.find((m) => m.family_entity_id === selectedEntity)?.entity_name}
        role={role}
        onVrError={setNotice}
        isVrModalOpen={isVrModalOpen}
        onCloseVrModal={() => setIsVrModalOpen(false)}
        rendererRef={rendererRef}
        activeView={activeView}
        setActiveView={setActiveView}
        isStereoOpen={isStereoOpen}
        setIsStereoOpen={setIsStereoOpen}
        spatialStateRef={spatialStateRef}
        onOrbTap={handleOrbTap}
        onSelectDocument={handleSelectDocument}
        onCreateDashboard={createDashboardForLast}
        onCloseDashboard={() => setShowDashboardIn3D(false)}
      />
    </div>
  );
}
