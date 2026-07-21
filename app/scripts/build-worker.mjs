import { cp, mkdir, readdir, writeFile } from 'node:fs/promises'

const dist = new URL('../dist/', import.meta.url)
const client = new URL('../dist/client/', import.meta.url)
const hostingSource = new URL('../.openai/hosting.json', import.meta.url)
const hostingTarget = new URL('../dist/.openai/hosting.json', import.meta.url)

await mkdir(client, { recursive: true })
for (const entry of await readdir(dist, { withFileTypes: true })) {
  if (entry.name === 'client' || entry.name === 'server' || entry.name === '.openai') continue
  await cp(new URL(entry.name, dist), new URL(entry.name, client), { recursive: entry.isDirectory() })
}

await mkdir(new URL('../dist/server/', import.meta.url), { recursive: true })
await mkdir(new URL('../dist/.openai/', import.meta.url), { recursive: true })
await cp(hostingSource, hostingTarget)
await writeFile(
  new URL('../dist/server/index.js', import.meta.url),
  `export default {
  async fetch(request, env) {
    const response = await env.ASSETS.fetch(request)
    if (response.status !== 404 || request.method !== 'GET') return response
    const url = new URL(request.url)
    if (!request.headers.get('accept')?.includes('text/html')) return response
    url.pathname = '/index.html'
    return env.ASSETS.fetch(new Request(url, request))
  },
}
`
)
