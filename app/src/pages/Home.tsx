import { useEffect, useRef, useState } from 'react'
import {
  Pencil,
  Paintbrush,
  SprayCan,
  PaintBucket,
  Eraser,
  Hand,
  Undo2,
  Trash2,
  Camera,
  Ruler,
  LayoutGrid,
  ZoomIn,
  ZoomOut,
  RotateCcw,
  RefreshCw,
  X,
  Download,
  FlipHorizontal2,
  Gem,
  Shapes,
  Shirt,
  Save,
  Smartphone,
  Square,
  Circle,
  Layers,
  Redo2,
  MousePointer2,
  Activity,
  Scissors,
  Eye,
  EyeOff,
  Lock,
  Unlock,
  Copy,
  RotateCw,
  Plus,
  Minus,
  ShieldCheck,
  FilePlus2,
  FolderOpen,
  Upload,
  FileDown,
} from 'lucide-react'
import {
  AtelierEngine,
  type AtelierDesignState,
  type DrawingPlaneAnchor,
  type FabricPreset,
  type ShapeKind,
  type StoneShape,
  type Tool,
  straightenDrawingPlaneAnchor,
} from '../three/engine'
import { composeDesignCard } from '../lib/designCard'
import {
  deleteSavedProject,
  isSavedAtelierProject,
  listSavedProjects,
  loadActiveDesign,
  loadActiveProjectId,
  loadDrawing,
  loadSavedProject,
  saveActiveDesign,
  saveDrawing,
  saveNamedProject,
  setActiveProjectId as persistActiveProjectId,
  type SavedAtelierProject,
  type SavedProjectSummary,
} from '../lib/autosave'
import {
  DrawingCanvas,
  type CoverageMode,
  type DrawingAction,
  type DrawingCanvasHandle,
  type DrawingPlaneSnapshot,
  type DrawingProject,
  type DrawingViewId,
  type GarmentTemplate,
  type LayerDefinition,
} from '../components/DrawingCanvas'

const GOLD = '#c9a96a'
const CHARCOAL = '#16130f'
const DEFAULT_LAYERS: LayerDefinition[] = [
  { id: 'design', name: 'Garment', visible: true, locked: false, opacity: 1 },
  { id: 'details', name: 'Seams & trims', visible: true, locked: false, opacity: 1 },
  { id: 'stones', name: 'Stones', visible: true, locked: false, opacity: 1 },
  { id: 'notes', name: 'Measurements', visible: true, locked: false, opacity: 1 },
]
const EMPTY_VIEWS: Record<DrawingViewId, DrawingAction[]> = { front: [], back: [], left: [], right: [] }

const PALETTE = [
  '#1f1b16', // noir
  '#f4ead9', // ivory
  '#8e1f2f', // crimson
  '#e8a2b4', // blush
  '#7c93ab', // dusty blue
  '#9aa88a', // sage
  '#c9a96a', // gold
  '#b9a7ce', // lilac
  '#5d4532', // chocolate
  '#ffffff', // white
]

const TOOLS: Array<{ id: Tool; label: string; icon: typeof Pencil }> = [
  { id: 'move', label: 'Move', icon: Hand },
  { id: 'pencil', label: 'Pencil', icon: Pencil },
  { id: 'brush', label: 'Paintbrush', icon: Paintbrush },
  { id: 'fill', label: 'Fill', icon: PaintBucket },
  { id: 'eraser', label: 'Eraser', icon: Eraser },
  { id: 'shape', label: 'Shapes', icon: Shapes },
  { id: 'stone', label: 'Stones', icon: Gem },
  { id: 'spray', label: 'Spray', icon: SprayCan },
  { id: 'measure', label: 'Measure', icon: Ruler },
  { id: 'select', label: 'Select', icon: MousePointer2 },
]
const SURFACE_3D_TOOLS = new Set<Tool>(['move','pencil','brush','spray','fill','stone','shape','eraser'])

const TOOL_HINTS: Record<Tool, string> = {
  pencil: '3D surface drawing · Snap joins nearby lines and closes fillable outlines',
  brush: 'Solid 3D paintbrush · choose a broad size and paint directly over the mannequin surface',
  spray: 'Soft 3D airbrush that follows the visible mannequin surface',
  fill: 'Tap inside a closed 3D outline · fabric wraps to the body contours and drapes outside the silhouette',
  stone: 'Paint on stones using the shape, size and batch count below',
  shape: 'Tap the mannequin to place a closed surface shape; use Fill inside it',
  measure: 'Drag between two points to add a saved measurement',
  select: 'Tap an item to move, resize, rotate, duplicate or delete it',
  eraser: 'Tap or drag over a stroke to remove it',
  move: 'Drag around, over or under · full upside-down tumble · pinch and double-tap zoom',
}

/** nice cm step so major ruler ticks stay at least ~55px apart */
function niceStep(cmPerPx: number): number {
  const target = 55 * cmPerPx
  for (const s of [1, 2, 5, 10, 20, 50, 100, 200]) if (s >= target) return s
  return 500
}

/** Photoshop-style measurement rulers (cm) along the top and left edges, live with zoom */
function Rulers({ engineRef }: { engineRef: React.RefObject<AtelierEngine | null> }) {
  const topRef = useRef<HTMLCanvasElement>(null)
  const leftRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    let raf = 0
    const THICK = 22

    const drawRuler = (
      cv: HTMLCanvasElement,
      length: number,
      cmPerPx: number,
      horizontal: boolean,
      dpr: number
    ) => {
      const w = horizontal ? length : THICK
      const h = horizontal ? THICK : length
      if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) {
        cv.width = Math.round(w * dpr)
        cv.height = Math.round(h * dpr)
        cv.style.width = `${w}px`
        cv.style.height = `${h}px`
      }
      const ctx = cv.getContext('2d')
      if (!ctx) return
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.clearRect(0, 0, w, h)
      ctx.fillStyle = 'rgba(22,19,15,0.5)'
      ctx.fillRect(0, 0, w, h)
      // edge line
      ctx.strokeStyle = 'rgba(201,169,106,0.35)'
      ctx.lineWidth = 1
      ctx.beginPath()
      if (horizontal) {
        ctx.moveTo(0, THICK - 0.5)
        ctx.lineTo(w, THICK - 0.5)
      } else {
        ctx.moveTo(THICK - 0.5, 0)
        ctx.lineTo(THICK - 0.5, h)
      }
      ctx.stroke()

      const step = niceStep(cmPerPx)
      const minor = step / 5
      const center = length / 2
      ctx.font = '9px Georgia, serif'
      const firstCm = Math.floor((-center * cmPerPx) / minor) * minor
      for (let cm = firstCm; cm <= center * cmPerPx + minor; cm += minor) {
        const px = center + cm / cmPerPx
        const isMajor = Math.abs(cm / step - Math.round(cm / step)) < 1e-6
        const isCenter = Math.abs(cm) < 1e-6
        const len = isMajor ? 10 : 5
        ctx.strokeStyle = isCenter ? 'rgba(201,169,106,0.95)' : 'rgba(201,169,106,0.55)'
        ctx.beginPath()
        if (horizontal) {
          ctx.moveTo(px, THICK)
          ctx.lineTo(px, THICK - len)
        } else {
          ctx.moveTo(THICK, px)
          ctx.lineTo(THICK - len, px)
        }
        ctx.stroke()
        if (isMajor && !isCenter) {
          const label = `${Math.round(cm)}`
          ctx.fillStyle = 'rgba(201,169,106,0.85)'
          if (horizontal) {
            ctx.textAlign = 'left'
            ctx.fillText(label, px + 3, 9)
          } else {
            ctx.save()
            ctx.translate(9, px - 3)
            ctx.rotate(-Math.PI / 2)
            ctx.textAlign = 'right'
            ctx.fillText(label, 0, 0)
            ctx.restore()
          }
        }
      }
    }

    const loop = () => {
      raf = requestAnimationFrame(loop)
      const eng = engineRef.current
      const top = topRef.current
      const left = leftRef.current
      if (!eng || !top || !left) return
      const m = eng.getViewMetrics()
      const dpr = Math.min(window.devicePixelRatio || 1, 2)
      drawRuler(top, m.width, m.cmPerPixel, true, dpr)
      drawRuler(left, m.height, m.cmPerPixel, false, dpr)
    }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [engineRef])

  return (
    <>
      <canvas
        ref={topRef}
        style={{
          position: 'absolute',
          top: 'env(safe-area-inset-top)',
          left: 0,
          pointerEvents: 'none',
          zIndex: 4,
        }}
      />
      <canvas
        ref={leftRef}
        style={{
          position: 'absolute',
          top: 'calc(env(safe-area-inset-top) + 22px)',
          left: 0,
          pointerEvents: 'none',
          zIndex: 4,
        }}
      />
    </>
  )
}

