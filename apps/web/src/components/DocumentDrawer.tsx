"use client";

import React, { useRef, useState } from "react";
import {
  FileText,
  Upload,
  X,
  CheckCircle2,
  AlertCircle,
  Loader2,
  ShieldCheck,
  FolderLock,
} from "lucide-react";
import { DocumentRecord } from "../types";
import { uploadDocument } from "../lib/api";

interface DocumentDrawerProps {
  isOpen: boolean;
  onClose: () => void;
  documents: DocumentRecord[];
  onDocumentUploaded: () => void;
  selectedEntity: string;
  theme?: "dark" | "light";
}

export function DocumentDrawer({
  isOpen,
  onClose,
  documents,
  onDocumentUploaded,
  selectedEntity,
  theme = "dark",
}: DocumentDrawerProps) {
  const [isUploading, setIsUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [uploadSuccess, setUploadSuccess] = useState<string | null>(null);
  const [allowedRole, setAllowedRole] = useState("family_member");
  const [isDragging, setIsDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  if (!isOpen) return null;
  const isLight = theme === "light";

  const handleProcessFile = async (file: File) => {
    setIsUploading(true);
    setUploadError(null);
    setUploadSuccess(null);

    try {
      const res = await uploadDocument(file, selectedEntity, allowedRole);
      setUploadSuccess(`Indexed "${file.name}" successfully across ${res.document.total_pages} page(s).`);
      onDocumentUploaded();
      if (fileInputRef.current) fileInputRef.current.value = "";
    } catch (err: any) {
      setUploadError(err.message || "Upload failed.");
    } finally {
      setIsUploading(false);
    }
  };

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) handleProcessFile(file);
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  };

  const handleDragLeave = () => {
    setIsDragging(false);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    const file = e.dataTransfer.files?.[0];
    if (file) handleProcessFile(file);
  };

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/75 backdrop-blur-md animate-in fade-in duration-200">
      <div
        className={`w-full max-w-lg apple-glass border-l h-full flex flex-col shadow-2xl transition-all ${
          isLight ? "bg-white/95 border-black/10 text-black shadow-xl" : "border-white/10 text-white"
        }`}
      >
        {/* Apple Drawer Header */}
        <div
          className={`px-6 py-5 border-b flex items-center justify-between ${
            isLight ? "border-black/10 bg-black/[0.02]" : "border-white/10 bg-black/40"
          }`}
        >
          <div className="flex items-center space-x-3">
            <div className="w-9 h-9 rounded-2xl bg-[#7C3AED]/15 border border-[#7C3AED]/30 flex items-center justify-center">
              <FolderLock className={`w-4 h-4 ${isLight ? "text-[#6D28D9]" : "text-[#A78BFA]"}`} />
            </div>
            <div>
              <h2 className="text-base font-semibold tracking-tight">
                Australian Wealth Repository
              </h2>
              <p className={`text-xs ${isLight ? "text-black/50" : "text-white/50"}`}>
                Entity Vault:{" "}
                <span className={`font-semibold ${isLight ? "text-[#6D28D9]" : "text-[#A78BFA]"}`}>
                  {selectedEntity}
                </span>
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            aria-label="Close drawer"
            className={`p-2 rounded-full transition-colors ${
              isLight ? "text-black/60 hover:text-black hover:bg-black/5" : "text-white/60 hover:text-white hover:bg-white/10"
            }`}
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Content Area */}
        <div className="flex-1 overflow-y-auto p-6 space-y-6">
          {/* Upload Dropzone */}
          <div
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
            className={`rounded-3xl p-6 border-2 border-dashed transition-all text-center space-y-3.5 ${
              isDragging
                ? "bg-[#7C3AED]/10 border-[#7C3AED] scale-[1.01]"
                : isLight
                ? "bg-black/[0.02] hover:bg-black/[0.04] border-black/10 hover:border-black/20"
                : "bg-white/[0.02] hover:bg-white/[0.04] border-white/10 hover:border-white/20"
            }`}
          >
            <div className="flex justify-center">
              <div
                className={`w-12 h-12 rounded-2xl border flex items-center justify-center ${
                  isLight
                    ? "bg-[#6D28D9]/10 border-[#6D28D9]/20 text-[#6D28D9]"
                    : "bg-[#7C3AED]/15 border-[#7C3AED]/30 text-[#A78BFA]"
                }`}
              >
                <Upload className="w-6 h-6" />
              </div>
            </div>

            <div className="space-y-1">
              <h3 className="text-sm font-semibold tracking-tight">
                Deposit Financial Document
              </h3>
              <p className={`text-xs max-w-xs mx-auto ${isLight ? "text-black/50" : "text-white/50"}`}>
                ATO Notices of Assessment, Super Statements, Macquarie Wrap PDFs, DOCX, or XLSX
              </p>
            </div>

            {/* Access Permission Scope */}
            <div className="flex items-center justify-center space-x-2 text-xs pt-2">
              <span className={`font-medium ${isLight ? "text-black/50" : "text-white/40"}`}>
                Access Scope:
              </span>
              <select
                value={allowedRole}
                onChange={(e) => setAllowedRole(e.target.value)}
                className={`text-xs border rounded-xl px-3 py-1.5 focus:outline-none ${
                  isLight
                    ? "bg-white border-black/10 text-black"
                    : "bg-[#1A1A22] border-white/10 text-white"
                }`}
              >
                <option value="family_member">Family-Wide (All Verified Members)</option>
                <option value="family_admin">Restricted (Trustee / Admin Only)</option>
              </select>
            </div>

            <input
              ref={fileInputRef}
              type="file"
              accept=".pdf,.docx,.doc,.xlsx,.xls,.txt"
              onChange={handleFileChange}
              disabled={isUploading}
              className="hidden"
              id="doc-upload-input"
            />

            <label
              htmlFor="doc-upload-input"
              className={`inline-flex items-center space-x-2 px-5 py-2.5 rounded-full text-xs font-semibold cursor-pointer shadow-md transition-all active:scale-95 ${
                isLight
                  ? "bg-[#581C87] text-white hover:bg-[#4C1D95]"
                  : "bg-white text-black hover:bg-white/90"
              } ${isUploading ? "opacity-40 cursor-not-allowed" : ""}`}
            >
              {isUploading ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  <span>Parsing & Chunking Document...</span>
                </>
              ) : (
                <>
                  <Upload className="w-4 h-4" />
                  <span>Select Financial File</span>
                </>
              )}
            </label>

            {/* Upload Feedback */}
            {uploadError && (
              <div className="flex items-center space-x-2 text-red-500 text-xs bg-red-500/10 p-3 rounded-2xl border border-red-500/30 text-left">
                <AlertCircle className="w-4 h-4 flex-shrink-0" />
                <span>{uploadError}</span>
              </div>
            )}
            {uploadSuccess && (
              <div className="flex items-center space-x-2 text-green-500 text-xs bg-green-500/10 p-3 rounded-2xl border border-green-500/30 text-left">
                <CheckCircle2 className="w-4 h-4 flex-shrink-0" />
                <span>{uploadSuccess}</span>
              </div>
            )}
          </div>

          {/* Indexed Documents Ledger */}
          <div className="space-y-3">
            <div className="flex items-center justify-between text-xs">
              <span className={`font-semibold uppercase tracking-wider text-[11px] ${isLight ? "text-black/50" : "text-white/50"}`}>
                Authorized Entity Records
              </span>
              <span className={`font-mono text-[11px] ${isLight ? "text-[#6D28D9]" : "text-[#A78BFA]"}`}>
                {documents.length} File(s)
              </span>
            </div>

            {documents.length === 0 ? (
              <div className={`text-center py-12 text-xs border rounded-2xl ${isLight ? "border-black/5 bg-black/[0.01] text-black/40" : "border-white/5 bg-white/[0.01] text-white/40"}`}>
                No financial documents in this vault yet. Deposit a tax statement or portfolio report to enable evidence retrieval.
              </div>
            ) : (
              <div className="space-y-2">
                {documents.map((doc) => (
                  <div
                    key={doc.id}
                    className={`p-3.5 rounded-2xl border transition-all flex items-center justify-between ${
                      isLight
                        ? "bg-black/[0.02] hover:bg-black/[0.04] border-black/5"
                        : "bg-white/[0.02] hover:bg-white/[0.05] border-white/5"
                    }`}
                  >
                    <div className="flex items-center space-x-3 truncate">
                      <div className={`w-9 h-9 rounded-xl flex items-center justify-center flex-shrink-0 ${isLight ? "bg-[#6D28D9]/10" : "bg-white/5"}`}>
                        <FileText className={`w-4 h-4 ${isLight ? "text-[#6D28D9]" : "text-[#A78BFA]"}`} />
                      </div>
                      <div className="truncate">
                        <p className="text-xs font-semibold truncate" title={doc.original_name}>
                          {doc.original_name}
                        </p>
                        <p className={`text-[11px] ${isLight ? "text-black/40" : "text-white/40"}`}>
                          {doc.total_pages} page(s) • {(doc.file_size / 1024).toFixed(1)} KB
                        </p>
                      </div>
                    </div>
                    <span className={`text-[10px] font-medium px-2.5 py-0.5 rounded-full border flex-shrink-0 ${
                      isLight
                        ? "bg-[#6D28D9]/10 text-[#6D28D9] border-[#6D28D9]/30"
                        : "bg-[#7C3AED]/20 text-[#A78BFA] border-[#7C3AED]/40"
                    }`}>
                      Verified
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Apple Drawer Footer */}
        <div className={`p-4 border-t text-[11px] text-center flex items-center justify-center space-x-1.5 ${isLight ? "border-black/10 bg-black/[0.02] text-black/50" : "border-white/10 bg-black/40 text-white/40"}`}>
          <ShieldCheck className={`w-3.5 h-3.5 flex-shrink-0 ${isLight ? "text-[#6D28D9]" : "text-[#A78BFA]"}`} />
          <span>APP 8 Compliant: Local SQLite storage with anonymous Pinecone vector coordinates.</span>
        </div>
      </div>
    </div>
  );
}
