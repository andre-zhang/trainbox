/** Strip UTF-8 BOM so JSON.parse accepts the payload. */
export function stripJsonBom(text: string): string {
  return text.replace(/^\uFEFF/, '')
}

/**
 * Parse JSON from a string (file body or API text). Clear errors for empty / HTML / garbage prefixes.
 */
export function parseJsonText(text: string, label = 'JSON'): unknown {
  const s = stripJsonBom(text).trim()
  if (!s) {
    throw new Error(`${label}: empty`)
  }
  const c = s[0]
  if (c !== '{' && c !== '[') {
    const head = s.slice(0, 160).replace(/\s+/g, ' ')
    if (head.startsWith('<!') || head.toLowerCase().startsWith('<html')) {
      throw new Error(
        `${label}: got a web page instead of JSON — check that /api is running (dev: run npm run dev, not dev:vite-only).`,
      )
    }
    throw new Error(`${label}: must start with { or [, got "${c}"`)
  }
  try {
    return JSON.parse(s)
  } catch (e) {
    const msg = e instanceof SyntaxError ? e.message : String(e)
    throw new Error(`${label}: ${msg}`)
  }
}

/** Read `Response` as text and parse JSON (never use raw res.json() when the server might return HTML). */
export async function parseJsonResponse(res: Response, label = 'Server'): Promise<unknown> {
  const text = await res.text()
  return parseJsonText(text, label)
}
