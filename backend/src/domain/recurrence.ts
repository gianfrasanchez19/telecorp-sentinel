export interface EpisodeSummary {
  episodeId: string;
  antennaId: string;
  startedAt: string;
  endedAt?: string;
  worstStatus: string;
  anomalousReadings: number;
}

export interface RecurrenceResult {
  antennaId: string;
  episodesInWindow: number;
  structuralReview: boolean;
  windowStart: string;
  totalAnomalousMinutes: number;
}

/**
 * Recurrencia: cuenta EPISODIOS distintos (no lecturas) que empezaron dentro de
 * la ventana. Con >= threshold episodios se marca "revisión estructural".
 */
export function evaluateRecurrence(antennaId: string, episodes: EpisodeSummary[], now: Date, threshold: number, windowMs: number): RecurrenceResult {
  const start = now.getTime() - windowMs;
  const inWindow = episodes.filter((e) => e.antennaId === antennaId && new Date(e.startedAt).getTime() > start);
  const minutes = inWindow.reduce((acc, e) => {
    const end = e.endedAt ? new Date(e.endedAt).getTime() : now.getTime();
    return acc + Math.max(0, (end - new Date(e.startedAt).getTime()) / 60_000);
  }, 0);
  return {
    antennaId,
    episodesInWindow: inWindow.length,
    structuralReview: inWindow.length >= threshold,
    windowStart: new Date(start).toISOString(),
    totalAnomalousMinutes: Math.round(minutes),
  };
}
