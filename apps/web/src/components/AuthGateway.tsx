"use client";

import React, { useState } from "react";
import { Loader2 } from "lucide-react";
import { login, register, UserProfile } from "../lib/auth";

// Next inlines NODE_ENV, so production bundles drop these dev-only demo credentials entirely
const DEMO_CREDENTIALS =
  process.env.NODE_ENV !== "production"
    ? { email: "admin@sovereignfamily.com.au", password: "SovereignAdmin2026!" }
    : null;

export interface AuthGatewayProps {
  onAuthenticated: (user: UserProfile) => void;
}

/** Login and sign-up maps raw failures to a calm message; the server's own `detail` text is already safe. */
function authMessage(err: unknown, tab: "login" | "register") {
  const msg = err instanceof Error ? err.message : "";
  if (!msg || /status \d{3}|failed to fetch|networkerror|load failed/i.test(msg)) {
    return tab === "login"
      ? "We couldn't sign you in. The service may be temporarily unavailable; please try again."
      : "We couldn't create your account. The service may be temporarily unavailable; please try again.";
  }
  return msg;
}

export function AuthGateway({ onAuthenticated }: AuthGatewayProps) {
  const [tab, setTab] = useState<"login" | "register">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [fullName, setFullName] = useState("");
  const [familyName, setFamilyName] = useState("");
  const [inviteToken, setInviteToken] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isLoading) return;
    setErrorMessage(null);
    if (tab === "login" && (!email.trim() || !password)) {
      setErrorMessage("Enter your email and password.");
      return;
    }
    if (tab === "register") {
      if (!fullName.trim() || !email.trim() || !password) {
        setErrorMessage("Full name, email and password are required.");
        return;
      }
      if (password.length < 8) {
        setErrorMessage("Use a password of at least 8 characters.");
        return;
      }
    }
    setIsLoading(true);
    try {
      const auth =
        tab === "login"
          ? await login(email.trim(), password)
          : await register(email.trim(), password, fullName.trim(), familyName.trim() || undefined, inviteToken.trim() || undefined);
      onAuthenticated(auth.user);
    } catch (err) {
      setErrorMessage(authMessage(err, tab));
    } finally {
      setIsLoading(false);
    }
  };

  const field = "mt-1 block w-full h-10 rounded-md border border-slate-300 bg-white px-3 text-[14px] text-slate-900 placeholder-slate-400 focus:border-[#2563EB] focus:outline-none focus:ring-2 focus:ring-blue-100";
  const label = "block text-[13px] font-medium text-slate-700";

  return (
    <div className="min-h-screen bg-[#F8FAFC] text-slate-900 flex flex-col">
      <div className="border-b border-slate-200 bg-white px-4 sm:px-6 py-2 text-[12px] text-slate-600">
        <span className="font-semibold text-amber-700">ASIC RG 244 &amp; Privacy Act 1988:</span> Factual summaries derived from
        authorised records. Not personal financial product advice.
      </div>

      <main className="flex-1 flex items-center justify-center px-4 py-10">
        <div className="w-full max-w-sm">
          <div className="flex items-center gap-3 mb-8">
            <span className="w-9 h-9 rounded-md bg-[#0A2540] text-[#E0F2FE] text-[12px] font-bold tracking-wider flex items-center justify-center">AS</span>
            <div className="leading-tight">
              <div className="text-[14px] font-semibold tracking-[0.08em] text-[#0A2540]">AETHER SOVEREIGN</div>
              <div className="text-[12px] text-slate-500">Family office financial intelligence</div>
            </div>
          </div>

          <h1 className="text-[24px] font-semibold tracking-tight">{tab === "login" ? "Sign in" : "Create an account"}</h1>
          <p className="text-[14px] text-slate-500 mt-1">
            {tab === "login"
              ? "Access your family office's authorised records."
              : "Start a new family office workspace, or join one with an invitation."}
          </p>

          <form onSubmit={handleSubmit} className="mt-6 space-y-4" noValidate>
            {tab === "register" && (
              <label className={label}>
                Full name
                <input type="text" autoComplete="name" value={fullName} onChange={(e) => setFullName(e.target.value)} className={field} />
              </label>
            )}
            <label className={label}>
              Email
              <input type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} className={field} />
            </label>
            <label className={label}>
              Password
              <input
                type="password"
                autoComplete={tab === "login" ? "current-password" : "new-password"}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className={field}
              />
              {tab === "register" && <span className="block mt-1 text-[12px] font-normal text-slate-500">At least 8 characters.</span>}
            </label>
            {tab === "register" && (
              <>
                <label className={label}>
                  Invitation token <span className="font-normal text-slate-500">(if you were invited)</span>
                  <input type="text" value={inviteToken} onChange={(e) => setInviteToken(e.target.value)} className={`${field} font-mono text-[12px]`} />
                </label>
                {!inviteToken.trim() && (
                  <label className={label}>
                    Family office or trust name <span className="font-normal text-slate-500">(new workspace)</span>
                    <input type="text" autoComplete="organization" value={familyName} onChange={(e) => setFamilyName(e.target.value)} className={field} />
                  </label>
                )}
              </>
            )}

            {errorMessage && (
              <p role="alert" className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-[13px] text-rose-900">
                {errorMessage}
              </p>
            )}

            <button
              type="submit"
              disabled={isLoading}
              className="w-full h-10 rounded-md bg-[#2563EB] text-white text-[14px] font-medium hover:bg-[#1D4ED8] disabled:opacity-60 inline-flex items-center justify-center gap-2"
            >
              {isLoading && <Loader2 className="w-4 h-4 animate-spin" aria-hidden />}
              {tab === "login" ? (isLoading ? "Signing in…" : "Sign in") : isLoading ? "Creating account…" : "Create account"}
            </button>
          </form>

          <div className="mt-6 text-[13px] text-slate-600">
            {tab === "login" ? (
              <>
                New to Aether?{" "}
                <button type="button" className="font-medium text-blue-700 dark:text-blue-400 hover:underline" onClick={() => { setTab("register"); setErrorMessage(null); }}>
                  Create an account
                </button>
              </>
            ) : (
              <>
                Already have an account?{" "}
                <button type="button" className="font-medium text-blue-700 dark:text-blue-400 hover:underline" onClick={() => { setTab("login"); setErrorMessage(null); }}>
                  Sign in
                </button>
              </>
            )}
          </div>

          {DEMO_CREDENTIALS && tab === "login" && (
            <button
              type="button"
              onClick={() => {
                setEmail(DEMO_CREDENTIALS.email);
                setPassword(DEMO_CREDENTIALS.password);
                setErrorMessage(null);
              }}
              className="mt-3 text-[12px] text-slate-500 hover:underline"
            >
              Development only: fill the seeded demo account
            </button>
          )}
        </div>
      </main>
    </div>
  );
}
