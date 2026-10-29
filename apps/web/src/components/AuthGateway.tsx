"use client";

import React, { useState, useRef, useCallback } from "react";
import {
  Shield,
  Box,
  LayoutGrid,
  Lock,
  Mail,
  User,
  Building,
  ArrowRight,
  Loader2,
  AlertCircle,
  Sparkles,
  Layers,
} from "lucide-react";
import SwarmCursor from "./SwarmCursor";
import { login, register, UserProfile } from "../lib/auth";

export interface AuthGatewayProps {
  onAuthenticated: (user: UserProfile, mode: "spatial" | "ledger") => void;
}

export function AuthGateway({ onAuthenticated }: AuthGatewayProps) {
  // Render Mode: 2D Standard vs 3D Spatial Holographic
  const [renderMode, setRenderMode] = useState<"2d" | "3d">("3d");
  const [tab, setTab] = useState<"login" | "register">("login");

  // Form Fields
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [fullName, setFullName] = useState("");
  const [familyTrustName, setFamilyTrustName] = useState("");

  const [isLoading, setIsLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // 3D Tilt & Parallax Physics State
  const cardRef = useRef<HTMLDivElement>(null);
  const [tilt, setTilt] = useState({ rx: 0, ry: 0, gx: 50, gy: 50 });

  const handlePointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (renderMode !== "3d" || !cardRef.current) return;
    const rect = cardRef.current.getBoundingClientRect();
    const nx = (e.clientX - (rect.left + rect.width / 2)) / (rect.width / 2);
    const ny = (e.clientY - (rect.top + rect.height / 2)) / (rect.height / 2);

    // Limit maximum tilt to 12 degrees
    const clampedX = Math.max(-1, Math.min(1, nx));
    const clampedY = Math.max(-1, Math.min(1, ny));

    setTilt({
      rx: -clampedY * 9,
      ry: clampedX * 11,
      gx: ((e.clientX - rect.left) / rect.width) * 100,
      gy: ((e.clientY - rect.top) / rect.height) * 100,
    });
  }, [renderMode]);

  const handlePointerLeave = useCallback(() => {
    setTilt({ rx: 0, ry: 0, gx: 50, gy: 50 });
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMessage(null);
    setIsLoading(true);

    try {
      if (tab === "login") {
        if (!email.trim() || !password) {
          throw new Error("Please enter both email and password.");
        }
        const authData = await login(email.trim(), password);
        onAuthenticated(authData.user, renderMode === "3d" ? "spatial" : "ledger");
      } else {
        if (!fullName.trim() || !email.trim() || !password) {
          throw new Error("Full name, email, and password are required.");
        }
        if (password.length < 8) {
          throw new Error("Password must be at least 8 characters.");
        }
        const authData = await register(
          email.trim(),
          password,
          fullName.trim(),
          familyTrustName.trim() || undefined
        );
        onAuthenticated(authData.user, renderMode === "3d" ? "spatial" : "ledger");
      }
    } catch (err: any) {
      setErrorMessage(err.message || "Authentication failed. Please verify credentials.");
    } finally {
      setIsLoading(false);
    }
  };

  const handleUseDemo = () => {
    setEmail("admin@sovereignfamily.com.au");
    setPassword("SovereignAdmin2026!");
    setTab("login");
    setErrorMessage(null);
  };

  const is3D = renderMode === "3d";

  return (
    <div
      className="fixed inset-0 z-50 overflow-hidden font-sans bg-[#060609]"
      style={{
        backgroundImage:
          "radial-gradient(circle at 50% 35%, rgba(124, 58, 237, 0.22) 0%, rgba(212, 175, 55, 0.12) 35%, rgba(6, 6, 9, 0.98) 85%)",
      }}
    >
      {/* 1. Fullscreen WebGL2 Swarm Cursor Particle Simulation */}
      <SwarmCursor
        color="#D4AF37"
        accentColor="#A855F7"
        count={1200}
        size={3.4}
        shape="dot"
        spread={120}
        speed={1.2}
        swirl={0.7}
        tail={0.6}
        trail={0.8}
        wander={0.6}
        depth={0.8}
        targets="button, input, a, [data-swarm-target]"
        clickEffect="burst"
      />

      {/* 2. Dedicated Centered Stage Container (Isolated from background) */}
      <div className="fixed inset-0 z-10 flex items-center justify-center overflow-y-auto px-4 py-8 sm:px-6 pointer-events-none">
        <div
          className="w-full max-w-xl mx-auto my-auto relative pointer-events-auto"
          style={{ perspective: is3D ? "1200px" : "none" }}
        >
        <div
          ref={cardRef}
          onPointerMove={handlePointerMove}
          onPointerLeave={handlePointerLeave}
          className={`w-full rounded-3xl border transition-all duration-300 relative overflow-hidden backdrop-blur-2xl shadow-2xl ring-1 ring-white/10 ${
            is3D
              ? "bg-[#08080C]/40 border-[#D4AF37]/30 shadow-[#7C3AED]/20 hover:shadow-[#D4AF37]/25 hover:border-[#D4AF37]/45"
              : "bg-[#0A0A10]/45 border-white/15 shadow-black/80 hover:border-white/25"
          }`}
          style={{
            transform: is3D
              ? `rotateX(${tilt.rx}deg) rotateY(${tilt.ry}deg) translateZ(15px)`
              : "none",
            transformStyle: is3D ? "preserve-3d" : "flat",
            transition: "transform 0.15s ease-out, box-shadow 0.3s ease, border-color 0.3s ease",
          }}
        >
          {/* Holographic Dynamic Cursor Glare (Active in 3D Mode) */}
          {is3D && (
            <div
              className="absolute inset-0 pointer-events-none rounded-3xl transition-opacity duration-300"
              style={{
                background: `radial-gradient(circle at ${tilt.gx}% ${tilt.gy}%, rgba(212, 175, 55, 0.16) 0%, rgba(124, 58, 237, 0.10) 35%, transparent 70%)`,
                transform: "translateZ(1px)",
              }}
            />
          )}

          <div className="p-6 sm:p-9 space-y-6 relative z-10">
            {/* TOP BAR: Brand Badge & 2D / 3D Form Render Toggle Button */}
            <div
              className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-white/10 pb-5"
              style={{ transform: is3D ? "translateZ(30px)" : "none" }}
            >
              {/* ASIC Compliance Badge */}
              <div className="inline-flex items-center space-x-2 px-3 py-1 rounded-full bg-[#D4AF37]/10 border border-[#D4AF37]/30 text-[#E8C860] text-xs font-semibold tracking-wide w-fit">
                <Shield className="w-3.5 h-3.5 text-[#D4AF37]" />
                <span>ASIC RG 244 • Sovereign Vault</span>
              </div>

              {/* Form Render Mode Switcher: 2D vs 3D */}
              <div className="inline-flex items-center p-1 rounded-full bg-white/5 border border-white/10 backdrop-blur-md self-start sm:self-auto">
                <button
                  type="button"
                  onClick={() => {
                    setRenderMode("2d");
                    setTilt({ rx: 0, ry: 0, gx: 50, gy: 50 });
                  }}
                  className={`flex items-center space-x-1.5 px-3 py-1.5 rounded-full text-xs font-semibold transition-all ${
                    !is3D
                      ? "bg-white/15 text-white shadow-sm border border-white/20"
                      : "text-zinc-400 hover:text-zinc-200"
                  }`}
                  title="Render form in high-contrast flat 2D"
                >
                  <LayoutGrid className="w-3.5 h-3.5" />
                  <span>2D Flat</span>
                </button>
                <button
                  type="button"
                  onClick={() => setRenderMode("3d")}
                  className={`flex items-center space-x-1.5 px-3 py-1.5 rounded-full text-xs font-semibold transition-all ${
                    is3D
                      ? "bg-gradient-to-r from-[#7C3AED] to-[#9333EA] text-white shadow-md shadow-[#7C3AED]/30 border border-purple-400/30"
                      : "text-zinc-400 hover:text-zinc-200"
                  }`}
                  title="Render form in 3D spatial holographic mode with tilt parallax"
                >
                  <Box className="w-3.5 h-3.5 text-[#D4AF37]" />
                  <span>3D Spatial</span>
                </button>
              </div>
            </div>

            {/* HEADER: Title & Dynamic Mode Feedback */}
            <div
              className="space-y-1.5"
              style={{ transform: is3D ? "translateZ(32px)" : "none" }}
            >
              <div className="flex items-center justify-between">
                <h1 className="text-2xl sm:text-3xl font-black tracking-tight text-white flex items-center space-x-2">
                  <span>Aether Sovereign</span>
                  <span className="text-xs px-2 py-0.5 rounded-md font-mono bg-[#D4AF37]/20 border border-[#D4AF37]/40 text-[#E8C860]">
                    v2.6
                  </span>
                </h1>

                {/* Quick Auto-fill Demo Button */}
                <button
                  type="button"
                  onClick={handleUseDemo}
                  title="Auto-fill verified demo administrator credentials"
                  className="text-[11px] text-[#D4AF37] hover:underline font-medium bg-[#D4AF37]/10 px-2.5 py-1 rounded-md border border-[#D4AF37]/20 hover:bg-[#D4AF37]/20 transition-all"
                >
                  Auto-fill Demo Admin
                </button>
              </div>

              <p className="text-xs sm:text-sm text-zinc-400">
                Australian Family Office Spatial Financial Intelligence Gateway
              </p>

              {/* Render Status Pill */}
              <div className="pt-1 flex items-center space-x-2 text-[11px]">
                {is3D ? (
                  <span className="inline-flex items-center space-x-1.5 text-[#A78BFA] bg-[#7C3AED]/15 px-2.5 py-0.5 rounded-full border border-[#7C3AED]/30 font-medium">
                    <Sparkles className="w-3 h-3 text-[#D4AF37]" />
                    <span>3D Holographic Render Active • Cursor Tilt & Depth Enabled</span>
                  </span>
                ) : (
                  <span className="inline-flex items-center space-x-1.5 text-zinc-300 bg-white/5 px-2.5 py-0.5 rounded-full border border-white/10 font-medium">
                    <Layers className="w-3 h-3 text-zinc-400" />
                    <span>2D Flat Render Active • High-Contrast Executive Layout</span>
                  </span>
                )}
              </div>
            </div>

            {/* TAB SELECTOR: Sign In vs Register */}
            <div
              className="flex space-x-6 border-b border-white/10 pb-2"
              style={{ transform: is3D ? "translateZ(24px)" : "none" }}
            >
              <button
                type="button"
                onClick={() => { setTab("login"); setErrorMessage(null); }}
                className={`text-sm font-semibold pb-2 border-b-2 transition-all ${
                  tab === "login"
                    ? "text-[#D4AF37] border-[#D4AF37]"
                    : "text-zinc-400 border-transparent hover:text-white"
                }`}
              >
                Sign In
              </button>
              <button
                type="button"
                onClick={() => { setTab("register"); setErrorMessage(null); }}
                className={`text-sm font-semibold pb-2 border-b-2 transition-all ${
                  tab === "register"
                    ? "text-[#D4AF37] border-[#D4AF37]"
                    : "text-zinc-400 border-transparent hover:text-white"
                }`}
              >
                Register Family Trust
              </button>
            </div>

            {/* ERROR BANNER */}
            {errorMessage && (
              <div
                className="p-3 rounded-xl bg-red-500/15 border border-red-500/30 text-red-300 text-xs flex items-center space-x-2"
                style={{ transform: is3D ? "translateZ(26px)" : "none" }}
              >
                <AlertCircle className="w-4 h-4 shrink-0 text-red-400" />
                <span>{errorMessage}</span>
              </div>
            )}

            {/* AUTHENTICATION FORM */}
            <form onSubmit={handleSubmit} className="space-y-4">
              {tab === "register" && (
                <div
                  className="space-y-4"
                  style={{ transform: is3D ? "translateZ(20px)" : "none" }}
                >
                  <div>
                    <label className="text-xs font-medium text-zinc-300 mb-1 block">Full Name</label>
                    <div className="relative">
                      <User className="w-4 h-4 text-zinc-500 absolute left-3.5 top-3" />
                      <input
                        type="text"
                        required
                        value={fullName}
                        onChange={(e) => setFullName(e.target.value)}
                        placeholder="e.g. Alexander Sterling"
                        className="w-full pl-10 pr-4 py-2.5 bg-white/[0.04] backdrop-blur-md border border-white/15 rounded-xl text-sm text-white placeholder-zinc-400 focus:outline-none focus:bg-white/[0.08] focus:border-[#D4AF37] focus:ring-1 focus:ring-[#D4AF37] transition-all shadow-inner"
                      />
                    </div>
                  </div>

                  <div>
                    <label className="text-xs font-medium text-zinc-300 mb-1 block">Family Trust / Entity Name</label>
                    <div className="relative">
                      <Building className="w-4 h-4 text-zinc-500 absolute left-3.5 top-3" />
                      <input
                        type="text"
                        value={familyTrustName}
                        onChange={(e) => setFamilyTrustName(e.target.value)}
                        placeholder="e.g. Sterling Family Office"
                        className="w-full pl-10 pr-4 py-2.5 bg-white/[0.04] backdrop-blur-md border border-white/15 rounded-xl text-sm text-white placeholder-zinc-400 focus:outline-none focus:bg-white/[0.08] focus:border-[#D4AF37] focus:ring-1 focus:ring-[#D4AF37] transition-all shadow-inner"
                      />
                    </div>
                  </div>
                </div>
              )}

              <div style={{ transform: is3D ? "translateZ(20px)" : "none" }}>
                <label className="text-xs font-medium text-zinc-300 mb-1 block">Corporate Email Address</label>
                <div className="relative">
                  <Mail className="w-4 h-4 text-zinc-500 absolute left-3.5 top-3" />
                  <input
                    type="email"
                    required
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="admin@sovereignfamily.com.au"
                    className="w-full pl-10 pr-4 py-2.5 bg-white/[0.04] backdrop-blur-md border border-white/15 rounded-xl text-sm text-white placeholder-zinc-400 focus:outline-none focus:bg-white/[0.08] focus:border-[#D4AF37] focus:ring-1 focus:ring-[#D4AF37] transition-all shadow-inner"
                  />
                </div>
              </div>

              <div style={{ transform: is3D ? "translateZ(20px)" : "none" }}>
                <label className="text-xs font-medium text-zinc-300 mb-1 block">Password</label>
                <div className="relative">
                  <Lock className="w-4 h-4 text-zinc-500 absolute left-3.5 top-3" />
                  <input
                    type="password"
                    required
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="••••••••••••••••"
                    className="w-full pl-10 pr-4 py-2.5 bg-white/[0.04] backdrop-blur-md border border-white/15 rounded-xl text-sm text-white placeholder-zinc-400 focus:outline-none focus:bg-white/[0.08] focus:border-[#D4AF37] focus:ring-1 focus:ring-[#D4AF37] transition-all shadow-inner"
                  />
                </div>
              </div>

              {/* SUBMIT BUTTON WITH 3D DEPTH */}
              <div
                className="pt-2"
                style={{ transform: is3D ? "translateZ(28px)" : "none" }}
              >
                <button
                  type="submit"
                  disabled={isLoading}
                  className="w-full py-3 px-4 rounded-xl bg-gradient-to-r from-[#D4AF37] via-[#E8C860] to-[#D4AF37] hover:brightness-110 text-black font-bold text-sm flex items-center justify-center space-x-2 shadow-lg shadow-[#D4AF37]/25 transition-all disabled:opacity-50 cursor-pointer"
                >
                  {isLoading ? (
                    <>
                      <Loader2 className="w-4 h-4 animate-spin text-black" />
                      <span>Verifying Fiduciary Security Clearance...</span>
                    </>
                  ) : (
                    <>
                      <span>
                        {tab === "login"
                          ? `Sign In to Sovereign Vault (${is3D ? "3D Spatial" : "2D Standard"})`
                          : "Create Sovereign Vault Account"}
                      </span>
                      <ArrowRight className="w-4 h-4 text-black" />
                    </>
                  )}
                </button>
              </div>
            </form>

            {/* FOOTER: Regulatory & Isolation Assurance */}
            <div
              className="pt-2 text-center text-[11px] text-zinc-500 space-y-1 border-t border-white/5"
              style={{ transform: is3D ? "translateZ(15px)" : "none" }}
            >
              <p className="flex items-center justify-center space-x-1.5">
                <Lock className="w-3 h-3 text-[#D4AF37]" />
                <span>Tenant-Isolated SQLite Storage & APP 8 Disclosed Cloud Sync</span>
              </p>
              <p>© 2026 Sovereign Wealth Intelligence • Australia (Cth)</p>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
  );
}
