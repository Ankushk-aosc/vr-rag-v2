import React, { useState } from "react";
import {
  View,
  Text,
  Modal,
  TouchableOpacity,
  StyleSheet,
  ScrollView,
  ActivityIndicator,
  Alert,
} from "react-native";
import * as DocumentPicker from "expo-document-picker";
import { FileText, Upload, X, ShieldCheck, CheckCircle2, AlertCircle } from "lucide-react-native";
import { DocumentRecord } from "../types";
import { uploadDocument } from "../services/api";
import { THEME, ThemeMode } from "../constants/theme";

interface DocumentVaultModalProps {
  isOpen: boolean;
  onClose: () => void;
  documents: DocumentRecord[];
  onDocumentUploaded: () => void;
  selectedEntity: string;
  theme: ThemeMode;
}

export function DocumentVaultModal({
  isOpen,
  onClose,
  documents,
  onDocumentUploaded,
  selectedEntity,
  theme,
}: DocumentVaultModalProps) {
  const [isUploading, setIsUploading] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const colors = THEME[theme];
  const isLight = theme === "light";

  const handlePickDocument = async () => {
    try {
      const result = await DocumentPicker.getDocumentAsync({
        type: ["application/pdf", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "text/plain"],
        copyToCacheDirectory: true,
      });

      if (!result.canceled && result.assets && result.assets.length > 0) {
        const file = result.assets[0];
        setIsUploading(true);
        setStatusMessage("Parsing & indexing document with local PyMuPDF...");

        await uploadDocument(
          file.uri,
          file.name,
          file.mimeType || "application/pdf",
          selectedEntity,
          "family_member"
        );

        setStatusMessage(`Successfully indexed "${file.name}"!`);
        onDocumentUploaded();
        setTimeout(() => setStatusMessage(null), 3000);
      }
    } catch (err: any) {
      console.error("Document upload error:", err);
      Alert.alert("Upload Failed", err.message || "Could not upload document.");
      setStatusMessage(null);
    } finally {
      setIsUploading(false);
    }
  };

  return (
    <Modal visible={isOpen} transparent animationType="slide">
      <View style={styles.backdrop}>
        <View style={[styles.sheet, { backgroundColor: colors.surfaceSolid, borderColor: colors.border }]}>
          {/* Header */}
          <View style={[styles.header, { borderBottomColor: colors.border }]}>
            <View style={styles.titleRow}>
              <View style={[styles.iconCircle, { backgroundColor: isLight ? "rgba(109,40,217,0.1)" : "rgba(124,58,237,0.2)" }]}>
                <FileText size={16} color={colors.accentLight} />
              </View>
              <View>
                <Text style={[styles.title, { color: colors.text }]}>Australian Wealth Vault</Text>
                <Text style={[styles.subtitle, { color: colors.textMuted }]}>
                  Entity: {selectedEntity}
                </Text>
              </View>
            </View>
            <TouchableOpacity onPress={onClose} style={styles.closeButton}>
              <X size={18} color={colors.textMuted} />
            </TouchableOpacity>
          </View>

          <ScrollView style={styles.content} contentContainerStyle={{ paddingBottom: 28 }}>
            {/* Upload Zone */}
            <TouchableOpacity
              onPress={handlePickDocument}
              disabled={isUploading}
              style={[
                styles.uploadBox,
                {
                  backgroundColor: isLight ? "rgba(109,40,217,0.04)" : "rgba(124,58,237,0.08)",
                  borderColor: colors.accent,
                },
              ]}
              activeOpacity={0.8}
            >
              <View style={[styles.uploadIconCircle, { backgroundColor: colors.accent }]}>
                {isUploading ? (
                  <ActivityIndicator size="small" color="#FFFFFF" />
                ) : (
                  <Upload size={18} color="#FFFFFF" />
                )}
              </View>
              <Text style={[styles.uploadTitle, { color: colors.text }]}>
                {isUploading ? "Indexing Document..." : "Deposit Financial Document"}
              </Text>
              <Text style={[styles.uploadSub, { color: colors.textMuted }]}>
                ATO Notices, Superannuation statements, Macquarie Wraps (PDF, DOCX, XLSX)
              </Text>

              {statusMessage && (
                <View style={[styles.statusBanner, { backgroundColor: isLight ? "rgba(48,209,88,0.1)" : "rgba(48,209,88,0.2)" }]}>
                  <CheckCircle2 size={14} color={colors.success} />
                  <Text style={[styles.statusText, { color: colors.success }]}>{statusMessage}</Text>
                </View>
              )}
            </TouchableOpacity>

            {/* Document Ledger */}
            <Text style={[styles.ledgerHeading, { color: colors.textMuted }]}>
              INDEXED RECORDS ({documents.length})
            </Text>

            {documents.length === 0 ? (
              <View style={[styles.emptyCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
                <Text style={[styles.emptyCardText, { color: colors.textMuted }]}>
                  No financial records in this vault. Tap above to deposit your first document.
                </Text>
              </View>
            ) : (
              documents.map((doc) => (
                <View
                  key={doc.id}
                  style={[styles.docItem, { backgroundColor: colors.card, borderColor: colors.border }]}
                >
                  <View style={[styles.docIcon, { backgroundColor: isLight ? "rgba(0,0,0,0.04)" : "rgba(255,255,255,0.05)" }]}>
                    <FileText size={16} color={colors.accentLight} />
                  </View>
                  <View style={styles.docInfo}>
                    <Text style={[styles.docName, { color: colors.text }]} numberOfLines={1}>
                      {doc.original_name}
                    </Text>
                    <Text style={[styles.docMeta, { color: colors.textMuted }]}>
                      {doc.total_pages} page(s) • {(doc.file_size / 1024).toFixed(1)} KB
                    </Text>
                  </View>
                  <View style={[styles.verifiedBadge, { backgroundColor: "rgba(48,209,88,0.15)", borderColor: colors.success }]}>
                    <Text style={[styles.verifiedText, { color: colors.success }]}>Verified</Text>
                  </View>
                </View>
              ))
            )}

            {/* Privacy Compliance Footer */}
            <View style={[styles.privacyBox, { borderColor: colors.border }]}>
              <ShieldCheck size={14} color={colors.accentLight} />
              <Text style={[styles.privacyText, { color: colors.textMuted }]}>
                APP 8 Compliant: Stored locally in SQLite. Only anonymous vector coordinates are uploaded to Pinecone.
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
  sheet: {
    borderTopLeftRadius: 28,
    borderTopRightRadius: 28,
    borderTopWidth: 1,
    maxHeight: "85%",
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
  uploadBox: {
    padding: 20,
    borderRadius: 20,
    borderWidth: 1.5,
    borderStyle: "dashed",
    alignItems: "center",
    marginBottom: 20,
  },
  uploadIconCircle: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 10,
  },
  uploadTitle: {
    fontSize: 14,
    fontWeight: "bold",
    marginBottom: 4,
  },
  uploadSub: {
    fontSize: 11,
    textAlign: "center",
    lineHeight: 16,
  },
  statusBanner: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 6,
    paddingHorizontal: 12,
    borderRadius: 14,
    marginTop: 12,
    gap: 6,
  },
  statusText: {
    fontSize: 11,
    fontWeight: "600",
  },
  ledgerHeading: {
    fontSize: 10,
    fontWeight: "bold",
    letterSpacing: 0.5,
    marginBottom: 10,
  },
  emptyCard: {
    padding: 24,
    borderRadius: 18,
    borderWidth: 1,
    alignItems: "center",
    marginBottom: 16,
  },
  emptyCardText: {
    fontSize: 12,
    textAlign: "center",
    lineHeight: 18,
  },
  docItem: {
    flexDirection: "row",
    alignItems: "center",
    padding: 12,
    borderRadius: 16,
    borderWidth: 1,
    marginBottom: 8,
    gap: 10,
  },
  docIcon: {
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: "center",
    justifyContent: "center",
  },
  docInfo: {
    flex: 1,
  },
  docName: {
    fontSize: 12,
    fontWeight: "600",
  },
  docMeta: {
    fontSize: 10,
    marginTop: 2,
  },
  verifiedBadge: {
    paddingVertical: 3,
    paddingHorizontal: 8,
    borderRadius: 10,
    borderWidth: 1,
  },
  verifiedText: {
    fontSize: 9,
    fontWeight: "bold",
  },
  privacyBox: {
    flexDirection: "row",
    alignItems: "center",
    padding: 12,
    borderRadius: 14,
    borderWidth: 1,
    marginTop: 12,
    gap: 8,
  },
  privacyText: {
    flex: 1,
    fontSize: 10,
    lineHeight: 15,
  },
});
