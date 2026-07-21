import * as THREE from 'three'

export const IVORY = '#efe7da'

/** Warm vertical studio gradient used as scene.background */
export function makeBackgroundTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas')
  c.width = 16
  c.height = 512
  const ctx = c.getContext('2d')!
  const g = ctx.createLinearGradient(0, 0, 0, 512)
  g.addColorStop(0, '#4a4034')
  g.addColorStop(0.45, '#322b23')
  g.addColorStop(1, '#171310')
  ctx.fillStyle = g
  ctx.fillRect(0, 0, 16, 512)
  const tex = new THREE.CanvasTexture(c)
  tex.colorSpace = THREE.SRGBColorSpace
  return tex
}

/** Soft radial disc under the stand — fakes a contact shadow / grounds the scene */
export function makeGroundTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas')
  c.width = c.height = 512
  const ctx = c.getContext('2d')!
  const g = ctx.createRadialGradient(256, 256, 0, 256, 256, 256)
  g.addColorStop(0, 'rgba(88, 76, 60, 0.95)')
  g.addColorStop(0.55, 'rgba(62, 53, 42, 0.55)')
  g.addColorStop(1, 'rgba(50, 42, 34, 0)')
  ctx.fillStyle = g
  ctx.fillRect(0, 0, 512, 512)
  const tex = new THREE.CanvasTexture(c)
  tex.colorSpace = THREE.SRGBColorSpace
  return tex
}

/** Soft round alpha sprite used for spray dots */
export function makeSoftDotTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas')
  c.width = c.height = 64
  const ctx = c.getContext('2d')!
  const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32)
  g.addColorStop(0, 'rgba(255,255,255,1)')
  g.addColorStop(0.35, 'rgba(255,255,255,0.55)')
  g.addColorStop(1, 'rgba(255,255,255,0)')
  ctx.fillStyle = g
  ctx.fillRect(0, 0, 64, 64)
  return new THREE.CanvasTexture(c)
}

export interface ManikinParts {
  group: THREE.Group
  mesh: THREE.Mesh
  material: THREE.MeshStandardMaterial
  breasts: THREE.Mesh[]
  limbs: THREE.Mesh[]
}

