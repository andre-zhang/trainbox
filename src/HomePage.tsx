import { useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { allocateCloudMapAndUpload } from './cloudPersist'
import { parseJsonResponse, parseJsonTextLenient } from './parseJsonSafe'
import { coerceLegacySavedMap, isValidSavedMap, tryRecoverSavedMap, type SavedMap } from './savedMapGuards'
import './HomePage.css'

const MAX_LOAD_BYTES = 5 * 1024 * 1024

export default function HomePage() {
  const navigate = useNavigate()
  const fileRef = useRef<HTMLInputElement>(null)
  const [mapIdInput, setMapIdInput] = useState('')
  const [busy, setBusy] = useState<'create' | 'upload' | null>(null)
  const [error, setError] = useState<string | null>(null)

  const onCreateNew = async () => {
    setError(null)
    setBusy('create')
    try {
      const res = await fetch('/api/map/create', { method: 'POST' })
      const data = (await parseJsonResponse(res, 'Create map')) as { id?: string; error?: string }
      if (!res.ok) {
        setError(data.error || `Could not create map (${res.status})`)
        return
      }
      if (!data.id || !/^[0-9]{4}$/.test(data.id)) {
        setError('Invalid response from server')
        return
      }
      navigate(`/m/${data.id}`)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Network error — is the API running?')
    } finally {
      setBusy(null)
    }
  }

  const onLoadById = (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)
    const id = mapIdInput.replace(/\D/g, '').slice(0, 4)
    if (id.length !== 4) {
      setError('Enter a 4-digit map id')
      return
    }
    navigate(`/m/${id}`)
  }

  const onPickJson = () => fileRef.current?.click()

  const onFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    setError(null)
    if (file.size > MAX_LOAD_BYTES) {
      setError(`File is too large (max ${MAX_LOAD_BYTES / 1024 / 1024} MB).`)
      return
    }
    const reader = new FileReader()
    reader.onload = () => {
      void (async () => {
        try {
          const raw = reader.result as string
          const parsed = parseJsonTextLenient(raw, 'Map file') as unknown
          const wasStrictValid = isValidSavedMap(parsed)
          let map: SavedMap | null = wasStrictValid
            ? parsed
            : coerceLegacySavedMap(parsed) ?? tryRecoverSavedMap(parsed)
          if (!map) {
            setError('That file is not a valid Trainbox map JSON.')
            return
          }
          if (!wasStrictValid) {
            if (!window.confirm('Older or partial map format. Load and normalize?')) {
              return
            }
          }
          setBusy('upload')
          const id = await allocateCloudMapAndUpload(map)
          navigate(`/m/${id}`)
        } catch (err) {
          setError(err instanceof Error ? err.message : 'Could not read file or save to cloud.')
        } finally {
          setBusy(null)
        }
      })()
    }
    reader.readAsText(file)
  }

  return (
    <div className="homePage">
      <div className="homeCard">
        <h1 className="homeTitle">Trainbox</h1>

        {error ? <div className="homeError">{error}</div> : null}

        <div className="homeOptions">
          <button
            type="button"
            className="homeOptionBtn homeOptionBtnPrimary"
            disabled={busy !== null}
            onClick={() => void onCreateNew()}
          >
            {busy === 'create' ? 'Creating…' : 'Create new map'}
          </button>

          <button type="button" className="homeOptionBtn" disabled={busy !== null} onClick={onPickJson}>
            {busy === 'upload' ? 'Uploading…' : 'Load existing JSON'}
          </button>
          <input
            ref={fileRef}
            type="file"
            accept=".json,application/json"
            className="homeHiddenInput"
            onChange={onFile}
          />

          <form className="homeIdForm" onSubmit={onLoadById}>
            <label className="homeIdLabel" htmlFor="map-id-input">
              Load by map id
            </label>
            <div className="homeIdRow">
              <input
                id="map-id-input"
                className="homeIdInput"
                inputMode="numeric"
                maxLength={8}
                placeholder="4829"
                value={mapIdInput}
                onChange={(ev) => setMapIdInput(ev.target.value)}
                autoComplete="off"
              />
              <button type="submit" className="homeOptionBtn homeOptionBtnInline">
                Open
              </button>
            </div>
          </form>
        </div>
      </div>
    </div>
  )
}
