/**
 * session-id.ts — Friendly human-readable session identifiers.
 *
 * Format: `adjective-noun-NNNN` (e.g. `nimble-otter-4271`).
 *
 * Why friendly IDs rather than opaque crypto strings?
 *   - Shareable over voice/chat without character-by-character dictation.
 *   - Memorable enough to bookmark a sandbox and return to it.
 *   - Same UX convention as Vercel preview URLs / StackBlitz sandboxes.
 *
 * DO mapping: `env.NIMBUS_SESSION.idFromName(sessionId)` — deterministic.
 * No backing store required; the session ID IS the key.
 *
 * Entropy budget: ~200 adjectives × ~200 nouns × 10,000 numeric suffixes
 * ≈ 4 × 10⁸ combinations. Birthday-collision probability at 1M live
 * sessions ≈ 0.12%. Acceptable for v1. If we ever push past that scale,
 * widen the suffix to 6 digits (≈ 4 × 10¹⁰).
 *
 * Validation is strict: lowercase ASCII only, exact shape enforced.
 * `idFromName` is case-sensitive, so accepting mixed-case would fragment
 * sessions. Reject anything non-conforming with 400 before touching a DO.
 */

// Curated single-word adjectives. Lowercase ASCII, no profanity, no numbers,
// no compounds. Sort order doesn't matter — we index randomly.
const ADJECTIVES = [
  'agile', 'alert', 'amber', 'ancient', 'arctic', 'ardent', 'autumn', 'azure',
  'balmy', 'bashful', 'bitter', 'blissful', 'bold', 'bouncy', 'brave', 'breezy',
  'bright', 'brisk', 'bronze', 'burly', 'busy', 'calm', 'candid', 'carbon',
  'cheerful', 'chilly', 'classic', 'clever', 'cloudy', 'coastal', 'cobalt', 'cold',
  'cool', 'copper', 'cosmic', 'cosy', 'crimson', 'crisp', 'curious', 'daring',
  'dashing', 'dawn', 'dazzling', 'deep', 'dewy', 'distant', 'divine', 'dotted',
  'dreamy', 'dry', 'dusty', 'eager', 'early', 'earnest', 'eastern', 'easy',
  'elated', 'electric', 'elegant', 'emerald', 'endless', 'epic', 'even', 'fair',
  'fancy', 'faithful', 'faint', 'falling', 'famous', 'fancy', 'fast', 'fearless',
  'feisty', 'fiery', 'fine', 'firm', 'flat', 'fleeting', 'fluffy', 'flying',
  'focused', 'fond', 'foggy', 'forgiving', 'frosty', 'gentle', 'giddy', 'glad',
  'gleaming', 'glowing', 'golden', 'good', 'graceful', 'grand', 'grateful', 'green',
  'gusty', 'handy', 'happy', 'hardy', 'harmonic', 'hasty', 'hazy', 'healthy',
  'helpful', 'heroic', 'honest', 'hopeful', 'humble', 'icy', 'idle', 'indigo',
  'ironclad', 'ivory', 'jade', 'jolly', 'joyful', 'keen', 'kind', 'lively',
  'loyal', 'lucky', 'lunar', 'merry', 'mighty', 'mild', 'misty', 'modern',
  'modest', 'mossy', 'muted', 'mystic', 'nimble', 'noble', 'northern', 'noisy',
  'obsidian', 'orchid', 'patient', 'peachy', 'pearly', 'peppy', 'plucky', 'plum',
  'polar', 'polite', 'proud', 'pure', 'quick', 'quiet', 'quirky', 'radiant',
  'rapid', 'rare', 'ready', 'regal', 'resolute', 'rich', 'ripe', 'rosy',
  'royal', 'ruby', 'rustic', 'sage', 'salty', 'sandy', 'scarlet', 'serene',
  'sharp', 'shiny', 'silent', 'silken', 'silver', 'simple', 'sleepy', 'sleek',
  'slender', 'smart', 'smooth', 'snappy', 'snowy', 'solar', 'solemn', 'solid',
  'sonic', 'spicy', 'spirited', 'spry', 'stable', 'steady', 'stellar', 'steep',
  'stormy', 'stout', 'sturdy', 'subtle', 'summer', 'sunny', 'super', 'supple',
  'swift', 'tame', 'tangerine', 'tart', 'tender', 'thankful', 'tidy', 'tiny',
  'tireless', 'topaz', 'tranquil', 'trusty', 'twilight', 'twinkling', 'upbeat',
  'valiant', 'velvet', 'vibrant', 'vigilant', 'violet', 'vivid', 'wandering',
  'warm', 'wary', 'whimsical', 'wild', 'windy', 'winsome', 'witty', 'wise',
  'woolly', 'youthful', 'zealous', 'zen', 'zesty',
] as const;

