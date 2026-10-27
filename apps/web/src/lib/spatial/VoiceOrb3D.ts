import * as THREE from "three";
import { VoicePhase } from "../../types";

/**
 * Audio-reactive voice orb: an icosphere displaced by 3D simplex noise in the vertex shader,
 * shaded with a fresnel rim. Each voice phase has its own look, and the displacement follows the
 * real microphone level (listening) or the assistant's audio output (speaking).
 */

const NOISE = /* glsl */ `
vec3 mod289(vec3 x){return x-floor(x*(1.0/289.0))*289.0;}
vec4 mod289(vec4 x){return x-floor(x*(1.0/289.0))*289.0;}
vec4 permute(vec4 x){return mod289(((x*34.0)+1.0)*x);}
vec4 taylorInvSqrt(vec4 r){return 1.79284291400159-0.85373472095314*r;}
float snoise(vec3 v){
  const vec2 C=vec2(1.0/6.0,1.0/3.0); const vec4 D=vec4(0.0,0.5,1.0,2.0);
  vec3 i=floor(v+dot(v,C.yyy)); vec3 x0=v-i+dot(i,C.xxx);
  vec3 g=step(x0.yzx,x0.xyz); vec3 l=1.0-g; vec3 i1=min(g.xyz,l.zxy); vec3 i2=max(g.xyz,l.zxy);
  vec3 x1=x0-i1+C.xxx; vec3 x2=x0-i2+C.yyy; vec3 x3=x0-D.yyy;
  i=mod289(i);
  vec4 p=permute(permute(permute(i.z+vec4(0.0,i1.z,i2.z,1.0))+i.y+vec4(0.0,i1.y,i2.y,1.0))+i.x+vec4(0.0,i1.x,i2.x,1.0));
  float n_=0.142857142857; vec3 ns=n_*D.wyz-D.xzx;
  vec4 j=p-49.0*floor(p*ns.z*ns.z); vec4 x_=floor(j*ns.z); vec4 y_=floor(j-7.0*x_);
  vec4 x=x_*ns.x+ns.yyyy; vec4 y=y_*ns.x+ns.yyyy; vec4 h=1.0-abs(x)-abs(y);
  vec4 b0=vec4(x.xy,y.xy); vec4 b1=vec4(x.zw,y.zw);
  vec4 s0=floor(b0)*2.0+1.0; vec4 s1=floor(b1)*2.0+1.0; vec4 sh=-step(h,vec4(0.0));
  vec4 a0=b0.xzyw+s0.xzyw*sh.xxyy; vec4 a1=b1.xzyw+s1.xzyw*sh.zzww;
  vec3 p0=vec3(a0.xy,h.x); vec3 p1=vec3(a0.zw,h.y); vec3 p2=vec3(a1.xy,h.z); vec3 p3=vec3(a1.zw,h.w);
  vec4 norm=taylorInvSqrt(vec4(dot(p0,p0),dot(p1,p1),dot(p2,p2),dot(p3,p3)));
  p0*=norm.x; p1*=norm.y; p2*=norm.z; p3*=norm.w;
  vec4 m=max(0.6-vec4(dot(x0,x0),dot(x1,x1),dot(x2,x2),dot(x3,x3)),0.0); m=m*m;
  return 42.0*dot(m*m,vec4(dot(p0,x0),dot(p1,x1),dot(p2,x2),dot(p3,x3)));
}`;

const VERT = /* glsl */ `
uniform float uTime; uniform float uAmp; uniform float uFreq;
varying vec3 vNormal; varying vec3 vView; varying float vNoise;
${NOISE}
void main(){
  float n = snoise(normal * uFreq + vec3(uTime * 0.61, uTime * 0.37, uTime * 0.53));
  float n2 = snoise(normal * uFreq * 2.4 - vec3(uTime * 0.9)) * 0.45;
  vNoise = n;
  vec3 pos = position + normal * (n + n2) * uAmp;
  vec4 mv = modelViewMatrix * vec4(pos, 1.0);
  vNormal = normalize(normalMatrix * normal);
  vView = normalize(-mv.xyz);
  gl_Position = projectionMatrix * mv;
}`;

const FRAG = /* glsl */ `
uniform vec3 uA; uniform vec3 uB; uniform vec3 uC; uniform float uGlow;
varying vec3 vNormal; varying vec3 vView; varying float vNoise;
void main(){
  float fres = pow(1.0 - max(dot(normalize(vNormal), normalize(vView)), 0.0), 2.1);
  vec3 base = mix(uA, uB, smoothstep(-0.55, 0.85, vNoise));
  vec3 col = base * (0.55 + 0.5 * uGlow) + uC * fres * (0.75 + uGlow);
  gl_FragColor = vec4(col, 0.93 + 0.07 * fres);
}`;

interface Look {
  amp: number;
  speed: number;
  glow: number;
  freq: number;
  a: THREE.Color;
  b: THREE.Color;
  c: THREE.Color;
}

