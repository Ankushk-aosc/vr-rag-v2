import React from "react";
import { View, Text, TouchableOpacity, StyleSheet, Modal } from "react-native";
import { Layers, Sun, Moon, HardDrive, Box, Glasses, ShieldCheck } from "lucide-react-native";
import { THEME, ThemeMode } from "../constants/theme";

interface HeaderProps {
  selectedEntity: string;
  onSelectEntity: (entity: string) => void;
  theme: ThemeMode;
  onToggleTheme: () => void;
  onOpenVault: () => void;
  activeView: "spatial" | "chat";
  onToggleView: () => void;
}

export function Header({
  selectedEntity,
  onSelectEntity,
  theme,
  onToggleTheme,
  onOpenVault,
  activeView,
  onToggleView,
}: HeaderProps) {
  const colors = THEME[theme];
  const isLight = theme === "light";
  const [isEntityModalOpen, setIsEntityModalOpen] = React.useState(false);

  const entities = [
    { id: "default_family", label: "Smith Family Trust (ABN 48 123)" },
    { id: "personal_portfolio", label: "Personal Superannuation (AUD)" },
  ];

  return (
    <View style={styles.container}>
      {/* Top Hairline Regulatory Badge */}
      <View style={[styles.regulatoryBar, { backgroundColor: isLight ? "#FFFFFF" : "#0A0A0E", borderColor: colors.border }]}>
        <ShieldCheck size={12} color={colors.accent} />
        <Text style={[styles.regulatoryText, { color: colors.gold }]}>
          ASIC RG 244 • Australia (Cth) Factual Grounding
        </Text>
      </View>

      {/* Floating Capsule Header */}
      <View style={[styles.headerCapsule, { backgroundColor: colors.surface, borderColor: colors.border }]}>
        {/* Left: Brand Monogram & Entity Pill */}
        <TouchableOpacity
          onPress={() => setIsEntityModalOpen(true)}
          style={[styles.entityButton, { backgroundColor: isLight ? "rgba(0,0,0,0.04)" : "rgba(255,255,255,0.06)", borderColor: colors.border }]}
          activeOpacity={0.8}
        >
          <View style={[styles.monogram, { backgroundColor: colors.accentDark }]}>
            <Text style={[styles.monogramText, { color: colors.gold }]}>AE</Text>
          </View>
          <Text style={[styles.entityLabel, { color: colors.text }]} numberOfLines={1}>
            {selectedEntity === "default_family" ? "Smith Trust" : "Personal Super"}
          </Text>
        </TouchableOpacity>

        {/* Center: View Switcher (Spatial 3D vs. Chat) */}
        <TouchableOpacity
          onPress={onToggleView}
          style={[styles.viewSwitchButton, { backgroundColor: isLight ? "rgba(109,40,217,0.1)" : "rgba(124,58,237,0.2)", borderColor: colors.border }]}
          activeOpacity={0.8}
        >
          {activeView === "spatial" ? (
            <>
              <Box size={14} color={colors.accentLight} />
              <Text style={[styles.viewSwitchText, { color: colors.accentLight }]}>3D Room</Text>
            </>
          ) : (
            <>
              <Glasses size={14} color={colors.gold} />
              <Text style={[styles.viewSwitchText, { color: colors.gold }]}>Chat Stream</Text>
            </>
          )}
        </TouchableOpacity>

        {/* Right Actions: Vault & Dark/Light Toggle */}
        <View style={styles.rightActions}>
          <TouchableOpacity
            onPress={onOpenVault}
            style={[styles.iconButton, { borderColor: colors.border }]}
            activeOpacity={0.8}
          >
            <HardDrive size={15} color={colors.text} />
          </TouchableOpacity>

          <TouchableOpacity
            onPress={onToggleTheme}
            style={[styles.iconButton, { borderColor: colors.border }]}
            activeOpacity={0.8}
          >
            {isLight ? (
              <Moon size={15} color={colors.accentDark} />
            ) : (
              <Sun size={15} color={colors.gold} />
            )}
          </TouchableOpacity>
        </View>
      </View>

      {/* Entity Selection Modal */}
      <Modal visible={isEntityModalOpen} transparent animationType="fade">
        <TouchableOpacity
          style={styles.modalBackdrop}
          activeOpacity={1}
          onPress={() => setIsEntityModalOpen(false)}
        >
          <View style={[styles.modalSheet, { backgroundColor: colors.surfaceSolid, borderColor: colors.border }]}>
            <Text style={[styles.modalTitle, { color: colors.text }]}>Select Australian Entity Vault</Text>
            {entities.map((item) => (
              <TouchableOpacity
                key={item.id}
                onPress={() => {
                  onSelectEntity(item.id);
                  setIsEntityModalOpen(false);
                }}
                style={[
                  styles.entityOption,
                  selectedEntity === item.id && { backgroundColor: isLight ? "rgba(109,40,217,0.12)" : "rgba(124,58,237,0.25)" },
                ]}
              >
                <Layers size={16} color={selectedEntity === item.id ? colors.accent : colors.textMuted} />
                <Text
                  style={[
                    styles.entityOptionText,
                    { color: selectedEntity === item.id ? colors.accent : colors.text },
                  ]}
                >
                  {item.label}
                </Text>
              </TouchableOpacity>
            ))}
          </View>
        </TouchableOpacity>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    paddingTop: 48,
    paddingHorizontal: 16,
    zIndex: 50,
  },
  regulatoryBar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 4,
    paddingHorizontal: 12,
    borderRadius: 20,
    borderWidth: 1,
    marginBottom: 8,
    gap: 6,
  },
  regulatoryText: {
    fontSize: 10,
    fontWeight: "600",
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  headerCapsule: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 30,
    borderWidth: 1,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.2,
    shadowRadius: 10,
    elevation: 8,
  },
  entityButton: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 4,
    paddingHorizontal: 8,
    borderRadius: 20,
    borderWidth: 1,
    gap: 6,
    maxWidth: 140,
  },
  monogram: {
    width: 22,
    height: 22,
    borderRadius: 11,
    alignItems: "center",
    justifyContent: "center",
  },
  monogramText: {
    fontSize: 9,
    fontWeight: "bold",
  },
  entityLabel: {
    fontSize: 11,
    fontWeight: "600",
  },
  viewSwitchButton: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 5,
    paddingHorizontal: 10,
    borderRadius: 20,
    borderWidth: 1,
    gap: 5,
  },
  viewSwitchText: {
    fontSize: 11,
    fontWeight: "600",
  },
  rightActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  iconButton: {
    width: 32,
    height: 32,
    borderRadius: 16,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  modalBackdrop: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.75)",
    justifyContent: "center",
    paddingHorizontal: 24,
  },
  modalSheet: {
    borderRadius: 24,
    borderWidth: 1,
    padding: 20,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 10 },
    shadowOpacity: 0.5,
    shadowRadius: 20,
    elevation: 12,
  },
  modalTitle: {
    fontSize: 14,
    fontWeight: "bold",
    marginBottom: 16,
    textAlign: "center",
  },
  entityOption: {
    flexDirection: "row",
    alignItems: "center",
    padding: 14,
    borderRadius: 16,
    gap: 12,
    marginBottom: 8,
  },
  entityOptionText: {
    fontSize: 13,
    fontWeight: "500",
    flex: 1,
  },
});
