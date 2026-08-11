export const GUILD_EVENTS_API_URL =
  "https://guild.host/api/next/events/upcoming";
export const GUILD_LOCATION_RADIUS_KM = 80;

// Retained only until the closure connector is replaced by the direct
// guild.host connector in the next implementation task.
export const GUILD_CLOSURE_URL = "https://guild.co/app";
export const GUILD_CLOSURE_DATE = "2024-10-01";
export const GUILD_UNAVAILABLE_MESSAGE = "Guild closed on 1 October 2024";
export const GUILD_UNAVAILABLE_CODE = "source_unavailable";

export interface GuildSearchLocation {
  name: string;
  latitude: number;
  longitude: number;
}

const locations: readonly GuildSearchLocation[] = [
  { name: "London", latitude: 51.5074, longitude: -0.1278 },
  { name: "Manchester", latitude: 53.4808, longitude: -2.2426 },
  { name: "Birmingham", latitude: 52.4862, longitude: -1.8904 },
  { name: "Bristol", latitude: 51.4545, longitude: -2.5879 },
  { name: "Edinburgh", latitude: 55.9533, longitude: -3.1883 },
  { name: "Paris", latitude: 48.8566, longitude: 2.3522 },
  { name: "Berlin", latitude: 52.52, longitude: 13.405 },
  { name: "Amsterdam", latitude: 52.3676, longitude: 4.9041 },
  { name: "Barcelona", latitude: 41.3874, longitude: 2.1686 }
];

export function resolveGuildLocation(
  locationText: string
): GuildSearchLocation | null {
  const normalized = ` ${normalizeLocation(locationText)} `;
  const match = locations.find(({ name }) =>
    normalized.includes(` ${normalizeLocation(name)} `)
  );
  return match === undefined ? null : { ...match };
}

export function distanceKilometres(
  first: Pick<GuildSearchLocation, "latitude" | "longitude">,
  second: Pick<GuildSearchLocation, "latitude" | "longitude">
): number {
  const earthRadiusKm = 6_371.0088;
  const latitudeDelta = radians(second.latitude - first.latitude);
  const longitudeDelta = radians(second.longitude - first.longitude);
  const firstLatitude = radians(first.latitude);
  const secondLatitude = radians(second.latitude);
  const haversine =
    Math.sin(latitudeDelta / 2) ** 2 +
    Math.cos(firstLatitude) *
      Math.cos(secondLatitude) *
      Math.sin(longitudeDelta / 2) ** 2;
  return 2 * earthRadiusKm * Math.asin(Math.sqrt(haversine));
}

function radians(value: number): number {
  return (value * Math.PI) / 180;
}

function normalizeLocation(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}
