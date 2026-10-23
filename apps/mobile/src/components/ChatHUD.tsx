import React, { useRef, useEffect } from "react";
import {
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
} from "react-native";
import { Bot, User, BookOpen, Volume2, Sparkles, ShieldCheck } from "lucide-react-native";
import { ChatMessage, CitationItem } from "../types";
import { THEME, ThemeMode } from "../constants/theme";
import { playBase64Audio } from "../services/audioService";

interface ChatHUDProps {
  messages: ChatMessage[];
  onSelectCitation: (citation: CitationItem) => void;
  isLoading: boolean;
  theme: ThemeMode;
}

export function ChatHUD({
  messages,
  onSelectCitation,
  isLoading,
  theme,
}: ChatHUDProps) {
  const colors = THEME[theme];
  const isLight = theme === "light";
  const scrollViewRef = useRef<any>(null);

  useEffect(() => {
    scrollViewRef.current?.scrollToEnd({ animated: true });
  }, [messages, isLoading]);

  // Play audio base64 using safe audioService
  const playAudio = async (base64String: string) => {
    await playBase64Audio(base64String);
  };

  return (
    <ScrollView
      ref={scrollViewRef}
      style={styles.container}
      contentContainerStyle={styles.contentContainer}
    >
      {messages.length === 0 ? (
        <View style={styles.emptyState}>
          <View style={[styles.emptyIconCircle, { backgroundColor: isLight ? "rgba(109,40,217,0.1)" : "rgba(124,58,237,0.2)" }]}>
            <Sparkles size={28} color={colors.accentLight} />
          </View>
          <Text style={[styles.emptyTitle, { color: colors.text }]}>
            Australian Wealth Intelligence
          </Text>
          <Text style={[styles.emptySubtitle, { color: colors.textMuted }]}>
            Inquire about ATO Notices of Assessment, superannuation guarantee, or trust documents in AUD with verifiable citations.
          </Text>
          <View style={[styles.compliancePill, { backgroundColor: colors.surface, borderColor: colors.border }]}>
            <ShieldCheck size={12} color={colors.accent} />
            <Text style={[styles.complianceText, { color: colors.textMuted }]}>
              ASIC RG 244 • Factual Financial Grounding
            </Text>
          </View>
        </View>
      ) : (
        messages.map((msg) => {
          const isUser = msg.sender === "user";
          return (
            <View
              key={msg.id}
              style={[
                styles.messageRow,
                isUser ? styles.messageRowUser : styles.messageRowAssistant,
              ]}
            >
              <View
                style={[
                  styles.messageBubble,
                  isUser
                    ? [styles.userBubble, { backgroundColor: colors.accentDark, borderColor: colors.accent }]
                    : [styles.assistantBubble, { backgroundColor: colors.surface, borderColor: colors.border }],
                ]}
              >
                {/* Header Tag */}
                <View style={styles.bubbleHeader}>
                  {isUser ? (
                    <>
                      <User size={12} color="#FFFFFF" />
                      <Text style={styles.userName}>You</Text>
                    </>
                  ) : (
                    <>
                      <Bot size={12} color={colors.accentLight} />
                      <Text style={[styles.assistantName, { color: colors.accentLight }]}>
                        Sovereign Assistant
                      </Text>
                    </>
                  )}
                  <Text style={[styles.timestamp, { color: isUser ? "rgba(255,255,255,0.6)" : colors.textMuted }]}>
                    • {msg.timestamp}
                  </Text>
                </View>

                {/* Message Text */}
                <Text
                  style={[
                    styles.messageText,
                    { color: isUser ? "#FFFFFF" : colors.text },
                  ]}
                >
                  {msg.content}
                </Text>

                {/* Audio Replay Pill */}
                {msg.audioBase64 && (
                  <TouchableOpacity
                    onPress={() => playAudio(msg.audioBase64!)}
                    style={[styles.audioButton, { backgroundColor: isLight ? "rgba(109,40,217,0.1)" : "rgba(124,58,237,0.2)" }]}
                    activeOpacity={0.7}
                  >
                    <Volume2 size={12} color={colors.accentLight} />
                    <Text style={[styles.audioText, { color: colors.accentLight }]}>
                      Replay Voice (en-AU)
                    </Text>
                  </TouchableOpacity>
                )}

                {/* Citation Badges */}
                {msg.citations && msg.citations.length > 0 && (
                  <View style={[styles.citationsContainer, { borderTopColor: colors.border }]}>
                    <Text style={[styles.citationsHeading, { color: colors.gold }]}>
                      SOURCES ({msg.citations.length}):
                    </Text>
                    <View style={styles.citationChipsWrap}>
                      {msg.citations.map((c, i) => (
                        <TouchableOpacity
                          key={i}
                          onPress={() => onSelectCitation(c)}
                          style={[styles.citationChip, { borderColor: colors.gold }]}
                          activeOpacity={0.7}
                        >
                          <BookOpen size={10} color={colors.gold} />
                          <Text style={[styles.citationDocName, { color: colors.gold }]} numberOfLines={1}>
                            {c.document_name}
                          </Text>
                          <Text style={styles.citationPage}>P.{c.page_number}</Text>
                        </TouchableOpacity>
                      ))}
                    </View>
                  </View>
                )}
              </View>
            </View>
          );
        })
      )}

      {/* Loading Indicator */}
      {isLoading && (
        <View style={[styles.loadingBubble, { backgroundColor: colors.surface, borderColor: colors.border }]}>
          <ActivityIndicator size="small" color={colors.accentLight} />
          <Text style={[styles.loadingText, { color: colors.textMuted }]}>
            Synthesizing portfolio evidence in AUD...
          </Text>
        </View>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  contentContainer: {
    paddingHorizontal: 16,
    paddingTop: 16,
    paddingBottom: 110,
  },
  emptyState: {
    alignItems: "center",
    justifyContent: "center",
    paddingTop: 80,
    paddingHorizontal: 24,
  },
  emptyIconCircle: {
    width: 60,
    height: 60,
    borderRadius: 30,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 16,
  },
  emptyTitle: {
    fontSize: 18,
    fontWeight: "bold",
    textAlign: "center",
    marginBottom: 8,
  },
  emptySubtitle: {
    fontSize: 13,
    textAlign: "center",
    lineHeight: 19,
    marginBottom: 16,
  },
  compliancePill: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 6,
    paddingHorizontal: 12,
    borderRadius: 20,
    borderWidth: 1,
    gap: 6,
  },
  complianceText: {
    fontSize: 11,
    fontWeight: "500",
  },
  messageRow: {
    marginBottom: 14,
    flexDirection: "row",
  },
  messageRowUser: {
    justifyContent: "flex-end",
  },
  messageRowAssistant: {
    justifyContent: "flex-start",
  },
  messageBubble: {
    maxWidth: "88%",
    padding: 14,
    borderRadius: 20,
    borderWidth: 1,
  },
  userBubble: {
    borderBottomRightRadius: 4,
  },
  assistantBubble: {
    borderBottomLeftRadius: 4,
  },
  bubbleHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    marginBottom: 6,
  },
  userName: {
    fontSize: 10,
    fontWeight: "bold",
    color: "#FFFFFF",
  },
  assistantName: {
    fontSize: 10,
    fontWeight: "bold",
  },
  timestamp: {
    fontSize: 10,
  },
  messageText: {
    fontSize: 13,
    lineHeight: 19,
  },
  audioButton: {
    flexDirection: "row",
    alignItems: "center",
    alignSelf: "flex-start",
    paddingVertical: 5,
    paddingHorizontal: 10,
    borderRadius: 14,
    marginTop: 8,
    gap: 6,
  },
  audioText: {
    fontSize: 11,
    fontWeight: "600",
  },
  citationsContainer: {
    marginTop: 10,
    paddingTop: 8,
    borderTopWidth: 1,
  },
  citationsHeading: {
    fontSize: 9,
    fontWeight: "bold",
    letterSpacing: 0.5,
    marginBottom: 6,
  },
  citationChipsWrap: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 6,
  },
  citationChip: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 4,
    paddingHorizontal: 8,
    borderRadius: 12,
    borderWidth: 1,
    backgroundColor: "rgba(0,0,0,0.3)",
    gap: 4,
    maxWidth: 160,
  },
  citationDocName: {
    fontSize: 10,
    fontWeight: "600",
    flexShrink: 1,
  },
  citationPage: {
    fontSize: 9,
    fontWeight: "bold",
    color: "#FFFFFF",
  },
  loadingBubble: {
    flexDirection: "row",
    alignItems: "center",
    padding: 12,
    borderRadius: 16,
    borderWidth: 1,
    gap: 10,
    alignSelf: "flex-start",
    marginBottom: 16,
  },
  loadingText: {
    fontSize: 12,
  },
});
