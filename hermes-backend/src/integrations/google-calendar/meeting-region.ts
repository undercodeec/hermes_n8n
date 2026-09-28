import { CalendarPolicy, CalendarSlot } from './calendar.types';
import { normalizeMeetingText } from './meeting-date-parser';

export interface MeetingLocation {
  city: string;
  country: 'EC' | 'ES';
  timezone: string;
}

const cities: [string, string, 'EC' | 'ES', string][] = [
  ...[
    'Quito',
    'Guayaquil',
    'Cuenca',
    'Ambato',
    'Loja',
    'Manta',
    'Portoviejo',
    'Machala',
    'Esmeraldas',
    'Ibarra',
    'Riobamba',
    'Latacunga',
    'Tulcán',
    'Babahoyo',
    'Quevedo',
    'Santo Domingo',
    'Salinas',
    'Santa Elena',
    'Daule',
    'Durán',
    'Milagro',
    'Otavalo',
    'Sangolquí',
    'Tena',
    'Puyo',
    'Macas',
    'Zamora',
    'Nueva Loja',
    'Lago Agrio',
    'Azogues',
    'Guaranda',
    'La Libertad',
  ].map((city): [string, string, 'EC', string] => [
    normalizeMeetingText(city),
    city,
    'EC',
    'America/Guayaquil',
  ]),
  ...[
    'Madrid',
    'Barcelona',
    'Valencia',
    'Sevilla',
    'Zaragoza',
    'Málaga',
    'Murcia',
    'Palma',
    'Bilbao',
    'Alicante',
    'Córdoba',
    'Valladolid',
    'Vigo',
    'Gijón',
    'Vitoria',
    'A Coruña',
    'Granada',
    'Elche',
    'Oviedo',
    'Badalona',
    'Cartagena',
    'Terrassa',
    'Jerez de la Frontera',
    'Sabadell',
    'Móstoles',
    'Alcalá de Henares',
    'Pamplona',
    'Fuenlabrada',
    'Almería',
    'Leganés',
    'Santander',
    'Burgos',
    'Castellón',
    'Albacete',
    'Getafe',
    'Salamanca',
    'Logroño',
    'Huelva',
    'Badajoz',
    'Lleida',
    'Tarragona',
    'León',
    'Cádiz',
    'Jaén',
    'Ourense',
    'Girona',
    'Lugo',
    'Santiago de Compostela',
    'Cáceres',
    'Toledo',
    'Ceuta',
    'Melilla',
    'Ibiza',
    'Mallorca',
    'Menorca',
    'San Sebastián',
    'Donostia',
    'Segovia',
    'Ávila',
    'Huesca',
    'Soria',
    'Teruel',
    'Zamora',
    'Palencia',
  ].map((city): [string, string, 'ES', string] => [
    normalizeMeetingText(city),
    city,
    'ES',
    'Europe/Madrid',
  ]),
  ...[
    'Las Palmas',
    'Las Palmas de Gran Canaria',
    'Santa Cruz de Tenerife',
    'San Cristóbal de La Laguna',
    'Tenerife',
    'Gran Canaria',
    'Lanzarote',
    'Fuerteventura',
    'La Gomera',
    'El Hierro',
    'Canarias',
    'Arrecife',
    'Puerto del Rosario',
    'Santa Cruz de La Palma',
  ].map((city): [string, string, 'ES', string] => [
    normalizeMeetingText(city),
    city,
    'ES',
    'Atlantic/Canary',
  ]),
];

export function isRegionalTimezone(timezone: unknown): timezone is string {
  return ['America/Guayaquil', 'Europe/Madrid', 'Atlantic/Canary'].includes(
    String(timezone),
  );
}

