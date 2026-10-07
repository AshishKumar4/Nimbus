// A source map's `mappings`, decoded: the oracle the build sourcemap tests
// check rolldown's maps against.

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/**
 * The original [line, column] (1-based line, 0-based column) the generated
 * `line` (1-based) and `column` map to: the last segment on that line
 * starting at or before `column`. Null when the line has none.
 */
export function originalPosition(sourceMap, line, column) {
  const state = [0, 0, 0, 0];
  let found = null;
  sourceMap.mappings.split(';').forEach((segments, generated) => {
    let col = 0;
    for (const segment of segments.split(',').filter(Boolean)) {
      const fields = [];
      for (let i = 0, value = 0, shift = 0; i < segment.length; i++) {
        const digit = B64.indexOf(segment[i]);
        value += (digit & 31) << shift;
        if (digit & 32) shift += 5;
        else { fields.push(value & 1 ? -(value >>> 1) : value >>> 1); value = 0; shift = 0; }
      }
      col += fields[0];
      for (let i = 1; i < fields.length; i++) state[i - 1] += fields[i];
      if (generated === line - 1 && fields.length > 1 && col <= column) found = [state[1] + 1, state[2]];
    }
  });
  return found;
}
