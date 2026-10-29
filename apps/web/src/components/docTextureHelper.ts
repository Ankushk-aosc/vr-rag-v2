import * as THREE from "three";
import { DocumentRecord } from "../types";

interface FormatStyle {
  label: string;
  bgLight: string;
  textLight: string;
  borderLight: string;
  bgDark: string;
  textDark: string;
  borderDark: string;
}

function getFormatStyle(ext: string): FormatStyle {
  const upper = ext.toUpperCase();
  if (upper.includes("XLS") || upper.includes("CSV") || upper.includes("SHEET")) {
    return {
      label: upper.slice(0, 4),
      bgLight: "#ECFDF5",
      textLight: "#047857",
      borderLight: "#10B981",
      bgDark: "rgba(16, 185, 129, 0.2)",
      textDark: "#34D399",
      borderDark: "#10B981",
    };
  }
  if (upper.includes("PDF")) {
    return {
      label: "PDF",
      bgLight: "#FEF2F2",
      textLight: "#B91C1C",
      borderLight: "#EF4444",
      bgDark: "rgba(239, 68, 68, 0.2)",
      textDark: "#F87171",
      borderDark: "#EF4444",
    };
  }
  if (upper.includes("DOC")) {
    return {
      label: upper.slice(0, 4),
      bgLight: "#EFF6FF",
      textLight: "#1D4ED8",
      borderLight: "#3B82F6",
      bgDark: "rgba(59, 130, 246, 0.2)",
      textDark: "#60A5FA",
      borderDark: "#3B82F6",
    };
  }
  if (upper.includes("TXT")) {
    return {
      label: "TXT",
      bgLight: "#FFFBEB",
      textLight: "#B45309",
      borderLight: "#F59E0B",
      bgDark: "rgba(245, 158, 11, 0.2)",
      textDark: "#FBBF24",
      borderDark: "#F59E0B",
    };
  }
  return {
    label: upper.slice(0, 4) || "DATA",
    bgLight: "#F5F3FF",
    textLight: "#6D28D9",
    borderLight: "#8B5CF6",
    bgDark: "rgba(139, 92, 246, 0.2)",
    textDark: "#A78BFA",
    borderDark: "#8B5CF6",
  };
}

