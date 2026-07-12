/** Geographic primitives shared across feeds and the network fixture. */

export interface GeoPoint {
  lat: number;
  lon: number;
}

/** Great-circle distance in miles. Used for movement→shipment association. */
export function haversineMiles(a: GeoPoint, b: GeoPoint): number {
  const R = 3958.7613; // earth radius, miles
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}