const col = (hex: string) => new THREE.Color(hex);
const LOOKS: Record<"idle" | "listening" | "thinking" | "speaking", Omit<Look, "amp" | "speed" | "glow"> & { amp: number; speed: number; glow: number }> = {
  idle: { amp: 0.018, speed: 0.22, glow: 0.12, freq: 1.4, a: col("#2E1065"), b: col("#6D28D9"), c: col("#C4B5FD") },
  listening: { amp: 0.045, speed: 0.8, glow: 0.35, freq: 1.7, a: col("#1E1B4B"), b: col("#7C3AED"), c: col("#A5B4FC") },
  thinking: { amp: 0.06, speed: 2.1, glow: 0.45, freq: 2.2, a: col("#4A044E"), b: col("#A21CAF"), c: col("#F5D0FE") },
  speaking: { amp: 0.04, speed: 0.95, glow: 0.4, freq: 1.6, a: col("#3B0764"), b: col("#9333EA"), c: col("#FDE68A") },
};

function haloTexture(): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = c.height = 256;
  const g = c.getContext("2d")!;
  const grad = g.createRadialGradient(128, 128, 20, 128, 128, 128);
  grad.addColorStop(0, "rgba(196,181,253,0.55)");
  grad.addColorStop(0.45, "rgba(139,92,246,0.22)");
  grad.addColorStop(1, "rgba(139,92,246,0)");
  g.fillStyle = grad;
  g.fillRect(0, 0, 256, 256);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export class VoiceOrb3D {
  readonly group = new THREE.Group();
  readonly core: THREE.Mesh;
  private material: THREE.ShaderMaterial;
  private halo: THREE.Sprite;
  private haloTex: THREE.CanvasTexture;
  private t = 0;
  private cur: Look;
  private hovered = false;
  private pulse = 0;
  private readonly radius: number;

  constructor(radius = 0.3) {
    this.radius = radius;
    const base = LOOKS.idle;
    this.cur = { ...base, a: base.a.clone(), b: base.b.clone(), c: base.c.clone() };
    this.material = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      uniforms: {
        uTime: { value: 0 },
        uAmp: { value: base.amp },
        uFreq: { value: base.freq },
        uGlow: { value: base.glow },
        uA: { value: this.cur.a },
        uB: { value: this.cur.b },
        uC: { value: this.cur.c },
      },
    });
    this.core = new THREE.Mesh(new THREE.IcosahedronGeometry(radius, 40), this.material);
    this.core.name = "voice-orb";
    this.group.add(this.core);

    this.haloTex = haloTexture();
    this.halo = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: this.haloTex,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        fog: false,
      })
    );
    this.halo.scale.setScalar(radius * 4.2);
    this.halo.raycast = () => {};
    this.group.add(this.halo);
  }

  setHovered(h: boolean) {
    this.hovered = h;
  }

  /** Visual acknowledgement of a tap. */
  tapPulse() {
    this.pulse = 1;
  }

  update(dt: number, phase: VoicePhase, conversation: boolean, micLevel: number, outLevel: number) {
    const key = !conversation && phase !== "speaking" ? "idle" : phase === "transcribing" ? "thinking" : phase === "idle" ? "listening" : phase;
    const look = LOOKS[key];
    const level = key === "listening" ? micLevel : key === "speaking" ? outLevel : 0;

    const targetAmp = look.amp + level * 0.32;
    const targetSpeed = look.speed + level * 1.6;
    const targetGlow = look.glow + level * 0.9 + (this.hovered ? 0.15 : 0) + this.pulse * 0.6;

    const k = 1 - Math.exp(-dt * 7);
    this.cur.amp += (targetAmp - this.cur.amp) * k;
    this.cur.speed += (targetSpeed - this.cur.speed) * k;
    this.cur.glow += (targetGlow - this.cur.glow) * k;
    this.cur.freq += (look.freq - this.cur.freq) * k * 0.5;
    this.cur.a.lerp(look.a, k * 0.6);
    this.cur.b.lerp(look.b, k * 0.6);
    this.cur.c.lerp(look.c, k * 0.6);
    this.pulse = Math.max(0, this.pulse - dt * 2.5);

    this.t += dt * this.cur.speed;
    const u = this.material.uniforms;
    u.uTime.value = this.t;
    u.uAmp.value = this.cur.amp;
    u.uFreq.value = this.cur.freq;
    u.uGlow.value = this.cur.glow;

    const s = 1 + level * 0.14 + (this.hovered ? 0.05 : 0) + this.pulse * 0.08;
    this.core.scale.setScalar(s);
    this.halo.scale.setScalar(this.radius * 4.2 * (0.9 + this.cur.glow * 0.45));
    if (key === "thinking") this.core.rotation.y += dt * 0.8;
  }

  dispose() {
    this.core.geometry.dispose();
    this.material.dispose();
    this.haloTex.dispose();
    (this.halo.material as THREE.SpriteMaterial).dispose();
  }
}
