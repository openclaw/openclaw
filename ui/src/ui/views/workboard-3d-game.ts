import type * as THREE from "three";

type ThreeModule = typeof THREE;

type WorkboardGameSceneObjects = {
  camera: THREE.PerspectiveCamera;
  player: THREE.Group;
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
};

const TILE_SPACING = 1.05;

function parseIntegerAttribute(element: Element, name: string, fallback: number): number {
  const value = Number.parseInt(element.getAttribute(name) ?? "", 10);
  return Number.isFinite(value) ? value : fallback;
}

function parseBlockers(value: string | null): Set<number> {
  if (!value) {
    return new Set();
  }
  return new Set(
    value
      .split(",")
      .map((entry) => Number.parseInt(entry.trim(), 10))
      .filter((entry) => Number.isFinite(entry)),
  );
}

function boardPosition(index: number, size: number, three: ThreeModule) {
  const row = Math.floor(index / size);
  const column = index % size;
  const center = (size - 1) / 2;
  return new three.Vector3((column - center) * TILE_SPACING, 0.25, (row - center) * TILE_SPACING);
}

class Workboard3dGameElement extends HTMLElement {
  static get observedAttributes() {
    return ["blockers", "board-size", "goal-index", "player-index", "wins"];
  }

  private animationFrame = 0;
  private canvas: HTMLCanvasElement | null = null;
  private sceneObjects: WorkboardGameSceneObjects | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private startVersion = 0;
  private three: ThreeModule | null = null;

  connectedCallback() {
    this.ensureDom();
    void this.start();
  }

  disconnectedCallback() {
    this.startVersion += 1;
    if (this.animationFrame) {
      cancelAnimationFrame(this.animationFrame);
      this.animationFrame = 0;
    }
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.disposeSceneObjects();
  }

  attributeChangedCallback() {
    this.updateScene();
  }

  private ensureDom() {
    if (this.canvas) {
      return;
    }
    this.replaceChildren();
    this.canvas = document.createElement("canvas");
    this.canvas.className = "workboard-game__canvas";
    this.canvas.setAttribute("aria-hidden", "true");
    this.append(this.canvas);
    this.renderFallback();
  }

  private renderFallback() {
    const size = parseIntegerAttribute(this, "board-size", 5);
    const goalIndex = parseIntegerAttribute(this, "goal-index", size * size - 1);
    const playerIndex = parseIntegerAttribute(this, "player-index", 0);
    const blockers = parseBlockers(this.getAttribute("blockers"));
    const fallback = document.createElement("div");
    fallback.className = "workboard-game__fallback";
    fallback.setAttribute("aria-hidden", "true");
    for (let index = 0; index < size * size; index += 1) {
      const tile = document.createElement("span");
      tile.className = [
        "workboard-game__fallback-tile",
        index === playerIndex ? "workboard-game__fallback-tile--player" : "",
        index === goalIndex ? "workboard-game__fallback-tile--goal" : "",
        blockers.has(index) ? "workboard-game__fallback-tile--blocker" : "",
      ]
        .filter(Boolean)
        .join(" ");
      fallback.append(tile);
    }
    this.querySelector(".workboard-game__fallback")?.remove();
    this.append(fallback);
  }

  private resetToFallback() {
    this.classList.remove("workboard-game__scene--ready");
    if (this.animationFrame) {
      cancelAnimationFrame(this.animationFrame);
      this.animationFrame = 0;
    }
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.disposeSceneObjects();
    this.renderFallback();
  }

  private disposeSceneObjects() {
    const objects = this.sceneObjects;
    if (!objects) {
      return;
    }
    const geometries = new Set<THREE.BufferGeometry>();
    const materials = new Set<THREE.Material>();
    objects.scene.traverse((object) => {
      const mesh = object as THREE.Mesh;
      if (mesh.geometry) {
        geometries.add(mesh.geometry);
      }
      const material = mesh.material;
      if (Array.isArray(material)) {
        for (const entry of material) {
          materials.add(entry);
        }
      } else if (material) {
        materials.add(material);
      }
    });
    for (const geometry of geometries) {
      geometry.dispose();
    }
    for (const material of materials) {
      material.dispose();
    }
    objects.renderer.dispose();
    this.sceneObjects = null;
  }

  private async start() {
    this.ensureDom();
    const canvas = this.canvas;
    if (!canvas || this.sceneObjects) {
      return;
    }
    const startVersion = ++this.startVersion;
    try {
      const context = canvas.getContext("webgl2") ?? canvas.getContext("webgl");
      if (!context) {
        this.renderFallback();
        return;
      }
      this.three = await import("three");
      if (!this.isConnected || startVersion !== this.startVersion || this.sceneObjects) {
        return;
      }
      const three = this.three;
      const renderer = new three.WebGLRenderer({
        alpha: true,
        antialias: true,
        canvas,
        context,
        preserveDrawingBuffer: true,
      });
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
      const scene = new three.Scene();
      const camera = new three.PerspectiveCamera(42, 1, 0.1, 100);
      const player = new three.Group();
      this.sceneObjects = { camera, player, renderer, scene };
      this.buildScene();
      this.resize();
      this.resizeObserver = new ResizeObserver(() => this.resize());
      this.resizeObserver.observe(this);
      this.classList.add("workboard-game__scene--ready");
      this.renderFrame();
    } catch {
      this.resetToFallback();
    }
  }