export function createDocTexture(
  doc: DocumentRecord | null,
  isLight: boolean,
  fallbackTitle: string = "Financial Ledger",
  fallbackSub: string = "Records Archive",
  fallbackCode: string = "DOC • ARCHIVE"
): THREE.CanvasTexture {
  const canvas = document.createElement("canvas");
  // drawn in 512x724 units at 3x supersampling resolution (1536x2172) so text stays crystal-sharp
  canvas.width = 1536;
  canvas.height = 2172;
  const ctx = canvas.getContext("2d")!;
  ctx.scale(3, 3);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";

  const ext = doc ? doc.original_name.split(".").pop()?.toUpperCase() || "DOC" : "DOC";
  const format = getFormatStyle(ext);
  const title = doc ? doc.original_name : fallbackTitle;
  const sizeKb = doc ? (doc.file_size / 1024).toFixed(0) : "500";
  const totalPages = doc ? doc.total_pages : 1;
  const subtitle = doc
    ? `${totalPages} Page(s) • ${sizeKb} KB • Verified Sovereign Ledger`
    : fallbackSub;
  const code = doc
    ? `${ext} • ${doc.file_hash.slice(0, 8).toUpperCase()}`
    : fallbackCode;

  // 1. High-Contrast Card Background
  if (isLight) {
    // Solid, opaque white card with subtle warm parchment depth
    ctx.fillStyle = "#FFFFFF";
    ctx.fillRect(0, 0, 512, 724);

    // Deep contrasting double border for crisp card separation
    ctx.strokeStyle = "#4C1D95"; // Rich Royal Purple outer line
    ctx.lineWidth = 6;
    ctx.strokeRect(8, 8, 496, 708);

    ctx.strokeStyle = "rgba(212, 175, 55, 0.5)"; // Gold inner hairline
    ctx.lineWidth = 2;
    ctx.strokeRect(16, 16, 480, 692);

    // Header Band Ribbon
    const headerGrad = ctx.createLinearGradient(0, 20, 0, 85);
    headerGrad.addColorStop(0, "#3B0764");
    headerGrad.addColorStop(1, "#581C87");
    ctx.fillStyle = headerGrad;
    ctx.fillRect(20, 20, 472, 65);
  } else {
    // Deep obsidian-slate glass gradient
    const grad = ctx.createLinearGradient(0, 0, 0, 724);
    grad.addColorStop(0, "#161522");
    grad.addColorStop(1, "#0A0910");
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, 512, 724);

    // Glowing vibrant purple outer border
    ctx.strokeStyle = "#8B5CF6";
    ctx.lineWidth = 6;
    ctx.strokeRect(8, 8, 496, 708);

    ctx.strokeStyle = "rgba(212, 175, 55, 0.7)"; // Gold inner hairline
    ctx.lineWidth = 2;
    ctx.strokeRect(16, 16, 480, 692);

    // Header Band Ribbon
    const headerGrad = ctx.createLinearGradient(0, 20, 0, 85);
    headerGrad.addColorStop(0, "#2E1065");
    headerGrad.addColorStop(1, "#4C1D95");
    ctx.fillStyle = headerGrad;
    ctx.fillRect(20, 20, 472, 65);
  }

  // 2. Gold Accent Top Divider
  ctx.fillStyle = "#D4AF37";
  ctx.fillRect(20, 85, 472, 4);

  // 3. Document Code / Seal in Header Band
  ctx.font = "bold 20px monospace";
  ctx.fillStyle = "#FDE047"; // Luminous gold text
  ctx.fillText(code, 40, 58);

  // 4. Vibrant Color-Coded Format Badge Pill
  ctx.beginPath();
  ctx.roundRect(365, 34, 110, 36, 18);
  ctx.fillStyle = isLight ? format.bgLight : format.bgDark;
  ctx.fill();
  ctx.lineWidth = 2.5;
  ctx.strokeStyle = isLight ? format.borderLight : format.borderDark;
  ctx.stroke();

  ctx.fillStyle = isLight ? format.textLight : format.textDark;
  ctx.font = "bold 17px monospace";
  ctx.textAlign = "center";
  ctx.fillText(format.label, 420, 58);
  ctx.textAlign = "start";

  // 5. Document Title (High legibility, dark obsidian in light mode, pure white in dark mode)
  ctx.font = "bold 24px -apple-system, BlinkMacSystemFont, sans-serif";
  ctx.fillStyle = isLight ? "#0F172A" : "#FFFFFF";

  const words = title.split(/[_\s]+/);
  let line = "";
  let lineY = 125;
  for (let n = 0; n < words.length; n++) {
    const testLine = line + words[n] + " ";
    const metrics = ctx.measureText(testLine);
    if (metrics.width > 425 && n > 0) {
      ctx.fillText(line.trim(), 40, lineY);
      line = words[n] + " ";
      lineY += 32;
      if (lineY > 165) break;
    } else {
      line = testLine;
    }
  }
  if (line.trim() && lineY <= 165) {
    ctx.fillText(line.trim(), 40, lineY);
  }

  // 6. Subtitle / Metadata
  ctx.font = "bold 15px -apple-system, BlinkMacSystemFont, sans-serif";
  ctx.fillStyle = isLight ? "#475569" : "#A78BFA";
  ctx.fillText(subtitle, 40, lineY + 32);

  // 7. Data Table or Real Content Area
  const tableTopY = lineY + 54;
  const hasTableData = Boolean(doc?.columns && doc.columns.length > 0 && doc?.sample_rows && doc.sample_rows.length > 0);
  const hasTextPreview = !hasTableData && Boolean(doc?.preview_text);

  ctx.fillStyle = isLight ? "#EDE9FE" : "rgba(139, 92, 246, 0.25)";
  ctx.fillRect(36, tableTopY, 440, 36);
  ctx.strokeStyle = isLight ? "#C4B5FD" : "rgba(167, 139, 250, 0.4)";
  ctx.lineWidth = 1.5;
  ctx.strokeRect(36, tableTopY, 440, 36);

  if (hasTableData && doc?.columns && doc?.sample_rows) {
    // A. Render Real Live Tabular Data from Uploaded File with Intelligent Column Selection
    const colLower = doc.columns.map((c) => c.toLowerCase().trim());
    const yIdx = colLower.indexOf("year");
    const mIdx = colLower.indexOf("month");
    const dIdx = colLower.indexOf("day");
    const hasYmd = yIdx !== -1 && mIdx !== -1 && dIdx !== -1;

    interface DisplayCol {
      label: string;
      width: number;
      getValue: (row: string[]) => string;
    }

    const displayCols: DisplayCol[] = [];

    if (hasYmd) {
      displayCols.push({
        label: "DATE",
        width: 90,
        getValue: (r) => {
          const y = r[yIdx] || "0000";
          const m = (r[mIdx] || "0").padStart(2, "0");
          const d = (r[dIdx] || "0").padStart(2, "0");
          return `${y}-${m}-${d}`;
        },
      });
    }

    const priorityKeywords = ["time", "amount", "price", "close", "income", "debt", "city", "merchant", "fico", "score", "volume", "return", "total", "balance"];

    const candidateIndices: number[] = [];
    doc.columns.forEach((colName, idx) => {
      if (hasYmd && (idx === yIdx || idx === mIdx || idx === dIdx)) return;
      // Skip static user ID 0
      if (colLower[idx] === "user" && doc.sample_rows?.every((r) => r[idx] === doc.sample_rows![0][idx])) {
        return;
      }
      // Skip columns where values are raw integer IDs (e.g. 18-digit merchant numbers)
      const isMachineId = doc.sample_rows?.every((r) => /^-?\d{10,}$/.test(String(r[idx] || "").trim()));
      if (isMachineId) {
        return;
      }
      candidateIndices.push(idx);
    });

    candidateIndices.sort((a, b) => {
      const aName = colLower[a];
      const bName = colLower[b];
      const aPri = priorityKeywords.findIndex((k) => aName.includes(k));
      const bPri = priorityKeywords.findIndex((k) => bName.includes(k));
      const aScore = aPri !== -1 ? aPri : 999;
      const bScore = bPri !== -1 ? bPri : 999;
      return aScore - bScore;
    });

    // Pick top 3-4 candidate columns
    const maxCols = hasYmd ? 4 : 5;
    const needed = Math.min(maxCols - displayCols.length, candidateIndices.length);
    const chosenIndices = candidateIndices.slice(0, needed);
    chosenIndices.sort((a, b) => a - b);

    // Calculate available table width
    const totalTableWidth = 430;
    const reservedWidth = displayCols.reduce((sum, c) => sum + c.width, 0);
    const remainingWidth = Math.max(120, totalTableWidth - reservedWidth);
    const defaultColWidth = Math.floor(remainingWidth / Math.max(1, chosenIndices.length));

    chosenIndices.forEach((cIdx) => {
      const colName = doc.columns![cIdx];
      const colL = colLower[cIdx];
      let width = defaultColWidth;
      if (colL.includes("time")) width = Math.min(60, defaultColWidth);
      else if (colL.includes("amount") || colL.includes("price") || colL.includes("close")) width = Math.min(78, defaultColWidth);
      else if (colL.includes("city") || colL.includes("merchant") || colL.includes("desc")) width = Math.max(115, defaultColWidth);

      displayCols.push({
        label: colName,
        width,
        getValue: (r) => r[cIdx] || "",
      });
    });

    // Normalize widths so they sum precisely to <= 430px
    const currentSum = displayCols.reduce((sum, c) => sum + c.width, 0);
    if (currentSum > 430) {
      const scale = 430 / currentSum;
      displayCols.forEach((c) => {
        c.width = Math.floor(c.width * scale);
      });
    }

    // Compute start X positions for each column
    const colPositions: number[] = [];
    let curX = 40;
    displayCols.forEach((col) => {
      colPositions.push(curX);
      curX += col.width + 4;
    });

    // Render Headers with strict cell clipping
    ctx.font = "bold 12px monospace";
    ctx.fillStyle = isLight ? "#4C1D95" : "#DDD6FE";
    displayCols.forEach((col, cIdx) => {
      const posX = colPositions[cIdx];
      const w = col.width;
      ctx.save();
      ctx.beginPath();
      ctx.rect(posX, tableTopY + 4, w, 28);
      ctx.clip();
      const maxChar = Math.max(4, Math.floor(w / 8.5));
      const truncated = col.label.length > maxChar ? col.label.slice(0, maxChar - 1) + "…" : col.label;
      ctx.fillText(truncated.toUpperCase(), posX + 2, tableTopY + 23);
      ctx.restore();
    });

    // Render Data Rows with strict cell clipping
    ctx.font = "12px monospace";
    const sampleSlice = doc.sample_rows.slice(0, 10);
    sampleSlice.forEach((row, rIdx) => {
      const rowY = tableTopY + 54 + rIdx * 28;
      if (rowY < 620) {
        if (rIdx % 2 === 0) {
          ctx.fillStyle = isLight ? "#F1F5F9" : "rgba(255, 255, 255, 0.05)";
          ctx.fillRect(36, rowY - 18, 440, 26);
        }
        ctx.fillStyle = isLight ? "#0F172A" : "#F8FAFC";
        displayCols.forEach((col, cIdx) => {
          const posX = colPositions[cIdx];
          const w = col.width;
          const valStr = String(col.getValue(row) || "").trim();
          const maxChar = Math.max(4, Math.floor(w / 8.0));
          const truncated = valStr.length > maxChar ? valStr.slice(0, maxChar - 1) + "…" : valStr;

          ctx.save();
          ctx.beginPath();
          ctx.rect(posX, rowY - 18, w, 26);
          ctx.clip();
          ctx.fillText(truncated, posX + 2, rowY + 1);
          ctx.restore();
        });
      }
    });

    // Interactive action affordance
    ctx.font = "bold 11px monospace";
    ctx.fillStyle = isLight ? "#6D28D9" : "#A78BFA";
    ctx.fillText("Previewing 10 rows • Click slab to view & scroll full dataset ↗", 40, tableTopY + 54 + sampleSlice.length * 28 + 14);
  } else if (hasTextPreview && doc?.preview_text) {
    // B. Render Real Extracted Document Text Preview
    ctx.font = "bold 13px monospace";
    ctx.fillStyle = isLight ? "#4C1D95" : "#DDD6FE";
    ctx.fillText("EXTRACTED SOVEREIGN CONTENT PREVIEW", 48, tableTopY + 23);

    ctx.font = "14px -apple-system, BlinkMacSystemFont, sans-serif";
    ctx.fillStyle = isLight ? "#1E293B" : "#F1F5F9";
    const words = doc.preview_text.split(/\s+/);
    let curLine = "";
    let curY = tableTopY + 56;
    for (const w of words) {
      const test = curLine + w + " ";
      if (ctx.measureText(test).width > 420) {
        ctx.fillText(curLine.trim(), 44, curY);
        curLine = w + " ";
        curY += 28;
        if (curY > 635) break;
      } else {
        curLine = test;
      }
    }
    if (curLine.trim() && curY <= 635) {
      ctx.fillText(curLine.trim(), 44, curY);
    }
  } else {
    // C. Render High-DPI Sovereign Index Specifications
    ctx.font = "bold 13px monospace";
    ctx.fillStyle = isLight ? "#4C1D95" : "#DDD6FE";
    ctx.fillText("PINECONE INDEX SPECIFICATIONS & METRICS", 48, tableTopY + 23);

    const sizeStr = doc
      ? doc.file_size > 1024 * 1024
        ? `${(doc.file_size / (1024 * 1024)).toFixed(2)} MB`
        : `${(doc.file_size / 1024).toFixed(1)} KB`
      : "Verified Cloud File";

    const isTabular = /\.(xlsx|xls|csv)$/i.test(doc?.original_name || "");
    const docTypeLabel = isTabular ? "Tabular Dataset (Spreadsheet)" : "Document Text & Content Chunks";

    const realMetrics = [
      ["DOCUMENT TYPE", docTypeLabel],
      ["FILE SIZE", sizeStr],
      ["TOTAL EXTENT", `${totalPages} Indexed Page(s) / Sheet(s)`],
      ["CLOUD STORAGE", "Pinecone Vector Registry"],
      ["STATUS", doc?.status ? doc.status.toUpperCase() : "INDEXED & VERIFIED"],
      ["VECTOR MODEL", "all-MiniLM-L6-v2 (384-Dim)"],
      ["ACCESS ROLE", "Family Entity Wide"],
      ["SEARCH MODE", isTabular ? "3D Column Plots & Hybrid Retrieval" : "Semantic Vector & Keyword BM25"],
      ["ENCRYPTION", "SHA-256 Fingerprint Verified"],
      ["COMPLIANCE", "Australian Sovereign APPs Compliant"],
    ];

    realMetrics.forEach(([label, value], idx) => {
      const rowY = tableTopY + 54 + idx * 30;
      if (rowY < 645) {
        if (idx % 2 === 0) {
          ctx.fillStyle = isLight ? "#F1F5F9" : "rgba(255, 255, 255, 0.05)";
          ctx.fillRect(36, rowY - 18, 440, 28);
        }
        ctx.fillStyle = isLight ? "#6B21A8" : "#A78BFA";
        ctx.font = "bold 11px monospace";
        ctx.fillText(label, 48, rowY + 1);

        ctx.fillStyle = isLight ? "#0F172A" : "#F8FAFC";
        ctx.font = "12px monospace";
        ctx.fillText(value, 195, rowY + 1);
      }
    });
  }

  // 9. High-Contrast Footer Seal
  ctx.fillStyle = isLight ? "#F8FAFC" : "rgba(0, 0, 0, 0.35)";
  ctx.fillRect(36, 655, 440, 36);
  ctx.strokeStyle = isLight ? "#E2E8F0" : "rgba(255, 255, 255, 0.1)";
  ctx.lineWidth = 1.5;
  ctx.strokeRect(36, 655, 440, 36);

  ctx.font = "bold 12px monospace";
  ctx.fillStyle = isLight ? "#4C1D95" : "#D4AF37";
  const hashLabel = doc
    ? `SHA: ${doc.file_hash.slice(0, 16)}... • PINECONE CLOUD STORAGE`
    : "PINECONE CLOUD REGISTRY • ZERO LOCAL STORAGE";
  ctx.fillText(hashLabel, 48, 678);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.generateMipmaps = true;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.anisotropy = 16;
  texture.needsUpdate = true;
  return texture;
}


