import { CitationItem, Dashboard, ThinkingStage, VoicePhase } from "../../types";
import { FONT, MONO, roundRect, wrapLines } from "./CanvasPanel";

/** Snapshot of app state the 3D world renders each frame (fed from React through a ref). */
export interface SpatialState {
  question: string;
  answer: string;
  streaming: boolean;
  stages: ThinkingStage[];
  reasoning: string;
  citations: CitationItem[];
  phase: VoicePhase;
  conversation: boolean;
  interim: string;
  error: string | null;
  /** performance.now() when the current answer started (for the live timer). */
  startedAt: number;
  /** Dashboard shown in 3D (the active one), and the state of the "create dashboard" button. */
  dashboard: Dashboard | null;
  dashboardState: "none" | "available" | "loading" | "ready" | "error";
  /** Incremented to ask the 3D view to bring the dashboard in front of the viewer. */
  dashboardFocus: number;
}

export const EMPTY_SPATIAL_STATE: SpatialState = {
  question: "",
  answer: "",
  streaming: false,
  stages: [],
  reasoning: "",
  citations: [],
  phase: "idle",
  conversation: false,
  interim: "",
  error: null,
  startedAt: 0,
  dashboard: null,
  dashboardState: "none",
  dashboardFocus: 0,
};

const C = {
  bg: "rgba(12, 9, 22, 0.98)",
  border: "rgba(167, 139, 250, 0.70)",
  violet: "#DDD6FE",
  violetDeep: "#A78BFA",
  gold: "#FDE047",
  text: "#FFFFFF",
  dim: "rgba(255, 255, 255, 0.88)",
  faint: "rgba(255, 255, 255, 0.60)",
  green: "#6EE7B7",
};

const PHASE_TEXT: Record<VoicePhase, string> = {
  idle: "READY",
  listening: "LISTENING",
  transcribing: "TRANSCRIBING",
  thinking: "THINKING",
  speaking: "SPEAKING",
};

function frame(ctx: CanvasRenderingContext2D, w: number, h: number, title: string, pill: string, pillColor: string) {
  roundRect(ctx, 6, 6, w - 12, h - 12, 30);
  ctx.fillStyle = C.bg;
  ctx.fill();
  ctx.lineWidth = 3.5;
  ctx.strokeStyle = C.border;
  ctx.stroke();

  ctx.fillStyle = C.gold;
  ctx.fillRect(40, 34, 80, 4);
  ctx.font = `700 24px ${MONO}`;
  ctx.fillStyle = C.violet;
  ctx.textBaseline = "alphabetic";
  ctx.fillText(title, 40, 76);

  ctx.font = `700 18px ${MONO}`;
  const pw = ctx.measureText(pill).width + 36;
  roundRect(ctx, w - 40 - pw, 48, pw, 38, 19);
  ctx.fillStyle = `${pillColor}33`;
  ctx.fill();
  ctx.strokeStyle = pillColor;
  ctx.lineWidth = 2.5;
  ctx.stroke();
  ctx.fillStyle = pillColor;
  ctx.textAlign = "center";
  ctx.fillText(pill, w - 40 - pw / 2, 74);
  ctx.textAlign = "start";
}

// ------------------------------------------------------------------ dialogue

type Block =
  | { kind: "heading"; text: string }
  | { kind: "para"; text: string; lead: boolean }
  | { kind: "bullet"; text: string }
  | { kind: "table"; rows: string[][] };

