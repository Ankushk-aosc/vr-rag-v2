"use client";

import React, { useEffect, useState } from "react";
import { FileText, FileSpreadsheet, Upload } from "lucide-react";
import { ChatMessage, CitationItem, DocumentRecord, AuditEvent } from "../types";
import { UserProfile } from "../lib/auth";
import { FamilyRole, can, entityName } from "../lib/roles";
import { fetchAuditEvents } from "../lib/api";
import { friendlyError } from "../lib/apiErrors";
import { DialogueThread } from "./DialogueThread";
import { EmptyState, ErrorState, SkeletonRows } from "./StateViews";
import { formatDateTime, humanizeAction, isTabularDoc } from "../lib/format";

interface HomeViewProps {
  theme: "light" | "dark";
  currentUser: UserProfile;
  selectedEntity: string;
  role: FamilyRole;
  messages: ChatMessage[];
  documents: DocumentRecord[];
  documentsLoading: boolean;
  documentsError: string | null;
  onRetryDocuments: () => void;
  prompts: string[];
  isProcessing: boolean;
  onSendMessage: (text: string) => void;
  onCitationClick: (c: CitationItem) => void;
  onSelectDocument: (doc: DocumentRecord) => void;
  onOpenUpload: () => void;
  onOpenLedger: () => void;
  onOpenAudit: () => void;
  onClearMessages: () => void;
  onSpeakMessage: (msg: ChatMessage) => void;
  onStopSpeaking: () => void;
  speakingMessageId: string | null;
  /** The Ask Aether input, rendered by the page so it shares the voice engine wiring. */
  askBar: React.ReactNode;
}

function greeting(d = new Date()) {
  const h = d.getHours();
  return h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
}

function Section({
  title,
  action,
  children,
  theme,
}: {
  title: string;
  action?: React.ReactNode;
  children: React.ReactNode;
  theme: "light" | "dark";
}) {
  return (
    <section aria-label={title}>
      <div className={`flex items-center justify-between gap-3 pb-2 mb-3 border-b ${theme === "light" ? "border-slate-200" : "border-slate-800"}`}>
        <h2 className="text-[16px] font-semibold">{title}</h2>
        {action}
      </div>
      {children}
    </section>
  );
}

function RecentActivity({
  entityId,
  role,
  theme,
  onOpenAudit,
}: {
  entityId: string;
  role: FamilyRole;
  theme: "light" | "dark";
  onOpenAudit: () => void;
}) {
  const [events, setEvents] = useState<AuditEvent[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const ctrl = new AbortController();
    setEvents(null);
    setError(null);
    // Admins read the entity trail; everyone else gets their own events, kept to this entity only.
    const scoped = can.viewEntityAudit(role) ? entityId : undefined;
    fetchAuditEvents(scoped, ctrl.signal)
      .then((all) => setEvents(all.filter((e) => !e.family_entity_id || e.family_entity_id === entityId).slice(0, 6)))
      .catch((err) => {
        if (!ctrl.signal.aborted) setError(friendlyError(err, "load recent activity").body);
      });
    return () => ctrl.abort();
  }, [entityId, role, attempt]);

  const muted = theme === "light" ? "text-slate-500" : "text-slate-400";
  if (error) return <ErrorState theme={theme} title="Recent activity is unavailable" body={error} onRetry={() => setAttempt((n) => n + 1)} compact />;
  if (!events) return <SkeletonRows rows={4} theme={theme} />;
  if (!events.length)
    return <p className={`text-[13px] ${muted}`}>No recorded activity for this entity yet.</p>;
  return (
    <>
      <ul className="space-y-2.5">
        {events.map((e) => (
          <li key={e.id} className="text-[13px]">
            <div className="font-medium">{humanizeAction(e.action)}</div>
            <div className={`text-[12px] ${muted}`}>{formatDateTime(e.timestamp)}</div>
          </li>
        ))}
      </ul>
      {can.viewEntityAudit(role) && (
        <button type="button" onClick={onOpenAudit} className="mt-3 text-[13px] font-medium text-blue-700 dark:text-blue-400 hover:underline">
          View audit trail
        </button>
      )}
    </>
  );
}

