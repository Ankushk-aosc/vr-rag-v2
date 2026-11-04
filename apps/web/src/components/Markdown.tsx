"use client";

import React, { memo } from "react";
import ReactMarkdown, { Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { citationLocation } from "../lib/citations";
import { CitationItem } from "../types";

interface MarkdownProps {
  text: string;
  citations?: CitationItem[];
  onCitationClick?: (c: CitationItem) => void;
  theme?: "dark" | "light";
  /** Show a blinking caret at the end while tokens are streaming. */
  streaming?: boolean;
}

/** Turn "[2]" citation markers into links the renderer can style as chips. */
function linkCitations(text: string): string {
  return text.replace(/\[(\d{1,2})\](?!\()/g, "[$1](#cite-$1)");
}

function MarkdownImpl({ text, citations = [], onCitationClick, theme = "light", streaming }: MarkdownProps) {
  const isLight = theme === "light";
  const byRef = new Map(citations.map((c, i) => [c.ref ?? i + 1, c]));

  const components: Components = {
    a({ href, children }) {
      if (href?.startsWith("#cite-")) {
        const ref = Number(href.slice(6));
        const c = byRef.get(ref);
        // Only markers that match a citation the backend returned become links; others stay plain text
        if (!c) return <span>[{ref}]</span>;
        return (
          <button
            type="button"
            onClick={() => onCitationClick?.(c)}
            title={`${c.document_name} · ${citationLocation(c)}`}
            aria-label={`Source ${ref}: ${c.document_name}, ${citationLocation(c)}`}
            className={`inline-flex items-center justify-center align-baseline mx-0.5 min-w-[1.25rem] h-[1.15rem] px-1 rounded text-[10px] font-semibold font-mono transition-colors ${
              isLight
                ? "bg-blue-50 text-blue-700 hover:bg-blue-100 border border-blue-200"
                : "bg-blue-950/60 text-blue-300 hover:bg-blue-900 border border-blue-800"
            }`}
          >
            {ref}
          </button>
        );
      }
      // U2: Enforce strict protocol validation. Only https:// links are clickable.
      // Prohibit javascript:, data:, file:, unencrypted http:, and invalid protocols.
      if (!href) return <span>{children}</span>;
      const isHttps = href.startsWith("https://");
      if (!isHttps) {
        return <span className="font-mono text-xs opacity-75">{children}</span>;
      }
      return (
        <a
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          className="underline decoration-dotted underline-offset-2"
        >
          {children}
        </a>
      );
    },
    h1: ({ children }) => <h3 className="text-[15px] font-semibold mt-3 mb-1.5">{children}</h3>,
    h2: ({ children }) => <h3 className="text-[14px] font-semibold mt-3 mb-1.5">{children}</h3>,
    h3: ({ children }) => (
      <h4
        className={`text-[11px] font-semibold uppercase tracking-wider mt-3.5 mb-1.5 ${
          isLight ? "text-slate-500" : "text-slate-400"
        }`}
      >
        {children}
      </h4>
    ),
    h4: ({ children }) => <h5 className="text-[12px] font-semibold mt-2 mb-1">{children}</h5>,
    p: ({ children }) => <p className="my-1.5 leading-relaxed">{children}</p>,
    strong: ({ children }) => (
      <strong className={`font-semibold ${isLight ? "text-black" : "text-white"}`}>{children}</strong>
    ),
    ul: ({ children }) => <ul className="my-1.5 pl-4 space-y-1 list-disc marker:text-[#8B5CF6]">{children}</ul>,
    ol: ({ children }) => <ol className="my-1.5 pl-4 space-y-1 list-decimal marker:text-[#8B5CF6]">{children}</ol>,
    li: ({ children }) => <li className="leading-relaxed pl-0.5">{children}</li>,
    table: ({ children }) => (
      <div
        className={`my-2.5 overflow-x-auto rounded-xl border ${isLight ? "border-black/10" : "border-white/10"}`}
      >
        <table className="w-full text-[12px] tabular-numbers border-collapse">{children}</table>
      </div>
    ),
    thead: ({ children }) => (
      <thead className={isLight ? "bg-slate-50" : "bg-white/[0.05]"}>{children}</thead>
    ),
    th: ({ children }) => (
      <th
        className={`text-left px-2.5 py-1.5 font-semibold text-[10.5px] uppercase tracking-wide ${
          isLight ? "text-black/60" : "text-white/60"
        }`}
      >
        {children}
      </th>
    ),
    td: ({ children }) => (
      <td className={`px-2.5 py-1.5 border-t font-mono ${isLight ? "border-black/5" : "border-white/5"}`}>
        {children}
      </td>
    ),
    code: ({ children }) => (
      <code className={`px-1 py-0.5 rounded text-[11.5px] font-mono ${isLight ? "bg-black/5" : "bg-white/10"}`}>
        {children}
      </code>
    ),
    blockquote: ({ children }) => (
      <blockquote className="border-l-2 border-[#8B5CF6]/60 pl-3 my-2 opacity-90">{children}</blockquote>
    ),
  };

  return (
    <div className={`aether-markdown text-[13px] ${streaming ? "aether-streaming" : ""}`}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {linkCitations(text)}
      </ReactMarkdown>
    </div>
  );
}

export const Markdown = memo(MarkdownImpl);
