/**
 * The contract between the command router and the bots.
 *
 * Discord posts every interaction to one HTTPS endpoint; that endpoint decides
 * which bot should run it and queues it for that bot alone. Everything either
 * side needs to agree on lives here — the visibility of the acknowledgement,
 * the envelope on the wire, and the decision itself.
 */
export * from './claims.js';
export * from './custom-id.js';
export * from './deferral.js';
export * from './envelope.js';
export * from './route.js';
