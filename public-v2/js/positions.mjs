import { fetchJson } from './api.mjs';
import { computeTrailStopLevel, buildTradeMarker, buildCandidateMarker } from './format.mjs';
import { createSeriesMarkers } from '/vendor/lightweight-charts.standalone.production.mjs';

// v5's markers API is a separate primitive (createSeriesMarkers), not a series.setMarkers()
// method — confirmed against the actual vendored bundle's exports before writing this, since
// v4's API (series.setMarkers directly) would silently fail to compile/throw differently here.
let markersPrimitive;
let priceLineHandles = [];

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

    // Every coin/timeframe switch calls this again — without removing the previous run's lines
    // first, switching away from a positioned coin left its stop line drawn on the next coin's
    // chart, and repeated switches stacked an ever-growing pile of lines.
    for (const handle of priceLineHandles) candleSeries.removePriceLine(handle);
    priceLineHandles = [];

    const openForThisCoin = positions.filter((p) => p.coin === coin);
    for (const position of openForThisCoin) {
      const candlesSinceEntry = candles.filter((c) => c.ts > position.entryTs);
      const level = position.exitType === 'trailing_stop'
        ? computeTrailStopLevel(position, candlesSinceEntry)
        : position.initialStopPrice;
      priceLineHandles.push(candleSeries.createPriceLine({ price: level, color: '#ef4444', title: 'stop' }));
    }
  } catch (err) {
    console.error('Could not load markers/positions:', err.message);
  }
}
