// Parsers for Apple's responses. Adapted from kelindi/apple-stock (MIT).

const KM_PER_MILE = 1.609344;

// One row per store and part from `<shop>/retail/pickup-message`, skipping stores farther than maxDistanceKm.
// Apple reports distance in the country's own unit (miles in the US); `distance` keeps that for display and
// `distanceKm` is used for the MAX_DISTANCE_KM filter.
export function parsePickup(json, { maxDistanceKm = Infinity } = {}) {
  const stores = json?.body?.stores;
  if (!Array.isArray(stores)) throw new Error('Unexpected pickup response shape');
  const rows = [];
  for (const store of stores) {
    const value = Number(store.storedistance);
    const miles = /\bmi\b/i.test(store.storeDistanceWithUnit ?? '');
    const distanceKm = miles ? value * KM_PER_MILE : value;
    if (Number.isFinite(distanceKm) && distanceKm > maxDistanceKm) continue;
    for (const [partNumber, part] of Object.entries(store.partsAvailability ?? {})) {
      const quote = stripHtml(part.pickupSearchQuote ?? part.messageTypes?.regular?.storePickupQuote ?? '');
      rows.push({
        partNumber,
        storeNumber: store.storeNumber,
        storeName: stripHtml(store.storeName),
        distanceKm,
        distance: `${value} ${miles ? 'mi' : 'km'}`,
        available: availability(part.pickupDisplay, quote),
        quote,
        title: stripHtml(part.messageTypes?.regular?.storePickupProductTitle ?? partNumber),
      });
    }
  }
  return rows;
}

// Part numbers and names from the `metrics` JSON on an Apple Store product page.
export function parseProducts(html) {
  const match = html.match(/<script[^>]*id="?metrics"?[^>]*>([\s\S]*?)<\/script>/);
  if (!match) return [];
  let data;
  try {
    data = JSON.parse(match[1]);
  } catch {
    return [];
  }
  const byPart = new Map();
  for (const p of data?.data?.products ?? []) if (p.partNumber && p.name) byPart.set(p.partNumber, { partNumber: p.partNumber, name: p.name });
  return [...byPart.values()].sort((a, b) => a.name.localeCompare(b.name, 'en', { numeric: true }));
}

// true = available, false = Apple explicitly says unavailable, null = unknown (missing or unrecognised fields).
// pickupDisplay is the main signal; the quote text is a fallback in case that field lags.
function availability(display, quote) {
  const saysUnavailable = /unavailable|not available/i.test(quote);
  if (display === 'available' || (!saysUnavailable && /\bavailable\b|today|tomorrow/i.test(quote))) return true;
  if (display === 'unavailable' || saysUnavailable) return false;
  return null;
}

function stripHtml(s) {
  return String(s).replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
}