  private resize() {
    const { camera, renderer } = this.sceneObjects ?? {};
    if (!camera || !renderer) {
      return;
    }
    const width = Math.max(1, this.clientWidth);
    const height = Math.max(1, this.clientHeight);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    renderer.setSize(width, height, false);
  }

  private buildScene() {
    const three = this.three;
    const objects = this.sceneObjects;
    if (!three || !objects) {
      return;
    }
    const { camera, player, scene } = objects;
    scene.clear();
    const size = parseIntegerAttribute(this, "board-size", 5);
    const goalIndex = parseIntegerAttribute(this, "goal-index", size * size - 1);
    const blockers = parseBlockers(this.getAttribute("blockers"));
    const baseMaterial = new three.MeshStandardMaterial({
      color: 0x21313b,
      metalness: 0.28,
      roughness: 0.58,
    });
    const openMaterial = new three.MeshStandardMaterial({
      color: 0x2f4650,
      metalness: 0.24,
      roughness: 0.5,
    });
    const blockerMaterial = new three.MeshStandardMaterial({
      color: 0xe55b4d,
      emissive: 0x3b0804,
      metalness: 0.18,
      roughness: 0.42,
    });
    const goalMaterial = new three.MeshStandardMaterial({
      color: 0x52d273,
      emissive: 0x123d1c,
      metalness: 0.2,
      roughness: 0.36,
    });
    const playerMaterial = new three.MeshStandardMaterial({
      color: 0x67a6ff,
      emissive: 0x112b62,
      metalness: 0.34,
      roughness: 0.26,
    });
    const tileGeometry = new three.BoxGeometry(0.94, 0.14, 0.94);
    const blockerGeometry = new three.ConeGeometry(0.28, 0.7, 5);
    for (let index = 0; index < size * size; index += 1) {
      const tile = new three.Mesh(
        tileGeometry,
        index === goalIndex ? goalMaterial : blockers.has(index) ? baseMaterial : openMaterial,
      );
      const position = boardPosition(index, size, three);
      tile.position.set(position.x, 0, position.z);
      tile.receiveShadow = true;
      scene.add(tile);
      if (blockers.has(index)) {
        const blocker = new three.Mesh(blockerGeometry, blockerMaterial);
        blocker.position.set(position.x, 0.42, position.z);
        blocker.rotation.y = index * 0.61;
        scene.add(blocker);
      }
    }
    const goalPosition = boardPosition(goalIndex, size, three);
    const ring = new three.Mesh(new three.TorusGeometry(0.34, 0.045, 10, 28), goalMaterial);
    ring.position.set(goalPosition.x, 0.25, goalPosition.z);
    ring.rotation.x = Math.PI / 2;
    scene.add(ring);

    player.clear();
    const body = new three.Mesh(new three.IcosahedronGeometry(0.29, 1), playerMaterial);
    const base = new three.Mesh(new three.CylinderGeometry(0.24, 0.3, 0.16, 16), playerMaterial);
    base.position.y = -0.2;
    player.add(body, base);
    scene.add(player);

    scene.add(new three.AmbientLight(0xa8c7ff, 0.7));
    const keyLight = new three.DirectionalLight(0xffffff, 1.75);
    keyLight.position.set(-3.5, 6, 4);
    scene.add(keyLight);
    const rimLight = new three.PointLight(0x67a6ff, 6, 9);
    rimLight.position.set(3, 2.8, -4);
    scene.add(rimLight);
    camera.position.set(3.4, 5.5, 6.8);
    camera.lookAt(0, 0, 0);
    this.updateScene();
  }

  private updateScene() {
    this.renderFallback();
    const three = this.three;
    const { player } = this.sceneObjects ?? {};
    if (!three || !player) {
      return;
    }
    const size = parseIntegerAttribute(this, "board-size", 5);
    const playerIndex = parseIntegerAttribute(this, "player-index", 0);
    const target = boardPosition(playerIndex, size, three);
    player.position.copy(target);
  }

  private renderFrame = () => {
    const three = this.three;
    const objects = this.sceneObjects;
    if (!three || !objects) {
      return;
    }
    const size = parseIntegerAttribute(this, "board-size", 5);
    const playerIndex = parseIntegerAttribute(this, "player-index", 0);
    const target = boardPosition(playerIndex, size, three);
    objects.player.position.lerp(target, 0.2);
    objects.player.rotation.y += 0.035;
    objects.player.position.y = target.y + Math.sin(performance.now() / 210) * 0.06;
    const orbit = performance.now() / 8200;
    objects.camera.position.x = Math.sin(orbit) * 1.2 + 3.4;
    objects.camera.position.z = Math.cos(orbit) * 1.2 + 6.8;
    objects.camera.lookAt(0, 0, 0);
    objects.renderer.render(objects.scene, objects.camera);
    this.animationFrame = requestAnimationFrame(this.renderFrame);
  };
}

if ("customElements" in globalThis && !customElements.get("workboard-3d-game")) {
  customElements.define("workboard-3d-game", Workboard3dGameElement);
}
