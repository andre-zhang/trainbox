# Trainbox

## Inspiration

I have liked transit maps since I was a kid and used to draw them on paper. Later I tried a bunch of digital tools (Metro Map Maker, Google Maps, Canva, and others). Most were either too rigid, too loose, or not really built around a real map and fine control over how the network looks.

Trainbox is the tool I wanted: a real basemap, enough structure to feel like a transit diagram, and enough control over visuals and geometry that it still feels like yours.

## What it does

- Draw transit lines on a geographic basemap (Leaflet with CartoDB tiles, plus an optional lighter simplified tile layer).
- Import an existing network from OpenStreetMap through Overpass: metro, light rail, bus, regional rail, and national rail.
- Edit, extend, or draw new lines on top of an import or from a blank map.
- Optional auto naming for new stops via Nominatim reverse geocoding (roads and neighbourhoods near the drop point).
- Visual settings per mode: line colour, weight, solid vs dashed, label font, marker fill and scale.
- Five modes (metro, light rail, bus, regional rail, national rail), each with its own defaults.
- Express stops, planned or under construction styling, and show or hide lines by mode.
- System map view: read only, optional night theme, fullscreen.
- JSON save and load, draft autosave in `localStorage`, and a short list of recent files.
- Optional cloud maps: short ids in the URL, with a small API backed by Neon Postgres when deployed.

## Tech stack

The UI is **React 18** and **TypeScript**, bundled with **Vite**. Routing uses **React Router**. The map is **Leaflet** through **react-leaflet**; tiles come from CartoDB. Curve smoothing and midpoint editing logic live in plain TypeScript helpers (Bezier style curves, snapping to polylines, etc.), not in a separate GIS engine.

Imports talk to public OSM services: **Overpass** for route data and **Nominatim** for search and reverse geocoding, with throttling and client side cleanup so results are easier to use.

Persistence for hosted maps uses **Neon** (Postgres) and the **`@neondatabase/serverless`** driver over HTTP. In production, map CRUD runs as **Vercel** serverless functions under `api/`. Local development runs **Vite** and a small **Node** HTTP shim (`tsx` + `server/map-api.ts`) so `/api` matches production behaviour behind the Vite proxy.

**Three.js** is in the dependency tree for experiments or secondary views; the core editor is still mostly Leaflet and DOM.

Linting is **ESLint** with the TypeScript and React hooks plugins.

## Challenges

### Curves

Straight station to station segments looked wrong on a real map. The app smooths paths and adds draggable midpoint handles so you can bend a leg without moving the endpoints. Small details (extend vs bend, snapping, zoom) took more iteration than the feature list suggests.

### OSM cleanup

Imported data is noisy: generic names, duplicate relations, split stops that should read as one. The import path normalises and merges where it can so you spend less time fixing obvious issues by hand.

### Different cities

Bounding boxes, density, and Overpass load vary a lot. The same import flow has to stay usable for large metros and smaller systems without timing out or returning unusable geometry.

### Zoom and density

Dot size, line weight, and label sizing react to zoom. If labels would overlap badly, the map backs off and hides them instead of stacking unreadable text.

### Station labels (in progress)

Placement and collision avoidance relative to lines and neighbours is the hardest part of the UI. There is a placement and overlap pass under the hood; it works in many cases but is still being improved.
