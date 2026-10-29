/**
 * Fluid Dynamic & Swarm Particle Physics Simulation Engine
 * Encapsulates spatial hashing, Eulerian fluid advection, and agent steering.
 */

import {
  MAX_PARTICLES,
  CELL,
  MAX_COLS,
  MAX_ROWS,
  PRESSURE_STEPS,
  clamp,
  random,
  rectField,
} from "./swarmMath";
import { sampleField, applyWalls, solvePressure, PhysicsGrid } from "./swarmPhysics";

export interface SwarmSettings {
  count: number;
  size: number;
  shape: number;
  color: string;
  accentColor: string;
  spread: number;
  speed: number;
  swirl: number;
  tail: number;
  trail: number;
  wander: number;
  depth: number;
  targets: string;
  idle: "roam" | "gather" | "hide";
  clickEffect: "burst" | "pulse" | "none";
  hideCursor: boolean;
  intro: boolean;
  enabled: boolean;
  lightMode: boolean;
  dpr?: number;
}

export interface SwarmViewState {
  width: number;
  height: number;
  ratio: number;
}

export class SwarmSimulation {
  // Particle State Buffers
  readonly px = new Float32Array(MAX_PARTICLES);
  readonly py = new Float32Array(MAX_PARTICLES);
  readonly pz = new Float32Array(MAX_PARTICLES);
  readonly vx = new Float32Array(MAX_PARTICLES);
  readonly vy = new Float32Array(MAX_PARTICLES);
  readonly vz = new Float32Array(MAX_PARTICLES);
  readonly home = new Float32Array(MAX_PARTICLES);
  readonly heft = new Float32Array(MAX_PARTICLES);
  readonly bob = new Float32Array(MAX_PARTICLES);
  readonly bobRate = new Float32Array(MAX_PARTICLES);
  readonly grain = new Float32Array(MAX_PARTICLES);
  readonly glint = new Float32Array(MAX_PARTICLES);
  readonly order = new Int32Array(MAX_PARTICLES);

  // Eulerian Fluid Grid
  readonly grid: PhysicsGrid = {
    cols: 1,
    rows: 1,
    cell: CELL,
    flowX: new Float32Array(1),
    flowY: new Float32Array(1),
    lastX: new Float32Array(1),
    lastY: new Float32Array(1),
    pressure: new Float32Array(1),
    divergence: new Float32Array(1),
    curl: new Float32Array(1),
  };

  // Spatial Hashing Crowd Buffers
  private readonly crowd = new Int32Array(MAX_PARTICLES);
  private crowdHeads = new Int32Array(1);
  private crowdRows = 1;
  private readonly field = [0, 0, 0];

  // Dynamic Steering & Interaction
  readonly pointer = { x: 0, y: 0, inside: false };
  readonly anchor = { x: 0, y: 0, lastX: 0, lastY: 0, moveX: 0, moveY: 0 };
  readonly ring = { active: false, x: 0, y: 0, hx: 0, hy: 0, corner: 0, spin: 1 };
  readonly burst = { age: 10 };
  readonly ping = { age: 10, x: 0, y: 0 };

  hovered: Element | null = null;
  time = 0;
  presence = 1;
  introClock = 1;
  seeded = false;
  sorted = 0;

  allocate(view: SwarmViewState): void {
    const nextCols = clamp(Math.round(view.width / CELL), 8, MAX_COLS);
    const nextRows = clamp(Math.round(view.height / CELL), 8, MAX_ROWS);
    this.grid.cell = Math.max(view.width / nextCols, view.height / nextRows);
    if (nextCols === this.grid.cols && nextRows === this.grid.rows) return;
    this.grid.cols = nextCols;
    this.grid.rows = nextRows;
    const total = this.grid.cols * this.grid.rows;
    this.grid.flowX = new Float32Array(total);
    this.grid.flowY = new Float32Array(total);
    this.grid.lastX = new Float32Array(total);
    this.grid.lastY = new Float32Array(total);
    this.grid.pressure = new Float32Array(total);
    this.grid.divergence = new Float32Array(total);
    this.grid.curl = new Float32Array(total);
  }

