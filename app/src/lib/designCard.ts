export interface CardMeasurements {
  height: number
  bust: number
  waist: number
  hip: number
}

export interface CardView {
  label: string
  image: string // dataURL, square
}

export interface DesignCardOptions {
  views: CardView[]
  measurements: CardMeasurements
  baseColor: string
  strokeColors: string[]
  date: string
}

const CHARCOAL = '#16130f'
const IVORY_BG = '#f6f0e4'
const GOLD = '#c9a96a'
const IVORY_TEXT = '#efe7da'

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('image load failed'))
    img.src = src
  })
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number
): void {
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.arcTo(x + w, y, x + w, y + h, r)
  ctx.arcTo(x + w, y + h, x, y + h, r)
  ctx.arcTo(x, y + h, x, y, r)
  ctx.arcTo(x, y, x + w, y, r)
  ctx.closePath()
}

function setTracking(ctx: CanvasRenderingContext2D, px: number): void {
  ;(ctx as CanvasRenderingContext2D & { letterSpacing?: string }).letterSpacing = `${px}px`
}

/** Compose the portrait design-card PNG and return it as a dataURL */
export async function composeDesignCard(opts: DesignCardOptions): Promise<string> {
  const W = 1200
  const H = 1600
  const canvas = document.createElement('canvas')
  canvas.width = W
  canvas.height = H
  const ctx = canvas.getContext('2d')!

  const imgs = await Promise.all(opts.views.map((v) => loadImage(v.image)))

  // background
  ctx.fillStyle = IVORY_BG
  ctx.fillRect(0, 0, W, H)

  // header
  ctx.fillStyle = CHARCOAL
  ctx.fillRect(0, 0, W, 150)
  ctx.fillStyle = GOLD
  ctx.fillRect(0, 150, W, 4)

  ctx.textBaseline = 'alphabetic'
  ctx.textAlign = 'left'
  setTracking(ctx, 10)
  ctx.fillStyle = GOLD
  ctx.font = '600 46px Georgia, "Times New Roman", serif'
  ctx.fillText('EDEN VELVET', 60, 82)
  setTracking(ctx, 6)
  ctx.fillStyle = IVORY_TEXT
  ctx.font = '400 22px Georgia, serif'
  ctx.fillText('D E S I G N   C A R D', 60, 122)
  ctx.textAlign = 'right'
  ctx.fillStyle = 'rgba(239,231,218,0.7)'
  ctx.font = '400 24px Georgia, serif'
  ctx.fillText(opts.date, W - 60, 82)
  ctx.fillText('COUTURE STUDY', W - 60, 122)
  setTracking(ctx, 0)

  // 2x2 view grid
  const margin = 60
  const gap = 24
  const cell = (W - margin * 2 - gap) / 2 // 528
  const labelH = 36
  const cellH = cell + labelH
  const top = 190

  for (let i = 0; i < 4 && i < imgs.length; i++) {
    const col = i % 2
    const row = Math.floor(i / 2)
    const x = margin + col * (cell + gap)
    const y = top + row * (cellH + gap)

    ctx.save()
    roundRect(ctx, x, y, cell, cell, 18)
    ctx.clip()
    ctx.drawImage(imgs[i], x, y, cell, cell)
    ctx.restore()

    // thin gold frame
    ctx.strokeStyle = 'rgba(201,169,106,0.55)'
    ctx.lineWidth = 2
    roundRect(ctx, x + 1, y + 1, cell - 2, cell - 2, 17)
    ctx.stroke()

    // label chip
    ctx.fillStyle = CHARCOAL
    roundRect(ctx, x + 14, y + cell - 46, 150, 34, 17)
    ctx.fill()
    ctx.fillStyle = IVORY_TEXT
    setTracking(ctx, 3)
    ctx.font = '500 18px Georgia, serif'
    ctx.textAlign = 'left'
    ctx.fillText(opts.views[i].label, x + 30, y + cell - 23)
    setTracking(ctx, 0)
  }

  // measurements panel
  const gridBottom = top + 2 * cellH + gap
  const panelY = gridBottom + 20
  const panelH = 126
  ctx.fillStyle = CHARCOAL
  roundRect(ctx, margin, panelY, W - margin * 2, panelH, 20)
  ctx.fill()

  const stats: Array<[string, number]> = [
    ['HEIGHT', opts.measurements.height],
    ['BUST', opts.measurements.bust],
    ['WAIST', opts.measurements.waist],
    ['HIP', opts.measurements.hip],
  ]
  const colW = (W - margin * 2) / 4
  stats.forEach(([label, value], i) => {
    const cx = margin + colW * i + colW / 2
    ctx.textAlign = 'center'
    setTracking(ctx, 4)
    ctx.fillStyle = 'rgba(239,231,218,0.6)'
    ctx.font = '400 17px Georgia, serif'
    ctx.fillText(label, cx, panelY + 40)
    setTracking(ctx, 0)
    ctx.fillStyle = GOLD
    ctx.font = '600 44px Georgia, serif'
    ctx.fillText(String(value), cx, panelY + 90)
    ctx.fillStyle = 'rgba(239,231,218,0.55)'
    ctx.font = '400 16px Georgia, serif'
    ctx.fillText('cm', cx + ctx.measureText(String(value)).width / 2 + 18, panelY + 90)
    if (i > 0) {
      ctx.strokeStyle = 'rgba(239,231,218,0.15)'
      ctx.lineWidth = 1
      ctx.beginPath()
      ctx.moveTo(margin + colW * i, panelY + 24)
      ctx.lineTo(margin + colW * i, panelY + panelH - 24)
      ctx.stroke()
    }
  })

  // footer
  const footerY = panelY + panelH + 20
  ctx.fillStyle = CHARCOAL
  ctx.fillRect(0, footerY, W, H - footerY)
  ctx.fillStyle = GOLD
  ctx.fillRect(0, footerY, W, 2)

  // base fabric swatch
  ctx.textAlign = 'left'
  setTracking(ctx, 3)
  ctx.fillStyle = 'rgba(239,231,218,0.6)'
  ctx.font = '400 16px Georgia, serif'
  const midY = footerY + (H - footerY) / 2 + 6
  ctx.fillText('BASE FABRIC', 60, midY)
  ctx.beginPath()
  ctx.arc(200, midY - 6, 16, 0, Math.PI * 2)
  ctx.fillStyle = opts.baseColor
  ctx.fill()
  ctx.strokeStyle = GOLD
  ctx.lineWidth = 2
  ctx.stroke()

  // stroke palette dots
  ctx.fillText('PALETTE', 260, midY)
  opts.strokeColors.slice(0, 12).forEach((c, i) => {
    ctx.beginPath()
    ctx.arc(370 + i * 34, midY - 6, 13, 0, Math.PI * 2)
    ctx.fillStyle = c
    ctx.fill()
    ctx.strokeStyle = 'rgba(201,169,106,0.7)'
    ctx.lineWidth = 1.5
    ctx.stroke()
  })

  ctx.textAlign = 'right'
  setTracking(ctx, 4)
  ctx.fillStyle = GOLD
  ctx.font = '400 20px Georgia, serif'
  ctx.fillText('EDEN VELVET', W - 60, midY)
  setTracking(ctx, 0)

  return canvas.toDataURL('image/png')
}
