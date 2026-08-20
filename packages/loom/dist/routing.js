/**
 * routing.ts — URL → binding → named actor instance.
 *
 * partyserver's router already is the mechanism loom wants: it maps
 * `/${prefix}/<binding-kebab>/<name>` onto the Durable Object binding, with
 * `onBeforeConnect`/`onBeforeRequest` gates, CORS, jurisdiction, location
 * hints, and retry over transient DO routing errors. Wrapping it in a
 * parallel implementation would be a drift channel, so loom re-exports it
 * under its own names. The URL convention stays `/parties/...` by default —
 * it is the wire contract PartySocket-family clients build URLs from.
 */
export { routePartykitRequest as routeActorRequest, getServerByName as getActorByName, } from 'partyserver';
