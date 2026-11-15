/**
 * Empaqueta los handlers de Lambda en un único módulo ESM (Node.js 22) con esbuild.
 * Salida: backend/dist/lambda/handlers.mjs (+ sourcemap). Serverless Framework
 * empaqueta ese artefacto (build integrado desactivado para controlar el formato ESM).
 */
import { build } from 'esbuild';
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';

rmSync('dist/lambda', { recursive: true, force: true });
await build({
  entryPoints: ['src/aws/handlers.ts'],
  outfile: 'dist/lambda/handlers.mjs',
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  sourcemap: true,
  minify: true,
  legalComments: 'none',
  // Algunos paquetes CJS requieren `require` en ESM:
  banner: { js: "import { createRequire as __cr } from 'module'; const require = __cr(import.meta.url);" },
});
const kb = Math.round(statSync('dist/lambda/handlers.mjs').size / 1024);
console.log(`dist/lambda/handlers.mjs (${kb} KB)`);

/**
 * Genera la DefinitionString de CloudFormation a partir de la MISMA definición ASL
 * usada localmente: cada marcador `${XxxArn}` se reemplaza por Fn::GetAtt de la
 * Lambda correspondiente, usando Fn::Join (evita `${}` que Serverless interpretaría).
 */
const asl = JSON.stringify(JSON.parse(readFileSync('statemachine/incident-workflow.asl.json', 'utf8')));
const fnFor: Record<string, string> = {
  LoadEventArn: 'WfLoadEventLambdaFunction',
  ValidateAndCorrelateArn: 'WfValidateAndCorrelateLambdaFunction',
  PersistIncidentAndHistoryArn: 'WfPersistIncidentAndHistoryLambdaFunction',
  CalculatePriorityArn: 'WfCalculatePriorityLambdaFunction',
  AnalyzeWithGcpArn: 'WfAnalyzeWithGcpLambdaFunction',
  BuildFallbackAnalysisArn: 'WfBuildFallbackAnalysisLambdaFunction',
  PersistAnalysisArn: 'WfPersistAnalysisLambdaFunction',
  PropagateStatusArn: 'WfPropagateStatusLambdaFunction',
  QueueNotificationsArn: 'WfQueueNotificationsLambdaFunction',
  MarkSucceededArn: 'WfMarkSucceededLambdaFunction',
  MarkFailedArn: 'WfMarkFailedLambdaFunction',
};
const parts: unknown[] = [];
let last = 0;
for (const m of asl.matchAll(/\$\{(\w+)\}/g)) {
  const logical = fnFor[m[1]];
  if (!logical) throw new Error(`Marcador ASL sin función: ${m[1]}`);
  parts.push(asl.slice(last, m.index), { 'Fn::GetAtt': [logical, 'Arn'] });
  last = m.index! + m[0].length;
}
parts.push(asl.slice(last));
if (parts.some((p) => typeof p === 'string' && p.includes('${'))) throw new Error('Quedaron marcadores sin reemplazar');
mkdirSync('dist', { recursive: true });
writeFileSync('dist/statemachine-definition.json', JSON.stringify({ 'Fn::Join': ['', parts] }, null, 1));
console.log(`dist/statemachine-definition.json (${Object.keys(fnFor).length} tareas Lambda)`);
