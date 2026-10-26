import React, { useState, useEffect } from "react";
import { StyleSheet, View, SafeAreaView } from "react-native";
import { StatusBar } from "expo-status-bar";
import { THEME, ThemeMode } from "./src/constants/theme";
import { Header } from "./src/components/Header";
import { SpatialGyroView } from "./src/components/SpatialGyroView";
import { ChatHUD } from "./src/components/ChatHUD";
import { AetherVoiceBar } from "./src/components/AetherVoiceBar";
import { CitationBottomSheet } from "./src/components/CitationBottomSheet";
import { DocumentVaultModal } from "./src/components/DocumentVaultModal";
import { ChatMessage, CitationItem, DocumentRecord } from "./src/types";
import { fetchDocuments, queryAssistant, voiceAskAssistant } from "./src/services/api";

export default function App() {
  const [theme, setTheme] = useState<ThemeMode>("light");
  const [selectedEntity, setSelectedEntity] = useState("default_family");
  const [activeView, setActiveView] = useState<"spatial" | "chat">("spatial");

  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [documents, setDocuments] = useState<DocumentRecord[]>([]);
  const [isProcessing, setIsProcessing] = useState(false);

  const [selectedCitation, setSelectedCitation] = useState<CitationItem | null>(null);
  const [isVaultOpen, setIsVaultOpen] = useState(false);

  const colors = THEME[theme];

  const loadDocs = async () => {
    try {
      const docs = await fetchDocuments(selectedEntity);
      setDocuments(docs);
    } catch (e) {
      console.warn("Could not load documents:", e);
    }
  };

  useEffect(() => {
    loadDocs();
  }, [selectedEntity]);

  const handleSendMessage = async (text: string) => {
    const userMsg: ChatMessage = {
      id: `user-${Date.now()}`,
      sender: "user",
      content: text,
      timestamp: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
    };

    setMessages((prev) => [...prev, userMsg]);
    setActiveView("chat"); // Switch to chat view to see answer
    setIsProcessing(true);

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
    }
  };

  const handleAudioCaptured = async (audioUri: string) => {
    setIsProcessing(true);
    setActiveView("chat");

    try {
      const res = await voiceAskAssistant(audioUri, selectedEntity);

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
    } catch (err: any) {
      const errorMsg: ChatMessage = {
        id: `err-${Date.now()}`,
        sender: "system",
        content: `Voice Error: ${err.message || "Could not process audio."}`,
        timestamp: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
      };
      setMessages((prev) => [...prev, errorMsg]);
    } finally {
      setIsProcessing(false);
    }
  };

  const toggleTheme = () => {
    setTheme((prev) => (prev === "dark" ? "light" : "dark"));
  };

  const toggleView = () => {
    setActiveView((prev) => (prev === "spatial" ? "chat" : "spatial"));
  };

  return (
    <View style={[styles.root, { backgroundColor: colors.background }]}>
      <StatusBar style={theme === "dark" ? "light" : "dark"} />

      {/* Floating Apple Navigation Header */}
      <Header
        selectedEntity={selectedEntity}
        onSelectEntity={setSelectedEntity}
        theme={theme}
        onToggleTheme={toggleTheme}
        onOpenVault={() => setIsVaultOpen(true)}
        activeView={activeView}
        onToggleView={toggleView}
      />

      {/* Main View Area: Spatial 3D Gyro Room OR Grounded Chat */}
      <View style={styles.mainView}>
        {activeView === "spatial" ? (
          <SpatialGyroView
            theme={theme}
            onSelectDocument={(docTitle) => {
              setSelectedCitation({
                chunk_id: `chunk_${docTitle.toLowerCase().replace(/\s+/g, "_")}`,
                document_id: "doc_preview",
                document_name: docTitle,
                page_number: 1,
                snippet: `Verified Australian financial evidence excerpt from ${docTitle}. Grounded strictly in local encrypted storage with APP 8 compliance.`,
              });
            }}
          />
        ) : (
          <ChatHUD
            messages={messages}
            onSelectCitation={setSelectedCitation}
            isLoading={isProcessing}
            theme={theme}
          />
        )}
      </View>

      {/* Floating Aether Command Bar (Bottom) */}
      <AetherVoiceBar
        onSendMessage={handleSendMessage}
        onAudioCaptured={handleAudioCaptured}
        isProcessing={isProcessing}
        theme={theme}
      />

      {/* Citation Provenance Bottom Sheet */}
      <CitationBottomSheet
        citation={selectedCitation}
        onClose={() => setSelectedCitation(null)}
        theme={theme}
      />

      {/* Document Vault Upload Modal */}
      <DocumentVaultModal
        isOpen={isVaultOpen}
        onClose={() => setIsVaultOpen(false)}
        documents={documents}
        onDocumentUploaded={loadDocs}
        selectedEntity={selectedEntity}
        theme={theme}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
  },
  mainView: {
    flex: 1,
  },
});
