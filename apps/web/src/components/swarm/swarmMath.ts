/**
 * Mathematical Utilities & Constants for SwarmCursor Simulation
 */

export const MAX_PARTICLES = 2000;
export const INTRO_SECONDS = 1.4;
export const HIDDEN = 'swarm-cursor-hidden';
export const SHAPES: Record<string, number> = { dot: 0, square: 1, streak: 2 };
export const CELL = 16;
export const MAX_COLS = 72;
export const MAX_ROWS = 48;
export const PRESSURE_STEPS = 12;

export const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value));

export const random = (seed: number) => {
  let state = (seed >>> 0) || 1;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 4294967296;
  };
};

export const rectField = (
  x: number,
  y: number,
  hx: number,
  hy: number,
  r: number,
  out: number[] | Float32Array
): number[] | Float32Array => {
  const sx = x < 0 ? -1 : 1;
  const sy = y < 0 ? -1 : 1;
  const qx = Math.abs(x) - (hx - r);
  const qy = Math.abs(y) - (hy - r);
  if (qx > 0 && qy > 0) {
    const l = Math.hypot(qx, qy) || 1;
    out[0] = l - r;
    out[1] = (qx / l) * sx;
    out[2] = (qy / l) * sy;
  } else if (qx > qy) {
    out[0] = qx - r;
    out[1] = sx;
    out[2] = 0;
  } else {
    out[0] = qy - r;
    out[1] = 0;
    out[2] = sy;
  }
  return out;
};

