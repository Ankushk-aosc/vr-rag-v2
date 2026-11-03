import React, { useState } from "react";
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { ShieldCheck } from "lucide-react-native";
import { THEME, ThemeMode } from "../constants/theme";
import { getBaseUrl, loginUser } from "../services/api";
import { AuthSession } from "../types";

interface LoginScreenProps {
  theme: ThemeMode;
  onSignedIn: (session: AuthSession) => void;
  /** Shown above the form, e.g. after a session expired. */
  notice?: string | null;
}

/**
 * Sign-in gate for the mobile app (Audit I-12). Every API route except health requires a JWT, so the
 * app shows nothing else until this succeeds. Accounts are created by invite on the web app.
 */
export function LoginScreen({ theme, onSignedIn, notice }: LoginScreenProps) {
  const colors = THEME[theme];
  const isLight = theme === "light";
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canSubmit = email.trim().length > 3 && password.length > 0 && !busy;

  const submit = async () => {
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    try {
      const session = await loginUser(email, password);
      setPassword("");
      onSignedIn(session);
    } catch (err: any) {
      setError(err?.message || "Sign-in failed.");
    } finally {
      setBusy(false);
    }
  };

  const inputStyle = [
    styles.input,
    {
      color: colors.text,
      borderColor: colors.border,
      backgroundColor: isLight ? "rgba(0,0,0,0.03)" : "rgba(255,255,255,0.05)",
    },
  ];

  return (
    <KeyboardAvoidingView
      style={[styles.root, { backgroundColor: colors.background }]}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      <View style={[styles.card, { backgroundColor: colors.surfaceSolid, borderColor: colors.border }]}>
        <View style={[styles.monogram, { backgroundColor: colors.accentDark }]}>
          <Text style={[styles.monogramText, { color: colors.gold }]}>AE</Text>
        </View>
        <Text style={[styles.title, { color: colors.text }]}>Sign in to your vault</Text>
        <Text style={[styles.subtitle, { color: colors.textMuted }]}>
          Use the account your family office administrator invited you to.
        </Text>

        {notice ? <Text style={[styles.notice, { color: colors.gold }]}>{notice}</Text> : null}

        <TextInput
          style={inputStyle}
          placeholder="you@familyoffice.com.au"
          placeholderTextColor={colors.textMuted}
          value={email}
          onChangeText={setEmail}
          autoCapitalize="none"
          autoCorrect={false}
          autoComplete="email"
          keyboardType="email-address"
          textContentType="username"
          returnKeyType="next"
          editable={!busy}
          accessibilityLabel="Email"
        />
        <TextInput
          style={inputStyle}
          placeholder="Password"
          placeholderTextColor={colors.textMuted}
          value={password}
          onChangeText={setPassword}
          secureTextEntry
          autoCapitalize="none"
          autoCorrect={false}
          autoComplete="password"
          textContentType="password"
          returnKeyType="go"
          onSubmitEditing={submit}
          editable={!busy}
          accessibilityLabel="Password"
        />

        {error ? (
          <Text style={[styles.error, { color: colors.danger }]} accessibilityRole="alert">
            {error}
          </Text>
        ) : null}

        <TouchableOpacity
          onPress={submit}
          disabled={!canSubmit}
          activeOpacity={0.85}
          style={[styles.button, { backgroundColor: colors.accent, opacity: canSubmit ? 1 : 0.5 }]}
          accessibilityRole="button"
          accessibilityLabel="Sign in"
        >
          {busy ? <ActivityIndicator color="#FFFFFF" /> : <Text style={styles.buttonText}>Sign in</Text>}
        </TouchableOpacity>

        <View style={styles.footer}>
          <ShieldCheck size={12} color={colors.textMuted} />
          <Text style={[styles.footerText, { color: colors.textMuted }]} numberOfLines={1}>
            {getBaseUrl()}
          </Text>
        </View>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    justifyContent: "center",
    paddingHorizontal: 20,
  },
  card: {
    borderRadius: 24,
    borderWidth: StyleSheet.hairlineWidth,
    padding: 24,
    gap: 12,
  },
  monogram: {
    width: 44,
    height: 44,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 4,
  },
  monogramText: {
    fontSize: 16,
    fontWeight: "700",
    letterSpacing: 1,
  },
  title: {
    fontSize: 22,
    fontWeight: "700",
  },
  subtitle: {
    fontSize: 13,
    lineHeight: 18,
    marginBottom: 4,
  },
  notice: {
    fontSize: 13,
    lineHeight: 18,
  },
  input: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 15,
  },
  error: {
    fontSize: 13,
    lineHeight: 18,
  },
  button: {
    borderRadius: 14,
    paddingVertical: 14,
    alignItems: "center",
    marginTop: 4,
  },
  buttonText: {
    color: "#FFFFFF",
    fontSize: 15,
    fontWeight: "600",
  },
  footer: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    marginTop: 4,
  },
  footerText: {
    fontSize: 11,
    flexShrink: 1,
  },
});