/** Procedural tailor's dress-form torso via LatheGeometry, ~1.56 units tall, base at local y=0 */
export function buildManikin(): ManikinParts {
  const profile: Array<[number, number]> = [
    [0.001, 0.0],
    [0.26, 0.0],
    [0.315, 0.1],
    [0.335, 0.28], // hip fullest
    [0.32, 0.4],
    [0.265, 0.55],
    [0.245, 0.63], // waist
    [0.255, 0.7],
    [0.3, 0.82],
    [0.33, 0.93], // bust
    [0.325, 1.02],
    [0.28, 1.13],
    [0.21, 1.22],
    [0.15, 1.3], // shoulder
    [0.125, 1.38],
    [0.12, 1.47], // neck
    [0.115, 1.52],
    [0.09, 1.55],
    [0.001, 1.56],
  ]
  const pts = profile.map(([r, y]) => new THREE.Vector2(r, y))
  const geo = new THREE.LatheGeometry(pts, 64)
  geo.computeVertexNormals()
  const material = new THREE.MeshStandardMaterial({
    color: new THREE.Color(IVORY),
    roughness: 0.9,
    metalness: 0.02,
  })
  const mesh = new THREE.Mesh(geo, material)
  mesh.castShadow = true

  const group = new THREE.Group()
  group.add(mesh)

  // waist seam
  const seam = new THREE.Mesh(
    new THREE.TorusGeometry(0.246, 0.0045, 8, 72),
    new THREE.MeshStandardMaterial({ color: '#c4b294', roughness: 0.85 })
  )
  seam.rotation.x = Math.PI / 2
  seam.position.y = 0.65
  group.add(seam)

  // neck cap knob
  const cap = new THREE.Mesh(
    new THREE.SphereGeometry(0.05, 24, 16),
    new THREE.MeshStandardMaterial({ color: '#8a7a5f', roughness: 0.5, metalness: 0.4 })
  )
  cap.position.y = 1.59
  cap.castShadow = true
  group.add(cap)

  // feminine bust — two soft domes so the form reads clearly female (front = +z)
  const breasts: THREE.Mesh[] = []
  for (const side of [-1, 1]) {
    const dome = new THREE.Mesh(new THREE.SphereGeometry(0.16, 32, 24), material)
    dome.scale.set(1.05, 1.2, 0.9)
    dome.position.set(0.115 * side, 1.0, 0.24)
    dome.castShadow = true
    breasts.push(dome)
    group.add(dome)
  }

  // Full dancer's figure: compact waist, long articulated-looking arms and legs.
  // The forms intentionally share the fabric material so colour, lace and
  // transparency previews cover the complete garment canvas.
  const limbs: THREE.Mesh[] = []
  const addLimb = (
    geometry: THREE.BufferGeometry,
    position: [number, number, number],
    rotation: [number, number, number] = [0, 0, 0]
  ) => {
    const limb = new THREE.Mesh(geometry, material)
    limb.position.set(...position)
    limb.rotation.set(...rotation)
    limb.castShadow = true
    limbs.push(limb)
    group.add(limb)
    return limb
  }

  for (const side of [-1, 1]) {
    addLimb(new THREE.CapsuleGeometry(0.072, 0.48, 8, 18), [side * 0.37, 1.03, 0], [0, 0, side * -0.11])
    addLimb(new THREE.CapsuleGeometry(0.058, 0.43, 8, 18), [side * 0.43, 0.58, 0], [0, 0, side * -0.08])
    addLimb(new THREE.SphereGeometry(0.072, 18, 14), [side * 0.46, 0.32, 0])
    addLimb(new THREE.CapsuleGeometry(0.105, 0.62, 10, 20), [side * 0.18, -0.34, 0], [0, 0, side * -0.025])
    addLimb(new THREE.CapsuleGeometry(0.082, 0.61, 10, 20), [side * 0.2, -0.99, 0], [0, 0, side * 0.02])
    const foot = addLimb(new THREE.CapsuleGeometry(0.07, 0.19, 8, 18), [side * 0.2, -1.39, 0.075], [Math.PI / 2, 0, 0])
    foot.scale.set(1, 1, 0.75)
  }

  // Head keeps the silhouette readable while leaving the body as the design surface.
  const head = addLimb(new THREE.SphereGeometry(0.155, 28, 20), [0, 1.82, 0])
  head.scale.set(0.82, 1.08, 0.9)

  return { group, mesh, material, breasts, limbs }
}

/** Slim pole + round floor base in dark metal (not scalable with body size) */
export function buildStand(): THREE.Group {
  const g = new THREE.Group()
  const metal = new THREE.MeshStandardMaterial({ color: '#2b2622', roughness: 0.45, metalness: 0.8 })

  const base = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.36, 0.045, 48), metal)
  base.position.y = 0.0225
  base.castShadow = true
  base.receiveShadow = true

  const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 0.95, 16), metal)
  pole.position.y = 0.475
  pole.castShadow = true

  const collar = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.045, 0.05, 24), metal)
  collar.position.y = 0.93
  collar.castShadow = true

  g.add(base, pole, collar)
  return g
}

/** Recursively dispose geometries and materials of an object subtree */
export function disposeObject(root: THREE.Object3D): void {
  root.traverse((o) => {
    const mesh = o as THREE.Mesh
    if (mesh.geometry) mesh.geometry.dispose()
    const mat = mesh.material as THREE.Material | THREE.Material[] | undefined
    if (Array.isArray(mat)) mat.forEach((m) => m.dispose())
    else if (mat) mat.dispose()
  })
}
