import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react'
import type { DrawingPlaneAnchor, FabricPreset, ShapeKind, StoneShape, Tool } from '../three/engine'

export type DrawingViewId = 'front' | 'back' | 'left' | 'right'
export type CoverageMode = 'dance' | 'lingerie' | 'competition'
export type GarmentTemplate = 'bodice' | 'corset' | 'brief' | 'skirt' | 'cups' | 'sleeves' | 'straps' | 'fringe' | 'feathers'
export type Point = { x: number; y: number; pressure: number }
export interface DrawingPlaneSnapshot { id: string; image: string; anchor: DrawingPlaneAnchor; actions: DrawingAction[]; view: DrawingViewId; depth: number }

export interface LayerDefinition {
  id: string
  name: string
  visible: boolean
  locked: boolean
  opacity: number
}

type Base = { id: string; layerId?: string }
export type DrawingAction =
  | (Base & { kind: 'stroke'; mode: 'pencil' | 'spray' | 'eraser'; color: string; size: number; mirror: boolean; closed: boolean; points: Point[] })
  | (Base & { kind: 'shape'; shape: ShapeKind; color: string; size: number; mirror: boolean; start: Point; end: Point })
  | (Base & { kind: 'stones'; shape: StoneShape; color: string; size: number; count: number; mirror: boolean; points: Point[] })
  | (Base & { kind: 'fill'; targetId: string; color: string; material: FabricPreset; scale?: number; rotation?: number })
  | (Base & { kind: 'area-fill'; image: string })
  | (Base & { kind: 'measure'; color: string; start: Point; end: Point; label?: string })

export interface DrawingProject {
  version: 2
  views: Record<DrawingViewId, DrawingAction[]>
  activeView?: DrawingViewId
  layers: LayerDefinition[]
  activeLayerId: string
  pencilOnly: boolean
  coverageMode: CoverageMode
  showCoverage: boolean
  anchoredPlanes?: DrawingPlaneSnapshot[]
  activePlaneId?: string
  activePlaneAnchor?: DrawingPlaneAnchor | null
  activePlaneDepth?: number
}

export interface DrawingCanvasHandle {
  undo: () => void
  redo: () => void
  clear: () => void
  capture: () => string | null
  captureTexture: () => HTMLCanvasElement | null
  getSurface: () => HTMLCanvasElement | null
  deleteSelected: () => void
  duplicateSelected: () => void
  duplicateLastStones: () => void
  scaleSelected: (factor: number) => void
  rotateSelected: (radians: number) => void
  addTemplate: (template: GarmentTemplate) => void
}

interface Props {
  tool: Tool
  color: string
  thickness: number
  mirror: boolean
  shapeKind: ShapeKind
  stoneShape: StoneShape
  stoneSize: number
  stoneCount: number
  fabric: FabricPreset
  materialScale: number
  materialRotation: number
  mapPoint?: (clientX: number, clientY: number) => { x: number; y: number } | null
  onSurfaceChange?: () => void
  passthrough3D: boolean
  activeLayerId: string
  layers: LayerDefinition[]
  pencilOnly: boolean
  showCoverage: boolean
  coverageMode: CoverageMode
  heightCm: number
  initialActions: DrawingAction[]
  onChange: (actions: DrawingAction[]) => void
  onSelectionChange?: (selected: boolean) => void
}

const uid = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
const pt = (x: number, y: number): Point => ({ x, y, pressure: 0.65 })
const clamp = (value: number) => Math.max(0, Math.min(1, value))

function pathFor(action: Extract<DrawingAction, { kind: 'stroke' | 'shape' }>, w: number, h: number, mirrored = false) {
  const path = new Path2D()
  const mx = (x: number) => (mirrored ? 1 - x : x) * w
  if (action.kind === 'shape') {
    const x1 = mx(action.start.x), y1 = action.start.y * h, x2 = mx(action.end.x), y2 = action.end.y * h
    const left = Math.min(x1, x2), top = Math.min(y1, y2)
    const width = Math.max(8, Math.abs(x2 - x1)), height = Math.max(8, Math.abs(y2 - y1))
    if (action.shape === 'circle') path.ellipse(left + width / 2, top + height / 2, width / 2, height / 2, 0, 0, Math.PI * 2)
    else if (action.shape === 'square') {
      const side = Math.max(width, height)
      path.rect(x2 >= x1 ? x1 : x1 - side, y2 >= y1 ? y1 : y1 - side, side, side)
    } else path.rect(left, top, width, height)
    path.closePath()
    return path
  }
  if (!action.points.length) return path
  path.moveTo(mx(action.points[0].x), action.points[0].y * h)
  for (let i = 1; i < action.points.length - 1; i++) {
    const current = action.points[i], next = action.points[i + 1]
    path.quadraticCurveTo(mx(current.x), current.y * h, (mx(current.x) + mx(next.x)) / 2, ((current.y + next.y) * h) / 2)
  }
  const last = action.points[action.points.length - 1]
  path.lineTo(mx(last.x), last.y * h)
  if (action.closed) path.closePath()
  return path
}

