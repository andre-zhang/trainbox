/** Small inline SVGs for Trainbox toolbar (icon + label) */

export function IconPan({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
      <path d="M12 2v4M12 18v4M4 12H2M22 12h-2" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  )
}

export function IconStation({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
      <circle cx="12" cy="12" r="8" />
      <path d="M12 8v8M8 12h8" />
    </svg>
  )
}

export function IconLine({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
      <path d="M4 18c2-4 6-6 8-8s4-4 4-8" />
      <circle cx="4" cy="18" r="2" fill="currentColor" stroke="none" />
      <circle cx="16" cy="10" r="2" fill="currentColor" stroke="none" />
    </svg>
  )
}

export function IconEditLine({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
      <path d="M4 12h16M4 12l3-3M4 12l3 3M20 12l-3-3M20 12l-3 3" />
      <circle cx="8" cy="12" r="2" />
      <circle cx="16" cy="12" r="2" />
    </svg>
  )
}

export function IconUndo({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
      <path d="M9 14L4 9l5-5" />
      <path d="M4 9h10.5a6 6 0 0 1 6 6v0" />
    </svg>
  )
}

export function IconRedo({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
      <path d="M15 14l5-5-5-5" />
      <path d="M20 9H9.5a6 6 0 0 0-6 6v0" />
    </svg>
  )
}
