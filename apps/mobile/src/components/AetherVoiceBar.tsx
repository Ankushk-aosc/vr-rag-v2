import React, { useState, useRef, useEffect } from "react";
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
  Animated,
} from "react-native";
import { Mic, Square, Send, Sparkles, ArrowUpRight } from "lucide-react-native";
import { THEME, ThemeMode } from "../constants/theme";
import {
  isAudioAvailable,
  requestAudioPermissions,
  startRecording as recordStart,
  stopRecording as recordStop,
} from "../services/audioService";

export interface AetherVoiceBarProps {
  onSendMessage: (text: string) => void;
  onAudioCaptured: (audioUri: string) => void;
  isProcessing: boolean;
  theme: ThemeMode;
}

export function AetherVoiceBar({
  onSendMessage,
  onAudioCaptured,
  isProcessing,
  theme,
}: AetherVoiceBarProps) {
  const colors = THEME[theme];
  const isLight = theme === "light";

  const [inputText, setInputText] = useState("");
  const [recording, setRecording] = useState<any>(null);
  const [isRecording, setIsRecording] = useState(false);
  const [recordDuration, setRecordDuration] = useState(0);

  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const pulseAnim = useRef(new Animated.Value(1)).current;

  const quickPrompts = [
    "Portfolio asset allocation",
    "Quarterly balance and returns",
    "Tax distributions & franking credits",
  ];

  // Request permissions safely
  useEffect(() => {
    (async () => {
      if (isAudioAvailable()) {
        await requestAudioPermissions();
      }
    })();
  }, []);

  // Pulsing animation when recording
  useEffect(() => {
    if (isRecording) {
      Animated.loop(
        Animated.sequence([
          Animated.timing(pulseAnim, {
            toValue: 1.15,
            duration: 600,
            useNativeDriver: true,
          }),
          Animated.timing(pulseAnim, {
            toValue: 1.0,
            duration: 600,
            useNativeDriver: true,
          }),
        ])
      ).start();
    } else {
      pulseAnim.setValue(1);
    }
  }, [isRecording]);

  const handleStartRecording = async () => {
    if (!isAudioAvailable()) {
      alert("Microphone recording is not supported in this client environment.");
      return;
    }

    try {
      const rec = await recordStart();
      if (!rec) return;

      setRecording(rec);
      setIsRecording(true);
      setRecordDuration(0);

      timerRef.current = setInterval(() => {
        setRecordDuration((prev) => prev + 1);
      }, 1000);
    } catch (e) {
      console.warn("Failed to start voice capture:", e);
    }
  };

  const handleStopRecording = async () => {
    if (timerRef.current) clearInterval(timerRef.current);
    setIsRecording(false);

    try {
      const uri = await recordStop(recording);
      setRecording(null);
      if (uri) {
        onAudioCaptured(uri);
      }
    } catch (e) {
      console.warn("Failed to stop voice recording:", e);
    }
  };

  const handleToggle = () => {
    if (isRecording) {
      handleStopRecording();
    } else {
      handleStartRecording();
    }
  };

  const handleSend = () => {
    if (!inputText.trim() || isProcessing) return;
    onSendMessage(inputText.trim());
    setInputText("");
  };

  const formatTimer = (s: number) => {
    const mins = Math.floor(s / 60);
    const secs = s % 60;
    return `${mins}:${secs < 10 ? "0" : ""}${secs}`;
  };

  return (
    <View style={styles.container}>
      {/* Quick Prompts */}
      {!isRecording && (
        <View style={styles.promptsRow}>
          {quickPrompts.map((p, idx) => (
            <TouchableOpacity
              key={idx}
              onPress={() => setInputText(p)}
              style={[
                styles.promptPill,
                {
                  backgroundColor: isLight ? "rgba(0,0,0,0.04)" : "rgba(255,255,255,0.08)",
                  borderColor: isLight ? "rgba(0,0,0,0.08)" : "rgba(255,255,255,0.12)",
                },
              ]}
            >
              <Text style={[styles.promptText, { color: colors.textMuted }]}>
                {p}
              </Text>
              <ArrowUpRight size={10} color={colors.accent} />
            </TouchableOpacity>
          ))}
        </View>
      )}

      {/* Main Aether Sovereign Capsule */}
      <View
        style={[
          styles.capsule,
          {
            backgroundColor: isLight ? "rgba(255,255,255,0.95)" : "rgba(18,18,24,0.92)",
            borderColor: isRecording
              ? "rgba(239,68,68,0.5)"
              : isLight
              ? "rgba(0,0,0,0.1)"
              : "rgba(255,255,255,0.15)",
          },
        ]}
      >
        {/* Left: Mic Button */}
        <TouchableOpacity
          onPress={handleToggle}
          disabled={isProcessing}
          style={[
            styles.micBtn,
            {
              backgroundColor: isRecording
                ? "rgba(239,68,68,0.2)"
                : isLight
                ? "rgba(109,40,217,0.1)"
                : "rgba(255,255,255,0.1)",
              borderColor: isRecording ? "#EF4444" : colors.border,
            },
          ]}
        >
          {isProcessing ? (
            <ActivityIndicator size="small" color={colors.accent} />
          ) : isRecording ? (
            <Square size={14} color="#EF4444" fill="#EF4444" />
          ) : (
            <Mic size={16} color={colors.accent} />
          )}
        </TouchableOpacity>

        {/* Center: Input / Audio Wave */}
        {isRecording ? (
          <View style={styles.listeningContainer}>
            <Animated.View
              style={[
                styles.recordingDot,
                { transform: [{ scale: pulseAnim }] },
              ]}
            />
            <Text style={[styles.listeningText, { color: colors.text }]}>
              Listening ({formatTimer(recordDuration)})
            </Text>
          </View>
        ) : (
          <TextInput
            value={inputText}
            onChangeText={setInputText}
            placeholder="Ask Aether about financial records..."
            placeholderTextColor={colors.textMuted}
            editable={!isProcessing}
            style={[styles.input, { color: colors.text }]}
          />
        )}

        {/* Right: Action Button */}
        {isRecording ? (
          <TouchableOpacity onPress={handleStopRecording} style={styles.doneBtn}>
            <Text style={styles.doneText}>Done</Text>
          </TouchableOpacity>
        ) : isProcessing ? (
          <View style={styles.processingBadge}>
            <Sparkles size={12} color={colors.accent} />
          </View>
        ) : (
          <TouchableOpacity
            onPress={handleSend}
            disabled={!inputText.trim()}
            style={[
              styles.sendBtn,
              {
                backgroundColor: inputText.trim()
                  ? colors.accent
                  : isLight
                  ? "rgba(0,0,0,0.06)"
                  : "rgba(255,255,255,0.1)",
              },
            ]}
          >
            <Send
              size={14}
              color={inputText.trim() ? "#FFFFFF" : colors.textMuted}
            />
          </TouchableOpacity>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    position: "absolute",
    bottom: 24,
    left: 16,
    right: 16,
    alignItems: "center",
  },
  promptsRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    justifyContent: "center",
    gap: 6,
    marginBottom: 8,
  },
  promptPill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 14,
    borderWidth: 1,
  },
  promptText: {
    fontSize: 10,
    fontFamily: "SpaceGrotesk_400Regular",
  },
  capsule: {
    flexDirection: "row",
    alignItems: "center",
    width: "100%",
    paddingHorizontal: 8,
    paddingVertical: 6,
    borderRadius: 30,
    borderWidth: 1,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.15,
    shadowRadius: 12,
    elevation: 8,
  },
  micBtn: {
    width: 38,
    height: 38,
    borderRadius: 19,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  listeningContainer: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 12,
    gap: 8,
  },
  recordingDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: "#EF4444",
  },
  listeningText: {
    fontSize: 12,
    fontFamily: "SpaceGrotesk_500Medium",
  },
  input: {
    flex: 1,
    fontSize: 13,
    fontFamily: "SpaceGrotesk_400Regular",
    paddingHorizontal: 10,
  },
  doneBtn: {
    backgroundColor: "rgba(239,68,68,0.2)",
    borderWidth: 1,
    borderColor: "rgba(239,68,68,0.4)",
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 16,
  },
  doneText: {
    color: "#EF4444",
    fontSize: 11,
    fontFamily: "SpaceGrotesk_600SemiBold",
  },
  processingBadge: {
    width: 32,
    height: 32,
    alignItems: "center",
    justifyContent: "center",
  },
  sendBtn: {
    width: 34,
    height: 34,
    borderRadius: 17,
    alignItems: "center",
    justifyContent: "center",
  },
});
