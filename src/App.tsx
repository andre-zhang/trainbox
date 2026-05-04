import { Component, type ErrorInfo, type ReactNode } from 'react'
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'
import './App.css'
import HomePage from './HomePage'
import LocalEditorPage from './LocalEditorPage'
import MapEditorPage from './MapEditorPage'

type BoundaryProps = { children: ReactNode }
type BoundaryState = { error: Error | null }

class AppErrorBoundary extends Component<BoundaryProps, BoundaryState> {
  state: BoundaryState = { error: null }

  static getDerivedStateFromError(error: Error): BoundaryState {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('App render error', error, info.componentStack)
  }

  render() {
    if (this.state.error) {
      return (
        <div
          style={{
            padding: 24,
            fontFamily: '"Open Sans", system-ui, sans-serif',
            maxWidth: 520,
            margin: '10vh auto',
          }}
        >
          <h1 style={{ fontSize: 18, margin: '0 0 12px' }}>Something went wrong</h1>
          <p style={{ color: '#64748b', fontSize: 14, margin: '0 0 16px' }}>
            {this.state.error.message}
          </p>
          <button
            type="button"
            onClick={() => window.location.reload()}
            style={{
              padding: '8px 14px',
              fontSize: 14,
              cursor: 'pointer',
              borderRadius: 8,
              border: '1px solid #cbd5e1',
              background: '#f8fafc',
            }}
          >
            Reload page
          </button>
        </div>
      )
    }
    return this.props.children
  }
}

export default function App() {
  return (
    <AppErrorBoundary>
      <BrowserRouter>
        <Routes>
          <Route path="/" element={<HomePage />} />
          <Route path="/m/:mapId" element={<MapEditorPage />} />
          <Route path="/local" element={<LocalEditorPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </BrowserRouter>
    </AppErrorBoundary>
  )
}