function containsPoint(
  action: Extract<DrawingAction, { kind: 'stroke' | 'shape' }>,
  point: Point,
  w: number,
  h: number,
  mirrored = false,
) {
  const mx = (x: number) => (mirrored ? 1 - x : x) * w
  const px = point.x * w
  const py = point.y * h
  if (action.kind === 'shape') {
    const x1 = mx(action.start.x), y1 = action.start.y * h, x2 = mx(action.end.x), y2 = action.end.y * h
    const rawWidth = Math.max(8, Math.abs(x2 - x1)), rawHeight = Math.max(8, Math.abs(y2 - y1))
    let left = Math.min(x1, x2), top = Math.min(y1, y2), width = rawWidth, height = rawHeight
    if (action.shape === 'square') {
      width = height = Math.max(rawWidth, rawHeight)
      left = x2 >= x1 ? x1 : x1 - width
      top = y2 >= y1 ? y1 : y1 - height
    }
    if (action.shape === 'circle') {
      const rx = width / 2, ry = height / 2
      return ((px - (left + rx)) / rx) ** 2 + ((py - (top + ry)) / ry) ** 2 <= 1
    }
    return px >= left && px <= left + width && py >= top && py <= top + height
  }
  if (action.points.length < 3) return false
  const first = action.points[0], last = action.points.at(-1)!
  const closeRadius = Math.max(40, Math.min(w, h) * .055, action.size * 4)
  if (!action.closed && Math.hypot((last.x - first.x) * w, (last.y - first.y) * h) > closeRadius) return false
  const polygon = action.points.map((item) => ({ x: mx(item.x), y: item.y * h }))
  let inside = false
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i], b = polygon[j]
    if ((a.y > py) !== (b.y > py) && px < ((b.x - a.x) * (py - a.y)) / (b.y - a.y) + a.x) inside = !inside
  }
  return inside
}

function materialFill(ctx: CanvasRenderingContext2D, material: FabricPreset, color: string, w: number, h: number, scale = 1, rotation = 0): string | CanvasGradient | CanvasPattern {
  if (material === 'satin') {
    const gradient = ctx.createLinearGradient(0, 0, w, h)
    gradient.addColorStop(0, color); gradient.addColorStop(0.42, '#ffffff'); gradient.addColorStop(0.52, color); gradient.addColorStop(1, color)
    return gradient
  }
  if (material === 'velvet') {
    const gradient = ctx.createRadialGradient(w * 0.42, h * 0.36, 0, w * 0.5, h * 0.5, Math.max(w, h) * 0.62)
    gradient.addColorStop(0, color); gradient.addColorStop(1, '#21110f')
    return gradient
  }
  if (material === 'matte') return color
  const tile = document.createElement('canvas')
  const tileSize = Math.round(32 * Math.max(0.5, Math.min(2.5, scale)))
  tile.width = tile.height = tileSize
  const t = tile.getContext('2d')!
  t.translate(tileSize / 2, tileSize / 2); t.rotate(rotation * Math.PI / 180); t.translate(-tileSize / 2, -tileSize / 2)
  t.fillStyle = color; t.fillRect(-tileSize, -tileSize, tileSize * 3, tileSize * 3)
  if (material === 'lace') {
    t.clearRect(-tileSize, -tileSize, tileSize * 3, tileSize * 3); t.strokeStyle = color; t.lineWidth = Math.max(2, tileSize / 12)
    t.beginPath(); t.arc(tileSize * .25, tileSize * .25, tileSize * .18, 0, Math.PI * 2); t.arc(tileSize * .75, tileSize * .75, tileSize * .18, 0, Math.PI * 2); t.stroke()
    t.beginPath(); t.moveTo(0, tileSize); t.lineTo(tileSize, 0); t.stroke()
  } else if (material === 'mesh') {
    t.globalAlpha = .5; t.strokeStyle = '#fff'; t.lineWidth = 1
    for (let i = 0; i <= tileSize; i += Math.max(5, tileSize / 5)) { t.beginPath(); t.moveTo(i, 0); t.lineTo(i, tileSize); t.stroke(); t.beginPath(); t.moveTo(0, i); t.lineTo(tileSize, i); t.stroke() }
  } else if (material === 'sequin') {
    const step = tileSize / 2
    for (let y = step / 2; y < tileSize; y += step) for (let x = step / 2; x < tileSize; x += step) {
      const g = t.createRadialGradient(x - 2, y - 2, 0, x, y, step * .38)
      g.addColorStop(0, '#fff'); g.addColorStop(.4, color); g.addColorStop(1, '#3a2b25')
      t.fillStyle = g; t.beginPath(); t.arc(x, y, step * .38, 0, Math.PI * 2); t.fill()
    }
  }
  return ctx.createPattern(tile, 'repeat') || color
}

