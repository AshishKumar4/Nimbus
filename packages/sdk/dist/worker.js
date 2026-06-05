/**
 * @nimbus-sh/sdk/worker - Cloudflare Worker embedder surface.
 *
 * This is the public entrypoint for deploying Nimbus itself inside a
 * Worker. The implementation is provided by @nimbus-sh/worker, but apps
 * should import through the SDK so the interactive app and programmatic
 * sandbox APIs share one public package surface.
 */
export { NimbusSession, SupervisorRPC, NimbusAssetsRPC, NimbusLoaderRPC, NimbusLoadedWorker, NimbusLoadedEntrypoint, NimbusDurableObjectNamespace, NimbusDOStub, CirrusHmrRPC, createNimbusHandler, issueNimbusToken, verifyNimbusToken, NimbusAuthError, } from '@nimbus-sh/worker';
