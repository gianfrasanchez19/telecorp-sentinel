import { getZone } from '../domain/catalog.js';
import { CORRELATABLE_FAMILIES, PROBLEM_TYPES, redactText } from '../domain/reports.js';
import { canonicalJson, sha256Hex } from '../lib/crypto.js';
import type { IncidentMeta } from '../repo/entities.js';
import type { AiAnalysis } from '../services/runtime.js';

export const AI_CONTEXT_VERSION = 'ctx-v1';

/**
 * Contexto ANONIMIZADO para la IA: sólo datos operativos agregados y descripciones
 * redactadas. Nunca DNI, teléfono, correo, tokens, seudónimos ni ubicación exacta.
 */
export function buildAiContext(m: IncidentMeta, sampleDescriptions: string[], problemTypes: Record<string, number>) {
  const zone = getZone(m.zoneId);
  return {
    contextVersion: AI_CONTEXT_VERSION,
    incident: {
      kind: m.kind,
      status: m.status,
      zoneCriticality: m.zoneCriticality,
      zoneLabel: zone?.name ?? m.zoneId, // nombre ficticio de zona (no ubicación exacta)
      family: m.family ?? null,
      uniqueReporters: m.uniqueReporters,
      reportCount: m.reportCount,
      estimatedUsersCatalog: m.estimatedUsers,
      antennas: m.antennaIds.length,
      worstAntennaStatus: m.worstAntennaStatus ?? null,
      currentAntennaStatus: m.currentAntennaStatus ?? null,
      recoveryDetected: !!m.recovery,
      investigationPending: m.investigationPending,
      priorityLevel: m.priority?.level ?? null,
    },
    problemTypes,
    descriptions: sampleDescriptions.slice(0, 8).map((d) => redactText(d).slice(0, 300)),
  };
}

export function contextHash(ctx: Record<string, unknown>): string {
  return sha256Hex(canonicalJson(ctx));
}

/**
 * Respaldo por REGLAS LOCALES cuando la IA no está disponible. Se etiqueta
 * explícitamente como AI_UNAVAILABLE y nunca se presenta como respuesta de Gemini.
 */
export function fallbackAnalysis(m: IncidentMeta, reason: string): AiAnalysis & { source: 'AI_UNAVAILABLE'; reason: string } {
  const causes: string[] = [];
  const actions: string[] = [];
  if (m.kind === 'INFRAESTRUCTURA') {
    if (m.worstAntennaStatus === 'INHABILITADA') {
      causes.push('Antena sin tráfico (0 GB/min): posible corte de energía, falla de hardware o desconexión del enlace de transporte.');
      actions.push('Verificar alimentación eléctrica y alarmas del equipo en sitio.', 'Revisar el enlace de transporte (backhaul) de la estación.');
    } else if (m.worstAntennaStatus === 'CAIDA') {
      causes.push('Tráfico anormalmente bajo (<60 GB/min): degradación de radio, interferencia o falla parcial.');
      actions.push('Revisar KPIs de radio y alarmas de la celda.', 'Comparar con antenas vecinas de la zona.');
    } else if (m.worstAntennaStatus === 'SATURADA') {
      causes.push('Tráfico superior a la capacidad nominal (>129 GB/min): congestión por demanda.');
      actions.push('Evaluar balanceo de carga hacia celdas vecinas o ampliación de capacidad.');
    }
  } else {
    causes.push(m.investigationPending ? 'Reportes coincidentes sin anomalía de antenas registrada: posible problema de núcleo, configuración o cobertura localizada.' : 'Reportes coincidentes con antenas anómalas en la zona (correlación temporal, causalidad no confirmada).');
    actions.push('Contrastar con métricas de las antenas candidatas de la zona.', 'Contactar a soporte de campo si persisten los reportes.');
  }
  if (m.zoneCriticality === 'HOSPITAL' || m.zoneCriticality === 'SERVICIOS_CRITICOS') actions.unshift('Zona crítica: escalar al equipo de guardia y priorizar la atención.');
  return {
    source: 'AI_UNAVAILABLE',
    reason,
    summary: `[RESPALDO POR REGLAS — IA NO DISPONIBLE] Incidente ${m.kind.toLowerCase()} en ${getZone(m.zoneId)?.name ?? m.zoneId} con ${m.uniqueReporters} reportante(s) único(s).`,
    probableCauses: causes.length ? causes : ['Sin datos suficientes para sugerir una causa.'],
    recommendedActions: actions,
    uncertainties: ['Análisis generado por reglas deterministas locales, no por un modelo de IA.'],
    relatedProblemType: m.family && CORRELATABLE_FAMILIES.has(m.family) ? m.family : 'CONECTIVIDAD',
    model: 'reglas-locales-v1',
    generatedAt: new Date().toISOString(),
  };
}

export function problemTypeLabel(t: string): string {
  return (PROBLEM_TYPES as Record<string, { label: string }>)[t]?.label ?? t;
}