  seed(): void {
    const rand = random(7);
    for (let i = 0; i < MAX_PARTICLES; i++) {
      this.home[i] = 0.08 + 0.92 * Math.sqrt(rand());
      this.heft[i] = rand() * rand();
      this.bob[i] = rand() * Math.PI * 2;
      this.bobRate[i] = 0.5 + rand() * 1.1;
      this.grain[i] = 0.55 + rand() * 0.9;
      this.glint[i] = rand() * 100;
    }
    this.seeded = true;
  }

  place(view: SwarmViewState, s: SwarmSettings, gathered: boolean): void {
    const rand = random(11);
    const reachOut = Math.hypot(view.width, view.height) * 0.5;
    for (let i = 0; i < MAX_PARTICLES; i++) {
      const a = rand() * Math.PI * 2;
      const r = gathered ? this.home[i] * s.spread : (0.35 + 0.65 * Math.sqrt(rand())) * reachOut;
      this.px[i] = this.anchor.x + Math.cos(a) * r;
      this.py[i] = this.anchor.y + Math.sin(a) * r;
      this.pz[i] = Math.sin(this.bob[i]) * s.spread * 0.55;
      this.vx[i] = 0;
      this.vy[i] = 0;
      this.vz[i] = 0;
    }
  }

  findTarget(container: HTMLElement, targets: string): Element | null {
    if (!targets || !this.pointer.inside) return null;
    const rect = container.getBoundingClientRect();
    const element = document.elementFromPoint(rect.left + this.pointer.x, rect.top + this.pointer.y);
    if (!element || !container.contains(element)) return null;
    try {
      const match = element.closest(targets);
      return match && container.contains(match) ? match : null;
    } catch {
      return null;
    }
  }

  updateAnchor(container: HTMLElement, s: SwarmSettings, view: SwarmViewState, dt: number): void {
    const w = view.width;
    const h = view.height;
    if (this.hovered && this.hovered.isConnected) {
      const box = this.hovered.getBoundingClientRect();
      const frame = container.getBoundingClientRect();
      const radius = parseFloat(getComputedStyle(this.hovered).borderTopLeftRadius) || 0;
      this.ring.x = box.left - frame.left + box.width / 2;
      this.ring.y = box.top - frame.top + box.height / 2;
      this.ring.hx = box.width / 2;
      this.ring.hy = box.height / 2;
      this.ring.corner = Math.min(radius, this.ring.hx, this.ring.hy);
      if (!this.ring.active) {
        let turning = 0;
        for (let i = 0; i < s.count; i++) {
          turning += (this.px[i] - this.ring.x) * this.vy[i] - (this.py[i] - this.ring.y) * this.vx[i];
        }
        this.ring.spin = turning < 0 ? -1 : 1;
      }
      this.ring.active = true;
    } else {
      this.ring.active = false;
    }

    let goal = 1;
    if (this.pointer.inside) {
      this.anchor.x = this.pointer.x;
      this.anchor.y = this.pointer.y;
    } else if (s.idle === "gather") {
      this.anchor.x = w * 0.5;
      this.anchor.y = h * 0.5;
    } else if (s.idle === "hide") {
      goal = 0;
    } else {
      this.anchor.x = w * (0.5 + 0.3 * Math.sin(this.time * 0.21) + 0.06 * Math.sin(this.time * 0.53 + 1.7));
      this.anchor.y = h * (0.5 + 0.24 * Math.sin(this.time * 0.29 + 0.8) + 0.05 * Math.sin(this.time * 0.71));
    }

    if (dt > 0) {
      const moveX = clamp((this.anchor.x - this.anchor.lastX) / dt, -4000, 4000);
      const moveY = clamp((this.anchor.y - this.anchor.lastY) / dt, -4000, 4000);
      const blend = 1 - Math.exp(-dt * 30);
      this.anchor.moveX += (moveX - this.anchor.moveX) * blend;
      this.anchor.moveY += (moveY - this.anchor.moveY) * blend;
    }
    this.anchor.lastX = this.anchor.x;
    this.anchor.lastY = this.anchor.y;
    this.presence += (goal - this.presence) * (1 - Math.exp(-dt / 0.25));
  }

