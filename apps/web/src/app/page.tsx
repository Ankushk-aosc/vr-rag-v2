"use client";

import React, { useEffect, useState } from "react";
import { Header } from "../components/Header";
import { RegulatoryBanner } from "../components/RegulatoryBanner";
import { VoiceMicOrb } from "../components/VoiceMicOrb";
import { SpatialScene } from "../components/SpatialScene";
import { ChatHUD } from "../components/ChatHUD";
import { DocumentDrawer } from "../components/DocumentDrawer";
import { CitationInspector } from "../components/CitationInspector";
import { VrLaunchModal } from "../components/VrLaunchModal";
import { ChatMessage, CitationItem, DocumentRecord } from "../types";
import { fetchDocuments, queryAssistant, voiceAskAssistant } from "../lib/api";

export default function AuroraDashboard() {
  const [selectedEntity, setSelectedEntity] = useState<string>("default_family");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [documents, setDocuments] = useState<DocumentRecord[]>([]);
  const [isProcessing, setIsProcessing] = useState<boolean>(false);
  const [statusText, setStatusText] = useState<string>("");
  const [selectedCitation, setSelectedCitation] = useState<CitationItem | null>(null);
  const [isDocDrawerOpen, setIsDocDrawerOpen] = useState<boolean>(false);
  const [isVrModalOpen, setIsVrModalOpen] = useState<boolean>(false);

  // Load documents on mount
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
    setIsProcessing(true);
    setStatusText("Searching Pinecone & Local Evidence...");

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
    setStatusText("Transcribing Speech with Local Whisper...");

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

      // Automatically play spoken answer if audio generated
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

  return (
    <div className="flex flex-col min-h-screen">
      {/* 1. Regulatory Disclosure Banner */}
      <RegulatoryBanner />

      {/* 2. Cockpit Header with "VIEW IN VR" Action */}
      <Header
        selectedEntity={selectedEntity}
        onSelectEntity={setSelectedEntity}
        onOpenDocuments={() => setIsDocDrawerOpen(true)}
        onOpenVrModal={() => setIsVrModalOpen(true)}
      />

      {/* 3. Main Split Cockpit Viewport */}
      <main className="flex-1 max-w-7xl w-full mx-auto p-4 sm:p-6 grid grid-cols-1 lg:grid-cols-12 gap-6">
        {/* Left Column: 3D Spatial Scene & Voice Core Orb (5 cols) */}
        <section className="lg:col-span-5 flex flex-col space-y-4">
          {/* Always-On 3D Spatial Scene */}
          <div className="h-[320px] sm:h-[380px] w-full">
            <SpatialScene />
          </div>

          {/* 3D Cyber-Tactile Neon Voice Orb */}
          <div className="aurora-glass rounded-2xl p-4 border border-aurora-cyan/30 shadow-glass flex-1 flex items-center justify-center">
            <VoiceMicOrb
              onAudioCaptured={handleAudioCaptured}
              isProcessing={isProcessing}
              statusText={statusText}
            />
          </div>
        </section>

        {/* Right Column: Grounded Conversational Stream & Citations (7 cols) */}
        <section className="lg:col-span-7 h-[680px] flex flex-col">
          <ChatHUD
            messages={messages}
            onSendMessage={handleSendMessage}
            onCitationClick={setSelectedCitation}
            isLoading={isProcessing}
            onPlayAudio={playAudioBase64}
          />
        </section>
      </main>

      {/* 4. Interactive Citation Inspector Modal */}
      <CitationInspector
        citation={selectedCitation}
        onClose={() => setSelectedCitation(null)}
      />

      {/* 5. Document Management Drawer */}
      <DocumentDrawer
        isOpen={isDocDrawerOpen}
        onClose={() => setIsDocDrawerOpen(false)}
        documents={documents}
        onDocumentUploaded={loadDocuments}
        selectedEntity={selectedEntity}
      />

      {/* 6. YouTube-Style "VIEW IN VR" Launcher Modal */}
      <VrLaunchModal
        isOpen={isVrModalOpen}
        onClose={() => setIsVrModalOpen(false)}
        onEnterWebXr={() => {
          // Direct WebXR session request
          if (typeof window !== "undefined" && "xr" in navigator) {
            // @ts-ignore
            navigator.xr?.requestSession("immersive-vr").catch((e: any) => {
              console.warn("WebXR session request:", e);
            });
          }
        }}
      />
    </div>
  );
}
