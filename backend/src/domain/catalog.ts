/**
 * Catálogo FIJO DE DEMOSTRACIÓN.
 *
 * Todas las zonas, antenas, coordenadas, centros y coberturas son SINTÉTICAS.
 * Los nombres de distritos son ficticios (inspirados en Lima, Perú) y las
 * poblaciones son estimaciones inventadas para la demo. TeleCorp Sentinel NO
 * tiene acceso a antenas reales de ningún operador.
 */

export type ZoneCriticality = 'HOSPITAL' | 'SERVICIOS_CRITICOS' | 'EDUCACION' | 'INDUSTRIAL' | 'RESIDENCIAL';

export interface Zone {
  zoneId: string;
  name: string;
  criticality: ZoneCriticality;
  /** Centros relevantes (ficticios) que justifican la criticidad. */
  keySites: string[];
  /** Coordenadas de ejemplo (no reales) para dibujar el mapa esquemático. */
  center: { lat: number; lon: number };
}

export interface Cell {
  cellId: string;
  zoneId: string;
  /** Usuarios estimados (dato de catálogo sintético, NO medido). */
  estimatedUsers: number;
}

export interface Antenna {
  antennaId: string;
  zoneId: string;
  name: string;
  /** Coordenadas de ejemplo (sintéticas). */
  lat: number;
  lon: number;
  /** Celdas cubiertas. Las celdas pueden solaparse entre antenas. */
  cells: string[];
  technology: '4G' | '5G' | '4G/5G';
}

export const ZONES: Zone[] = [
  {
    zoneId: 'Z-SRN',
    name: 'Santa Rosa Norte',
    criticality: 'HOSPITAL',
    keySites: ['Hospital Regional Santa Rosa (ficticio)', 'Centro de Salud Las Lomas (ficticio)'],
    center: { lat: -11.985, lon: -77.06 },
  },
  {
    zoneId: 'Z-CCV',
    name: 'Centro Cívico',
    criticality: 'SERVICIOS_CRITICOS',
    keySites: ['Central de Bomberos N.º 7 (ficticia)', 'Comisaría Central (ficticia)'],
    center: { lat: -12.045, lon: -77.03 },
  },
  {
    zoneId: 'Z-CSU',
    name: 'Campus Sur',
    criticality: 'EDUCACION',
    keySites: ['Universidad del Sur (ficticia)', 'Colegio Nacional Las Acacias (ficticio)'],
    center: { lat: -12.135, lon: -76.99 },
  },
  {
    zoneId: 'Z-VIN',
    name: 'Valle Industrial',
    criticality: 'INDUSTRIAL',
    keySites: ['Parque Industrial Valle Verde (ficticio)'],
    center: { lat: -12.06, lon: -77.12 },
  },
  {
    zoneId: 'Z-LPA',
    name: 'Las Palmeras',
    criticality: 'RESIDENCIAL',
    keySites: ['Conjunto residencial Las Palmeras (ficticio)'],
    center: { lat: -12.1, lon: -77.04 },
  },
  {
    zoneId: 'Z-MIR',
    name: 'Miramar',
    criticality: 'RESIDENCIAL',
    keySites: ['Malecón Miramar (ficticio)'],
    center: { lat: -12.125, lon: -77.06 },
  },
];

export const CELLS: Cell[] = [
  { cellId: 'C-SRN-1', zoneId: 'Z-SRN', estimatedUsers: 4200 },
  { cellId: 'C-SRN-2', zoneId: 'Z-SRN', estimatedUsers: 3100 },
  { cellId: 'C-SRN-3', zoneId: 'Z-SRN', estimatedUsers: 2600 },
  { cellId: 'C-CCV-1', zoneId: 'Z-CCV', estimatedUsers: 5200 },
  { cellId: 'C-CCV-2', zoneId: 'Z-CCV', estimatedUsers: 3800 },
  { cellId: 'C-CSU-1', zoneId: 'Z-CSU', estimatedUsers: 6100 },
  { cellId: 'C-CSU-2', zoneId: 'Z-CSU', estimatedUsers: 2900 },
  { cellId: 'C-VIN-1', zoneId: 'Z-VIN', estimatedUsers: 1800 },
  { cellId: 'C-VIN-2', zoneId: 'Z-VIN', estimatedUsers: 1500 },
  { cellId: 'C-LPA-1', zoneId: 'Z-LPA', estimatedUsers: 4300 },
  { cellId: 'C-LPA-2', zoneId: 'Z-LPA', estimatedUsers: 3900 },
  { cellId: 'C-LPA-3', zoneId: 'Z-LPA', estimatedUsers: 2700 },
  { cellId: 'C-MIR-1', zoneId: 'Z-MIR', estimatedUsers: 3600 },
  { cellId: 'C-MIR-2', zoneId: 'Z-MIR', estimatedUsers: 2400 },
];

