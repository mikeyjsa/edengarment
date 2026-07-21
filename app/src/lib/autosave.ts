import type { AtelierDesignState } from '../three/engine'
import type { DrawingAction, DrawingProject } from '../components/DrawingCanvas'

const DB_NAME = 'eden-velvet-atelier'
const STORE = 'designs'
const ACTIVE_KEY = 'active-design'
const DRAWING_KEY = 'active-2d-drawing'
const PROJECT_INDEX_KEY = 'saved-project-index'
const ACTIVE_PROJECT_KEY = 'active-project-id'
const PROJECT_PREFIX = 'saved-project:'
const VAULT_KEY = 'eden-velvet-vault-id'

export interface SavedProjectSummary {
  id: string
  name: string
  createdAt: string
  updatedAt: string
}

export interface SavedAtelierProject extends SavedProjectSummary {
  format: 'eden-velvet-project'
  version: 1
  design: AtelierDesignState
  drawing: DrawingProject
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1)
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE)
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

async function readLocalValue<T>(key: string): Promise<T | null> {
  const db = await openDatabase()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly')
    const request = tx.objectStore(STORE).get(key)
    request.onsuccess = () => resolve((request.result as T | undefined) ?? null)
    request.onerror = () => reject(request.error)
    tx.oncomplete = () => db.close()
  })
}

async function writeLocalValue<T>(key: string, value: T): Promise<void> {
  const db = await openDatabase()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite')
    tx.objectStore(STORE).put(value, key)
    tx.oncomplete = () => { db.close(); resolve() }
    tx.onerror = () => { db.close(); reject(tx.error) }
  })
}

async function deleteLocalValue(key: string): Promise<void> {
  const db = await openDatabase()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite')
    tx.objectStore(STORE).delete(key)
    tx.oncomplete = () => { db.close(); resolve() }
    tx.onerror = () => { db.close(); reject(tx.error) }
  })
}

function getVaultId(): string | null {
  if (typeof window === 'undefined' || !window.localStorage) return null
  let id = window.localStorage.getItem(VAULT_KEY)
  if (!id) {
    id = globalThis.crypto?.randomUUID?.().replaceAll('-', '') ||
      `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`
    window.localStorage.setItem(VAULT_KEY, id)
  }
  return id
}

type CloudRead<T> = { available: boolean; found: boolean; value: T | null }

function cloudRequest(key: string, init?: RequestInit): Promise<Response> | null {
  if (typeof window === 'undefined' || !/^https?:$/.test(window.location.protocol)) return null
  const vaultId = getVaultId()
  if (!vaultId) return null
  return fetch(`/api/storage/${encodeURIComponent(key)}`, {
    ...init,
    headers: { 'X-Eden-Vault': vaultId, ...(init?.headers || {}) },
  })
}

async function readCloudValue<T>(key: string): Promise<CloudRead<T>> {
  try {
    const request = cloudRequest(key, { method: 'GET', cache: 'no-store' })
    if (!request) return { available: false, found: false, value: null }
    const response = await request
    if (!response.headers.get('content-type')?.includes('application/json')) {
      return { available: false, found: false, value: null }
    }
    if (response.status === 404) return { available: true, found: false, value: null }
    if (!response.ok) return { available: true, found: false, value: null }
    return { available: true, found: true, value: await response.json() as T }
  } catch {
    return { available: false, found: false, value: null }
  }
}

async function writeCloudValue<T>(key: string, value: T): Promise<boolean> {
  try {
    const request = cloudRequest(key, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(value),
    })
    return request ? (await request).ok : false
  } catch {
    return false
  }
}

async function deleteCloudValue(key: string): Promise<boolean> {
  try {
    const request = cloudRequest(key, { method: 'DELETE' })
    return request ? (await request).ok : false
  } catch {
    return false
  }
}

async function readValue<T>(key: string): Promise<T | null> {
  const cloud = await readCloudValue<T>(key)
  if (cloud.found) {
    await writeLocalValue(key, cloud.value)
    return cloud.value
  }
  const local = await readLocalValue<T>(key)
  if (local !== null && cloud.available) void writeCloudValue(key, local)
  return local
}

async function writeValue<T>(key: string, value: T): Promise<void> {
  await writeLocalValue(key, value)
  await writeCloudValue(key, value)
}

async function deleteValue(key: string): Promise<void> {
  await deleteLocalValue(key)
  await deleteCloudValue(key)
}

export async function loadActiveDesign(): Promise<AtelierDesignState | null> {
  return readValue<AtelierDesignState>(ACTIVE_KEY)
}

export async function saveActiveDesign(state: AtelierDesignState): Promise<void> {
  return writeValue(ACTIVE_KEY, state)
}

export async function loadDrawing(): Promise<DrawingProject | DrawingAction[]> {
  return (await readValue<DrawingProject | DrawingAction[]>(DRAWING_KEY)) ?? []
}

export async function saveDrawing(project: DrawingProject): Promise<void> {
  return writeValue(DRAWING_KEY, project)
}

export async function listSavedProjects(): Promise<SavedProjectSummary[]> {
  return (await readValue<SavedProjectSummary[]>(PROJECT_INDEX_KEY)) ?? []
}

export async function loadSavedProject(id: string): Promise<SavedAtelierProject | null> {
  return readValue<SavedAtelierProject>(`${PROJECT_PREFIX}${id}`)
}

export async function loadActiveProjectId(): Promise<string | null> {
  return readValue<string>(ACTIVE_PROJECT_KEY)
}

export async function setActiveProjectId(id: string | null): Promise<void> {
  if (id) await writeValue(ACTIVE_PROJECT_KEY, id)
  else await deleteValue(ACTIVE_PROJECT_KEY)
}

export async function saveNamedProject(
  name: string,
  design: AtelierDesignState,
  drawing: DrawingProject,
  existingId?: string,
): Promise<SavedAtelierProject> {
  const id = existingId || globalThis.crypto?.randomUUID?.() || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
  const existing = existingId ? await loadSavedProject(existingId) : null
  const now = new Date().toISOString()
  const project: SavedAtelierProject = {
    format: 'eden-velvet-project',
    version: 1,
    id,
    name: name.trim() || 'Untitled Design',
    createdAt: existing?.createdAt || now,
    updatedAt: now,
    design: structuredClone(design),
    drawing: structuredClone(drawing),
  }
  const index = await listSavedProjects()
  const summary: SavedProjectSummary = { id, name: project.name, createdAt: project.createdAt, updatedAt: now }
  const nextIndex = [summary, ...index.filter((item) => item.id !== id)]
  await Promise.all([
    writeValue(`${PROJECT_PREFIX}${id}`, project),
    writeValue(PROJECT_INDEX_KEY, nextIndex),
  ])
  return project
}

export async function deleteSavedProject(id: string): Promise<void> {
  const index = await listSavedProjects()
  await Promise.all([
    deleteValue(`${PROJECT_PREFIX}${id}`),
    writeValue(PROJECT_INDEX_KEY, index.filter((item) => item.id !== id)),
  ])
}

export function isSavedAtelierProject(value: unknown): value is SavedAtelierProject {
  if (!value || typeof value !== 'object') return false
  const project = value as Partial<SavedAtelierProject>
  return project.format === 'eden-velvet-project' &&
    project.version === 1 &&
    typeof project.name === 'string' &&
    project.design?.version === 1 &&
    Array.isArray(project.design.items) &&
    project.drawing?.version === 2 &&
    Boolean(project.drawing.views)
}
