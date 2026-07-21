import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { acceleratedRaycast, computeBoundsTree, disposeBoundsTree, StaticGeometryGenerator } from 'three-mesh-bvh'
import {
  buildManikin,
  buildStand,
  disposeObject,
  makeBackgroundTexture,
  makeGroundTexture,
  makeSoftDotTexture,
  IVORY,
} from './atelierScene'
import type { CardMeasurements, CardView } from '../lib/designCard'

type BVHGeometry = THREE.BufferGeometry & {
  boundsTree?: unknown
  computeBoundsTree: typeof computeBoundsTree
  disposeBoundsTree: typeof disposeBoundsTree
}

;(THREE.BufferGeometry.prototype as BVHGeometry).computeBoundsTree = computeBoundsTree
;(THREE.BufferGeometry.prototype as BVHGeometry).disposeBoundsTree = disposeBoundsTree
THREE.Mesh.prototype.raycast = acceleratedRaycast

export type Tool = 'pencil' | 'brush' | 'spray' | 'fill' | 'stone' | 'shape' | 'measure' | 'select' | 'eraser' | 'move'
export type DrawingViewPreset = 'front' | 'back' | 'left' | 'right'
export interface DrawingPlaneAnchor { position: [number, number, number]; quaternion: [number, number, number, number]; width: number; height: number }
export function straightenDrawingPlaneAnchor(anchor: DrawingPlaneAnchor): DrawingPlaneAnchor {
  const normal=new THREE.Vector3(0,0,1).applyQuaternion(new THREE.Quaternion().fromArray(anchor.quaternion));normal.y=0
  if(normal.lengthSq()<.0001)normal.set(0,0,1);else normal.normalize()
  const quaternion=new THREE.Quaternion().setFromEuler(new THREE.Euler(0,Math.atan2(normal.x,normal.z),0))
  return {...structuredClone(anchor),quaternion:quaternion.toArray() as [number,number,number,number]}
}
export type FabricPreset = 'matte' | 'satin' | 'velvet' | 'lace' | 'mesh' | 'sequin'
export type StoneShape = 'round' | 'diamond' | 'square' | 'teardrop'
export type ShapeKind = 'circle' | 'square' | 'rectangle'

export interface AtelierDesignState {
  version: 1
  heightCm: number
  fabric: { color: string; preset: FabricPreset }
  view: { azimuth: number; polar: number; distance: number }
  settings?: { snapEnabled: boolean; outlinesVisible?: boolean }
  items: Array<Record<string, unknown>>
}

export interface EngineOptions {
  onStrokesChange?: (count: number) => void
  onDesignChange?: (state: AtelierDesignState) => void
}

const STAND_TOP = 1.43 // raises the full figure so its feet meet the floor
const BASE_HEIGHT_CM = 170 // scale 1.0 represents 170 cm

interface ActiveStroke {
  group: THREE.Group
  kind: 'pencil' | 'brush' | 'spray'
  points: THREE.Vector3[]
  normals: THREE.Vector3[]
  lastLocal: THREE.Vector3 | null
  planeRef: THREE.Vector3 | null
  previewMesh: THREE.Mesh | THREE.Line | null
  pointsObj: THREE.Points | null
  positions: Float32Array | null
  posCount: number
  previewDirty: boolean
  lastPreviewAt: number
  lastScreen: THREE.Vector2 | null
}

export class AtelierEngine {
  private canvas: HTMLCanvasElement
  private opts: EngineOptions
  private renderer: THREE.WebGLRenderer
  private scene: THREE.Scene
  private camera: THREE.PerspectiveCamera
  private raycaster = new THREE.Raycaster()

  private manikinGroup: THREE.Group
  private manikinMaterial: THREE.MeshStandardMaterial
  private bodyMeshes: THREE.Object3D[] = []
  private collisionMeshes: THREE.Mesh[] = []
  private collisionGenerators: Array<{ generator: StaticGeometryGenerator; mesh: THREE.Mesh }> = []
  private standGroup: THREE.Group
  private referenceModel: THREE.Group | null = null
  private drawingPlanes = new Map<string, { mesh: THREE.Mesh; texture: THREE.Texture; live: boolean; anchor: DrawingPlaneAnchor }>()
  private drawingTextureVersions = new Map<string, number>()
  private dirtyDrawingViews = new Set<string>()
  private drawingTextureUpdatedAt = new Map<string, number>()
  private strokesGroup: THREE.Group
  private strokeStack: THREE.Object3D[] = []

  // interaction state
  private tool: Tool = 'move'
  private color = '#1f1b16'
  private thickness = 4 // 1..10
  private brushSizeCm = 8
  private mirror = false
  private snapEnabled = true
  private outlinesVisible = true
  private autoRotate = false
  private heightCm = BASE_HEIGHT_CM
  private fabricPreset: FabricPreset = 'matte'
  private materialScale = 1
  private materialRotation = 0
  private stoneShape: StoneShape = 'diamond'
  private stoneSize = 5
  private stoneCount = 3
  private shapeKind: ShapeKind = 'circle'
  private shapeWidthCm = 12
  private shapeHeightCm = 8
  private lastStonePoint: THREE.Vector3 | null = null

  // camera orbit state
  private azimuth = 0.35
  private polar = 1.22
  private dist = 5.2
  private desiredDist = 5.2
  private target = new THREE.Vector3(0, 1.65, 0)

  private pointers = new Map<number, { x: number; y: number }>()
  private pinchBase: { d: number; dist: number; midX: number; midY: number; az: number; pol: number } | null =
    null
  private orbitBase: { x: number; y: number; az: number; pol: number } | null = null
  private stroke: ActiveStroke | null = null
  private downInfo: { x: number; y: number; t: number } | null = null
  private lastTap: { t: number; x: number; y: number } | null = null

  private raf = 0
  private lastTime = 0
  private ro: ResizeObserver
  private disposed = false

  private boundDown: (e: PointerEvent) => void
  private boundMove: (e: PointerEvent) => void
  private boundUp: (e: PointerEvent) => void
  private boundWheel: (e: WheelEvent) => void
  private boundCtx: (e: Event) => void

