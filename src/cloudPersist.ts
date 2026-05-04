import type { SavedMap } from './savedMapGuards'
import { parseJsonResponse, parseJsonText } from './parseJsonSafe'

const MIN_READER_VERSION = 2

export function toPersistPayload(map: SavedMap): Record<string, unknown> {
  return {
    version: map.version,
    minReaderVersion: MIN_READER_VERSION,
    stations: map.stations,
    lines: map.lines,
    stationLabelOverrides: map.stationLabelOverrides ?? {},
  }
}

/** Creates a new cloud map id and uploads the given snapshot. */
export async function allocateCloudMapAndUpload(map: SavedMap): Promise<string> {
  const res = await fetch('/api/map/create', { method: 'POST' })
  const json = (await parseJsonResponse(res, 'Create map')) as { id?: string; error?: string }
  if (!res.ok) {
    throw new Error(json.error || `Create failed (${res.status})`)
  }
  if (!json.id || !/^[0-9]{4}$/.test(json.id)) {
    throw new Error('Invalid create response')
  }
  const put = await fetch(`/api/map/${json.id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(toPersistPayload(map)),
  })
  const putText = await put.text()
  let putJson: { error?: string } = {}
  if (putText.trim()) {
    try {
      putJson = parseJsonText(putText, 'Save map') as { error?: string }
    } catch {
      putJson = { error: putText.slice(0, 200) }
    }
  }
  if (!put.ok) {
    throw new Error(putJson.error || `Upload failed (${put.status})`)
  }
  return json.id
}