export const ANTENNAS: Antenna[] = [
  { antennaId: 'ANT-SRN-01', zoneId: 'Z-SRN', name: 'SRN Hospital Norte', lat: -11.981, lon: -77.064, cells: ['C-SRN-1', 'C-SRN-2'], technology: '4G/5G' },
  { antennaId: 'ANT-SRN-02', zoneId: 'Z-SRN', name: 'SRN Las Lomas', lat: -11.989, lon: -77.055, cells: ['C-SRN-2', 'C-SRN-3'], technology: '4G' },
  { antennaId: 'ANT-SRN-03', zoneId: 'Z-SRN', name: 'SRN Avenida Central', lat: -11.992, lon: -77.066, cells: ['C-SRN-1', 'C-SRN-3'], technology: '5G' },
  { antennaId: 'ANT-CCV-01', zoneId: 'Z-CCV', name: 'CCV Plaza Mayor', lat: -12.043, lon: -77.034, cells: ['C-CCV-1'], technology: '4G/5G' },
  { antennaId: 'ANT-CCV-02', zoneId: 'Z-CCV', name: 'CCV Bomberos', lat: -12.049, lon: -77.026, cells: ['C-CCV-1', 'C-CCV-2'], technology: '4G' },
  { antennaId: 'ANT-CSU-01', zoneId: 'Z-CSU', name: 'CSU Universidad', lat: -12.132, lon: -76.994, cells: ['C-CSU-1'], technology: '5G' },
  { antennaId: 'ANT-CSU-02', zoneId: 'Z-CSU', name: 'CSU Acacias', lat: -12.139, lon: -76.986, cells: ['C-CSU-1', 'C-CSU-2'], technology: '4G' },
  { antennaId: 'ANT-VIN-01', zoneId: 'Z-VIN', name: 'VIN Parque Industrial', lat: -12.057, lon: -77.124, cells: ['C-VIN-1'], technology: '4G' },
  { antennaId: 'ANT-VIN-02', zoneId: 'Z-VIN', name: 'VIN Almacenes', lat: -12.064, lon: -77.115, cells: ['C-VIN-1', 'C-VIN-2'], technology: '4G' },
  { antennaId: 'ANT-LPA-01', zoneId: 'Z-LPA', name: 'LPA Parque', lat: -12.097, lon: -77.043, cells: ['C-LPA-1'], technology: '4G/5G' },
  { antennaId: 'ANT-LPA-02', zoneId: 'Z-LPA', name: 'LPA Mercado', lat: -12.103, lon: -77.036, cells: ['C-LPA-1', 'C-LPA-2'], technology: '4G' },
  { antennaId: 'ANT-LPA-03', zoneId: 'Z-LPA', name: 'LPA Colegio', lat: -12.106, lon: -77.045, cells: ['C-LPA-2', 'C-LPA-3'], technology: '4G' },
  { antennaId: 'ANT-MIR-01', zoneId: 'Z-MIR', name: 'MIR Malecón', lat: -12.122, lon: -77.064, cells: ['C-MIR-1'], technology: '5G' },
  { antennaId: 'ANT-MIR-02', zoneId: 'Z-MIR', name: 'MIR Faro', lat: -12.129, lon: -77.056, cells: ['C-MIR-1', 'C-MIR-2'], technology: '4G' },
];

const zoneById = new Map(ZONES.map((z) => [z.zoneId, z]));
const antennaById = new Map(ANTENNAS.map((a) => [a.antennaId, a]));
const cellById = new Map(CELLS.map((c) => [c.cellId, c]));

export function getZone(zoneId: string): Zone | undefined {
  return zoneById.get(zoneId);
}
export function getAntenna(antennaId: string): Antenna | undefined {
  return antennaById.get(antennaId);
}
export function antennasInZone(zoneId: string): Antenna[] {
  return ANTENNAS.filter((a) => a.zoneId === zoneId);
}
export function isValidZone(zoneId: string): boolean {
  return zoneById.has(zoneId);
}

/**
 * Usuarios potencialmente afectados (ESTIMADO DE CATÁLOGO) para un conjunto de
 * antenas: se suma cada celda UNA sola vez aunque varias antenas la cubran,
 * evitando duplicar coberturas solapadas.
 */
export function estimatedUsersForAntennas(antennaIds: string[]): number {
  const cells = new Set<string>();
  for (const id of antennaIds) for (const c of getAntenna(id)?.cells ?? []) cells.add(c);
  let total = 0;
  for (const c of cells) total += cellById.get(c)?.estimatedUsers ?? 0;
  return total;
}

export function estimatedUsersForZone(zoneId: string): number {
  return estimatedUsersForAntennas(antennasInZone(zoneId).map((a) => a.antennaId));
}