  constructor(canvas: HTMLCanvasElement, opts: EngineOptions = {}) {
    this.canvas = canvas
    this.opts = opts

    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false })
    const touchDevice = navigator.maxTouchPoints > 0 || window.matchMedia('(pointer: coarse)').matches
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, touchDevice ? 1.25 : 1.75))

    this.scene = new THREE.Scene()
    this.scene.background = makeBackgroundTexture()

    this.camera = new THREE.PerspectiveCamera(40, 1, 0.05, 60)

    // lights — soft studio
    const hemi = new THREE.HemisphereLight(0xfff4e2, 0x453a2e, 1.05)
    const key = new THREE.DirectionalLight(0xffffff, 1.9)
    key.position.set(3, 5, 2.5)
    const rim = new THREE.DirectionalLight(0xd8b98a, 0.65)
    rim.position.set(-3.2, 2.2, -3)
    this.scene.add(hemi, key, rim)

    // ground
    const ground = new THREE.Mesh(
      new THREE.CircleGeometry(3.2, 48),
      new THREE.MeshBasicMaterial({ map: makeGroundTexture(), transparent: true, depthWrite: false })
    )
    ground.rotation.x = -Math.PI / 2
    ground.position.y = 0.001
    this.scene.add(ground)

    // stand + manikin
    this.standGroup = buildStand()
    this.scene.add(this.standGroup)
    const parts = buildManikin()
    this.manikinGroup = parts.group
    this.manikinMaterial = parts.material
    this.bodyMeshes = [parts.mesh, ...parts.breasts, ...parts.limbs]
    this.bodyMeshes.forEach((object) => {
      const mesh = object as THREE.Mesh
      const geometry = mesh.geometry as BVHGeometry | undefined
      if (geometry && !geometry.boundsTree) geometry.computeBoundsTree()
    })
    this.manikinGroup.position.y = STAND_TOP
    this.scene.add(this.manikinGroup)
    this.loadReferenceModel()
    this.buildDrawingPlanes()

    this.strokesGroup = new THREE.Group()
    this.scene.add(this.strokesGroup)

    this.raycaster.params.Points.threshold = 0.06
    ;(this.raycaster as THREE.Raycaster & { firstHitOnly: boolean }).firstHitOnly = true

    // events
    this.boundDown = (e) => this.onPointerDown(e)
    this.boundMove = (e) => this.onPointerMove(e)
    this.boundUp = (e) => this.onPointerUp(e)
    this.boundWheel = (e) => this.onWheel(e)
    this.boundCtx = (e) => e.preventDefault()
    canvas.addEventListener('pointerdown', this.boundDown)
    canvas.addEventListener('pointermove', this.boundMove)
    canvas.addEventListener('pointerup', this.boundUp)
    canvas.addEventListener('pointercancel', this.boundUp)
    canvas.addEventListener('wheel', this.boundWheel, { passive: false })
    canvas.addEventListener('contextmenu', this.boundCtx)

    this.ro = new ResizeObserver(() => this.resize())
    this.ro.observe(canvas.parentElement ?? canvas)
    this.resize()
    this.applyHeight()

    this.lastTime = performance.now()
    const loop = (t: number) => {
      if (this.disposed) return
      const dt = Math.min((t - this.lastTime) / 1000, 0.05)
      this.lastTime = t
      if (this.autoRotate && this.pointers.size === 0) this.azimuth += dt * 0.28
      this.dist += (this.desiredDist - this.dist) * 0.18
      this.updateCamera()
      if (
        (this.stroke?.kind === 'pencil' || this.stroke?.kind === 'brush') &&
        this.stroke.previewDirty &&
        t - this.stroke.lastPreviewAt >= 32
      ) {
        this.stroke.previewDirty = false
        this.stroke.lastPreviewAt = t
        this.rebuildPencilPreview(this.stroke)
      }
      for(const view of this.dirtyDrawingViews){const last=this.drawingTextureUpdatedAt.get(view)??0;if(t-last<50)continue;const plane=this.drawingPlanes.get(view);if(plane?.live)plane.texture.needsUpdate=true;this.drawingTextureUpdatedAt.set(view,t);this.dirtyDrawingViews.delete(view)}
      this.renderer.render(this.scene, this.camera)
      this.raf = requestAnimationFrame(loop)
    }
    this.raf = requestAnimationFrame(loop)
  }

  // ---------------------------------------------------------- public API

  setTool(t: Tool) {
    this.tool = t
  }
  setColor(hex: string) {
    this.color = hex
  }
  setThickness(v: number) {
    this.thickness = THREE.MathUtils.clamp(v, 1, 10)
  }
  setBrushSize(cm: number) {
    this.brushSizeCm = THREE.MathUtils.clamp(cm, 1, 30)
  }
  setMirror(b: boolean) {
    this.mirror = b
  }
  setSnapEnabled(enabled: boolean) {
    if (this.snapEnabled === enabled) return
    this.snapEnabled = enabled
    this.emitDesignChange()
  }
  setOutlinesVisible(visible: boolean) {
    if (this.outlinesVisible === visible) return
    this.outlinesVisible = visible
    this.applyOutlineVisibility()
    this.emitDesignChange()
  }
  setAutoRotate(b: boolean) {
    this.autoRotate = b
  }
  setStoneOptions(shape: StoneShape, size: number, count: number) {
    this.stoneShape = shape
    this.stoneSize = THREE.MathUtils.clamp(size, 2, 14)
    this.stoneCount = THREE.MathUtils.clamp(Math.round(count), 1, 12)
  }
  setShapeKind(kind: ShapeKind) {
    this.shapeKind = kind
  }
  setShapeSize(widthCm: number, heightCm = widthCm) {
    this.shapeWidthCm = THREE.MathUtils.clamp(widthCm, 2, 80)
    this.shapeHeightCm = THREE.MathUtils.clamp(heightCm, 2, 80)
  }
  setViewPreset(view: DrawingViewPreset) {
    this.azimuth = view === 'front' ? 0 : view === 'right' ? Math.PI / 2 : view === 'back' ? Math.PI : -Math.PI / 2
    this.polar = 1.22
    this.desiredDist = 5.2 * (this.heightCm / BASE_HEIGHT_CM)
    this.emitDesignChange()
  }
  setDrawingViewTexture(view: string, source: HTMLCanvasElement | string, anchor?: DrawingPlaneAnchor) {
    this.replaceDrawingViewTexture(view, source, false, anchor)
  }
  setLiveDrawingView(view: string, source: HTMLCanvasElement, anchor?: DrawingPlaneAnchor) {
    this.replaceDrawingViewTexture(view, source, true, anchor)
  }
  markDrawingViewDirty(view: string) {
    if(this.drawingPlanes.get(view)?.live)this.dirtyDrawingViews.add(view)
  }
  screenToDrawingPoint(view: string, clientX: number, clientY: number): { x: number; y: number } | null {
    const plane = this.drawingPlanes.get(view)?.mesh
    if (!plane) return null
    const rect = this.canvas.getBoundingClientRect()
    const ndc = new THREE.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1)
    this.raycaster.setFromCamera(ndc, this.camera)
    const hit = this.raycaster.intersectObject(plane, false)[0]
    return hit?.uv ? { x: hit.uv.x, y: 1 - hit.uv.y } : null
  }
  createCurrentDrawingAnchor(): DrawingPlaneAnchor {
    this.updateCamera()
    const towardCamera=this.camera.position.clone().sub(this.target);towardCamera.y=0;if(towardCamera.lengthSq()<.0001)towardCamera.set(0,0,1);else towardCamera.normalize()
    const offset=.36*(this.heightCm/BASE_HEIGHT_CM),position=this.target.clone().addScaledVector(towardCamera,offset),quaternion=new THREE.Quaternion().setFromEuler(new THREE.Euler(0,Math.atan2(towardCamera.x,towardCamera.z),0))
    const distance=Math.max(.5,this.camera.position.distanceTo(position)),height=2*Math.tan(THREE.MathUtils.degToRad(this.camera.fov/2))*distance
    return { position:position.toArray() as [number,number,number], quaternion:quaternion.toArray() as [number,number,number,number], width:height*this.camera.aspect, height }
  }
  getDrawingPlaneAnchor(view: string): DrawingPlaneAnchor | null {
    const anchor=this.drawingPlanes.get(view)?.anchor
    return anchor ? structuredClone(anchor) : null
  }
  isDrawingPlaneAligned(view: string) {
    const plane=this.drawingPlanes.get(view)?.mesh
    if(!plane)return false
    const normal=new THREE.Vector3(0,0,1).applyQuaternion(plane.quaternion).normalize(),towardCamera=this.camera.position.clone().sub(plane.position);towardCamera.y=0;if(towardCamera.lengthSq()<.0001)return true;towardCamera.normalize()
    return Math.abs(normal.dot(towardCamera))>.985
  }
  removeDrawingPlane(view: string) {
    const plane=this.drawingPlanes.get(view);if(!plane)return
    plane.texture.dispose();plane.mesh.parent?.remove(plane.mesh);disposeObject(plane.mesh);this.drawingPlanes.delete(view);this.dirtyDrawingViews.delete(view);this.drawingTextureUpdatedAt.delete(view)
  }
  clearDrawingPlanes() {
    for(const view of [...this.drawingPlanes.keys()])this.removeDrawingPlane(view)
  }
  moveDrawingPlaneDepth(view: string, deltaCm: number): DrawingPlaneAnchor | null {
    const plane=this.drawingPlanes.get(view);if(!plane)return null
    const normal=new THREE.Vector3(0,0,1).applyQuaternion(plane.mesh.quaternion).normalize();plane.mesh.position.addScaledVector(normal,deltaCm*.01);plane.anchor.position=plane.mesh.position.toArray() as [number,number,number]
    return structuredClone(plane.anchor)
  }
  focusDrawingPlane(view: string) {
    const plane=this.drawingPlanes.get(view);if(!plane)return
    const normal=new THREE.Vector3(0,0,1).applyQuaternion(plane.mesh.quaternion).normalize(),towardCurrent=this.camera.position.clone().sub(plane.mesh.position)
    if(normal.dot(towardCurrent)<0)normal.negate()
    const viewingDistance=Math.max(2.4,plane.anchor.height/(2*Math.tan(THREE.MathUtils.degToRad(this.camera.fov/2)))),desiredPosition=plane.mesh.position.clone().addScaledVector(normal,viewingDistance),offset=desiredPosition.sub(this.target),distance=offset.length()
    this.azimuth=Math.atan2(offset.x,offset.z);this.polar=Math.acos(THREE.MathUtils.clamp(offset.y/distance,-1,1));this.dist=this.desiredDist=distance
  }
  setDrawingPlaneHighlight(view: string | null) {
    for(const [id,plane] of this.drawingPlanes){const outline=plane.mesh.getObjectByName('drawing-plane-outline');if(outline)outline.visible=id===view}
  }
  private replaceDrawingViewTexture(view: string, source: HTMLCanvasElement | string, live: boolean, anchor?: DrawingPlaneAnchor) {
    const version = (this.drawingTextureVersions.get(view) ?? 0) + 1
    this.drawingTextureVersions.set(view, version)
    const previous = this.drawingPlanes.get(view)
    if (previous) {
      previous.texture.dispose()
      previous.mesh.parent?.remove(previous.mesh)
      disposeObject(previous.mesh)
      this.drawingPlanes.delete(view)
    }
    const apply = (image: CanvasImageSource) => {
      if (this.drawingTextureVersions.get(view) !== version || this.disposed) return
      const texture = source instanceof HTMLCanvasElement ? new THREE.CanvasTexture(source) : new THREE.Texture(image)
      texture.colorSpace = THREE.SRGBColorSpace
      texture.needsUpdate = true
      const resolvedAnchor=straightenDrawingPlaneAnchor(anchor??this.presetDrawingAnchor(view as DrawingViewPreset))
      const plane = this.createDrawingPlane(texture,resolvedAnchor)
      plane.visible = true
      this.scene.add(plane)
      this.drawingPlanes.set(view, { mesh: plane, texture, live, anchor:resolvedAnchor })
    }
    if (typeof source === 'string') { const image = new Image(); image.onload = () => apply(image); image.src = source }
    else apply(source)
  }
  getFabricColor(): string {
    return '#' + this.manikinMaterial.color.getHexString()
  }
  setFabricColor(hex: string) {
    this.manikinMaterial.color.set(hex)
    this.emitDesignChange()
  }
  resetFabric() {
    this.manikinMaterial.color.set(IVORY)
    this.setFabricPreset('matte')
    this.emitDesignChange()
  }
  setFabricPreset(preset: FabricPreset) {
    this.fabricPreset = preset
    const mat = this.manikinMaterial
    mat.map?.dispose()
    mat.map = null
    mat.transparent = preset === 'mesh' || preset === 'lace'
    mat.opacity = preset === 'mesh' ? 0.42 : preset === 'lace' ? 0.78 : 1
    mat.depthWrite = preset !== 'mesh'
    mat.roughness = preset === 'satin' ? 0.22 : preset === 'sequin' ? 0.3 : preset === 'velvet' ? 0.98 : 0.72
    mat.metalness = preset === 'sequin' ? 0.42 : preset === 'satin' ? 0.08 : 0.01
    if (preset === 'lace' || preset === 'mesh' || preset === 'sequin' || preset === 'velvet') {
      mat.map = this.makeFabricTexture(preset)
    }
    mat.needsUpdate = true
    this.emitDesignChange()
  }

  setMaterialOptions(scale: number, rotation: number) {
    this.materialScale = THREE.MathUtils.clamp(scale, 0.5, 2.5)
    this.materialRotation = THREE.MathUtils.clamp(rotation, 0, 180)
  }

  setHeightCm(cm: number) {
    this.heightCm = THREE.MathUtils.clamp(Math.round(cm), 145, 195)
    this.applyHeight()
    this.emitDesignChange()
  }

  exportState(): AtelierDesignState {
    return {
      version: 1,
      heightCm: this.heightCm,
      fabric: { color: this.getFabricColor(), preset: this.fabricPreset },
      view: { azimuth: this.azimuth, polar: this.polar, distance: this.desiredDist },
      settings: { snapEnabled: this.snapEnabled, outlinesVisible: this.outlinesVisible },
      items: this.strokeStack.map((item) => structuredClone(item.userData.design ?? {})),
    }
  }

  importState(state: AtelierDesignState) {
    if (!state || state.version !== 1) return
    this.clearAll(false)
    this.heightCm = THREE.MathUtils.clamp(state.heightCm || BASE_HEIGHT_CM, 145, 195)
    this.applyHeight()
    this.manikinMaterial.color.set(state.fabric?.color || IVORY)
    this.setFabricPreset(state.fabric?.preset || 'matte')
    this.snapEnabled = state.settings?.snapEnabled ?? true
    this.outlinesVisible = state.settings?.outlinesVisible ?? true
    if (state.view) {
      this.azimuth = state.view.azimuth
      this.polar = state.view.polar
      this.dist = this.desiredDist = state.view.distance
    }
    for (const spec of state.items || []) {
      const item = this.buildSavedItem(spec)
      if (item) {
        this.strokesGroup.add(item)
        this.strokeStack.push(item)
      }
    }
    this.applyOutlineVisibility()
    this.notifyStrokes(false)
  }

  private applyOutlineVisibility() {
    for (const item of this.strokeStack) {
      const design = item.userData.design as { kind?: string } | undefined
      if (design?.kind !== 'pencil' && design?.kind !== 'shape') continue
      for (const child of item.children) child.visible = child.name === 'closed-fill' || this.outlinesVisible
    }
  }

  getMeasurements(): CardMeasurements {
    const h = this.heightCm
    return {
      height: h,
      bust: Math.round(h * 0.53),
      waist: Math.round(h * 0.4),
      hip: Math.round(h * 0.55),
    }
  }

  getStrokeColors(): string[] {
    const seen = new Set<string>()
    for (const s of this.strokeStack) {
      s.traverse((o) => {
        const m = (o as THREE.Mesh).material as THREE.Material | undefined
        const col = (m as THREE.MeshStandardMaterial | undefined)?.color
        if (col) seen.add('#' + col.getHexString())
      })
    }
    return [...seen]
  }

  undo() {
    const obj = this.strokeStack.pop()
    if (obj) {
      this.strokesGroup.remove(obj)
      disposeObject(obj)
      this.notifyStrokes()
    }
  }

  clearAll(notify = true) {
    while (this.strokeStack.length) {
      const obj = this.strokeStack.pop()!
      this.strokesGroup.remove(obj)
      disposeObject(obj)
    }
    this.notifyStrokes(notify)
  }

  getStoneCount() {
    return this.strokeStack.reduce((total,item)=>total+(item.userData.design?.kind==='stones'?(item.userData.design.placements?.length??0):0),0)
  }

  duplicateLastStones() {
    const source=[...this.strokeStack].reverse().find((item)=>item.userData.design?.kind==='stones');if(!source)return
    const spec=structuredClone(source.userData.design) as Record<string,unknown>,placements=(spec.placements as Array<{p:number[];n:number[]}>)||[]
    spec.placements=placements.map((placement)=>({p:[placement.p[0]+.035,placement.p[1]+.025,placement.p[2]],n:[...placement.n]}))
    const duplicate=this.buildSavedItem(spec);if(!duplicate)return;this.strokesGroup.add(duplicate);this.strokeStack.push(duplicate);this.notifyStrokes()
  }

  zoomBy(factor: number) {
    const s = this.heightCm / BASE_HEIGHT_CM
    this.desiredDist = THREE.MathUtils.clamp(this.desiredDist * factor, 0.85 * s, 10.5 * s)
  }

  resetView() {
    const s = this.heightCm / BASE_HEIGHT_CM
    this.azimuth = 0.35
    this.polar = 1.22
    this.desiredDist = 5.2 * s
    this.emitDesignChange()
  }

  /** Render the current view and return a PNG dataURL */
  capturePNG(): string {
    this.updateCamera()
    this.renderer.render(this.scene, this.camera)
    return this.renderer.domElement.toDataURL('image/png')
  }

  /** Render the four canonical card views offscreen-ish and restore state */
  async captureCardViews(): Promise<CardView[]> {
    const s = this.heightCm / BASE_HEIGHT_CM
    const size = 760
    const parent = this.canvas.parentElement
    const w = parent?.clientWidth ?? 375
    const h = parent?.clientHeight ?? 667
    const prevAz = this.azimuth
    const prevPol = this.polar
    const prevDist = this.dist
    const prevDesired = this.desiredDist

    const specs: Array<{ label: string; az: number }> = [
      { label: 'FRONT', az: 0 },
      { label: 'SIDE', az: Math.PI / 2 },
      { label: 'BACK', az: Math.PI },
      { label: '¾ VIEW', az: Math.PI / 4 },
    ]
    const out: CardView[] = []
    this.renderer.setSize(size, size, false)
    this.camera.aspect = 1
    this.camera.updateProjectionMatrix()
    this.dist = this.desiredDist = 4.9 * s
    this.polar = 1.18
    for (const spec of specs) {
      this.azimuth = spec.az
      this.updateCamera()
      this.renderer.render(this.scene, this.camera)
      out.push({ label: spec.label, image: this.renderer.domElement.toDataURL('image/png') })
      await new Promise((r) => setTimeout(r, 0))
    }

    // restore
    this.azimuth = prevAz
    this.polar = prevPol
    this.dist = prevDist
    this.desiredDist = prevDesired
    this.renderer.setSize(w, h, false)
    this.camera.aspect = w / h
    this.camera.updateProjectionMatrix()
    this.updateCamera()
    this.renderer.render(this.scene, this.camera)
    return out
  }

  private makeFabricTexture(preset: FabricPreset): THREE.CanvasTexture {
    const canvas = document.createElement('canvas')
    canvas.width = canvas.height = 256
    const ctx = canvas.getContext('2d')!
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, 256, 256)
    if (preset === 'lace') {
      ctx.clearRect(0, 0, 256, 256)
      ctx.strokeStyle = 'rgba(255,255,255,.88)'
      ctx.lineWidth = 5
      for (let y = -32; y < 288; y += 32) {
        for (let x = -32; x < 288; x += 32) {
          ctx.beginPath()
          ctx.arc(x + ((y / 32) % 2) * 16, y, 11, 0, Math.PI * 2)
          ctx.stroke()
        }
      }
    } else if (preset === 'mesh') {
      ctx.fillStyle = '#b9b9b9'
      ctx.fillRect(0, 0, 256, 256)
      ctx.strokeStyle = 'rgba(255,255,255,.45)'
      ctx.lineWidth = 1
      for (let i = 0; i < 256; i += 8) {
        ctx.beginPath(); ctx.moveTo(i, 0); ctx.lineTo(i, 256); ctx.stroke()
        ctx.beginPath(); ctx.moveTo(0, i); ctx.lineTo(256, i); ctx.stroke()
      }
    } else if (preset === 'sequin') {
      ctx.fillStyle = '#d6d6d6'
      ctx.fillRect(0, 0, 256, 256)
      for (let y = 8; y < 256; y += 18) for (let x = 8; x < 256; x += 18) {
        ctx.fillStyle = (x + y) % 36 ? '#ffffff' : '#a8a8a8'
        ctx.beginPath(); ctx.arc(x, y, 6, 0, Math.PI * 2); ctx.fill()
      }
    } else if (preset === 'velvet') {
      const image = ctx.getImageData(0, 0, 256, 256)
      for (let i = 0; i < image.data.length; i += 4) {
        const v = 205 + Math.floor(Math.random() * 45)
        image.data[i] = image.data[i + 1] = image.data[i + 2] = v
      }
      ctx.putImageData(image, 0, 0)
    }
    const texture = new THREE.CanvasTexture(canvas)
    texture.wrapS = texture.wrapT = THREE.RepeatWrapping
    texture.repeat.set(4, 7)
    texture.colorSpace = THREE.SRGBColorSpace
    return texture
  }

  private makeGarmentMaterial(color: string, preset: FabricPreset, scale: number, rotation: number) {
    const transparent = preset === 'mesh' || preset === 'lace'
    const material = new THREE.MeshStandardMaterial({
      color,
      side: THREE.DoubleSide,
      transparent,
      opacity: preset === 'mesh' ? 0.46 : preset === 'lace' ? 0.8 : 1,
      depthWrite: !transparent,
      roughness: preset === 'satin' ? 0.2 : preset === 'velvet' ? 0.96 : preset === 'sequin' ? 0.28 : 0.68,
      metalness: preset === 'sequin' ? 0.4 : preset === 'satin' ? 0.08 : 0.01,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -1,
    })
    if (preset === 'lace' || preset === 'mesh' || preset === 'sequin' || preset === 'velvet') {
      const texture = this.makeFabricTexture(preset)
      const safeScale = THREE.MathUtils.clamp(scale, 0.5, 2.5)
      texture.repeat.set(4 / safeScale, 7 / safeScale)
      texture.center.set(0.5, 0.5)
      texture.rotation = THREE.MathUtils.degToRad(rotation)
      material.map = texture
    }
    return material
  }

  /**
   * Build a tessellated garment panel from the closed line as it appears in the
   * current view. Every generated vertex raycasts back to the mannequin; this
   * makes the fill follow the bust, waist, hips and limbs rather than spanning
   * them with one flat triangle fan. Areas outside the silhouette remain in the
   * drawing-depth plane so skirts and other volume can extend beyond the body.
   */
  private makeFill(pointsInput: THREE.Vector3[], color: string, preset = this.fabricPreset, scale = this.materialScale, rotation = this.materialRotation): THREE.Mesh | null {
    const points = pointsInput.map((point) => point.clone())
    if (points.length > 3 && points[0].distanceTo(points[points.length - 1]) < 0.0005) points.pop()
    if (points.length < 3) return null

    const rect = this.canvas.getBoundingClientRect()
    const projected = points.map((point) => {
      const value = point.clone().project(this.camera)
      return new THREE.Vector2(value.x, value.y)
    })
    // Remove near-duplicate screen samples before triangulation. The original
    // 3D line stays untouched; this only prevents tiny fill slivers.
    const contour: THREE.Vector2[] = []
    for (const point of projected) {
      const previous = contour[contour.length - 1]
      const pixelDistance = previous ? Math.hypot((point.x - previous.x) * rect.width * 0.5, (point.y - previous.y) * rect.height * 0.5) : Infinity
      if (pixelDistance >= 7) contour.push(point)
    }
    if (contour.length > 3) {
      const first = contour[0]
      const last = contour[contour.length - 1]
      if (Math.hypot((first.x - last.x) * rect.width * 0.5, (first.y - last.y) * rect.height * 0.5) < 7) contour.pop()
    }
    if (contour.length < 3) return null
    const faces = THREE.ShapeUtils.triangulateShape(contour, [])
    if (!faces.length) return null

    const viewDirection = this.camera.getWorldDirection(new THREE.Vector3()).normalize()
    // Put free-hanging cloth at the nearest boundary depth. Using the average
    // depth can place a skirt panel halfway through the body when the outline
    // wraps around the hips.
    const nearestDepth = Math.min(...points.map((point) => point.clone().sub(this.camera.position).dot(viewDirection)))
    const drapeOrigin = this.camera.position.clone().addScaledVector(viewDirection, Math.max(0.05, nearestDepth - 0.014))
    const drapePlane = new THREE.Plane().setFromNormalAndCoplanarPoint(viewDirection, drapeOrigin)
    const minX = Math.min(...contour.map((point) => point.x))
    const maxX = Math.max(...contour.map((point) => point.x))
    const minY = Math.min(...contour.map((point) => point.y))
    const maxY = Math.max(...contour.map((point) => point.y))
    const width = Math.max(0.0001, maxX - minX)
    const height = Math.max(0.0001, maxY - minY)
    const vertices: number[] = []
    const uvs: number[] = []
    const indices: number[] = []
    const vertexSurfaces: string[] = []
    const vertexCache = new Map<string, number>()

    const addVertex = (screenPoint: THREE.Vector2) => {
      const key = `${Math.round(screenPoint.x * 100000)},${Math.round(screenPoint.y * 100000)}`
      const cached = vertexCache.get(key)
      if (cached !== undefined) return cached
      this.raycaster.setFromCamera(screenPoint, this.camera)
      const bodyHit = this.raycaster.intersectObjects(this.collisionMeshes.length ? this.collisionMeshes : this.bodyMeshes, false)[0]
      let worldPoint: THREE.Vector3 | null = null
      let surface = 'drape'
      if (bodyHit) {
        let normal = new THREE.Vector3(0, 0, 1)
        if (bodyHit.normal) normal = bodyHit.normal.clone().applyMatrix3(new THREE.Matrix3().getNormalMatrix(bodyHit.object.matrixWorld)).normalize()
        else if (bodyHit.face) normal = bodyHit.face.normal.clone().applyMatrix3(new THREE.Matrix3().getNormalMatrix(bodyHit.object.matrixWorld)).normalize()
        worldPoint = bodyHit.point.clone().addScaledVector(normal, 0.014)
        // The Meshy mannequin is split into several material primitives even
        // where the visible skin is continuous. Treat them as one surface;
        // the world-edge guard below still rejects genuine depth jumps.
        surface = 'body'
      } else {
        const planePoint = new THREE.Vector3()
        if (this.raycaster.ray.intersectPlane(drapePlane, planePoint)) worldPoint = planePoint.addScaledVector(viewDirection, -0.012)
      }
      if (!worldPoint) return -1
      const index = vertices.length / 3
      vertices.push(worldPoint.x, worldPoint.y, worldPoint.z)
      uvs.push((screenPoint.x - minX) / width, (screenPoint.y - minY) / height)
      vertexSurfaces.push(surface)
      vertexCache.set(key, index)
      return index
    }

    const addTriangle = (a: THREE.Vector2, b: THREE.Vector2, c: THREE.Vector2, depth = 0) => {
      const screenLength = (p1: THREE.Vector2, p2: THREE.Vector2) => Math.hypot((p1.x - p2.x) * rect.width * 0.5, (p1.y - p2.y) * rect.height * 0.5)
      const longest = Math.max(screenLength(a, b), screenLength(b, c), screenLength(c, a))
      if (longest > 24 && depth < 3) {
        const ab = a.clone().lerp(b, 0.5)
        const bc = b.clone().lerp(c, 0.5)
        const ca = c.clone().lerp(a, 0.5)
        addTriangle(a, ab, ca, depth + 1)
        addTriangle(ab, b, bc, depth + 1)
        addTriangle(ca, bc, c, depth + 1)
        addTriangle(ab, bc, ca, depth + 1)
        return
      }
      const ia = addVertex(a)
      const ib = addVertex(b)
      const ic = addVertex(c)
      if (ia < 0 || ib < 0 || ic < 0) return
      // Subdivide around the silhouette until the body-to-drape seam is small.
      // Keeping the final seam triangles closes the cloth without the large,
      // folded bridges that previously cut through the mannequin.
      const mixed = vertexSurfaces[ia] !== vertexSurfaces[ib] || vertexSurfaces[ib] !== vertexSurfaces[ic]
      if (mixed && depth < 5) {
        const ab = a.clone().lerp(b, 0.5)
        const bc = b.clone().lerp(c, 0.5)
        const ca = c.clone().lerp(a, 0.5)
        addTriangle(a, ab, ca, depth + 1)
        addTriangle(ab, b, bc, depth + 1)
        addTriangle(ca, bc, c, depth + 1)
        addTriangle(ab, bc, ca, depth + 1)
        return
      }
      indices.push(ia, ib, ic)
    }
    for (const [a, b, c] of faces) addTriangle(contour[a], contour[b], contour[c])
    if (!indices.length) return null

    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3))
    geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2))
    geometry.setIndex(indices)
    geometry.computeVertexNormals()
    const mesh = new THREE.Mesh(geometry, this.makeGarmentMaterial(color, preset, scale, rotation))
    mesh.renderOrder = 2
    return mesh
  }

  private pointInsidePolygon(point: THREE.Vector2, polygon: THREE.Vector2[]) {
    let inside = false
    for (let index = 0, previous = polygon.length - 1; index < polygon.length; previous = index++) {
      const a = polygon[index]
      const b = polygon[previous]
      if ((a.y > point.y) !== (b.y > point.y) && point.x < ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y) + a.x) inside = !inside
    }
    return inside
  }

  private fillClosedItemAt(clientX: number, clientY: number): boolean {
    const rect = this.canvas.getBoundingClientRect()
    const pointer = new THREE.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1)
    let group: THREE.Object3D | null = null
    let smallestArea = Infinity
    // Prefer the smallest closed projected outline containing the tap. This is
    // what makes "tap inside to fill" work for nested lingerie panels.
    for (const item of [...this.strokeStack].reverse()) {
      const design = item.userData.design as { kind?: string; points?: number[][]; closed?: boolean }
      if (!design || !Array.isArray(design.points) || (design.kind === 'pencil' && !design.closed) || (design.kind !== 'pencil' && design.kind !== 'shape')) continue
      const polygon = design.points.map((value) => {
        const projected = new THREE.Vector3().fromArray(value).project(this.camera)
        return new THREE.Vector2(projected.x, projected.y)
      })
      if (polygon.length > 3 && polygon[0].distanceTo(polygon[polygon.length - 1]) < 0.0005) polygon.pop()
      if (polygon.length < 3 || !this.pointInsidePolygon(pointer, polygon)) continue
      let area = 0
      for (let index = 0, previous = polygon.length - 1; index < polygon.length; previous = index++) area += polygon[previous].x * polygon[index].y - polygon[index].x * polygon[previous].y
      area = Math.abs(area)
      if (area < smallestArea) { smallestArea = area; group = item }
    }
    if (!group) {
      this.raycaster.setFromCamera(pointer, this.camera)
      const hit = this.raycaster.intersectObject(this.strokesGroup, true)[0]
      if (hit) {
        group = hit.object
        while (group && group.parent !== this.strokesGroup) group = group.parent
      }
    }
    if (!group) return false
    const design = group.userData.design as { kind?: string; points?: number[][]; closed?: boolean; fillColor?: string; fillPreset?: FabricPreset; fillScale?: number; fillRotation?: number; fillGeometry?: { positions: number[]; indices: number[]; uvs: number[] } }
    if (!design || !Array.isArray(design.points) || (design.kind === 'pencil' && !design.closed)) return false
    const points = design.points.map((p) => new THREE.Vector3(p[0], p[1], p[2]))
    const fill = this.makeFill(points, this.color, this.fabricPreset, this.materialScale, this.materialRotation)
    if (!fill) return false
    const previous = group.getObjectByName('closed-fill')
    if (previous) { group.remove(previous); disposeObject(previous) }
    fill.name = 'closed-fill'
    fill.visible = true
    group.add(fill)
    design.fillColor = this.color
    design.fillPreset = this.fabricPreset
    design.fillScale = this.materialScale
    design.fillRotation = this.materialRotation
    design.fillGeometry = {
      positions: Array.from((fill.geometry.getAttribute('position') as THREE.BufferAttribute).array),
      indices: Array.from(fill.geometry.index?.array ?? []),
      uvs: Array.from((fill.geometry.getAttribute('uv') as THREE.BufferAttribute).array),
    }
    this.emitDesignChange()
    return true
  }

  private stoneGeometry(shape: StoneShape, size: number): THREE.BufferGeometry {
    const r = size * 0.0038
    if (shape === 'round') return new THREE.SphereGeometry(r, 16, 12)
    if (shape === 'square') return new THREE.BoxGeometry(r * 1.7, r * 1.7, r * 0.75)
    if (shape === 'teardrop') {
      const geo = new THREE.SphereGeometry(r, 16, 12)
      geo.scale(0.72, 1.25, 0.58)
      return geo
    }
    return new THREE.OctahedronGeometry(r, 1)
  }

  private placeStoneBatch(hit: { p: THREE.Vector3; n: THREE.Vector3 }) {
    const group = new THREE.Group()
    const placements: Array<{ p: number[]; n: number[] }> = []
    const spread = this.stoneSize * 0.009
    const up=Math.abs(hit.n.y)>.9?new THREE.Vector3(1,0,0):new THREE.Vector3(0,1,0),t1=new THREE.Vector3().crossVectors(hit.n,up).normalize(),t2=new THREE.Vector3().crossVectors(hit.n,t1).normalize()
    const stones=new THREE.InstancedMesh(this.stoneGeometry(this.stoneShape,this.stoneSize),new THREE.MeshPhysicalMaterial({color:this.color,metalness:.15,roughness:.08,transmission:.36,thickness:.5}),this.stoneCount),matrix=new THREE.Matrix4(),scale=new THREE.Vector3(1,1,1)
    for (let i = 0; i < this.stoneCount; i++) {
      const angle = (i / Math.max(1, this.stoneCount)) * Math.PI * 2
      const radius = i === 0 ? 0 : spread * (0.45 + 0.55 * ((i % 3) / 2))
      const p = hit.p.clone().addScaledVector(t1,Math.cos(angle)*radius).addScaledVector(t2,Math.sin(angle)*radius).addScaledVector(hit.n, 0.012)
      const quaternion=new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0,0,1),hit.n.clone().normalize());matrix.compose(p,quaternion,scale);stones.setMatrixAt(i,matrix)
      placements.push({ p: p.toArray(), n: hit.n.toArray() })
    }
    stones.instanceMatrix.needsUpdate=true;group.add(stones)
    group.userData.design = { kind: 'stones', shape: this.stoneShape, size: this.stoneSize, color: this.color, placements }
    this.strokesGroup.add(group)
    this.strokeStack.push(group)
    this.lastStonePoint = hit.p.clone()
    this.notifyStrokes()
  }

  private placeShape(hit: { p: THREE.Vector3; n: THREE.Vector3 }) {
    const halfWidth = this.shapeWidthCm * 0.01 * (this.heightCm / BASE_HEIGHT_CM)
    const halfHeight = (this.shapeKind === 'circle' || this.shapeKind === 'square' ? this.shapeWidthCm : this.shapeHeightCm) * 0.01 * (this.heightCm / BASE_HEIGHT_CM)
    const count = this.shapeKind === 'circle' ? 48 : 32
    const points: THREE.Vector3[] = []
    const center = hit.p.clone().project(this.camera)
    const cameraRight = new THREE.Vector3().setFromMatrixColumn(this.camera.matrixWorld, 0).normalize()
    const cameraUp = new THREE.Vector3().setFromMatrixColumn(this.camera.matrixWorld, 1).normalize()
    const projectedRight = hit.p.clone().addScaledVector(cameraRight, halfWidth).project(this.camera)
    const projectedUp = hit.p.clone().addScaledVector(cameraUp, halfHeight).project(this.camera)
    const ndcHalfWidth = Math.max(0.002, Math.abs(projectedRight.x - center.x))
    const ndcHalfHeight = Math.max(0.002, Math.abs(projectedUp.y - center.y))
    const targets = this.collisionMeshes.length ? this.collisionMeshes : this.bodyMeshes
    for (let i = 0; i < count; i++) {
      let x = 0
      let y = 0
      if (this.shapeKind === 'circle') {
        const angle = (i / count) * Math.PI * 2
        x = Math.cos(angle)
        y = Math.sin(angle)
      } else {
        const side = Math.floor(i / 8)
        const progress = (i % 8) / 8
        if (side === 0) { x = -1 + progress * 2; y = -1 }
        else if (side === 1) { x = 1; y = -1 + progress * 2 }
        else if (side === 2) { x = 1 - progress * 2; y = 1 }
        else { x = -1; y = 1 - progress * 2 }
      }
      this.raycaster.setFromCamera(new THREE.Vector2(center.x + x * ndcHalfWidth, center.y + y * ndcHalfHeight), this.camera)
      const surfaceHit = this.raycaster.intersectObjects(targets, false)[0]
      if (!surfaceHit) continue
      let normal = new THREE.Vector3(0, 0, 1)
      if (surfaceHit.normal) normal = surfaceHit.normal.clone().applyMatrix3(new THREE.Matrix3().getNormalMatrix(surfaceHit.object.matrixWorld)).normalize()
      else if (surfaceHit.face) normal = surfaceHit.face.normal.clone().applyMatrix3(new THREE.Matrix3().getNormalMatrix(surfaceHit.object.matrixWorld)).normalize()
      points.push(this.offsetPoint(surfaceHit.point, normal))
    }
    if (points.length < 3) return
    const curve = new THREE.CatmullRomCurve3(points,true,'centripetal',.5)
    const mesh = new THREE.Mesh(
      new THREE.TubeGeometry(curve, Math.max(32, count * 6), this.strokeRadius(), 8, true),
      new THREE.MeshStandardMaterial({ color: this.color, roughness: 0.52 })
    )
    const group = new THREE.Group()
    group.add(mesh)
    group.userData.design = { kind: 'shape', shape: this.shapeKind, widthCm: this.shapeWidthCm, heightCm: this.shapeHeightCm, color: this.color, radius: this.strokeRadius(), points: points.map((p) => p.toArray()) }
    this.strokesGroup.add(group)
    this.strokeStack.push(group)
    this.applyOutlineVisibility()
    this.notifyStrokes()
  }

  private buildSavedItem(spec: Record<string, unknown>): THREE.Group | null {
    const kind = spec.kind
    const group = new THREE.Group()
    group.userData.design = structuredClone(spec)
    if (kind === 'stones') {
      const shape = spec.shape as StoneShape
      const size = Number(spec.size)
      const color = String(spec.color)
      const placements=(spec.placements as Array<{p:number[];n:number[]}>)||[],stones=new THREE.InstancedMesh(this.stoneGeometry(shape,size),new THREE.MeshPhysicalMaterial({color,metalness:.15,roughness:.08,transmission:.36,thickness:.5}),placements.length),matrix=new THREE.Matrix4(),scale=new THREE.Vector3(1,1,1)
      placements.forEach((placement,index)=>{const position=new THREE.Vector3().fromArray(placement.p),quaternion=new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0,0,1),new THREE.Vector3().fromArray(placement.n).normalize());matrix.compose(position,quaternion,scale);stones.setMatrixAt(index,matrix)});stones.instanceMatrix.needsUpdate=true;group.add(stones)
      return group
    }
    if (kind === 'spray') {
      const values = spec.points as number[]
      const geo = new THREE.BufferGeometry()
      geo.setAttribute('position', new THREE.Float32BufferAttribute(values, 3))
      group.add(new THREE.Points(geo, new THREE.PointsMaterial({ color: String(spec.color), size: Number(spec.size), map: makeSoftDotTexture(), transparent: true, opacity: 0.85, depthWrite: false })))
      return group
    }
    if (kind === 'brush') {
      const points = ((spec.points as number[][]) || []).map((point) => new THREE.Vector3().fromArray(point))
      const normals = ((spec.normals as number[][]) || []).map((normal) => new THREE.Vector3().fromArray(normal).normalize())
      if (!points.length) return null
      group.add(this.makeBrushDabs(points, normals, Number(spec.radius) || 0.08, String(spec.color)))
      return group
    }
    if (kind === 'pencil' || kind === 'shape') {
      const points = ((spec.points as number[][]) || []).map((p) => new THREE.Vector3().fromArray(p))
      if (!points.length) return null
      const radius = Number(spec.radius) || 0.012
      const color = String(spec.color)
      const closed = kind === 'shape' || Boolean(spec.closed)
      const geo = points.length === 1 ? new THREE.SphereGeometry(radius, 14, 12) : new THREE.TubeGeometry(new THREE.CatmullRomCurve3(points,closed,'centripetal',.5), Math.min(450, points.length * 4), radius, 6, closed)
      const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color, roughness: 0.55 }))
      if (points.length === 1) mesh.position.copy(points[0])
      group.add(mesh)
      if (spec.fillColor) {
        const saved = spec.fillGeometry as { positions?: number[]; indices?: number[]; uvs?: number[] } | undefined
        let fill: THREE.Mesh | null = null
        if (saved?.positions?.length && saved.indices?.length) {
          const geometry = new THREE.BufferGeometry()
          geometry.setAttribute('position', new THREE.Float32BufferAttribute(saved.positions, 3))
          if (saved.uvs?.length) geometry.setAttribute('uv', new THREE.Float32BufferAttribute(saved.uvs, 2))
          geometry.setIndex(saved.indices)
          geometry.computeVertexNormals()
          fill = new THREE.Mesh(
            geometry,
            this.makeGarmentMaterial(
              String(spec.fillColor),
              (spec.fillPreset as FabricPreset) || 'matte',
              Number(spec.fillScale) || 1,
              Number(spec.fillRotation) || 0,
            ),
          )
          fill.renderOrder = 2
        } else {
          fill = this.makeFill(points, String(spec.fillColor), (spec.fillPreset as FabricPreset) || 'matte', Number(spec.fillScale) || 1, Number(spec.fillRotation) || 0)
        }
        if (fill) { fill.name = 'closed-fill'; group.add(fill) }
      }
      return group
    }
    return null
  }

  dispose() {
    this.disposed = true
    cancelAnimationFrame(this.raf)
    this.ro.disconnect()
    const c = this.canvas
    c.removeEventListener('pointerdown', this.boundDown)
    c.removeEventListener('pointermove', this.boundMove)
    c.removeEventListener('pointerup', this.boundUp)
    c.removeEventListener('pointercancel', this.boundUp)
    c.removeEventListener('wheel', this.boundWheel)
    c.removeEventListener('contextmenu', this.boundCtx)
    for (const entry of this.collisionGenerators) {
      ;(entry.mesh.geometry as BVHGeometry).disposeBoundsTree?.()
      disposeObject(entry.mesh)
    }
    this.collisionGenerators = []
    this.collisionMeshes = []
    disposeObject(this.scene)
    this.renderer.dispose()
  }

  // ---------------------------------------------------------- internals

  private applyHeight() {
    const s = this.heightCm / BASE_HEIGHT_CM
    this.manikinGroup.scale.setScalar(s)
    this.manikinGroup.position.y = STAND_TOP
    this.target.set(0, STAND_TOP + 0.12 * s, 0)
    if (this.referenceModel) {
      this.referenceModel.scale.setScalar(1.8 * s)
      this.referenceModel.position.set(0, 1.72 * s, 0)
      this.target.set(0, 1.7 * s, 0)
      this.referenceModel.updateMatrixWorld(true)
      this.refreshCollisionMeshes()
    }
    // keep framing proportional when height changes
    this.desiredDist = 5.2 * s
    this.dist = Math.min(this.dist, 10.5 * s)
  }

  private refreshCollisionMeshes() {
    for (const entry of this.collisionGenerators) {
      const geometry = entry.mesh.geometry as BVHGeometry
      geometry.disposeBoundsTree?.()
      entry.generator.generate(geometry)
      geometry.computeBoundsTree()
      geometry.computeBoundingSphere()
    }
  }

  private buildCollisionMeshes(meshes: THREE.Object3D[]) {
    for (const entry of this.collisionGenerators) {
      ;(entry.mesh.geometry as BVHGeometry).disposeBoundsTree?.()
      disposeObject(entry.mesh)
    }
    this.collisionGenerators = []
    this.collisionMeshes = []
    for (const object of meshes) {
      const source = object as THREE.Mesh
      const generator = new StaticGeometryGenerator(source)
      generator.useGroups = false
      generator.attributes = ['position', 'normal']
      const geometry = generator.generate() as BVHGeometry
      geometry.computeBoundsTree()
      geometry.computeBoundingSphere()
      const proxy = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }))
      proxy.name = 'mannequin-collision-proxy'
      this.collisionGenerators.push({ generator, mesh: proxy })
      this.collisionMeshes.push(proxy)
    }
  }

  private notifyStrokes(emit = true) {
    this.opts.onStrokesChange?.(this.strokeStack.length)
    if (emit) this.emitDesignChange()
  }

  private loadReferenceModel() {
    const loader = new GLTFLoader()
    loader.load(
      './models/eden-female-mannequin.glb',
      (gltf) => {
        if (this.disposed) return
        const model = gltf.scene
        const loadedMeshes: THREE.Object3D[] = []
        model.traverse((object) => {
          const mesh = object as THREE.Mesh
          if (!mesh.isMesh) return
          loadedMeshes.push(mesh)
          mesh.castShadow = true
          mesh.receiveShadow = true
          const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
          for (const material of materials) {
            const textured = material as THREE.Material & { map?: THREE.Texture | null }
            if (textured.map) textured.map.colorSpace = THREE.SRGBColorSpace
          }
        })
        this.referenceModel = model
        this.bodyMeshes = loadedMeshes
        this.manikinGroup.visible = false
        this.standGroup.visible = false
        this.scene.add(model)
        this.applyHeight()
        this.buildCollisionMeshes(loadedMeshes)
      },
      undefined,
      (error) => console.error('[atelier] Could not load mannequin model', error)
    )
  }

  private presetDrawingAnchor(view: DrawingViewPreset): DrawingPlaneAnchor {
    const aspect = Math.max(.45, this.canvas.clientWidth / Math.max(1, this.canvas.clientHeight))
    const height = 3.78
    const position: [number,number,number]=view==='front'?[0,1.7,.34]:view==='back'?[0,1.7,-.34]:view==='right'?[.97,1.7,0]:[-.97,1.7,0]
    const rotation=new THREE.Quaternion().setFromEuler(new THREE.Euler(0,view==='front'?0:view==='back'?Math.PI:view==='right'?Math.PI/2:-Math.PI/2,0))
    return {position,quaternion:rotation.toArray() as [number,number,number,number],width:height*aspect,height}
  }

  private createDrawingPlane(texture: THREE.Texture, anchor: DrawingPlaneAnchor): THREE.Mesh {
    const mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(anchor.width, anchor.height),
      new THREE.MeshBasicMaterial({ map: texture, transparent: true, depthWrite: false, side: THREE.DoubleSide })
    )
    mesh.position.fromArray(anchor.position)
    mesh.quaternion.fromArray(anchor.quaternion)
    mesh.renderOrder = 5
    const outline=new THREE.LineSegments(new THREE.EdgesGeometry(mesh.geometry),new THREE.LineBasicMaterial({color:0xc9a96a,transparent:true,opacity:.95,depthTest:false}));outline.name='drawing-plane-outline';outline.visible=false;outline.renderOrder=6;mesh.add(outline)
    return mesh
  }

  private buildDrawingPlanes() {
    // Planes are created lazily when each 2D view receives artwork.
  }

  private emitDesignChange() {
    this.opts.onDesignChange?.(this.exportState())
  }

  private resize() {
    const parent = this.canvas.parentElement
    const w = Math.max(1, parent?.clientWidth ?? window.innerWidth)
    const h = Math.max(1, parent?.clientHeight ?? window.innerHeight)
    this.renderer.setSize(w, h, false)
    this.camera.aspect = w / h
    this.camera.updateProjectionMatrix()
  }

  private updateCamera() {
    const sp = Math.sin(this.polar)
    const cp = Math.cos(this.polar)
    const sinAzimuth = Math.sin(this.azimuth)
    const cosAzimuth = Math.cos(this.azimuth)
    this.camera.position.set(
      this.target.x + this.dist * sp * sinAzimuth,
      this.target.y + this.dist * cp,
      this.target.z + this.dist * sp * cosAzimuth
    )
    // A spherical tangent stays valid at the top and bottom poles and allows
    // continuous tumbling into a genuinely upside-down view.
    this.camera.up.set(-cp * sinAzimuth, sp, -cp * cosAzimuth).normalize()
    this.camera.lookAt(this.target)
  }

  private strokeRadius(): number {
    if (this.tool === 'brush') return this.brushSizeCm * 0.01 * (this.heightCm / BASE_HEIGHT_CM)
    return 0.0035 + this.thickness * 0.0021 // ~0.006 .. ~0.025 local units
  }

  private makeBrushDabs(points: THREE.Vector3[], normals: THREE.Vector3[], radius: number, color: string) {
    const geometry = new THREE.CircleGeometry(radius, 18)
    const material = new THREE.MeshStandardMaterial({
      color,
      side: THREE.DoubleSide,
      roughness: 0.72,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    })
    const dabs = new THREE.InstancedMesh(geometry, material, points.length)
    const matrix = new THREE.Matrix4()
    const scale = new THREE.Vector3(1, 1, 1)
    const forward = new THREE.Vector3(0, 0, 1)
    points.forEach((point, index) => {
      const normal = normals[index]?.clone().normalize() || forward
      const quaternion = new THREE.Quaternion().setFromUnitVectors(forward, normal)
      matrix.compose(point, quaternion, scale)
      dabs.setMatrixAt(index, matrix)
    })
    dabs.instanceMatrix.needsUpdate = true
    dabs.frustumCulled = false
    return dabs
  }

  /** Raycast onto the manikin body (torso + bust); returns local-space point + normal */
  private hitManikin(clientX: number, clientY: number): { p: THREE.Vector3; n: THREE.Vector3 } | null {
    const rect = this.canvas.getBoundingClientRect()
    const ndc = new THREE.Vector2(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1
    )
    this.raycaster.setFromCamera(ndc, this.camera)
    const hits = this.raycaster.intersectObjects(this.collisionMeshes.length ? this.collisionMeshes : this.bodyMeshes, false)
    if (!hits.length) return null
    const hit = hits[0]
    // Use the renderer's barycentrically interpolated vertex normal. A flat
    // face normal makes the brush jump at every triangle on dense GLB meshes.
    let n = new THREE.Vector3(0, 0, 1)
    if (hit.normal) {
      const nm = new THREE.Matrix3().getNormalMatrix(hit.object.matrixWorld)
      n = hit.normal.clone().applyMatrix3(nm).normalize()
    } else if (hit.face) {
      const nm = new THREE.Matrix3().getNormalMatrix(hit.object.matrixWorld)
      n = hit.face.normal.clone().applyMatrix3(nm).normalize()
    }
    const p = hit.point.clone()
    return { p, n }
  }

  /**
   * Drawing surface: the manikin when the ray hits it, otherwise a camera-facing
   * plane locked to the depth where the stroke left the body (no depth drift —
   * you paint exactly in the angle you are looking from). New strokes that start
   * in space lock to manikin-center depth facing the current view.
   */
  private hitDrawingSurface(clientX: number, clientY: number): { p: THREE.Vector3; n: THREE.Vector3 } | null {
    const st = this.stroke
    const direct = this.hitManikin(clientX, clientY)
    if (direct) {
      // back on the body: release the airborne plane so the next off-body
      // segment re-anchors from this new surface point
      if (st) st.planeRef = null
      return direct
    }

    const rect = this.canvas.getBoundingClientRect()
    const ndc = new THREE.Vector2(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1
    )
    this.raycaster.setFromCamera(ndc, this.camera)
    const camDir = this.camera.getWorldDirection(new THREE.Vector3())

    let refWorld: THREE.Vector3
    if (st) {
      if (!st.planeRef) {
        st.planeRef = st.lastLocal ? st.lastLocal.clone() : this.target.clone()
      }
      refWorld = st.planeRef
    } else {
      refWorld = this.target.clone()
    }

    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(camDir, refWorld)
    const hit = new THREE.Vector3()
    if (!this.raycaster.ray.intersectPlane(plane, hit)) return null

    // keep stray intersections inside a sensible bubble around the manikin
    const s = this.heightCm / BASE_HEIGHT_CM
    const maxR = 2.6 * s
    const offset = hit.clone().sub(this.target)
    if (offset.length() > maxR) {
      hit.copy(this.target).addScaledVector(offset.normalize(), maxR)
    }

    const p = hit
    const n = camDir.clone().negate()
    return { p, n }
  }

  /** View metrics for the on-screen rulers: how many cm one screen pixel covers */
  getViewMetrics(): { cmPerPixel: number; width: number; height: number } {
    const parent = this.canvas.parentElement
    const width = Math.max(1, parent?.clientWidth ?? window.innerWidth)
    const height = Math.max(1, parent?.clientHeight ?? window.innerHeight)
    const worldPerPixel =
      (2 * this.dist * Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2))) / height
    // full dancer figure is ~3.4 local units tall and represents heightCm
    const cmPerUnit = this.heightCm / 3.4
    return { cmPerPixel: worldPerPixel * cmPerUnit, width, height }
  }

  // ---------------------------------------------------------- pointer handling

  private onPointerDown(e: PointerEvent) {
    e.preventDefault()
    try {
      this.canvas.setPointerCapture(e.pointerId)
    } catch {
      /* ignore */
    }
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY })

    if (this.pointers.size === 2) {
      // second finger: cancel any in-progress stroke, switch to pinch/orbit
      this.cancelStroke()
      this.orbitBase = null
      const [a, b] = [...this.pointers.values()]
      this.pinchBase = {
        d: Math.hypot(a.x - b.x, a.y - b.y),
        dist: this.desiredDist,
        midX: (a.x + b.x) / 2,
        midY: (a.y + b.y) / 2,
        az: this.azimuth,
        pol: this.polar,
      }
      return
    }
    if (this.pointers.size > 2) return

    // single pointer
    this.downInfo = { x: e.clientX, y: e.clientY, t: performance.now() }
    if (this.tool === 'move') {
      this.orbitBase = { x: e.clientX, y: e.clientY, az: this.azimuth, pol: this.polar }
      return
    }
    if (this.tool === 'fill') {
      this.fillClosedItemAt(e.clientX, e.clientY)
      return
    }
    if (this.tool === 'stone') {
      const hit = this.hitManikin(e.clientX, e.clientY)
      if (hit) this.placeStoneBatch(hit)
      return
    }
    if (this.tool === 'shape') {
      const hit = this.hitManikin(e.clientX, e.clientY)
      if (hit) this.placeShape(hit)
      return
    }
    if (this.tool === 'eraser') {
      this.eraseAt(e.clientX, e.clientY)
      return
    }
    // pencil / spray — begin stroke on the manikin OR in the space around it
    const hit = this.hitDrawingSurface(e.clientX, e.clientY)
    if (hit) this.beginStroke(hit,e.clientX,e.clientY)
  }

  private onPointerMove(e: PointerEvent) {
    if (!this.pointers.has(e.pointerId)) return
    e.preventDefault()
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY })

    if (this.pointers.size === 2 && this.pinchBase) {
      const [a, b] = [...this.pointers.values()]
      const d = Math.hypot(a.x - b.x, a.y - b.y)
      const midX = (a.x + b.x) / 2
      const midY = (a.y + b.y) / 2
      const s = this.heightCm / BASE_HEIGHT_CM
      if (this.pinchBase.d > 0) {
        this.desiredDist = THREE.MathUtils.clamp(
          this.pinchBase.dist * (this.pinchBase.d / d),
          0.85 * s,
          10.5 * s
        )
      }
      this.azimuth = this.pinchBase.az - (midX - this.pinchBase.midX) * 0.006
      this.polar = this.pinchBase.pol - (midY - this.pinchBase.midY) * 0.006
      return
    }

    if (this.pointers.size !== 1) return

    if (this.tool === 'move' && this.orbitBase) {
      this.azimuth = this.orbitBase.az - (e.clientX - this.orbitBase.x) * 0.0085
      this.polar = this.orbitBase.pol - (e.clientY - this.orbitBase.y) * 0.0085
      return
    }
    if (this.tool === 'eraser') {
      this.eraseAt(e.clientX, e.clientY)
      return
    }
    if (this.tool === 'stone') {
      const hit = this.hitManikin(e.clientX, e.clientY)
      if (hit && (!this.lastStonePoint || this.lastStonePoint.distanceTo(hit.p) > this.stoneSize * 0.012)) {
        this.placeStoneBatch(hit)
      }
      return
    }
    if ((this.tool === 'pencil' || this.tool === 'brush' || this.tool === 'spray') && this.stroke) {
      const coalesced=e.getCoalescedEvents?.()||[e]
      const stride=Math.max(1,Math.ceil(coalesced.length/4))
      const samples=coalesced.filter((_,index)=>index%stride===0||index===coalesced.length-1).slice(-4)
      for(const sample of samples){
        const previous=this.stroke?.lastScreen
        const raw=new THREE.Vector2(sample.clientX,sample.clientY)
        const distance=previous?.distanceTo(raw)??0
        const alpha=THREE.MathUtils.clamp(.3+distance/28,.3,.82)
        const filtered=previous?previous.clone().lerp(raw,alpha):raw
        const steps=previous?Math.min(6,Math.max(1,Math.ceil(previous.distanceTo(filtered)/9))):1
        for(let index=1;index<=steps;index++){
          const screen=previous?previous.clone().lerp(filtered,index/steps):filtered
          const hit=this.hitDrawingSurface(screen.x,screen.y)
          if(hit)this.extendStroke(hit)
        }
        this.stroke!.lastScreen=filtered
      }
    }
  }

  private onPointerUp(e: PointerEvent) {
    if (!this.pointers.has(e.pointerId)) return
    this.pointers.delete(e.pointerId)
    try {
      this.canvas.releasePointerCapture(e.pointerId)
    } catch {
      /* ignore */
    }

    if (this.pointers.size < 2) this.pinchBase = null

    if (this.pointers.size === 0) {
      const turn = Math.PI * 2
      this.azimuth = ((this.azimuth + Math.PI) % turn + turn) % turn - Math.PI
      this.polar = ((this.polar % turn) + turn) % turn
      // double-tap zoom (move mode only, and only for clean taps)
      if (this.tool === 'move' && this.downInfo) {
        const moved = Math.hypot(e.clientX - this.downInfo.x, e.clientY - this.downInfo.y)
        const dt = performance.now() - this.downInfo.t
        if (moved < 10 && dt < 260) {
          const now = performance.now()
          if (
            this.lastTap &&
            now - this.lastTap.t < 340 &&
            Math.hypot(e.clientX - this.lastTap.x, e.clientY - this.lastTap.y) < 60
          ) {
            const s = this.heightCm / BASE_HEIGHT_CM
            this.desiredDist = this.desiredDist > 2.2 * s ? 1.25 * s : 5.2 * s
            this.lastTap = null
          } else {
            this.lastTap = { t: now, x: e.clientX, y: e.clientY }
          }
        }
      }
      this.finishStroke()
      this.lastStonePoint = null
      this.orbitBase = null
      this.downInfo = null
    } else if (this.pointers.size === 1) {
      // went from 2 → 1: reset baselines so nothing jumps; stroke stays cancelled
      const remaining = [...this.pointers.values()][0]
      if (this.tool === 'move') {
        this.orbitBase = { x: remaining.x, y: remaining.y, az: this.azimuth, pol: this.polar }
      }
    }
  }

  private onWheel(e: WheelEvent) {
    e.preventDefault()
    this.zoomBy(1 + e.deltaY * 0.0012)
  }

  // ---------------------------------------------------------- strokes

  private offsetPoint(p: THREE.Vector3, n: THREE.Vector3): THREE.Vector3 {
    // Offset by more than the tube radius so the whole garment stroke stays
    // above the skin instead of placing its centre on the skin and clipping.
    const offset = this.tool === 'brush' ? 0.009 : this.strokeRadius() * 1.45 + 0.004
    return p.clone().addScaledVector(n, offset)
  }

  private mirrored(v: THREE.Vector3): THREE.Vector3 {
    return new THREE.Vector3(-v.x, v.y, v.z)
  }

  private snapDistance(): number {
    return Math.max(0.045 * (this.heightCm / BASE_HEIGHT_CM), this.strokeRadius() * 3)
  }

  private findSnapPoint(point: THREE.Vector3): THREE.Vector3 | null {
    const limit = this.snapDistance()
    let bestDistance = limit
    let bestPoint: THREE.Vector3 | null = null
    const segment = new THREE.Line3()
    const candidate = new THREE.Vector3()

    for (const item of this.strokeStack) {
      const design = item.userData.design as Record<string, unknown> | undefined
      if (!design || (design.kind !== 'pencil' && design.kind !== 'shape')) continue
      const values = design.points
      if (!Array.isArray(values)) continue
      const points = values
        .filter((value): value is number[] => Array.isArray(value) && value.length >= 3)
        .map((value) => new THREE.Vector3().fromArray(value))
      if (!points.length) continue

      for (let index = 0; index < points.length - 1; index += 1) {
        segment.set(points[index], points[index + 1])
        segment.closestPointToPoint(point, true, candidate)
        const distance = candidate.distanceTo(point)
        if (distance < bestDistance) {
          bestDistance = distance
          bestPoint = candidate.clone()
        }
      }
      if ((design.kind === 'shape' || design.closed) && points.length > 2) {
        segment.set(points[points.length - 1], points[0])
        segment.closestPointToPoint(point, true, candidate)
        const distance = candidate.distanceTo(point)
        if (distance < bestDistance) {
          bestDistance = distance
          bestPoint = candidate.clone()
        }
      }
      if (points.length === 1) {
        const distance = points[0].distanceTo(point)
        if (distance < bestDistance) {
          bestDistance = distance
          bestPoint = points[0].clone()
        }
      }
    }
    return bestPoint
  }

  private beginStroke(hit: { p: THREE.Vector3; n: THREE.Vector3 },screenX:number,screenY:number) {
    const group = new THREE.Group()
    this.stroke = {
      group,
      kind: this.tool === 'spray' ? 'spray' : this.tool === 'brush' ? 'brush' : 'pencil',
      points: [],
      normals: [],
      lastLocal: null,
      planeRef: null,
      previewMesh: null,
      pointsObj: null,
      positions: null,
      posCount: 0,
      previewDirty: false,
      lastPreviewAt: 0,
      lastScreen: new THREE.Vector2(screenX,screenY),
    }
    this.extendStroke(hit)
  }

  private extendStroke(hit: { p: THREE.Vector3; n: THREE.Vector3 }) {
    const st = this.stroke
    if (!st) return
    const r = this.strokeRadius()
    let pt = this.offsetPoint(hit.p, hit.n)
    if (st.kind === 'pencil' && this.snapEnabled) {
      const existingTarget = this.findSnapPoint(pt)
      const closeTarget = st.points.length > 3 && st.points[0].distanceTo(pt) < this.snapDistance() ? st.points[0] : null
      pt = closeTarget?.clone() ?? existingTarget ?? pt
    }
    st.lastLocal = pt

    if (st.kind === 'pencil' || st.kind === 'brush') {
      const minDist = Math.max(0.006, r * (st.kind === 'brush' ? 0.32 : 0.55))
      const last = st.points[st.points.length - 1]
      const distance=last?.distanceTo(pt)??0
      if (last && distance < minDist) return
      // Do not add straight 3D chords between surface hits. Those shortcuts
      // cut through curved areas such as the bust, hips, arms and legs.
      st.points.push(pt)
      st.normals.push(hit.n.clone().normalize())
      // Refresh a cheap live preview at most once per animation frame. The
      // smooth tube is built only after the pencil is lifted.
      st.previewDirty = true
      return
    }

    // spray — scatter soft dots on the surface around the hit
    const spread = r * 7
    const dots = 6 + this.thickness * 2
    this.ensureSprayCapacity(st, dots * (this.mirror ? 2 : 1))
    if (!st.positions || !st.pointsObj) return
    const up = Math.abs(hit.n.y) > 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0)
    const t1 = new THREE.Vector3().crossVectors(hit.n, up).normalize()
    const t2 = new THREE.Vector3().crossVectors(hit.n, t1)
    for (let i = 0; i < dots; i++) {
      const ang = Math.random() * Math.PI * 2
      const rr = Math.sqrt(Math.random()) * spread
      const off = t1
        .clone()
        .multiplyScalar(Math.cos(ang) * rr)
        .addScaledVector(t2, Math.sin(ang) * rr)
      const jitter = Math.random() * 0.008
      const base = pt.clone().add(off).addScaledVector(hit.n, jitter)
      st.positions[st.posCount * 3] = base.x
      st.positions[st.posCount * 3 + 1] = base.y
      st.positions[st.posCount * 3 + 2] = base.z
      st.posCount++
      if (this.mirror) {
        const m = this.mirrored(base)
        st.positions[st.posCount * 3] = m.x
        st.positions[st.posCount * 3 + 1] = m.y
        st.positions[st.posCount * 3 + 2] = m.z
        st.posCount++
      }
      if (st.posCount * 3 >= st.positions.length) break
    }
    const attr = st.pointsObj.geometry.getAttribute('position') as THREE.BufferAttribute
    attr.needsUpdate = true
    st.pointsObj.geometry.setDrawRange(0, st.posCount)
  }

  private ensureSprayCapacity(st: ActiveStroke, extra: number) {
    if (!st.pointsObj) {
      const cap = 6000
      st.positions = new Float32Array(cap * 3)
      const geo = new THREE.BufferGeometry()
      geo.setAttribute('position', new THREE.BufferAttribute(st.positions, 3))
      geo.setDrawRange(0, 0)
      const mat = new THREE.PointsMaterial({
        color: new THREE.Color(this.color),
        size: this.strokeRadius() * 3.4,
        map: makeSoftDotTexture(),
        transparent: true,
        opacity: 0.85,
        depthWrite: false,
        sizeAttenuation: true,
      })
      st.pointsObj = new THREE.Points(geo, mat)
      st.pointsObj.frustumCulled = false
      st.group.add(st.pointsObj)
      if (!st.group.parent) this.strokesGroup.add(st.group)
      return
    }
    if (st.positions && st.posCount * 3 + extra * 3 > st.positions.length) {
      // grow once, up to a hard cap of 20000 dots
      const newCap = Math.min(st.positions.length * 2, 20000 * 3)
      if (newCap <= st.positions.length) return
      const next = new Float32Array(newCap)
      next.set(st.positions.subarray(0, st.posCount * 3))
      st.positions = next
      const geo = new THREE.BufferGeometry()
      geo.setAttribute('position', new THREE.BufferAttribute(st.positions, 3))
      geo.setDrawRange(0, st.posCount)
      st.pointsObj.geometry.dispose()
      st.pointsObj.geometry = geo
    }
  }

  private rebuildPencilPreview(st: ActiveStroke) {
    if (st.previewMesh) {
      st.group.remove(st.previewMesh)
      st.previewMesh.geometry.dispose()
      const material = st.previewMesh.material
      if (Array.isArray(material)) material.forEach((item) => item.dispose())
      else material.dispose()
      st.previewMesh = null
    }
    if (st.points.length === 1) {
      const geo = new THREE.SphereGeometry(this.strokeRadius() * 1.15, 8, 6)
      const mat = new THREE.MeshBasicMaterial({ color: new THREE.Color(this.color) })
      st.previewMesh = new THREE.Mesh(geo, mat)
      st.previewMesh.position.copy(st.points[0])
      st.group.add(st.previewMesh)
      if (!st.group.parent) this.strokesGroup.add(st.group)
      return
    }
    const geo = new THREE.BufferGeometry().setFromPoints(st.points)
    const mat = new THREE.LineBasicMaterial({ color: new THREE.Color(this.color) })
    st.previewMesh = new THREE.Line(geo, mat)
    st.group.add(st.previewMesh)
    if (!st.group.parent) this.strokesGroup.add(st.group)
  }

  private finishStroke() {
    const st = this.stroke
    if (!st) return
    this.stroke = null

    if (st.kind === 'pencil' && st.points.length === 0) {
      this.strokesGroup.remove(st.group)
      return
    }

    // final geometry for pencil (smoother) + mirror twin
    if (st.kind === 'pencil' || st.kind === 'brush') {
      if (st.kind === 'pencil' && this.snapEnabled && st.points.length > 1) {
        const lastIndex = st.points.length - 1
        const end = st.points[lastIndex]
        let target = this.findSnapPoint(end)
        if (st.points.length > 3 && st.points[0].distanceTo(end) < this.snapDistance()) {
          target = st.points[0].clone()
        }
        if (target) st.points[lastIndex] = target
      }
      if (st.previewMesh) {
        st.group.remove(st.previewMesh)
        st.previewMesh.geometry.dispose()
        const material = st.previewMesh.material
        if (Array.isArray(material)) material.forEach((item) => item.dispose())
        else material.dispose()
        st.previewMesh = null
      }
      if (st.kind === 'brush') {
        st.previewMesh = this.makeBrushDabs(st.points, st.normals, this.strokeRadius(), this.color)
        st.group.add(st.previewMesh)
      } else if (st.points.length === 1) {
        const geo = new THREE.SphereGeometry(this.strokeRadius() * 1.15, 14, 12)
        const mat = new THREE.MeshStandardMaterial({ color: new THREE.Color(this.color), roughness: 0.55 })
        st.previewMesh = new THREE.Mesh(geo, mat)
        st.previewMesh.position.copy(st.points[0])
        st.group.add(st.previewMesh)
      } else {
        const curve = new THREE.CatmullRomCurve3(st.points,false,'centripetal',.5)
        const segs = Math.min(st.points.length * 4, 450)
        const geo = new THREE.TubeGeometry(curve, segs, this.strokeRadius(), 6, false)
        const mat = new THREE.MeshStandardMaterial({ color: new THREE.Color(this.color), roughness: 0.55 })
        st.previewMesh = new THREE.Mesh(geo, mat)
        st.group.add(st.previewMesh)
      }
      if (st.kind === 'pencil' && this.mirror && st.previewMesh) {
        const mirroredPts = st.points.map((p) => this.mirrored(p))
        let mgeo: THREE.BufferGeometry
        if (mirroredPts.length === 1) {
          mgeo = new THREE.SphereGeometry(this.strokeRadius() * 1.15, 14, 12)
        } else {
          const mcurve = new THREE.CatmullRomCurve3(mirroredPts,false,'centripetal',.5)
          mgeo = new THREE.TubeGeometry(mcurve, Math.min(mirroredPts.length * 4, 450), this.strokeRadius(), 6, false)
        }
        const mmesh = new THREE.Mesh(
          mgeo,
          new THREE.MeshStandardMaterial({ color: new THREE.Color(this.color), roughness: 0.55 })
        )
        if (mirroredPts.length === 1) mmesh.position.copy(mirroredPts[0])
        st.group.add(mmesh)
      }
    }

    if (!st.group.parent) this.strokesGroup.add(st.group)
    st.group.userData.design =
      st.kind === 'pencil'
        ? {
            kind: 'pencil',
            color: this.color,
            radius: this.strokeRadius(),
            points: st.points.map((p) => p.toArray()),
            closed: st.points.length > 3 && st.points[0].distanceTo(st.points[st.points.length - 1]) < this.strokeRadius() * 8,
          }
        : st.kind === 'brush'
          ? {
              kind: 'brush',
              color: this.color,
              radius: this.strokeRadius(),
              sizeCm: this.brushSizeCm,
              points: st.points.map((point) => point.toArray()),
              normals: st.normals.map((normal) => normal.toArray()),
            }
          : {
            kind: 'spray',
            color: this.color,
            size: this.strokeRadius() * 3.4,
            points: st.positions ? Array.from(st.positions.subarray(0, st.posCount * 3)) : [],
          }
    this.strokeStack.push(st.group)
    this.applyOutlineVisibility()
    this.notifyStrokes()
  }

  private cancelStroke() {
    const st = this.stroke
    if (!st) return
    this.stroke = null
    this.strokesGroup.remove(st.group)
    disposeObject(st.group)
  }

  private eraseAt(clientX: number, clientY: number) {
    const rect = this.canvas.getBoundingClientRect()
    const ndc = new THREE.Vector2(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1
    )
    this.raycaster.setFromCamera(ndc, this.camera)
    const hits = this.raycaster.intersectObject(this.strokesGroup, true)
    if (!hits.length) return
    let obj: THREE.Object3D | null = hits[0].object
    while (obj && obj.parent !== this.strokesGroup) obj = obj.parent
    if (!obj) return
    const idx = this.strokeStack.indexOf(obj)
    if (idx >= 0) this.strokeStack.splice(idx, 1)
    this.strokesGroup.remove(obj)
    disposeObject(obj)
    this.notifyStrokes()
  }
}