function cleanInline(s: string): string {
  return s.replace(/\*\*|__|`/g, "").replace(/\[([^\]]+)\]\([^)]*\)/g, "$1").trim();
}

function parseMarkdown(md: string): Block[] {
  const blocks: Block[] = [];
  let table: string[][] | null = null;
  let sawPara = false;
  for (const raw of md.split("\n")) {
    const line = raw.trim();
    if (line.startsWith("|")) {
      if (/^\|?\s*:?-{2,}/.test(line)) continue; // header separator row
      const cells = line.replace(/^\||\|$/g, "").split("|").map((c) => cleanInline(c));
      if (!table) blocks.push({ kind: "table", rows: (table = []) });
      table.push(cells);
      continue;
    }
    table = null;
    if (!line) continue;
    const heading = line.match(/^#{1,6}\s+(.*)/);
    if (heading) blocks.push({ kind: "heading", text: cleanInline(heading[1]).toUpperCase() });
    else if (/^[-*•]\s+/.test(line)) blocks.push({ kind: "bullet", text: cleanInline(line.replace(/^[-*•]\s+/, "")) });
    else {
      blocks.push({ kind: "para", text: cleanInline(line), lead: !sawPara });
      sawPara = true;
    }
  }
  return blocks;
}

export function drawDialoguePanel(ctx: CanvasRenderingContext2D, w: number, h: number, s: SpatialState) {
  const pill = s.streaming ? (s.answer ? "ANSWERING" : "THINKING") : s.conversation ? PHASE_TEXT[s.phase] : "READY";
  const pillColor = s.streaming || s.phase === "thinking" ? "#F59E0B" : s.phase === "listening" ? "#A78BFA" : C.green;
  frame(ctx, w, h, "AETHER  •  DIALOGUE", pill, pillColor);

  const left = 44;
  const right = w - 44;
  const maxW = right - left;
  let y = 116;

  // question
  const question = s.phase === "listening" && s.interim ? s.interim : s.question;
  roundRect(ctx, left - 8, y, maxW + 16, 86, 18);
  ctx.fillStyle = "rgba(255,255,255,0.05)";
  ctx.fill();
  ctx.font = `700 16px ${FONT}`;
  ctx.fillStyle = C.violet;
  ctx.fillText(s.phase === "listening" && s.interim ? "HEARING YOU…" : "YOUR QUESTION", left + 10, y + 28);
  ctx.font = `600 23px ${FONT}`;
  ctx.fillStyle = C.text;
  const qLines = wrapLines(ctx, question || "Tap the orb or use the mic, then ask about your documents.", maxW - 20);
  ctx.fillText(qLines[0] + (qLines.length > 1 ? " …" : ""), left + 10, y + 62);
  y += 112;

  const bottomLimit = h - (s.citations.length ? 96 : 50);
  if (!s.answer) {
    ctx.font = `500 23px ${FONT}`;
    ctx.fillStyle = C.dim;
    const hint = s.streaming
      ? "Searching your documents and reasoning…"
      : s.error || "Answers appear here as they stream in. Grab any panel to move it.";
    wrapLines(ctx, hint, maxW).forEach((l, i) => ctx.fillText(l, left, y + 30 + i * 34));
  }

  let truncated = false;
  for (const b of s.answer ? parseMarkdown(s.answer) : []) {
    if (y > bottomLimit) {
      truncated = true;
      break;
    }
    if (b.kind === "heading") {
      y += 14;
      ctx.font = `700 15px ${MONO}`;
      ctx.fillStyle = C.violet;
      ctx.fillText(b.text, left, y + 16);
      y += 30;
    } else if (b.kind === "para") {
      ctx.font = b.lead ? `600 25px ${FONT}` : `400 21px ${FONT}`;
      ctx.fillStyle = b.lead ? "#FFFFFF" : C.text;
      const lh = b.lead ? 34 : 29;
      for (const l of wrapLines(ctx, b.text, maxW)) {
        if (y > bottomLimit) {
          truncated = true;
          break;
        }
        ctx.fillText(l, left, y + lh - 6);
        y += lh;
      }
      y += 8;
    } else if (b.kind === "bullet") {
      ctx.font = `400 20px ${FONT}`;
      const lines = wrapLines(ctx, b.text, maxW - 28);
      ctx.fillStyle = C.violetDeep;
      ctx.beginPath();
      ctx.arc(left + 7, y + 17, 4.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = C.text;
      for (const l of lines) {
        if (y > bottomLimit) {
          truncated = true;
          break;
        }
        ctx.fillText(l, left + 26, y + 24);
        y += 28;
      }
      y += 4;
    } else if (b.kind === "table") {
      const rows = b.rows.slice(0, 7);
      const cols = Math.max(...rows.map((r) => r.length));
      const colW = maxW / cols;
      const rowH = 36;
      roundRect(ctx, left - 6, y, maxW + 12, rows.length * rowH + 8, 14);
      ctx.fillStyle = "rgba(255,255,255,0.035)";
      ctx.fill();
      ctx.strokeStyle = "rgba(255,255,255,0.10)";
      ctx.lineWidth = 1.5;
      ctx.stroke();
      rows.forEach((r, ri) => {
        const ry = y + 4 + ri * rowH;
        if (ri === 0) {
          ctx.fillStyle = "rgba(139, 92, 246, 0.16)";
          ctx.fillRect(left - 6, ry - 4, maxW + 12, rowH);
        }
        r.forEach((cell, ci) => {
          ctx.font = ri === 0 ? `700 14px ${MONO}` : ci === 1 ? `700 19px ${MONO}` : `400 17px ${FONT}`;
          ctx.fillStyle = ri === 0 ? C.violet : ci === 1 ? C.gold : C.text;
          let text = ri === 0 ? cell.toUpperCase() : cell;
          while (ctx.measureText(text).width > colW - 14 && text.length > 3) text = text.slice(0, -2) + "…";
          ctx.fillText(text, left + 6 + ci * colW, ry + 24);
        });
      });
      y += rows.length * rowH + 20;
    }
  }

  if (truncated) {
    ctx.font = `italic 400 17px ${FONT}`;
    ctx.fillStyle = C.faint;
    ctx.fillText("… full answer continues in the dialogue window", left, bottomLimit + 26);
  }

  if (s.citations.length) {
    roundRect(ctx, left - 8, h - 82, maxW + 16, 48, 14);
    ctx.fillStyle = "rgba(212, 175, 55, 0.13)";
    ctx.fill();
    ctx.font = `700 15px ${MONO}`;
    ctx.fillStyle = C.gold;
    const names = Array.from(new Set(s.citations.map((c) => `${c.document_name} p.${c.page_number}`)));
    let line = `SOURCES  ${names.join("  •  ")}`;
    while (ctx.measureText(line).width > maxW && line.length > 10) line = line.slice(0, -2);
    ctx.fillText(line, left + 8, h - 51);
  }
}

export function dialogueKey(s: SpatialState): string {
  return [s.question, s.answer.length, s.streaming, s.phase, s.conversation, s.interim, s.citations.length, s.error].join("|");
}

// ------------------------------------------------------------------ thinking

export function drawThinkingPanel(ctx: CanvasRenderingContext2D, w: number, h: number, s: SpatialState, now: number) {
  const working = s.streaming && !s.answer;
  const total = s.stages.reduce((a, st) => a + (st.duration_ms || 0), 0);
  const elapsed = working && s.startedAt ? (now - s.startedAt) / 1000 : total / 1000;
  frame(ctx, w, h, "REASONING", working ? `${elapsed.toFixed(1)}s` : s.stages.length ? `THOUGHT ${elapsed.toFixed(1)}s` : "IDLE",
    working ? "#F59E0B" : C.green);

  const left = 40;
  const maxW = w - 80;
  let y = 120;
  if (!s.stages.length) {
    ctx.font = `500 22px ${FONT}`;
    ctx.fillStyle = C.dim;
    wrapLines(ctx, "Live search, ranking and model reasoning appear here while an answer is generated.", maxW).forEach(
      (l, i) => ctx.fillText(l, left, y + 28 + i * 32)
    );
    return;
  }

  const dots = ".".repeat(1 + (Math.floor(now / 350) % 3));
  for (const st of s.stages) {
    const done = st.status === "done";
    ctx.beginPath();
    ctx.arc(left + 11, y + 13, 11, 0, Math.PI * 2);
    ctx.fillStyle = done ? "rgba(110, 231, 183, 0.18)" : "rgba(167, 139, 250, 0.22)";
    ctx.fill();
    ctx.strokeStyle = done ? C.green : C.violet;
    ctx.lineWidth = 2.5;
    if (done) {
      ctx.beginPath();
      ctx.moveTo(left + 5, y + 13);
      ctx.lineTo(left + 10, y + 18);
      ctx.lineTo(left + 18, y + 8);
      ctx.stroke();
    } else {
      ctx.beginPath();
      ctx.arc(left + 11, y + 13, 6, now / 180, now / 180 + Math.PI * 1.3);
      ctx.stroke();
    }
    ctx.font = `600 19px ${FONT}`;
    ctx.fillStyle = C.text;
    ctx.fillText(done ? st.title : `${st.title}${dots}`, left + 34, y + 20);
    if (done) {
      ctx.font = `500 15px ${MONO}`;
      ctx.fillStyle = C.faint;
      const t = st.duration_ms >= 1000 ? `${(st.duration_ms / 1000).toFixed(1)}s` : `${st.duration_ms}ms`;
      ctx.textAlign = "right";
      ctx.fillText(t, w - left, y + 20);
      ctx.textAlign = "start";
    }
    y += 30;
    if (st.details) {
      ctx.font = `400 15px ${FONT}`;
      ctx.fillStyle = C.dim;
      const d = wrapLines(ctx, st.details, maxW - 34)[0];
      ctx.fillText(d, left + 34, y + 10);
      y += 26;
    }
    y += 6;
  }

  if (s.reasoning.trim()) {
    y += 8;
    const boxTop = y;
    const boxH = h - boxTop - 34;
    if (boxH > 60) {
      ctx.fillStyle = "rgba(167, 139, 250, 0.5)";
      ctx.fillRect(left, boxTop, 3, boxH);
      ctx.font = `italic 400 16px ${FONT}`;
      ctx.fillStyle = C.dim;
      const lines = wrapLines(ctx, s.reasoning.trim().replace(/\s+/g, " "), maxW - 20);
      const fit = Math.floor(boxH / 23);
      // show the newest reasoning, like a live feed
      lines.slice(-fit).forEach((l, i) => ctx.fillText(l, left + 16, boxTop + 18 + i * 23));
    }
  }
}

export function thinkingKey(s: SpatialState, now: number): string {
  const working = s.streaming && !s.answer;
  return [
    s.stages.map((st) => `${st.title}:${st.status}`).join(","),
    s.reasoning.length,
    working,
    working ? Math.floor(now / 120) : 0,
  ].join("|");
}

// ------------------------------------------------------------------ orb label

export function drawOrbLabel(ctx: CanvasRenderingContext2D, w: number, h: number, s: SpatialState) {
  const text = !s.conversation
    ? "Tap the orb to talk"
    : s.phase === "listening"
    ? s.interim
      ? `“${s.interim}”`
      : "Listening… speak now"
    : s.phase === "transcribing"
    ? "Transcribing…"
    : s.phase === "thinking"
    ? "Thinking…"
    : s.phase === "speaking"
    ? "Speaking…"
    : "Voice ready";
  const sub = !s.conversation
    ? "drag the orb or any panel to move it"
    : s.phase === "speaking"
    ? "talk or tap the orb to interrupt"
    : "tap the orb to end voice mode";
  roundRect(ctx, 4, 4, w - 8, h - 8, (h - 8) / 2);
  ctx.fillStyle = "rgba(18, 14, 30, 0.88)";
  ctx.fill();
  ctx.strokeStyle = "rgba(167, 139, 250, 0.45)";
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.textAlign = "center";
  ctx.font = `600 24px ${FONT}`;
  ctx.fillStyle = C.text;
  let line = text;
  while (ctx.measureText(line).width > w - 50 && line.length > 6) line = line.slice(0, -2);
  if (line !== text) line = line.slice(0, -1) + "…";
  ctx.fillText(line, w / 2, h / 2 + 2);
  ctx.font = `400 14px ${FONT}`;
  ctx.fillStyle = C.faint;
  ctx.fillText(sub, w / 2, h / 2 + 26);
  ctx.textAlign = "start";
}

// ------------------------------------------------------------------ "create dashboard" button

export function drawDashboardButton(ctx: CanvasRenderingContext2D, w: number, h: number, s: SpatialState) {
  const label =
    s.dashboardState === "loading"
      ? "Building dashboard…"
      : s.dashboardState === "ready"
      ? "Dashboard ready · tap to rebuild"
      : s.dashboardState === "error"
      ? "Couldn't build dashboard · tap to retry"
      : "Create 3D dashboard";
  roundRect(ctx, 4, 4, w - 8, h - 8, (h - 8) / 2);
  ctx.fillStyle = s.dashboardState === "loading" ? "rgba(76, 29, 149, 0.92)" : "rgba(109, 40, 217, 0.96)";
  ctx.fill();
  ctx.strokeStyle = "rgba(221, 214, 254, 0.7)";
  ctx.lineWidth = 3;
  ctx.stroke();
  // bar-chart glyph
  ctx.fillStyle = "#FFFFFF";
  const gx = 44;
  [[0, 26], [14, 40], [28, 18]].forEach(([dx, bh]) => {
    roundRect(ctx, gx + dx, h / 2 + 20 - bh, 9, bh, 2);
    ctx.fill();
  });
  ctx.font = `600 30px ${FONT}`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(label, w / 2 + 30, h / 2 + 2);
  ctx.textAlign = "start";
  ctx.textBaseline = "alphabetic";
}

export function dashboardButtonKey(s: SpatialState): string {
  return s.dashboardState;
}

export function orbLabelKey(s: SpatialState): string {
  return [s.conversation, s.phase, s.interim].join("|");
}
