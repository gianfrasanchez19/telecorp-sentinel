export interface CorrelationPoint {
  userHash: string;
  /** Momento del inconveniente (epoch ms, UTC). */
  at: number;
  ticketId: string;
}

export interface WindowResult {
  distinctUsers: number;
  users: string[];
  tickets: string[];
  startAt?: number;
  endAt?: number;
}

/**
 * Máximo de USUARIOS DISTINTOS dentro de cualquier ventana móvil de longitud
 * ESTRICTAMENTE menor que windowMs (dos reportes separados exactamente windowMs
 * NO caen en la misma ventana). Un mismo usuario repetido cuenta una vez.
 * Complejidad O(n log n) por el ordenamiento + O(n) de dos punteros.
 */
export function maxDistinctUsersInWindow(points: CorrelationPoint[], windowMs: number): WindowResult {
  const pts = [...points].sort((a, b) => a.at - b.at || a.ticketId.localeCompare(b.ticketId));
  const counts = new Map<string, number>();
  let best: WindowResult = { distinctUsers: 0, users: [], tickets: [] };
  let left = 0;
  for (let right = 0; right < pts.length; right++) {
    const p = pts[right];
    counts.set(p.userHash, (counts.get(p.userHash) ?? 0) + 1);
    while (p.at - pts[left].at >= windowMs) {
      const u = pts[left].userHash;
      const c = (counts.get(u) ?? 0) - 1;
      if (c <= 0) counts.delete(u);
      else counts.set(u, c);
      left++;
    }
    if (counts.size > best.distinctUsers) {
      const slice = pts.slice(left, right + 1);
      best = {
        distinctUsers: counts.size,
        users: [...counts.keys()],
        tickets: slice.map((s) => s.ticketId),
        startAt: pts[left].at,
        endAt: p.at,
      };
    }
  }
  return best;
}

/** Clave lógica del incidente activo (una por antena / por zona+familia). */
export function infraIncidentKey(antennaId: string): string {
  return `INFRA#${antennaId}`;
}
export function collectiveIncidentKey(zoneId: string, family: string): string {
  return `COLL#${zoneId}#${family}`;
}
