# Trainbox

**Try it:** [https://trainbox-kappa.vercel.app/](https://trainbox-kappa.vercel.app/)

## Inspiration

I drew fake transit maps as a kid and never really stopped wanting a proper editor for it. The tools I tried over the years usually sat at one extreme or the other: either a schematic canvas with no real geography, or a generic map where transit felt like an afterthought. Trainbox is meant to sit between those: you work on a real basemap and real coordinates, but the workflow still feels like building a network (lines, modes, how it reads on the page) rather than doodling shapes.

## What it does

From the home screen you can start a blank map, load a JSON file you already have, or open one you saved online using a short numeric code. If you prefer not to use cloud saves at all, there is a path that keeps the session in the browser only.

While you edit, you switch between a few tools: move the map, drop stations, string stations into a line in order, or enter line edit mode where you drag stops and use the blue handles to bend a segment or extend the route from an end. There is an optional mode where adding a stop in the middle of a segment works differently (segment click vs handle drag), so you can pick the behaviour you want. Lines remember their own colour, thickness, dashed or solid style, and which of the five transit modes they belong to. You can mark some stops as express-only on a line, flag a line as planned, and show or hide whole mode groups on the map.

Curves are smoothed along the line so it does not look like a ruler diagram; you can still nudge the path with handles without moving every station. Undo and redo cover recent edits, and on very large maps the app keeps a shorter history so the tab stays responsive. The sidebar groups lines by mode (with names sorted inside each group) and surfaces simple sanity checks: stops that are not on any line, lines with no stops yet, duplicate stop names, and lines that point at a missing stop.

You can pull a city’s transit network in from OpenStreetMap: pick the area, choose which modes to include, and import. If you already have a map and import again, you may get a review screen when an incoming route looks too close to something you already drew, so you can merge or skip per row instead of silently overwriting.

For viewing only, switch to system map mode: same network, no editing chrome, optional night colours and fullscreen. On a phone-sized screen the app stays in that read-only view and hides the full editor behind a small menu so the map stays usable.

Saving is a JSON document you can file away or send to someone; the app also keeps a draft in the browser and a short list of recent files. If you use online maps, edits autosave to that copy while you work. New stops can optionally pick up a suggested name from what is around them on the map. There is also a short guided tour if you want a walkthrough the first time.

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
