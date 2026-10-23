import React from "react";
import { View, Text, Modal, TouchableOpacity, StyleSheet, ScrollView } from "react-native";
import { BookOpen, X, ShieldCheck, FileText, Table } from "lucide-react-native";
import { CitationItem } from "../types";
import { THEME, ThemeMode } from "../constants/theme";

interface CitationBottomSheetProps {
  citation: CitationItem | null;
  onClose: () => void;
  theme: ThemeMode;
}

export function CitationBottomSheet({
  citation,
  onClose,
  theme,
}: CitationBottomSheetProps) {
  if (!citation) return null;
  const colors = THEME[theme];
  const isLight = theme === "light";

  return (
    <Modal visible={!!citation} transparent animationType="slide">
      <View style={styles.backdrop}>
        <View style={[styles.sheetContainer, { backgroundColor: colors.surfaceSolid, borderColor: colors.border }]}>
          {/* Header */}
          <View style={[styles.header, { borderBottomColor: colors.border }]}>
            <View style={styles.titleRow}>
              <View style={[styles.iconCircle, { backgroundColor: colors.goldMuted }]}>
                <BookOpen size={16} color={colors.gold} />
              </View>
              <View>
                <Text style={[styles.title, { color: colors.text }]}>Verified Provenance</Text>
                <Text style={[styles.subtitle, { color: colors.textMuted }]}>Exact document excerpt</Text>
              </View>
            </View>
            <TouchableOpacity onPress={onClose} style={styles.closeButton}>
              <X size={18} color={colors.textMuted} />
            </TouchableOpacity>
          </View>

          <ScrollView style={styles.content} contentContainerStyle={{ paddingBottom: 32 }}>
            {/* Metadata Pills */}
            <View style={styles.metaGrid}>
              <View style={[styles.metaCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
                <Text style={[styles.metaLabel, { color: colors.textMuted }]}>DOCUMENT</Text>
                <Text style={[styles.metaValue, { color: colors.text }]} numberOfLines={1}>
                  {citation.document_name}
                </Text>
              </View>

              <View style={[styles.metaCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
                <Text style={[styles.metaLabel, { color: colors.textMuted }]}>SOURCE PAGE</Text>
                <Text style={[styles.metaValue, { color: colors.gold }]}>
                  Page {citation.page_number}
                </Text>
              </View>
            </View>

            {/* Document Excerpt Box */}
            <Text style={[styles.sectionTitle, { color: colors.textMuted }]}>
              DOCUMENT EXCERPT
            </Text>
            <View style={[styles.excerptBox, { backgroundColor: isLight ? "#F4F4F8" : "#0D0D12", borderColor: colors.border }]}>
              <Text style={[styles.excerptText, { color: colors.text }]}>
                {citation.snippet}
              </Text>
            </View>

            {/* Privacy Guarantee Banner */}
            <View style={[styles.guaranteeCard, { backgroundColor: isLight ? "rgba(109,40,217,0.06)" : "rgba(124,58,237,0.12)", borderColor: colors.border }]}>
              <ShieldCheck size={16} color={colors.accentLight} />
              <Text style={[styles.guaranteeText, { color: colors.text }]}>
                Australian Privacy Act (APP 8): Retained strictly in local encrypted SQLite. No raw financial data sent to cloud AI models.
              </Text>
            </View>
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.65)",
    justifyContent: "flex-end",
  },
  sheetContainer: {
    borderTopLeftRadius: 28,
    borderTopRightRadius: 28,
    borderTopWidth: 1,
    maxHeight: "80%",
    shadowColor: "#000",
    shadowOffset: { width: 0, height: -4 },
    shadowOpacity: 0.3,
    shadowRadius: 16,
    elevation: 20,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 20,
    paddingVertical: 16,
    borderBottomWidth: 1,
  },
  titleRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  iconCircle: {
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: "center",
    justifyContent: "center",
  },
  title: {
    fontSize: 15,
    fontWeight: "bold",
  },
  subtitle: {
    fontSize: 11,
  },
  closeButton: {
    padding: 6,
  },
  content: {
    padding: 20,
  },
  metaGrid: {
    flexDirection: "row",
    gap: 10,
    marginBottom: 16,
  },
  metaCard: {
    flex: 1,
    padding: 12,
    borderRadius: 16,
    borderWidth: 1,
  },
  metaLabel: {
    fontSize: 9,
    fontWeight: "bold",
    marginBottom: 4,
  },
  metaValue: {
    fontSize: 12,
    fontWeight: "600",
  },
  sectionTitle: {
    fontSize: 10,
    fontWeight: "bold",
    marginBottom: 8,
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  excerptBox: {
    padding: 16,
    borderRadius: 18,
    borderWidth: 1,
    marginBottom: 16,
  },
  excerptText: {
    fontSize: 12,
    lineHeight: 18,
    fontFamily: "monospace",
  },
  guaranteeCard: {
    flexDirection: "row",
    alignItems: "flex-start",
    padding: 14,
    borderRadius: 16,
    borderWidth: 1,
    gap: 10,
  },
  guaranteeText: {
    flex: 1,
    fontSize: 11,
    lineHeight: 16,
  },
});
