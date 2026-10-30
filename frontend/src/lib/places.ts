export type LocationSuggestion = {
  id: string;
  label: string;
  latitude: number | null;
  longitude: number | null;
};

export const DEFAULT_LOCATION = { latitude: -1.2921, longitude: 36.8219, label: "Nairobi, Kenya" };

const GOOGLE_PLACES_KEY = (import.meta.env.VITE_GOOGLE_MAPS_API_KEY as string | undefined)?.trim() ?? "";

export const locationSearchSource = GOOGLE_PLACES_KEY ? "Google Maps" : "OpenStreetMap";

export async function searchLocations(query: string, signal: AbortSignal): Promise<LocationSuggestion[]> {
  return GOOGLE_PLACES_KEY ? googleSearch(query, signal) : nominatimSearch(query, signal);
}

export async function resolveLocation(suggestion: LocationSuggestion, signal: AbortSignal): Promise<LocationSuggestion> {
  if (suggestion.latitude !== null && suggestion.longitude !== null) return suggestion;
  if (!GOOGLE_PLACES_KEY) return suggestion;
  const response = await fetch(`https://places.googleapis.com/v1/places/${encodeURIComponent(suggestion.id)}`, {
    signal,
    headers: {
      "X-Goog-Api-Key": GOOGLE_PLACES_KEY,
      "X-Goog-FieldMask": "location,formattedAddress",
    },
  });
  if (!response.ok) throw new Error("The place location could not be read.");
  const body = (await response.json()) as {
    location?: { latitude?: number; longitude?: number };
    formattedAddress?: string;
  };
  const { latitude, longitude } = body.location ?? {};
  if (typeof latitude !== "number" || typeof longitude !== "number") {
    throw new Error("The place location could not be read.");
  }
  return {
    ...suggestion,
    label: body.formattedAddress?.slice(0, 80) || suggestion.label,
    latitude,
    longitude,
  };
}

async function googleSearch(query: string, signal: AbortSignal): Promise<LocationSuggestion[]> {
  const response = await fetch("https://places.googleapis.com/v1/places:autocomplete", {
    method: "POST",
    signal,
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": GOOGLE_PLACES_KEY,
    },
    body: JSON.stringify({
      input: query,
      languageCode: "en",
      locationBias: {
        circle: {
          center: { latitude: DEFAULT_LOCATION.latitude, longitude: DEFAULT_LOCATION.longitude },
          radius: 50000,
        },
      },
    }),
  });
  if (!response.ok) throw new Error("The place search failed.");
  const body = (await response.json()) as {
    suggestions?: {
      placePrediction?: {
        placeId?: string;
        text?: { text?: string };
      };
    }[];
  };
  return (body.suggestions ?? [])
    .map((suggestion) => suggestion.placePrediction)
    .filter(
      (prediction): prediction is { placeId: string; text?: { text?: string } } =>
        Boolean(prediction?.placeId && prediction?.text?.text),
    )
    .map((prediction) => ({
      id: prediction.placeId,
      label: prediction.text?.text ?? "",
      latitude: null,
      longitude: null,
    }));
}

async function nominatimSearch(query: string, signal: AbortSignal): Promise<LocationSuggestion[]> {
  const params = new URLSearchParams({
    format: "jsonv2",
    limit: "6",
    q: query,
    "accept-language": "en",
    // viewbox nudges results toward Kenya without excluding matches elsewhere.
    viewbox: "33.5,5.6,42.5,-5.2",
  });
  const response = await fetch(`https://nominatim.openstreetmap.org/search?${params}`, { signal });
  if (!response.ok) throw new Error("The place search failed.");
  const body = (await response.json()) as { place_id: number; display_name: string; lat: string; lon: string }[];
  return body.map((item) => ({
    id: String(item.place_id),
    label: item.display_name.slice(0, 80),
    latitude: Number(item.lat),
    longitude: Number(item.lon),
  }));
}
