import { nodeError } from '../../../_shared/node-error.js';
/** What would reach past the program (the host's files, loader or process), refused as Node refuses a feature its platform lacks. */
export function unavailable(feature) {
    throw nodeError(TypeError, 'ERR_FEATURE_UNAVAILABLE_ON_PLATFORM', `The feature ${feature} is unavailable on the current platform, which is being used to run Node.js`, undefined, unavailable);
}
