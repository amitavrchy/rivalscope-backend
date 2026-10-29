import 'dotenv/config';
import * as Sentry from '@sentry/node';

// External export is opt-in: no telemetry is sent unless the operator configures a destination.
if (process.env.OTEL_EXPORTER_OTLP_ENDPOINT) {
  const [{ NodeSDK }, { getNodeAutoInstrumentations }, { OTLPTraceExporter }] = await Promise.all([import('@opentelemetry/sdk-node'), import('@opentelemetry/auto-instrumentations-node'), import('@opentelemetry/exporter-trace-otlp-http')]);
  const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT.replace(/\/$/, '');
  const sdk = new NodeSDK({ traceExporter: new OTLPTraceExporter({ url: `${endpoint}/v1/traces` }), instrumentations: [getNodeAutoInstrumentations({ '@opentelemetry/instrumentation-fs': { enabled: false }, '@opentelemetry/instrumentation-http': { ignoreIncomingRequestHook: req => /^\/api\/(?:auth|account|privacy)(?:\/|\?)/.test(req.url||''), ignoreOutgoingRequestHook: options => /(?:hooks\.slack\.com|discord(?:app)?\.com)/i.test(String(options.hostname||options.host||'')) } })] });
  sdk.start(); process.on('SIGTERM', () => { void sdk.shutdown(); });
}
if (process.env.SENTRY_DSN) Sentry.init({ dsn: process.env.SENTRY_DSN, environment: process.env.NODE_ENV, defaultIntegrations: false, dataCollection: { userInfo: false, cookies: false, httpHeaders: false, httpBodies: [], urlQueryParams: false, genAI: { inputs: false, outputs: false }, mcp: { inputs: false, outputs: false }, graphQL: { document: false, variables: false } }, includeServerName: false, tracesSampleRate: 0, beforeSend(event) { delete event.request; delete event.user; delete event.breadcrumbs; return event; } });
export function captureSanitizedError(error: unknown) {
  if (process.env.SENTRY_DSN) Sentry.captureException(new Error(error instanceof Error ? `${error.constructor.name}: request failed` : 'Unknown request failure'));
}