function drawStone(ctx: CanvasRenderingContext2D, x: number, y: number, radius: number, shape: StoneShape, color: string) {
  ctx.save(); ctx.translate(x, y); ctx.shadowColor = '#fff'; ctx.shadowBlur = radius
  const gradient = ctx.createRadialGradient(-radius * .35, -radius * .4, 0, 0, 0, radius)
  gradient.addColorStop(0, '#fff'); gradient.addColorStop(.28, color); gradient.addColorStop(1, '#403327')
  ctx.fillStyle = gradient; ctx.strokeStyle = 'rgba(255,255,255,.85)'; ctx.lineWidth = Math.max(1, radius * .12); ctx.beginPath()
  if (shape === 'round') ctx.arc(0, 0, radius, 0, Math.PI * 2)
  else if (shape === 'square') ctx.rect(-radius * .82, -radius * .82, radius * 1.64, radius * 1.64)
  else if (shape === 'teardrop') { ctx.moveTo(0, -radius * 1.35); ctx.bezierCurveTo(radius, -radius * .25, radius * .85, radius, 0, radius * 1.15); ctx.bezierCurveTo(-radius * .85, radius, -radius, -radius * .25, 0, -radius * 1.35) }
  else { ctx.moveTo(0, -radius * 1.2); ctx.lineTo(radius, 0); ctx.lineTo(0, radius * 1.2); ctx.lineTo(-radius, 0); ctx.closePath() }
  ctx.fill(); ctx.stroke(); ctx.restore()
}

const stoneSpriteCache = new Map<string, HTMLCanvasElement>()
function stoneSprite(shape: StoneShape, color: string, size: number) {
  const key=`${shape}:${color}:${size}`,cached=stoneSpriteCache.get(key);if(cached)return cached
  const radius=size*.72,side=Math.max(12,Math.ceil(radius*6)),sprite=document.createElement('canvas');sprite.width=sprite.height=side
  drawStone(sprite.getContext('2d')!,side/2,side/2,radius,shape,color);stoneSpriteCache.set(key,sprite);return sprite
}

function actionPoints(action: DrawingAction): Point[] {
  if (action.kind === 'stroke' || action.kind === 'stones') return action.points
  if (action.kind === 'shape' || action.kind === 'measure') return [action.start, action.end]
  return []
}

function bounds(action: DrawingAction) {
  const points = actionPoints(action)
  if (!points.length) return null
  return { minX: Math.min(...points.map((p) => p.x)), maxX: Math.max(...points.map((p) => p.x)), minY: Math.min(...points.map((p) => p.y)), maxY: Math.max(...points.map((p) => p.y)) }
}

function mapAction(action: DrawingAction, transform: (point: Point) => Point): DrawingAction {
  if (action.kind === 'stroke' || action.kind === 'stones') return { ...action, points: action.points.map(transform) }
  if (action.kind === 'shape' || action.kind === 'measure') return { ...action, start: transform(action.start), end: transform(action.end) }
  return action
}

