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
  fallbackTitle: string = "AAPL Financial Ledger",
  fallbackSub: string = "11,558 Rows • AUD Synthesized",
  fallbackCode: string = "AAPL • FY20-24"
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

  // 7. Structured Table Header Bar
  const tableTopY = lineY + 54;
  ctx.fillStyle = isLight ? "#EDE9FE" : "rgba(139, 92, 246, 0.25)";
  ctx.fillRect(36, tableTopY, 440, 36);
  ctx.strokeStyle = isLight ? "#C4B5FD" : "rgba(167, 139, 250, 0.4)";
  ctx.lineWidth = 1.5;
  ctx.strokeRect(36, tableTopY, 440, 36);

  ctx.font = "bold 14px monospace";
  ctx.fillStyle = isLight ? "#4C1D95" : "#DDD6FE";
  ctx.fillText("DATE        OPEN    HIGH   CLOSE    VOL", 48, tableTopY + 23);

  // 8. Financial Table Data Rows
  const sampleRows = [
    "2020-04-01   59.45   59.99   58.11   176.2M",
    "2020-04-02   57.97   59.13   59.08   165.9M",
    "2020-04-03   58.56   59.26   58.23   129.8M",
    "2020-04-06   60.12   61.50   60.75   201.3M",
    "2020-04-07   63.15   64.00   62.54   187.5M",
    "2020-04-08   62.50   63.75   63.02   168.0M",
    "2020-04-09   63.80   67.44   67.09   201.1M",
    "2020-04-13   67.08   67.20   65.85   131.0M",
    "2020-04-14   67.50   71.72   71.70   194.9M",
    "2020-04-15   70.60   71.58   71.11   131.1M",
  ];

  ctx.font = "bold 13px monospace";
  sampleRows.forEach((rowText, idx) => {
    const rowY = tableTopY + 54 + idx * 30;
    if (rowY < 645) {
      if (idx % 2 === 0) {
        ctx.fillStyle = isLight ? "#F1F5F9" : "rgba(255, 255, 255, 0.05)";
        ctx.fillRect(36, rowY - 18, 440, 28);
      }
      ctx.fillStyle = isLight ? "#0F172A" : "#F8FAFC";
      ctx.fillText(rowText, 48, rowY + 2);
    }
  });

  // 9. High-Contrast Footer Seal
  ctx.fillStyle = isLight ? "#F8FAFC" : "rgba(0, 0, 0, 0.35)";
  ctx.fillRect(36, 655, 440, 36);
  ctx.strokeStyle = isLight ? "#E2E8F0" : "rgba(255, 255, 255, 0.1)";
  ctx.lineWidth = 1.5;
  ctx.strokeRect(36, 655, 440, 36);

  ctx.font = "bold 12px monospace";
  ctx.fillStyle = isLight ? "#4C1D95" : "#D4AF37";
  const hashLabel = doc
    ? `SHA: ${doc.file_hash.slice(0, 16)}... • AUD APP 8 LOCAL`
    : "VERIFIED SOVEREIGN AUD RECORD • APP 8 ZERO LEAK";
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

export const DEFAULT_SPATIAL_DOCS: DocumentRecord[] = [
  {
    id: "doc-1",
    filename: "AAPL_financial_data_11558_rows.xlsx",
    original_name: "AAPL_financial_data_11558_rows.xlsx",
    mime_type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    file_size: 539573,
    file_hash: "2af8528614ef4900a6e0b3c5825bc5e5",
    total_pages: 2,
    family_entity_id: "default_family",
    status: "indexed",
    uploaded_at: "",
  },
  {
    id: "doc-2",
    filename: "AAPL_financial_data_11558_rows.pdf",
    original_name: "AAPL_financial_data_11558_rows.pdf",
    mime_type: "application/pdf",
    file_size: 940280,
    file_hash: "cf9d93ed806e478fb18bc298d871be84",
    total_pages: 233,
    family_entity_id: "default_family",
    status: "indexed",
    uploaded_at: "",
  },
  {
    id: "doc-3",
    filename: "AAPL_financial_data_11558_rows.csv",
    original_name: "AAPL_financial_data_11558_rows.csv",
    mime_type: "text/csv",
    file_size: 710536,
    file_hash: "d2be779e1f104f279c13e51240a1b6ca",
    total_pages: 232,
    family_entity_id: "default_family",
    status: "indexed",
    uploaded_at: "",
  },
  {
    id: "doc-4",
    filename: "AAPL_financial_data_11558_rows.docx",
    original_name: "AAPL_financial_data_11558_rows.docx",
    mime_type: "application/docx",
    file_size: 346220,
    file_hash: "af7556c576aba4749f1b21396a84cbb0",
    total_pages: 1,
    family_entity_id: "default_family",
    status: "indexed",
    uploaded_at: "",
  },
  {
    id: "doc-5",
    filename: "AAPL_financial_data_11558_rows.txt",
    original_name: "AAPL_financial_data_11558_rows.txt",
    mime_type: "text/plain",
    file_size: 719771,
    file_hash: "d09437ff9af64f5095ce56a4297c55b7",
    total_pages: 1,
    family_entity_id: "default_family",
    status: "indexed",
    uploaded_at: "",
  },
];

