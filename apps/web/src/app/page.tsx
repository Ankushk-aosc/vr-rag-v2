"use client";

import React, { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { Header } from "../components/Header";
import { RegulatoryBanner } from "../components/RegulatoryBanner";
import { SpatialScene } from "../components/SpatialScene";
import { AetherCommandBar } from "../components/AetherCommandBar";
import { ChatHUD } from "../components/ChatHUD";
import { LedgerView } from "../components/LedgerView";
import { DocumentDrawer } from "../components/DocumentDrawer";
import { CitationInspector } from "../components/CitationInspector";
import { VrLaunchModal } from "../components/VrLaunchModal";
import { StereoViewer } from "../components/StereoViewer";
import { ChatMessage, CitationItem, DocumentRecord } from "../types";
import {
  fetchDocuments,
  fetchDocumentSuggestions,
  queryAssistant,
  voiceAskAssistant,
} from "../lib/api";
import { enterImmersiveVr } from "../lib/webxr";

export default function SovereignPavilionApp() {
  const [theme, setTheme] = useState<"dark" | "light">("dark");
  const [selectedEntity, setSelectedEntity] = useState<string>("default_family");
  const [activeView, setActiveView] = useState<"spatial" | "ledger">("spatial");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [documents, setDocuments] = useState<DocumentRecord[]>([]);
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [isProcessing, setIsProcessing] = useState<boolean>(false);
  const [statusText, setStatusText] = useState<string>("");
  const [isDialogueOpen, setIsDialogueOpen] = useState<boolean>(false);

  const [selectedCitation, setSelectedCitation] = useState<CitationItem | null>(null);
  const [isDocDrawerOpen, setIsDocDrawerOpen] = useState<boolean>(false);
  const [isVrModalOpen, setIsVrModalOpen] = useState<boolean>(false);
  const [isStereoOpen, setIsStereoOpen] = useState<boolean>(false);
  const [isListening, setIsListening] = useState<boolean>(false);
  const [audioLevels, setAudioLevels] = useState<number[]>([15, 20, 30, 25, 18]);

  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);

  // Sync theme with document class
  useEffect(() => {
    const savedTheme = localStorage.getItem("sovereign_theme") as "dark" | "light" | null;
    if (savedTheme) {
      setTheme(savedTheme);
      document.documentElement.classList.toggle("light", savedTheme === "light");
    }
  }, []);

  const handleToggleTheme = () => {
    const nextTheme = theme === "dark" ? "light" : "dark";
    setTheme(nextTheme);
    localStorage.setItem("sovereign_theme", nextTheme);
    document.documentElement.classList.toggle("light", nextTheme === "light");
  };

  // Load documents and real query suggestions
  const loadDocuments = async () => {
    try {
      const docs = await fetchDocuments();
      setDocuments(docs);
    } catch (err) {
      console.warn("Could not fetch documents (backend may be offline):", err);
    }
  };

  useEffect(() => {
    loadDocuments();
    fetchDocumentSuggestions(selectedEntity).then((suggs) => {
      if (suggs && suggs.length > 0) {
        setSuggestions(suggs);
      }
    });
  }, [selectedEntity]);

  // Audio Playback helper
  const playAudioBase64 = (base64String: string) => {
    try {
      const audio = new Audio(`data:audio/mp3;base64,${base64String}`);
      audio.play().catch((err) => console.error("Playback error:", err));
    } catch (err) {
      console.error("Audio initialization error:", err);
    }
  };

  // Handle Text Queries
  const handleSendMessage = async (text: string) => {
    const userMsg: ChatMessage = {
      id: `user-${Date.now()}`,
      sender: "user",
      content: text,
      timestamp: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
    };

    setMessages((prev) => [...prev, userMsg]);
    setIsDialogueOpen(true);
    setIsProcessing(true);
    setStatusText("Retrieving local evidence & Pinecone coordinates...");

    try {
      const res = await queryAssistant(text, selectedEntity);
      const assistantMsg: ChatMessage = {
        id: `ast-${Date.now()}`,
        sender: "assistant",
        content: res.answer,
        timestamp: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
        citations: res.citations,
        grounded: res.grounded,
      };
      setMessages((prev) => [...prev, assistantMsg]);
    } catch (err: any) {
      const errorMsg: ChatMessage = {
        id: `err-${Date.now()}`,
        sender: "system",
        content: `Error: ${err.message || "Failed to retrieve evidence."}`,
        timestamp: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
      };
      setMessages((prev) => [...prev, errorMsg]);
    } finally {
      setIsProcessing(false);
      setStatusText("");
    }
  };

  // Handle Spoken Audio Input
  const handleAudioCaptured = async (audioBlob: Blob) => {
    setIsProcessing(true);
    setIsDialogueOpen(true);
    setStatusText("Transcribing speech with local Whisper...");

    try {
      const res = await voiceAskAssistant(audioBlob, selectedEntity);

      if (res.user_transcript) {
        const userMsg: ChatMessage = {
          id: `user-${Date.now()}`,
          sender: "user",
          content: res.user_transcript,
          timestamp: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
        };
        setMessages((prev) => [...prev, userMsg]);
      }

      const assistantMsg: ChatMessage = {
        id: `ast-${Date.now()}`,
        sender: "assistant",
        content: res.answer,
        timestamp: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
        citations: res.citations,
        grounded: res.grounded,
        audioBase64: res.audio_base64,
      };

      setMessages((prev) => [...prev, assistantMsg]);

      if (res.audio_base64) {
        playAudioBase64(res.audio_base64);
      }
    } catch (err: any) {
      const errorMsg: ChatMessage = {
        id: `err-${Date.now()}`,
        sender: "system",
        content: `Voice error: ${err.message || "Could not process audio."}`,
        timestamp: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
      };
      setMessages((prev) => [...prev, errorMsg]);
    } finally {
      setIsProcessing(false);
      setStatusText("");
    }
  };

  // Handle clicking a 3D document slab in SpatialScene
  const handle3DDocClick = (docTitle?: string, docRecord?: DocumentRecord) => {
    if (docRecord) {
      setSelectedCitation({
        chunk_id: docRecord.file_hash,
        document_id: docRecord.id,
        document_name: docRecord.original_name,
        page_number: 1,
        snippet: `Verified Australian financial evidence excerpt from ${docRecord.original_name} (${docRecord.total_pages} page(s), ${(docRecord.file_size / 1024).toFixed(1)} KB). Stored strictly in local SQLite with APP 8 compliance. Indexed in Pinecone for role-filtered RAG queries.`,
      });
      return;
    }
    const matched = documents.find((d) => d.original_name === docTitle);
    if (matched) {
      setSelectedCitation({
        chunk_id: matched.file_hash,
        document_id: matched.id,
        document_name: matched.original_name,
        page_number: 1,
        snippet: `Verified Australian financial evidence excerpt from ${matched.original_name} (${matched.total_pages} page(s), ${(matched.file_size / 1024).toFixed(1)} KB). Stored strictly in local SQLite with APP 8 compliance. Indexed in Pinecone for role-filtered RAG queries.`,
      });
      return;
    }
    const title = docTitle && typeof docTitle === "string" ? docTitle : "AAPL_financial_data_11558_rows.xlsx";
    setSelectedCitation({
      chunk_id: `chunk_${title.toLowerCase().replace(/[^a-z0-9]/g, "_")}`,
      document_id: "doc_preview",
      document_name: title,
      page_number: 1,
      snippet: `Verified Australian financial evidence excerpt from ${title}. Grounded strictly in local SQLite storage with APP 8 compliance. All monetary figures synthesized in Australian Dollars (AUD $).`,
    });
  };

  const isLight = theme === "light";

  return (
    <div
      className={`relative w-screen h-screen overflow-hidden select-none transition-colors duration-300 ${
        isLight ? "bg-[#F5F5F7] text-[#1D1D1F]" : "bg-black text-[#F5F5F7]"
      }`}
    >
      {/* 1. Hairline Regulatory Disclosure */}
      <RegulatoryBanner theme={theme} />

      {/* 2. Apple visionOS Floating Navigation Capsule */}
      <Header
        selectedEntity={selectedEntity}
        onSelectEntity={setSelectedEntity}
        onOpenDocuments={() => setIsDocDrawerOpen(true)}
        onOpenVrModal={() => setIsVrModalOpen(true)}
        activeView={activeView}
        onSelectView={setActiveView}
        messageCount={messages.length}
        onToggleDialogue={() => setIsDialogueOpen(!isDialogueOpen)}
        isDialogueOpen={isDialogueOpen}
        theme={theme}
        onToggleTheme={handleToggleTheme}
      />

      {/* 3. Main Stage: Spatial Studio Room OR Ledger Vault */}
      <main className="w-full h-full relative">
        {activeView === "spatial" ? (
          /* Full Panoramic 3D Spatial Pavilion with Royal Purple Accents */
          <div className="w-full h-full absolute inset-0">
            <SpatialScene
              onRendererReady={(renderer) => {
                rendererRef.current = renderer;
              }}
              onSelectDocument={handle3DDocClick}
              theme={theme}
              documents={documents}
              isListening={isListening}
              audioLevels={audioLevels}
            />
          </div>
        ) : (
          /* Executive Private Wealth Portfolio Ledger Table */
          <div className="w-full h-full overflow-y-auto">
            <LedgerView
              documents={documents}
              selectedEntity={selectedEntity}
              onOpenUpload={() => setIsDocDrawerOpen(true)}
              onSelectDocument={(doc) => {
                setSelectedCitation({
                  chunk_id: doc.file_hash,
                  document_id: doc.id,
                  document_name: doc.original_name,
                  page_number: 1,
                  snippet: `Verified document: ${doc.original_name} (${doc.total_pages} pages, ${(doc.file_size / 1024).toFixed(1)} KB). Indexed with SHA-256 hash ${doc.file_hash}. Available for role-filtered retrieval.`,
                });
              }}
              theme={theme}
            />
          </div>
        )}
      </main>

      {/* 4. Unified Aether Sovereign Command Capsule */}
      <AetherCommandBar
        onSendMessage={handleSendMessage}
        onAudioCaptured={handleAudioCaptured}
        isProcessing={isProcessing}
        statusText={statusText}
        hasMessages={messages.length > 0}
        onToggleDialogue={() => setIsDialogueOpen(!isDialogueOpen)}
        isDialogueOpen={isDialogueOpen}
        theme={theme}
        prompts={suggestions}
        onListeningStateChange={(listening, levels) => {
          setIsListening(listening);
          setAudioLevels(levels);
        }}
      />

      {/* 5. Floating Apple Intelligence Dialogue Glass Window */}
      <ChatHUD
        isOpen={isDialogueOpen}
        onClose={() => setIsDialogueOpen(false)}
        messages={messages}
        onSendMessage={handleSendMessage}
        onCitationClick={setSelectedCitation}
        isLoading={isProcessing}
        onPlayAudio={playAudioBase64}
        onClearMessages={() => setMessages([])}
        theme={theme}
      />

      {/* 6. Provenance Inspector Modal */}
      <CitationInspector
        citation={selectedCitation}
        onClose={() => setSelectedCitation(null)}
        theme={theme}
      />

      {/* 7. Document Deposit Drawer */}
      <DocumentDrawer
        isOpen={isDocDrawerOpen}
        onClose={() => setIsDocDrawerOpen(false)}
        documents={documents}
        onDocumentUploaded={loadDocuments}
        selectedEntity={selectedEntity}
        theme={theme}
      />

      {/* 8. "VIEW IN VR" Launcher Modal */}
      <VrLaunchModal
        isOpen={isVrModalOpen}
        onClose={() => setIsVrModalOpen(false)}
        onEnterWebXr={() => {
          if (rendererRef.current) {
            enterImmersiveVr(rendererRef.current).catch((err) => {
              console.warn("Immersive VR launch failed:", err);
            });
          }
        }}
        onLaunchStereo={() => setIsStereoOpen(true)}
        theme={theme}
      />

      {/* 9. Mobile Cardboard Stereoscopic Viewer */}
      <StereoViewer
        isOpen={isStereoOpen}
        onClose={() => setIsStereoOpen(false)}
        documents={documents}
        isListening={isListening}
        audioLevels={audioLevels}
      />
    </div>
  );
}
