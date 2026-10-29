/**
 * GLSL ES 3.0 Shaders & WebGL2 Linking Utilities for SwarmCursor
 */

export const VERTEX = `#version 300 es
layout(location = 0) in vec2 aCorner;
layout(location = 1) in vec4 aAgent;
layout(location = 2) in vec4 aLook;
layout(location = 3) in vec2 aExtra;
uniform vec2 uView;
out vec2 vLocal;
out vec2 vHalf;
out float vAlpha;
out float vTint;
out float vSoft;
out float vShape;

void main() {
  vec2 dir = aAgent.zw;
  vec2 side = vec2(-dir.y, dir.x);
  vec2 extent = aLook.xy * 0.5;
  vec2 pad = extent + 1.0 + aExtra.x * 1.5;
  vec2 local = aCorner * pad;
  vec2 center = aAgent.xy - dir * (extent.x - extent.y);
  vec2 pos = center + dir * local.x + side * local.y;
  vLocal = local;
  vHalf = extent;
  vAlpha = aLook.z;
  vTint = aLook.w;
  vSoft = aExtra.x;
  vShape = aExtra.y;
  vec2 clip = pos / uView * 2.0 - 1.0;
  gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);
}`;

export const FRAGMENT = `#version 300 es
precision highp float;
uniform vec3 uColor;
uniform vec3 uAccent;
uniform float uRatio;
in vec2 vLocal;
in vec2 vHalf;
in float vAlpha;
in float vTint;
in float vSoft;
in float vShape;
out vec4 outColor;

void main() {
  float d;
  if (vShape > 0.5 && vShape < 1.5) {
    float corner = vHalf.y * 0.3;
    vec2 q = abs(vLocal) - vHalf + corner;
    d = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - corner;
  } else {
    vec2 q = vLocal;
    q.x = max(abs(q.x) - (vHalf.x - vHalf.y), 0.0);
    d = length(q) - vHalf.y;
  }
  float edge = 0.6 / uRatio + vSoft;
  float cover = 1.0 - smoothstep(-edge, edge, d);
  float stretch = clamp(1.0 - vHalf.y / max(vHalf.x, 0.001), 0.0, 1.0);
  float head = clamp((vLocal.x + vHalf.x) / max(2.0 * vHalf.x, 0.001), 0.0, 1.0);
  cover *= mix(1.0, 0.12 + 0.88 * head * head, stretch);
  float alpha = cover * vAlpha;
  outColor = vec4(mix(uColor, uAccent, vTint) * alpha, alpha);
}`;

export const compile = (gl: WebGL2RenderingContext, type: number, source: string): WebGLShader | null => {
  const shader = gl.createShader(type);
  if (!shader) {
    console.error("SwarmCursor: gl.createShader returned null! gl error:", gl.getError());
    return null;
  }
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (gl.getShaderParameter(shader, gl.COMPILE_STATUS)) return shader;
  const info = gl.getShaderInfoLog(shader);
  console.error("SwarmCursor SHADER COMPILE ERROR:", type === gl.VERTEX_SHADER ? "VERTEX" : "FRAGMENT", "info:", info, "gl error:", gl.getError(), "source start:", JSON.stringify(source.slice(0, 50)));
  gl.deleteShader(shader);
  return null;
};

export interface ShaderProgramLink {
  program: WebGLProgram;
  uniforms: Record<string, WebGLUniformLocation>;
}

export const link = (gl: WebGL2RenderingContext): ShaderProgramLink | null => {
  const vertex = compile(gl, gl.VERTEX_SHADER, VERTEX);
  const fragment = compile(gl, gl.FRAGMENT_SHADER, FRAGMENT);
  const program = gl.createProgram();
  if (!vertex || !fragment || !program) return null;
  gl.attachShader(program, vertex);
  gl.attachShader(program, fragment);
  gl.linkProgram(program);
  gl.deleteShader(vertex);
  gl.deleteShader(fragment);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    console.error("SwarmCursor PROGRAM LINK ERROR:", gl.getProgramInfoLog(program));
    gl.deleteProgram(program);
    return null;
  }
  const uniforms: Record<string, WebGLUniformLocation> = {};
  const count = gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS);
  for (let i = 0; i < count; i++) {
    const info = gl.getActiveUniform(program, i);
    if (info) {
      const loc = gl.getUniformLocation(program, info.name);
      if (loc) uniforms[info.name] = loc;
    }
  }
  return { program, uniforms };
};