function templateActions(template: GarmentTemplate, layerId: string, color: string, size: number): DrawingAction[] {
  const closed = (points: Array<[number, number]>, mirror = false): DrawingAction => ({ id: uid(), layerId, kind: 'stroke', mode: 'pencil', color, size, mirror, closed: true, points: [...points.map(([x, y]) => pt(x, y)), pt(points[0][0], points[0][1])] })
  if (template === 'bodice') return [closed([[.39,.27],[.61,.27],[.66,.47],[.59,.62],[.41,.62],[.34,.47]])]
  if (template === 'corset') return [closed([[.37,.31],[.63,.31],[.61,.62],[.55,.69],[.45,.69],[.39,.62]])]
  if (template === 'brief') return [closed([[.38,.60],[.62,.60],[.58,.75],[.5,.82],[.42,.75]])]
  if (template === 'skirt') return [closed([[.39,.58],[.61,.58],[.72,.86],[.28,.86]])]
  if (template === 'cups') return [closed([[.39,.38],[.5,.32],[.5,.48],[.39,.48]], true)]
  if (template === 'sleeves') return [closed([[.37,.29],[.28,.31],[.23,.56],[.31,.57],[.39,.39]], true)]
  if (template === 'straps') return [closed([[.4,.28],[.43,.27],[.47,.12],[.44,.12]], true)]
  if (template === 'fringe') return Array.from({ length: 11 }, (_, i) => ({ id: uid(), layerId, kind: 'stroke' as const, mode: 'pencil' as const, color, size: Math.max(1.5, size * .55), mirror: false, closed: false, points: [pt(.36 + i * .028,.61), pt(.35 + i * .03,.78 + (i % 2) * .03)] }))
  return Array.from({ length: 9 }, (_, i) => ({ id: uid(), layerId, kind: 'stroke' as const, mode: 'pencil' as const, color, size: Math.max(2, size), mirror: false, closed: false, points: [pt(.39 + i * .028,.61), pt(.32 + i * .045,.74), pt(.36 + i * .035,.83)] }))
}