// Curated single-word concrete nouns (mostly animals + natural features).
// Avoid anything culturally loaded, branded, or with negative connotations.
const NOUNS = [
  'acorn', 'alder', 'anchor', 'aspen', 'aster', 'axis', 'badger', 'bamboo',
  'basin', 'basil', 'beacon', 'beagle', 'bear', 'beaver', 'beetle', 'birch',
  'bison', 'blossom', 'bobcat', 'boulder', 'branch', 'breeze', 'briar', 'brook',
  'bubble', 'buffalo', 'butler', 'cactus', 'camel', 'canyon', 'capybara',
  'cardinal', 'caribou', 'cascade', 'castle', 'cavern', 'cedar', 'channel',
  'cheetah', 'cherry', 'chestnut', 'chipmunk', 'cinnamon', 'citrus', 'clam',
  'cliff', 'clover', 'coast', 'cobra', 'comet', 'coral', 'cosmos', 'cougar',
  'coyote', 'crane', 'creek', 'crocus', 'crystal', 'cub', 'cypress', 'dahlia',
  'daisy', 'deer', 'delta', 'diamond', 'dolphin', 'dove', 'dragon', 'dune',
  'eagle', 'ember', 'emu', 'falcon', 'fawn', 'fennel', 'fern', 'ferret',
  'finch', 'firefly', 'fjord', 'flame', 'flint', 'foal', 'forest', 'fossil',
  'fox', 'galaxy', 'garden', 'gazelle', 'gecko', 'geyser', 'gibbon', 'giraffe',
  'glacier', 'granite', 'grove', 'gull', 'harbor', 'harp', 'harvest', 'hawk',
  'hedge', 'heron', 'hickory', 'horizon', 'hornet', 'hummingbird', 'husky',
  'iguana', 'iris', 'island', 'jackal', 'jasmine', 'juniper', 'kestrel',
  'kingfisher', 'kite', 'koala', 'lagoon', 'lantern', 'lark', 'laurel',
  'lavender', 'lemur', 'leopard', 'lichen', 'lighthouse', 'lilac', 'lily',
  'lion', 'llama', 'lobster', 'lotus', 'lynx', 'magnolia', 'mallard', 'mango',
  'maple', 'marble', 'marlin', 'marmot', 'marsh', 'meadow', 'medallion',
  'meridian', 'meteor', 'mink', 'mint', 'mist', 'mockingbird', 'moose', 'moss',
  'mouse', 'mulberry', 'mustang', 'narwhal', 'nebula', 'nectar', 'newt',
  'nightingale', 'oak', 'oasis', 'ocean', 'ocelot', 'opal', 'orchid', 'oriole',
  'otter', 'owl', 'oyster', 'palm', 'panda', 'pangolin', 'panther', 'parrot',
  'peak', 'pebble', 'peony', 'petal', 'phoenix', 'pigeon', 'pine', 'piper',
  'plateau', 'poppy', 'prairie', 'puffin', 'puma', 'quail', 'quartz', 'quokka',
  'rabbit', 'raccoon', 'rapids', 'raven', 'reef', 'reindeer', 'ribbon', 'ridge',
  'river', 'robin', 'rose', 'sable', 'sage', 'salmon', 'sapphire', 'savanna',
  'seal', 'sequoia', 'shark', 'shrub', 'silo', 'skink', 'sky', 'snail',
  'snowflake', 'sparrow', 'spider', 'spire', 'spruce', 'squirrel', 'starling',
  'stingray', 'stone', 'stork', 'stream', 'summit', 'sunflower', 'swan',
  'swift', 'talon', 'tamarind', 'tapir', 'teal', 'tern', 'thicket', 'thistle',
  'thrush', 'tiger', 'toad', 'topaz', 'tortoise', 'toucan', 'tree', 'trout',
  'tulip', 'tundra', 'turtle', 'valley', 'vine', 'violet', 'viper', 'vista',
  'vole', 'walnut', 'warbler', 'waterfall', 'wave', 'weasel', 'whale', 'wharf',
  'wheat', 'whippet', 'willow', 'wisp', 'wolf', 'wombat', 'woodland',
  'woodpecker', 'yak', 'yew', 'zebra', 'zinnia',
] as const;

/** Strict shape check. Rejects empty, uppercase, missing-parts, extra-parts. */
const SESSION_ID_RE = /^[a-z]{3,14}-[a-z]{3,14}-\d{4}$/;

/**
 * Validate a session ID before touching a DO. Returns true iff the string
 * matches the exact `adjective-noun-NNNN` shape. Length bounds on each part
 * are deliberately looser than our own word lists so future list growth
 * doesn't invalidate bookmarked URLs.
 */
export function isValidSessionId(id: string | null | undefined): boolean {
  if (typeof id !== 'string') return false;
  if (id.length < 9 || id.length > 40) return false;
  return SESSION_ID_RE.test(id);
}

/**
 * Generate a fresh session ID. Uses crypto.getRandomValues for uniform
 * sampling — NOT Math.random (which on Workers is seeded at isolate start
 * and can repeat across concurrent requests that share an isolate).
 *
 * Suffix is a 4-digit zero-padded decimal (0000–9999), so parseInt can
 * round-trip it cleanly if anyone ever needs to sort/compare.
 */
export function generateSessionId(): string {
  const buf = new Uint32Array(3);
  crypto.getRandomValues(buf);
  const adj = ADJECTIVES[buf[0] % ADJECTIVES.length];
  const noun = NOUNS[buf[1] % NOUNS.length];
  const num = (buf[2] % 10000).toString().padStart(4, '0');
  return `${adj}-${noun}-${num}`;
}