export function HomeView({
  theme,
  currentUser,
  selectedEntity,
  role,
  messages,
  documents,
  documentsLoading,
  documentsError,
  onRetryDocuments,
  prompts,
  isProcessing,
  onSendMessage,
  onCitationClick,
  onSelectDocument,
  onOpenUpload,
  onOpenLedger,
  onOpenAudit,
  onClearMessages,
  onSpeakMessage,
  onStopSpeaking,
  speakingMessageId,
  askBar,
}: HomeViewProps) {
  const isLight = theme === "light";
  const muted = isLight ? "text-slate-500" : "text-slate-400";
  const firstName = currentUser.full_name?.split(" ")[0] || "";
  const recentDocs = [...documents].sort((a, b) => (b.uploaded_at || "").localeCompare(a.uploaded_at || "")).slice(0, 6);

  return (
    <div className="max-w-6xl mx-auto px-4 sm:px-6 py-6 sm:py-8 pb-16">
      <div className="mb-6">
        <div className={`text-[13px] ${muted}`}>{entityName(currentUser, selectedEntity)}</div>
        <h1 className="text-[24px] sm:text-[26px] font-semibold tracking-tight mt-0.5">
          {greeting()}
          {firstName ? `, ${firstName}` : ""}
        </h1>
        <p className={`text-[14px] mt-1 ${muted}`}>Financial intelligence grounded in your authorised records.</p>
      </div>

      <section aria-label="Ask Aether" className="mb-8">
        <h2 className="text-[16px] font-semibold mb-2">Ask Aether</h2>
        {askBar}
        {prompts.length > 0 && !messages.length && (
          <div className="mt-3 flex flex-wrap items-baseline gap-x-4 gap-y-1.5 text-[13px]">
            <span className={muted}>Suggested from your documents:</span>
            {prompts.slice(0, 3).map((p) => (
              <button
                key={p}
                type="button"
                disabled={isProcessing}
                onClick={() => onSendMessage(p)}
                className="text-left text-blue-700 dark:text-blue-400 hover:underline disabled:opacity-50"
              >
                {p}
              </button>
            ))}
          </div>
        )}
      </section>

      <div className="grid gap-8 lg:grid-cols-3">
        <div className="lg:col-span-2 min-w-0">
          <Section
            title="Recent intelligence"
            theme={theme}
            action={
              messages.length > 0 ? (
                <button type="button" onClick={onClearMessages} className={`text-[13px] ${muted} hover:text-slate-900`}>
                  Clear
                </button>
              ) : undefined
            }
          >
            {messages.length ? (
              <DialogueThread
                messages={messages}
                theme={theme}
                onCitationClick={onCitationClick}
                onSpeakMessage={onSpeakMessage}
                onStopSpeaking={onStopSpeaking}
                speakingMessageId={speakingMessageId}
              />
            ) : (
              <EmptyState
                theme={theme}
                title="No questions asked in this session"
                body={
                  documents.length || documentsLoading || documentsError
                    ? "Ask a question above. Each answer lists the documents, pages and sheets it relies on."
                    : "Upload financial records first. Aether answers only from documents authorised for this family entity."
                }
              />
            )}
          </Section>
        </div>

        <div className="space-y-8 min-w-0">
          <Section
            title="Recent documents"
            theme={theme}
            action={
              documents.length > 0 ? (
                <button type="button" onClick={onOpenLedger} className="text-[13px] font-medium text-blue-700 dark:text-blue-400 hover:underline">
                  View all ({documents.length})
                </button>
              ) : undefined
            }
          >
            {documentsError ? (
              <ErrorState theme={theme} title="Documents are unavailable" body={documentsError} onRetry={onRetryDocuments} compact />
            ) : documentsLoading ? (
              <SkeletonRows rows={4} theme={theme} />
            ) : recentDocs.length ? (
              <ul className="space-y-1">
                {recentDocs.map((d) => {
                  const Icon = isTabularDoc(d) ? FileSpreadsheet : FileText;
                  return (
                    <li key={d.id}>
                      <button
                        type="button"
                        onClick={() => onSelectDocument(d)}
                        className={`w-full flex items-start gap-2.5 rounded-md px-2 py-1.5 -mx-2 text-left ${isLight ? "hover:bg-slate-100" : "hover:bg-slate-800"}`}
                      >
                        <Icon className={`w-4 h-4 mt-0.5 flex-shrink-0 ${muted}`} aria-hidden />
                        <span className="min-w-0">
                          <span className="block text-[13px] font-medium truncate">{d.original_name}</span>
                          <span className={`block text-[12px] ${muted}`}>{formatDateTime(d.uploaded_at)}</span>
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <EmptyState
                theme={theme}
                title="No authorised documents yet"
                body="Upload financial records to begin building your family-office knowledge base."
                action={
                  can.upload(role) ? (
                    <button
                      type="button"
                      onClick={onOpenUpload}
                      className="inline-flex items-center gap-1.5 h-9 px-3 rounded-md bg-[#2563EB] text-white text-[13px] font-medium hover:bg-[#1D4ED8]"
                    >
                      <Upload className="w-4 h-4" aria-hidden /> Upload documents
                    </button>
                  ) : (
                    <p className={`text-[12px] ${muted}`}>Your role is read-only. A family admin or member can add documents.</p>
                  )
                }
                compact
              />
            )}
          </Section>

          <Section title="Recent activity" theme={theme}>
            <RecentActivity entityId={selectedEntity} role={role} theme={theme} onOpenAudit={onOpenAudit} />
          </Section>
        </div>
      </div>
    </div>
  );
}
