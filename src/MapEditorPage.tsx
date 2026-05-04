import { useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import TransitApp from './TransitApp'
import { isValidSavedMap, tryRecoverSavedMap, type SavedMap } from './savedMapGuards'
import './HomePage.css'

type LoadState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ok'; data: SavedMap }

export default function MapEditorPage() {
  const { mapId } = useParams()
  const navigate = useNavigate()
  const [state, setState] = useState<LoadState>({ status: 'loading' })

  useEffect(() => {
    if (!mapId || !/^[0-9]{4}$/.test(mapId)) {
      setState({ status: 'error', message: 'Invalid map id in URL.' })
      return
    }
    let cancelled = false
    ;(async () => {
      try {
        const res = await fetch(`/api/map/${mapId}`)
        const text = await res.text()
        if (cancelled) return
        if (!res.ok) {
          setState({
            status: 'error',
            message:
              res.status === 404
                ? 'No map found for that id. Check the digits or create a new map from home.'
                : `Could not load map (${res.status}).`,
          })
          return
        }
        let parsed: unknown
        try {
          parsed = JSON.parse(text)
        } catch {
          setState({ status: 'error', message: 'Server returned invalid JSON.' })
          return
        }
        if (isValidSavedMap(parsed)) {
          setState({ status: 'ok', data: parsed })
          return
        }
        const recovered = tryRecoverSavedMap(parsed)
        if (recovered) {
          setState({ status: 'ok', data: recovered })
          return
        }
        setState({ status: 'error', message: 'Stored map data is not usable.' })
      } catch (e) {
        if (!cancelled) {
          setState({
            status: 'error',
            message: e instanceof Error ? e.message : 'Network error while loading the map.',
          })
        }
      }
    })()
    return () => {
      cancelled = true
    }
  }, [mapId])

  if (state.status === 'loading') {
    return (
      <div className="homePage">
        <div className="homeCard homeCardNarrowMsg">
          <p className="homeLoadingText">Loading map…</p>
        </div>
      </div>
    )
  }

  if (state.status === 'error') {
    return (
      <div className="homePage">
        <div className="homeCard">
          <h2 className="homeTitle" style={{ fontSize: '1.15rem' }}>
            Could not open map
          </h2>
          <p className="homeSubtitle" style={{ marginBottom: 20 }}>
            {state.message}
          </p>
          <button type="button" className="homeOptionBtn homeOptionBtnPrimary" onClick={() => navigate('/')}>
            Back to home
          </button>
        </div>
      </div>
    )
  }

  return (
    <TransitApp
      key={mapId}
      cloudMapId={mapId!}
      initialSavedMap={state.data}
      onNavigateHome={() => navigate('/')}
    />
  )
}