export const DrawingCanvas = forwardRef<DrawingCanvasHandle, Props>(function DrawingCanvas(props, ref) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const actionsRef = useRef<DrawingAction[]>(props.initialActions)
  const redoRef = useRef<DrawingAction[]>([])
  const activeRef = useRef<DrawingAction | null>(null)
  const selectedRef = useRef<string | null>(null)
  const dragRef = useRef<Point | null>(null)
  const dragChangedRef = useRef(false)
  const sizeRef = useRef({ w: 1, h: 1, dpr: 1 })
  const rasterImagesRef = useRef(new Map<string, HTMLImageElement>())

  const layerFor = (action: DrawingAction) => props.layers.find((layer) => layer.id === (action.layerId || 'design'))
  const render = (clean = false) => {
    const canvas = canvasRef.current
    if (!canvas) return
    const { w, h, dpr } = sizeRef.current
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, canvas.width, canvas.height); ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.lineCap = 'round'; ctx.lineJoin = 'round'
    if (props.showCoverage && !clean) {
      const zones: Record<CoverageMode, Array<[number, number]>> = {
        dance: [[.36,.31],[.64,.31],[.62,.55],[.58,.72],[.42,.72],[.38,.55]],
        lingerie: [[.4,.36],[.6,.36],[.58,.52],[.61,.63],[.57,.76],[.43,.76],[.39,.63],[.42,.52]],
        competition: [[.37,.3],[.63,.3],[.59,.55],[.63,.7],[.57,.8],[.43,.8],[.37,.7],[.41,.55]],
      }
      ctx.save(); ctx.setLineDash([7,6]); ctx.strokeStyle = 'rgba(201,169,106,.72)'; ctx.fillStyle = 'rgba(201,169,106,.06)'; ctx.lineWidth = 1.5; ctx.beginPath()
      zones[props.coverageMode].forEach(([x,y], index) => index ? ctx.lineTo(x*w,y*h) : ctx.moveTo(x*w,y*h)); ctx.closePath(); ctx.fill(); ctx.stroke(); ctx.restore()
    }
    const all = activeRef.current ? [...actionsRef.current, activeRef.current] : actionsRef.current
    const fills = new Map(all.filter((a): a is Extract<DrawingAction, { kind: 'fill' }> => a.kind === 'fill').map((a) => [a.targetId, a]))
    for (const layer of props.layers) {
      if (!layer.visible) continue
      ctx.save(); ctx.globalAlpha = layer.opacity
      for (const action of all.filter((item): item is Extract<DrawingAction,{kind:'area-fill'}> => (item.layerId || 'design') === layer.id && item.kind === 'area-fill')) {
        let image=rasterImagesRef.current.get(action.id)
        if(!image){image=new Image();image.onload=()=>render();image.src=action.image;rasterImagesRef.current.set(action.id,image)}
        if(image.complete&&image.naturalWidth)ctx.drawImage(image,0,0,w,h)
      }
      for (const action of all.filter((item) => (item.layerId || 'design') === layer.id && item.kind !== 'fill' && item.kind !== 'area-fill')) {
        if (action.kind === 'stroke') {
          for (const mirrored of action.mirror ? [false,true] : [false]) {
            const path = pathFor(action,w,h,mirrored), fill = fills.get(action.id)
            if (action.closed && fill) { ctx.save(); ctx.globalAlpha *= fill.material === 'mesh' ? .48 : fill.material === 'lace' ? .82 : .9; ctx.fillStyle = materialFill(ctx,fill.material||'matte',fill.color,w,h,fill.scale,fill.rotation); ctx.fill(path); ctx.restore() }
            ctx.globalCompositeOperation = action.mode === 'eraser' ? 'destination-out' : 'source-over'; ctx.strokeStyle = action.mode === 'eraser' ? '#000' : action.color
            const pressure = action.points.reduce((sum,p)=>sum+p.pressure,0)/Math.max(1,action.points.length); ctx.lineWidth = action.size*(.7+pressure*.65)*(action.mode==='eraser'?2.2:1)
            if (action.mode === 'spray') for (const p of action.points) for (let i=0;i<7;i++) { const px=(mirrored?1-p.x:p.x)*w,py=p.y*h,ang=i*2.399+p.x*31,dist=i/7*action.size*2.4; ctx.beginPath();ctx.arc(px+Math.cos(ang)*dist,py+Math.sin(ang)*dist,Math.max(1,action.size*.22),0,Math.PI*2);ctx.fillStyle=action.color;ctx.globalAlpha=.24*layer.opacity;ctx.fill() } else ctx.stroke(path)
          }
        } else if (action.kind === 'shape') {
          for (const mirrored of action.mirror?[false,true]:[false]) { const path=pathFor(action,w,h,mirrored),fill=fills.get(action.id); if(fill){ctx.save();ctx.globalAlpha*=fill.material==='mesh'?.48:fill.material==='lace'?.82:.9;ctx.fillStyle=materialFill(ctx,fill.material||'matte',fill.color,w,h,fill.scale,fill.rotation);ctx.fill(path);ctx.restore()} ctx.strokeStyle=action.color;ctx.lineWidth=action.size;ctx.stroke(path) }
        } else if (action.kind === 'stones') {
          const sprite=stoneSprite(action.shape,action.color,action.size),half=sprite.width/2
          for (const point of action.points) for (const mirrored of action.mirror?[false,true]:[false]) { const px=(mirrored?1-point.x:point.x)*w,py=point.y*h; for(let i=0;i<action.count;i++){const angle=i/Math.max(1,action.count)*Math.PI*2,spread=i===0?0:action.size*1.25;ctx.drawImage(sprite,px+Math.cos(angle)*spread-half,py+Math.sin(angle)*spread-half)} }
        } else if (action.kind === 'measure') {
          const x1=action.start.x*w,y1=action.start.y*h,x2=action.end.x*w,y2=action.end.y*h,d=Math.hypot(x2-x1,y2-y1),cm=Math.round(d/h*props.heightCm*1.25)
          ctx.save();ctx.setLineDash([5,4]);ctx.strokeStyle=action.color;ctx.fillStyle=action.color;ctx.lineWidth=1.5;ctx.beginPath();ctx.moveTo(x1,y1);ctx.lineTo(x2,y2);ctx.stroke();ctx.setLineDash([]);ctx.beginPath();ctx.arc(x1,y1,4,0,Math.PI*2);ctx.arc(x2,y2,4,0,Math.PI*2);ctx.fill();ctx.font='600 12px system-ui';ctx.fillText(action.label||`${cm} cm`,(x1+x2)/2+6,(y1+y2)/2-6);ctx.restore()
        }
      }
      ctx.restore()
    }
    const selected = clean ? undefined : all.find((action)=>action.id===selectedRef.current), box = selected && bounds(selected)
    if (box) { ctx.save();ctx.setLineDash([6,4]);ctx.strokeStyle='#c9a96a';ctx.lineWidth=1.5;ctx.strokeRect(box.minX*w-8,box.minY*h-8,(box.maxX-box.minX)*w+16,(box.maxY-box.minY)*h+16);ctx.setLineDash([]);for(const [x,y] of [[box.minX,box.minY],[box.maxX,box.minY],[box.maxX,box.maxY],[box.minX,box.maxY]]){ctx.fillStyle='#c9a96a';ctx.beginPath();ctx.arc(x*w,y*h,5,0,Math.PI*2);ctx.fill()}ctx.restore() }
    ctx.globalAlpha=1;ctx.globalCompositeOperation='source-over'
    props.onSurfaceChange?.()
  }

  const publish = (actions: DrawingAction[]) => { actionsRef.current=actions; activeRef.current=null; render(); props.onChange(actions) }
  const commit = (action: DrawingAction) => { redoRef.current=[]; publish([...actionsRef.current,action]) }
  const selectedAction = () => actionsRef.current.find((action)=>action.id===selectedRef.current)
  const mutateSelected = (mapper:(action:DrawingAction)=>DrawingAction) => { const id=selectedRef.current;if(!id)return;publish(actionsRef.current.map((action)=>action.id===id?mapper(action):action)) }

  const makeAreaFill=(point:Point):string|null=>{
    const source=canvasRef.current;if(!source)return null
    render(true)
    const{w,h}=sizeRef.current,maskW=Math.min(800,Math.max(240,Math.round(w))),maskH=Math.max(240,Math.round(maskW*h/w))
    const boundary=document.createElement('canvas');boundary.width=maskW;boundary.height=maskH
    const boundaryCtx=boundary.getContext('2d',{willReadFrequently:true});if(!boundaryCtx){render();return null}
    boundaryCtx.drawImage(source,0,0,maskW,maskH)
    const pixels=boundaryCtx.getImageData(0,0,maskW,maskH),seedX=Math.max(0,Math.min(maskW-1,Math.floor(point.x*maskW))),seedY=Math.max(0,Math.min(maskH-1,Math.floor(point.y*maskH))),seed=seedY*maskW+seedX
    if(pixels.data[seed*4+3]>36){render();return null}
    const visited=new Uint8Array(maskW*maskH),queue=new Int32Array(maskW*maskH);let head=0,tail=0,touchesEdge=false
    visited[seed]=1;queue[tail++]=seed
    while(head<tail){const index=queue[head++],x=index%maskW,y=Math.floor(index/maskW);if(x===0||y===0||x===maskW-1||y===maskH-1)touchesEdge=true;const neighbours=[index-1,index+1,index-maskW,index+maskW];for(let n=0;n<4;n++){const next=neighbours[n];if(next<0||next>=visited.length||visited[next])continue;const nx=next%maskW;if(n===0&&nx!==x-1||n===1&&nx!==x+1)continue;if(pixels.data[next*4+3]>36)continue;visited[next]=1;queue[tail++]=next}}
    if(touchesEdge||tail<24){render();return null}
    const mask=document.createElement('canvas');mask.width=maskW;mask.height=maskH;const maskCtx=mask.getContext('2d')!,maskData=maskCtx.createImageData(maskW,maskH)
    for(let i=0;i<visited.length;i++)if(visited[i]){maskData.data[i*4]=255;maskData.data[i*4+1]=255;maskData.data[i*4+2]=255;maskData.data[i*4+3]=255}
    maskCtx.putImageData(maskData,0,0)
    const filled=document.createElement('canvas');filled.width=maskW;filled.height=maskH;const fillCtx=filled.getContext('2d')!
    fillCtx.globalAlpha=props.fabric==='mesh'?.48:props.fabric==='lace'?.82:.9;fillCtx.fillStyle=materialFill(fillCtx,props.fabric,props.color,maskW,maskH,props.materialScale,props.materialRotation);fillCtx.fillRect(0,0,maskW,maskH);fillCtx.globalAlpha=1;fillCtx.globalCompositeOperation='destination-in';fillCtx.drawImage(mask,0,0)
    const image=filled.toDataURL('image/png');render();return image
  }

  useEffect(()=>{actionsRef.current=props.initialActions;selectedRef.current=null;props.onSelectionChange?.(false);render()},[props.initialActions])
  useEffect(()=>{const canvas=canvasRef.current;if(!canvas)return;const resize=()=>{const parent=canvas.parentElement,w=Math.max(1,parent?.clientWidth??innerWidth),h=Math.max(1,parent?.clientHeight??innerHeight),coarse=matchMedia('(pointer: coarse)').matches,dpr=Math.min(devicePixelRatio||1,coarse?1.25:1.75);canvas.width=Math.round(w*dpr);canvas.height=Math.round(h*dpr);canvas.style.width=`${w}px`;canvas.style.height=`${h}px`;sizeRef.current={w,h,dpr};render()};const observer=new ResizeObserver(resize);observer.observe(canvas.parentElement??canvas);resize();return()=>observer.disconnect()},[])
  useEffect(render,[props.layers,props.showCoverage,props.coverageMode,props.heightCm])

  useImperativeHandle(ref,()=>({
    undo:()=>{const action=actionsRef.current.at(-1);if(!action)return;redoRef.current.push(action);publish(actionsRef.current.slice(0,-1))},
    redo:()=>{const action=redoRef.current.pop();if(action)publish([...actionsRef.current,action])},
    clear:()=>{redoRef.current=[...actionsRef.current];selectedRef.current=null;props.onSelectionChange?.(false);publish([])},
    capture:()=>{render(true);const image=canvasRef.current?.toDataURL('image/png')??null;render();return image},
    captureTexture:()=>{const source=canvasRef.current;if(!source)return null;render(true);const copy=document.createElement('canvas');copy.width=source.width;copy.height=source.height;copy.getContext('2d')?.drawImage(source,0,0);render();return copy},
    getSurface:()=>canvasRef.current,
    deleteSelected:()=>{const id=selectedRef.current;if(!id)return;selectedRef.current=null;props.onSelectionChange?.(false);publish(actionsRef.current.filter((action)=>action.id!==id&&!(action.kind==='fill'&&action.targetId===id)))},
    duplicateSelected:()=>{const action=selectedAction();if(!action)return;const copy=mapAction(structuredClone(action),(p)=>({...p,x:clamp(p.x+.025),y:clamp(p.y+.025)}));copy.id=uid();commit(copy);selectedRef.current=copy.id;props.onSelectionChange?.(true)},
    duplicateLastStones:()=>{const action=[...actionsRef.current].reverse().find((item):item is Extract<DrawingAction,{kind:'stones'}>=>item.kind==='stones');if(!action)return;const copy={...structuredClone(action),id:uid(),points:action.points.map((p)=>({...p,x:clamp(p.x+.025),y:clamp(p.y+.025)}))};commit(copy)},
    scaleSelected:(factor)=>mutateSelected((action)=>{const box=bounds(action);if(!box)return action;const cx=(box.minX+box.maxX)/2,cy=(box.minY+box.maxY)/2;return mapAction(action,(p)=>({...p,x:clamp(cx+(p.x-cx)*factor),y:clamp(cy+(p.y-cy)*factor)}))}),
    rotateSelected:(angle)=>mutateSelected((action)=>{const box=bounds(action);if(!box)return action;const cx=(box.minX+box.maxX)/2,cy=(box.minY+box.maxY)/2;return mapAction(action,(p)=>{const dx=p.x-cx,dy=p.y-cy;return{...p,x:clamp(cx+dx*Math.cos(angle)-dy*Math.sin(angle)),y:clamp(cy+dx*Math.sin(angle)+dy*Math.cos(angle))}})}),
    addTemplate:(template)=>{const actions=templateActions(template,props.activeLayerId,props.color,Math.max(2,props.thickness));redoRef.current=[];publish([...actionsRef.current,...actions])},
  }))

  const pointFrom=(event:React.PointerEvent<HTMLCanvasElement>):Point|null=>{const mapped=props.mapPoint?.(event.clientX,event.clientY);if(props.mapPoint&&!mapped)return null;if(mapped)return{x:clamp(mapped.x),y:clamp(mapped.y),pressure:event.pointerType==='pen'?Math.max(.2,event.pressure):.65};const rect=event.currentTarget.getBoundingClientRect();return{x:clamp((event.clientX-rect.left)/rect.width),y:clamp((event.clientY-rect.top)/rect.height),pressure:event.pointerType==='pen'?Math.max(.2,event.pressure):.65}}
  const onPointerDown=(event:React.PointerEvent<HTMLCanvasElement>)=>{
    if(props.tool==='move'||(props.pencilOnly&&event.pointerType!=='pen'&&props.tool!=='select'))return
    const point=pointFrom(event);if(!point)return;event.preventDefault();event.currentTarget.setPointerCapture(event.pointerId);const layer=props.layers.find((item)=>item.id===props.activeLayerId);if(layer?.locked)return
    if(props.tool==='select'){for(let i=actionsRef.current.length-1;i>=0;i--){const action=actionsRef.current[i],box=bounds(action);if(!box||!layerFor(action)?.visible)continue;if(point.x>=box.minX-.035&&point.x<=box.maxX+.035&&point.y>=box.minY-.035&&point.y<=box.maxY+.035){selectedRef.current=action.id;dragRef.current=point;dragChangedRef.current=false;props.onSelectionChange?.(true);render();return}}selectedRef.current=null;props.onSelectionChange?.(false);render();return}
    if(props.tool==='fill'){
      const{w,h}=sizeRef.current
      for(let i=actionsRef.current.length-1;i>=0;i--){
        const action=actionsRef.current[i]
        const fillable=action.kind==='shape'||action.kind==='stroke'
        const targetLayer=layerFor(action)
        if(!fillable||!targetLayer?.visible||targetLayer.locked)continue
        const insidePrimary=containsPoint(action,point,w,h)
        const insideMirror=action.mirror&&containsPoint(action,point,w,h,true)
        if(insidePrimary||insideMirror){
          const normalized=actionsRef.current.map((item)=>item.id===action.id&&item.kind==='stroke'&&!item.closed?{...item,closed:true,points:[...item.points.slice(0,-1),{...item.points[0]}]}:item)
          const previous=normalized.filter((item)=>!(item.kind==='fill'&&item.targetId===action.id))
          publish([...previous,{id:uid(),layerId:action.layerId||props.activeLayerId,kind:'fill',targetId:action.id,color:props.color,material:props.fabric,scale:props.materialScale,rotation:props.materialRotation}]);return
        }
      }
      const areaImage=makeAreaFill(point)
      if(areaImage){const id=uid(),image=new Image();image.src=areaImage;rasterImagesRef.current.set(id,image);publish([...actionsRef.current,{id,layerId:props.activeLayerId,kind:'area-fill',image:areaImage}])}
      return
    }
    if(props.tool==='shape')activeRef.current={id:uid(),layerId:props.activeLayerId,kind:'shape',shape:props.shapeKind,color:props.color,size:Math.max(2,props.thickness),mirror:props.mirror,start:point,end:point}
    else if(props.tool==='stone')activeRef.current={id:uid(),layerId:props.activeLayerId,kind:'stones',shape:props.stoneShape,color:props.color,size:props.stoneSize,count:props.stoneCount,mirror:props.mirror,points:[point]}
    else if(props.tool==='measure')activeRef.current={id:uid(),layerId:props.activeLayerId,kind:'measure',color:'#c9a96a',start:point,end:point}
    else if(props.tool==='pencil'||props.tool==='spray'||props.tool==='eraser')activeRef.current={id:uid(),layerId:props.activeLayerId,kind:'stroke',mode:props.tool,color:props.color,size:Math.max(2,props.thickness*1.35),mirror:props.mirror,closed:false,points:[point]}
    render()
  }
  const onPointerMove=(event:React.PointerEvent<HTMLCanvasElement>)=>{const point=pointFrom(event);if(!point)return;if(props.tool==='select'&&selectedRef.current&&dragRef.current){const last=dragRef.current,dx=point.x-last.x,dy=point.y-last.y;dragRef.current=point;dragChangedRef.current=true;const id=selectedRef.current;actionsRef.current=actionsRef.current.map((action)=>action.id===id?mapAction(action,(p)=>({...p,x:clamp(p.x+dx),y:clamp(p.y+dy)})):action);render();return}const active=activeRef.current;if(!active||!event.currentTarget.hasPointerCapture(event.pointerId))return;event.preventDefault();if(active.kind==='shape'||active.kind==='measure')active.end=point;else if(active.kind==='stroke'||active.kind==='stones'){const last=active.points.at(-1)!,{w,h}=sizeRef.current,spacing=active.kind==='stones'?Math.max(12,active.size*3.2):2.5,maxPoints=active.kind==='stones'?Math.max(1,Math.floor(720/(active.count*(active.mirror?2:1)))):Infinity;if(active.points.length<maxPoints&&Math.hypot((point.x-last.x)*w,(point.y-last.y)*h)>=spacing)active.points.push(point)}render()}
  const onPointerUp=(event:React.PointerEvent<HTMLCanvasElement>)=>{const movedSelection=dragChangedRef.current;dragRef.current=null;dragChangedRef.current=false;if(movedSelection){redoRef.current=[];props.onChange(actionsRef.current);try{event.currentTarget.releasePointerCapture(event.pointerId)}catch{/* released */}return}const active=activeRef.current;if(!active)return;if(active.kind==='stroke'&&active.mode==='pencil'&&active.points.length>5){const first=active.points[0],last=active.points.at(-1)!,{w,h}=sizeRef.current;const closeRadius=Math.max(40,Math.min(w,h)*.055,active.size*4);if(Math.hypot((last.x-first.x)*w,(last.y-first.y)*h)<=closeRadius){active.closed=true;active.points[active.points.length-1]={...first}}}commit(active);try{event.currentTarget.releasePointerCapture(event.pointerId)}catch{/* released */}}

  return <canvas ref={canvasRef} aria-label="3D garment drawing surface" onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp} style={{position:'absolute',inset:0,zIndex:2,touchAction:'none',pointerEvents:props.tool==='move'||props.passthrough3D?'none':'auto',opacity:0}} />
})
