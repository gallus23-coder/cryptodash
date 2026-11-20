import { fetchJson } from './api.mjs';
import { computeTrailStopLevel, buildTradeMarker, buildCandidateMarker } from './format.mjs';
import { createSeriesMarkers } from '/vendor/lightweight-charts.standalone.production.mjs';

// v5's markers API is a separate primitive (createSeriesMarkers), not a series.setMarkers()
// method — confirmed against the actual vendored bundle's exports before writing this, since
// v4's API (series.setMarkers directly) would silently fail to compile/throw differently here.
let markersPrimitive;

export async function renderMarkersAndPositions(chart, candleSeries, coin, mode = 'paper') {
  try {
    const [markers, positions, candles] = await Promise.all([
      fetchJson(`/api/markers/${coin}`, { mode }),
      fetchJson('/api/positions', { mode }),
      fetchJson(`/api/candles/${coin}`, { tf: '1h' }),
    ]);

    const allMarkers = [
      ...markers.trades.flatMap(buildTradeMarker),
      ...markers.candidates.map(buildCandidateMarker),
    ].sort((a, b) => a.time - b.time);
    if (!markersPrimitive) markersPrimitive = createSeriesMarkers(candleSeries, allMarkers);
    else markersPrimitive.setMarkers(allMarkers);

    const openForThisCoin = positions.filter((p) => p.coin === coin);
    for (const position of openForThisCoin) {
      const candlesSinceEntry = candles.filter((c) => c.ts > position.entryTs);
      const level = position.exitType === 'trailing_stop'
        ? computeTrailStopLevel(position, candlesSinceEntry)
        : position.initialStopPrice;
      candleSeries.createPriceLine({ price: level, color: '#ef4444', title: 'stop' });
    }
  } catch (err) {
    console.error('Could not load markers/positions:', err.message);
  }
}
