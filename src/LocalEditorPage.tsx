import { useLocation, useNavigate } from 'react-router-dom'
import TransitApp from './TransitApp'
import type { SavedMap } from './savedMapGuards'

export default function LocalEditorPage() {
  const navigate = useNavigate()
  const location = useLocation()
  const savedMap = (location.state as { savedMap?: SavedMap } | null)?.savedMap

  return (
    <TransitApp
      initialSavedMap={savedMap ?? null}
      onNavigateHome={() => navigate('/')}
    />
  )
}
