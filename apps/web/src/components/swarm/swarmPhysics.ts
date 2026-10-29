/**
 * 2D Eulerian Fluid Dynamics & Particle Physics for SwarmCursor
 */

import { CELL, rectField, clamp } from "./swarmMath";

export interface PhysicsGrid {
  cols: number;
  rows: number;
  cell: number;
  flowX: Float32Array;
  flowY: Float32Array;
  lastX: Float32Array;
  lastY: Float32Array;
  pressure: Float32Array;
  divergence: Float32Array;
  curl: Float32Array;
}

export const sampleField = (values: Float32Array, x: number, y: number, cell: number, cols: number, rows: number): number => {
  let gx = x / cell - 0.5;
  let gy = y / cell - 0.5;
  if (gx < 0) gx = 0;
  else if (gx > cols - 1.001) gx = cols - 1.001;
  if (gy < 0) gy = 0;
  else if (gy > rows - 1.001) gy = rows - 1.001;
  const i = gx | 0;
  const j = gy | 0;
  const fx = gx - i;
  const fy = gy - j;
  const k = i + j * cols;
  return (
    (values[k] * (1 - fx) + values[k + 1] * fx) * (1 - fy) +
    (values[k + cols] * (1 - fx) + values[k + cols + 1] * fx) * fy
  );
};

export const applyWalls = (values: Float32Array, axis: number, cols: number, rows: number) => {
  for (let j = 1; j < rows - 1; j++) {
    const left = j * cols;
    const right = left + cols - 1;
    values[left] = axis === 1 ? -values[left + 1] : values[left + 1];
    values[right] = axis === 1 ? -values[right - 1] : values[right - 1];
  }
  for (let i = 1; i < cols - 1; i++) {
    const bottom = i + (rows - 1) * cols;
    values[i] = axis === 2 ? -values[i + cols] : values[i + cols];
    values[bottom] = axis === 2 ? -values[bottom - cols] : values[bottom - cols];
  }
  values[0] = 0.5 * (values[1] + values[cols]);
  values[cols - 1] = 0.5 * (values[cols - 2] + values[2 * cols - 1]);
  values[(rows - 1) * cols] = 0.5 * (values[(rows - 2) * cols] + values[(rows - 1) * cols + 1]);
  values[rows * cols - 1] = 0.5 * (values[rows * cols - 2] + values[(rows - 1) * cols - 1]);
};

export const solvePressure = (grid: PhysicsGrid, steps: number) => {
  const { cols, rows, cell, flowX, flowY, divergence, pressure } = grid;
  const total = cols * rows;
  const h2 = cell * cell;

  for (let j = 1; j < rows - 1; j++) {
    for (let i = 1; i < cols - 1; i++) {
      const k = i + j * cols;
      divergence[k] = (flowX[k + 1] - flowX[k - 1] + flowY[k + cols] - flowY[k - cols]) * (0.5 / cell);
    }
  }
  pressure.fill(0, 0, total);
  applyWalls(divergence, 0, cols, rows);

  for (let step = 0; step < steps; step++) {
    for (let j = 1; j < rows - 1; j++) {
      for (let i = 1; i < cols - 1; i++) {
        const k = i + j * cols;
        pressure[k] =
          (pressure[k - 1] + pressure[k + 1] + pressure[k - cols] + pressure[k + cols] - h2 * divergence[k]) * 0.25;
      }
    }
    applyWalls(pressure, 0, cols, rows);
  }

  for (let j = 1; j < rows - 1; j++) {
    for (let i = 1; i < cols - 1; i++) {
      const k = i + j * cols;
      flowX[k] -= (pressure[k + 1] - pressure[k - 1]) * (0.5 / cell);
      flowY[k] -= (pressure[k + cols] - pressure[k - cols]) * (0.5 / cell);
    }
  }
  applyWalls(flowX, 1, cols, rows);
  applyWalls(flowY, 2, cols, rows);
};

