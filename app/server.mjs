import http from 'node:http'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { access, mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { constants as fsConstants } from 'node:fs'
import { fileURLToPath } from 'node:url'

const appDir = path.dirname(fileURLToPath(import.meta.url))
const staticDir = path.join(appDir, 'dist')
const port = Number(process.env.PORT || 3000)
const maxBodyBytes = 80 * 1024 * 1024

async function resolveDataRoot() {
  const preferred = process.env.DATA_DIR || '/data/eden-velvet'
  try {
    await mkdir(preferred, { recursive: true })
    await access(preferred, fsConstants.R_OK | fsConstants.W_OK)
    return preferred
  } catch {
    const fallback = path.join(appDir, '.data', 'eden-velvet')
    await mkdir(fallback, { recursive: true })
    return fallback
  }
}

const dataRoot = await resolveDataRoot()
const mimeTypes = new Map([
  ['.html', 'text/html; charset=utf-8'], ['.js', 'text/javascript; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'], ['.json', 'application/json; charset=utf-8'],
  ['.svg', 'image/svg+xml'], ['.png', 'image/png'], ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'], ['.webp', 'image/webp'], ['.ico', 'image/x-icon'],
  ['.glb', 'model/gltf-binary'], ['.woff2', 'font/woff2'],
])

function json(response, status, value) {
  const body = JSON.stringify(value)
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body), 'Cache-Control': 'no-store' })
  response.end(body)
}

function storageTarget(request, pathname) {
  const vault = request.headers['x-eden-vault']
  let key = ''
  try { key = decodeURIComponent(pathname.slice('/api/storage/'.length)) } catch { return null }
  if (typeof vault !== 'string' || !/^[A-Za-z0-9_-]{20,100}$/.test(vault)) return null
  if (!key || key.length > 180 || !/^[A-Za-z0-9:._-]+$/.test(key)) return null
  return path.join(dataRoot, vault, `${Buffer.from(key).toString('base64url')}.json`)
}

async function readBody(request) {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > maxBodyBytes) throw Object.assign(new Error('body too large'), { status: 413 })
    chunks.push(chunk)
  }
  return Buffer.concat(chunks).toString('utf8')
}

async function handleStorage(request, response, pathname) {
  const target = storageTarget(request, pathname)
  if (!target) return json(response, 400, { error: 'Invalid vault or storage key' })
  if (request.method === 'GET') {
    try {
      const body = await readFile(target)
      response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': body.length, 'Cache-Control': 'no-store' })
      return response.end(body)
    } catch (error) {
      if (error?.code === 'ENOENT') return json(response, 404, { error: 'Not found' })
      throw error
    }
  }
  if (request.method === 'PUT') {
    const raw = await readBody(request)
    let value
    try { value = JSON.parse(raw) } catch { return json(response, 400, { error: 'Invalid JSON' }) }
    await mkdir(path.dirname(target), { recursive: true })
    const temporary = `${target}.${randomUUID()}.tmp`
    await writeFile(temporary, JSON.stringify(value), { mode: 0o600 })
    await rename(temporary, target)
    return json(response, 200, { saved: true })
  }
  if (request.method === 'DELETE') {
    try { await unlink(target) } catch (error) { if (error?.code !== 'ENOENT') throw error }
    return json(response, 200, { deleted: true })
  }
  response.writeHead(405, { Allow: 'GET, PUT, DELETE' })
  response.end()
}

async function serveStatic(request, response, pathname) {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    response.writeHead(405)
    return response.end()
  }
  let requestedPath
  try { requestedPath = decodeURIComponent(pathname) } catch { requestedPath = '/' }
  const candidate = path.resolve(staticDir, `.${requestedPath}`)
  let file = candidate.startsWith(`${staticDir}${path.sep}`) ? candidate : path.join(staticDir, 'index.html')
  try {
    const info = await stat(file)
    if (info.isDirectory()) file = path.join(file, 'index.html')
    await access(file, fsConstants.R_OK)
  } catch {
    file = path.join(staticDir, 'index.html')
  }
  const body = await readFile(file)
  response.writeHead(200, {
    'Content-Type': mimeTypes.get(path.extname(file).toLowerCase()) || 'application/octet-stream',
    'Content-Length': body.length,
    'Cache-Control': pathname.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache',
  })
  response.end(request.method === 'HEAD' ? undefined : body)
}

const server = http.createServer(async (request, response) => {
  try {
    const pathname = new URL(request.url || '/', 'http://localhost').pathname
    if (pathname === '/api/health') return json(response, 200, { ok: true, persistent: dataRoot.startsWith('/data/') })
    if (pathname.startsWith('/api/storage/')) return await handleStorage(request, response, pathname)
    return await serveStatic(request, response, pathname)
  } catch (error) {
    console.error('[eden-storage] request failed', error)
    return json(response, error?.status || 500, { error: error?.status === 413 ? 'Design is too large' : 'Storage request failed' })
  }
})

server.listen(port, '0.0.0.0', () => {
  console.log(`[eden-storage] listening on ${port}; data root: ${dataRoot}`)
})
