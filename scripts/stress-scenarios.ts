import { performance } from 'node:perf_hooks'
import {
  postProcessImportedNetwork,
  mergeImportIntoMap,
  findImportLineConflicts,
  UNNAMED_STOP_PLACEHOLDER,
} from '../src/transitOsmImport'

function makeStations(count: number, lat0 = 43.6532, lng0 = -79.3832, step = 0.00035, unnamedEvery = 0, nameMod = 300) {
  const out: Array<{ id: string; name: string; position: { lat: number; lng: number } }> = []
  const side = Math.ceil(Math.sqrt(count))
  for (let i = 0; i < count; i++) {
    const row = Math.floor(i / side)
    const col = i % side
    out.push({
      id: `s-${i}`,
      name: unnamedEvery > 0 && i % unnamedEvery === 0 ? UNNAMED_STOP_PLACEHOLDER : `Station ${i % Math.max(1, nameMod)}`,
      position: { lat: lat0 + row * step, lng: lng0 + col * step },
    })
  }
  return out
}

function makeLines(stations: Array<{ id: string }>, lineCount: number, span = 22) {
  const out: Array<{ id: string; name: string; color: string; stationIds: string[]; mode: 'metro' | 'regional_rail' }> =
    []
  for (let i = 0; i < lineCount; i++) {
    const start = (i * 13) % Math.max(1, stations.length - span - 1)
    const ids: string[] = []
    for (let k = 0; k < span; k++) ids.push(stations[start + k].id)
    out.push({
      id: `l-${i}`,
      name: `Line ${i}`,
      color: '#2563eb',
      stationIds: ids,
      mode: i % 2 === 0 ? 'metro' : 'regional_rail',
    })
  }
  return out
}

function timed<T>(label: string, fn: () => T) {
  const t0 = performance.now()
  const result = fn()
  const t1 = performance.now()
  return { label, ms: +(t1 - t0).toFixed(2), result }
}

function run() {
  const scenarioResults: unknown[] = []

  const importedStations = makeStations(3500, 43.62, -79.5, 0.00028, 0, 100000)
  const importedLines = makeLines(importedStations, 320, 18)
  const first = timed('scenario1.postProcessImportedNetwork', () =>
    postProcessImportedNetwork(importedStations, importedLines),
  )
  const merged1 = timed('scenario1.mergeImportIntoMap.first', () =>
    mergeImportIntoMap(
      [],
      [],
      { stations: first.result.stations, lines: first.result.lines },
      () => 'ns' + Math.random(),
      () => 'nl' + Math.random(),
    ),
  )
  const merged2 = timed('scenario1.mergeImportIntoMap.second', () =>
    mergeImportIntoMap(
      merged1.result.stations,
      merged1.result.lines,
      { stations: first.result.stations, lines: first.result.lines },
      () => 'ns' + Math.random(),
      () => 'nl' + Math.random(),
    ),
  )
  scenarioResults.push({
    scenario: 'Dense import merged twice',
    timings_ms: [first.ms, merged1.ms, merged2.ms],
    output: {
      importedStations: importedStations.length,
      importedLines: importedLines.length,
      afterPostStations: first.result.stations.length,
      afterSecondMergeStations: merged2.result.stations.length,
    },
  })

  const s2Stations = makeStations(38000)
  const payload = {
    version: 4,
    stations: s2Stations,
    lines: makeLines(s2Stations, 2400, 16),
    stationLabelOverrides: {},
  }
  const blob = JSON.stringify(payload)
  const loops = 5
  const jsonRun = timed('scenario2.largeJSON.parseStringify', () => {
    for (let i = 0; i < loops; i++) {
      const parsed = JSON.parse(blob)
      JSON.stringify(parsed)
    }
    return null
  })
  scenarioResults.push({
    scenario: 'Large JSON repeated load work',
    timings_ms: [jsonRun.ms],
    output: { bytes: blob.length, loops },
  })

  const exStations = makeStations(2500, 43.64, -79.42, 0.00033, 6)
  const exLines = makeLines(exStations, 220, 14)
  const imStations = makeStations(2300, 43.6408, -79.4208, 0.00033, 5)
  const imLines = makeLines(imStations, 210, 14)
  const conflictRun = timed('scenario3.findImportLineConflicts', () =>
    findImportLineConflicts(exStations, exLines, imStations, imLines),
  )
  const unnamedCount = imStations.filter((s) => s.name === UNNAMED_STOP_PLACEHOLDER).length
  const enrichmentEstimateMs = unnamedCount * 1100
  scenarioResults.push({
    scenario: 'Conflicts + placeholder enrichment estimate',
    timings_ms: [conflictRun.ms],
    output: {
      conflictsFound: conflictRun.result.length,
      unnamedStops: unnamedCount,
      enrichmentEstimateSeconds: +(enrichmentEstimateMs / 1000).toFixed(1),
    },
  })

  const modeToggleRun = timed('scenario4.repeatedVisibilityComputations', () => {
    let visible = new Set(exLines.map((l) => l.id))
    for (let i = 0; i < 2000; i++) {
      if (i % 2 === 0) visible = new Set(exLines.filter((_, idx) => idx % 2 === 0).map((l) => l.id))
      else visible = new Set(exLines.filter((_, idx) => idx % 3 !== 0).map((l) => l.id))
      exLines.filter((l) => visible.has(l.id)).map((l) => l.stationIds.length)
    }
    return null
  })
  scenarioResults.push({
    scenario: 'Rapid view toggle proxy workload',
    timings_ms: [modeToggleRun.ms],
    output: { iterations: 2000, lines: exLines.length },
  })

  console.log(JSON.stringify({ scenarioResults }, null, 2))
}

run()

