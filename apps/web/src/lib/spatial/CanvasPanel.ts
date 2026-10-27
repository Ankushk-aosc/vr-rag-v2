import * as THREE from "three";

/**
 * A crisp, flat 3D panel whose face is drawn with the Canvas 2D API.
 *
 * Why the old panels looked blurry, and what this does instead:
 *  - lit MeshStandardMaterial + tone mapping washed text out  → unlit MeshBasicMaterial, toneMapped off
 *  - scene fog faded panels with distance                    → fog disabled on the material
 *  - 1x canvas magnified over ~2 m, no mipmaps                → 2x canvas, mipmaps + max anisotropy
 *  - wrong colour space (dull, low-contrast text)            → SRGBColorSpace
 *  - the texture was re-uploaded every frame (jank)           → redraw only when the content key changes
 */
export class CanvasPanel {
  readonly mesh: THREE.Mesh;
  readonly canvas: HTMLCanvasElement;
  readonly ctx: CanvasRenderingContext2D;
  readonly width: number;
  readonly height: number;
  private texture: THREE.CanvasTexture;
  private material: THREE.MeshBasicMaterial;
  private lastKey = "";

  constructor(opts: {
    /** Logical drawing size in CSS-like pixels. */
    width: number;
    height: number;
    /** Size in metres. */
    worldWidth: number;
    pixelRatio?: number;
    renderer?: THREE.WebGLRenderer;
    name?: string;
  }) {
    const ratio = opts.pixelRatio ?? 2;
    this.width = opts.width;
    this.height = opts.height;
    this.canvas = document.createElement("canvas");
    this.canvas.width = Math.round(opts.width * ratio);
    this.canvas.height = Math.round(opts.height * ratio);
    this.ctx = this.canvas.getContext("2d")!;
    this.ctx.scale(ratio, ratio);

    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.generateMipmaps = true;
    this.texture.minFilter = THREE.LinearMipmapLinearFilter;
    this.texture.magFilter = THREE.LinearFilter;
    this.texture.anisotropy = opts.renderer ? opts.renderer.capabilities.getMaxAnisotropy() : 8;

    this.material = new THREE.MeshBasicMaterial({
      map: this.texture,
      transparent: true,
      toneMapped: false,
      fog: false,
      side: THREE.DoubleSide,
      depthWrite: true,
    });
    const worldHeight = (opts.worldWidth * opts.height) / opts.width;
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(opts.worldWidth, worldHeight), this.material);
    this.mesh.name = opts.name || "canvas-panel";
  }

  /** Redraw only when `key` differs from the last drawn content. */
  draw(key: string, paint: (ctx: CanvasRenderingContext2D, w: number, h: number) => void): void {
    if (key === this.lastKey) return;
    this.lastKey = key;
    this.ctx.clearRect(0, 0, this.width, this.height);
    paint(this.ctx, this.width, this.height);
    this.texture.needsUpdate = true;
  }

  dispose(): void {
    this.texture.dispose();
    this.material.dispose();
    this.mesh.geometry.dispose();
  }
}

// ---------------------------------------------------------------- drawing helpers

export function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/** Word-wrap `text` into lines no wider than `maxWidth` with the current font. */
export function wrapLines(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  const lines: string[] = [];
  for (const para of text.split("\n")) {
    const words = para.split(/\s+/).filter(Boolean);
    let line = "";
    for (const word of words) {
      const test = line ? `${line} ${word}` : word;
      if (ctx.measureText(test).width > maxWidth && line) {
        lines.push(line);
        line = word;
      } else {
        line = test;
      }
    }
    if (line) lines.push(line);
  }
  return lines;
}

export const FONT = `-apple-system, BlinkMacSystemFont, "Segoe UI", Inter, sans-serif`;
export const MONO = `"JetBrains Mono", "SF Mono", Consolas, monospace`;