/** Only explicit locations or known cities; never infer a timezone from a phone. */
export function resolveMeetingLocation(
  text: string,
): MeetingLocation | undefined {
  // Prefer the explicitly stated current location over origin or nationality.
  const current =
    text.match(/\b(?:estoy|me encuentro|vivo|resido)\s+en\s+(.+)$/i)?.[1] ??
    text;
  const normalized = normalizeMeetingText(current).replace(/\S+@\S+/g, '');
  if (
    /\b(?:colombia|mexico|peru|argentina|chile|bolivia|venezuela|uruguay|paraguay|brasil|republica dominicana|estados unidos)\b/.test(
      normalized,
    )
  )
    return undefined;
  const country = /\becuador\b/.test(normalized)
    ? 'EC'
    : /\b(?:espana|spain)\b/.test(normalized)
      ? 'ES'
      : undefined;
  const matches = cities.filter(
    ([key, , region]) =>
      (!country || region === country) &&
      new RegExp(`\\b${key}\\b`).test(normalized),
  );
  // Keep longest city names ("Santa Cruz de La Palma", not "Palma").
  const longest = matches.filter(
    ([key]) => !matches.some(([other]) => other !== key && other.includes(key)),
  );
  if (longest.length === 1) {
    const [, city, region, timezone] = longest[0];
    return { city, country: region, timezone };
  }
  if (longest.length || !country) return undefined;
  // Explicit country lets unlisted municipalities resolve without guessing a country.
  // Spain without a city remains ambiguous between mainland and Canary Islands.
  const city = current
    .trim()
    .replace(/[<>]/g, '')
    .match(
      /^(?:estoy en |me encuentro en |vivo en |soy de |en )?([\p{L} .'-]{2,80})\s*(?:,|\ben\b|\bde\b)\s*(?:España|Ecuador|Spain)(?:\s+(?:peninsular|continental|península|Baleares))?[.!]?$/iu,
    )?.[1]
    ?.trim();
  if (!city || /^(?:españa|ecuador|spain)$/i.test(city)) return undefined;
  if (
    country === 'ES' &&
    !/\b(?:peninsular|continental|peninsula|baleares)\b/.test(normalized)
  )
    return undefined;
  return {
    city,
    country,
    timezone: country === 'EC' ? 'America/Guayaquil' : 'Europe/Madrid',
  };
}

export function mentionsMeetingLocation(text: string): boolean {
  return /\b(?:estoy|me encuentro|vivo|resido)\s+en\b|^en\s|\b(?:ecuador|espana|spain)\b|\b(?:reunion|cita|llamada)\b.*\ben\s+[a-z]/.test(
    normalizeMeetingText(text).replace(/\S+@\S+/g, ''),
  );
}

export function readMeetingLocation(
  value: unknown,
): MeetingLocation | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return undefined;
  const location = value as MeetingLocation;
  if (
    typeof location.city !== 'string' ||
    !location.city.trim() ||
    location.city.length > 120
  )
    return undefined;
  if (
    (location.country === 'EC' && location.timezone === 'America/Guayaquil') ||
    (location.country === 'ES' &&
      ['Europe/Madrid', 'Atlantic/Canary'].includes(location.timezone))
  )
    return location;
  return undefined;
}

/** Regional hours are authoritative; calendar settings supply duration, buffer and weekdays. */
export function meetingPolicy(
  base: CalendarPolicy,
  timezone: string,
): CalendarPolicy {
  if (!isRegionalTimezone(timezone)) return { ...base, timezone }; // Legacy meetings.
  return {
    ...base,
    timezone,
    businessStart: timezone === 'America/Guayaquil' ? '08:00' : '14:00',
    businessEnd: '20:00',
  };
}

export function meetingTimeLabel(slot: CalendarSlot, timezone: string): string {
  return new Intl.DateTimeFormat('es-EC', {
    timeZone: timezone,
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(new Date(slot.start));
}

export function meetingDualTime(slot: CalendarSlot, timezone: string): string {
  const local = `${meetingTimeLabel(slot, timezone)} (${timezone})`;
  return ['Europe/Madrid', 'Atlantic/Canary'].includes(timezone)
    ? `${local}, hora España; ${meetingTimeLabel(slot, 'America/Guayaquil')} (America/Guayaquil), hora Ecuador`
    : `${local}, ${timezone === 'America/Guayaquil' ? 'hora Ecuador' : 'hora de la reunión'}`;
}

export function meetingEventDetails(draft: {
  meetingId: string;
  slot: CalendarSlot;
  timezone: string;
  serviceContext?: string;
}) {
  const region =
    draft.timezone === 'America/Guayaquil'
      ? 'EC'
      : ['Europe/Madrid', 'Atlantic/Canary'].includes(draft.timezone)
        ? 'ES'
        : 'OTRO';
  const endTime = (timezone: string) =>
    new Intl.DateTimeFormat('es-EC', {
      timeZone: timezone,
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).format(new Date(draft.slot.end));
  const description = [
    `Referencia CRM: ${draft.meetingId}`,
    ...(draft.serviceContext
      ? [`Servicio: ${draft.serviceContext.replace(/[<>]/g, '').slice(0, 240)}`]
      : []),
    `Zona de la reunión: ${draft.timezone}`,
    ...(region === 'ES'
      ? [
          `Hora España: ${meetingTimeLabel(draft.slot, draft.timezone)} – ${endTime(draft.timezone)} (${draft.timezone})`,
        ]
      : []),
    `Hora Ecuador: ${meetingTimeLabel(draft.slot, 'America/Guayaquil')} – ${endTime('America/Guayaquil')} (America/Guayaquil)`,
  ].join('\n');
  return {
    summary: `[${region}] Reunión comercial - Undercodeec`,
    description,
    extendedProperties: {
      private: {
        hermesMeetingId: draft.meetingId,
        hermesTimezone: draft.timezone,
        hermesRegion: region,
      },
    },
  };
}
