**__TRY IT__**: [https://trainbox-kappa.vercel.app/](https://trainbox-kappa.vercel.app/)

# Trainbox

## Inspiration

I've always been into transit maps. As a kid I'd draw them on paper. Later I tried a bunch of apps (Metro Map Maker, Google Maps, Canva, whatever). They all felt too stiff and just not really about drawing a real network on a real map with the look you want.

Trainbox is the thing I wished existed: real basemap, diagram-ish workflow, and enough knobs on visuals and geometry that it feels like your map.

## What it does

- Draw lines on a real map (Leaflet + CartoDB tiles, optional lighter tile layer).
- Pull in a city from OpenStreetMap via Overpass (metro, light rail, bus, regional, national rail).
- Edit, extend, or start from scratch on top of that or on an empty map.
- Optional auto names for new stops (Nominatim reverse geocode near the pin).
- Per mode visuals: colour, weight, dashed vs solid, labels, markers.
- Five modes with their own defaults, plus express, planned styling, hide by mode.
- System map mode (read only, night theme, fullscreen).
- JSON in and out, drafts in `localStorage`, recent files list, or hosted maps if you want

## Tech stack

- React 18 + TypeScript
- Vite for dev and build
- React Router for pages
- Leaflet + react-leaflet, CartoDB basemaps
- Curve / midpoint stuff in plain TS helpers (not a full GIS stack)
- Overpass + Nominatim from the browser (throttled, cleaned up a bit on import)
- Neon Postgres + `@neondatabase/serverless` for cloud saves
- Vercel serverless `api/` routes in prod
- Three.js is in the repo (side experiments); the editor is mostly Leaflet + DOM
- ESLint + TS + react-hooks

## Challenges

### Curves

Straight segments looked cheap on a real map. Smoothing plus draggable midpoints so you can bend a leg without nudging the endpoints sounds easy; the edge cases (extend vs bend, snap, zoom) were not.

### OSM cleanup

Imports are messy: junk names, doubled routes, nodes that should be one stop, messy GTFS. There's a bunch of normalisation so you're not fixing the same boring stuff every time.

### Different cities

BBox size, density, and how hard you hit Overpass all change. Same flow has to work for a huge metro and a small system without falling over.

### Zoom and density

Dots, lines, and labels scale with zoom. If labels would turn into soup, the map bails and hides them instead of pretending it's readable.

### Station labels (wip)

Getting labels to sit nicely next to lines and other stops is the hardest UI bit. There's placement and overlap logic; it's better than nothing but still a work in progress.
