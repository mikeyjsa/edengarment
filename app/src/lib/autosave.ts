import type { AtelierDesignState } from '../three/engine'
import type { DrawingAction, DrawingProject } from '../components/DrawingCanvas'

const DB_NAME = 'eden-velvet-atelier'
const STORE = 'designs'
const ACTIVE_KEY = 'active-design'
const DRAWING_KEY = 'active-2d-drawing'
const PROJECT_INDEX_KEY = 'saved-project-index'
const ACTIVE_PROJECT_KEY = 'active-project-id'
const PROJECT_PREFIX = 'saved-project:'

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

export async function loadActiveDesign(): Promise<AtelierDesignState | null> {
  const db = await openDatabase()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly')
    const request = tx.objectStore(STORE).get(ACTIVE_KEY)
    request.onsuccess = () => resolve((request.result as AtelierDesignState | undefined) ?? null)
    request.onerror = () => reject(request.error)
    tx.oncomplete = () => db.close()
  })
}

export async function saveActiveDesign(state: AtelierDesignState): Promise<void> {
  const db = await openDatabase()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite')
    tx.objectStore(STORE).put(state, ACTIVE_KEY)
    tx.oncomplete = () => { db.close(); resolve() }
    tx.onerror = () => { db.close(); reject(tx.error) }
  })
}

export async function loadDrawing(): Promise<DrawingProject | DrawingAction[]> {
  const db = await openDatabase()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly')
    const request = tx.objectStore(STORE).get(DRAWING_KEY)
    request.onsuccess = () => resolve((request.result as DrawingProject | DrawingAction[] | undefined) ?? [])
    request.onerror = () => reject(request.error)
    tx.oncomplete = () => db.close()
  })
}

export async function saveDrawing(project: DrawingProject): Promise<void> {
  const db = await openDatabase()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite')
    tx.objectStore(STORE).put(project, DRAWING_KEY)
    tx.oncomplete = () => { db.close(); resolve() }
    tx.onerror = () => { db.close(); reject(tx.error) }
  })
}

async function readValue<T>(key: string): Promise<T | null> {
  const db = await openDatabase()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly')
    const request = tx.objectStore(STORE).get(key)
    request.onsuccess = () => resolve((request.result as T | undefined) ?? null)
    request.onerror = () => reject(request.error)
    tx.oncomplete = () => db.close()
  })
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
  const db = await openDatabase()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite')
    if (id) tx.objectStore(STORE).put(id, ACTIVE_PROJECT_KEY)
    else tx.objectStore(STORE).delete(ACTIVE_PROJECT_KEY)
    tx.oncomplete = () => { db.close(); resolve() }
    tx.onerror = () => { db.close(); reject(tx.error) }
  })
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
  const db = await openDatabase()
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite')
    const store = tx.objectStore(STORE)
    store.put(project, `${PROJECT_PREFIX}${id}`)
    store.put(nextIndex, PROJECT_INDEX_KEY)
    tx.oncomplete = () => { db.close(); resolve() }
    tx.onerror = () => { db.close(); reject(tx.error) }
  })
  return project
}

export async function deleteSavedProject(id: string): Promise<void> {
  const index = await listSavedProjects()
  const db = await openDatabase()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite')
    const store = tx.objectStore(STORE)
    store.delete(`${PROJECT_PREFIX}${id}`)
    store.put(index.filter((item) => item.id !== id), PROJECT_INDEX_KEY)
    tx.oncomplete = () => { db.close(); resolve() }
    tx.onerror = () => { db.close(); reject(tx.error) }
  })
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
