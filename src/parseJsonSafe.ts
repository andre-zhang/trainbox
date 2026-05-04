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

/**
 * Parse JSON from an HTTP response body. Servers often return **plain text** or HTML on error
 * (e.g. "A server error…", Vercel diagnostics) — do not require a leading `{`.
 */
export async function parseJsonResponse(res: Response, label = 'Server'): Promise<unknown> {
  const text = await res.text()
  const s = stripJsonBom(text).trim()
  if (!s) {
    throw new Error(
      `${label} (${res.status}): empty body — set DATABASE_URL on the server, or run \`npm run dev\` locally (not dev:vite-only).`,
    )
  }
  const c = s[0]
  if (c === '{' || c === '[') {
    try {
      return JSON.parse(s)
    } catch (e) {
      const msg = e instanceof SyntaxError ? e.message : String(e)
      throw new Error(`${label}: ${msg}`)
    }
  }
  const head = s.slice(0, 500).replace(/\s+/g, ' ')
  if (head.startsWith('<!') || head.toLowerCase().startsWith('<html')) {
    throw new Error(
      `${label} (${res.status}): got HTML, not JSON — the /api route may be missing on this deploy.`,
    )
  }
  throw new Error(`${label} (${res.status}, not JSON): ${head}`)
}

/**
 * Parse a user file: trim/BOM, then if junk appears before `{`/`[` (rare exports), skip to first `{` or `[`.
 */
export function parseJsonTextLenient(text: string, label = 'JSON'): unknown {
  let s = stripJsonBom(text).trim()
  if (!s) {
    throw new Error(`${label}: empty`)
  }
  if (s[0] !== '{' && s[0] !== '[') {
    const brace = s.indexOf('{')
    const bracket = s.indexOf('[')
    const idxs = [brace, bracket].filter((i) => i >= 0)
    const idx = idxs.length > 0 ? Math.min(...idxs) : -1
    if (idx > 0 && idx < 4096) {
      s = s.slice(idx).trimStart()
    }
  }
  return parseJsonText(s, label)
}