export default function Home() {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const engineRef = useRef<AtelierEngine | null>(null)
  const drawingRef = useRef<DrawingCanvasHandle>(null)

  const [tool, setTool] = useState<Tool>('move')
  const [color, setColor] = useState('#8e1f2f')
  const [thickness, setThickness] = useState(4)
  const [brushSizeCm, setBrushSizeCm] = useState(8)
  const [mirror, setMirror] = useState(false)
  const [snapEnabled, setSnapEnabled] = useState(true)
  const [outlinesVisible, setOutlinesVisible] = useState(true)
  const [autoRotate, setAutoRotate] = useState(false)
  const [strokes, setStrokes] = useState(0)
  const [surfaceStrokes, setSurfaceStrokes] = useState(0)
  const [surfaceStoneCount, setSurfaceStoneCount] = useState(0)
  const [sizeOpen, setSizeOpen] = useState(false)
  const [height, setHeight] = useState(170)
  const [cardBusy, setCardBusy] = useState(false)
  const [cardUrl, setCardUrl] = useState<string | null>(null)
  const [fabric, setFabric] = useState<FabricPreset>('matte')
  const [materialsOpen, setMaterialsOpen] = useState(false)
  const [stoneShape, setStoneShape] = useState<StoneShape>('diamond')
  const [stoneSize, setStoneSize] = useState(5)
  const [stoneCount, setStoneCount] = useState(3)
  const [materialScale, setMaterialScale] = useState(1)
  const [materialRotation, setMaterialRotation] = useState(0)
  const [shapeKind, setShapeKind] = useState<ShapeKind>('circle')
  const [shapeWidthCm, setShapeWidthCm] = useState(12)
  const [shapeHeightCm, setShapeHeightCm] = useState(8)
  const [saveStatus, setSaveStatus] = useState<'loading' | 'saved' | 'saving'>('loading')
  const [installPrompt, setInstallPrompt] = useState<Event | null>(null)
  const [drawingViews, setDrawingViews] = useState<Record<DrawingViewId, DrawingAction[]>>(EMPTY_VIEWS)
  const [activeView, setActiveView] = useState<DrawingViewId>('front')
  const [layers, setLayers] = useState<LayerDefinition[]>(DEFAULT_LAYERS)
  const [activeLayerId, setActiveLayerId] = useState('design')
  const [pencilOnly, setPencilOnly] = useState(false)
  const [showCoverage, setShowCoverage] = useState(false)
  const [coverageMode, setCoverageMode] = useState<CoverageMode>('dance')
  const [layersOpen, setLayersOpen] = useState(false)
  const [previewPlaneId, setPreviewPlaneId] = useState('front')
  const [componentsOpen, setComponentsOpen] = useState(false)
  const [movementOpen, setMovementOpen] = useState(false)
  const [selectedDrawing, setSelectedDrawing] = useState(false)
  const [colorway, setColorway] = useState(0)
  const [drawingReady, setDrawingReady] = useState(false)
  const [activePlaneId, setActivePlaneId] = useState<string>('front')
  const [activePlaneAnchor, setActivePlaneAnchor] = useState<DrawingPlaneAnchor | null>(null)
  const [activePlaneDepth, setActivePlaneDepth] = useState(0)
  const [anchoredPlanes, setAnchoredPlanes] = useState<DrawingPlaneSnapshot[]>([])
  const [projectsOpen, setProjectsOpen] = useState(false)
  const [savedProjects, setSavedProjects] = useState<SavedProjectSummary[]>([])
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null)
  const [projectName, setProjectName] = useState('Untitled Design')
  const [projectBusy, setProjectBusy] = useState(false)
  const importProjectRef = useRef<HTMLInputElement>(null)
  const saveTimer = useRef<number | null>(null)
  const drawingSaveTimer = useRef<number | null>(null)
  const hydrated = useRef(false)

  // create engine once
  useEffect(() => {
    if (!canvasRef.current) return
    const engine = new AtelierEngine(canvasRef.current, {
      onStrokesChange: (count) => {setSurfaceStrokes(count);setSurfaceStoneCount(engineRef.current?.getStoneCount()??0)},
      onDesignChange: (state: AtelierDesignState) => {
        if (!hydrated.current) return
        setSaveStatus('saving')
        if (saveTimer.current) window.clearTimeout(saveTimer.current)
        saveTimer.current = window.setTimeout(() => {
          void saveActiveDesign(state).then(() => setSaveStatus('saved'))
        }, 350)
      },
    })
    engineRef.current = engine
    void loadActiveDesign()
      .then((saved) => {
        if (saved) {
          engine.importState(saved)
          setHeight(saved.heightCm)
          setFabric(saved.fabric.preset)
          setColor(saved.fabric.color)
          setSnapEnabled(saved.settings?.snapEnabled ?? true)
          setOutlinesVisible(saved.settings?.outlinesVisible ?? true)
        }
      })
      .finally(() => {
        hydrated.current = true
        setSaveStatus('saved')
      })
    void loadDrawing().then((saved) => {
      if (Array.isArray(saved)) {
        setDrawingViews({ ...EMPTY_VIEWS, front: saved })
        setStrokes(saved.length)
      } else {
        setDrawingViews(saved.views)
        setActiveView(saved.activeView || 'front')
        setLayers(saved.layers)
        setActiveLayerId(saved.activeLayerId)
        setPencilOnly(saved.pencilOnly)
        setCoverageMode(saved.coverageMode)
        setShowCoverage(saved.showCoverage)
        setActivePlaneId(saved.activePlaneId || 'front')
        setActivePlaneAnchor(saved.activePlaneAnchor ? straightenDrawingPlaneAnchor(saved.activePlaneAnchor) : null)
        setActivePlaneDepth(saved.activePlaneDepth || 0)
        setAnchoredPlanes((saved.anchoredPlanes || []).map((plane)=>({...plane,anchor:straightenDrawingPlaneAnchor(plane.anchor),actions:plane.actions||[],view:plane.view||'front',depth:plane.depth||0})))
        setStrokes(saved.views.front.length)
      }
      setDrawingReady(true)
    })
    return () => {
      if (saveTimer.current) window.clearTimeout(saveTimer.current)
      if (drawingSaveTimer.current) window.clearTimeout(drawingSaveTimer.current)
      if (hydrated.current) void saveActiveDesign(engine.exportState())
      engine.dispose()
      engineRef.current = null
    }
  }, [])

  useEffect(() => {
    void Promise.all([listSavedProjects(), loadActiveProjectId()]).then(([projects, activeId]) => {
      setSavedProjects(projects)
      const active = projects.find((project) => project.id === activeId)
      setActiveProjectId(active?.id || null)
      if (active) setProjectName(active.name)
      else if (activeId) void persistActiveProjectId(null)
    })
  }, [])

  // sync state → engine
  useEffect(() => {
    engineRef.current?.setTool(SURFACE_3D_TOOLS.has(tool)?tool:'move')
  }, [tool])
  useEffect(() => {
    engineRef.current?.setColor(color)
  }, [color])
  useEffect(() => {
    engineRef.current?.setThickness(thickness)
  }, [thickness])
  useEffect(() => {
    engineRef.current?.setBrushSize(brushSizeCm)
  }, [brushSizeCm])
  useEffect(() => {
    engineRef.current?.setMirror(mirror)
  }, [mirror])
  useEffect(() => {
    engineRef.current?.setSnapEnabled(snapEnabled)
  }, [snapEnabled])
  useEffect(() => {
    engineRef.current?.setOutlinesVisible(outlinesVisible)
  }, [outlinesVisible])
  useEffect(() => {
    engineRef.current?.setAutoRotate(autoRotate)
  }, [autoRotate])
  useEffect(() => {
    engineRef.current?.setHeightCm(height)
  }, [height])
  useEffect(() => {
    engineRef.current?.setFabricPreset(fabric)
  }, [fabric])
  useEffect(() => {
    engineRef.current?.setMaterialOptions(materialScale, materialRotation)
  }, [materialScale, materialRotation])
  useEffect(() => {
    engineRef.current?.setStoneOptions(stoneShape, stoneSize, stoneCount)
  }, [stoneShape, stoneSize, stoneCount])
  useEffect(() => {
    engineRef.current?.setShapeKind(shapeKind)
  }, [shapeKind])
  useEffect(() => {
    engineRef.current?.setShapeSize(shapeWidthCm, shapeHeightCm)
  }, [shapeWidthCm, shapeHeightCm])

  useEffect(() => {
    engineRef.current?.setViewPreset(activeView)
  }, [activeView])

  useEffect(()=>{engineRef.current?.setDrawingPlaneHighlight(layersOpen?previewPlaneId:null);return()=>engineRef.current?.setDrawingPlaneHighlight(null)},[layersOpen,previewPlaneId])

  useEffect(() => {
    const onInstall = (event: Event) => {
      event.preventDefault()
      setInstallPrompt(event)
    }
    window.addEventListener('beforeinstallprompt', onInstall)
    return () => window.removeEventListener('beforeinstallprompt', onInstall)
  }, [])

  async function installApp() {
    if (installPrompt) {
      await (installPrompt as Event & { prompt: () => Promise<void> }).prompt()
      setInstallPrompt(null)
      return
    }
    window.alert('On iPad: tap Share, then choose “Add to Home Screen”.')
  }

  function scheduleDrawingSave(
    views: Record<DrawingViewId, DrawingAction[]>,
    nextLayers = layers,
    overrides: Partial<DrawingProject> = {},
  ) {
    setSaveStatus('saving')
    if (drawingSaveTimer.current) window.clearTimeout(drawingSaveTimer.current)
    const project: DrawingProject = { version: 2, views, activeView, layers: nextLayers, activeLayerId, pencilOnly, coverageMode, showCoverage, anchoredPlanes, activePlaneId, activePlaneAnchor, activePlaneDepth, ...overrides }
    drawingSaveTimer.current = window.setTimeout(() => void saveDrawing(project).then(() => setSaveStatus('saved')), 300)
  }

  function syncViewTo3D() {
    const texture = drawingRef.current?.captureTexture()
    if (texture) engineRef.current?.setDrawingViewTexture(activePlaneId, texture, engineRef.current?.getDrawingPlaneAnchor(activePlaneId) || activePlaneAnchor || undefined)
  }

  function attachLiveView() {
    const surface = drawingRef.current?.getSurface()
    if (!surface) return
    engineRef.current?.setLiveDrawingView(activePlaneId, surface, engineRef.current?.getDrawingPlaneAnchor(activePlaneId) || activePlaneAnchor || undefined)
  }

  useEffect(() => {
    if (!drawingReady) return
    for(const plane of anchoredPlanes) engineRef.current?.setDrawingViewTexture(plane.id,plane.image,plane.anchor)
    const frame = window.requestAnimationFrame(() => attachLiveView())
    return () => window.cancelAnimationFrame(frame)
  }, [drawingReady, activeView, activePlaneId])

  function handleDrawingChange(actions: DrawingAction[]) {
    setDrawingViews((current) => {
      const next = { ...current, [activeView]: actions }
      scheduleDrawingSave(next)
      return next
    })
    setStrokes(actions.length)
  }

  function switchView(view: DrawingViewId) {
    let nextViews=drawingViews,nextPlanes=anchoredPlanes
    if(activePlaneId.startsWith('angle-')&&drawingViews[activeView].length){const image=drawingRef.current?.capture(),anchor=engineRef.current?.getDrawingPlaneAnchor(activePlaneId)||activePlaneAnchor;if(image&&anchor){const archiveId=`saved-${Date.now().toString(36)}`;nextPlanes=[...anchoredPlanes,{id:archiveId,image,anchor,actions:structuredClone(drawingViews[activeView]),view:activeView,depth:activePlaneDepth}];nextViews={...drawingViews,[activeView]:[]};engineRef.current?.setDrawingViewTexture(archiveId,image,anchor);engineRef.current?.removeDrawingPlane(activePlaneId);setAnchoredPlanes(nextPlanes);setDrawingViews(nextViews)}}else syncViewTo3D()
    setActiveView(view)
    setActivePlaneId(view)
    setActivePlaneAnchor(null)
    setActivePlaneDepth(0)
    setStrokes(nextViews[view].length)
    setSelectedDrawing(false)
    scheduleDrawingSave(nextViews,layers,{anchoredPlanes:nextPlanes,activePlaneId:view,activePlaneAnchor:null,activePlaneDepth:0})
  }

  function chooseTool(nextTool: Tool) {
    setTool(nextTool)
  }

  function setPlaneDepth(id: string, nextDepth: number) {
    if (id === activePlaneId) {
      const anchor = engineRef.current?.moveDrawingPlaneDepth(id, nextDepth - activePlaneDepth) || activePlaneAnchor
      setActivePlaneDepth(nextDepth)
      setActivePlaneAnchor(anchor || null)
      scheduleDrawingSave(drawingViews, layers, { activePlaneDepth: nextDepth, activePlaneAnchor: anchor || null })
      return
    }
    setAnchoredPlanes((current) => {
      const previous = current.find((plane) => plane.id === id)
      if (!previous) return current
      const anchor = engineRef.current?.moveDrawingPlaneDepth(id, nextDepth - previous.depth) || previous.anchor
      const next = current.map((plane) => plane.id === id ? { ...plane, depth: nextDepth, anchor } : plane)
      scheduleDrawingSave(drawingViews, layers, { anchoredPlanes: next })
      return next
    })
  }

  function previewDrawingPlane(id:string){setPreviewPlaneId(id);engineRef.current?.setDrawingPlaneHighlight(id);engineRef.current?.focusDrawingPlane(id)}

  function openDrawingPlane(plane: DrawingPlaneSnapshot) {
    const currentImage = drawingRef.current?.capture()
    const currentAnchor = engineRef.current?.getDrawingPlaneAnchor(activePlaneId) || activePlaneAnchor
    const currentActions = drawingViews[activeView]
    let nextPlanes = anchoredPlanes.filter((item) => item.id !== plane.id)
    if (currentImage && currentAnchor && currentActions.length && activePlaneId !== plane.id) {
      const currentId = `saved-${Date.now().toString(36)}`
      nextPlanes = [...nextPlanes, { id: currentId, image: currentImage, anchor: currentAnchor, actions: structuredClone(currentActions), view: activeView, depth: activePlaneDepth }]
      engineRef.current?.setDrawingViewTexture(currentId, currentImage, currentAnchor)
      engineRef.current?.removeDrawingPlane(activePlaneId)
    }
    const nextViews = { ...drawingViews, [activeView]: [], [plane.view]: structuredClone(plane.actions) }
    setAnchoredPlanes(nextPlanes)
    setDrawingViews(nextViews)
    setActiveView(plane.view)
    setActivePlaneId(plane.id)
    setActivePlaneAnchor(plane.anchor)
    setActivePlaneDepth(plane.depth)
    setStrokes(plane.actions.length)
    setSelectedDrawing(false)
    setTool('move')
    window.requestAnimationFrame(()=>engineRef.current?.focusDrawingPlane(plane.id))
    setLayersOpen(false)
    scheduleDrawingSave(nextViews, layers, { anchoredPlanes: nextPlanes, activePlaneId: plane.id, activePlaneAnchor: plane.anchor, activePlaneDepth: plane.depth })
  }

  function updateLayers(next: LayerDefinition[]) {
    setLayers(next)
    scheduleDrawingSave(drawingViews, next)
  }

  function addGarmentTemplate(template: GarmentTemplate) {
    drawingRef.current?.addTemplate(template)
    setComponentsOpen(false)
  }

  function currentDrawingProject(): DrawingProject {
    const anchor = engineRef.current?.getDrawingPlaneAnchor(activePlaneId) || activePlaneAnchor
    return { version: 2, views: drawingViews, activeView, layers, activeLayerId, pencilOnly, coverageMode, showCoverage, anchoredPlanes, activePlaneId, activePlaneAnchor: anchor, activePlaneDepth }
  }

  async function saveWorkingCopy() {
    const engine = engineRef.current
    if (!engine) return null
    setSaveStatus('saving')
    if (drawingSaveTimer.current) window.clearTimeout(drawingSaveTimer.current)
    if (saveTimer.current) window.clearTimeout(saveTimer.current)
    const design = engine.exportState()
    const drawing = currentDrawingProject()
    await Promise.all([saveDrawing(drawing), saveActiveDesign(design)])
    setSaveStatus('saved')
    return { design, drawing }
  }

  async function refreshProjectLibrary() {
    const projects = await listSavedProjects()
    setSavedProjects(projects)
    return projects
  }

  async function openProjectLibrary() {
    await refreshProjectLibrary()
    setProjectsOpen(true)
  }

  async function saveProjectAsNew() {
    if (projectBusy || !projectName.trim()) return
    setProjectBusy(true)
    try {
      const snapshot = await saveWorkingCopy()
      if (!snapshot) return
      const saved = await saveNamedProject(projectName, snapshot.design, snapshot.drawing)
      setActiveProjectId(saved.id)
      setProjectName(saved.name)
      await persistActiveProjectId(saved.id)
      await refreshProjectLibrary()
    } finally {
      setProjectBusy(false)
    }
  }

  async function saveNow() {
    if (projectBusy) return
    setProjectBusy(true)
    try {
      const snapshot = await saveWorkingCopy()
      if (!snapshot) return
      if (!activeProjectId) {
        await openProjectLibrary()
        return
      }
      const current = savedProjects.find((project) => project.id === activeProjectId)
      const saved = await saveNamedProject(current?.name || projectName, snapshot.design, snapshot.drawing, activeProjectId)
      setProjectName(saved.name)
      await refreshProjectLibrary()
    } finally {
      setProjectBusy(false)
    }
  }

  function applyDrawingProject(project: DrawingProject) {
    const nextView = project.activeView || 'front'
    const nextPlanes = (project.anchoredPlanes || []).map((plane) => ({ ...plane, anchor: straightenDrawingPlaneAnchor(plane.anchor), actions: plane.actions || [], view: plane.view || 'front', depth: plane.depth || 0 }))
    engineRef.current?.clearDrawingPlanes()
    setDrawingViews(project.views)
    setActiveView(nextView)
    setLayers(project.layers || DEFAULT_LAYERS)
    setActiveLayerId(project.activeLayerId || 'design')
    setPencilOnly(Boolean(project.pencilOnly))
    setCoverageMode(project.coverageMode || 'dance')
    setShowCoverage(Boolean(project.showCoverage))
    setActivePlaneId(project.activePlaneId || nextView)
    setActivePlaneAnchor(project.activePlaneAnchor ? straightenDrawingPlaneAnchor(project.activePlaneAnchor) : null)
    setActivePlaneDepth(project.activePlaneDepth || 0)
    setAnchoredPlanes(nextPlanes)
    setStrokes(project.views[nextView]?.length || 0)
    setSelectedDrawing(false)
    for (const plane of nextPlanes) engineRef.current?.setDrawingViewTexture(plane.id, plane.image, plane.anchor)
    window.requestAnimationFrame(() => {
      const surface = drawingRef.current?.getSurface()
      if (surface) engineRef.current?.setLiveDrawingView(project.activePlaneId || nextView, surface, project.activePlaneAnchor || undefined)
    })
  }

  async function loadProjectFile(id: string) {
    if (projectBusy) return
    setProjectBusy(true)
    try {
      if (activeProjectId && activeProjectId !== id) {
        const currentSnapshot = await saveWorkingCopy()
        const currentFile = savedProjects.find((project) => project.id === activeProjectId)
        if (currentSnapshot && currentFile) {
          await saveNamedProject(currentFile.name, currentSnapshot.design, currentSnapshot.drawing, activeProjectId)
        }
      } else if (!activeProjectId && (surfaceStrokes > 0 || strokes > 0)) {
        const replaceDraft = window.confirm('This draft is not saved as a named project. Load another file and replace the draft?')
        if (!replaceDraft) return
      }
      const project = await loadSavedProject(id)
      if (!project) return
      hydrated.current = false
      engineRef.current?.importState(project.design)
      setHeight(project.design.heightCm)
      setFabric(project.design.fabric.preset)
      setColor(project.design.fabric.color)
      setSnapEnabled(project.design.settings?.snapEnabled ?? true)
      setOutlinesVisible(project.design.settings?.outlinesVisible ?? true)
      applyDrawingProject(project.drawing)
      window.requestAnimationFrame(() => engineRef.current?.importState(project.design))
      setActiveProjectId(project.id)
      setProjectName(project.name)
      await Promise.all([
        saveActiveDesign(project.design),
        saveDrawing(project.drawing),
        persistActiveProjectId(project.id),
      ])
      hydrated.current = true
      setSaveStatus('saved')
      setProjectsOpen(false)
    } finally {
      hydrated.current = true
      setProjectBusy(false)
    }
  }

  function exportProjectFile(project: SavedAtelierProject) {
    const blob = new Blob([JSON.stringify(project, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const safeName = project.name.trim().replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase() || 'eden-velvet-design'
    triggerDownload(url, `${safeName}.eden.json`)
    window.setTimeout(() => URL.revokeObjectURL(url), 1000)
  }

  async function exportSavedProject(id: string) {
    const project = await loadSavedProject(id)
    if (project) exportProjectFile(project)
  }

  async function importProjectFile(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file || projectBusy) return
    setProjectBusy(true)
    try {
      const parsed: unknown = JSON.parse(await file.text())
      if (!isSavedAtelierProject(parsed)) throw new Error('invalid-project')
      const imported = await saveNamedProject(parsed.name, parsed.design, parsed.drawing)
      await refreshProjectLibrary()
      setProjectBusy(false)
      await loadProjectFile(imported.id)
    } catch {
      window.alert('This is not a valid Eden Velvet project file.')
    } finally {
      setProjectBusy(false)
    }
  }

  async function removeProjectFile(project: SavedProjectSummary) {
    if (!window.confirm(`Delete “${project.name}” from saved projects?`)) return
    await deleteSavedProject(project.id)
    if (activeProjectId === project.id) {
      setActiveProjectId(null)
      setProjectName('Untitled Design')
      await persistActiveProjectId(null)
    }
    await refreshProjectLibrary()
  }

  async function newDesign() {
    if(!window.confirm('Start a new blank design? Your named project files will remain saved.'))return
    drawingRef.current?.clear()
    if(drawingSaveTimer.current)window.clearTimeout(drawingSaveTimer.current)
    const views:Record<DrawingViewId,DrawingAction[]>={front:[],back:[],left:[],right:[]},engine=engineRef.current
    engine?.clearDrawingPlanes();engine?.clearAll();engine?.resetFabric();engine?.setViewPreset('front')
    setDrawingViews(views);setAnchoredPlanes([]);setActiveView('front');setActivePlaneId('front');setActivePlaneAnchor(null);setActivePlaneDepth(0);setStrokes(0);setSelectedDrawing(false);setTool('move');setFabric('matte');setActiveProjectId(null);setProjectName('Untitled Design')
    await persistActiveProjectId(null)
    setSaveStatus('saving')
    const project:DrawingProject={version:2,views,activeView:'front',layers,activeLayerId,pencilOnly,coverageMode,showCoverage,anchoredPlanes:[],activePlaneId:'front',activePlaneAnchor:null,activePlaneDepth:0}
    if(engine)await Promise.all([saveDrawing(project),saveActiveDesign(engine.exportState())]);else await saveDrawing(project)
    window.requestAnimationFrame(()=>{const surface=drawingRef.current?.getSurface();if(surface)engineRef.current?.setLiveDrawingView('front',surface)})
    setSaveStatus('saved')
  }

  function triggerDownload(url: string, name: string) {
    const a = document.createElement('a')
    a.href = url
    a.download = name
    document.body.appendChild(a)
    a.click()
    a.remove()
  }

  async function saveView() {
    const eng = engineRef.current
    if (!eng) return
    const baseUrl = eng.capturePNG()
    const drawingUrl = drawingRef.current?.capture()
    if (!drawingUrl) return triggerDownload(baseUrl, 'eden-velvet-look.png')
    const [base, drawing] = await Promise.all([baseUrl, drawingUrl].map((url) => new Promise<HTMLImageElement>((resolve) => {
      const image = new Image(); image.onload = () => resolve(image); image.src = url
    })))
    const composed = document.createElement('canvas')
    composed.width = base.naturalWidth
    composed.height = base.naturalHeight
    const ctx = composed.getContext('2d')!
    ctx.drawImage(base, 0, 0, composed.width, composed.height)
    ctx.drawImage(drawing, 0, 0, composed.width, composed.height)
    triggerDownload(composed.toDataURL('image/png'), 'eden-velvet-look.png')
  }

  async function makeCard() {
    const eng = engineRef.current
    if (!eng || cardBusy) return
    setCardBusy(true)
    try {
      const views = await eng.captureCardViews()
      const url = await composeDesignCard({
        views,
        measurements: eng.getMeasurements(),
        baseColor: eng.getFabricColor(),
        strokeColors: eng.getStrokeColors(),
        date: new Date()
          .toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })
          .toUpperCase(),
      })
      setCardUrl(url)
    } finally {
      setCardBusy(false)
    }
  }

  const meas = {
    height,
    bust: Math.round(height * 0.53),
    waist: Math.round(height * 0.4),
    hip: Math.round(height * 0.55),
  }
  const placedStoneCount = drawingViews[activeView]
    .filter((action): action is Extract<DrawingAction, { kind: 'stones' }> => action.kind === 'stones')
    .reduce((total, action) => total + action.points.length * action.count * (action.mirror ? 2 : 1), 0)
  const hasStonePlacement = drawingViews[activeView].some((action) => action.kind === 'stones')

  const iconBtn = (active: boolean): React.CSSProperties => ({
    width: 44,
    height: 44,
    borderRadius: 14,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: active ? GOLD : 'rgba(22,19,15,0.72)',
    color: active ? CHARCOAL : '#efe7da',
    border: active ? 'none' : '1px solid rgba(239,231,218,0.14)',
    backdropFilter: 'blur(8px)',
    WebkitBackdropFilter: 'blur(8px)',
  })

  return (
    <div className="fixed inset-0 overflow-hidden select-none" style={{ background: CHARCOAL }}>
      {/* 3D canvas */}
      <div className="absolute inset-0">
        <canvas
          ref={canvasRef}
          className="h-full w-full"
          style={{ touchAction: 'none', WebkitTouchCallout: 'none', display: 'block' }}
        />
      </div>

      {drawingReady && (
        <DrawingCanvas
          ref={drawingRef}
          tool={tool}
          color={color}
          thickness={thickness}
          mirror={mirror}
          shapeKind={shapeKind}
          stoneShape={stoneShape}
          stoneSize={stoneSize}
          stoneCount={stoneCount}
          fabric={fabric}
          materialScale={materialScale}
          materialRotation={materialRotation}
          mapPoint={(clientX, clientY) => engineRef.current?.screenToDrawingPoint(activePlaneId, clientX, clientY) ?? null}
          onSurfaceChange={() => engineRef.current?.markDrawingViewDirty(activePlaneId)}
          passthrough3D={SURFACE_3D_TOOLS.has(tool)}
          activeLayerId={activeLayerId}
          layers={layers}
          pencilOnly={pencilOnly}
          showCoverage={showCoverage}
          coverageMode={coverageMode}
          heightCm={height}
          initialActions={drawingViews[activeView]}
          onChange={handleDrawingChange}
          onSelectionChange={setSelectedDrawing}
        />
      )}

      {/* measurement rulers (top + left), live with zoom */}
      <Rulers engineRef={engineRef} />

      {/* top bar */}
      <div
        className="absolute left-0 right-0 top-0 flex items-center justify-between px-4"
        style={{ paddingTop: 'calc(env(safe-area-inset-top) + 10px)', zIndex: 10 }}
      >
        <div className="brand-lockup">
          <div className="brand-monogram">EV</div>
          <div className="min-w-0">
            <div className="brand-name">EDEN VELVET</div>
            <div className="brand-status"><Save size={9} /> {saveStatus === 'loading' ? 'RESUMING…' : saveStatus === 'saving' ? 'SAVING…' : activeProjectId ? `SAVED · ${projectName}` : 'AUTOSAVED DRAFT'}</div>
          </div>
        </div>
        <div className="top-actions flex gap-2">
          <button className="studio-top-action" aria-label="Save project now" onClick={()=>void saveNow()}><Save size={17}/><span>SAVE</span></button>
          <button className="studio-top-action" aria-label="Open saved project files" onClick={()=>void openProjectLibrary()}><FolderOpen size={17}/><span>FILES</span></button>
          <button className="studio-top-action" aria-label="Start a new design and clear all" onClick={()=>void newDesign()}><FilePlus2 size={17}/><span>NEW</span></button>
          <button aria-label="Layers" style={iconBtn(layersOpen)} onClick={() => {setPreviewPlaneId(activePlaneId);setLayersOpen(true)}}><Layers size={20} /></button>
          <button
            className="studio-top-action outline-toggle"
            aria-label={outlinesVisible ? 'Hide pencil lines and show fills only' : 'Show pencil lines'}
            aria-pressed={!outlinesVisible}
            onClick={() => setOutlinesVisible((visible) => !visible)}
          >
            {outlinesVisible ? <EyeOff size={18}/> : <Eye size={18}/>}<span>{outlinesVisible ? 'FILLS ONLY' : 'SHOW LINES'}</span>
          </button>
          <button aria-label="Garment components" style={iconBtn(componentsOpen)} onClick={() => setComponentsOpen(true)}><Scissors size={20} /></button>
          <button aria-label="Dancer and movement checks" style={iconBtn(movementOpen)} onClick={() => setMovementOpen(true)}><Activity size={20} /></button>
          <button aria-label="Fabrics and materials" style={iconBtn(materialsOpen)} onClick={() => setMaterialsOpen(true)}>
            <Shirt size={20} />
          </button>
          <button className="mobile-optional" aria-label="Add app to home screen" style={iconBtn(false)} onClick={installApp}>
            <Smartphone size={20} />
          </button>
          <button className="mobile-optional" aria-label="Size & measurements" style={iconBtn(sizeOpen)} onClick={() => setSizeOpen(true)}>
            <Ruler size={20} />
          </button>
          <button
            aria-label="Undo"
            style={{ ...iconBtn(false), opacity: strokes === 0 && surfaceStrokes === 0 ? 0.4 : 1 }}
            disabled={strokes === 0 && surfaceStrokes === 0}
            onClick={() => surfaceStrokes>0?engineRef.current?.undo():drawingRef.current?.undo()}
          >
            <Undo2 size={20} />
          </button>
          <button className="desktop-action" aria-label="Redo" style={iconBtn(false)} onClick={() => drawingRef.current?.redo()}><Redo2 size={20} /></button>
          <button
            className="desktop-action"
            aria-label="Clear all"
            style={{ ...iconBtn(false), opacity: strokes === 0 ? 0.4 : 1 }}
            disabled={strokes === 0}
            onClick={() => {
                  if (window.confirm('Remove all drawing, fills and stones?')) {drawingRef.current?.clear();engineRef.current?.clearAll()}
            }}
          >
            <Trash2 size={20} />
          </button>
          <button className="desktop-action" aria-label="Save view" style={iconBtn(false)} onClick={saveView}>
            <Camera size={20} />
          </button>
          <button className="desktop-action" aria-label="Design card" style={iconBtn(false)} onClick={makeCard}>
            <LayoutGrid size={20} />
          </button>
        </div>
      </div>

      <div className="view-strip absolute left-1/2 top-0 z-10 flex -translate-x-1/2 items-center gap-1" style={{ marginTop: 'calc(env(safe-area-inset-top) + 68px)' }}>
        {(['front','right','back','left'] as DrawingViewId[]).map((view) => (
          <button key={view} data-active={activeView === view} onClick={() => switchView(view)}>{view.toUpperCase()}</button>
        ))}
        <span className="view-divider" />
        {[
          ['#8e1f2f','#c9a96a'],['#111111','#e8a2b4'],['#e9e2d8','#7c93ab']
        ].map((colors,index)=><button key={index} className="colorway-dot" data-active={colorway===index} aria-label={`Colorway ${index+1}`} style={{background:`linear-gradient(135deg,${colors[0]} 50%,${colors[1]} 50%)`}} onClick={()=>{setColorway(index);setColor(colors[0])}} />)}
      </div>

      {/* zoom controls */}
      <div
        className="zoom-controls absolute right-3 flex flex-col gap-2"
        style={{ top: '50%', transform: 'translateY(-50%)', zIndex: 10 }}
      >
        <button aria-label="Zoom in" style={iconBtn(false)} onClick={() => engineRef.current?.zoomBy(0.64)}>
          <ZoomIn size={20} />
        </button>
        <button aria-label="Zoom out" style={iconBtn(false)} onClick={() => engineRef.current?.zoomBy(1.28)}>
          <ZoomOut size={20} />
        </button>
        <button aria-label="Reset view" style={iconBtn(false)} onClick={() => engineRef.current?.resetView()}>
          <RotateCcw size={20} />
        </button>
        <button
          aria-label="Auto rotate"
          style={iconBtn(autoRotate)}
          onClick={() => setAutoRotate((v) => !v)}
        >
          <RefreshCw size={20} />
        </button>
      </div>

      {/* bottom area */}
      <div
        className="absolute bottom-0 left-0 right-0"
        style={{ paddingBottom: 'calc(env(safe-area-inset-bottom) + 10px)', zIndex: 10 }}
      >
        {/* contextual panel */}
        {tool !== 'move' && (
          <div
            className="mx-3 mb-3 rounded-2xl p-3"
            style={{
              background: 'rgba(22,19,15,0.78)',
              border: '1px solid rgba(239,231,218,0.12)',
              backdropFilter: 'blur(10px)',
              WebkitBackdropFilter: 'blur(10px)',
            }}
          >
            {tool !== 'eraser' && (
              <div className="mb-2 flex items-center gap-2 overflow-x-auto" style={{ scrollbarWidth: 'none' }}>
                {PALETTE.map((c) => (
                  <button
                    key={c}
                    aria-label={`Color ${c}`}
                    onClick={() => setColor(c)}
                    style={{
                      flex: '0 0 auto',
                      width: 34,
                      height: 34,
                      borderRadius: '50%',
                      background: c,
                      border: color === c ? `3px solid ${GOLD}` : '2px solid rgba(239,231,218,0.25)',
                      boxSizing: 'border-box',
                    }}
                  />
                ))}
                <label
                  style={{
                    flex: '0 0 auto',
                    width: 34,
                    height: 34,
                    borderRadius: '50%',
                    border: '2px dashed rgba(239,231,218,0.4)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    color: '#efe7da',
                    fontSize: 18,
                    overflow: 'hidden',
                    position: 'relative',
                  }}
                >
                  +
                  <input
                    type="color"
                    value={color}
                    onChange={(e) => setColor(e.target.value)}
                    style={{ position: 'absolute', inset: 0, opacity: 0 }}
                  />
                </label>
              </div>
            )}

            {(tool === 'pencil' || tool === 'spray') && (
              <div className="flex flex-wrap items-center gap-3">
                <span style={{ color: 'rgba(239,231,218,0.6)', fontSize: 11, letterSpacing: '0.1em' }}>
                  SIZE
                </span>
                <input
                  type="range"
                  min={1}
                  max={10}
                  step={1}
                  value={thickness}
                  onChange={(e) => setThickness(Number(e.target.value))}
                  style={{ flex: '1 1 120px', accentColor: GOLD, height: 32 }}
                />
                <button
                  aria-label="Mirror"
                  style={{ ...iconBtn(mirror), width: 40, height: 40 }}
                  onClick={() => setMirror((v) => !v)}
                >
                  <FlipHorizontal2 size={18} />
                </button>
                {tool === 'pencil' && (
                  <button
                    className="option-chip"
                    data-active={snapEnabled}
                    aria-pressed={snapEnabled}
                    onClick={() => setSnapEnabled((enabled) => !enabled)}
                  >
                    SNAP {snapEnabled ? 'ON' : 'OFF'}
                  </button>
                )}
                <button className="option-chip" data-active={pencilOnly} onClick={() => { const next = !pencilOnly; setPencilOnly(next); scheduleDrawingSave(drawingViews, layers, { pencilOnly: next }) }}>PENCIL ONLY</button>
              </div>
            )}

            {tool === 'brush' && (
              <div className="brush-controls">
                <div className="brush-size-label"><span>PAINTBRUSH SIZE</span><strong>{brushSizeCm} cm</strong></div>
                <input aria-label="Paintbrush size in centimetres" type="range" min={1} max={30} step={1} value={brushSizeCm} onChange={(event)=>setBrushSizeCm(Number(event.target.value))}/>
                <div className="brush-size-presets">
                  {[4,8,16,24].map((size)=><button key={size} className="option-chip" data-active={brushSizeCm===size} onClick={()=>setBrushSizeCm(size)}>{size} CM</button>)}
                </div>
                <div className="tool-subhint">{TOOL_HINTS.brush}</div>
              </div>
            )}

            {tool === 'stone' && (
              <div>
                <div className="mb-2 flex gap-2 overflow-x-auto">
                  {(['round', 'diamond', 'square', 'teardrop'] as StoneShape[]).map((shape) => (
                    <button key={shape} onClick={() => setStoneShape(shape)} className="option-chip" data-active={stoneShape === shape}>
                      {shape.toUpperCase()}
                    </button>
                  ))}
                </div>
                <div className="grid grid-cols-[auto_1fr_auto] items-center gap-3">
                  <span className="control-label">STONE {stoneSize} mm</span>
                  <input type="range" min={2} max={14} value={stoneSize} onChange={(e) => setStoneSize(Number(e.target.value))} style={{ accentColor: GOLD, height: 32 }} />
                  <label className="count-control">× <select aria-label="Stones per dab" value={stoneCount} onChange={(e) => setStoneCount(Number(e.target.value))}>{[1, 2, 3, 5, 8, 12].map((n) => <option key={n}>{n}</option>)}</select></label>
                </div>
                <div className="stone-actions"><div className="stone-counter"><Gem size={13}/> {(surfaceStoneCount||placedStoneCount).toLocaleString()} stones in 3D</div><button disabled={!hasStonePlacement&&surfaceStoneCount===0} onClick={()=>{if(surfaceStoneCount)engineRef.current?.duplicateLastStones();else drawingRef.current?.duplicateLastStones()}}><Copy size={14}/> DUPLICATE LAST</button></div>
              </div>
            )}

            {tool === 'shape' && (
              <div className="shape-controls">
                <div className="flex items-center gap-2">
                  {([
                    ['circle', Circle],
                    ['square', Square],
                    ['rectangle', Shapes],
                  ] as Array<[ShapeKind, typeof Circle]>).map(([kind, Icon]) => (
                    <button key={kind} onClick={() => setShapeKind(kind)} className="option-chip flex flex-1 items-center justify-center gap-2" data-active={shapeKind === kind}>
                      <Icon size={16} /> {kind.toUpperCase()}
                    </button>
                  ))}
                </div>
                <div className="shape-size-grid">
                  <label><span>{shapeKind === 'circle' ? 'DIAMETER' : 'WIDTH'} <b>{shapeWidthCm} cm</b></span><input aria-label="Shape width in centimetres" type="range" min={2} max={60} step={1} value={shapeWidthCm} onChange={(event)=>setShapeWidthCm(Number(event.target.value))}/></label>
                  {shapeKind === 'rectangle' && <label><span>HEIGHT <b>{shapeHeightCm} cm</b></span><input aria-label="Shape height in centimetres" type="range" min={2} max={60} step={1} value={shapeHeightCm} onChange={(event)=>setShapeHeightCm(Number(event.target.value))}/></label>}
                </div>
              </div>
            )}

            {tool === 'fill' && (
              <div className="surface-fill-controls">
                <div className="surface-fill-copy"><strong>SURFACE FILL</strong><span>{TOOL_HINTS.fill}</span></div>
                <div className="active-fabric-chip"><span className="active-fabric-dot" style={{background:color}}/><span>{fabric === 'matte' ? 'STRETCH JERSEY' : fabric.toUpperCase()}</span></div>
                <button
                  onClick={() => setMaterialsOpen(true)}
                  className="choose-fabric-button"
                >
                  CHANGE FABRIC
                </button>
              </div>
            )}

            {tool === 'eraser' && (
              <div style={{ color: 'rgba(239,231,218,0.6)', fontSize: 12 }}>{TOOL_HINTS.eraser}</div>
            )}

            {tool === 'pencil' && (
              <div style={{ color: 'rgba(239,231,218,0.45)', fontSize: 11, marginTop: 6 }}>
                {TOOL_HINTS.pencil}
              </div>
            )}
            {tool === 'spray' && (
              <div style={{ color: 'rgba(239,231,218,0.45)', fontSize: 11, marginTop: 6 }}>
                {TOOL_HINTS.spray}
              </div>
            )}
            {(tool === 'stone' || tool === 'shape') && (
              <div style={{ color: 'rgba(239,231,218,0.45)', fontSize: 11, marginTop: 6 }}>{TOOL_HINTS[tool]}</div>
            )}
            {tool === 'measure' && <div style={{ color: 'rgba(239,231,218,0.6)', fontSize: 12 }}>{TOOL_HINTS.measure}</div>}
            {tool === 'select' && (
              <div className="selection-tools">
                <span className="control-label">{selectedDrawing ? 'ITEM SELECTED' : 'TAP AN ITEM'}</span>
                <button disabled={!selectedDrawing} onClick={() => drawingRef.current?.scaleSelected(.9)}><Minus size={16} /> SIZE</button>
                <button disabled={!selectedDrawing} onClick={() => drawingRef.current?.scaleSelected(1.1)}><Plus size={16} /> SIZE</button>
                <button disabled={!selectedDrawing} onClick={() => drawingRef.current?.rotateSelected(Math.PI/12)}><RotateCw size={16} /></button>
                <button disabled={!selectedDrawing} onClick={() => drawingRef.current?.duplicateSelected()}><Copy size={16} /></button>
                <button disabled={!selectedDrawing} onClick={() => drawingRef.current?.deleteSelected()}><Trash2 size={16} /></button>
              </div>
            )}
          </div>
        )}

        {tool === 'move' && (
          <div className="mb-2 text-center" style={{ color: 'rgba(239,231,218,0.5)', fontSize: 12 }}>
            {TOOL_HINTS.move}
          </div>
        )}

        {/* tool dock */}
        <div className="tool-dock mx-3 flex gap-2 overflow-x-auto">
          {TOOLS.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              aria-label={label}
              onClick={() => chooseTool(id)}
              style={{
                flex: '0 0 64px',
                height: 58,
                borderRadius: 18,
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 3,
                background: tool === id ? GOLD : 'rgba(22,19,15,0.78)',
                color: tool === id ? CHARCOAL : '#efe7da',
                border: tool === id ? 'none' : '1px solid rgba(239,231,218,0.12)',
                backdropFilter: 'blur(10px)',
                WebkitBackdropFilter: 'blur(10px)',
              }}
            >
              <Icon size={21} />
              <span style={{ fontSize: 9, letterSpacing: '0.08em' }}>{label.toUpperCase()}</span>
            </button>
          ))}
        </div>
      </div>

      {projectsOpen && (
        <div className="absolute inset-0 z-30 flex items-end sheet-backdrop" onClick={() => setProjectsOpen(false)}>
          <div className="studio-sheet project-sheet w-full rounded-t-3xl p-5" onClick={(event) => event.stopPropagation()}>
            <div className="sheet-header">
              <div><div className="sheet-title">PROJECT FILES</div><div className="sheet-subtitle">Save separate designs · load them later · move them between devices</div></div>
              <button aria-label="Close project files" style={iconBtn(false)} onClick={() => setProjectsOpen(false)}><X size={18}/></button>
            </div>
            <div className="project-create">
              <label><span>DESIGN NAME</span><input value={projectName} maxLength={80} onChange={(event) => setProjectName(event.target.value)} placeholder="Competition dress 1" /></label>
              <button disabled={projectBusy || !projectName.trim()} onClick={() => void saveProjectAsNew()}><FilePlus2 size={17}/> SAVE AS NEW</button>
              <button disabled={projectBusy} onClick={() => importProjectRef.current?.click()}><Upload size={17}/> IMPORT FILE</button>
              <input ref={importProjectRef} className="sr-only" type="file" accept=".json,.eden.json,application/json" onChange={(event) => void importProjectFile(event)} />
            </div>
            <div className="project-note">Autosave protects the current draft. Save updates the current named file; Save as New creates a separate copy. The current file is safely updated before loading another.</div>
            <div className="project-list">
              {savedProjects.length === 0 && <div className="project-empty"><FolderOpen size={24}/><strong>No named projects yet</strong><small>Enter a name above and choose Save as New.</small></div>}
              {savedProjects.map((project) => (
                <div className="project-row" data-active={activeProjectId === project.id} key={project.id}>
                  <div className="project-file-icon"><FolderOpen size={20}/></div>
                  <div className="project-details"><strong>{project.name}</strong><small>{activeProjectId === project.id ? 'CURRENT FILE · ' : ''}{new Date(project.updatedAt).toLocaleString()}</small></div>
                  <div className="project-actions">
                    <button disabled={projectBusy} onClick={() => void loadProjectFile(project.id)}>LOAD</button>
                    <button disabled={projectBusy} aria-label={`Export ${project.name}`} onClick={() => void exportSavedProject(project.id)}><FileDown size={16}/></button>
                    <button disabled={projectBusy} aria-label={`Delete ${project.name}`} onClick={() => void removeProjectFile(project)}><Trash2 size={16}/></button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {layersOpen && (
        <div className="layers-backdrop absolute inset-0 z-20 flex items-end" onClick={() => setLayersOpen(false)}>
          <div className="studio-sheet layers-sheet w-full rounded-t-3xl p-5" onClick={(e)=>e.stopPropagation()}>
            <div className="sheet-header"><div><div className="sheet-title">DRAWING LAYERS</div><div className="sheet-subtitle">{activeView.toUpperCase()} VIEW · tap a layer to draw into it</div></div><button aria-label="Close layers" style={iconBtn(false)} onClick={()=>setLayersOpen(false)}><X size={18}/></button></div>
            <div className="canvas-layer-section">
              <div className="canvas-layer-heading"><span>3D DRAWING CANVASES</span><small>Select a canvas, set its depth, or return the camera to it</small></div>
              <div className="canvas-layer-row" data-active="true">
                <button className="canvas-focus" aria-label="Move camera to active drawing canvas" onClick={()=>previewDrawingPlane(activePlaneId)}><Camera size={17}/></button>
                <div><strong>Current canvas</strong><small>{activeView.toUpperCase()} · EDITING</small></div>
                <label><span>DEPTH {activePlaneDepth>0?'+':''}{activePlaneDepth} cm</span><input aria-label="Current canvas depth" type="range" min={-30} max={40} step={1} value={activePlaneDepth} onFocus={()=>previewDrawingPlane(activePlaneId)} onPointerDown={()=>previewDrawingPlane(activePlaneId)} onChange={(event)=>setPlaneDepth(activePlaneId,Number(event.target.value))}/></label>
              </div>
              {anchoredPlanes.map((plane,index)=><div key={plane.id} className="canvas-layer-row">
                <button className="canvas-focus" aria-label={`Move camera to canvas ${index+1}`} onClick={()=>previewDrawingPlane(plane.id)}><Camera size={17}/></button>
                <button className="canvas-open" onClick={()=>openDrawingPlane(plane)}><strong>Canvas {index+1}</strong><small>{plane.view.toUpperCase()} · {plane.actions.length} items</small></button>
                <label><span>DEPTH {plane.depth>0?'+':''}{plane.depth} cm</span><input aria-label={`Canvas ${index+1} depth`} type="range" min={-30} max={40} step={1} value={plane.depth} onFocus={()=>previewDrawingPlane(plane.id)} onPointerDown={()=>previewDrawingPlane(plane.id)} onChange={(event)=>setPlaneDepth(plane.id,Number(event.target.value))}/></label>
              </div>)}
            </div>
            <div className="layer-list">
              {[...layers].reverse().map((layer)=><div key={layer.id} className="layer-row" role="button" tabIndex={0} data-active={activeLayerId===layer.id} onKeyDown={(event)=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();setActiveLayerId(layer.id);scheduleDrawingSave(drawingViews,layers,{activeLayerId:layer.id})}}} onClick={()=>{setActiveLayerId(layer.id);scheduleDrawingSave(drawingViews,layers,{activeLayerId:layer.id})}}>
                <button aria-label={layer.visible?'Hide layer':'Show layer'} onClick={(e)=>{e.stopPropagation();updateLayers(layers.map((item)=>item.id===layer.id?{...item,visible:!item.visible}:item))}}>{layer.visible?<Eye size={18}/>:<EyeOff size={18}/>}</button>
                <div className="layer-thumb"><Layers size={17}/></div><input className="layer-name-input" aria-label={`Rename ${layer.name} layer`} value={layer.name} onClick={(event)=>event.stopPropagation()} onChange={(event)=>updateLayers(layers.map((item)=>item.id===layer.id?{...item,name:event.target.value}:item))}/>
                <input aria-label={`${layer.name} opacity`} type="range" min={.1} max={1} step={.1} value={layer.opacity} onClick={(e)=>e.stopPropagation()} onChange={(e)=>updateLayers(layers.map((item)=>item.id===layer.id?{...item,opacity:Number(e.target.value)}:item))}/>
                <button aria-label={layer.locked?'Unlock layer':'Lock layer'} onClick={(e)=>{e.stopPropagation();updateLayers(layers.map((item)=>item.id===layer.id?{...item,locked:!item.locked}:item))}}>{layer.locked?<Lock size={17}/>:<Unlock size={17}/>}</button>
              </div>)}
            </div>
          </div>
        </div>
      )}

      {componentsOpen && (
        <div className="absolute inset-0 z-20 flex items-end sheet-backdrop" onClick={()=>setComponentsOpen(false)}>
          <div className="studio-sheet w-full rounded-t-3xl p-5" onClick={(e)=>e.stopPropagation()}>
            <div className="sheet-header"><div><div className="sheet-title">PERFORMANCEWEAR BLOCKS</div><div className="sheet-subtitle">Editable starting shapes for dancewear and lingerie</div></div><button aria-label="Close components" style={iconBtn(false)} onClick={()=>setComponentsOpen(false)}><X size={18}/></button></div>
            <div className="component-grid">
              {([['bodice','Bodice'],['corset','Corset'],['cups','Bra cups'],['straps','Straps'],['sleeves','Sleeves'],['gloves','Long gloves'],['brief','Brief'],['stockings','Stockings'],['catsuit','Catsuit'],['skirt','Short skirt'],['longDress','Long dress'],['fringe','Fringe belt'],['feathers','Feather bustle']] as Array<[GarmentTemplate,string]>).map(([id,label])=><button key={id} onClick={()=>addGarmentTemplate(id)}><span className="component-icon"><Scissors size={20}/></span><strong>{label}</strong><small>Add to {layers.find((layer)=>layer.id===activeLayerId)?.name}</small></button>)}
            </div>
          </div>
        </div>
      )}

      {movementOpen && (
        <div className="absolute inset-0 z-20 flex items-end sheet-backdrop" onClick={()=>setMovementOpen(false)}>
          <div className="studio-sheet w-full rounded-t-3xl p-5" onClick={(e)=>e.stopPropagation()}>
            <div className="sheet-header"><div><div className="sheet-title">DANCER CHECK</div><div className="sheet-subtitle">Views, coverage and movement-sensitive areas</div></div><button aria-label="Close dancer checks" style={iconBtn(false)} onClick={()=>setMovementOpen(false)}><X size={18}/></button></div>
            <div className="movement-grid">
              <section><h3>VIEW SHEETS</h3><div className="chip-grid">{(['front','right','back','left'] as DrawingViewId[]).map((view)=><button key={view} data-active={activeView===view} onClick={()=>switchView(view)}>{view.toUpperCase()}</button>)}</div></section>
              <section><h3>COVERAGE GUIDE</h3><label className="switch-row"><ShieldCheck size={18}/><span>Show safe coverage zone</span><input type="checkbox" checked={showCoverage} onChange={(e)=>{const next=e.target.checked;setShowCoverage(next);scheduleDrawingSave(drawingViews,layers,{showCoverage:next})}}/></label><div className="chip-grid">{(['dance','lingerie','competition'] as CoverageMode[]).map((mode)=><button key={mode} data-active={coverageMode===mode} onClick={()=>{setCoverageMode(mode);scheduleDrawingSave(drawingViews,layers,{coverageMode:mode})}}>{mode.toUpperCase()}</button>)}</div></section>
              <section><h3>POSE READINESS</h3><div className="pose-note"><Activity size={20}/><div><strong>Static Meshy model detected</strong><small>Front, side and back fit checks are active. High-kick and arabesque animation will unlock when a rigged mannequin is supplied.</small></div></div></section>
            </div>
          </div>
        </div>
      )}

      {/* fabric and material library */}
      {materialsOpen && (
        <div className="absolute inset-0 z-20 flex items-end sheet-backdrop" onClick={() => setMaterialsOpen(false)}>
          <div className="material-sheet w-full rounded-t-3xl p-5" onClick={(e) => e.stopPropagation()}>
            <div className="mb-4 flex items-center justify-between">
              <div>
                <div className="sheet-title">FABRIC LIBRARY</div>
                <div className="sheet-subtitle">Choose fabric, then tap inside a closed 3D garment outline</div>
              </div>
              <button aria-label="Close materials" style={iconBtn(false)} onClick={() => setMaterialsOpen(false)}><X size={18} /></button>
            </div>
            <div className="material-grid">
              {([
                ['matte', 'Stretch jersey', 'Opaque · flexible'],
                ['satin', 'Satin', 'Silky · luminous'],
                ['velvet', 'Velvet', 'Plush · rich'],
                ['lace', 'Floral lace', 'Openwork · lingerie'],
                ['mesh', 'Power mesh', 'Semi-transparent'],
                ['sequin', 'Sequins', 'Sparkle · stage'],
              ] as Array<[FabricPreset, string, string]>).map(([id, name, note]) => (
                <button key={id} className="material-card" data-active={fabric === id} onClick={() => setFabric(id)}>
                  <span className="material-swatch" data-material={id} />
                  <span><strong>{name}</strong><small>{note}</small></span>
                </button>
              ))}
            </div>
            <div className="mt-4 flex items-center gap-3 rounded-2xl p-3" style={{ background: 'rgba(239,231,218,.06)' }}>
              <span className="control-label">MATERIAL COLOUR</span>
              <input aria-label="Material colour" type="color" value={color} onChange={(e) => setColor(e.target.value)} className="fabric-color" />
              <label className="material-adjust"><span>SCALE {materialScale.toFixed(1)}×</span><input aria-label="Texture scale" type="range" min={.5} max={2.5} step={.1} value={materialScale} onChange={(e)=>setMaterialScale(Number(e.target.value))}/></label>
              <label className="material-adjust"><span>ANGLE {materialRotation}°</span><input aria-label="Texture angle" type="range" min={0} max={180} step={15} value={materialRotation} onChange={(e)=>setMaterialRotation(Number(e.target.value))}/></label>
              <button className="done-button" onClick={() => {engineRef.current?.setFabricColor(color);engineRef.current?.setFabricPreset(fabric);engineRef.current?.setMaterialOptions(materialScale,materialRotation);setTool('fill');setMaterialsOpen(false)}}>USE FOR NEXT FILL</button>
            </div>
          </div>
        </div>
      )}

      {/* size sheet */}
      {sizeOpen && (
        <div
          className="absolute inset-0 z-20 flex items-end"
          style={{ background: 'rgba(0,0,0,0.45)' }}
          onClick={() => setSizeOpen(false)}
        >
          <div
            className="w-full rounded-t-3xl p-5"
            style={{
              background: CHARCOAL,
              borderTop: `2px solid ${GOLD}`,
              paddingBottom: 'calc(env(safe-area-inset-bottom) + 22px)',
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-1 flex items-center justify-between">
              <div
                style={{
                  fontFamily: 'Georgia, serif',
                  color: GOLD,
                  letterSpacing: '0.2em',
                  fontSize: 14,
                }}
              >
                MANIKIN SIZE
              </div>
              <button aria-label="Close" style={iconBtn(false)} onClick={() => setSizeOpen(false)}>
                <X size={18} />
              </button>
            </div>
            <div className="my-4 flex items-center gap-3">
              <span style={{ color: 'rgba(239,231,218,0.6)', fontSize: 11, width: 52 }}>HEIGHT</span>
              <input
                type="range"
                min={145}
                max={195}
                step={1}
                value={height}
                onChange={(e) => setHeight(Number(e.target.value))}
                style={{ flex: 1, accentColor: GOLD, height: 34 }}
              />
              <span style={{ color: GOLD, fontFamily: 'Georgia, serif', fontSize: 20, width: 70, textAlign: 'right' }}>
                {height} cm
              </span>
            </div>
            <div className="mt-2 grid grid-cols-4 gap-2">
              {(
                [
                  ['HEIGHT', meas.height],
                  ['BUST', meas.bust],
                  ['WAIST', meas.waist],
                  ['HIP', meas.hip],
                ] as Array<[string, number]>
              ).map(([label, v]) => (
                <div
                  key={label}
                  className="rounded-xl py-3 text-center"
                  style={{ background: 'rgba(239,231,218,0.07)' }}
                >
                  <div style={{ color: 'rgba(239,231,218,0.5)', fontSize: 10, letterSpacing: '0.12em' }}>
                    {label}
                  </div>
                  <div style={{ color: GOLD, fontFamily: 'Georgia, serif', fontSize: 22, fontWeight: 600 }}>
                    {v}
                  </div>
                  <div style={{ color: 'rgba(239,231,218,0.4)', fontSize: 10 }}>cm</div>
                </div>
              ))}
            </div>
            <button
              onClick={() => setSizeOpen(false)}
              className="mt-5 w-full rounded-2xl py-4"
              style={{ background: GOLD, color: CHARCOAL, fontWeight: 700, letterSpacing: '0.12em' }}
            >
              DONE
            </button>
          </div>
        </div>
      )}

      {/* design card busy overlay */}
      {cardBusy && (
        <div
          className="absolute inset-0 z-30 flex items-center justify-center"
          style={{ background: 'rgba(0,0,0,0.6)' }}
        >
          <div style={{ color: GOLD, fontFamily: 'Georgia, serif', letterSpacing: '0.2em', fontSize: 14 }}>
            COMPOSING DESIGN CARD…
          </div>
        </div>
      )}

      {/* design card preview */}
      {cardUrl && (
        <div
          className="absolute inset-0 z-30 flex flex-col"
          style={{ background: 'rgba(10,8,6,0.96)' }}
        >
          <div
            className="flex items-center justify-between px-4"
            style={{ paddingTop: 'calc(env(safe-area-inset-top) + 12px)', paddingBottom: 10 }}
          >
            <div style={{ fontFamily: 'Georgia, serif', color: GOLD, letterSpacing: '0.2em', fontSize: 14 }}>
              DESIGN CARD
            </div>
            <button aria-label="Close" style={iconBtn(false)} onClick={() => setCardUrl(null)}>
              <X size={18} />
            </button>
          </div>
          <div className="flex flex-1 items-center justify-center overflow-hidden px-4">
            <img
              src={cardUrl}
              alt="Design card"
              style={{ maxHeight: '100%', maxWidth: '100%', borderRadius: 12, objectFit: 'contain' }}
            />
          </div>
          <div
            className="flex gap-3 px-4 pt-3"
            style={{ paddingBottom: 'calc(env(safe-area-inset-bottom) + 16px)' }}
          >
            <button
              onClick={() => triggerDownload(cardUrl, 'eden-velvet-design-card.png')}
              className="flex flex-1 items-center justify-center gap-2 rounded-2xl py-4"
              style={{ background: GOLD, color: CHARCOAL, fontWeight: 700, letterSpacing: '0.1em' }}
            >
              <Download size={18} /> SAVE PNG
            </button>
            <button
              onClick={() => setCardUrl(null)}
              className="flex-1 rounded-2xl py-4"
              style={{
                background: 'rgba(239,231,218,0.1)',
                color: '#efe7da',
                fontWeight: 600,
                letterSpacing: '0.1em',
              }}
            >
              CLOSE
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
