"use client";

import React, { useEffect, useRef, useState } from "react";
import { Glasses, Sun, Moon, LogOut, ChevronDown, Menu, X, Check } from "lucide-react";
import { UserProfile } from "../lib/auth";
import { ROLE_LABEL, entityName, roleFor } from "../lib/roles";

export type SovereignNavView = "home" | "spatial" | "ledger" | "analytics" | "audit" | "access";

export interface HeaderProps {
  selectedEntity: string;
  onSelectEntity?: (entityId: string) => void;
  onOpenDocuments: () => void;
  onOpenVrModal: () => void;
  activeView: SovereignNavView;
  onSelectView: (view: SovereignNavView) => void;
  messageCount: number;
  onToggleDialogue: () => void;
  isDialogueOpen: boolean;
  theme: "dark" | "light";
  onToggleTheme: () => void;
  isThinkingOpen: boolean;
  onToggleThinking: () => void;
  layoutLocked?: boolean;
  onToggleLayoutLock?: () => void;
  onResetLayout?: () => void;
  currentUser?: UserProfile | null;
  onSignOut?: () => void;
}

type MenuId = "workspace" | "intelligence" | "governance" | "user";

interface NavItem {
  label: string;
  view?: SovereignNavView;
  /** Panels toggle instead of navigating. */
  toggle?: () => void;
  active: boolean;
}

export const VIEW_TITLES: Record<SovereignNavView, string> = {
  home: "Dashboard",
  spatial: "Spatial Room",
  ledger: "Ledger Vault",
  analytics: "Analytics",
  audit: "Audit",
  access: "Access",
};