  stir(s: SwarmSettings, dt: number, ease: number): void {
    const radius = s.spread;
    const reach = radius * 2.2;
    const i0 = Math.max(1, Math.floor((this.anchor.x - reach) / this.grid.cell));
    const i1 = Math.min(this.grid.cols - 2, Math.ceil((this.anchor.x + reach) / this.grid.cell));
    const j0 = Math.max(1, Math.floor((this.anchor.y - reach) / this.grid.cell));
    const j1 = Math.min(this.grid.rows - 2, Math.ceil((this.anchor.y + reach) / this.grid.cell));
    const inv = 1 / (radius * radius * 0.55);
    const moving = Math.hypot(this.anchor.moveX, this.anchor.moveY);
    const grab = (1 - Math.exp(-dt * 20)) * clamp(moving / 240, 0, 1) * this.presence;
    const whirl = this.ring.active ? 0 : radius * (0.5 + 4 * (1 - ease)) * (0.35 + 0.65 * s.speed);
    const churn = s.wander * radius * 14 * (0.4 + 0.6 * s.speed);
    const fk = 1.4 / radius;
    const ft = this.time * 0.75 * (0.4 + 0.6 * s.speed);

    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const k = i + j * this.grid.cols;
        const x = (i + 0.5) * this.grid.cell;
        const y = (j + 0.5) * this.grid.cell;
        const rx = x - this.anchor.x;
        const ry = y - this.anchor.y;
        const d2 = rx * rx + ry * ry;
        const w = Math.exp(-d2 * inv);
        if (w < 0.003) continue;
        const d = Math.sqrt(d2) + 0.001;
        this.grid.flowX[k] += (this.anchor.moveX - this.grid.flowX[k]) * w * grab;
        this.grid.flowY[k] += (this.anchor.moveY - this.grid.flowY[k]) * w * grab;
        const reachOut = Math.min(1, d / (radius * 0.45));
        this.grid.flowX[k] += (-ry / d) * whirl * reachOut * w * dt;
        this.grid.flowY[k] += (rx / d) * whirl * reachOut * w * dt;
        const a1 = x * fk + ft;
        const b1 = y * fk * 1.1 - ft * 0.8;
        const a2 = y * fk * 1.7 + ft * 1.2 + 1.3;
        const b2 = x * fk * 1.3 - 0.7;
        const curlX = -Math.sin(a1) * Math.sin(b1) * 1.1 + 1.02 * Math.cos(a2) * Math.cos(b2);
        const curlY = -(Math.cos(a1) * Math.cos(b1) - 0.78 * Math.sin(a2) * Math.sin(b2));
        this.grid.flowX[k] += curlX * churn * w * dt;
        this.grid.flowY[k] += curlY * churn * w * dt;
      }
    }

    if (!this.ring.active) return;
    const band = Math.max(4, radius * 0.16);
    const margin = band + 24;
    const circulate = 230 * (0.4 + 0.6 * s.speed) * this.ring.spin;
    const r0 = Math.max(1, Math.floor((this.ring.x - this.ring.hx - margin) / this.grid.cell));
    const r1 = Math.min(this.grid.cols - 2, Math.ceil((this.ring.x + this.ring.hx + margin) / this.grid.cell));
    const c0 = Math.max(1, Math.floor((this.ring.y - this.ring.hy - margin) / this.grid.cell));
    const c1 = Math.min(this.grid.rows - 2, Math.ceil((this.ring.y + this.ring.hy + margin) / this.grid.cell));
    const rate = 1 - Math.exp(-dt * 6);

    for (let j = c0; j <= c1; j++) {
      for (let i = r0; i <= r1; i++) {
        const k = i + j * this.grid.cols;
        rectField((i + 0.5) * this.grid.cell - this.ring.x, (j + 0.5) * this.grid.cell - this.ring.y, this.ring.hx, this.ring.hy, this.ring.corner, this.field);
        const off = this.field[0] - (5 + band * 0.5);
        const w = Math.exp(-(off * off) / (margin * margin * 0.35));
        if (w < 0.01) continue;
        this.grid.flowX[k] += (-this.field[2] * circulate - this.grid.flowX[k]) * w * rate;
        this.grid.flowY[k] += (this.field[1] * circulate - this.grid.flowY[k]) * w * rate;
      }
    }
  }

  flow(s: SwarmSettings, dt: number): void {
    const { cols, rows, cell, flowX, flowY, lastX, lastY, curl } = this.grid;
    for (let j = 1; j < rows - 1; j++) {
      for (let i = 1; i < cols - 1; i++) {
        const k = i + j * cols;
        curl[k] = (flowY[k + 1] - flowY[k - 1] - flowX[k + cols] + flowX[k - cols]) * (0.5 / cell);
      }
    }
    const confine = s.swirl * cell * 9;
    for (let j = 2; j < rows - 2; j++) {
      for (let i = 2; i < cols - 2; i++) {
        const k = i + j * cols;
        const gx = Math.abs(curl[k + 1]) - Math.abs(curl[k - 1]);
        const gy = Math.abs(curl[k + cols]) - Math.abs(curl[k - cols]);
        const len = Math.hypot(gx, gy) + 1e-5;
        flowX[k] += (gy / len) * curl[k] * confine * dt;
        flowY[k] -= (gx / len) * curl[k] * confine * dt;
      }
    }
    lastX.set(flowX);
    lastY.set(flowY);
    const back = dt / cell;
    const fade = Math.exp(-dt / (0.35 + 1.5 * s.swirl));
    for (let j = 1; j < rows - 1; j++) {
      for (let i = 1; i < cols - 1; i++) {
        const k = i + j * cols;
        let x = clamp(i - back * lastX[k], 0.5, cols - 1.5);
        let y = clamp(j - back * lastY[k], 0.5, rows - 1.5);
        const i0 = x | 0;
        const j0 = y | 0;
        const fx = x - i0;
        const fy = y - j0;
        const a = i0 + j0 * cols;
        flowX[k] =
          ((lastX[a] * (1 - fx) + lastX[a + 1] * fx) * (1 - fy) +
            (lastX[a + cols] * (1 - fx) + lastX[a + cols + 1] * fx) * fy) *
          fade;
        flowY[k] =
          ((lastY[a] * (1 - fx) + lastY[a + 1] * fx) * (1 - fy) +
            (lastY[a + cols] * (1 - fx) + lastY[a + cols + 1] * fx) * fy) *
          fade;
      }
    }
    applyWalls(flowX, 1, cols, rows);
    applyWalls(flowY, 2, cols, rows);
    solvePressure(this.grid, PRESSURE_STEPS);
  }

  private pushCrowd(view: SwarmViewState, n: number, h: number): number {
    const gc = Math.max(1, Math.ceil(view.width / h) + 2);
    const gr = Math.max(1, Math.ceil(view.height / h) + 2);
    if (this.crowdHeads.length < gc * gr) this.crowdHeads = new Int32Array(gc * gr);
    this.crowdHeads.fill(-1, 0, gc * gr);
    this.crowdRows = gr;
    for (let i = 0; i < n; i++) {
      const cx = clamp(Math.floor(this.px[i] / h) + 1, 0, gc - 1);
      const cy = clamp(Math.floor(this.py[i] / h) + 1, 0, gr - 1);
      const key = cy * gc + cx;
      this.crowd[i] = this.crowdHeads[key];
      this.crowdHeads[key] = i;
    }
    return gc;
  }

  move(s: SwarmSettings, view: SwarmViewState, dt: number, ease: number): void {
    const n = s.count;
    const radius = s.spread;
    const loose = 1 - 0.6 * s.tail;
    const gather = 12 * loose * (0.2 + 0.8 * ease);
    const pull = 30 * loose * (0.2 + 0.8 * ease);
    const band = Math.max(4, radius * 0.16);
    const w = view.width;
    const h = view.height;
    const gap = radius * Math.sqrt(Math.PI / Math.max(n, 1)) * 1.6;
    const repel = 4000;
    const gc = this.pushCrowd(view, n, gap);

    for (let i = 0; i < n; i++) {
      const x = this.px[i];
      const y = this.py[i];
      const k = 10 * (1 - 0.6 * s.tail * this.heft[i]);
      let ax = (sampleField(this.grid.flowX, x, y, this.grid.cell, this.grid.cols, this.grid.rows) - this.vx[i]) * k;
      let ay = (sampleField(this.grid.flowY, x, y, this.grid.cell, this.grid.cols, this.grid.rows) - this.vy[i]) * k;
      const cx = clamp(Math.floor(x / gap) + 1, 0, gc - 1);
      const cy = clamp(Math.floor(y / gap) + 1, 0, this.crowdRows - 1);

      for (let oy = -1; oy <= 1; oy++) {
        const row = cy + oy;
        if (row < 0 || row >= this.crowdRows) continue;
        for (let ox = -1; ox <= 1; ox++) {
          const col = cx + ox;
          if (col < 0 || col >= gc) continue;
          for (let j = this.crowdHeads[row * gc + col]; j !== -1; j = this.crowd[j]) {
            if (j === i) continue;
            const dx = x - this.px[j];
            const dy = y - this.py[j];
            const d2 = dx * dx + dy * dy;
            if (d2 >= gap * gap || d2 < 1e-6) continue;
            const d = Math.sqrt(d2);
            const q = 1 - d / gap;
            ax += (dx / d) * q * q * repel;
            ay += (dy / d) * q * q * repel;
          }
        }
      }

      if (this.ring.active) {
        rectField(x - this.ring.x, y - this.ring.y, this.ring.hx, this.ring.hy, this.ring.corner, this.field);
        const e = this.field[0] - (5 + band * this.home[i] * this.home[i]);
        const hold = e > 0 ? 70 : 140;
        ax -= this.field[1] * e * hold;
        ay -= this.field[2] * e * hold;
      } else {
        const dx = this.anchor.x - x;
        const dy = this.anchor.y - y;
        const d = Math.hypot(dx, dy) + 0.001;
        const over = Math.max(0, d - radius);
        ax += (dx / d) * (d * gather + over * pull);
        ay += (dy / d) * (d * gather + over * pull);
      }

      if (this.introClock >= 1) {
        if (x < 8) ax += (8 - x) * 30;
        else if (x > w - 8) ax -= (x - w + 8) * 30;
        if (y < 8) ay += (8 - y) * 30;
        else if (y > h - 8) ay -= (y - h + 8) * 30;
      }

      const lift = Math.sin(this.time * this.bobRate[i] + this.bob[i]) * radius * (this.ring.active ? 0.15 : 0.55);
      const az = (lift - this.pz[i]) * 36 - this.vz[i] * 9;
      this.vx[i] += ax * dt;
      this.vy[i] += ay * dt;
      this.vz[i] += az * dt;
      this.px[i] += this.vx[i] * dt;
      this.py[i] += this.vy[i] * dt;
      this.pz[i] += this.vz[i] * dt;
    }
  }
}

