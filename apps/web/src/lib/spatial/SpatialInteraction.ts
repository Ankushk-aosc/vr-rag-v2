import * as THREE from "three";
import { spatialLayout } from "./spatialLayout";

/**
 * Lets the user move any registered 3D object anywhere:
 *  - mouse / touch: press on an object and drag (it slides on a plane facing the camera and turns to
 *    face you); scroll while hovering pushes it further / pulls it closer.
 *  - WebXR controllers or hand pinch: point and squeeze the trigger to grab, carry it, release to drop.
 *    While holding, the thumbstick pushes / pulls it along the ray.
 * A press without movement is a click. Placements are persisted through spatialLayout.
 */

export interface DraggableItem {
  id: string;
  object: THREE.Object3D;
  onClick?: () => void;
  onHover?: (hovered: boolean) => void;
  /** Receives the exact ray hit while hovered (null when the pointer leaves) - used for chart tooltips. */
  onHoverDetail?: (hit: THREE.Intersection | null) => void;
  /** Turn to face the viewer while being moved (panels). Default true. */
  faceCamera?: boolean;
  /** Click-only (buttons attached to a panel): never moved by dragging. */
  fixed?: boolean;
}

export interface PickResult {
  camera: THREE.Camera;
  ndc: THREE.Vector2;
}

interface InteractionOptions {
  dom: HTMLElement;
  scene: THREE.Scene;
  /** The live list of interactive objects (read on every event, so added/removed items just work). */
  getItems: () => DraggableItem[];
  /** Map a client point to a camera + normalised device coords (handles split-screen stereo). */
  pick: (clientX: number, clientY: number) => PickResult | null;
  renderer?: THREE.WebGLRenderer;
  /** Parent for XR controllers (the camera rig / dolly). */
  xrParent?: THREE.Object3D;
  onBackgroundDrag?: (dx: number, dy: number) => void;
  onBackgroundWheel?: (deltaY: number) => void;
  /** Thumbstick input when nothing is grabbed (locomotion). */
  onThumbstick?: (handedness: XRHandedness, x: number, y: number, dt: number) => void;
  isLocked?: () => boolean;
}

type PointerDrag =
  | {
      kind: "object";
      item: DraggableItem;
      camera: THREE.Camera;
      plane: THREE.Plane;
      offset: THREE.Vector3;
      startX: number;
      startY: number;
      moved: boolean;
    }
  | { kind: "background"; lastX: number; lastY: number; startX: number; startY: number; moved: boolean };

interface XrGrab {
  item: DraggableItem;
  parent: THREE.Object3D;
  startedAt: number;
  startWorld: THREE.Vector3;
}

const CLICK_PX = 5;

/** An object counts as visible only if it and all its ancestors are visible. */
function isVisible(o: THREE.Object3D | null): boolean {
  for (let n = o; n; n = n.parent) if (!n.visible) return false;
  return true;
}

export class SpatialInteraction {
  private raycaster = new THREE.Raycaster();
  private drag: PointerDrag | null = null;
  private hovered: DraggableItem | null = null;
  private controllers: THREE.XRTargetRaySpace[] = [];
  private lasers: THREE.Line[] = [];
  private grabs: (XrGrab | null)[] = [null, null];
  private tmpMatrix = new THREE.Matrix4();
  private wheelSaveTimer: ReturnType<typeof setTimeout> | null = null;
  private disposers: (() => void)[] = [];

  constructor(private opts: InteractionOptions) {
    const { dom } = opts;
    const down = (e: PointerEvent) => this.onPointerDown(e);
    const move = (e: PointerEvent) => this.onPointerMove(e);
    const up = (e: PointerEvent) => this.onPointerUp(e);
    const wheel = (e: WheelEvent) => this.onWheel(e);
    const leave = () => this.setHovered(null);
    dom.addEventListener("pointerdown", down);
    dom.addEventListener("pointermove", move);
    dom.addEventListener("pointerup", up);
    dom.addEventListener("pointercancel", up);
    dom.addEventListener("pointerleave", leave);
    dom.addEventListener("wheel", wheel, { passive: false });
    this.disposers.push(() => {
      dom.removeEventListener("pointerdown", down);
      dom.removeEventListener("pointermove", move);
      dom.removeEventListener("pointerup", up);
      dom.removeEventListener("pointercancel", up);
      dom.removeEventListener("pointerleave", leave);
      dom.removeEventListener("wheel", wheel);
    });
    if (opts.renderer) this.setupXr(opts.renderer);
  }

  // ---------------------------------------------------------------- picking

  private hitTest(
    raycaster: THREE.Raycaster
  ): { item: DraggableItem; point: THREE.Vector3; distance: number; hit: THREE.Intersection } | null {
    const items = this.opts.getItems();
    const roots = items.filter((i) => isVisible(i.object)).map((i) => i.object);
    const hits = raycaster.intersectObjects(roots, true);
    for (const hit of hits) {
      if (!isVisible(hit.object)) continue;
      // the innermost registered object wins, so a button on a panel gets the click, not the panel
      let o: THREE.Object3D | null = hit.object;
      while (o) {
        const item = items.find((i) => i.object === o);
        if (item) return { item, point: hit.point.clone(), distance: hit.distance, hit };
        o = o.parent;
      }
    }
    return null;
  }