export function Header({
  selectedEntity,
  onSelectEntity,
  onOpenVrModal,
  activeView,
  onSelectView,
  messageCount,
  onToggleDialogue,
  isDialogueOpen,
  theme,
  onToggleTheme,
  isThinkingOpen,
  onToggleThinking,
  currentUser,
  onSignOut,
}: HeaderProps) {
  const [openMenu, setOpenMenu] = useState<MenuId | null>(null);
  const [mobileOpen, setMobileOpen] = useState(false);
  const rootRef = useRef<HTMLElement>(null);
  const isLight = theme === "light";

  useEffect(() => {
    const onPointer = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpenMenu(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpenMenu(null);
        setMobileOpen(false);
      }
    };
    document.addEventListener("mousedown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, []);

  const role = roleFor(currentUser, selectedEntity);
  const entity = entityName(currentUser, selectedEntity);
  const displayName = currentUser?.full_name || currentUser?.email || "";
  const initials = (displayName || "?")
    .split(/[\s@.]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase())
    .join("");

  const groups: { id: Exclude<MenuId, "user">; label: string; items: NavItem[] }[] = [
    {
      id: "workspace",
      label: "Workspace",
      items: (["home", "spatial", "ledger", "analytics"] as SovereignNavView[]).map((v) => ({
        label: VIEW_TITLES[v],
        view: v,
        active: activeView === v,
      })),
    },
    {
      id: "intelligence",
      label: "Intelligence",
      items: [
        { label: messageCount ? `Dialogue (${messageCount})` : "Dialogue", toggle: onToggleDialogue, active: isDialogueOpen },
        { label: "Reasoning", toggle: onToggleThinking, active: isThinkingOpen },
      ],
    },
    {
      id: "governance",
      label: "Governance",
      items: (["audit", "access"] as SovereignNavView[]).map((v) => ({ label: VIEW_TITLES[v], view: v, active: activeView === v })),
    },
  ];

  const choose = (item: NavItem) => {
    if (item.view) onSelectView(item.view);
    else item.toggle?.();
    setOpenMenu(null);
    setMobileOpen(false);
  };

  const navBtn = (active: boolean) =>
    `h-9 px-3 flex items-center gap-1 rounded-md text-[13px] font-medium transition-colors ${
      active
        ? isLight
          ? "text-[#0A2540] bg-slate-100"
          : "text-white bg-slate-800"
        : isLight
        ? "text-slate-600 hover:text-slate-900 hover:bg-slate-50"
        : "text-slate-400 hover:text-white hover:bg-slate-800/60"
    }`;
  const menuPanel = `absolute top-full mt-1 min-w-[200px] rounded-md border py-1 shadow-lg z-50 ${
    isLight ? "bg-white border-slate-200" : "bg-[#0F172A] border-slate-700"
  }`;
  const menuItem = (active: boolean) =>
    `w-full flex items-center justify-between gap-3 px-3 py-2 text-[13px] text-left ${
      active ? (isLight ? "text-[#0A2540] font-medium" : "text-white font-medium") : isLight ? "text-slate-700" : "text-slate-300"
    } ${isLight ? "hover:bg-slate-50" : "hover:bg-slate-800"}`;
  const iconBtn = `h-9 w-9 flex items-center justify-center rounded-md border transition-colors ${
    isLight ? "border-slate-200 text-slate-600 hover:bg-slate-50 hover:text-slate-900" : "border-slate-700 text-slate-300 hover:bg-slate-800"
  }`;

  return (
    <header
      ref={rootRef}
      className={`w-full relative z-40 border-b ${isLight ? "bg-white border-slate-200 text-slate-900" : "bg-[#0F172A] border-slate-800 text-white"}`}
    >
      <div className="px-4 sm:px-6 h-14 flex items-center gap-4">
        {/* Brand + entity: never truncated */}
        <button
          type="button"
          onClick={() => onSelectView("home")}
          className="flex items-center gap-3 flex-shrink-0 text-left"
          aria-label="Aether Sovereign dashboard"
        >
          <span className="w-8 h-8 rounded-md bg-[#0A2540] text-[#E0F2FE] text-[11px] font-bold tracking-wider flex items-center justify-center">
            AS
          </span>
          <span className="leading-tight">
            <span className={`block text-[13px] font-semibold tracking-[0.08em] whitespace-nowrap ${isLight ? "text-[#0A2540]" : "text-white"}`}>
              AETHER SOVEREIGN
            </span>
            <span className={`hidden sm:block text-[12px] whitespace-nowrap ${isLight ? "text-slate-500" : "text-slate-400"}`}>{entity}</span>
          </span>
        </button>

        {/* Grouped navigation (desktop) */}
        <nav aria-label="Main" className="hidden lg:flex items-center gap-1 ml-4">
          {groups.map((g) => {
            const groupActive = g.items.some((i) => i.active && i.view);
            return (
              <div key={g.id} className="relative">
                <button
                  type="button"
                  aria-haspopup="menu"
                  aria-expanded={openMenu === g.id}
                  onClick={() => setOpenMenu(openMenu === g.id ? null : g.id)}
                  className={navBtn(groupActive)}
                >
                  {g.label}
                  <ChevronDown className="w-3.5 h-3.5 opacity-60" aria-hidden />
                </button>
                {openMenu === g.id && (
                  <div role="menu" aria-label={g.label} className={`${menuPanel} left-0`}>
                    {g.items.map((item) => (
                      <button
                        key={item.label}
                        type="button"
                        role={item.toggle ? "menuitemcheckbox" : "menuitem"}
                        aria-checked={item.toggle ? item.active : undefined}
                        aria-current={item.view && item.active ? "page" : undefined}
                        onClick={() => choose(item)}
                        className={menuItem(item.active)}
                      >
                        <span>{item.label}</span>
                        {item.active && <Check className="w-3.5 h-3.5 text-blue-600" aria-hidden />}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </nav>

        <div className="ml-auto flex items-center gap-2 flex-shrink-0">
          <button
            type="button"
            onClick={onOpenVrModal}
            className={`h-9 px-3 flex items-center gap-1.5 rounded-md border text-[13px] font-medium ${
              isLight ? "border-slate-200 text-slate-700 hover:bg-slate-50" : "border-slate-700 text-slate-200 hover:bg-slate-800"
            }`}
            aria-label="View in VR"
          >
            <Glasses className="w-4 h-4" aria-hidden />
            <span className="hidden sm:inline">VR</span>
          </button>

          <button
            type="button"
            onClick={onToggleTheme}
            aria-label={isLight ? "Switch to dark theme" : "Switch to light theme"}
            title={isLight ? "Dark theme" : "Light theme"}
            className={`${iconBtn} hidden sm:flex`}
          >
            {isLight ? <Moon className="w-4 h-4" /> : <Sun className="w-4 h-4" />}
          </button>

          {currentUser && (
            <div className="relative">
              <button
                type="button"
                aria-haspopup="menu"
                aria-expanded={openMenu === "user"}
                aria-label={`Account: ${displayName}`}
                onClick={() => setOpenMenu(openMenu === "user" ? null : "user")}
                className={`h-9 flex items-center gap-2 pl-1 pr-2 rounded-md border ${
                  isLight ? "border-slate-200 hover:bg-slate-50" : "border-slate-700 hover:bg-slate-800"
                }`}
              >
                <span className="w-7 h-7 rounded bg-[#0A2540] text-white text-[11px] font-semibold flex items-center justify-center">
                  {initials}
                </span>
                <span className="hidden xl:block text-[13px] max-w-[160px] truncate">{displayName}</span>
                <ChevronDown className="w-3.5 h-3.5 opacity-60" aria-hidden />
              </button>
              {openMenu === "user" && (
                <div role="menu" aria-label="Account" className={`${menuPanel} right-0 w-72`}>
                  <div className={`px-3 py-2.5 border-b ${isLight ? "border-slate-100" : "border-slate-800"}`}>
                    <div className="text-[13px] font-medium truncate">{currentUser.full_name}</div>
                    <div className="text-[12px] text-slate-500 truncate">{currentUser.email}</div>
                    <div className="text-[12px] text-slate-500 mt-1">
                      {entity} · {ROLE_LABEL[role]}
                    </div>
                  </div>
                  {onSelectEntity && (currentUser.memberships?.length || 0) > 1 && (
                    <div className={`py-1 border-b ${isLight ? "border-slate-100" : "border-slate-800"}`}>
                      <div className="px-3 pt-1 pb-0.5 text-[11px] font-semibold uppercase tracking-wide text-slate-500">Family entity</div>
                      {currentUser.memberships.map((m) => (
                        <button
                          key={m.family_entity_id}
                          type="button"
                          role="menuitemradio"
                          aria-checked={m.family_entity_id === selectedEntity}
                          onClick={() => {
                            onSelectEntity(m.family_entity_id);
                            setOpenMenu(null);
                          }}
                          className={menuItem(m.family_entity_id === selectedEntity)}
                        >
                          <span className="truncate">{m.entity_name || m.family_entity_id}</span>
                          {m.family_entity_id === selectedEntity && <Check className="w-3.5 h-3.5 text-blue-600" aria-hidden />}
                        </button>
                      ))}
                    </div>
                  )}
                  <button type="button" role="menuitem" onClick={onToggleTheme} className={`${menuItem(false)} sm:hidden`}>
                    {isLight ? "Dark theme" : "Light theme"}
                  </button>
                  {onSignOut && (
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        setOpenMenu(null);
                        onSignOut();
                      }}
                      className={`${menuItem(false)} !text-rose-600`}
                    >
                      <span>Sign out</span>
                      <LogOut className="w-3.5 h-3.5" aria-hidden />
                    </button>
                  )}
                </div>
              )}
            </div>
          )}

          <button
            type="button"
            onClick={() => setMobileOpen((v) => !v)}
            className={`${iconBtn} lg:hidden`}
            aria-label={mobileOpen ? "Close navigation menu" : "Open navigation menu"}
            aria-expanded={mobileOpen}
            aria-controls="mobile-nav"
          >
            {mobileOpen ? <X className="w-4 h-4" /> : <Menu className="w-4 h-4" />}
          </button>
        </div>
      </div>

      {mobileOpen && (
        <nav
          id="mobile-nav"
          aria-label="Main"
          className={`lg:hidden absolute top-full inset-x-0 border-b shadow-lg max-h-[calc(100vh-7rem)] overflow-y-auto ${
            isLight ? "bg-white border-slate-200" : "bg-[#0F172A] border-slate-800"
          }`}
        >
          <div className="px-4 py-3 grid gap-4 sm:grid-cols-3">
            {groups.map((g) => (
              <div key={g.id}>
                <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-500 mb-1">{g.label}</div>
                <ul>
                  {g.items.map((item) => (
                    <li key={item.label}>
                      <button
                        type="button"
                        onClick={() => choose(item)}
                        aria-current={item.view && item.active ? "page" : undefined}
                        className={`${menuItem(item.active)} rounded-md px-2`}
                      >
                        <span>{item.label}</span>
                        {item.active && <Check className="w-3.5 h-3.5 text-blue-600" aria-hidden />}
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </nav>
      )}
    </header>
  );
}
