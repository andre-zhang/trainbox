/** Shared demo tour viewport math (caption band, padded target rects). */

export const DEMO_TOUR_CAPTION_FALLBACK_PX = 220

export const DEMO_TOUR_TARGET_PAD = { top: 38, bottom: 36, left: 24, right: 28 }

export function demoTourCaptionTopPx(): number {
  const cap = document.querySelector('.demoTourCaptionInner')
  if (!cap) return window.innerHeight - DEMO_TOUR_CAPTION_FALLBACK_PX
  return cap.getBoundingClientRect().top
}

export function padClientRectForDemo(el: HTMLElement) {
  const r = el.getBoundingClientRect()
  const p = DEMO_TOUR_TARGET_PAD
  return {
    left: r.left - p.left,
    top: r.top - p.top,
    right: r.right + p.right,
    bottom: r.bottom + p.bottom,
    width: r.width + p.left + p.right,
    height: r.height + p.top + p.bottom,
  }
}