  private rayFromPointer(e: { clientX: number; clientY: number }): THREE.Camera | null {
    const picked = this.opts.pick(e.clientX, e.clientY);
    if (!picked) return null;
    this.raycaster.setFromCamera(picked.ndc, picked.camera);
    return picked.camera;
  }

  private setHovered(item: DraggableItem | null, hit: THREE.Intersection | null = null) {
    if (this.hovered !== item) {
      this.hovered?.onHover?.(false);
      this.hovered?.onHoverDetail?.(null);
      this.hovered = item;
      item?.onHover?.(true);
      this.opts.dom.style.cursor = item ? (item.fixed || this.opts.isLocked?.() ? "pointer" : "grab") : "default";
    }
    item?.onHoverDetail?.(hit);
  }

  private faceTowards(obj: THREE.Object3D, viewer: THREE.Vector3) {
    obj.rotation.set(0, Math.atan2(viewer.x - obj.position.x, viewer.z - obj.position.z), 0);
  }

  // ---------------------------------------------------------------- mouse / touch

  private onPointerDown(e: PointerEvent) {
    if (this.opts.renderer?.xr.isPresenting || (e.pointerType === "mouse" && e.button !== 0)) return;
    const camera = this.rayFromPointer(e);
    if (!camera) return;
    const hit = this.hitTest(this.raycaster);
    try {
      this.opts.dom.setPointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    if (hit) {
      const normal = new THREE.Vector3();
      camera.getWorldDirection(normal).negate();
      const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(normal, hit.point);
      this.drag = {
        kind: "object",
        item: hit.item,
        camera,
        plane,
        offset: hit.item.object.position.clone().sub(hit.point),
        startX: e.clientX,
        startY: e.clientY,
        moved: false,
      };
      this.opts.dom.style.cursor = this.opts.isLocked?.() ? "pointer" : "grabbing";
    } else {
      this.drag = { kind: "background", lastX: e.clientX, lastY: e.clientY, startX: e.clientX, startY: e.clientY, moved: false };
    }
  }

  private onPointerMove(e: PointerEvent) {
    const d = this.drag;
    if (!d) {
      if (this.opts.renderer?.xr.isPresenting) return;
      if (this.rayFromPointer(e)) {
        const found = this.hitTest(this.raycaster);
        this.setHovered(found?.item || null, found?.hit || null);
      }
      return;
    }
    if (Math.hypot(e.clientX - d.startX, e.clientY - d.startY) > CLICK_PX) d.moved = true;
    if (d.kind === "background") {
      this.opts.onBackgroundDrag?.(e.clientX - d.lastX, e.clientY - d.lastY);
      d.lastX = e.clientX;
      d.lastY = e.clientY;
      return;
    }
    if (!d.moved || d.item.fixed || this.opts.isLocked?.()) return;
    const picked = this.opts.pick(e.clientX, e.clientY);
    if (!picked) return;
    this.raycaster.setFromCamera(picked.ndc, d.camera);
    const point = new THREE.Vector3();
    if (this.raycaster.ray.intersectPlane(d.plane, point)) {
      const obj = d.item.object;
      obj.position.copy(point.add(d.offset));
      obj.position.y = Math.max(0.15, Math.min(4.5, obj.position.y));
      if (d.item.faceCamera !== false) {
        this.faceTowards(obj, d.camera.getWorldPosition(new THREE.Vector3()));
      }
    }
  }

  private onPointerUp(e: PointerEvent) {
    const d = this.drag;
    this.drag = null;
    try {
      this.opts.dom.releasePointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    if (!d) return;
    if (d.kind === "object") {
      if (d.moved && !d.item.fixed && !this.opts.isLocked?.()) spatialLayout.save(d.item.id, d.item.object);
      else if (!d.moved) d.item.onClick?.();
      this.opts.dom.style.cursor = this.hovered ? "grab" : "default";
    }
  }

  private onWheel(e: WheelEvent) {
    if (this.opts.renderer?.xr.isPresenting) return;
    e.preventDefault();
    const item = this.hovered;
    if (!item || item.fixed || this.opts.isLocked?.()) {
      this.opts.onBackgroundWheel?.(e.deltaY);
      return;
    }
    const camera = this.rayFromPointer(e);
    if (!camera) return;
    const camPos = camera.getWorldPosition(new THREE.Vector3());
    const obj = item.object;
    const dir = obj.position.clone().sub(camPos);
    const dist = THREE.MathUtils.clamp(dir.length() * (1 + Math.sign(e.deltaY) * 0.08), 0.8, 10);
    obj.position.copy(camPos.add(dir.normalize().multiplyScalar(dist)));
    if (this.wheelSaveTimer) clearTimeout(this.wheelSaveTimer);
    this.wheelSaveTimer = setTimeout(() => spatialLayout.save(item.id, obj), 300);
  }

  // ---------------------------------------------------------------- WebXR

  private setupXr(renderer: THREE.WebGLRenderer) {
    const parent = this.opts.xrParent || this.opts.scene;
    const laserGeo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, -1)]);
    for (let i = 0; i < 2; i++) {
      const controller = renderer.xr.getController(i);
      const laser = new THREE.Line(
        laserGeo,
        new THREE.LineBasicMaterial({ color: 0xa78bfa, transparent: true, opacity: 0.8, fog: false })
      );
      laser.scale.z = 5;
      laser.raycast = () => {};
      controller.add(laser);
      parent.add(controller);
      const onConnected = (event: any) => {
        controller.userData.inputSource = event.data;
        laser.visible = event.data?.targetRayMode !== "gaze";
      };
      const onDisconnected = () => {
        controller.userData.inputSource = null;
      };
      const onSelectStart = () => this.xrGrab(i);
      const onSelectEnd = () => this.xrRelease(i);
      controller.addEventListener("connected", onConnected);
      controller.addEventListener("disconnected", onDisconnected);
      controller.addEventListener("selectstart", onSelectStart);
      controller.addEventListener("selectend", onSelectEnd);
      this.disposers.push(() => {
        controller.removeEventListener("connected", onConnected);
        controller.removeEventListener("disconnected", onDisconnected);
        controller.removeEventListener("selectstart", onSelectStart);
        controller.removeEventListener("selectend", onSelectEnd);
        controller.remove(laser);
        parent.remove(controller);
      });
      this.controllers.push(controller);
      this.lasers.push(laser);
    }
  }

  private rayFromController(controller: THREE.Object3D) {
    controller.updateMatrixWorld();
    this.tmpMatrix.identity().extractRotation(controller.matrixWorld);
    this.raycaster.ray.origin.setFromMatrixPosition(controller.matrixWorld);
    this.raycaster.ray.direction.set(0, 0, -1).applyMatrix4(this.tmpMatrix);
  }

  private xrGrab(i: number) {
    const controller = this.controllers[i];
    this.rayFromController(controller);
    const hit = this.hitTest(this.raycaster);
    if (!hit) return;
    const obj = hit.item.object;
    const parent = obj.parent || this.opts.scene;
    const grab: XrGrab = {
      item: hit.item,
      parent,
      startedAt: performance.now(),
      startWorld: obj.getWorldPosition(new THREE.Vector3()),
    };
    if (!hit.item.fixed && !this.opts.isLocked?.()) controller.attach(obj);
    this.grabs[i] = grab;
  }

  private xrRelease(i: number) {
    const grab = this.grabs[i];
    this.grabs[i] = null;
    if (!grab) return;
    const obj = grab.item.object;
    const moved = obj.getWorldPosition(new THREE.Vector3()).distanceTo(grab.startWorld);
    if (obj.parent !== grab.parent) grab.parent.attach(obj);
    const quick = performance.now() - grab.startedAt < 450;
    if (moved < 0.04 && quick) {
      // put it back exactly and treat as a click
      grab.parent.worldToLocal(grab.startWorld);
      obj.position.copy(grab.startWorld);
      grab.item.onClick?.();
      return;
    }
    const head = this.opts.renderer!.xr.getCamera().getWorldPosition(new THREE.Vector3());
    grab.parent.worldToLocal(head);
    if (grab.item.faceCamera !== false) this.faceTowards(obj, head);
    else obj.rotation.set(0, obj.rotation.y, 0);
    spatialLayout.save(grab.item.id, obj);
  }

  /** Call every frame: XR hover, laser length and thumbstick input. */
  update(dt: number) {
    const renderer = this.opts.renderer;
    if (!renderer?.xr.isPresenting) return;
    let hoverItem: DraggableItem | null = null;
    let hoverHit: THREE.Intersection | null = null;
    this.controllers.forEach((controller, i) => {
      const laser = this.lasers[i];
      const source: XRInputSource | null = controller.userData.inputSource || null;
      const grab = this.grabs[i];
      const axes = source?.gamepad?.axes || [];
      const stickX = axes.length >= 4 ? axes[2] : axes[0] || 0;
      const stickY = axes.length >= 4 ? axes[3] : axes[1] || 0;

      if (grab) {
        laser.scale.z = Math.max(0.2, -grab.item.object.position.z);
        if (Math.abs(stickY) > 0.15) {
          const obj = grab.item.object; // local to the controller while held
          obj.position.z = THREE.MathUtils.clamp(obj.position.z + stickY * dt * 2.5, -9, -0.25);
        }
        return;
      }
      this.rayFromController(controller);
      const hit = this.hitTest(this.raycaster);
      laser.scale.z = hit ? hit.distance : 5;
      if (hit && !hoverItem) {
        hoverItem = hit.item;
        hoverHit = hit.hit;
      }
      if (source && (Math.abs(stickX) > 0.15 || Math.abs(stickY) > 0.15)) {
        this.opts.onThumbstick?.(source.handedness, stickX, stickY, dt);
      }
    });
    this.setHovered(hoverItem, hoverHit);
  }

  dispose() {
    this.disposers.forEach((d) => d());
    this.disposers = [];
    if (this.wheelSaveTimer) clearTimeout(this.wheelSaveTimer);
  }
}
