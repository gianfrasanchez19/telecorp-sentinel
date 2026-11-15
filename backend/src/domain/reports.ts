import { z } from 'zod';
import { isValidZone } from './catalog.js';
import type { DomainConfig } from './config.js';
import { DomainValidationError } from './telemetry.js';

/**
 * Taxonomía de problemas. La correlación agrupa por FAMILIA (dato estructurado
 * elegido por el usuario), nunca por coincidencia textual de la descripción, para
 * no excluir reportes similares escritos de forma distinta.
 */
export const PROBLEM_TYPES = {
  SIN_SENAL: { label: 'Sin señal / sin cobertura', family: 'CONECTIVIDAD' },
  SIN_DATOS_MOVILES: { label: 'Sin datos móviles', family: 'CONECTIVIDAD' },
  INTERNET_LENTO: { label: 'Internet muy lento', family: 'CONECTIVIDAD' },
  INTERMITENCIA: { label: 'Conexión intermitente', family: 'CONECTIVIDAD' },
  LLAMADAS_CAIDAS: { label: 'Llamadas que se cortan', family: 'CONECTIVIDAD' },
  NO_PUEDE_LLAMAR: { label: 'No puede realizar llamadas', family: 'CONECTIVIDAD' },
  SMS_NO_LLEGAN: { label: 'SMS no llegan', family: 'MENSAJERIA' },
  FACTURACION: { label: 'Cobro o facturación', family: 'COMERCIAL' },
  OTRO: { label: 'Otro', family: 'OTROS' },
} as const;

export type ProblemType = keyof typeof PROBLEM_TYPES;
export type ProblemFamily = (typeof PROBLEM_TYPES)[ProblemType]['family'];

/** Familias que participan en la detección de incidentes colectivos de red. */
export const CORRELATABLE_FAMILIES: ReadonlySet<ProblemFamily> = new Set<ProblemFamily>(['CONECTIVIDAD', 'MENSAJERIA']);

export function familyOf(t: ProblemType): ProblemFamily {
  return PROBLEM_TYPES[t].family;
}

export const REPORT_STATUSES = ['REGISTRADA', 'EN_REVISION', 'EN_ATENCION', 'SOLUCIONADA', 'CERRADA'] as const;
export type CaseStatus = (typeof REPORT_STATUSES)[number];

const problemTypeEnum = z.enum(Object.keys(PROBLEM_TYPES) as [ProblemType, ...ProblemType[]]);

export const reportInputSchema = z
  .object({
    documentType: z.enum(['DNI', 'CE', 'PASAPORTE']),
    documentNumber: z.string().trim().min(5).max(20),
    serviceNumber: z
      .string()
      .trim()
      .regex(/^(\+?51)?\s?9\d{2}\s?\d{3}\s?\d{3}$/, 'Número de servicio móvil inválido (formato peruano 9XX XXX XXX)'),
    zoneId: z.string().trim().min(1).max(40),
    locationHint: z.string().trim().max(120).optional(),
    occurredAt: z.iso.datetime({ offset: true }),
    problemType: problemTypeEnum,
    description: z.string().trim().min(10).max(1000),
    contact: z
      .object({
        email: z.email().max(254).optional(),
        phone: z
          .string()
          .trim()
          .regex(/^(\+?51)?\s?9\d{2}\s?\d{3}\s?\d{3}$/, 'Teléfono de aviso inválido')
          .optional(),
      })
      .strict()
      .optional(),
    notifyConsent: z.boolean().default(false),
    idempotencyKey: z.string().trim().min(16).max(100).regex(/^[A-Za-z0-9_-]+$/),
    synthetic: z.boolean().optional(),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (v.notifyConsent && !v.contact?.email && !v.contact?.phone) {
      ctx.addIssue({ code: 'custom', message: 'Para recibir avisos indique un correo o teléfono', path: ['contact'] });
    }
    if (v.documentType === 'DNI' && !/^\d{8}$/.test(v.documentNumber.replace(/\D/g, ''))) {
      ctx.addIssue({ code: 'custom', message: 'DNI debe tener 8 dígitos', path: ['documentNumber'] });
    }
  });

export type ReportInput = z.input<typeof reportInputSchema>;
export type ParsedReport = z.output<typeof reportInputSchema>;

export interface ValidatedReport extends ParsedReport {
  occurredAt: string; // ISO UTC
  family: ProblemFamily;
  /** Identidad normalizada (NUNCA se persiste en claro; se usa para HMAC). */
  normalizedIdentity: string;
  descriptionRedacted: string;
  /** true si el reporte es tardío según la política (no abre colectivos nuevos). */
  lateForOpening: boolean;
}

/** Normaliza la identidad: tipo + número en mayúsculas sin separadores. */
export function normalizeIdentity(documentType: string, documentNumber: string): string {
  return `${documentType.toUpperCase()}:${documentNumber.toUpperCase().replace(/[^A-Z0-9]/g, '')}`;
}

export function normalizePhone(p: string): string {
  const d = p.replace(/\D/g, '');
  return d.length === 9 ? `+51${d}` : `+${d}`;
}

/**
 * Redacta datos personales de textos libres antes de mostrarlos a terceros o
 * enviarlos a IA: correos, secuencias telefónicas/documentos y URLs.
 */
export function redactText(text: string): string {
  return text
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[CORREO]')
    .replace(/https?:\/\/\S+/g, '[URL]')
    .replace(/(\+?\d[\d\s-]{6,}\d)/g, '[NUMERO]');
}

export function validateReport(raw: unknown, now: Date, cfg: DomainConfig): ValidatedReport {
  const parsed = reportInputSchema.safeParse(raw);
  if (!parsed.success) throw new DomainValidationError('Reporte inválido', parsed.error.issues);
  const r = parsed.data;
  if (!isValidZone(r.zoneId)) throw new DomainValidationError('La zona no existe en el catálogo');
  const occurred = new Date(r.occurredAt);
  if (occurred.getTime() > now.getTime() + cfg.maxClockSkewMs) throw new DomainValidationError('La fecha del problema no puede estar en el futuro');
  if (occurred.getTime() < now.getTime() - cfg.maxReportAgeMs) throw new DomainValidationError('La fecha del problema es demasiado antigua');
  return {
    ...r,
    occurredAt: occurred.toISOString(),
    family: familyOf(r.problemType),
    normalizedIdentity: normalizeIdentity(r.documentType, r.documentNumber),
    descriptionRedacted: redactText(r.description),
    lateForOpening: occurred.getTime() < now.getTime() - cfg.lateReportNoOpenMs,
  };
}

export function maskEmail(e?: string): string | undefined {
  if (!e) return undefined;
  const [u, d] = e.split('@');
  return `${u.slice(0, 1)}***@${d}`;
}
export function maskPhone(p?: string): string | undefined {
  if (!p) return undefined;
  const d = p.replace(/\D/g, '');
  return `*** *** ${d.slice(-3)}`;
}
