/**
 * Demo/aceptación reproducible en modo LOCAL EMULADO (memoria, sin nube):
 * ejecuta los escenarios de la especificación y muestra resultados medidos.
 * Uso: npm run demo
 */
process.env.LOG_SILENT = '1';
const { createLocalEnv } = await import('./localRuntime.js');
const { runScenario } = await import('../services/simulator.js');
const { listIncidents } = await import('../services/incidents.js');
const { listAntennas } = await import('../services/telemetry.js');
const { processingStats } = await import('../services/pipeline.js');

const env = createLocalEnv({ allowedRecipients: ['*'] });
const rows: { escenario: string; esperado: string; obtenido: string; ok: boolean }[] = [];
const check = (escenario: string, esperado: string, obtenido: unknown, ok: boolean) => rows.push({ escenario, esperado, obtenido: String(obtenido), ok });
const coll = async (z: string) => (await listIncidents({})).filter((i) => i.kind === 'COLECTIVO' && i.zoneId === z);

const lim = (await runScenario('lecturas-limite', { antennaId: 'ANT-CSU-02' })) as { injected: { value: number; result: string }[] };
check('Lecturas límite', '0→INH, 59.99→CAIDA, 60/129→NORMAL, 129.01→SAT, -5 rechazada', lim.injected.map((x) => `${x.value}:${x.result.split(':')[0]}`).join(' '), lim.injected[0].result === 'INHABILITADA' && lim.injected[1].result === 'CAIDA' && lim.injected[2].result === 'NORMAL' && lim.injected[3].result === 'NORMAL' && lim.injected[4].result === 'SATURADA' && lim.injected[5].result.startsWith('RECHAZADA'));
await env.idle();

await runScenario('antena-inhabilitada', { antennaId: 'ANT-SRN-01' });
await runScenario('antena-inhabilitada', { antennaId: 'ANT-MIR-02' });
await env.idle();
{
  const inf0 = (await listIncidents({})).filter((i) => i.kind === 'INFRAESTRUCTURA');
  const hosp = inf0.find((i) => i.zoneId === 'Z-SRN');
  const resi = inf0.find((i) => i.zoneId === 'Z-MIR');
  check('Prioridad hospital vs residencial (mismo estado, sin reportes)', 'hospital primero', `${hosp?.priority?.level}(${hosp?.priority?.score}) vs ${resi?.priority?.level}(${resi?.priority?.score})`, (hosp?.priority?.score ?? 0) > (resi?.priority?.score ?? 0));
}

await runScenario('reportes-usuarios', { zoneId: 'Z-LPA', count: 9, startIndex: 0, repeatIndex: 3 });
await env.idle();
check('9 usuarios + 1 repetido', 'sin colectivo', (await coll('Z-LPA')).length, (await coll('Z-LPA')).length === 0);
await runScenario('reportes-usuarios', { zoneId: 'Z-LPA', count: 1, startIndex: 9 });
await env.idle();
const c1 = await coll('Z-LPA');
check('Décimo usuario distinto', '1 colectivo, 10 reportantes, investigación pendiente', `${c1.length} / ${c1[0]?.uniqueReporters} / ${c1[0]?.investigationPending}`, c1.length === 1 && c1[0].uniqueReporters === 10 && c1[0].investigationPending);
await runScenario('reportes-usuarios', { zoneId: 'Z-LPA', count: 2, startIndex: 10 });
await env.idle();
check('11.º y 12.º', 'actualiza afectación a 12', (await coll('Z-LPA'))[0]?.uniqueReporters, (await coll('Z-LPA'))[0]?.uniqueReporters === 12);

await Promise.all(Array.from({ length: 10 }, (_, i) => runScenario('reportes-usuarios', { zoneId: 'Z-MIR', count: 1, startIndex: 100 + i })));
await env.idle();
check('10 simultáneos (carrera)', 'exactamente 1 colectivo', (await coll('Z-MIR')).length, (await coll('Z-MIR')).length === 1);

await runScenario('antena-caida', { antennaId: 'ANT-LPA-02' });
await runScenario('antena-saturada', { antennaId: 'ANT-LPA-03' });
await env.idle();
const inf = (await listIncidents({})).filter((i) => i.kind === 'INFRAESTRUCTURA' && ['Z-SRN', 'Z-MIR', 'Z-LPA'].includes(i.zoneId));
check('Antenas anómalas simultáneas (3 zonas, 2 en Las Palmeras)', '4 incidentes de infraestructura (uno por antena)', inf.length, inf.length === 4);
const lpaColl = (await coll('Z-LPA'))[0];
check('Colectivo + 2 antenas anómalas misma zona', '2 relaciones, 12 usuarios (sin duplicar)', `${lpaColl?.relatedIncidentIds.length} relación(es), ${lpaColl?.uniqueReporters} usuarios`, lpaColl?.relatedIncidentIds.length === 2 && lpaColl?.uniqueReporters === 12);

await runScenario('recuperar', { antennaId: 'ANT-SRN-01' });
await env.idle();
const rec = (await listIncidents({})).find((i) => i.zoneId === 'Z-SRN' && i.kind === 'INFRAESTRUCTURA');
check('Recuperación (3 normales)', 'pendiente de verificación, no SOLUCIONADA', `${rec?.status}, verificación pendiente=${rec?.recovery?.pendingVerification}`, rec?.status !== 'SOLUCIONADA' && rec?.recovery?.pendingVerification === true);

await runScenario('recurrencia', { antennaId: 'ANT-VIN-02' });
await env.idle();
const vin = (await listAntennas()).find((a) => a.antennaId === 'ANT-VIN-02')!;
check('Recurrencia', '≥3 episodios ⇒ revisión estructural', `${vin.recurrence.episodesInWindow} episodios, revisión=${vin.recurrence.structuralReview}`, vin.recurrence.structuralReview);

const ai = (await listIncidents({})).map((i) => i.ai?.source);
check('IA sin configurar', 'respaldo etiquetado AI_UNAVAILABLE', [...new Set(ai)].join(','), ai.every((s) => s === 'AI_UNAVAILABLE'));
const st = await processingStats();
check('Ejecuciones del workflow', 'todas COMPLETADO, 0 FALLIDO', JSON.stringify(st.byStatus), st.byStatus.FALLIDO === 0 && st.byStatus.INICIADO === 0 && st.byStatus.EN_EJECUCION === 0);

console.log('\nTeleCorp Sentinel — demo de aceptación (MODO LOCAL EMULADO; no es evidencia de nube)\n');
console.table(rows.map((r) => ({ '': r.ok ? '✅' : '❌', escenario: r.escenario, esperado: r.esperado, obtenido: r.obtenido })));
const failed = rows.filter((r) => !r.ok).length;
console.log(failed ? `${failed} escenario(s) fallaron` : 'Todos los escenarios se cumplieron.');
process.exit(failed ? 1 : 0);
export {};
