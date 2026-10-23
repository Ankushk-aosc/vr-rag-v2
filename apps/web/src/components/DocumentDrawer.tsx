"use client";

import React, { useRef, useState } from "react";
import {
  FileText,
  Upload,
  X,
  CheckCircle2,
  AlertCircle,
  Loader2,
  Lock,
  Users,
  HardDrive,
} from "lucide-react";
import { DocumentRecord } from "../types";
import { uploadDocument } from "../lib/api";

interface DocumentDrawerProps {
  isOpen: boolean;
  onClose: () => void;
  documents: DocumentRecord[];
  onDocumentUploaded: () => void;
  selectedEntity: string;
}

export function DocumentDrawer({
  isOpen,
  onClose,
  documents,
  onDocumentUploaded,
  selectedEntity,
}: DocumentDrawerProps) {
  const [isUploading, setIsUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [uploadSuccess, setUploadSuccess] = useState<string | null>(null);
  const [allowedRole, setAllowedRole] = useState("family_member");
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  if (!isOpen) return null;

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

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

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/60 backdrop-blur-sm animate-in fade-in duration-200">
      <div className="w-full max-w-lg aurora-glass border-l border-aurora-cyan/30 h-full flex flex-col shadow-2xl">
        {/* Drawer Header */}
        <div className="p-5 border-b border-aurora-border/40 flex items-center justify-between bg-aurora-panel/90">
          <div className="flex items-center space-x-2.5">
            <HardDrive className="w-5 h-5 text-aurora-cyan" />
            <div>
              <h2 className="font-space font-bold text-white text-base">
                Australian Financial Documents
              </h2>
              <p className="text-xs text-aurora-muted">
                Authorized Vault for {selectedEntity}
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="text-aurora-muted hover:text-white p-1 rounded-lg transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Content Area */}
        <div className="flex-1 overflow-y-auto p-5 space-y-6">
          {/* Upload Area */}
          <div className="aurora-glass-interactive rounded-xl p-5 border-dashed border-2 border-aurora-cyan/40 text-center space-y-3">
            <div className="flex justify-center">
              <div className="w-12 h-12 rounded-full bg-aurora-cyan/15 flex items-center justify-center text-aurora-cyan shadow-cyan-glow">
                <Upload className="w-6 h-6" />
              </div>
            </div>

            <div>
              <h3 className="font-space font-semibold text-white text-sm">
                Upload Australian Financial Document
              </h3>
              <p className="text-xs text-aurora-muted mt-1">
                PDF (ATO Notices, Super Statements, Bank Records), DOCX, XLSX
              </p>
            </div>

            {/* Role Permissions Tag */}
            <div className="flex items-center justify-center space-x-2 text-xs font-space pt-2">
              <span className="text-aurora-muted">Access Scope:</span>
              <select
                value={allowedRole}
                onChange={(e) => setAllowedRole(e.target.value)}
                className="bg-aurora-panel text-white text-xs border border-aurora-border rounded px-2 py-1 focus:outline-none"
              >
                <option value="family_member">Family-Wide (All Members)</option>
                <option value="family_admin">Admin-Only (Restricted)</option>
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
              className={`inline-flex items-center space-x-2 px-4 py-2 rounded-lg font-space text-xs font-bold uppercase tracking-wider text-black bg-aurora-cyan hover:bg-aurora-cyan/90 cursor-pointer shadow-cyan-glow transition-all ${
                isUploading ? "opacity-50 cursor-not-allowed" : ""
              }`}
            >
              {isUploading ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin text-black" />
                  <span>Processing & Indexing...</span>
                </>
              ) : (
                <>
                  <Upload className="w-4 h-4 text-black" />
                  <span>Select Financial File</span>
                </>
              )}
            </label>

            {/* Status alerts */}
            {uploadError && (
              <div className="flex items-center space-x-2 text-red-400 text-xs bg-red-950/40 p-2.5 rounded-lg border border-red-500/30">
                <AlertCircle className="w-4 h-4 flex-shrink-0" />
                <span>{uploadError}</span>
              </div>
            )}
            {uploadSuccess && (
              <div className="flex items-center space-x-2 text-green-400 text-xs bg-green-950/40 p-2.5 rounded-lg border border-green-500/30">
                <CheckCircle2 className="w-4 h-4 flex-shrink-0" />
                <span>{uploadSuccess}</span>
              </div>
            )}
          </div>

          {/* Indexed Documents List */}
          <div className="space-y-3">
            <h4 className="font-space font-semibold text-xs text-aurora-muted uppercase tracking-wider flex items-center justify-between">
              <span>Indexed Vault Records</span>
              <span className="text-aurora-cyan">{documents.length} File(s)</span>
            </h4>

            {documents.length === 0 ? (
              <div className="text-center py-10 text-aurora-muted text-xs border border-aurora-border/30 rounded-xl bg-aurora-panel/40">
                No financial documents uploaded yet. Upload a tax notice or bank statement above to begin evidence-grounded queries.
              </div>
            ) : (
              <div className="space-y-2">
                {documents.map((doc) => (
                  <div
                    key={doc.id}
                    className="p-3 rounded-lg bg-aurora-void/70 border border-aurora-border/40 hover:border-aurora-cyan/40 transition-colors flex items-center justify-between"
                  >
                    <div className="flex items-center space-x-3 truncate">
                      <div className="w-8 h-8 rounded bg-aurora-cyan/10 flex items-center justify-center flex-shrink-0">
                        <FileText className="w-4 h-4 text-aurora-cyan" />
                      </div>
                      <div className="truncate">
                        <p className="font-space text-xs font-semibold text-white truncate" title={doc.original_name}>
                          {doc.original_name}
                        </p>
                        <p className="text-[11px] text-aurora-muted">
                          {doc.total_pages} page(s) • {(doc.file_size / 1024).toFixed(1)} KB
                        </p>
                      </div>
                    </div>
                    <span className="text-[10px] font-space uppercase px-2 py-0.5 rounded bg-green-500/15 text-green-400 border border-green-500/30 flex-shrink-0">
                      Indexed
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Drawer Footer */}
        <div className="p-4 border-t border-aurora-border/40 bg-aurora-panel/80 text-[11px] text-aurora-muted text-center font-sans">
          Documents remain strictly local in SQLite. Only anonymous vector coordinates are indexed in Pinecone.
        </div>
      </div>
    </div>
  );
}
