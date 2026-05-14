# Trainbox

**Try it:** [https://trainbox-kappa.vercel.app/](https://trainbox-kappa.vercel.app/)

## Inspiration

I drew fake transit maps as a kid and kept looking for a serious editor as an adult. Most tools were either pure diagramming with no geography, or generic map drawing with no transit workflow. Trainbox sits in the middle: real coordinates and basemap, plus line lists, modes, and styling that match how you think about a network.

## What it does

Single page app with routes `/` (home), `/m/:mapId` (cloud map by 4 digit id), and `/local` (editor without cloud).

**Editing**

- Map tools: pan, place stations, connect stations into a line in order, and edit line mode (drag stops, drag midpoint handles to bend segments or extend from ends, optional segment click to infill when that flag is on).
- Per line: colour, weight, dash pattern, mode tag (metro, light rail, bus, regional rail, national rail), optional express subset of stops, planned styling.
- Optional Bézier style waypoints stored per segment; render path switches between smooth polylines through stops only vs piecewise quadratic when waypoints exist.
- Undo and redo with a bounded stack; depth shrinks on very large maps so memory stays predictable.
- Sidebar validation for orphans, empty lines, duplicate stop names, and lines referencing missing stop ids, plus grouped line list by mode (sorted by name within each group).

**Data in and out**

- Save and load JSON; tolerant parsing for older export shapes when you upload.
- Draft autosave in `localStorage` and a small recent files list.
- Optional hosted maps: POST allocates an id, client PUTs the map JSON, debounced autosave while you edit.

**Import**

- Overpass driven import for a chosen bbox or place; filters by transit mode flags you set before running.
- Merge into an existing map can surface a conflict modal (similar or duplicate geometry vs existing lines) with per row overrides before commit.

**Viewing**

- System map view: same geometry, read only UI, optional night palette and fullscreen. On narrow viewports the app stays in that view and tucks a few toggles behind a compact menu so touch layout does not run the full editor chrome.

**Other**

- Optional reverse geocode naming for new stops (Nominatim, rate limited on the client). Some cleanup reads `gtfs:*` style tags when mappers mirrored feed data onto OSM nodes; there is no separate GTFS file import.
- Guided demo tour for onboarding (optional, lives in the editor bundle).

## Tech stack

- React 18, TypeScript, Vite
- React Router (`/`, `/m/:mapId`, `/local`)
- Leaflet + react-leaflet, CartoDB raster tiles (default and simplified variant)
- Curve and intersection math in `src/utils/curve.ts` (Catmull style smoothing, quadratic legs, closest point on polyline)
- Overpass + Nominatim from the browser; import and merge logic in `src/transitOsmImport.ts`
- Cloud API: Vercel functions under `api/`, Neon Postgres via `@neondatabase/serverless`
- Local dev: Vite proxy to `server/map-api.ts` (tsx) so `/api` matches production behaviour
- Three.js is a dependency for experiments; the shipped editor is Leaflet and DOM
- ESLint, TypeScript strict, react-hooks rules

## Challenges (implementation)

**Curve geometry and edit handles**

Rendering uses dense sampled polylines so lines look smooth at city scale. Edit handles must sit on that geometry, not only on straight chords between stops. Midpoint markers snap to the polyline, waypoints store implicit quadratic controls, and one drag handler has to distinguish extend from terminus, bend only, and infill when enabled. Short final segments can stack handles; we dedupe when two handles would land on top of each other.

**OSM import and merge**

Overpass returns noisy relations and duplicate variants of the same service. The pipeline filters routes, normalises stop geometry and naming (including noisy or placeholder names and occasional `gtfs:*` tags on nodes), and merges into live state. Conflict detection runs in chunks so the UI stays responsive on big imports; resolving conflicts is a second step with explicit user choices instead of silent data loss.

**Leaflet inside React**

Vectors and hit targets use separate Leaflet panes with fixed z order. Station hit areas use geodesic circles while edit handles use markers. Popups and controls call `stopPropagation` so clicks do not fall through to the map and create accidental edits. Tour overlays portal outside the map subtree so they do not fight Leaflet layout.

**Station labels**

Labels are Leaflet tooltips with manual offsets and rotations per stop. Placement runs in screen space with a small overlap solver and clamped nudges; if overlap is still bad at the current zoom the layer turns labels off instead of drawing unreadable stacks. Manual overrides bypass auto placement. Still the weakest area and ongoing work.

**Client state and persistence**

History is copy on write snapshots of stations, lines, and label overrides. Cloud saves debounce edits and share one JSON schema with local files; older files need coercion helpers before validation. Routing ties draft storage keys to `mapId` so two tabs do not clobber each other.
