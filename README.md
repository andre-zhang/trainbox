# Trainbox

**Try it:** [https://trainbox-kappa.vercel.app/](https://trainbox-kappa.vercel.app/)

## Inspiration

I drew fake transit maps as a kid and never really stopped wanting a proper editor for it. The tools I tried over the years usually sat at one extreme or the other: either a schematic canvas with no real geography, or a generic map where transit felt like an afterthought. Trainbox is meant to sit between those: you work on a real basemap and real coordinates, but the workflow still feels like building a network (lines, modes, how it reads on the page) rather than doodling shapes.

## What it does

- Start from the home screen: new blank map, load a JSON file you already have, or open a map you saved online with a short numeric code. If you do not want cloud saves, you can keep the whole session in the browser only.
- Editing uses a small set of tools: pan the map, place stations, connect stations into a line in order, or line-edit mode where you drag stops and use the blue handles to bend a segment or extend from an end.
- Optional behaviour for adding a stop mid-line: you can drive it from segment clicks vs handle drags depending on a toggle, so infill and reshaping do not fight each other.
- Each line keeps its own colour, thickness, dashed or solid style, and one of five transit modes (metro, light rail, bus, regional rail, national rail). You can mark express-only stops on a line, mark a line as planned, and show or hide whole mode groups on the map.
- Lines are drawn as smooth curves rather than straight station-to-station segments; you can still adjust the path with handles without nudging every stop.
- Undo and redo cover recent work; on very large maps the history is shorter so the tab stays responsive.
- The sidebar groups lines by mode (names sorted within each group) and flags simple issues: stops not on any line, empty lines, duplicate stop names, and lines that reference a missing stop.
- Import a city’s network from OpenStreetMap: pick the area, choose which modes to pull in, then merge into your map. Re-importing can open a review step when a new route looks too close to something you already drew, so you merge or skip per row instead of overwriting blindly.
- System map mode is read-only: same network, less chrome, optional night theme and fullscreen. On a phone-sized screen the app stays in that view and puts a few controls in a small menu so the map stays usable without the full editor layout.
- Save and share as JSON; the app also keeps a draft in the browser and a short recent-files list. Online maps autosave while you edit.
- New stops can optionally get a suggested name from nearby map context. A short guided tour is there if you want a first-time walkthrough.

## Tech stack

- React 18, TypeScript, Vite
- React Router: `/`, `/m/:mapId`, `/local`
- Leaflet + react-leaflet, CartoDB raster tiles (default and simplified variant)
- Curve and intersection math in `src/utils/curve.ts` (Catmull style smoothing, quadratic legs when waypoints exist, closest point on polyline for handle placement)
- Overpass + Nominatim from the browser; import and merge in `src/transitOsmImport.ts` (chunked conflict detection, normalisation including noisy names and `gtfs:*` tags on OSM nodes where present; no separate GTFS file ingest)
- Cloud map CRUD: Vercel serverless `api/`, Neon Postgres via `@neondatabase/serverless`
- Three.js in the dependency tree for experiments; production editor is Leaflet + DOM
- ESLint, TypeScript strict, react-hooks rules

## Challenges (implementation)

**Curve geometry and edit handles**

Rendering relies on dense sampled polylines so lines read well at city scale, which means edit handles have to snap to the rendered path, not just to straight chords between stations. Waypoints store implicit quadratic controls, the smooth path switches between a single Catmull style chain and piecewise quadratics when those controls exist, and one drag end handler has to tell extend-from-terminus apart from bend-only and from optional infill. When the last segment is very short, two handles can end up on top of each other, so there is an explicit dedupe pass.

**OSM import and merge**

Overpass output is noisy: duplicate relations, variants of the same service, placeholder names. The importer filters and normalises before merge, then runs conflict detection in chunks so large cities do not freeze the UI; the modal path is deliberate so users resolve ambiguity instead of the app guessing.

**Leaflet inside React**

Map vectors, station hit discs, and handle markers live in separate Leaflet panes with a fixed stacking order. Popups and form controls stop pointer events from leaking to the map (otherwise a dismissed dialog still drops a station). The demo tour renders through a portal so it does not fight Leaflet’s layout and z-index.

**Station labels**

Labels are Leaflet tooltips with per-stop offsets and rotations. A small screen-space overlap pass nudges automatic placement; if overlap is still bad at the current zoom, labels hide rather than stacking into noise. Manual overrides skip auto placement. This is the roughest subsystem and still active work.

**Client state and persistence**

Undo history stores snapshots of stations, lines, and label overrides with a cap that tightens on huge maps. Cloud saves debounce PUTs and reuse the same JSON shape as file export; older files go through coercion before validation. Draft keys are scoped by cloud map id so parallel tabs do not overwrite each other’s drafts.
