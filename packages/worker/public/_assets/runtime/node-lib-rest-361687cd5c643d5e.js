module.exports = { sources: {
    "internal/source_map/source_map": function (exports, require, module, process, internalBinding, primordials) {
// This file is a modified version of:
// https://cs.chromium.org/chromium/src/v8/tools/SourceMap.js?rcl=dd10454c1d
// from the V8 codebase. Logic specific to WebInspector is removed and linting
// is made to match the Node.js style guide.

// Copyright 2013 the V8 project authors. All rights reserved.
// Redistribution and use in source and binary forms, with or without
// modification, are permitted provided that the following conditions are
// met:
//
//     * Redistributions of source code must retain the above copyright
//       notice, this list of conditions and the following disclaimer.
//     * Redistributions in binary form must reproduce the above
//       copyright notice, this list of conditions and the following
//       disclaimer in the documentation and/or other materials provided
//       with the distribution.
//     * Neither the name of Google Inc. nor the names of its
//       contributors may be used to endorse or promote products derived
//       from this software without specific prior written permission.
//
// THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS
// "AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT
// LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR
// A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT
// OWNER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL,
// SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT
// LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE,
// DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY
// THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
// (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
// OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.

// This is a copy from blink dev tools, see:
// http://src.chromium.org/viewvc/blink/trunk/Source/devtools/front_end/SourceMap.js
// revision: 153407

/*
 * Copyright (C) 2012 Google Inc. All rights reserved.
 *
 * Redistribution and use in source and binary forms, with or without
 * modification, are permitted provided that the following conditions are
 * met:
 *
 *     * Redistributions of source code must retain the above copyright
 * notice, this list of conditions and the following disclaimer.
 *     * Redistributions in binary form must reproduce the above
 * copyright notice, this list of conditions and the following disclaimer
 * in the documentation and/or other materials provided with the
 * distribution.
 *     * Neither the name of Google Inc. nor the names of its
 * contributors may be used to endorse or promote products derived from
 * this software without specific prior written permission.
 *
 * THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS
 * "AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT
 * LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR
 * A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT
 * OWNER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL,
 * SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT
 * LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE,
 * DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY
 * THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
 * (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
 * OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
 */

'use strict';

const {
  ArrayIsArray,
  ArrayPrototypePush,
  ArrayPrototypeSlice,
  ArrayPrototypeSort,
  ObjectPrototypeHasOwnProperty,
  StringPrototypeCharAt,
  Symbol,
} = primordials;

const { validateObject } = require('internal/validators');

let base64Map;

const VLQ_BASE_SHIFT = 5;
const VLQ_BASE_MASK = (1 << 5) - 1;
const VLQ_CONTINUATION_MASK = 1 << 5;

const kMappings = Symbol('kMappings');

class StringCharIterator {
  /**
   * @constructor
   * @param {string} string
   */
  constructor(string) {
    this._string = string;
    this._position = 0;
  }

  /**
   * @return {string}
   */
  next() {
    return StringPrototypeCharAt(this._string, this._position++);
  }

  /**
   * @return {string}
   */
  peek() {
    return StringPrototypeCharAt(this._string, this._position);
  }

  /**
   * @return {boolean}
   */
  hasNext() {
    return this._position < this._string.length;
  }
}

/**
 * Implements Source Map V3 model.
 * See https://github.com/google/closure-compiler/wiki/Source-Maps
 * for format description.
 */
class SourceMap {
  #payload;
  #mappings = [];
  #sources = {};
  #sourceContentByURL = {};
  #lineLengths = undefined;

  /**
   * @constructor
   * @param {SourceMapV3} payload
   */
  constructor(payload, { lineLengths } = { __proto__: null }) {
    if (!base64Map) {
      const base64Digits =
             'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
      base64Map = {};
      for (let i = 0; i < base64Digits.length; ++i)
        base64Map[base64Digits[i]] = i;
    }
    this.#payload = cloneSourceMapV3(payload);
    this.#parseMappingPayload();
    if (ArrayIsArray(lineLengths) && lineLengths.length) {
      this.#lineLengths = lineLengths;
    }
  }

  /**
   * @return {object} raw source map v3 payload.
   */
  get payload() {
    return cloneSourceMapV3(this.#payload);
  }

  get [kMappings]() {
    return this.#mappings;
  }

  /**
   * @return {number[] | undefined} line lengths of generated source code
   */
  get lineLengths() {
    if (this.#lineLengths) {
      return ArrayPrototypeSlice(this.#lineLengths);
    }
    return undefined;
  }

  #parseMappingPayload = () => {
    if (this.#payload.sections) {
      this.#parseSections(this.#payload.sections);
    } else {
      this.#parseMap(this.#payload, 0, 0);
    }
    ArrayPrototypeSort(this.#mappings, compareSourceMapEntry);
  };

  /**
   * @param {Array.<SourceMapV3.Section>} sections
   */
  #parseSections = (sections) => {
    for (let i = 0; i < sections.length; ++i) {
      const section = sections[i];
      this.#parseMap(section.map, section.offset.line, section.offset.column);
    }
  };

  /**
   * @param {number} lineOffset 0-indexed line offset in compiled resource
   * @param {number} columnOffset 0-indexed column offset in compiled resource
   * @return {object} representing start of range if found, or empty object
   */
  findEntry(lineOffset, columnOffset) {
    let first = 0;
    let count = this.#mappings.length;
    while (count > 1) {
      const step = count >> 1;
      const middle = first + step;
      const mapping = this.#mappings[middle];
      if (lineOffset < mapping[0] ||
          (lineOffset === mapping[0] && columnOffset < mapping[1])) {
        count = step;
      } else {
        first = middle;
        count -= step;
      }
    }
    const entry = this.#mappings[first];
    if (!first && entry && (lineOffset < entry[0] ||
        (lineOffset === entry[0] && columnOffset < entry[1]))) {
      return {};
    } else if (!entry) {
      return {};
    }
    return {
      generatedLine: entry[0],
      generatedColumn: entry[1],
      originalSource: entry[2],
      originalLine: entry[3],
      originalColumn: entry[4],
      name: entry[5],
    };
  }

  /**
   * @param {number} lineNumber 1-indexed line number in compiled resource call site
   * @param {number} columnNumber 1-indexed column number in compiled resource call site
   * @return {object} representing origin call site if found, or empty object
   */
  findOrigin(lineNumber, columnNumber) {
    const range = this.findEntry(lineNumber - 1, columnNumber - 1);
    if (
      range.originalSource === undefined ||
      range.originalLine === undefined ||
      range.originalColumn === undefined ||
      range.generatedLine === undefined ||
      range.generatedColumn === undefined
    ) {
      return {};
    }
    const lineOffset = lineNumber - range.generatedLine;
    const columnOffset = columnNumber - range.generatedColumn;
    return {
      name: range.name,
      fileName: range.originalSource,
      lineNumber: range.originalLine + lineOffset,
      columnNumber: range.originalColumn + columnOffset,
    };
  }

  /**
   * @override
   */
  #parseMap(map, lineNumber, columnNumber) {
    let sourceIndex = 0;
    let sourceLineNumber = 0;
    let sourceColumnNumber = 0;
    let nameIndex = 0;

    const sources = [];
    const originalToCanonicalURLMap = {};
    for (let i = 0; i < map.sources.length; ++i) {
      const url = map.sources[i];
      originalToCanonicalURLMap[url] = url;
      ArrayPrototypePush(sources, url);
      this.#sources[url] = true;

      if (map.sourcesContent?.[i])
        this.#sourceContentByURL[url] = map.sourcesContent[i];
    }

    const stringCharIterator = new StringCharIterator(map.mappings);
    let sourceURL = sources[sourceIndex];
    while (true) {
      if (stringCharIterator.peek() === ',')
        stringCharIterator.next();
      else {
        while (stringCharIterator.peek() === ';') {
          lineNumber += 1;
          columnNumber = 0;
          stringCharIterator.next();
        }
        if (!stringCharIterator.hasNext())
          break;
      }

      columnNumber += decodeVLQ(stringCharIterator);
      if (isSeparator(stringCharIterator.peek())) {
        ArrayPrototypePush(this.#mappings, [lineNumber, columnNumber]);
        continue;
      }

      const sourceIndexDelta = decodeVLQ(stringCharIterator);
      if (sourceIndexDelta) {
        sourceIndex += sourceIndexDelta;
        sourceURL = sources[sourceIndex];
      }
      sourceLineNumber += decodeVLQ(stringCharIterator);
      sourceColumnNumber += decodeVLQ(stringCharIterator);

      let name;
      if (!isSeparator(stringCharIterator.peek())) {
        nameIndex += decodeVLQ(stringCharIterator);
        name = map.names?.[nameIndex];
      }

      ArrayPrototypePush(
        this.#mappings,
        [lineNumber, columnNumber, sourceURL, sourceLineNumber,
         sourceColumnNumber, name],
      );
    }
  }
}

/**
 * @param {string} char
 * @return {boolean}
 */
function isSeparator(char) {
  return char === ',' || char === ';';
}

/**
 * @param {SourceMap.StringCharIterator} stringCharIterator
 * @return {number}
 */
function decodeVLQ(stringCharIterator) {
  // Read unsigned value.
  let result = 0;
  let shift = 0;
  let digit;
  do {
    digit = base64Map[stringCharIterator.next()];
    result += (digit & VLQ_BASE_MASK) << shift;
    shift += VLQ_BASE_SHIFT;
  } while (digit & VLQ_CONTINUATION_MASK);

  // Fix the sign.
  const negative = result & 1;
  // Use unsigned right shift, so that the 32nd bit is properly shifted to the
  // 31st, and the 32nd becomes unset.
  result >>>= 1;
  if (!negative) {
    return result;
  }

  // We need to OR here to ensure the 32nd bit (the sign bit in an Int32) is
  // always set for negative numbers. If `result` were 1, (meaning `negate` is
  // true and all other bits were zeros), `result` would now be 0. But -0
  // doesn't flip the 32nd bit as intended. All other numbers will successfully
  // set the 32nd bit without issue, so doing this is a noop for them.
  return -result | (1 << 31);
}

/**
 * @param {SourceMapV3} payload
 * @return {SourceMapV3}
 */
function cloneSourceMapV3(payload) {
  validateObject(payload, 'payload');
  payload = { ...payload };
  for (const key in payload) {
    if (ObjectPrototypeHasOwnProperty(payload, key) &&
        ArrayIsArray(payload[key])) {
      payload[key] = ArrayPrototypeSlice(payload[key]);
    }
  }
  return payload;
}

/**
 * @param {Array} entry1 source map entry [lineNumber, columnNumber, sourceURL,
 *  sourceLineNumber, sourceColumnNumber]
 * @param {Array} entry2 source map entry.
 * @return {number}
 */
function compareSourceMapEntry(entry1, entry2) {
  const { 0: lineNumber1, 1: columnNumber1 } = entry1;
  const { 0: lineNumber2, 1: columnNumber2 } = entry2;
  if (lineNumber1 !== lineNumber2) {
    return lineNumber1 - lineNumber2;
  }
  return columnNumber1 - columnNumber2;
}

module.exports = {
  kMappings,
  SourceMap,
};

    },
    "internal/util/colors": function (exports, require, module, process, internalBinding, primordials) {
'use strict';

let internalTTy;
function lazyInternalTTY() {
  internalTTy ??= require('internal/tty');
  return internalTTy;
}

module.exports = {
  blue: '',
  green: '',
  white: '',
  red: '',
  gray: '',
  clear: '',
  reset: '',
  hasColors: false,
  shouldColorize(stream) {
    if (process.env.FORCE_COLOR !== undefined) {
      return lazyInternalTTY().getColorDepth() > 2;
    }
    return stream?.isTTY && (
      typeof stream.getColorDepth === 'function' ?
        stream.getColorDepth() > 2 : true);
  },
  refresh() {
    const hasColors = module.exports.shouldColorize(process.stderr);
    module.exports.blue = hasColors ? '\u001b[34m' : '';
    module.exports.green = hasColors ? '\u001b[32m' : '';
    module.exports.white = hasColors ? '\u001b[39m' : '';
    module.exports.yellow = hasColors ? '\u001b[33m' : '';
    module.exports.red = hasColors ? '\u001b[31m' : '';
    module.exports.gray = hasColors ? '\u001b[90m' : '';
    module.exports.clear = hasColors ? '\u001bc' : '';
    module.exports.reset = hasColors ? '\u001b[0m' : '';
    module.exports.hasColors = hasColors;
  },
};

module.exports.refresh();

    },
    "internal/util/comparisons": function (exports, require, module, process, internalBinding, primordials) {
'use strict';

const {
  Array,
  ArrayBuffer,
  ArrayIsArray,
  ArrayPrototypeFilter,
  ArrayPrototypePush,
  BigInt,
  BigInt64Array,
  BigIntPrototypeValueOf,
  BigUint64Array,
  Boolean,
  BooleanPrototypeValueOf,
  DataView,
  Date,
  DatePrototypeGetTime,
  Error,
  Float32Array,
  Float64Array,
  Function,
  Int16Array,
  Int32Array,
  Int8Array,
  Map,
  Number,
  NumberPrototypeValueOf,
  Object,
  ObjectGetOwnPropertyDescriptor,
  ObjectGetOwnPropertySymbols: getOwnSymbols,
  ObjectGetPrototypeOf,
  ObjectIs,
  ObjectKeys,
  ObjectPrototypeHasOwnProperty: hasOwn,
  ObjectPrototypePropertyIsEnumerable: hasEnumerable,
  ObjectPrototypeToString,
  Promise,
  RegExp,
  SafeSet,
  Set,
  String,
  StringPrototypeValueOf,
  Symbol,
  SymbolPrototypeValueOf,
  TypedArrayPrototypeGetByteLength: getByteLength,
  TypedArrayPrototypeGetSymbolToStringTag,
  Uint16Array,
  Uint32Array,
  Uint8Array,
  Uint8ClampedArray,
  WeakMap,
  WeakSet,
  globalThis: { Float16Array },
} = primordials;

const { compare } = internalBinding('buffer');
const assert = require('internal/assert');
const { isError } = require('internal/util');
const { isURL } = require('internal/url');
const { Buffer } = require('buffer');

const wellKnownConstructors = new SafeSet()
  .add(Array)
  .add(ArrayBuffer)
  .add(BigInt)
  .add(BigInt64Array)
  .add(BigUint64Array)
  .add(Boolean)
  .add(Buffer)
  .add(DataView)
  .add(Date)
  .add(Error)
  .add(Float32Array)
  .add(Float64Array)
  .add(Function)
  .add(Int16Array)
  .add(Int32Array)
  .add(Int8Array)
  .add(Map)
  .add(Number)
  .add(Object)
  .add(Promise)
  .add(RegExp)
  .add(Set)
  .add(String)
  .add(Symbol)
  .add(Uint16Array)
  .add(Uint32Array)
  .add(Uint8Array)
  .add(Uint8ClampedArray)
  .add(WeakMap)
  .add(WeakSet);

if (Float16Array) { // TODO(BridgeAR): Remove when regularly supported
  wellKnownConstructors.add(Float16Array);
}

const types = require('internal/util/types');
const {
  isAnyArrayBuffer,
  isArrayBufferView,
  isDate,
  isMap,
  isRegExp,
  isSet,
  isNativeError,
  isBoxedPrimitive,
  isNumberObject,
  isStringObject,
  isBooleanObject,
  isBigIntObject,
  isSymbolObject,
  isFloat16Array,
  isFloat32Array,
  isFloat64Array,
  isKeyObject,
  isCryptoKey,
  isWeakMap,
  isWeakSet,
} = types;
const {
  constants: {
    ONLY_ENUMERABLE,
    SKIP_SYMBOLS,
  },
  getOwnNonIndexProperties,
} = internalBinding('util');

const kStrict = 1;
const kLoose = 0;
const kPartial = 2;

const kNoIterator = 0;
const kIsArray = 1;
const kIsSet = 2;
const kIsMap = 3;

let kKeyObject;

// Check if they have the same source and flags
function areSimilarRegExps(a, b) {
  return a.source === b.source &&
         a.flags === b.flags &&
         a.lastIndex === b.lastIndex;
}

function isPartialUint8Array(a, b) {
  const lenA = getByteLength(a);
  const lenB = getByteLength(b);
  if (lenA < lenB) {
    return false;
  }
  let offsetA = 0;
  for (let offsetB = 0; offsetB < lenB; offsetB++) {
    while (!ObjectIs(a[offsetA], b[offsetB])) {
      offsetA++;
      if (offsetA > lenA - lenB + offsetB) {
        return false;
      }
    }
    offsetA++;
  }
  return true;
}

function isPartialArrayBufferView(a, b) {
  if (a.byteLength < b.byteLength) {
    return false;
  }
  return isPartialUint8Array(
    new Uint8Array(a.buffer, a.byteOffset, a.byteLength),
    new Uint8Array(b.buffer, b.byteOffset, b.byteLength),
  );
}

function areSimilarFloatArrays(a, b) {
  const len = getByteLength(a);
  if (len !== getByteLength(b)) {
    return false;
  }
  for (let offset = 0; offset < len; offset++) {
    if (a[offset] !== b[offset]) {
      return false;
    }
  }
  return true;
}

function areSimilarTypedArrays(a, b) {
  if (a.byteLength !== b.byteLength) {
    return false;
  }
  return compare(new Uint8Array(a.buffer, a.byteOffset, a.byteLength),
                 new Uint8Array(b.buffer, b.byteOffset, b.byteLength)) === 0;
}

function areEqualArrayBuffers(buf1, buf2) {
  return buf1.byteLength === buf2.byteLength &&
    compare(new Uint8Array(buf1), new Uint8Array(buf2)) === 0;
}

function isEqualBoxedPrimitive(val1, val2) {
  if (isNumberObject(val1)) {
    return isNumberObject(val2) &&
           ObjectIs(NumberPrototypeValueOf(val1),
                    NumberPrototypeValueOf(val2));
  }
  if (isStringObject(val1)) {
    return isStringObject(val2) &&
           StringPrototypeValueOf(val1) === StringPrototypeValueOf(val2);
  }
  if (isBooleanObject(val1)) {
    return isBooleanObject(val2) &&
           BooleanPrototypeValueOf(val1) === BooleanPrototypeValueOf(val2);
  }
  if (isBigIntObject(val1)) {
    return isBigIntObject(val2) &&
           BigIntPrototypeValueOf(val1) === BigIntPrototypeValueOf(val2);
  }
  if (isSymbolObject(val1)) {
    return isSymbolObject(val2) &&
          SymbolPrototypeValueOf(val1) === SymbolPrototypeValueOf(val2);
  }
  /* c8 ignore next */
  assert.fail(`Unknown boxed type ${val1}`);
}

function isEnumerableOrIdentical(val1, val2, prop, mode, memos, method) {
  return hasEnumerable(val2, prop) || // This is handled by Object.keys()
      (mode === kPartial && (val2[prop] === undefined || (prop === 'message' && val2[prop] === ''))) ||
      innerDeepEqual(val1[prop], val2[prop], mode, memos);
}

function innerDeepEqual(val1, val2, mode, memos) {
  // All identical values are equivalent, as determined by ===.
  if (val1 === val2) {
    return val1 !== 0 || ObjectIs(val1, val2) || mode === kLoose;
  }

  // Check more closely if val1 and val2 are equal.
  if (mode !== kLoose) {
    if (typeof val1 === 'number') {
      // Check for NaN
      // eslint-disable-next-line no-self-compare
      return val1 !== val1 && val2 !== val2;
    }
    if (typeof val2 !== 'object' ||
        typeof val1 !== 'object' ||
        val1 === null ||
        val2 === null) {
      return false;
    }
  } else {
    if (val1 === null || typeof val1 !== 'object') {
      return (val2 === null || typeof val2 !== 'object') &&
             // Check for NaN
             // eslint-disable-next-line eqeqeq, no-self-compare
             (val1 == val2 || (val1 !== val1 && val2 !== val2));
    }
    if (val2 === null || typeof val2 !== 'object') {
      return false;
    }
  }
  return objectComparisonStart(val1, val2, mode, memos);
}

function objectComparisonStart(val1, val2, mode, memos) {
  if (mode === kStrict) {
    if (wellKnownConstructors.has(val1.constructor) ||
        (val1.constructor !== undefined && !hasOwn(val1, 'constructor'))) {
      if (val1.constructor !== val2.constructor) {
        return false;
      }
    } else if (ObjectGetPrototypeOf(val1) !== ObjectGetPrototypeOf(val2)) {
      return false;
    }
  }

  const val1Tag = ObjectPrototypeToString(val1);
  const val2Tag = ObjectPrototypeToString(val2);

  if (val1Tag !== val2Tag) {
    return false;
  }

  if (ArrayIsArray(val1)) {
    if (!ArrayIsArray(val2) ||
        (val1.length !== val2.length && (mode !== kPartial || val1.length < val2.length))) {
      return false;
    }

    const filter = mode !== kLoose ? ONLY_ENUMERABLE : ONLY_ENUMERABLE | SKIP_SYMBOLS;
    const keys2 = getOwnNonIndexProperties(val2, filter);
    if (mode !== kPartial &&
        keys2.length !== getOwnNonIndexProperties(val1, filter).length) {
      return false;
    }
    return keyCheck(val1, val2, mode, memos, kIsArray, keys2);
  } else if (val1Tag === '[object Object]') {
    return keyCheck(val1, val2, mode, memos, kNoIterator);
  } else if (isDate(val1)) {
    if (!isDate(val2) ||
        DatePrototypeGetTime(val1) !== DatePrototypeGetTime(val2)) {
      return false;
    }
  } else if (isRegExp(val1)) {
    if (!isRegExp(val2) || !areSimilarRegExps(val1, val2)) {
      return false;
    }
  } else if (isArrayBufferView(val1)) {
    if (TypedArrayPrototypeGetSymbolToStringTag(val1) !==
        TypedArrayPrototypeGetSymbolToStringTag(val2)) {
      return false;
    }
    if (mode === kPartial && val1.byteLength !== val2.byteLength) {
      if (!isPartialArrayBufferView(val1, val2)) {
        return false;
      }
    } else if (mode === kLoose &&
               (isFloat32Array(val1) || isFloat64Array(val1) || isFloat16Array(val1))) {
      if (!areSimilarFloatArrays(val1, val2)) {
        return false;
      }
    } else if (!areSimilarTypedArrays(val1, val2)) {
      return false;
    }
    // Buffer.compare returns true, so val1.length === val2.length. If they both
    // only contain numeric keys, we don't need to exam further than checking
    // the symbols.
    const filter = mode !== kLoose ? ONLY_ENUMERABLE : ONLY_ENUMERABLE | SKIP_SYMBOLS;
    const keys2 = getOwnNonIndexProperties(val2, filter);
    if (mode !== kPartial &&
        keys2.length !== getOwnNonIndexProperties(val1, filter).length) {
      return false;
    }
    return keyCheck(val1, val2, mode, memos, kNoIterator, keys2);
  } else if (isSet(val1)) {
    if (!isSet(val2) ||
        (val1.size !== val2.size && (mode !== kPartial || val1.size < val2.size))) {
      return false;
    }
    return keyCheck(val1, val2, mode, memos, kIsSet);
  } else if (isMap(val1)) {
    if (!isMap(val2) ||
        (val1.size !== val2.size && (mode !== kPartial || val1.size < val2.size))) {
      return false;
    }
    return keyCheck(val1, val2, mode, memos, kIsMap);
  } else if (isAnyArrayBuffer(val1)) {
    if (!isAnyArrayBuffer(val2)) {
      return false;
    }
    if (mode !== kPartial || val1.byteLength === val2.byteLength) {
      if (!areEqualArrayBuffers(val1, val2)) {
        return false;
      }
    } else if (!isPartialUint8Array(new Uint8Array(val1), new Uint8Array(val2))) {
      return false;
    }
  } else if (isError(val1)) {
    // Do not compare the stack as it might differ even though the error itself
    // is otherwise identical.
    if (!isError(val2) ||
        !isEnumerableOrIdentical(val1, val2, 'message', mode, memos) ||
        !isEnumerableOrIdentical(val1, val2, 'name', mode, memos) ||
        !isEnumerableOrIdentical(val1, val2, 'cause', mode, memos) ||
        !isEnumerableOrIdentical(val1, val2, 'errors', mode, memos)) {
      return false;
    }
    const hasOwnVal2Cause = hasOwn(val2, 'cause');
    if ((hasOwnVal2Cause !== hasOwn(val1, 'cause') && (mode !== kPartial || hasOwnVal2Cause))) {
      return false;
    }
  } else if (isBoxedPrimitive(val1)) {
    if (!isEqualBoxedPrimitive(val1, val2)) {
      return false;
    }
  } else if (ArrayIsArray(val2) ||
             isArrayBufferView(val2) ||
             isSet(val2) ||
             isMap(val2) ||
             isDate(val2) ||
             isRegExp(val2) ||
             isAnyArrayBuffer(val2) ||
             isBoxedPrimitive(val2) ||
             isNativeError(val2) ||
             val2 instanceof Error) {
    return false;
  } else if (isURL(val1)) {
    if (!isURL(val2) || val1.href !== val2.href) {
      return false;
    }
  } else if (isKeyObject(val1)) {
    if (!isKeyObject(val2) || !val1.equals(val2)) {
      return false;
    }
  } else if (isCryptoKey(val1)) {
    kKeyObject ??= require('internal/crypto/util').kKeyObject;
    if (!isCryptoKey(val2) ||
      val1.extractable !== val2.extractable ||
      !innerDeepEqual(val1.algorithm, val2.algorithm, mode, memos) ||
      !innerDeepEqual(val1.usages, val2.usages, mode, memos) ||
      !innerDeepEqual(val1[kKeyObject], val2[kKeyObject], mode, memos)
    ) {
      return false;
    }
  } else if (isWeakMap(val1) || isWeakSet(val1)) {
    return false;
  }

  return keyCheck(val1, val2, mode, memos, kNoIterator);
}

function getEnumerables(val, keys) {
  return ArrayPrototypeFilter(keys, (key) => hasEnumerable(val, key));
}

function partialSymbolEquiv(val1, val2, keys2) {
  const symbolKeys = getOwnSymbols(val2);
  if (symbolKeys.length !== 0) {
    for (const key of symbolKeys) {
      if (hasEnumerable(val2, key)) {
        if (!hasEnumerable(val1, key)) {
          return false;
        }
        ArrayPrototypePush(keys2, key);
      }
    }
  }
  return true;
}

function keyCheck(val1, val2, mode, memos, iterationType, keys2) {
  // For all remaining Object pairs, including Array, objects and Maps,
  // equivalence is determined by having:
  // a) The same number of owned enumerable properties
  // b) The same set of keys/indexes (although not necessarily the same order)
  // c) Equivalent values for every corresponding key/index
  // d) For Sets and Maps, equal contents
  // Note: this accounts for both named and indexed properties on Arrays.
  const isArrayLikeObject = keys2 !== undefined;

  if (keys2 === undefined) {
    keys2 = ObjectKeys(val2);
  }
  let keys1;

  if (!isArrayLikeObject) {
    // The pair must have the same number of owned properties.
    if (mode === kPartial) {
      if (!partialSymbolEquiv(val1, val2, keys2)) {
        return false;
      }
    } else if (keys2.length !== (keys1 = ObjectKeys(val1)).length) {
      return false;
    } else if (mode === kStrict) {
      const symbolKeysA = getOwnSymbols(val1);
      if (symbolKeysA.length !== 0) {
        let count = 0;
        for (const key of symbolKeysA) {
          if (hasEnumerable(val1, key)) {
            if (!hasEnumerable(val2, key)) {
              return false;
            }
            ArrayPrototypePush(keys2, key);
            count++;
          } else if (hasEnumerable(val2, key)) {
            return false;
          }
        }
        const symbolKeysB = getOwnSymbols(val2);
        if (symbolKeysA.length !== symbolKeysB.length &&
            getEnumerables(val2, symbolKeysB).length !== count) {
          return false;
        }
      } else {
        const symbolKeysB = getOwnSymbols(val2);
        if (symbolKeysB.length !== 0 &&
            getEnumerables(val2, symbolKeysB).length !== 0) {
          return false;
        }
      }
    }
  }

  if (keys2.length === 0 &&
      (iterationType === kNoIterator ||
        (iterationType === kIsArray && val2.length === 0) ||
        val2.size === 0)) {
    return true;
  }

  if (memos === null) {
    return objEquiv(val1, val2, mode, keys1, keys2, memos, iterationType);
  }
  return handleCycles(val1, val2, mode, keys1, keys2, memos, iterationType);
}

function handleCycles(val1, val2, mode, keys1, keys2, memos, iterationType) {
  // Use memos to handle cycles.
  if (memos === undefined) {
    memos = {
      set: undefined,
      a: val1,
      b: val2,
      c: undefined,
      d: undefined,
      deep: false,
    };
    return objEquiv(val1, val2, mode, keys1, keys2, memos, iterationType);
  }

  if (memos.set === undefined) {
    if (memos.deep === false) {
      if (memos.a === val1) {
        if (memos.b === val2) return true;
      }
      memos.c = val1;
      memos.d = val2;
      memos.deep = true;
      const result = objEquiv(val1, val2, mode, keys1, keys2, memos, iterationType);
      memos.deep = false;
      return result;
    }
    memos.set = new SafeSet();
    memos.set.add(memos.a);
    memos.set.add(memos.b);
    memos.set.add(memos.c);
    memos.set.add(memos.d);
  }

  const { set } = memos;

  const originalSize = set.size;
  set.add(val1);
  set.add(val2);
  if (originalSize === set.size) {
    return true;
  }

  const areEq = objEquiv(val1, val2, mode, keys1, keys2, memos, iterationType);

  set.delete(val1);
  set.delete(val2);

  return areEq;
}

// See https://developer.mozilla.org/en-US/docs/Web/JavaScript/Equality_comparisons_and_sameness#Loose_equality_using
// Sadly it is not possible to detect corresponding values properly in case the
// type is a string, number, bigint or boolean. The reason is that those values
// can match lots of different string values (e.g., 1n == '+00001').
function findLooseMatchingPrimitives(prim) {
  switch (typeof prim) {
    case 'undefined':
      return null;
    case 'object': // Only pass in null as object!
      return undefined;
    case 'symbol':
      return false;
    case 'string':
      prim = +prim;
      // Loose equal entries exist only if the string is possible to convert to
      // a regular number and not NaN.
      // Fall through
    case 'number':
      // Check for NaN
      // eslint-disable-next-line no-self-compare
      if (prim !== prim) {
        return false;
      }
  }
  return true;
}

function setMightHaveLoosePrim(a, b, prim) {
  const altValue = findLooseMatchingPrimitives(prim);
  if (altValue != null)
    return altValue;

  return !b.has(altValue) && a.has(altValue);
}

function mapMightHaveLoosePrim(a, b, prim, item2, memo) {
  const altValue = findLooseMatchingPrimitives(prim);
  if (altValue != null) {
    return altValue;
  }
  const item1 = a.get(altValue);
  if ((item1 === undefined && !a.has(altValue)) ||
      !innerDeepEqual(item1, item2, kLoose, memo)) {
    return false;
  }
  return !b.has(altValue) && innerDeepEqual(item1, item2, kLoose, memo);
}

function partialObjectSetEquiv(array, a, b, mode, memo) {
  let aPos = 0;
  let direction = 1;
  let start = 0;
  let end = array.length - 1;
  for (const val1 of a) {
    aPos++;
    if (!b.has(val1)) {
      let innerStart = start;
      if (direction === 1) {
        if (innerDeepEqual(val1, array[start], mode, memo)) {
          if (start === end) {
            return true;
          }
          start += 1;
          continue;
        }
        if (start === end) {
          // The last element of set b might match a later element in set a.
          continue;
        }
        direction = -1;
        innerStart += 1;
      }
      let matched = true;
      if (!innerDeepEqual(val1, array[end], mode, memo)) {
        direction = 1;
        matched = arrayHasEqualElement(array, val1, mode, memo, innerDeepEqual, innerStart, end);
      }
      if (matched) {
        if (start === end) {
          return true;
        }
        end -= 1;
      }
    }
    if (a.size - aPos <= end - start) {
      return false;
    }
  }
  return false;
}

function arrayHasEqualElement(array, val1, mode, memo, comparator, start, end) {
  let matched = false;
  for (let i = end - 1; i >= start; i--) {
    if (comparator(val1, array[i], mode, memo)) {
      // Remove the matching element to make sure we do not check that again.
      array.splice(i, 1);
      matched = true;
      break;
    }
  }
  return matched;
}

function setObjectEquiv(array, a, b, mode, memo) {
  let direction = 1;
  let start = 0;
  let end = array.length - 1;
  const comparator = mode !== kLoose ? objectComparisonStart : innerDeepEqual;
  const extraChecks = mode === kLoose || array.length !== a.size;
  for (const val1 of a) {
    if (extraChecks) {
      if (typeof val1 === 'object') {
        if (b.has(val1)) {
          continue;
        }
      } else if (b.has(val1)) {
        continue;
      } else if (mode !== kLoose) {
        return false;
      }
    }

    let innerStart = start;
    if (direction === 1) {
      if (comparator(val1, array[start], mode, memo)) {
        start += 1;
        continue;
      }
      if (start === end) {
        return false;
      }
      direction = -1;
      innerStart += 1;
    }
    if (!comparator(val1, array[end], mode, memo)) {
      direction = 1;
      if (!arrayHasEqualElement(array, val1, mode, memo, comparator, innerStart, end)) {
        return false;
      }
    }
    end -= 1;
  }
  return true;
}

function compareSmallSets(a, b, val, iteratorB, mode, memo) {
  const iteratorA = a.values();
  const firstA = iteratorA.next().value;
  const first = innerDeepEqual(firstA, val, mode, memo);
  if (first) {
    if (b.size === 1) { // Partial mode && a.size === 1 || b.size === 1
      return true;
    }
    const secondA = iteratorA.next().value;
    return b.has(secondA) || innerDeepEqual(secondA, iteratorB.next().value, mode, memo);
  }
  return a.size !== 1 && innerDeepEqual(iteratorA.next().value, val, mode, memo) && (
    b.size === 1 || // Partial mode
    b.has(firstA) || // Primitive or reference equal
    innerDeepEqual(firstA, iteratorB.next().value, mode, memo)
  );
}

function setEquiv(a, b, mode, memo) {
  // This is a lazily initiated Set of entries which have to be compared
  // pairwise.
  let array;

  const iteratorB = b.values();
  for (const val of iteratorB) {
    if (!a.has(val)) {
      if ((typeof val !== 'object' || val === null) &&
          (mode !== kLoose || !setMightHaveLoosePrim(a, b, val))) {
        return false;
      }

      if (array === undefined) {
        if (a.size < 3) {
          return compareSmallSets(a, b, val, iteratorB, mode, memo);
        }
        array = [];
      }
      // If the specified value doesn't exist in the second set it's a object
      // (or in loose mode: a non-matching primitive). Find the
      // deep-(mode-)equal element in a set copy to reduce duplicate checks.
      array.push(val);
    }
  }

  if (array === undefined) {
    return true;
  }
  if (mode === kPartial) {
    return partialObjectSetEquiv(array, a, b, mode, memo);
  }
  return setObjectEquiv(array, a, b, mode, memo);
}

function partialObjectMapEquiv(array, a, b, mode, memo) {
  let aPos = 0;
  let direction = 1;
  let start = 0;
  let end = array.length - 1;
  for (const { 0: key1, 1: item1 } of a) {
    aPos++;
    if (typeof key1 === 'object' && key1 !== null) {
      let innerStart = start;
      if (direction === 1) {
        const key2 = array[start];
        if (objectComparisonStart(key1, key2, mode, memo) && innerDeepEqual(item1, b.get(key2), mode, memo)) {
          if (start === end) {
            return true;
          }
          start += 1;
          continue;
        }
        if (start === end) {
          // The last element of map b might match a later element in map a.
          continue;
        }
        direction = -1;
        innerStart += 1;
      }
      let matched = true;
      const key2 = array[end];
      if (!objectComparisonStart(key1, key2, mode, memo) || !innerDeepEqual(item1, b.get(key2), mode, memo)) {
        direction = 1;
        matched = arrayHasEqualMapElement(array, key1, item1, b, mode, memo, objectComparisonStart, innerStart, end);
      }
      if (matched) {
        if (start === end) {
          return true;
        }
        end -= 1;
      }
    }
    if (a.size - aPos <= end - start) {
      return false;
    }
  }
  return false;
}

function arrayHasEqualMapElement(array, key1, item1, b, mode, memo, comparator, start, end) {
  let matched = false;
  for (let i = end - 1; i >= start; i--) {
    const key2 = array[i];
    if (comparator(key1, key2, mode, memo) &&
        innerDeepEqual(item1, b.get(key2), mode, memo)) {
      // Remove the matching element to make sure we do not check that again.
      array.splice(i, 1);
      matched = true;
      break;
    }
  }
  return matched;
}

function mapObjectEquiv(array, a, b, mode, memo) {
  let direction = 1;
  let start = 0;
  let end = array.length - 1;
  const comparator = mode !== kLoose ? objectComparisonStart : innerDeepEqual;
  const extraChecks = mode === kLoose || array.length !== a.size;

  for (const { 0: key1, 1: item1 } of a) {
    if (extraChecks && (typeof key1 !== 'object' || key1 === null)) {
      if (b.has(key1)) {
        if (mode !== kLoose || innerDeepEqual(item1, b.get(key1), mode, memo)) {
          continue;
        }
      } else if (mode !== kLoose) {
        return false;
      }
    }

    let innerStart = start;
    if (direction === 1) {
      const key2 = array[start];
      if (comparator(key1, key2, mode, memo) && innerDeepEqual(item1, b.get(key2), mode, memo)) {
        start += 1;
        continue;
      }
      if (start === end) {
        return false;
      }
      direction = -1;
      innerStart += 1;
    }
    const key2 = array[end];
    if ((!comparator(key1, key2, mode, memo) || !innerDeepEqual(item1, b.get(key2), mode, memo))) {
      direction = 1;
      if (!arrayHasEqualMapElement(array, key1, item1, b, mode, memo, comparator, innerStart, end)) {
        return false;
      }
    }
    end -= 1;
  }
  return true;
}

function mapEquiv(a, b, mode, memo) {
  let array;

  for (const { 0: key2, 1: item2 } of b) {
    if (typeof key2 === 'object' && key2 !== null) {
      if (array === undefined) {
        if (a.size === 1) {
          const { 0: key1, 1: item1 } = a.entries().next().value;
          return innerDeepEqual(key1, key2, mode, memo) &&
                  innerDeepEqual(item1, item2, mode, memo);
        }
        array = [];
      }
      array.push(key2);
    } else {
      // By directly retrieving the value we prevent another b.has(key2) check in
      // almost all possible cases.
      const item1 = a.get(key2);
      if (((item1 === undefined && !a.has(key2)) ||
          !innerDeepEqual(item1, item2, mode, memo))) {
        if (mode !== kLoose)
          return false;
        // Fast path to detect missing string, symbol, undefined and null
        // keys.
        if (!mapMightHaveLoosePrim(a, b, key2, item2, memo))
          return false;
        if (array === undefined) {
          array = [];
        }
        array.push(key2);
      }
    }
  }

  if (array === undefined) {
    return true;
  }

  if (mode === kPartial) {
    return partialObjectMapEquiv(array, a, b, mode, memo);
  }

  return mapObjectEquiv(array, a, b, mode, memo);
}

function partialSparseArrayEquiv(a, b, mode, memos, startA, startB) {
  let aPos = 0;
  const keysA = ObjectKeys(a).slice(startA);
  const keysB = ObjectKeys(b).slice(startB);
  if (keysA.length < keysB.length) {
    return false;
  }
  for (let i = 0; i < keysB.length; i++) {
    const keyB = keysB[i];
    while (!innerDeepEqual(a[keysA[aPos]], b[keyB], mode, memos)) {
      aPos++;
      if (aPos > keysA.length - keysB.length + i) {
        return false;
      }
    }
    aPos++;
  }
  return true;
}

function partialArrayEquiv(a, b, mode, memos) {
  let aPos = 0;
  for (let i = 0; i < b.length; i++) {
    let isSparse = b[i] === undefined && !hasOwn(b, i);
    if (isSparse) {
      return partialSparseArrayEquiv(a, b, mode, memos, aPos, i);
    }
    while (!(isSparse = a[aPos] === undefined && !hasOwn(a, aPos)) &&
           !innerDeepEqual(a[aPos], b[i], mode, memos)) {
      aPos++;
      if (aPos > a.length - b.length + i) {
        return false;
      }
    }
    if (isSparse) {
      return partialSparseArrayEquiv(a, b, mode, memos, aPos, i);
    }
    aPos++;
  }
  return true;
}

function sparseArrayEquiv(a, b, mode, memos, i) {
  // TODO(BridgeAR): Use internal method to only get index properties. The
  // same applies to the partial implementation.
  const keysA = ObjectKeys(a);
  const keysB = ObjectKeys(b);
  if (keysA.length !== keysB.length) {
    return false;
  }
  for (; i < keysB.length; i++) {
    const key = keysB[i];
    if ((a[key] === undefined && !hasOwn(a, key)) || !innerDeepEqual(a[key], b[key], mode, memos)) {
      return false;
    }
  }
  return true;
}

function objEquiv(a, b, mode, keys1, keys2, memos, iterationType) {
  // The pair must have equivalent values for every corresponding key.
  if (keys2.length > 0) {
    let i = 0;
    // Ordered keys
    if (keys1 !== undefined) {
      for (; i < keys2.length; i++) {
        const key = keys2[i];
        if (keys1[i] !== key) {
          break;
        }
        if (!innerDeepEqual(a[key], b[key], mode, memos)) {
          return false;
        }
      }
    }
    // Unordered keys
    for (; i < keys2.length; i++) {
      const key = keys2[i];
      // It is faster to get the whole descriptor and to check it's enumerable
      // property in V8 13.0 compared to calling Object.propertyIsEnumerable()
      // and accessing the property regularly.
      const descriptor = ObjectGetOwnPropertyDescriptor(a, key);
      if (!descriptor?.enumerable ||
          !innerDeepEqual(descriptor.value !== undefined ? descriptor.value : a[key], b[key], mode, memos)) {
        return false;
      }
    }
  }

  if (iterationType === kIsArray) {
    if (mode === kPartial) {
      return partialArrayEquiv(a, b, mode, memos);
    }
    for (let i = 0; i < a.length; i++) {
      if (b[i] === undefined) {
        if (!hasOwn(b, i))
          return sparseArrayEquiv(a, b, mode, memos, i);
        if (a[i] !== undefined || !hasOwn(a, i))
          return false;
      } else if (a[i] === undefined || !innerDeepEqual(a[i], b[i], mode, memos)) {
        return false;
      }
    }
  } else if (iterationType === kIsSet) {
    if (!setEquiv(a, b, mode, memos)) {
      return false;
    }
  } else if (iterationType === kIsMap) {
    if (!mapEquiv(a, b, mode, memos)) {
      return false;
    }
  }

  return true;
}

// Only handle cycles when they are detected.
// eslint-disable-next-line func-style
let detectCycles = function(val1, val2, mode) {
  try {
    return innerDeepEqual(val1, val2, mode, null);
  } catch {
    detectCycles = innerDeepEqual;
    return innerDeepEqual(val1, val2, mode, undefined);
  }
};

module.exports = {
  isDeepEqual(val1, val2) {
    return detectCycles(val1, val2, kLoose);
  },
  isDeepStrictEqual(val1, val2) {
    return detectCycles(val1, val2, kStrict);
  },
  isPartialStrictEqual(val1, val2) {
    return detectCycles(val1, val2, kPartial);
  },
};

    },
    "internal/errors/error_source": function (exports, require, module, process, internalBinding, primordials) {
'use strict';

const {
  FunctionPrototypeBind,
  StringPrototypeSlice,
} = primordials;

const {
  getErrorSourcePositions,
} = internalBinding('errors');
const {
  getSourceMapsSupport,
  findSourceMap,
  getSourceLine,
} = require('internal/source_map/source_map_cache');

/**
 * Get the source location of an error. If source map is enabled, resolve the source location
 * based on the source map.
 *
 * The `error.stack` must not have been accessed. The resolution is based on the structured
 * error stack data.
 * @param {Error|object} error An error object, or an object being invoked with ErrorCaptureStackTrace
 * @returns {{sourceLine: string, startColumn: number}|undefined}
 */
function getErrorSourceLocation(error) {
  const pos = getErrorSourcePositions(error);
  const {
    sourceLine,
    scriptResourceName,
    lineNumber,
    startColumn,
  } = pos;

  // Source map is not enabled. Return the source line directly.
  if (!getSourceMapsSupport().enabled) {
    return { sourceLine, startColumn };
  }

  const sm = findSourceMap(scriptResourceName);
  if (sm === undefined) {
    return;
  }
  const {
    originalLine,
    originalColumn,
    originalSource,
  } = sm.findEntry(lineNumber - 1, startColumn);
  const originalSourceLine = getSourceLine(sm, originalSource, originalLine, originalColumn);

  if (!originalSourceLine) {
    return;
  }

  return {
    sourceLine: originalSourceLine,
    startColumn: originalColumn,
  };
}

const memberAccessTokens = [ '.', '?.', '[', ']' ];
const memberNameTokens = [ 'name', 'string', 'num' ];
let tokenizer;
/**
 * Get the first expression in a code string at the startColumn.
 * @param {string} code source code line
 * @param {number} startColumn which column the error is constructed
 * @returns {string}
 */
function getFirstExpression(code, startColumn) {
  // Lazy load acorn.
  if (tokenizer === undefined) {
    const Parser = require('internal/deps/acorn/acorn/dist/acorn').Parser;
    tokenizer = FunctionPrototypeBind(Parser.tokenizer, Parser);
  }

  let lastToken;
  let firstMemberAccessNameToken;
  let terminatingCol;
  let parenLvl = 0;
  // Tokenize the line to locate the expression at the startColumn.
  // The source line may be an incomplete JavaScript source, so do not parse the source line.
  for (const token of tokenizer(code, { ecmaVersion: 'latest' })) {
    // Peek before the startColumn.
    if (token.start < startColumn) {
      // There is a semicolon. This is a statement before the startColumn, so reset the memo.
      if (token.type.label === ';') {
        firstMemberAccessNameToken = null;
        continue;
      }
      // Try to memo the member access expressions before the startColumn, so that the
      // returned source code contains more info:
      //   assert.ok(value)
      //          ^ startColumn
      // The member expression can also be like
      //   assert['ok'](value) or assert?.ok(value)
      //               ^ startColumn      ^ startColumn
      if (memberAccessTokens.includes(token.type.label) && lastToken?.type.label === 'name') {
        // First member access name token must be a 'name'.
        firstMemberAccessNameToken ??= lastToken;
      } else if (!memberAccessTokens.includes(token.type.label) &&
        !memberNameTokens.includes(token.type.label)) {
        // Reset the memo if it is not a simple member access.
        // For example: assert[(() => 'ok')()](value)
        //                                    ^ startColumn
        firstMemberAccessNameToken = null;
      }
      lastToken = token;
      continue;
    }
    // Now after the startColumn, this must be an expression.
    if (token.type.label === '(') {
      parenLvl++;
      continue;
    }
    if (token.type.label === ')') {
      parenLvl--;
      if (parenLvl === 0) {
        // A matched closing parenthesis found after the startColumn,
        // terminate here. Include the token.
        //   (assert.ok(false), assert.ok(true))
        //           ^ startColumn
        terminatingCol = token.start + 1;
        break;
      }
      continue;
    }
    if (token.type.label === ';') {
      // A semicolon found after the startColumn, terminate here.
      //   assert.ok(false); assert.ok(true));
      //          ^ startColumn
      terminatingCol = token;
      break;
    }
    // If no semicolon found after the startColumn. The string after the
    // startColumn must be the expression.
    //   assert.ok(false)
    //          ^ startColumn
  }
  const start = firstMemberAccessNameToken?.start ?? startColumn;
  return StringPrototypeSlice(code, start, terminatingCol);
}

/**
 * Get the source expression of an error. If source map is enabled, resolve the source location
 * based on the source map.
 *
 * The `error.stack` must not have been accessed, or the source location may be incorrect. The
 * resolution is based on the structured error stack data.
 * @param {Error|object} error An error object, or an object being invoked with ErrorCaptureStackTrace
 * @returns {string|undefined}
 */
function getErrorSourceExpression(error) {
  const loc = getErrorSourceLocation(error);
  if (loc === undefined) {
    return;
  }
  const { sourceLine, startColumn } = loc;
  return getFirstExpression(sourceLine, startColumn);
}

module.exports = {
  getErrorSourceLocation,
  getErrorSourceExpression,
};

    },
    "internal/assert/assertion_error": function (exports, require, module, process, internalBinding, primordials) {
'use strict';

const {
  ArrayPrototypeJoin,
  ArrayPrototypePop,
  ArrayPrototypeSlice,
  Error,
  ErrorCaptureStackTrace,
  ObjectAssign,
  ObjectDefineProperty,
  ObjectGetPrototypeOf,
  ObjectPrototypeHasOwnProperty,
  SafeSet,
  String,
  StringPrototypeRepeat,
  StringPrototypeSlice,
  StringPrototypeSplit,
} = primordials;

const { isError } = require('internal/util');

const { inspect } = require('internal/util/inspect');
const colors = require('internal/util/colors');
const { validateObject } = require('internal/validators');
const { isErrorStackTraceLimitWritable } = require('internal/errors');
const { myersDiff, printMyersDiff, printSimpleMyersDiff } = require('internal/assert/myers_diff');

const kReadableOperator = {
  deepStrictEqual: 'Expected values to be strictly deep-equal:',
  partialDeepStrictEqual: 'Expected values to be partially and strictly deep-equal:',
  strictEqual: 'Expected values to be strictly equal:',
  strictEqualObject: 'Expected "actual" to be reference-equal to "expected":',
  deepEqual: 'Expected values to be loosely deep-equal:',
  notDeepStrictEqual: 'Expected "actual" not to be strictly deep-equal to:',
  notStrictEqual: 'Expected "actual" to be strictly unequal to:',
  notStrictEqualObject:
    'Expected "actual" not to be reference-equal to "expected":',
  notDeepEqual: 'Expected "actual" not to be loosely deep-equal to:',
  notIdentical: 'Values have same structure but are not reference-equal:',
  notDeepEqualUnequal: 'Expected values not to be loosely deep-equal:',
};

const kMaxShortStringLength = 12;
const kMaxLongStringLength = 512;

const kMethodsWithCustomMessageDiff = new SafeSet()
  .add('deepStrictEqual')
  .add('strictEqual')
  .add('partialDeepStrictEqual');

function copyError(source) {
  const target = ObjectAssign(
    { __proto__: ObjectGetPrototypeOf(source) },
    source,
  );
  ObjectDefineProperty(target, 'message', {
    __proto__: null,
    value: source.message,
  });
  if (ObjectPrototypeHasOwnProperty(source, 'cause')) {
    let { cause } = source;

    if (isError(cause)) {
      cause = copyError(cause);
    }

    ObjectDefineProperty(target, 'cause', { __proto__: null, value: cause });
  }
  return target;
}

function inspectValue(val) {
  // The util.inspect default values could be changed. This makes sure the
  // error messages contain the necessary information nevertheless.
  return inspect(val, {
    compact: false,
    customInspect: false,
    depth: 1000,
    maxArrayLength: Infinity,
    // Assert compares only enumerable properties (with a few exceptions).
    showHidden: false,
    // Assert does not detect proxies currently.
    showProxy: false,
    sorted: true,
    // Inspect getters as we also check them when comparing entries.
    getters: true,
  });
}

function getErrorMessage(operator, message) {
  return message || kReadableOperator[operator];
}

function checkOperator(actual, expected, operator) {
  // In case both values are objects or functions explicitly mark them as not
  // reference equal for the `strictEqual` operator.
  if (
    operator === 'strictEqual' &&
    ((typeof actual === 'object' &&
      actual !== null &&
      typeof expected === 'object' &&
      expected !== null) ||
      (typeof actual === 'function' && typeof expected === 'function'))
  ) {
    operator = 'strictEqualObject';
  }

  return operator;
}

function getColoredMyersDiff(actual, expected) {
  const header = `${colors.green}actual${colors.white} ${colors.red}expected${colors.white}`;
  const skipped = false;

  const diff = myersDiff(StringPrototypeSplit(actual, ''), StringPrototypeSplit(expected, ''));
  let message = printSimpleMyersDiff(diff);

  if (skipped) {
    message += '...';
  }

  return { message, header, skipped };
}

function getStackedDiff(actual, expected) {
  const isStringComparison = typeof actual === 'string' && typeof expected === 'string';

  let message = `\n${colors.green}+${colors.white} ${actual}\n${colors.red}- ${colors.white}${expected}`;
  const stringsLen = actual.length + expected.length;
  const maxTerminalLength = process.stderr.isTTY ? process.stderr.columns : 80;
  const showIndicator = isStringComparison && (stringsLen <= maxTerminalLength);

  if (showIndicator) {
    let indicatorIdx = -1;

    for (let i = 0; i < actual.length; i++) {
      if (actual[i] !== expected[i]) {
        // Skip the indicator for the first 2 characters because the diff is immediately apparent
        // It is 3 instead of 2 to account for the quotes
        if (i >= 3) {
          indicatorIdx = i;
        }
        break;
      }
    }

    if (indicatorIdx !== -1) {
      message += `\n${StringPrototypeRepeat(' ', indicatorIdx + 2)}^`;
    }
  }

  return { message };
}

function getSimpleDiff(originalActual, actual, originalExpected, expected) {
  let stringsLen = actual.length + expected.length;
  // Accounting for the quotes wrapping strings
  if (typeof originalActual === 'string') {
    stringsLen -= 2;
  }
  if (typeof originalExpected === 'string') {
    stringsLen -= 2;
  }
  if (stringsLen <= kMaxShortStringLength && (originalActual !== 0 || originalExpected !== 0)) {
    return { message: `${actual} !== ${expected}`, header: '' };
  }

  const isStringComparison = typeof originalActual === 'string' && typeof originalExpected === 'string';
  // colored myers diff
  if (isStringComparison && colors.hasColors) {
    return getColoredMyersDiff(actual, expected);
  }

  return getStackedDiff(actual, expected);
}

function isSimpleDiff(actual, inspectedActual, expected, inspectedExpected) {
  if (inspectedActual.length > 1 || inspectedExpected.length > 1) {
    return false;
  }

  return typeof actual !== 'object' || actual === null || typeof expected !== 'object' || expected === null;
}

function createErrDiff(actual, expected, operator, customMessage, diffType = 'simple') {
  operator = checkOperator(actual, expected, operator);

  let skipped = false;
  let message = '';
  const inspectedActual = inspectValue(actual);
  const inspectedExpected = inspectValue(expected);
  const inspectedSplitActual = StringPrototypeSplit(inspectedActual, '\n');
  const inspectedSplitExpected = StringPrototypeSplit(inspectedExpected, '\n');
  const showSimpleDiff = isSimpleDiff(actual, inspectedSplitActual, expected, inspectedSplitExpected);
  let header = `${colors.green}+ actual${colors.white} ${colors.red}- expected${colors.white}`;

  if (showSimpleDiff) {
    const simpleDiff = getSimpleDiff(actual, inspectedSplitActual[0], expected, inspectedSplitExpected[0]);
    message = simpleDiff.message;
    if (typeof simpleDiff.header !== 'undefined') {
      header = simpleDiff.header;
    }
    if (simpleDiff.skipped) {
      skipped = true;
    }
  } else if (inspectedActual === inspectedExpected) {
    // Handles the case where the objects are structurally the same but different references
    operator = 'notIdentical';
    if (inspectedSplitActual.length > 50 && diffType !== 'full') {
      message = `${ArrayPrototypeJoin(ArrayPrototypeSlice(inspectedSplitActual, 0, 50), '\n')}\n...}`;
      skipped = true;
    } else {
      message = ArrayPrototypeJoin(inspectedSplitActual, '\n');
    }
    header = '';
  } else {
    const checkCommaDisparity = actual != null && typeof actual === 'object';
    const diff = myersDiff(inspectedSplitActual, inspectedSplitExpected, checkCommaDisparity);

    const myersDiffMessage = printMyersDiff(diff, operator);
    message = myersDiffMessage.message;

    if (operator === 'partialDeepStrictEqual') {
      header = `${colors.gray}${colors.hasColors ? '' : '+ '}actual${colors.white} ${colors.red}- expected${colors.white}`;
    }

    if (myersDiffMessage.skipped) {
      skipped = true;
    }
  }

  const headerMessage = `${getErrorMessage(operator, customMessage)}\n${header}`;
  const skippedMessage = skipped ? '\n... Skipped lines' : '';

  return `${headerMessage}${skippedMessage}\n${message}\n`;
}

function addEllipsis(string) {
  const lines = StringPrototypeSplit(string, '\n', 11);
  if (lines.length > 10) {
    lines.length = 10;
    return `${ArrayPrototypeJoin(lines, '\n')}\n...`;
  } else if (string.length > kMaxLongStringLength) {
    return `${StringPrototypeSlice(string, kMaxLongStringLength)}...`;
  }
  return string;
}

class AssertionError extends Error {
  constructor(options) {
    validateObject(options, 'options');
    const {
      message,
      operator,
      stackStartFn,
      details,
      // Compatibility with older versions.
      stackStartFunction,
      diff = 'simple',
    } = options;
    let {
      actual,
      expected,
    } = options;

    const limit = Error.stackTraceLimit;
    if (isErrorStackTraceLimitWritable()) Error.stackTraceLimit = 0;

    if (message != null) {
      if (kMethodsWithCustomMessageDiff.has(operator)) {
        super(createErrDiff(actual, expected, operator, message, diff));
      } else {
        super(String(message));
      }
    } else {
      // Reset colors on each call to make sure we handle dynamically set environment
      // variables correct.
      colors.refresh();
      // Prevent the error stack from being visible by duplicating the error
      // in a very close way to the original in case both sides are actually
      // instances of Error.
      if (typeof actual === 'object' && actual !== null &&
          typeof expected === 'object' && expected !== null &&
          'stack' in actual && actual instanceof Error &&
          'stack' in expected && expected instanceof Error) {
        actual = copyError(actual);
        expected = copyError(expected);
      }

      if (kMethodsWithCustomMessageDiff.has(operator)) {
        super(createErrDiff(actual, expected, operator, message, diff));
      } else if (operator === 'notDeepStrictEqual' ||
        operator === 'notStrictEqual') {
        // In case the objects are equal but the operator requires unequal, show
        // the first object and say A equals B
        let base = kReadableOperator[operator];
        const res = StringPrototypeSplit(inspectValue(actual), '\n');

        // In case "actual" is an object or a function, it should not be
        // reference equal.
        if (operator === 'notStrictEqual' &&
            ((typeof actual === 'object' && actual !== null) ||
             typeof actual === 'function')) {
          base = kReadableOperator.notStrictEqualObject;
        }

        // Only remove lines in case it makes sense to collapse those.
        if (res.length > 50 && diff !== 'full') {
          res[46] = `${colors.blue}...${colors.white}`;
          while (res.length > 47) {
            ArrayPrototypePop(res);
          }
        }

        // Only print a single input.
        if (res.length === 1) {
          super(`${base}${res[0].length > 5 ? '\n\n' : ' '}${res[0]}`);
        } else {
          super(`${base}\n\n${ArrayPrototypeJoin(res, '\n')}\n`);
        }
      } else {
        let res = inspectValue(actual);
        let other = inspectValue(expected);
        const knownOperator = kReadableOperator[operator];
        if (operator === 'notDeepEqual' && res === other) {
          res = `${knownOperator}\n\n${res}`;
          if (res.length > 1024 && diff !== 'full') {
            res = `${StringPrototypeSlice(res, 0, 1021)}...`;
          }
          super(res);
        } else {
          if (res.length > kMaxLongStringLength && diff !== 'full') {
            res = `${StringPrototypeSlice(res, 0, 509)}...`;
          }
          if (other.length > kMaxLongStringLength && diff !== 'full') {
            other = `${StringPrototypeSlice(other, 0, 509)}...`;
          }
          if (operator === 'deepEqual') {
            res = `${knownOperator}\n\n${res}\n\nshould loosely deep-equal\n\n`;
          } else {
            const newOp = kReadableOperator[`${operator}Unequal`];
            if (newOp) {
              res = `${newOp}\n\n${res}\n\nshould not loosely deep-equal\n\n`;
            } else {
              other = ` ${operator} ${other}`;
            }
          }
          super(`${res}${other}`);
        }
      }
    }

    if (isErrorStackTraceLimitWritable()) Error.stackTraceLimit = limit;

    this.generatedMessage = !message;
    ObjectDefineProperty(this, 'name', {
      __proto__: null,
      value: 'AssertionError [ERR_ASSERTION]',
      enumerable: false,
      writable: true,
      configurable: true,
    });
    this.code = 'ERR_ASSERTION';
    if (details) {
      this.actual = undefined;
      this.expected = undefined;
      this.operator = undefined;
      for (let i = 0; i < details.length; i++) {
        this['message ' + i] = details[i].message;
        this['actual ' + i] = details[i].actual;
        this['expected ' + i] = details[i].expected;
        this['operator ' + i] = details[i].operator;
        this['stack trace ' + i] = details[i].stack;
      }
    } else {
      this.actual = actual;
      this.expected = expected;
      this.operator = operator;
    }
    ErrorCaptureStackTrace(this, stackStartFn || stackStartFunction);
    // Create error message including the error code in the name.
    this.stack; // eslint-disable-line no-unused-expressions
    // Reset the name.
    this.name = 'AssertionError';
    this.diff = diff;
  }

  toString() {
    return `${this.name} [${this.code}]: ${this.message}`;
  }

  [inspect.custom](recurseTimes, ctx) {
    // Long strings should not be fully inspected.
    const tmpActual = this.actual;
    const tmpExpected = this.expected;

    if (typeof this.actual === 'string') {
      this.actual = addEllipsis(this.actual);
    }
    if (typeof this.expected === 'string') {
      this.expected = addEllipsis(this.expected);
    }

    // This limits the `actual` and `expected` property default inspection to
    // the minimum depth. Otherwise those values would be too verbose compared
    // to the actual error message which contains a combined view of these two
    // input values.
    const result = inspect(this, {
      ...ctx,
      customInspect: false,
      depth: 0,
    });

    // Reset the properties after inspection.
    this.actual = tmpActual;
    this.expected = tmpExpected;

    return result;
  }
}

module.exports = AssertionError;

    },
    "internal/assert/myers_diff": function (exports, require, module, process, internalBinding, primordials) {
'use strict';

const {
  ArrayPrototypePush,
  Int32Array,
  StringPrototypeEndsWith,
} = primordials;

const {
  codes: {
    ERR_OUT_OF_RANGE,
  },
} = require('internal/errors');

const colors = require('internal/util/colors');

const kNopLinesToCollapse = 5;
const kOperations = {
  DELETE: -1,
  NOP: 0,
  INSERT: 1,
};

function areLinesEqual(actual, expected, checkCommaDisparity) {
  if (actual === expected) {
    return true;
  }
  if (checkCommaDisparity) {
    return (actual + ',') === expected || actual === (expected + ',');
  }
  return false;
}

function myersDiff(actual, expected, checkCommaDisparity = false) {
  const actualLength = actual.length;
  const expectedLength = expected.length;
  const max = actualLength + expectedLength;

  if (max > 2 ** 31 - 1) {
    throw new ERR_OUT_OF_RANGE(
      'myersDiff input size',
      '< 2^31',
      max,
    );
  }

  const v = new Int32Array(2 * max + 1);
  const trace = [];

  for (let diffLevel = 0; diffLevel <= max; diffLevel++) {
    ArrayPrototypePush(trace, new Int32Array(v)); // Clone the current state of `v`

    for (let diagonalIndex = -diffLevel; diagonalIndex <= diffLevel; diagonalIndex += 2) {
      const offset = diagonalIndex + max;
      const previousOffset = v[offset - 1];
      const nextOffset = v[offset + 1];
      let x = diagonalIndex === -diffLevel || (diagonalIndex !== diffLevel && previousOffset < nextOffset) ?
        nextOffset :
        previousOffset + 1;
      let y = x - diagonalIndex;

      while (
        x < actualLength &&
        y < expectedLength &&
        areLinesEqual(actual[x], expected[y], checkCommaDisparity)
      ) {
        x++;
        y++;
      }

      v[offset] = x;

      if (x >= actualLength && y >= expectedLength) {
        return backtrack(trace, actual, expected, checkCommaDisparity);
      }
    }
  }
}

function backtrack(trace, actual, expected, checkCommaDisparity) {
  const actualLength = actual.length;
  const expectedLength = expected.length;
  const max = actualLength + expectedLength;

  let x = actualLength;
  let y = expectedLength;
  const result = [];

  for (let diffLevel = trace.length - 1; diffLevel >= 0; diffLevel--) {
    const v = trace[diffLevel];
    const diagonalIndex = x - y;
    const offset = diagonalIndex + max;

    let prevDiagonalIndex;
    if (
      diagonalIndex === -diffLevel ||
      (diagonalIndex !== diffLevel && v[offset - 1] < v[offset + 1])
    ) {
      prevDiagonalIndex = diagonalIndex + 1;
    } else {
      prevDiagonalIndex = diagonalIndex - 1;
    }

    const prevX = v[prevDiagonalIndex + max];
    const prevY = prevX - prevDiagonalIndex;

    while (x > prevX && y > prevY) {
      const actualItem = actual[x - 1];
      const value = checkCommaDisparity && !StringPrototypeEndsWith(actualItem, ',') ? expected[y - 1] : actualItem;
      ArrayPrototypePush(result, [ kOperations.NOP, value ]);
      x--;
      y--;
    }

    if (diffLevel > 0) {
      if (x > prevX) {
        ArrayPrototypePush(result, [ kOperations.INSERT, actual[--x] ]);
      } else {
        ArrayPrototypePush(result, [ kOperations.DELETE, expected[--y] ]);
      }
    }
  }

  return result;
}

function printSimpleMyersDiff(diff) {
  let message = '';

  for (let diffIdx = diff.length - 1; diffIdx >= 0; diffIdx--) {
    const { 0: operation, 1: value } = diff[diffIdx];
    let color = colors.white;

    if (operation === kOperations.INSERT) {
      color = colors.green;
    } else if (operation === kOperations.DELETE) {
      color = colors.red;
    }

    message += `${color}${value}${colors.white}`;
  }

  return `\n${message}`;
}

function printMyersDiff(diff, operator) {
  let message = '';
  let skipped = false;
  let nopCount = 0;

  for (let diffIdx = diff.length - 1; diffIdx >= 0; diffIdx--) {
    const { 0: operation, 1: value } = diff[diffIdx];
    const previousOperation = diffIdx < diff.length - 1 ? diff[diffIdx + 1][0] : null;

    // Avoid grouping if only one line would have been grouped otherwise
    if (previousOperation === kOperations.NOP && operation !== previousOperation) {
      if (nopCount === kNopLinesToCollapse + 1) {
        message += `${colors.white}  ${diff[diffIdx + 1][1]}\n`;
      } else if (nopCount === kNopLinesToCollapse + 2) {
        message += `${colors.white}  ${diff[diffIdx + 2][1]}\n`;
        message += `${colors.white}  ${diff[diffIdx + 1][1]}\n`;
      } else if (nopCount >= kNopLinesToCollapse + 3) {
        message += `${colors.blue}...${colors.white}\n`;
        message += `${colors.white}  ${diff[diffIdx + 1][1]}\n`;
        skipped = true;
      }
      nopCount = 0;
    }

    if (operation === kOperations.INSERT) {
      if (operator === 'partialDeepStrictEqual') {
        message += `${colors.gray}${colors.hasColors ? ' ' : '+'} ${value}${colors.white}\n`;
      } else {
        message += `${colors.green}+${colors.white} ${value}\n`;
      }
    } else if (operation === kOperations.DELETE) {
      message += `${colors.red}-${colors.white} ${value}\n`;
    } else if (operation === kOperations.NOP) {
      if (nopCount < kNopLinesToCollapse) {
        message += `${colors.white}  ${value}\n`;
      }
      nopCount++;
    }
  }

  message = message.trimEnd();

  return { message: `\n${message}`, skipped };
}

module.exports = { myersDiff, printMyersDiff, printSimpleMyersDiff };

    },
    "internal/assert/utils": function (exports, require, module, process, internalBinding, primordials) {
'use strict';

const {
  Error,
  ErrorCaptureStackTrace,
  StringPrototypeCharCodeAt,
  StringPrototypeReplace,
} = primordials;

const {
  isErrorStackTraceLimitWritable,
} = require('internal/errors');
const AssertionError = require('internal/assert/assertion_error');
const { isError } = require('internal/util');

const {
  getErrorSourceExpression,
} = require('internal/errors/error_source');

// Escape control characters but not \n and \t to keep the line breaks and
// indentation intact.
// eslint-disable-next-line no-control-regex
const escapeSequencesRegExp = /[\x00-\x08\x0b\x0c\x0e-\x1f]/g;
const meta = [
  '\\u0000', '\\u0001', '\\u0002', '\\u0003', '\\u0004',
  '\\u0005', '\\u0006', '\\u0007', '\\b', '',
  '', '\\u000b', '\\f', '', '\\u000e',
  '\\u000f', '\\u0010', '\\u0011', '\\u0012', '\\u0013',
  '\\u0014', '\\u0015', '\\u0016', '\\u0017', '\\u0018',
  '\\u0019', '\\u001a', '\\u001b', '\\u001c', '\\u001d',
  '\\u001e', '\\u001f',
];

const escapeFn = (str) => meta[StringPrototypeCharCodeAt(str, 0)];

function getErrMessage(fn) {
  const tmpLimit = Error.stackTraceLimit;
  const errorStackTraceLimitIsWritable = isErrorStackTraceLimitWritable();
  // Make sure the limit is set to 1. Otherwise it could fail (<= 0) or it
  // does to much work.
  if (errorStackTraceLimitIsWritable) Error.stackTraceLimit = 1;
  // We only need the stack trace. To minimize the overhead use an object
  // instead of an error.
  const err = {};
  ErrorCaptureStackTrace(err, fn);
  if (errorStackTraceLimitIsWritable) Error.stackTraceLimit = tmpLimit;

  let source = getErrorSourceExpression(err);
  if (source) {
    source = StringPrototypeReplace(source, escapeSequencesRegExp, escapeFn);
    return `The expression evaluated to a falsy value:\n\n  ${source}\n`;
  }
}

function innerOk(fn, argLen, value, message) {
  if (!value) {
    let generatedMessage = false;

    if (argLen === 0) {
      generatedMessage = true;
      message = 'No value argument passed to `assert.ok()`';
    } else if (message == null) {
      generatedMessage = true;
      message = getErrMessage(fn);
    } else if (isError(message)) {
      throw message;
    }

    const err = new AssertionError({
      actual: value,
      expected: true,
      message,
      operator: '==',
      stackStartFn: fn,
    });
    err.generatedMessage = generatedMessage;
    throw err;
  }
}

module.exports = {
  innerOk,
};

    },
    "internal/assert/calltracker": function (exports, require, module, process, internalBinding, primordials) {
'use strict';

const {
  ArrayPrototypePush,
  ArrayPrototypeSlice,
  Error,
  FunctionPrototype,
  ObjectFreeze,
  Proxy,
  ReflectApply,
  SafeSet,
  SafeWeakMap,
} = primordials;

const {
  codes: {
    ERR_INVALID_ARG_VALUE,
    ERR_UNAVAILABLE_DURING_EXIT,
  },
} = require('internal/errors');
const AssertionError = require('internal/assert/assertion_error');
const {
  validateUint32,
} = require('internal/validators');

const noop = FunctionPrototype;

class CallTrackerContext {
  #expected;
  #calls;
  #name;
  #stackTrace;
  constructor({ expected, stackTrace, name }) {
    this.#calls = [];
    this.#expected = expected;
    this.#stackTrace = stackTrace;
    this.#name = name;
  }

  track(thisArg, args) {
    const argsClone = ObjectFreeze(ArrayPrototypeSlice(args));
    ArrayPrototypePush(this.#calls, ObjectFreeze({ thisArg, arguments: argsClone }));
  }

  get delta() {
    return this.#calls.length - this.#expected;
  }

  reset() {
    this.#calls = [];
  }
  getCalls() {
    return ObjectFreeze(ArrayPrototypeSlice(this.#calls));
  }

  report() {
    if (this.delta !== 0) {
      const message = `Expected the ${this.#name} function to be ` +
                      `executed ${this.#expected} time(s) but was ` +
                      `executed ${this.#calls.length} time(s).`;
      return {
        message,
        actual: this.#calls.length,
        expected: this.#expected,
        operator: this.#name,
        stack: this.#stackTrace,
      };
    }
  }
}

class CallTracker {

  #callChecks = new SafeSet();
  #trackedFunctions = new SafeWeakMap();

  #getTrackedFunction(tracked) {
    if (!this.#trackedFunctions.has(tracked)) {
      throw new ERR_INVALID_ARG_VALUE('tracked', tracked, 'is not a tracked function');
    }
    return this.#trackedFunctions.get(tracked);
  }

  reset(tracked) {
    if (tracked === undefined) {
      this.#callChecks.forEach((check) => check.reset());
      return;
    }

    this.#getTrackedFunction(tracked).reset();
  }

  getCalls(tracked) {
    return this.#getTrackedFunction(tracked).getCalls();
  }

  calls(fn, expected = 1) {
    if (process._exiting)
      throw new ERR_UNAVAILABLE_DURING_EXIT();
    if (typeof fn === 'number') {
      expected = fn;
      fn = noop;
    } else if (fn === undefined) {
      fn = noop;
    }

    validateUint32(expected, 'expected', true);

    const context = new CallTrackerContext({
      expected,
      // eslint-disable-next-line no-restricted-syntax
      stackTrace: new Error(),
      name: fn.name || 'calls',
    });
    const tracked = new Proxy(fn, {
      __proto__: null,
      apply(fn, thisArg, argList) {
        context.track(thisArg, argList);
        return ReflectApply(fn, thisArg, argList);
      },
    });
    this.#callChecks.add(context);
    this.#trackedFunctions.set(tracked, context);
    return tracked;
  }

  report() {
    const errors = [];
    for (const context of this.#callChecks) {
      const message = context.report();
      if (message !== undefined) {
        ArrayPrototypePush(errors, message);
      }
    }
    return errors;
  }

  verify() {
    const errors = this.report();
    if (errors.length === 0) {
      return;
    }
    const message = errors.length === 1 ?
      errors[0].message :
      'Functions were not called the expected number of times';
    throw new AssertionError({
      message,
      details: errors,
    });
  }
}

module.exports = CallTracker;

    },
    "assert": function (exports, require, module, process, internalBinding, primordials) {
// Originally from narwhal.js (http://narwhaljs.org)
// Copyright (c) 2009 Thomas Robinson <280north.com>
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the 'Software'), to
// deal in the Software without restriction, including without limitation the
// rights to use, copy, modify, merge, publish, distribute, sublicense, and/or
// sell copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in
// all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED 'AS IS', WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN
// ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION
// WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

'use strict';

const {
  ArrayPrototypeForEach,
  ArrayPrototypeIndexOf,
  ArrayPrototypeJoin,
  ArrayPrototypePush,
  ArrayPrototypeSlice,
  Error,
  NumberIsNaN,
  ObjectAssign,
  ObjectDefineProperty,
  ObjectIs,
  ObjectKeys,
  ObjectPrototypeIsPrototypeOf,
  ReflectApply,
  RegExpPrototypeExec,
  String,
  StringPrototypeIndexOf,
  StringPrototypeSlice,
  StringPrototypeSplit,
  Symbol,
} = primordials;

const {
  codes: {
    ERR_AMBIGUOUS_ARGUMENT,
    ERR_CONSTRUCT_CALL_REQUIRED,
    ERR_INVALID_ARG_TYPE,
    ERR_INVALID_ARG_VALUE,
    ERR_INVALID_RETURN_VALUE,
    ERR_MISSING_ARGS,
  },
} = require('internal/errors');
const AssertionError = require('internal/assert/assertion_error');
const { inspect } = require('internal/util/inspect');
const {
  isPromise,
  isRegExp,
} = require('internal/util/types');
const { isError, deprecate, setOwnProperty } = require('internal/util');
const { innerOk } = require('internal/assert/utils');

const CallTracker = require('internal/assert/calltracker');
const {
  validateFunction,
  validateOneOf,
} = require('internal/validators');

const kOptions = Symbol('options');

let isDeepEqual;
let isDeepStrictEqual;
let isPartialStrictEqual;

function lazyLoadComparison() {
  const comparison = require('internal/util/comparisons');
  isDeepEqual = comparison.isDeepEqual;
  isDeepStrictEqual = comparison.isDeepStrictEqual;
  isPartialStrictEqual = comparison.isPartialStrictEqual;
}

let warned = false;

// The assert module provides functions that throw
// AssertionError's when particular conditions are not met. The
// assert module must conform to the following interface.

const assert = module.exports = ok;

const NO_EXCEPTION_SENTINEL = {};

/**
 * Assert options.
 * @typedef {object} AssertOptions
 * @property {'full'|'simple'} [diff='simple'] - If set to 'full', shows the full diff in assertion errors.
 * @property {boolean} [strict=true] - If set to true, non-strict methods behave like their corresponding
 *   strict methods.
 */

/**
 * @class Assert
 * @param {AssertOptions} [options] - Optional configuration for assertions.
 * @throws {ERR_CONSTRUCT_CALL_REQUIRED} If not called with `new`.
 */
function Assert(options) {
  if (!new.target) {
    throw new ERR_CONSTRUCT_CALL_REQUIRED('Assert');
  }

  options = ObjectAssign({ __proto__: null, strict: true }, options);

  const allowedDiffs = ['simple', 'full'];
  if (options.diff !== undefined) {
    validateOneOf(options.diff, 'options.diff', allowedDiffs);
  }

  this.AssertionError = AssertionError;
  ObjectDefineProperty(this, kOptions, {
    __proto__: null,
    value: options,
    enumerable: false,
    configurable: false,
    writable: false,
  });

  if (options.strict) {
    this.equal = this.strictEqual;
    this.deepEqual = this.deepStrictEqual;
    this.notEqual = this.notStrictEqual;
    this.notDeepEqual = this.notDeepStrictEqual;
  }
}

// All of the following functions must throw an AssertionError
// when a corresponding condition is not met, with a message that
// may be undefined if not provided. All assertion methods provide
// both the actual and expected values to the assertion error for
// display purposes.

// DESTRUCTURING WARNING: All Assert.prototype methods use optional chaining
// (this?.[kOptions]) to safely access instance configuration. When methods are
// destructured from an Assert instance (e.g., const {strictEqual} = myAssert),
// they lose their `this` context and will use default behavior instead of the
// instance's custom options.

function innerFail(obj) {
  if (obj.message instanceof Error) throw obj.message;

  throw new AssertionError(obj);
}

/**
 * @param {any} actual
 * @param {any} expected
 * @param {string | Error} [message]
 * @param {string} [operator]
 * @param {Function} [stackStartFn]
 */
Assert.prototype.fail = function fail(actual, expected, message, operator, stackStartFn) {
  const argsLen = arguments.length;

  let internalMessage = false;
  if (actual == null && argsLen <= 1) {
    internalMessage = true;
    message = 'Failed';
  } else if (argsLen === 1) {
    message = actual;
    actual = undefined;
  } else {
    if (warned === false) {
      warned = true;
      process.emitWarning(
        'assert.fail() with more than one argument is deprecated. ' +
          'Please use assert.strictEqual() instead or only pass a message.',
        'DeprecationWarning',
        'DEP0094',
      );
    }
    if (argsLen === 2)
      operator = '!=';
  }

  if (message instanceof Error) throw message;

  // IMPORTANT: When adding new references to `this`, ensure they use optional chaining
  // (this?.[kOptions]?.diff) to handle cases where the method is destructured from an
  // Assert instance and loses its context. Destructured methods will fall back
  // to default behavior when `this` is undefined.
  const errArgs = {
    actual,
    expected,
    operator: operator === undefined ? 'fail' : operator,
    stackStartFn: stackStartFn || fail,
    message,
    diff: this?.[kOptions]?.diff,
  };
  const err = new AssertionError(errArgs);
  if (internalMessage) {
    err.generatedMessage = true;
  }
  throw err;
};

// The AssertionError is defined in internal/error.
assert.AssertionError = AssertionError;

/**
 * Pure assertion tests whether a value is truthy, as determined
 * by !!value.
 * @param {...any} args
 * @returns {void}
 */
function ok(...args) {
  innerOk(ok, args.length, ...args);
}

/**
 * Pure assertion tests whether a value is truthy, as determined
 * by !!value.
 * Duplicated as the other `ok` function is supercharged and exposed as default export.
 * @param {...any} args
 * @returns {void}
 */
Assert.prototype.ok = function ok(...args) {
  innerOk(ok, args.length, ...args);
};

/**
 * The equality assertion tests shallow, coercive equality with ==.
 * @param {any} actual
 * @param {any} expected
 * @param {string | Error} [message]
 * @returns {void}
 */
Assert.prototype.equal = function equal(actual, expected, message) {
  if (arguments.length < 2) {
    throw new ERR_MISSING_ARGS('actual', 'expected');
  }
  // eslint-disable-next-line eqeqeq
  if (actual != expected && (!NumberIsNaN(actual) || !NumberIsNaN(expected))) {
    innerFail({
      actual,
      expected,
      message,
      operator: '==',
      stackStartFn: equal,
      diff: this?.[kOptions]?.diff,
    });
  }
};

/**
 * The non-equality assertion tests for whether two objects are not
 * equal with !=.
 * @param {any} actual
 * @param {any} expected
 * @param {string | Error} [message]
 * @returns {void}
 */
Assert.prototype.notEqual = function notEqual(actual, expected, message) {
  if (arguments.length < 2) {
    throw new ERR_MISSING_ARGS('actual', 'expected');
  }
  // eslint-disable-next-line eqeqeq
  if (actual == expected || (NumberIsNaN(actual) && NumberIsNaN(expected))) {
    innerFail({
      actual,
      expected,
      message,
      operator: '!=',
      stackStartFn: notEqual,
      diff: this?.[kOptions]?.diff,
    });
  }
};

/**
 * The deep equivalence assertion tests a deep equality relation.
 * @param {any} actual
 * @param {any} expected
 * @param {string | Error} [message]
 * @returns {void}
 */
Assert.prototype.deepEqual = function deepEqual(actual, expected, message) {
  if (arguments.length < 2) {
    throw new ERR_MISSING_ARGS('actual', 'expected');
  }
  if (isDeepEqual === undefined) lazyLoadComparison();
  if (!isDeepEqual(actual, expected)) {
    innerFail({
      actual,
      expected,
      message,
      operator: 'deepEqual',
      stackStartFn: deepEqual,
      diff: this?.[kOptions]?.diff,
    });
  }
};

/**
 * The deep non-equivalence assertion tests for any deep inequality.
 * @param {any} actual
 * @param {any} expected
 * @param {string | Error} [message]
 * @returns {void}
 */
Assert.prototype.notDeepEqual = function notDeepEqual(actual, expected, message) {
  if (arguments.length < 2) {
    throw new ERR_MISSING_ARGS('actual', 'expected');
  }
  if (isDeepEqual === undefined) lazyLoadComparison();
  if (isDeepEqual(actual, expected)) {
    innerFail({
      actual,
      expected,
      message,
      operator: 'notDeepEqual',
      stackStartFn: notDeepEqual,
      diff: this?.[kOptions]?.diff,
    });
  }
};

/**
 * The deep strict equivalence assertion tests a deep strict equality
 * relation.
 * @param {any} actual
 * @param {any} expected
 * @param {string | Error} [message]
 * @returns {void}
 */
Assert.prototype.deepStrictEqual = function deepStrictEqual(actual, expected, message) {
  if (arguments.length < 2) {
    throw new ERR_MISSING_ARGS('actual', 'expected');
  }
  if (isDeepEqual === undefined) lazyLoadComparison();
  if (!isDeepStrictEqual(actual, expected)) {
    innerFail({
      actual,
      expected,
      message,
      operator: 'deepStrictEqual',
      stackStartFn: deepStrictEqual,
      diff: this?.[kOptions]?.diff,
    });
  }
};

/**
 * The deep strict non-equivalence assertion tests for any deep strict
 * inequality.
 * @param {any} actual
 * @param {any} expected
 * @param {string | Error} [message]
 * @returns {void}
 */
Assert.prototype.notDeepStrictEqual = notDeepStrictEqual;
function notDeepStrictEqual(actual, expected, message) {
  if (arguments.length < 2) {
    throw new ERR_MISSING_ARGS('actual', 'expected');
  }
  if (isDeepEqual === undefined) lazyLoadComparison();
  if (isDeepStrictEqual(actual, expected)) {
    innerFail({
      actual,
      expected,
      message,
      operator: 'notDeepStrictEqual',
      stackStartFn: notDeepStrictEqual,
      diff: this?.[kOptions]?.diff,
    });
  }
}

/**
 * The strict equivalence assertion tests a strict equality relation.
 * @param {any} actual
 * @param {any} expected
 * @param {string | Error} [message]
 * @returns {void}
 */
Assert.prototype.strictEqual = function strictEqual(actual, expected, message) {
  if (arguments.length < 2) {
    throw new ERR_MISSING_ARGS('actual', 'expected');
  }
  if (!ObjectIs(actual, expected)) {
    innerFail({
      actual,
      expected,
      message,
      operator: 'strictEqual',
      stackStartFn: strictEqual,
      diff: this?.[kOptions]?.diff,
    });
  }
};

/**
 * The strict non-equivalence assertion tests for any strict inequality.
 * @param {any} actual
 * @param {any} expected
 * @param {string | Error} [message]
 * @returns {void}
 */
Assert.prototype.notStrictEqual = function notStrictEqual(actual, expected, message) {
  if (arguments.length < 2) {
    throw new ERR_MISSING_ARGS('actual', 'expected');
  }
  if (ObjectIs(actual, expected)) {
    innerFail({
      actual,
      expected,
      message,
      operator: 'notStrictEqual',
      stackStartFn: notStrictEqual,
      diff: this?.[kOptions]?.diff,
    });
  }
};

/**
 * The strict equivalence assertion test between two objects
 * @param {any} actual
 * @param {any} expected
 * @param {string | Error} [message]
 * @returns {void}
 */
Assert.prototype.partialDeepStrictEqual = function partialDeepStrictEqual(
  actual,
  expected,
  message,
) {
  if (arguments.length < 2) {
    throw new ERR_MISSING_ARGS('actual', 'expected');
  }
  if (isDeepEqual === undefined) lazyLoadComparison();
  if (!isPartialStrictEqual(actual, expected)) {
    innerFail({
      actual,
      expected,
      message,
      operator: 'partialDeepStrictEqual',
      stackStartFn: partialDeepStrictEqual,
      diff: this?.[kOptions]?.diff,
    });
  }
};

class Comparison {
  constructor(obj, keys, actual) {
    for (const key of keys) {
      if (key in obj) {
        if (actual !== undefined &&
            typeof actual[key] === 'string' &&
            isRegExp(obj[key]) &&
            RegExpPrototypeExec(obj[key], actual[key]) !== null) {
          this[key] = actual[key];
        } else {
          this[key] = obj[key];
        }
      }
    }
  }
}

function compareExceptionKey(actual, expected, key, message, keys, fn) {
  if (!(key in actual) || !isDeepStrictEqual(actual[key], expected[key])) {
    if (!message) {
      // Create placeholder objects to create a nice output.
      const a = new Comparison(actual, keys);
      const b = new Comparison(expected, keys, actual);

      const err = new AssertionError({
        actual: a,
        expected: b,
        operator: 'deepStrictEqual',
        stackStartFn: fn,
        diff: this?.[kOptions]?.diff,
      });
      err.actual = actual;
      err.expected = expected;
      err.operator = fn.name;
      throw err;
    }
    innerFail({
      actual,
      expected,
      message,
      operator: fn.name,
      stackStartFn: fn,
      diff: this?.[kOptions]?.diff,
    });
  }
}

function expectedException(actual, expected, message, fn) {
  let generatedMessage = false;
  let throwError = false;

  if (typeof expected !== 'function') {
    // Handle regular expressions.
    if (isRegExp(expected)) {
      const str = String(actual);
      if (RegExpPrototypeExec(expected, str) !== null)
        return;

      if (!message) {
        generatedMessage = true;
        message = 'The input did not match the regular expression ' +
                  `${inspect(expected)}. Input:\n\n${inspect(str)}\n`;
      }
      throwError = true;
      // Handle primitives properly.
    } else if (typeof actual !== 'object' || actual === null) {
      const err = new AssertionError({
        actual,
        expected,
        message,
        operator: 'deepStrictEqual',
        stackStartFn: fn,
        diff: this?.[kOptions]?.diff,
      });
      err.operator = fn.name;
      throw err;
    } else {
      // Handle validation objects.
      const keys = ObjectKeys(expected);
      // Special handle errors to make sure the name and the message are
      // compared as well.
      if (expected instanceof Error) {
        ArrayPrototypePush(keys, 'name', 'message');
      } else if (keys.length === 0) {
        throw new ERR_INVALID_ARG_VALUE('error',
                                        expected, 'may not be an empty object');
      }
      if (isDeepEqual === undefined) lazyLoadComparison();
      for (const key of keys) {
        if (typeof actual[key] === 'string' &&
            isRegExp(expected[key]) &&
            RegExpPrototypeExec(expected[key], actual[key]) !== null) {
          continue;
        }
        compareExceptionKey(actual, expected, key, message, keys, fn);
      }
      return;
    }
  // Guard instanceof against arrow functions as they don't have a prototype.
  // Check for matching Error classes.
  } else if (expected.prototype !== undefined && actual instanceof expected) {
    return;
  } else if (ObjectPrototypeIsPrototypeOf(Error, expected)) {
    if (!message) {
      generatedMessage = true;
      message = 'The error is expected to be an instance of ' +
        `"${expected.name}". Received `;
      if (isError(actual)) {
        const name = (actual.constructor?.name) ||
                     actual.name;
        if (expected.name === name) {
          message += 'an error with identical name but a different prototype.';
        } else {
          message += `"${name}"`;
        }
        if (actual.message) {
          message += `\n\nError message:\n\n${actual.message}`;
        }
      } else {
        message += `"${inspect(actual, { depth: -1 })}"`;
      }
    }
    throwError = true;
  } else {
    // Check validation functions return value.
    const res = ReflectApply(expected, {}, [actual]);
    if (res !== true) {
      if (!message) {
        generatedMessage = true;
        const name = expected.name ? `"${expected.name}" ` : '';
        message = `The ${name}validation function is expected to return` +
          ` "true". Received ${inspect(res)}`;

        if (isError(actual)) {
          message += `\n\nCaught error:\n\n${actual}`;
        }
      }
      throwError = true;
    }
  }

  if (throwError) {
    const err = new AssertionError({
      actual,
      expected,
      message,
      operator: fn.name,
      stackStartFn: fn,
      diff: this?.[kOptions]?.diff,
    });
    err.generatedMessage = generatedMessage;
    throw err;
  }
}

function getActual(fn) {
  validateFunction(fn, 'fn');
  try {
    fn();
  } catch (e) {
    return e;
  }
  return NO_EXCEPTION_SENTINEL;
}

function checkIsPromise(obj) {
  // Accept native ES6 promises and promises that are implemented in a similar
  // way. Do not accept thenables that use a function as `obj` and that have no
  // `catch` handler.
  return isPromise(obj) ||
    (obj !== null && typeof obj === 'object' &&
    typeof obj.then === 'function' &&
    typeof obj.catch === 'function');
}

async function waitForActual(promiseFn) {
  let resultPromise;
  if (typeof promiseFn === 'function') {
    // Return a rejected promise if `promiseFn` throws synchronously.
    resultPromise = promiseFn();
    // Fail in case no promise is returned.
    if (!checkIsPromise(resultPromise)) {
      throw new ERR_INVALID_RETURN_VALUE('instance of Promise',
                                         'promiseFn', resultPromise);
    }
  } else if (checkIsPromise(promiseFn)) {
    resultPromise = promiseFn;
  } else {
    throw new ERR_INVALID_ARG_TYPE(
      'promiseFn', ['Function', 'Promise'], promiseFn);
  }

  try {
    await resultPromise;
  } catch (e) {
    return e;
  }
  return NO_EXCEPTION_SENTINEL;
}

function expectsError(stackStartFn, actual, error, message) {
  if (typeof error === 'string') {
    if (arguments.length === 4) {
      throw new ERR_INVALID_ARG_TYPE('error',
                                     ['Object', 'Error', 'Function', 'RegExp'],
                                     error);
    }
    if (typeof actual === 'object' && actual !== null) {
      if (actual.message === error) {
        throw new ERR_AMBIGUOUS_ARGUMENT(
          'error/message',
          `The error message "${actual.message}" is identical to the message.`,
        );
      }
    } else if (actual === error) {
      throw new ERR_AMBIGUOUS_ARGUMENT(
        'error/message',
        `The error "${actual}" is identical to the message.`,
      );
    }
    message = error;
    error = undefined;
  } else if (error != null &&
             typeof error !== 'object' &&
             typeof error !== 'function') {
    throw new ERR_INVALID_ARG_TYPE('error',
                                   ['Object', 'Error', 'Function', 'RegExp'],
                                   error);
  }

  if (actual === NO_EXCEPTION_SENTINEL) {
    let details = '';
    if (error?.name) {
      details += ` (${error.name})`;
    }
    details += message ? `: ${message}` : '.';
    const fnType = stackStartFn === Assert.prototype.rejects ? 'rejection' : 'exception';
    innerFail({
      actual: undefined,
      expected: error,
      operator: stackStartFn.name,
      message: `Missing expected ${fnType}${details}`,
      stackStartFn,
      diff: this?.[kOptions]?.diff,
    });
  }

  if (!error)
    return;

  expectedException.call(this, actual, error, message, stackStartFn);
}

function hasMatchingError(actual, expected) {
  if (typeof expected !== 'function') {
    if (isRegExp(expected)) {
      const str = String(actual);
      return RegExpPrototypeExec(expected, str) !== null;
    }
    throw new ERR_INVALID_ARG_TYPE(
      'expected', ['Function', 'RegExp'], expected,
    );
  }
  // Guard instanceof against arrow functions as they don't have a prototype.
  if (expected.prototype !== undefined && actual instanceof expected) {
    return true;
  }
  if (ObjectPrototypeIsPrototypeOf(Error, expected)) {
    return false;
  }
  return ReflectApply(expected, {}, [actual]) === true;
}

function expectsNoError(stackStartFn, actual, error, message) {
  if (actual === NO_EXCEPTION_SENTINEL)
    return;

  if (typeof error === 'string') {
    message = error;
    error = undefined;
  }

  if (!error || hasMatchingError(actual, error)) {
    const details = message ? `: ${message}` : '.';
    const fnType = stackStartFn === Assert.prototype.doesNotReject ?
      'rejection' : 'exception';
    innerFail({
      actual,
      expected: error,
      operator: stackStartFn.name,
      message: `Got unwanted ${fnType}${details}\n` +
               `Actual message: "${actual?.message}"`,
      stackStartFn,
      diff: this?.[kOptions]?.diff,
    });
  }
  throw actual;
}

/**
 * Expects the function `promiseFn` to throw an error.
 * @param {() => any} promiseFn
 * @param {...any} [args]
 * @returns {void}
 */
Assert.prototype.throws = function throws(promiseFn, ...args) {
  expectsError(throws, getActual(promiseFn), ...args);
};

/**
 * Expects `promiseFn` function or its value to reject.
 * @param {() => Promise<any>} promiseFn
 * @param {...any} [args]
 * @returns {Promise<void>}
 */
Assert.prototype.rejects = async function rejects(promiseFn, ...args) {
  expectsError(rejects, await waitForActual(promiseFn), ...args);
};

/**
 * Asserts that the function `fn` does not throw an error.
 * @param {() => any} fn
 * @param {...any} [args]
 * @returns {void}
 */
Assert.prototype.doesNotThrow = function doesNotThrow(fn, ...args) {
  expectsNoError(doesNotThrow, getActual(fn), ...args);
};

/**
 * Expects `fn` or its value to not reject.
 * @param {() => Promise<any>} fn
 * @param {...any} [args]
 * @returns {Promise<void>}
 */
Assert.prototype.doesNotReject = async function doesNotReject(fn, ...args) {
  expectsNoError(doesNotReject, await waitForActual(fn), ...args);
};

/**
 * Throws `AssertionError` if the value is not `null` or `undefined`.
 * @param {any} err
 * @returns {void}
 */
Assert.prototype.ifError = function ifError(err) {
  if (err !== null && err !== undefined) {
    let message = 'ifError got unwanted exception: ';
    if (typeof err === 'object' && typeof err.message === 'string') {
      if (err.message.length === 0 && err.constructor) {
        message += err.constructor.name;
      } else {
        message += err.message;
      }
    } else {
      message += inspect(err);
    }

    const newErr = new AssertionError({
      actual: err,
      expected: null,
      operator: 'ifError',
      message,
      stackStartFn: ifError,
      diff: this?.[kOptions]?.diff,
    });

    // Make sure we actually have a stack trace!
    const origStack = err.stack;

    if (typeof origStack === 'string') {
      // This will remove any duplicated frames from the error frames taken
      // from within `ifError` and add the original error frames to the newly
      // created ones.
      const origStackStart = StringPrototypeIndexOf(origStack, '\n    at');
      if (origStackStart !== -1) {
        const originalFrames = StringPrototypeSplit(
          StringPrototypeSlice(origStack, origStackStart + 1),
          '\n',
        );
        // Filter all frames existing in err.stack.
        let newFrames = StringPrototypeSplit(newErr.stack, '\n');
        for (const errFrame of originalFrames) {
          // Find the first occurrence of the frame.
          const pos = ArrayPrototypeIndexOf(newFrames, errFrame);
          if (pos !== -1) {
            // Only keep new frames.
            newFrames = ArrayPrototypeSlice(newFrames, 0, pos);
            break;
          }
        }
        const stackStart = ArrayPrototypeJoin(newFrames, '\n');
        const stackEnd = ArrayPrototypeJoin(originalFrames, '\n');
        newErr.stack = `${stackStart}\n${stackEnd}`;
      }
    }

    throw newErr;
  }
};

function internalMatch(string, regexp, message, fn) {
  if (!isRegExp(regexp)) {
    throw new ERR_INVALID_ARG_TYPE(
      'regexp', 'RegExp', regexp,
    );
  }
  const match = fn === Assert.prototype.match;
  if (typeof string !== 'string' ||
      RegExpPrototypeExec(regexp, string) !== null !== match) {
    if (message instanceof Error) {
      throw message;
    }

    const generatedMessage = !message;

    // 'The input was expected to not match the regular expression ' +
    message ||= (typeof string !== 'string' ?
      'The "string" argument must be of type string. Received type ' +
        `${typeof string} (${inspect(string)})` :
      (match ?
        'The input did not match the regular expression ' :
        'The input was expected to not match the regular expression ') +
          `${inspect(regexp)}. Input:\n\n${inspect(string)}\n`);
    const err = new AssertionError({
      actual: string,
      expected: regexp,
      message,
      operator: fn.name,
      stackStartFn: fn,
      diff: this?.[kOptions]?.diff,
    });
    err.generatedMessage = generatedMessage;
    throw err;
  }
}

/**
 * Expects the `string` input to match the regular expression.
 * @param {string} string
 * @param {RegExp} regexp
 * @param {string | Error} [message]
 * @returns {void}
 */
Assert.prototype.match = function match(string, regexp, message) {
  internalMatch(string, regexp, message, match);
};

/**
 * Expects the `string` input not to match the regular expression.
 * @param {string} string
 * @param {RegExp} regexp
 * @param {string | Error} [message]
 * @returns {void}
 */
Assert.prototype.doesNotMatch = function doesNotMatch(string, regexp, message) {
  internalMatch(string, regexp, message, doesNotMatch);
};

assert.CallTracker = deprecate(CallTracker, 'assert.CallTracker is deprecated.', 'DEP0173');

/**
 * Expose a strict only variant of assert.
 * @param {...any} args
 * @returns {void}
 */
function strict(...args) {
  innerOk(strict, args.length, ...args);
}

// TODO(aduh95): take `ok` from `Assert.prototype` instead of a self-ref in a next major.
assert.ok = assert;
ArrayPrototypeForEach([
  'fail', 'equal', 'notEqual', 'deepEqual', 'notDeepEqual',
  'deepStrictEqual', 'notDeepStrictEqual', 'strictEqual',
  'notStrictEqual', 'partialDeepStrictEqual', 'match', 'doesNotMatch',
  'throws', 'rejects', 'doesNotThrow', 'doesNotReject', 'ifError',
], (name) => {
  setOwnProperty(assert, name, Assert.prototype[name]);
});

assert.strict = ObjectAssign(strict, assert, {
  equal: assert.strictEqual,
  deepEqual: assert.deepStrictEqual,
  notEqual: assert.notStrictEqual,
  notDeepEqual: assert.notDeepStrictEqual,
});

assert.strict.Assert = Assert;
assert.strict.strict = assert.strict;

assert.Assert = Assert;

    },
    "internal/querystring": function (exports, require, module, process, internalBinding, primordials) {
'use strict';

const {
  Array,
  Int8Array,
  NumberPrototypeToString,
  StringPrototypeCharCodeAt,
  StringPrototypeSlice,
  StringPrototypeToUpperCase,
} = primordials;

const { ERR_INVALID_URI } = require('internal/errors').codes;

const hexTable = new Array(256);
for (let i = 0; i < 256; ++i)
  hexTable[i] = '%' +
                StringPrototypeToUpperCase((i < 16 ? '0' : '') +
                                           NumberPrototypeToString(i, 16));

const isHexTable = new Int8Array([
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, // 0 - 15
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, // 16 - 31
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, // 32 - 47
  1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, // 48 - 63
  0, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, // 64 - 79
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, // 80 - 95
  0, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, // 96 - 111
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, // 112 - 127
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, // 128 ...
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,  // ... 256
]);

/**
 * @param {string} str
 * @param {Int8Array} noEscapeTable
 * @param {string[]} hexTable
 * @returns {string}
 */
function encodeStr(str, noEscapeTable, hexTable) {
  const len = str.length;
  if (len === 0)
    return '';

  let out = '';
  let lastPos = 0;
  let i = 0;

  outer:
  for (; i < len; i++) {
    let c = StringPrototypeCharCodeAt(str, i);

    // ASCII
    while (c < 0x80) {
      if (noEscapeTable[c] !== 1) {
        if (lastPos < i)
          out += StringPrototypeSlice(str, lastPos, i);
        lastPos = i + 1;
        out += hexTable[c];
      }

      if (++i === len)
        break outer;

      c = StringPrototypeCharCodeAt(str, i);
    }

    if (lastPos < i)
      out += StringPrototypeSlice(str, lastPos, i);

    // Multi-byte characters ...
    if (c < 0x800) {
      lastPos = i + 1;
      out += hexTable[0xC0 | (c >> 6)] +
             hexTable[0x80 | (c & 0x3F)];
      continue;
    }
    if (c < 0xD800 || c >= 0xE000) {
      lastPos = i + 1;
      out += hexTable[0xE0 | (c >> 12)] +
             hexTable[0x80 | ((c >> 6) & 0x3F)] +
             hexTable[0x80 | (c & 0x3F)];
      continue;
    }
    // Surrogate pair
    ++i;

    // This branch should never happen because all URLSearchParams entries
    // should already be converted to USVString. But, included for
    // completion's sake anyway.
    if (i >= len)
      throw new ERR_INVALID_URI();

    const c2 = StringPrototypeCharCodeAt(str, i) & 0x3FF;

    lastPos = i + 1;
    c = 0x10000 + (((c & 0x3FF) << 10) | c2);
    out += hexTable[0xF0 | (c >> 18)] +
           hexTable[0x80 | ((c >> 12) & 0x3F)] +
           hexTable[0x80 | ((c >> 6) & 0x3F)] +
           hexTable[0x80 | (c & 0x3F)];
  }
  if (lastPos === 0)
    return str;
  if (lastPos < len)
    return out + StringPrototypeSlice(str, lastPos);
  return out;
}

module.exports = {
  encodeStr,
  hexTable,
  isHexTable,
};

    },
    "querystring": function (exports, require, module, process, internalBinding, primordials) {
// Copyright Joyent, Inc. and other Node contributors.
//
// Permission is hereby granted, free of charge, to any person obtaining a
// copy of this software and associated documentation files (the
// "Software"), to deal in the Software without restriction, including
// without limitation the rights to use, copy, modify, merge, publish,
// distribute, sublicense, and/or sell copies of the Software, and to permit
// persons to whom the Software is furnished to do so, subject to the
// following conditions:
//
// The above copyright notice and this permission notice shall be included
// in all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS
// OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
// MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN
// NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
// DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
// OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE
// USE OR OTHER DEALINGS IN THE SOFTWARE.

// Query String Utilities

'use strict';

const {
  Array,
  ArrayIsArray,
  Int8Array,
  MathAbs,
  NumberIsFinite,
  ObjectKeys,
  String,
  StringPrototypeCharCodeAt,
  StringPrototypeSlice,
  decodeURIComponent,
} = primordials;

const { Buffer } = require('buffer');
const {
  encodeStr,
  hexTable,
  isHexTable,
} = require('internal/querystring');
const QueryString = module.exports = {
  unescapeBuffer,
  // `unescape()` is a JS global, so we need to use a different local name
  unescape: qsUnescape,

  // `escape()` is a JS global, so we need to use a different local name
  escape: qsEscape,

  stringify,
  encode: stringify,

  parse,
  decode: parse,
};

const unhexTable = new Int8Array([
  -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, // 0 - 15
  -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, // 16 - 31
  -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, // 32 - 47
  +0, +1, +2, +3, +4, +5, +6, +7, +8, +9, -1, -1, -1, -1, -1, -1, // 48 - 63
  -1, 10, 11, 12, 13, 14, 15, -1, -1, -1, -1, -1, -1, -1, -1, -1, // 64 - 79
  -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, // 80 - 95
  -1, 10, 11, 12, 13, 14, 15, -1, -1, -1, -1, -1, -1, -1, -1, -1, // 96 - 111
  -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, // 112 - 127
  -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, // 128 ...
  -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
  -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
  -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
  -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
  -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
  -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
  -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,  // ... 255
]);
/**
 * A safe fast alternative to decodeURIComponent
 * @param {string} s
 * @param {boolean} decodeSpaces
 * @returns {string}
 */
function unescapeBuffer(s, decodeSpaces) {
  const out = Buffer.allocUnsafe(s.length);
  let index = 0;
  let outIndex = 0;
  let currentChar;
  let nextChar;
  let hexHigh;
  let hexLow;
  const maxLength = s.length - 2;
  // Flag to know if some hex chars have been decoded
  let hasHex = false;
  while (index < s.length) {
    currentChar = StringPrototypeCharCodeAt(s, index);
    if (currentChar === 43 /* '+' */ && decodeSpaces) {
      out[outIndex++] = 32; // ' '
      index++;
      continue;
    }
    if (currentChar === 37 /* '%' */ && index < maxLength) {
      currentChar = StringPrototypeCharCodeAt(s, ++index);
      hexHigh = unhexTable[currentChar];
      if (!(hexHigh >= 0)) {
        out[outIndex++] = 37; // '%'
        continue;
      } else {
        nextChar = StringPrototypeCharCodeAt(s, ++index);
        hexLow = unhexTable[nextChar];
        if (!(hexLow >= 0)) {
          out[outIndex++] = 37; // '%'
          index--;
        } else {
          hasHex = true;
          currentChar = hexHigh * 16 + hexLow;
        }
      }
    }
    out[outIndex++] = currentChar;
    index++;
  }
  return hasHex ? out.slice(0, outIndex) : out;
}

/**
 * @param {string} s
 * @param {boolean} decodeSpaces
 * @returns {string}
 */
function qsUnescape(s, decodeSpaces) {
  try {
    return decodeURIComponent(s);
  } catch {
    return QueryString.unescapeBuffer(s, decodeSpaces).toString();
  }
}


// These characters do not need escaping when generating query strings:
// ! - . _ ~
// ' ( ) *
// digits
// alpha (uppercase)
// alpha (lowercase)
const noEscape = new Int8Array([
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, // 0 - 15
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, // 16 - 31
  0, 1, 0, 0, 0, 0, 0, 1, 1, 1, 1, 0, 0, 1, 1, 0, // 32 - 47
  1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, // 48 - 63
  0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, // 64 - 79
  1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 1, // 80 - 95
  0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, // 96 - 111
  1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 1, 0,  // 112 - 127
]);

/**
 * QueryString.escape() replaces encodeURIComponent()
 * @see https://www.ecma-international.org/ecma-262/5.1/#sec-15.1.3.4
 * @param {any} str
 * @returns {string}
 */
function qsEscape(str) {
  if (typeof str !== 'string') {
    if (typeof str === 'object')
      str = String(str);
    else
      str += '';
  }

  return encodeStr(str, noEscape, hexTable);
}

/**
 * @param {string | number | bigint | boolean | symbol | undefined | null} v
 * @returns {string}
 */
function stringifyPrimitive(v) {
  if (typeof v === 'string')
    return v;
  if (typeof v === 'number' && NumberIsFinite(v))
    return '' + v;
  if (typeof v === 'bigint')
    return '' + v;
  if (typeof v === 'boolean')
    return v ? 'true' : 'false';
  return '';
}

/**
 * @param {string | number | bigint | boolean} v
 * @param {(v: string) => string} encode
 * @returns {string}
 */
function encodeStringified(v, encode) {
  if (typeof v === 'string')
    return (v.length ? encode(v) : '');
  if (typeof v === 'number' && NumberIsFinite(v)) {
    // Values >= 1e21 automatically switch to scientific notation which requires
    // escaping due to the inclusion of a '+' in the output
    return (MathAbs(v) < 1e21 ? '' + v : encode('' + v));
  }
  if (typeof v === 'bigint')
    return '' + v;
  if (typeof v === 'boolean')
    return v ? 'true' : 'false';
  return '';
}

/**
 * @param {string | number | boolean | null} v
 * @param {(v: string) => string} encode
 * @returns {string}
 */
function encodeStringifiedCustom(v, encode) {
  return encode(stringifyPrimitive(v));
}

/**
 * @param {Record<string, string | number | boolean
 * | ReadonlyArray<string | number | boolean> | null>} obj
 * @param {string} [sep]
 * @param {string} [eq]
 * @param {{ encodeURIComponent?: (v: string) => string }} [options]
 * @returns {string}
 */
function stringify(obj, sep, eq, options) {
  sep ||= '&';
  eq ||= '=';

  let encode = QueryString.escape;
  if (options && typeof options.encodeURIComponent === 'function') {
    encode = options.encodeURIComponent;
  }
  const convert =
    (encode === qsEscape ? encodeStringified : encodeStringifiedCustom);

  if (obj !== null && typeof obj === 'object') {
    const keys = ObjectKeys(obj);
    const len = keys.length;
    let fields = '';
    for (let i = 0; i < len; ++i) {
      const k = keys[i];
      const v = obj[k];
      let ks = convert(k, encode);
      ks += eq;

      if (ArrayIsArray(v)) {
        const vlen = v.length;
        if (vlen === 0) continue;
        if (fields)
          fields += sep;
        for (let j = 0; j < vlen; ++j) {
          if (j)
            fields += sep;
          fields += ks;
          fields += convert(v[j], encode);
        }
      } else {
        if (fields)
          fields += sep;
        fields += ks;
        fields += convert(v, encode);
      }
    }
    return fields;
  }
  return '';
}

/**
 * @param {string} str
 * @returns {number[]}
 */
function charCodes(str) {
  if (str.length === 0) return [];
  if (str.length === 1) return [StringPrototypeCharCodeAt(str, 0)];
  const ret = new Array(str.length);
  for (let i = 0; i < str.length; ++i)
    ret[i] = StringPrototypeCharCodeAt(str, i);
  return ret;
}
const defSepCodes = [38]; // &
const defEqCodes = [61]; // =

function addKeyVal(obj, key, value, keyEncoded, valEncoded, decode) {
  if (key.length > 0 && keyEncoded)
    key = decodeStr(key, decode);
  if (value.length > 0 && valEncoded)
    value = decodeStr(value, decode);

  if (obj[key] === undefined) {
    obj[key] = value;
  } else {
    const curValue = obj[key];
    // A simple Array-specific property check is enough here to
    // distinguish from a string value and is faster and still safe
    // since we are generating all of the values being assigned.
    if (curValue.pop)
      curValue[curValue.length] = value;
    else
      obj[key] = [curValue, value];
  }
}

/**
 * Parse a key/val string.
 * @param {string} qs
 * @param {string} sep
 * @param {string} eq
 * @param {{
 *   maxKeys?: number;
 *   decodeURIComponent?(v: string): string;
 *   }} [options]
 * @returns {Record<string, string | string[]>}
 */
function parse(qs, sep, eq, options) {
  const obj = { __proto__: null };

  if (typeof qs !== 'string' || qs.length === 0) {
    return obj;
  }

  const sepCodes = (!sep ? defSepCodes : charCodes(String(sep)));
  const eqCodes = (!eq ? defEqCodes : charCodes(String(eq)));
  const sepLen = sepCodes.length;
  const eqLen = eqCodes.length;

  let pairs = 1000;
  if (options && typeof options.maxKeys === 'number') {
    // -1 is used in place of a value like Infinity for meaning
    // "unlimited pairs" because of additional checks V8 (at least as of v5.4)
    // has to do when using variables that contain values like Infinity. Since
    // `pairs` is always decremented and checked explicitly for 0, -1 works
    // effectively the same as Infinity, while providing a significant
    // performance boost.
    pairs = (options.maxKeys > 0 ? options.maxKeys : -1);
  }

  let decode = QueryString.unescape;
  if (options && typeof options.decodeURIComponent === 'function') {
    decode = options.decodeURIComponent;
  }
  const customDecode = (decode !== qsUnescape);

  let lastPos = 0;
  let sepIdx = 0;
  let eqIdx = 0;
  let key = '';
  let value = '';
  let keyEncoded = customDecode;
  let valEncoded = customDecode;
  const plusChar = (customDecode ? '%20' : ' ');
  let encodeCheck = 0;
  for (let i = 0; i < qs.length; ++i) {
    const code = StringPrototypeCharCodeAt(qs, i);

    // Try matching key/value pair separator (e.g. '&')
    if (code === sepCodes[sepIdx]) {
      if (++sepIdx === sepLen) {
        // Key/value pair separator match!
        const end = i - sepIdx + 1;
        if (eqIdx < eqLen) {
          // We didn't find the (entire) key/value separator
          if (lastPos < end) {
            // Treat the substring as part of the key instead of the value
            key += StringPrototypeSlice(qs, lastPos, end);
          } else if (key.length === 0) {
            // We saw an empty substring between separators
            if (--pairs === 0)
              return obj;
            lastPos = i + 1;
            sepIdx = eqIdx = 0;
            continue;
          }
        } else if (lastPos < end) {
          value += StringPrototypeSlice(qs, lastPos, end);
        }

        addKeyVal(obj, key, value, keyEncoded, valEncoded, decode);

        if (--pairs === 0)
          return obj;
        keyEncoded = valEncoded = customDecode;
        key = value = '';
        encodeCheck = 0;
        lastPos = i + 1;
        sepIdx = eqIdx = 0;
      }
    } else {
      sepIdx = 0;
      // Try matching key/value separator (e.g. '=') if we haven't already
      if (eqIdx < eqLen) {
        if (code === eqCodes[eqIdx]) {
          if (++eqIdx === eqLen) {
            // Key/value separator match!
            const end = i - eqIdx + 1;
            if (lastPos < end)
              key += StringPrototypeSlice(qs, lastPos, end);
            encodeCheck = 0;
            lastPos = i + 1;
          }
          continue;
        } else {
          eqIdx = 0;
          if (!keyEncoded) {
            // Try to match an (valid) encoded byte once to minimize unnecessary
            // calls to string decoding functions
            if (code === 37/* % */) {
              encodeCheck = 1;
              continue;
            } else if (encodeCheck > 0) {
              if (isHexTable[code] === 1) {
                if (++encodeCheck === 3)
                  keyEncoded = true;
                continue;
              } else {
                encodeCheck = 0;
              }
            }
          }
        }
        if (code === 43/* + */) {
          if (lastPos < i)
            key += StringPrototypeSlice(qs, lastPos, i);
          key += plusChar;
          lastPos = i + 1;
          continue;
        }
      }
      if (code === 43/* + */) {
        if (lastPos < i)
          value += StringPrototypeSlice(qs, lastPos, i);
        value += plusChar;
        lastPos = i + 1;
      } else if (!valEncoded) {
        // Try to match an (valid) encoded byte (once) to minimize unnecessary
        // calls to string decoding functions
        if (code === 37/* % */) {
          encodeCheck = 1;
        } else if (encodeCheck > 0) {
          if (isHexTable[code] === 1) {
            if (++encodeCheck === 3)
              valEncoded = true;
          } else {
            encodeCheck = 0;
          }
        }
      }
    }
  }

  // Deal with any leftover key or value data
  if (lastPos < qs.length) {
    if (eqIdx < eqLen)
      key += StringPrototypeSlice(qs, lastPos);
    else if (sepIdx < sepLen)
      value += StringPrototypeSlice(qs, lastPos);
  } else if (eqIdx === 0 && key.length === 0) {
    // We ended on an empty substring
    return obj;
  }

  addKeyVal(obj, key, value, keyEncoded, valEncoded, decode);

  return obj;
}


/**
 * V8 does not optimize functions with try-catch blocks, so we isolate them here
 * to minimize the damage (Note: no longer true as of V8 5.4 -- but still will
 * not be inlined).
 * @param {string} s
 * @param {(v: string) => string} decoder
 * @returns {string}
 */
function decodeStr(s, decoder) {
  try {
    return decoder(s);
  } catch {
    return QueryString.unescape(s, true);
  }
}

    },
    "punycode": function (exports, require, module, process, internalBinding, primordials) {
'use strict';
const {
  isInsideNodeModules,
} = internalBinding('util');

if (!isInsideNodeModules()) {
	process.emitWarning(
		'The `punycode` module is deprecated. Please use a userland ' +
		'alternative instead.',
		'DeprecationWarning',
		'DEP0040',
	);
}

/** Highest positive signed 32-bit float value */
const maxInt = 2147483647; // aka. 0x7FFFFFFF or 2^31-1

/** Bootstring parameters */
const base = 36;
const tMin = 1;
const tMax = 26;
const skew = 38;
const damp = 700;
const initialBias = 72;
const initialN = 128; // 0x80
const delimiter = '-'; // '\x2D'

/** Regular expressions */
const regexPunycode = /^xn--/;
const regexNonASCII = /[^\0-\x7F]/; // Note: U+007F DEL is excluded too.
const regexSeparators = /[\x2E\u3002\uFF0E\uFF61]/g; // RFC 3490 separators

/** Error messages */
const errors = {
	'overflow': 'Overflow: input needs wider integers to process',
	'not-basic': 'Illegal input >= 0x80 (not a basic code point)',
	'invalid-input': 'Invalid input'
};

/** Convenience shortcuts */
const baseMinusTMin = base - tMin;
const floor = Math.floor;
const stringFromCharCode = String.fromCharCode;

/*--------------------------------------------------------------------------*/

/**
 * A generic error utility function.
 * @private
 * @param {String} type The error type.
 * @returns {Error} Throws a `RangeError` with the applicable error message.
 */
function error(type) {
	throw new RangeError(errors[type]);
}

/**
 * A generic `Array#map` utility function.
 * @private
 * @param {Array} array The array to iterate over.
 * @param {Function} callback The function that gets called for every array
 * item.
 * @returns {Array} A new array of values returned by the callback function.
 */
function map(array, callback) {
	const result = [];
	let length = array.length;
	while (length--) {
		result[length] = callback(array[length]);
	}
	return result;
}

/**
 * A simple `Array#map`-like wrapper to work with domain name strings or email
 * addresses.
 * @private
 * @param {String} domain The domain name or email address.
 * @param {Function} callback The function that gets called for every
 * character.
 * @returns {String} A new string of characters returned by the callback
 * function.
 */
function mapDomain(domain, callback) {
	const parts = domain.split('@');
	let result = '';
	if (parts.length > 1) {
		// In email addresses, only the domain name should be punycoded. Leave
		// the local part (i.e. everything up to `@`) intact.
		result = parts[0] + '@';
		domain = parts[1];
	}
	// Avoid `split(regex)` for IE8 compatibility. See #17.
	domain = domain.replace(regexSeparators, '\x2E');
	const labels = domain.split('.');
	const encoded = map(labels, callback).join('.');
	return result + encoded;
}

/**
 * Creates an array containing the numeric code points of each Unicode
 * character in the string. While JavaScript uses UCS-2 internally,
 * this function will convert a pair of surrogate halves (each of which
 * UCS-2 exposes as separate characters) into a single code point,
 * matching UTF-16.
 * @see `punycode.ucs2.encode`
 * @see <https://mathiasbynens.be/notes/javascript-encoding>
 * @memberOf punycode.ucs2
 * @name decode
 * @param {String} string The Unicode input string (UCS-2).
 * @returns {Array} The new array of code points.
 */
function ucs2decode(string) {
	const output = [];
	let counter = 0;
	const length = string.length;
	while (counter < length) {
		const value = string.charCodeAt(counter++);
		if (value >= 0xD800 && value <= 0xDBFF && counter < length) {
			// It's a high surrogate, and there is a next character.
			const extra = string.charCodeAt(counter++);
			if ((extra & 0xFC00) == 0xDC00) { // Low surrogate.
				output.push(((value & 0x3FF) << 10) + (extra & 0x3FF) + 0x10000);
			} else {
				// It's an unmatched surrogate; only append this code unit, in case the
				// next code unit is the high surrogate of a surrogate pair.
				output.push(value);
				counter--;
			}
		} else {
			output.push(value);
		}
	}
	return output;
}

/**
 * Creates a string based on an array of numeric code points.
 * @see `punycode.ucs2.decode`
 * @memberOf punycode.ucs2
 * @name encode
 * @param {Array} codePoints The array of numeric code points.
 * @returns {String} The new Unicode string (UCS-2).
 */
const ucs2encode = codePoints => String.fromCodePoint(...codePoints);

/**
 * Converts a basic code point into a digit/integer.
 * @see `digitToBasic()`
 * @private
 * @param {Number} codePoint The basic numeric code point value.
 * @returns {Number} The numeric value of a basic code point (for use in
 * representing integers) in the range `0` to `base - 1`, or `base` if
 * the code point does not represent a value.
 */
const basicToDigit = function(codePoint) {
	if (codePoint >= 0x30 && codePoint < 0x3A) {
		return 26 + (codePoint - 0x30);
	}
	if (codePoint >= 0x41 && codePoint < 0x5B) {
		return codePoint - 0x41;
	}
	if (codePoint >= 0x61 && codePoint < 0x7B) {
		return codePoint - 0x61;
	}
	return base;
};

/**
 * Converts a digit/integer into a basic code point.
 * @see `basicToDigit()`
 * @private
 * @param {Number} digit The numeric value of a basic code point.
 * @returns {Number} The basic code point whose value (when used for
 * representing integers) is `digit`, which needs to be in the range
 * `0` to `base - 1`. If `flag` is non-zero, the uppercase form is
 * used; else, the lowercase form is used. The behavior is undefined
 * if `flag` is non-zero and `digit` has no uppercase form.
 */
const digitToBasic = function(digit, flag) {
	//  0..25 map to ASCII a..z or A..Z
	// 26..35 map to ASCII 0..9
	return digit + 22 + 75 * (digit < 26) - ((flag != 0) << 5);
};

/**
 * Bias adaptation function as per section 3.4 of RFC 3492.
 * https://tools.ietf.org/html/rfc3492#section-3.4
 * @private
 */
const adapt = function(delta, numPoints, firstTime) {
	let k = 0;
	delta = firstTime ? floor(delta / damp) : delta >> 1;
	delta += floor(delta / numPoints);
	for (/* no initialization */; delta > baseMinusTMin * tMax >> 1; k += base) {
		delta = floor(delta / baseMinusTMin);
	}
	return floor(k + (baseMinusTMin + 1) * delta / (delta + skew));
};

/**
 * Converts a Punycode string of ASCII-only symbols to a string of Unicode
 * symbols.
 * @memberOf punycode
 * @param {String} input The Punycode string of ASCII-only symbols.
 * @returns {String} The resulting string of Unicode symbols.
 */
const decode = function(input) {
	// Don't use UCS-2.
	const output = [];
	const inputLength = input.length;
	let i = 0;
	let n = initialN;
	let bias = initialBias;

	// Handle the basic code points: let `basic` be the number of input code
	// points before the last delimiter, or `0` if there is none, then copy
	// the first basic code points to the output.

	let basic = input.lastIndexOf(delimiter);
	if (basic < 0) {
		basic = 0;
	}

	for (let j = 0; j < basic; ++j) {
		// if it's not a basic code point
		if (input.charCodeAt(j) >= 0x80) {
			error('not-basic');
		}
		output.push(input.charCodeAt(j));
	}

	// Main decoding loop: start just after the last delimiter if any basic code
	// points were copied; start at the beginning otherwise.

	for (let index = basic > 0 ? basic + 1 : 0; index < inputLength; /* no final expression */) {

		// `index` is the index of the next character to be consumed.
		// Decode a generalized variable-length integer into `delta`,
		// which gets added to `i`. The overflow checking is easier
		// if we increase `i` as we go, then subtract off its starting
		// value at the end to obtain `delta`.
		const oldi = i;
		for (let w = 1, k = base; /* no condition */; k += base) {

			if (index >= inputLength) {
				error('invalid-input');
			}

			const digit = basicToDigit(input.charCodeAt(index++));

			if (digit >= base) {
				error('invalid-input');
			}
			if (digit > floor((maxInt - i) / w)) {
				error('overflow');
			}

			i += digit * w;
			const t = k <= bias ? tMin : (k >= bias + tMax ? tMax : k - bias);

			if (digit < t) {
				break;
			}

			const baseMinusT = base - t;
			if (w > floor(maxInt / baseMinusT)) {
				error('overflow');
			}

			w *= baseMinusT;

		}

		const out = output.length + 1;
		bias = adapt(i - oldi, out, oldi == 0);

		// `i` was supposed to wrap around from `out` to `0`,
		// incrementing `n` each time, so we'll fix that now:
		if (floor(i / out) > maxInt - n) {
			error('overflow');
		}

		n += floor(i / out);
		i %= out;

		// Insert `n` at position `i` of the output.
		output.splice(i++, 0, n);

	}

	return String.fromCodePoint(...output);
};

/**
 * Converts a string of Unicode symbols (e.g. a domain name label) to a
 * Punycode string of ASCII-only symbols.
 * @memberOf punycode
 * @param {String} input The string of Unicode symbols.
 * @returns {String} The resulting Punycode string of ASCII-only symbols.
 */
const encode = function(input) {
	const output = [];

	// Convert the input in UCS-2 to an array of Unicode code points.
	input = ucs2decode(input);

	// Cache the length.
	const inputLength = input.length;

	// Initialize the state.
	let n = initialN;
	let delta = 0;
	let bias = initialBias;

	// Handle the basic code points.
	for (const currentValue of input) {
		if (currentValue < 0x80) {
			output.push(stringFromCharCode(currentValue));
		}
	}

	const basicLength = output.length;
	let handledCPCount = basicLength;

	// `handledCPCount` is the number of code points that have been handled;
	// `basicLength` is the number of basic code points.

	// Finish the basic string with a delimiter unless it's empty.
	if (basicLength) {
		output.push(delimiter);
	}

	// Main encoding loop:
	while (handledCPCount < inputLength) {

		// All non-basic code points < n have been handled already. Find the next
		// larger one:
		let m = maxInt;
		for (const currentValue of input) {
			if (currentValue >= n && currentValue < m) {
				m = currentValue;
			}
		}

		// Increase `delta` enough to advance the decoder's <n,i> state to <m,0>,
		// but guard against overflow.
		const handledCPCountPlusOne = handledCPCount + 1;
		if (m - n > floor((maxInt - delta) / handledCPCountPlusOne)) {
			error('overflow');
		}

		delta += (m - n) * handledCPCountPlusOne;
		n = m;

		for (const currentValue of input) {
			if (currentValue < n && ++delta > maxInt) {
				error('overflow');
			}
			if (currentValue === n) {
				// Represent delta as a generalized variable-length integer.
				let q = delta;
				for (let k = base; /* no condition */; k += base) {
					const t = k <= bias ? tMin : (k >= bias + tMax ? tMax : k - bias);
					if (q < t) {
						break;
					}
					const qMinusT = q - t;
					const baseMinusT = base - t;
					output.push(
						stringFromCharCode(digitToBasic(t + qMinusT % baseMinusT, 0))
					);
					q = floor(qMinusT / baseMinusT);
				}

				output.push(stringFromCharCode(digitToBasic(q, 0)));
				bias = adapt(delta, handledCPCountPlusOne, handledCPCount === basicLength);
				delta = 0;
				++handledCPCount;
			}
		}

		++delta;
		++n;

	}
	return output.join('');
};

/**
 * Converts a Punycode string representing a domain name or an email address
 * to Unicode. Only the Punycoded parts of the input will be converted, i.e.
 * it doesn't matter if you call it on a string that has already been
 * converted to Unicode.
 * @memberOf punycode
 * @param {String} input The Punycoded domain name or email address to
 * convert to Unicode.
 * @returns {String} The Unicode representation of the given Punycode
 * string.
 */
const toUnicode = function(input) {
	return mapDomain(input, function(string) {
		return regexPunycode.test(string)
			? decode(string.slice(4).toLowerCase())
			: string;
	});
};

/**
 * Converts a Unicode string representing a domain name or an email address to
 * Punycode. Only the non-ASCII parts of the domain name will be converted,
 * i.e. it doesn't matter if you call it with a domain that's already in
 * ASCII.
 * @memberOf punycode
 * @param {String} input The domain name or email address to convert, as a
 * Unicode string.
 * @returns {String} The Punycode representation of the given domain name or
 * email address.
 */
const toASCII = function(input) {
	return mapDomain(input, function(string) {
		return regexNonASCII.test(string)
			? 'xn--' + encode(string)
			: string;
	});
};

/*--------------------------------------------------------------------------*/

/** Define the public API */
const punycode = {
	/**
	 * A string representing the current Punycode.js version number.
	 * @memberOf punycode
	 * @type String
	 */
	'version': '2.1.0',
	/**
	 * An object of methods to convert from JavaScript's internal character
	 * representation (UCS-2) to Unicode code points, and back.
	 * @see <https://mathiasbynens.be/notes/javascript-encoding>
	 * @memberOf punycode
	 * @type Object
	 */
	'ucs2': {
		'decode': ucs2decode,
		'encode': ucs2encode
	},
	'decode': decode,
	'encode': encode,
	'toASCII': toASCII,
	'toUnicode': toUnicode
};

module.exports = punycode;

    },
    "internal/streams/utils": function (exports, require, module, process, internalBinding, primordials) {
'use strict';

const {
  Symbol,
  SymbolAsyncIterator,
  SymbolFor,
  SymbolIterator,
} = primordials;

// We need to use SymbolFor to make these globally available
// for interoperability with readable-stream, i.e. readable-stream
// and node core needs to be able to read/write private state
// from each other for proper interoperability.
const kIsDestroyed = SymbolFor('nodejs.stream.destroyed');
const kIsErrored = SymbolFor('nodejs.stream.errored');
const kIsReadable = SymbolFor('nodejs.stream.readable');
const kIsWritable = SymbolFor('nodejs.stream.writable');
const kIsDisturbed = SymbolFor('nodejs.stream.disturbed');

const kOnConstructed = Symbol('kOnConstructed');

const kIsClosedPromise = SymbolFor('nodejs.webstream.isClosedPromise');
const kControllerErrorFunction = SymbolFor('nodejs.webstream.controllerErrorFunction');

const kState = Symbol('kState');
const kObjectMode = 1 << 0;
const kErrorEmitted = 1 << 1;
const kAutoDestroy = 1 << 2;
const kEmitClose = 1 << 3;
const kDestroyed = 1 << 4;
const kClosed = 1 << 5;
const kCloseEmitted = 1 << 6;
const kErrored = 1 << 7;
const kConstructed = 1 << 8;

function isReadableNodeStream(obj, strict = false) {
  return !!(
    obj &&
    typeof obj.pipe === 'function' &&
    typeof obj.on === 'function' &&
    (
      !strict ||
      (typeof obj.pause === 'function' && typeof obj.resume === 'function')
    ) &&
    (!obj._writableState || obj._readableState?.readable !== false) && // Duplex
    (!obj._writableState || obj._readableState) // Writable has .pipe.
  );
}

function isWritableNodeStream(obj) {
  return !!(
    obj &&
    typeof obj.write === 'function' &&
    typeof obj.on === 'function' &&
    (!obj._readableState || obj._writableState?.writable !== false) // Duplex
  );
}

function isDuplexNodeStream(obj) {
  return !!(
    obj &&
    (typeof obj.pipe === 'function' && obj._readableState) &&
    typeof obj.on === 'function' &&
    typeof obj.write === 'function'
  );
}

function isNodeStream(obj) {
  return (
    obj &&
    (
      obj._readableState ||
      obj._writableState ||
      (typeof obj.write === 'function' && typeof obj.on === 'function') ||
      (typeof obj.pipe === 'function' && typeof obj.on === 'function')
    )
  );
}

function isReadableStream(obj) {
  return !!(
    obj &&
    !isNodeStream(obj) &&
    typeof obj.pipeThrough === 'function' &&
    typeof obj.getReader === 'function' &&
    typeof obj.cancel === 'function'
  );
}

function isWritableStream(obj) {
  return !!(
    obj &&
    !isNodeStream(obj) &&
    typeof obj.getWriter === 'function' &&
    typeof obj.abort === 'function'
  );
}

function isTransformStream(obj) {
  return !!(
    obj &&
    !isNodeStream(obj) &&
    typeof obj.readable === 'object' &&
    typeof obj.writable === 'object'
  );
}

function isWebStream(obj) {
  return isReadableStream(obj) || isWritableStream(obj) || isTransformStream(obj);
}

function isIterable(obj, isAsync) {
  if (obj == null) return false;
  if (isAsync === true) return typeof obj[SymbolAsyncIterator] === 'function';
  if (isAsync === false) return typeof obj[SymbolIterator] === 'function';
  return typeof obj[SymbolAsyncIterator] === 'function' ||
    typeof obj[SymbolIterator] === 'function';
}

function isDestroyed(stream) {
  if (!isNodeStream(stream)) return null;
  const wState = stream._writableState;
  const rState = stream._readableState;
  const state = wState || rState;
  return !!(stream.destroyed || stream[kIsDestroyed] || state?.destroyed);
}

// Have been end():d.
function isWritableEnded(stream) {
  if (!isWritableNodeStream(stream)) return null;
  if (stream.writableEnded === true) return true;
  const wState = stream._writableState;
  if (wState?.errored) return false;
  if (typeof wState?.ended !== 'boolean') return null;
  return wState.ended;
}

// Have emitted 'finish'.
function isWritableFinished(stream, strict) {
  if (!isWritableNodeStream(stream)) return null;
  if (stream.writableFinished === true) return true;
  const wState = stream._writableState;
  if (wState?.errored) return false;
  if (typeof wState?.finished !== 'boolean') return null;
  return !!(
    wState.finished ||
    (strict === false && wState.ended === true && wState.length === 0)
  );
}

// Have been push(null):d.
function isReadableEnded(stream) {
  if (!isReadableNodeStream(stream)) return null;
  if (stream.readableEnded === true) return true;
  const rState = stream._readableState;
  if (!rState || rState.errored) return false;
  if (typeof rState?.ended !== 'boolean') return null;
  return rState.ended;
}

// Have emitted 'end'.
function isReadableFinished(stream, strict) {
  if (!isReadableNodeStream(stream)) return null;
  const rState = stream._readableState;
  if (rState?.errored) return false;
  if (typeof rState?.endEmitted !== 'boolean') return null;
  return !!(
    rState.endEmitted ||
    (strict === false && rState.ended === true && rState.length === 0)
  );
}

function isReadable(stream) {
  if (stream && stream[kIsReadable] != null) return stream[kIsReadable];
  if (typeof stream?.readable !== 'boolean') return null;
  if (isDestroyed(stream)) return false;
  return isReadableNodeStream(stream) &&
    stream.readable &&
    !isReadableFinished(stream);
}

function isWritable(stream) {
  if (stream && stream[kIsWritable] != null) return stream[kIsWritable];
  if (typeof stream?.writable !== 'boolean') return null;
  if (isDestroyed(stream)) return false;
  return isWritableNodeStream(stream) &&
    stream.writable &&
    !isWritableEnded(stream);
}

function isFinished(stream, opts) {
  if (!isNodeStream(stream)) {
    return null;
  }

  if (isDestroyed(stream)) {
    return true;
  }

  if (opts?.readable !== false && isReadable(stream)) {
    return false;
  }

  if (opts?.writable !== false && isWritable(stream)) {
    return false;
  }

  return true;
}

function isWritableErrored(stream) {
  if (!isNodeStream(stream)) {
    return null;
  }

  if (stream.writableErrored) {
    return stream.writableErrored;
  }

  return stream._writableState?.errored ?? null;
}

function isReadableErrored(stream) {
  if (!isNodeStream(stream)) {
    return null;
  }

  if (stream.readableErrored) {
    return stream.readableErrored;
  }

  return stream._readableState?.errored ?? null;
}

function isClosed(stream) {
  if (!isNodeStream(stream)) {
    return null;
  }

  if (typeof stream.closed === 'boolean') {
    return stream.closed;
  }

  const wState = stream._writableState;
  const rState = stream._readableState;

  if (
    typeof wState?.closed === 'boolean' ||
    typeof rState?.closed === 'boolean'
  ) {
    return wState?.closed || rState?.closed;
  }

  if (typeof stream._closed === 'boolean' && isOutgoingMessage(stream)) {
    return stream._closed;
  }

  return null;
}

function isOutgoingMessage(stream) {
  return (
    typeof stream._closed === 'boolean' &&
    typeof stream._defaultKeepAlive === 'boolean' &&
    typeof stream._removedConnection === 'boolean' &&
    typeof stream._removedContLen === 'boolean'
  );
}

function isServerResponse(stream) {
  return (
    typeof stream._sent100 === 'boolean' &&
    isOutgoingMessage(stream)
  );
}

function isServerRequest(stream) {
  return (
    typeof stream._consuming === 'boolean' &&
    typeof stream._dumped === 'boolean' &&
    stream.req?.upgradeOrConnect === undefined
  );
}

function willEmitClose(stream) {
  if (!isNodeStream(stream)) return null;

  const wState = stream._writableState;
  const rState = stream._readableState;
  const state = wState || rState;

  return (!state && isServerResponse(stream)) || !!(
    state?.autoDestroy &&
    state.emitClose &&
    state.closed === false
  );
}

function isDisturbed(stream) {
  return !!(stream && (
    stream[kIsDisturbed] ??
    (stream.readableDidRead || stream.readableAborted)
  ));
}

function isErrored(stream) {
  return !!(stream && (
    stream[kIsErrored] ??
    stream.readableErrored ??
    stream.writableErrored ??
    stream._readableState?.errorEmitted ??
    stream._writableState?.errorEmitted ??
    stream._readableState?.errored ??
    stream._writableState?.errored
  ));
}

module.exports = {
  kOnConstructed,
  isDestroyed,
  kIsDestroyed,
  isDisturbed,
  kIsDisturbed,
  isErrored,
  kIsErrored,
  isReadable,
  kIsReadable,
  kIsClosedPromise,
  kControllerErrorFunction,
  kIsWritable,
  isClosed,
  isDuplexNodeStream,
  isFinished,
  isIterable,
  isReadableNodeStream,
  isReadableStream,
  isReadableEnded,
  isReadableFinished,
  isReadableErrored,
  isNodeStream,
  isWebStream,
  isWritable,
  isWritableNodeStream,
  isWritableStream,
  isWritableEnded,
  isWritableFinished,
  isWritableErrored,
  isServerRequest,
  isServerResponse,
  willEmitClose,
  isTransformStream,
  kState,
  // bitfields
  kObjectMode,
  kErrorEmitted,
  kAutoDestroy,
  kEmitClose,
  kDestroyed,
  kClosed,
  kCloseEmitted,
  kErrored,
  kConstructed,
};

    },
    "internal/util/debuglog": function (exports, require, module, process, internalBinding, primordials) {
'use strict';

const {
  MathFloor,
  Number,
  NumberPrototypeToFixed,
  ObjectDefineProperty,
  RegExp,
  RegExpPrototypeExec,
  SafeArrayIterator,
  SafeMap,
  StringPrototypePadStart,
  StringPrototypeSplit,
  StringPrototypeToLowerCase,
  StringPrototypeToUpperCase,
} = primordials;
const {
  CHAR_LOWERCASE_B: kTraceBegin,
  CHAR_LOWERCASE_E: kTraceEnd,
  CHAR_LOWERCASE_N: kTraceInstant,
} = require('internal/constants');
const { inspect, format, formatWithOptions } = require('internal/util/inspect');
const { getCategoryEnabledBuffer, trace } = internalBinding('trace_events');

// `debugImpls` and `testEnabled` are deliberately not initialized so any call
// to `debuglog()` before `initializeDebugEnv()` is called will throw.
let debugImpls;
let testEnabled;


// `debugEnv` is initial value of process.env.NODE_DEBUG
function initializeDebugEnv(debugEnv) {
  debugImpls = { __proto__: null };
  if (debugEnv) {
    // This is run before any user code, it's OK not to use primordials.
    debugEnv = debugEnv.replace(/[|\\{}()[\]^$+?.]/g, '\\$&')
      .replaceAll('*', '.*')
      .replaceAll(',', '$|^');
    const debugEnvRegex = new RegExp(`^${debugEnv}$`, 'i');
    testEnabled = (str) => RegExpPrototypeExec(debugEnvRegex, str) !== null;
  } else {
    testEnabled = () => false;
  }
}

// Emits warning when user sets
// NODE_DEBUG=http or NODE_DEBUG=http2.
function emitWarningIfNeeded(set) {
  if ('HTTP' === set || 'HTTP2' === set) {
    process.emitWarning('Setting the NODE_DEBUG environment variable ' +
      'to \'' + StringPrototypeToLowerCase(set) + '\' can expose sensitive ' +
      'data (such as passwords, tokens and authentication headers) ' +
      'in the resulting log.');
  }
}

const noop = () => {};

let utilColors;
function lazyUtilColors() {
  utilColors ??= require('internal/util/colors');
  return utilColors;
}

function debuglogImpl(enabled, set) {
  if (debugImpls[set] === undefined) {
    if (enabled) {
      const pid = process.pid;
      emitWarningIfNeeded(set);
      debugImpls[set] = function debug(...args) {
        const colors = lazyUtilColors().shouldColorize(process.stderr);
        const msg = formatWithOptions({ colors }, ...args);
        const coloredPID = inspect(pid, { colors });
        process.stderr.write(format('%s %s: %s\n', set, coloredPID, msg));
      };
    } else {
      debugImpls[set] = noop;
    }
  }
  return debugImpls[set];
}

// debuglogImpl depends on process.pid and process.env.NODE_DEBUG,
// so it needs to be called lazily in top scopes of internal modules
// that may be loaded before these run time states are allowed to
// be accessed.
function debuglog(set, cb) {
  function init() {
    set = StringPrototypeToUpperCase(set);
    enabled = testEnabled(set);
  }
  let debug = (...args) => {
    init();
    // Only invokes debuglogImpl() when the debug function is
    // called for the first time.
    debug = debuglogImpl(enabled, set);
    if (typeof cb === 'function') {
      ObjectDefineProperty(debug, 'enabled', {
        __proto__: null,
        get() {
          return enabled;
        },
        configurable: true,
        enumerable: true,
      });
      cb(debug);
    }
    switch (args.length) {
      case 1: return debug(args[0]);
      case 2: return debug(args[0], args[1]);
      default: return debug(...new SafeArrayIterator(args));
    }
  };
  let enabled;
  let test = () => {
    init();
    test = () => enabled;
    return enabled;
  };
  const logger = (...args) => {
    // Improve performance when debug is disabled, avoid calling `new SafeArrayIterator(args)`
    if (enabled === false) return;
    switch (args.length) {
      case 1: return debug(args[0]);
      case 2: return debug(args[0], args[1]);
      default: return debug(...new SafeArrayIterator(args));
    }
  };
  ObjectDefineProperty(logger, 'enabled', {
    __proto__: null,
    get() {
      return test();
    },
    configurable: true,
    enumerable: true,
  });
  return logger;
}

function pad(value) {
  return StringPrototypePadStart(`${value}`, 2, '0');
}

const kNone = 1 << 0;
const kSkipLog = 1 << 1;
const kSkipTrace = 1 << 2;
const kShouldSkipAll = kSkipLog | kSkipTrace;

const kSecond = 1000;
const kMinute = 60 * kSecond;
const kHour = 60 * kMinute;

function formatTime(ms) {
  let hours = 0;
  let minutes = 0;
  let seconds = 0;

  if (ms >= kSecond) {
    if (ms >= kMinute) {
      if (ms >= kHour) {
        hours = MathFloor(ms / kHour);
        ms = ms % kHour;
      }
      minutes = MathFloor(ms / kMinute);
      ms = ms % kMinute;
    }
    seconds = ms / kSecond;
  }

  if (hours !== 0 || minutes !== 0) {
    ({ 0: seconds, 1: ms } = StringPrototypeSplit(
      NumberPrototypeToFixed(seconds, 3),
      '.',
      2,
    ));
    const res = hours !== 0 ? `${hours}:${pad(minutes)}` : minutes;
    return `${res}:${pad(seconds)}.${ms} (${hours !== 0 ? 'h:m' : ''}m:ss.mmm)`;
  }

  if (seconds !== 0) {
    return `${NumberPrototypeToFixed(seconds, 3)}s`;
  }

  return `${Number(NumberPrototypeToFixed(ms, 3))}ms`;
}

function safeTraceLabel(label) {
  return label.replaceAll('\\', '\\\\').replaceAll('"', '\\"');
}

/**
 * @typedef {(label: string, timeFormatted: string, args?: any[]) => void} LogImpl
 */

/**
 * Returns true if label was found
 * @param {string} timesStore
 * @param {string} implementation
 * @param {LogImpl} logImp
 * @param {string} label
 * @param {any} args
 * @returns {void}
 */
function timeLogImpl(timesStore, implementation, logImp, label, args) {
  const time = timesStore.get(label);
  if (time === undefined) {
    process.emitWarning(`No such label '${label}' for ${implementation}`);
    return;
  }

  const duration = process.hrtime(time);
  const ms = duration[0] * 1000 + duration[1] / 1e6;

  const formatted = formatTime(ms);

  if (args === undefined) {
    logImp(label, formatted);
  } else {
    logImp(label, formatted, args);
  }
}

/**
 * @param {SafeMap} timesStore
 * @param {string} traceCategory
 * @param {string} implementation
 * @param {number} timerFlags
 * @param {string} logLabel
 * @param {string} traceLabel
 * @returns {void}
 */
function time(timesStore, traceCategory, implementation, timerFlags, logLabel = 'default', traceLabel = undefined) {
  // Coerces everything other than Symbol to a string
  logLabel = `${logLabel}`;

  if (traceLabel !== undefined) {
    traceLabel = `${traceLabel}`;
  } else {
    traceLabel = logLabel;
  }

  if (timesStore.has(logLabel)) {
    process.emitWarning(`Label '${logLabel}' already exists for ${implementation}`);
    return;
  }

  if ((timerFlags & kSkipTrace) === 0) {
    traceLabel = safeTraceLabel(traceLabel);
    trace(kTraceBegin, traceCategory, traceLabel, 0);
  }

  timesStore.set(logLabel, process.hrtime());
}

/**
 * @param {SafeMap} timesStore
 * @param {string} traceCategory
 * @param {string} implementation
 * @param {number} timerFlags
 * @param {LogImpl} logImpl
 * @param {string} logLabel
 * @param {string} traceLabel
 * @returns {void}
 */
function timeEnd(
  timesStore,
  traceCategory,
  implementation,
  timerFlags,
  logImpl,
  logLabel = 'default',
  traceLabel = undefined,
) {
  // Coerces everything other than Symbol to a string
  logLabel = `${logLabel}`;

  if (traceLabel !== undefined) {
    traceLabel = `${traceLabel}`;
  } else {
    traceLabel = logLabel;
  }

  if ((timerFlags & kSkipLog) === 0) {
    timeLogImpl(timesStore, implementation, logImpl, logLabel);
  }

  if ((timerFlags & kSkipTrace) === 0) {
    traceLabel = safeTraceLabel(traceLabel);
    trace(kTraceEnd, traceCategory, traceLabel, 0);
  }

  timesStore.delete(logLabel);
}

/**
 * @param {SafeMap} timesStore
 * @param {string} traceCategory
 * @param {string} implementation
 * @param {number} timerFlags
 * @param {LogImpl} logImpl
 * @param {string} logLabel
 * @param {string} traceLabel
 * @param {any[]} args
 * @returns {void}
 */
function timeLog(
  timesStore,
  traceCategory,
  implementation,
  timerFlags,
  logImpl,
  logLabel = 'default',
  traceLabel = undefined,
  args,
) {
  // Coerces everything other than Symbol to a string
  logLabel = `${logLabel}`;

  if (traceLabel !== undefined) {
    traceLabel = `${traceLabel}`;
  } else {
    traceLabel = logLabel;
  }

  if ((timerFlags & kSkipLog) === 0) {
    timeLogImpl(timesStore, implementation, logImpl, logLabel, args);
  }

  if ((timerFlags & kSkipTrace) === 0) {
    traceLabel = safeTraceLabel(traceLabel);
    trace(kTraceInstant, traceCategory, traceLabel, 0);
  }
}

/**
 * @type {Record<string, SafeMap>}
 */
let tracesStores;

/**
 * @typedef {(logLabel: string, traceLabel?: string) => void} TimerStart
 */

/**
 * @typedef {(logLabel: string, traceLabel?: string) => void} TimerEnd
 */

/**
 * @typedef {(logLabel: string, traceLabel?: string, args?: any[]) => void} TimerLog
 */

/**
 * Debuglog with time fns and support for trace
 * @param {string} set
 * @param {(startTimer: TimerStart, endTimer: TimerEnd, logTimer: TimerLog) => void} cb
 * @returns {{startTimer: TimerStart, endTimer: TimerEnd, logTimer: TimerLog}}
 */
function debugWithTimer(set, cb) {
  set = StringPrototypeToUpperCase(set);

  if (tracesStores === undefined) {
    tracesStores = { __proto__: null };
  }

  /**
   * @type {LogImpl}
   */
  function logImpl(label, timeFormatted, args) {
    const pid = process.pid;
    const colors = { colors: lazyUtilColors().shouldColorize(process.stderr) };
    const coloredPID = inspect(pid, colors);

    if (args === undefined)
      process.stderr.write(format('%s %s %s: %s\n', set, coloredPID, label, timeFormatted));
    else
      process.stderr.write(
        format(
          '%s %s %s: %s\n',
          set,
          coloredPID,
          label,
          timeFormatted,
          ...new SafeArrayIterator(args),
        ),
      );
  }

  const traceCategory = `node,node.${StringPrototypeToLowerCase(set)}`;
  let traceCategoryBuffer;
  let debugLogCategoryEnabled = false;
  let timerFlags = kNone;

  function ensureTimerFlagsAreUpdated() {
    timerFlags &= ~kSkipTrace;

    if (traceCategoryBuffer[0] === 0) {
      timerFlags |= kSkipTrace;
    }
  }

  /**
   * @type {TimerStart}
   */
  function internalStartTimer(logLabel, traceLabel) {
    ensureTimerFlagsAreUpdated();

    if ((timerFlags & kShouldSkipAll) === kShouldSkipAll) {
      return;
    }

    time(
      tracesStores[set],
      traceCategory,
      'debuglog.time',
      timerFlags,
      logLabel,
      traceLabel,
    );
  }

  /**
   * @type {TimerEnd}
   */
  function internalEndTimer(logLabel, traceLabel) {
    ensureTimerFlagsAreUpdated();

    if ((timerFlags & kShouldSkipAll) === kShouldSkipAll) {
      return;
    }

    timeEnd(
      tracesStores[set],
      traceCategory,
      'debuglog.timeEnd',
      timerFlags,
      logImpl,
      logLabel,
      traceLabel,
    );
  }

  /**
   * @type {TimerLog}
   */
  function internalLogTimer(logLabel, traceLabel, args) {
    ensureTimerFlagsAreUpdated();

    if ((timerFlags & kShouldSkipAll) === kShouldSkipAll) {
      return;
    }

    timeLog(
      tracesStores[set],
      traceCategory,
      'debuglog.timeLog',
      timerFlags,
      logImpl,
      logLabel,
      traceLabel,
      args,
    );
  }

  function init() {
    if (tracesStores[set] === undefined) {
      tracesStores[set] = new SafeMap();
    }
    emitWarningIfNeeded(set);
    debugLogCategoryEnabled = testEnabled(set);
    traceCategoryBuffer = getCategoryEnabledBuffer(traceCategory);

    timerFlags = kNone;

    if (!debugLogCategoryEnabled) {
      timerFlags |= kSkipLog;
    }

    if (traceCategoryBuffer[0] === 0) {
      timerFlags |= kSkipTrace;
    }

    cb(internalStartTimer, internalEndTimer, internalLogTimer);
  }

  /**
   * @type {TimerStart}
   */
  const startTimer = (logLabel, traceLabel) => {
    init();

    if ((timerFlags & kShouldSkipAll) !== kShouldSkipAll)
      internalStartTimer(logLabel, traceLabel);
  };

  /**
   * @type {TimerEnd}
   */
  const endTimer = (logLabel, traceLabel) => {
    init();

    if ((timerFlags & kShouldSkipAll) !== kShouldSkipAll)
      internalEndTimer(logLabel, traceLabel);
  };

  /**
   * @type {TimerLog}
   */
  const logTimer = (logLabel, traceLabel, args) => {
    init();

    if ((timerFlags & kShouldSkipAll) !== kShouldSkipAll)
      internalLogTimer(logLabel, traceLabel, args);
  };

  return {
    startTimer,
    endTimer,
    logTimer,
  };
}

module.exports = {
  kNone,
  kSkipLog,
  kSkipTrace,
  formatTime,
  time,
  timeEnd,
  timeLog,
  debuglog,
  debugWithTimer,
  initializeDebugEnv,
};

    },
    "internal/mime": function (exports, require, module, process, internalBinding, primordials) {
'use strict';

const {
  FunctionPrototypeCall,
  ObjectDefineProperty,
  RegExpPrototypeExec,
  SafeMap,
  SafeStringPrototypeSearch,
  StringPrototypeCharAt,
  StringPrototypeIndexOf,
  StringPrototypeSlice,
  StringPrototypeToLowerCase,
  SymbolIterator,
} = primordials;
const {
  ERR_INVALID_MIME_SYNTAX,
} = require('internal/errors').codes;

const NOT_HTTP_TOKEN_CODE_POINT = /[^!#$%&'*+\-.^_`|~A-Za-z0-9]/g;
const NOT_HTTP_QUOTED_STRING_CODE_POINT = /[^\t\u0020-~\u0080-\u00FF]/g;

const END_BEGINNING_WHITESPACE = /[^\r\n\t ]|$/;
const START_ENDING_WHITESPACE = /[\r\n\t ]*$/;

function toASCIILower(str) {
  // eslint-disable-next-line no-control-regex
  if (!/[^\x00-\x7f]/.test(str)) return StringPrototypeToLowerCase(str);
  let result = '';
  for (let i = 0; i < str.length; i++) {
    const char = str[i];

    result += char >= 'A' && char <= 'Z' ?
      StringPrototypeToLowerCase(char) :
      char;
  }
  return result;
}

const SOLIDUS = '/';
const SEMICOLON = ';';

function parseTypeAndSubtype(str) {
  // Skip only HTTP whitespace from start
  let position = SafeStringPrototypeSearch(str, END_BEGINNING_WHITESPACE);
  // read until '/'
  const typeEnd = StringPrototypeIndexOf(str, SOLIDUS, position);
  const trimmedType = typeEnd === -1 ?
    StringPrototypeSlice(str, position) :
    StringPrototypeSlice(str, position, typeEnd);
  const invalidTypeIndex = SafeStringPrototypeSearch(trimmedType,
                                                     NOT_HTTP_TOKEN_CODE_POINT);
  if (trimmedType === '' || invalidTypeIndex !== -1 || typeEnd === -1) {
    throw new ERR_INVALID_MIME_SYNTAX('type', str, invalidTypeIndex);
  }
  // skip type and '/'
  position = typeEnd + 1;
  const type = toASCIILower(trimmedType);
  // read until ';'
  const subtypeEnd = StringPrototypeIndexOf(str, SEMICOLON, position);
  const rawSubtype = subtypeEnd === -1 ?
    StringPrototypeSlice(str, position) :
    StringPrototypeSlice(str, position, subtypeEnd);
  position += rawSubtype.length;
  if (subtypeEnd !== -1) {
    // skip ';'
    position += 1;
  }
  const trimmedSubtype = StringPrototypeSlice(
    rawSubtype,
    0,
    SafeStringPrototypeSearch(rawSubtype, START_ENDING_WHITESPACE));
  const invalidSubtypeIndex = SafeStringPrototypeSearch(trimmedSubtype,
                                                        NOT_HTTP_TOKEN_CODE_POINT);
  if (trimmedSubtype === '' || invalidSubtypeIndex !== -1) {
    throw new ERR_INVALID_MIME_SYNTAX('subtype', str, invalidSubtypeIndex);
  }
  const subtype = toASCIILower(trimmedSubtype);
  return [
    type,
    subtype,
    position,
  ];
}

const EQUALS_SEMICOLON_OR_END = /[;=]|$/;
const QUOTED_VALUE_PATTERN = /^(?:([\\]$)|[\\][\s\S]|[^"])*(?:(")|$)/u;

function removeBackslashes(str) {
  let ret = '';
  // We stop at str.length - 1 because we want to look ahead one character.
  let i;
  for (i = 0; i < str.length - 1; i++) {
    const c = str[i];
    if (c === '\\') {
      i++;
      ret += str[i];
    } else {
      ret += c;
    }
  }
  // We add the last character if we didn't skip to it.
  if (i === str.length - 1) {
    ret += str[i];
  }
  return ret;
}


function escapeQuoteOrSolidus(str) {
  let result = '';
  for (let i = 0; i < str.length; i++) {
    const char = str[i];
    result += (char === '"' || char === '\\') ? `\\${char}` : char;
  }
  return result;
}

const encode = (value) => {
  if (value.length === 0) return '""';
  const encode = SafeStringPrototypeSearch(value, NOT_HTTP_TOKEN_CODE_POINT) !== -1;
  if (!encode) return value;
  const escaped = escapeQuoteOrSolidus(value);
  return `"${escaped}"`;
};

class MIMEParams {
  #data = new SafeMap();
  // We set the flag the MIMEParams instance as processed on initialization
  // to defer the parsing of a potentially large string.
  #processed = true;
  #string = null;

  /**
   * Used to instantiate a MIMEParams object within the MIMEType class and
   * to allow it to be parsed lazily.
   */
  static instantiateMimeParams(str) {
    const instance = new MIMEParams();
    instance.#string = str;
    instance.#processed = false;
    return instance;
  }

  delete(name) {
    this.#parse();
    this.#data.delete(name);
  }

  get(name) {
    this.#parse();
    const data = this.#data;
    if (data.has(name)) {
      return data.get(name);
    }
    return null;
  }

  has(name) {
    this.#parse();
    return this.#data.has(name);
  }

  set(name, value) {
    this.#parse();
    const data = this.#data;
    name = `${name}`;
    value = `${value}`;
    const invalidNameIndex = SafeStringPrototypeSearch(name, NOT_HTTP_TOKEN_CODE_POINT);
    if (name.length === 0 || invalidNameIndex !== -1) {
      throw new ERR_INVALID_MIME_SYNTAX(
        'parameter name',
        name,
        invalidNameIndex,
      );
    }
    const invalidValueIndex = SafeStringPrototypeSearch(
      value,
      NOT_HTTP_QUOTED_STRING_CODE_POINT);
    if (invalidValueIndex !== -1) {
      throw new ERR_INVALID_MIME_SYNTAX(
        'parameter value',
        value,
        invalidValueIndex,
      );
    }
    data.set(name, value);
  }

  *entries() {
    this.#parse();
    yield* this.#data.entries();
  }

  *keys() {
    this.#parse();
    yield* this.#data.keys();
  }

  *values() {
    this.#parse();
    yield* this.#data.values();
  }

  toString() {
    this.#parse();
    let ret = '';
    for (const { 0: key, 1: value } of this.#data) {
      const encoded = encode(value);
      // Ensure they are separated
      if (ret.length) ret += ';';
      ret += `${key}=${encoded}`;
    }
    return ret;
  }

  // Used to act as a friendly class to stringifying stuff
  // not meant to be exposed to users, could inject invalid values
  #parse() {
    if (this.#processed) return;  // already parsed
    const paramsMap = this.#data;
    let position = 0;
    const str = this.#string;
    const endOfSource = SafeStringPrototypeSearch(
      StringPrototypeSlice(str, position),
      START_ENDING_WHITESPACE,
    ) + position;
    while (position < endOfSource) {
      // Skip any whitespace before parameter
      position += SafeStringPrototypeSearch(
        StringPrototypeSlice(str, position),
        END_BEGINNING_WHITESPACE,
      );
      // Read until ';' or '='
      const afterParameterName = SafeStringPrototypeSearch(
        StringPrototypeSlice(str, position),
        EQUALS_SEMICOLON_OR_END,
      ) + position;
      const parameterString = toASCIILower(
        StringPrototypeSlice(str, position, afterParameterName),
      );
      position = afterParameterName;
      // If we found a terminating character
      if (position < endOfSource) {
        // Safe to use because we never do special actions for surrogate pairs
        const char = StringPrototypeCharAt(str, position);
        // Skip the terminating character
        position += 1;
        // Ignore parameters without values
        if (char === ';') {
          continue;
        }
      }
      // If we are at end of the string, it cannot have a value
      if (position >= endOfSource) break;
      // Safe to use because we never do special actions for surrogate pairs
      const char = StringPrototypeCharAt(str, position);
      let parameterValue = null;
      if (char === '"') {
        // Handle quoted-string form of values
        // skip '"'
        position += 1;
        // Find matching closing '"' or end of string
        //   use $1 to see if we terminated on unmatched '\'
        //   use $2 to see if we terminated on a matching '"'
        //   so we can skip the last char in either case
        const insideMatch = RegExpPrototypeExec(
          QUOTED_VALUE_PATTERN,
          StringPrototypeSlice(str, position));
        position += insideMatch[0].length;
        // Skip including last character if an unmatched '\' or '"' during
        // unescape
        const inside = insideMatch[1] || insideMatch[2] ?
          StringPrototypeSlice(insideMatch[0], 0, -1) :
          insideMatch[0];
        // Unescape '\' quoted characters
        parameterValue = removeBackslashes(inside);
        // If we did have an unmatched '\' add it back to the end
        if (insideMatch[1]) parameterValue += '\\';
      } else {
        // Handle the normal parameter value form
        const valueEnd = StringPrototypeIndexOf(str, SEMICOLON, position);
        const rawValue = valueEnd === -1 ?
          StringPrototypeSlice(str, position) :
          StringPrototypeSlice(str, position, valueEnd);
        position += rawValue.length;
        const trimmedValue = StringPrototypeSlice(
          rawValue,
          0,
          SafeStringPrototypeSearch(rawValue, START_ENDING_WHITESPACE),
        );
        // Ignore parameters without values
        if (trimmedValue === '') continue;
        parameterValue = trimmedValue;
      }
      if (
        parameterString !== '' &&
        SafeStringPrototypeSearch(parameterString,
                                  NOT_HTTP_TOKEN_CODE_POINT) === -1 &&
        SafeStringPrototypeSearch(parameterValue,
                                  NOT_HTTP_QUOTED_STRING_CODE_POINT) === -1 &&
        paramsMap.has(parameterString) === false
      ) {
        paramsMap.set(parameterString, parameterValue);
      }
      position++;
    }
    this.#data = paramsMap;
    this.#processed = true;
  }
}
const MIMEParamsStringify = MIMEParams.prototype.toString;
ObjectDefineProperty(MIMEParams.prototype, SymbolIterator, {
  __proto__: null,
  configurable: true,
  value: MIMEParams.prototype.entries,
  writable: true,
});
ObjectDefineProperty(MIMEParams.prototype, 'toJSON', {
  __proto__: null,
  configurable: true,
  value: MIMEParamsStringify,
  writable: true,
});

const { instantiateMimeParams } = MIMEParams;
delete MIMEParams.instantiateMimeParams;

class MIMEType {
  #type;
  #subtype;
  #parameters;
  constructor(string) {
    string = `${string}`;
    const data = parseTypeAndSubtype(string);
    this.#type = data[0];
    this.#subtype = data[1];
    this.#parameters = instantiateMimeParams(StringPrototypeSlice(string, data[2]));
  }

  get type() {
    return this.#type;
  }

  set type(v) {
    v = `${v}`;
    const invalidTypeIndex = SafeStringPrototypeSearch(v, NOT_HTTP_TOKEN_CODE_POINT);
    if (v.length === 0 || invalidTypeIndex !== -1) {
      throw new ERR_INVALID_MIME_SYNTAX('type', v, invalidTypeIndex);
    }
    this.#type = toASCIILower(v);
  }

  get subtype() {
    return this.#subtype;
  }

  set subtype(v) {
    v = `${v}`;
    const invalidSubtypeIndex = SafeStringPrototypeSearch(v, NOT_HTTP_TOKEN_CODE_POINT);
    if (v.length === 0 || invalidSubtypeIndex !== -1) {
      throw new ERR_INVALID_MIME_SYNTAX('subtype', v, invalidSubtypeIndex);
    }
    this.#subtype = toASCIILower(v);
  }

  get essence() {
    return `${this.#type}/${this.#subtype}`;
  }

  get params() {
    return this.#parameters;
  }

  toString() {
    let ret = `${this.#type}/${this.#subtype}`;
    const paramStr = FunctionPrototypeCall(MIMEParamsStringify, this.#parameters);
    if (paramStr.length) ret += `;${paramStr}`;
    return ret;
  }
}
ObjectDefineProperty(MIMEType.prototype, 'toJSON', {
  __proto__: null,
  configurable: true,
  value: MIMEType.prototype.toString,
  writable: true,
});

module.exports = {
  MIMEParams,
  MIMEType,
};

    },
    "internal/util/diff": function (exports, require, module, process, internalBinding, primordials) {
'use strict';

const {
  ArrayIsArray,
  ArrayPrototypeReverse,
} = primordials;

const { validateStringArray, validateString } = require('internal/validators');
const { myersDiff } = require('internal/assert/myers_diff');

function validateInput(value, name) {
  if (!ArrayIsArray(value)) {
    validateString(value, name);
    return;
  }

  validateStringArray(value, name);
}

/**
 * Generate a difference report between two values
 * @param {Array | string} actual - The first value to compare
 * @param {Array | string} expected - The second value to compare
 * @returns {Array} - An array of differences between the two values.
 * The returned data is an array of arrays, where each sub-array has two elements:
 * 1. The operation to perform: -1 for delete, 0 for no-op, 1 for insert
 * 2. The value to perform the operation on
 */
function diff(actual, expected) {
  if (actual === expected) {
    return [];
  }

  validateInput(actual, 'actual');
  validateInput(expected, 'expected');

  return ArrayPrototypeReverse(myersDiff(actual, expected));
}

module.exports = {
  diff,
};

    },
    "internal/util/parse_args/utils": function (exports, require, module, process, internalBinding, primordials) {
'use strict';

const {
  ArrayPrototypeFind,
  ObjectEntries,
  ObjectPrototypeHasOwnProperty: ObjectHasOwn,
  StringPrototypeCharAt,
  StringPrototypeIncludes,
  StringPrototypeStartsWith,
} = primordials;

const {
  validateObject,
} = require('internal/validators');

// These are internal utilities to make the parsing logic easier to read, and
// add lots of detail for the curious. They are in a separate file to allow
// unit testing, although that is not essential (this could be rolled into
// main file and just tested implicitly via API).
//
// These routines are for internal use, not for export to client.

/**
 * Return the named property, but only if it is an own property.
 */
function objectGetOwn(obj, prop) {
  if (ObjectHasOwn(obj, prop))
    return obj[prop];
}

/**
 * Return the named options property, but only if it is an own property.
 */
function optionsGetOwn(options, longOption, prop) {
  if (ObjectHasOwn(options, longOption))
    return objectGetOwn(options[longOption], prop);
}

/**
 * Determines if the argument may be used as an option value.
 * @example
 * isOptionValue('V') // returns true
 * isOptionValue('-v') // returns true (greedy)
 * isOptionValue('--foo') // returns true (greedy)
 * isOptionValue(undefined) // returns false
 */
function isOptionValue(value) {
  if (value == null) return false;

  // Open Group Utility Conventions are that an option-argument
  // is the argument after the option, and may start with a dash.
  return true; // greedy!
}

/**
 * Detect whether there is possible confusion and user may have omitted
 * the option argument, like `--port --verbose` when `port` of type:string.
 * In strict mode we throw errors if value is option-like.
 */
function isOptionLikeValue(value) {
  if (value == null) return false;

  return value.length > 1 && StringPrototypeCharAt(value, 0) === '-';
}

/**
 * Determines if `arg` is just a short option.
 * @example '-f'
 */
function isLoneShortOption(arg) {
  return arg.length === 2 &&
    StringPrototypeCharAt(arg, 0) === '-' &&
    StringPrototypeCharAt(arg, 1) !== '-';
}

/**
 * Determines if `arg` is a lone long option.
 * @example
 * isLoneLongOption('a') // returns false
 * isLoneLongOption('-a') // returns false
 * isLoneLongOption('--foo') // returns true
 * isLoneLongOption('--foo=bar') // returns false
 */
function isLoneLongOption(arg) {
  return arg.length > 2 &&
    StringPrototypeStartsWith(arg, '--') &&
    !StringPrototypeIncludes(arg, '=', 3);
}

/**
 * Determines if `arg` is a long option and value in the same argument.
 * @example
 * isLongOptionAndValue('--foo') // returns false
 * isLongOptionAndValue('--foo=bar') // returns true
 */
function isLongOptionAndValue(arg) {
  return arg.length > 2 &&
    StringPrototypeStartsWith(arg, '--') &&
    StringPrototypeIncludes(arg, '=', 3);
}

/**
 * Determines if `arg` is a short option group.
 *
 * See Guideline 5 of the [Open Group Utility Conventions](https://pubs.opengroup.org/onlinepubs/9699919799/basedefs/V1_chap12.html).
 *   One or more options without option-arguments, followed by at most one
 *   option that takes an option-argument, should be accepted when grouped
 *   behind one '-' delimiter.
 * @example
 * isShortOptionGroup('-a', {}) // returns false
 * isShortOptionGroup('-ab', {}) // returns true
 * // -fb is an option and a value, not a short option group
 * isShortOptionGroup('-fb', {
 *   options: { f: { type: 'string' } }
 * }) // returns false
 * isShortOptionGroup('-bf', {
 *   options: { f: { type: 'string' } }
 * }) // returns true
 * // -bfb is an edge case, return true and caller sorts it out
 * isShortOptionGroup('-bfb', {
 *   options: { f: { type: 'string' } }
 * }) // returns true
 */
function isShortOptionGroup(arg, options) {
  if (arg.length <= 2) return false;
  if (StringPrototypeCharAt(arg, 0) !== '-') return false;
  if (StringPrototypeCharAt(arg, 1) === '-') return false;

  const firstShort = StringPrototypeCharAt(arg, 1);
  const longOption = findLongOptionForShort(firstShort, options);
  return optionsGetOwn(options, longOption, 'type') !== 'string';
}

/**
 * Determine if arg is a short string option followed by its value.
 * @example
 * isShortOptionAndValue('-a', {}); // returns false
 * isShortOptionAndValue('-ab', {}); // returns false
 * isShortOptionAndValue('-fFILE', {
 *   options: { foo: { short: 'f', type: 'string' }}
 * }) // returns true
 */
function isShortOptionAndValue(arg, options) {
  validateObject(options, 'options');

  if (arg.length <= 2) return false;
  if (StringPrototypeCharAt(arg, 0) !== '-') return false;
  if (StringPrototypeCharAt(arg, 1) === '-') return false;

  const shortOption = StringPrototypeCharAt(arg, 1);
  const longOption = findLongOptionForShort(shortOption, options);
  return optionsGetOwn(options, longOption, 'type') === 'string';
}

/**
 * Find the long option associated with a short option. Looks for a configured
 * `short` and returns the short option itself if a long option is not found.
 * @example
 * findLongOptionForShort('a', {}) // returns 'a'
 * findLongOptionForShort('b', {
 *   options: { bar: { short: 'b' } }
 * }) // returns 'bar'
 */
function findLongOptionForShort(shortOption, options) {
  validateObject(options, 'options');
  const longOptionEntry = ArrayPrototypeFind(
    ObjectEntries(options),
    ({ 1: optionConfig }) => objectGetOwn(optionConfig, 'short') === shortOption,
  );
  return longOptionEntry?.[0] ?? shortOption;
}

/**
 * Check if the given option includes a default value
 * and that option has not been set by the input args.
 * @param {string} longOption - long option name e.g. 'foo'
 * @param {object} optionConfig - the option configuration properties
 * @param {object} values - option values returned in `values` by parseArgs
 */
function useDefaultValueOption(longOption, optionConfig, values) {
  return objectGetOwn(optionConfig, 'default') !== undefined &&
    values[longOption] === undefined;
}

module.exports = {
  findLongOptionForShort,
  isLoneLongOption,
  isLoneShortOption,
  isLongOptionAndValue,
  isOptionValue,
  isOptionLikeValue,
  isShortOptionAndValue,
  isShortOptionGroup,
  useDefaultValueOption,
  objectGetOwn,
  optionsGetOwn,
};

    },
    "internal/util/parse_args/parse_args": function (exports, require, module, process, internalBinding, primordials) {
'use strict';

const {
  ArrayPrototypeForEach,
  ArrayPrototypeMap,
  ArrayPrototypePush,
  ArrayPrototypePushApply,
  ArrayPrototypeShift,
  ArrayPrototypeSlice,
  ArrayPrototypeUnshiftApply,
  ObjectEntries,
  ObjectPrototypeHasOwnProperty: ObjectHasOwn,
  StringPrototypeCharAt,
  StringPrototypeIndexOf,
  StringPrototypeSlice,
  StringPrototypeStartsWith,
} = primordials;

const {
  validateArray,
  validateBoolean,
  validateBooleanArray,
  validateObject,
  validateString,
  validateStringArray,
  validateUnion,
} = require('internal/validators');

const {
  findLongOptionForShort,
  isLoneLongOption,
  isLoneShortOption,
  isLongOptionAndValue,
  isOptionValue,
  isOptionLikeValue,
  isShortOptionAndValue,
  isShortOptionGroup,
  useDefaultValueOption,
  objectGetOwn,
  optionsGetOwn,
} = require('internal/util/parse_args/utils');

const {
  codes: {
    ERR_INVALID_ARG_VALUE,
    ERR_PARSE_ARGS_INVALID_OPTION_VALUE,
    ERR_PARSE_ARGS_UNEXPECTED_POSITIONAL,
    ERR_PARSE_ARGS_UNKNOWN_OPTION,
  },
} = require('internal/errors');

const {
  kEmptyObject,
} = require('internal/util');

const { getOptionValue } = require('internal/options');

function getMainArgs() {
  // -p / --print internally sets --eval, so this works for all cases
  const evalValue = getOptionValue('--eval');

  if (evalValue.length !== 0) {
    return ArrayPrototypeSlice(process.argv, 1);
  }

  return ArrayPrototypeSlice(process.argv, 2);
}

/**
 * In strict mode, throw for possible usage errors like --foo --bar
 * @param {object} token - from tokens as available from parseArgs
 */
function checkOptionLikeValue(token) {
  if (!token.inlineValue && isOptionLikeValue(token.value)) {
    // Only show short example if user used short option.
    const example = StringPrototypeStartsWith(token.rawName, '--') ?
      `'${token.rawName}=-XYZ'` :
      `'--${token.name}=-XYZ' or '${token.rawName}-XYZ'`;
    const errorMessage = `Option '${token.rawName}' argument is ambiguous.
Did you forget to specify the option argument for '${token.rawName}'?
To specify an option argument starting with a dash use ${example}.`;
    throw new ERR_PARSE_ARGS_INVALID_OPTION_VALUE(errorMessage);
  }
}

/**
 * In strict mode, throw for usage errors.
 * @param {object} config - from config passed to parseArgs
 * @param {object} token - from tokens as available from parseArgs
 */
function checkOptionUsage(config, token) {
  let tokenName = token.name;
  if (!ObjectHasOwn(config.options, tokenName)) {
    // Check for negated boolean option.
    if (config.allowNegative && StringPrototypeStartsWith(tokenName, 'no-')) {
      tokenName = StringPrototypeSlice(tokenName, 3);
      if (!ObjectHasOwn(config.options, tokenName) || optionsGetOwn(config.options, tokenName, 'type') !== 'boolean') {
        throw new ERR_PARSE_ARGS_UNKNOWN_OPTION(
          token.rawName, config.allowPositionals);
      }
    } else {
      throw new ERR_PARSE_ARGS_UNKNOWN_OPTION(
        token.rawName, config.allowPositionals);
    }
  }

  const short = optionsGetOwn(config.options, tokenName, 'short');
  const shortAndLong = `${short ? `-${short}, ` : ''}--${tokenName}`;
  const type = optionsGetOwn(config.options, tokenName, 'type');
  if (type === 'string' && typeof token.value !== 'string') {
    throw new ERR_PARSE_ARGS_INVALID_OPTION_VALUE(`Option '${shortAndLong} <value>' argument missing`);
  }
  // (Idiomatic test for undefined||null, expecting undefined.)
  if (type === 'boolean' && token.value != null) {
    throw new ERR_PARSE_ARGS_INVALID_OPTION_VALUE(`Option '${shortAndLong}' does not take an argument`);
  }
}


/**
 * Store the option value in `values`.
 * @param {object} token - from tokens as available from parseArgs
 * @param {object} options - option configs, from parseArgs({ options })
 * @param {object} values - option values returned in `values` by parseArgs
 * @param {boolean} allowNegative - allow negative optinons if true
 */
function storeOption(token, options, values, allowNegative) {
  let longOption = token.name;
  let optionValue = token.value;
  if (longOption === '__proto__') {
    return; // No. Just no.
  }

  if (allowNegative && StringPrototypeStartsWith(longOption, 'no-') && optionValue === undefined) {
    // Boolean option negation: --no-foo
    longOption = StringPrototypeSlice(longOption, 3);
    token.name = longOption;
    optionValue = false;
  }

  // We store based on the option value rather than option type,
  // preserving the users intent for author to deal with.
  const newValue = optionValue ?? true;
  if (optionsGetOwn(options, longOption, 'multiple')) {
    // Always store value in array, including for boolean.
    // values[longOption] starts out not present,
    // first value is added as new array [newValue],
    // subsequent values are pushed to existing array.
    // (note: values has null prototype, so simpler usage)
    if (values[longOption]) {
      ArrayPrototypePush(values[longOption], newValue);
    } else {
      values[longOption] = [newValue];
    }
  } else {
    values[longOption] = newValue;
  }
}

/**
 * Store the default option value in `values`.
 * @param {string} longOption - long option name e.g. 'foo'
 * @param {string
 *         | boolean
 *         | string[]
 *         | boolean[]} optionValue - default value from option config
 * @param {object} values - option values returned in `values` by parseArgs
 */
function storeDefaultOption(longOption, optionValue, values) {
  if (longOption === '__proto__') {
    return; // No. Just no.
  }

  values[longOption] = optionValue;
}

/**
 * Process args and turn into identified tokens:
 * - option (along with value, if any)
 * - positional
 * - option-terminator
 * @param {string[]} args - from parseArgs({ args }) or mainArgs
 * @param {object} options - option configs, from parseArgs({ options })
 */
function argsToTokens(args, options) {
  const tokens = [];
  let index = -1;
  let groupCount = 0;

  const remainingArgs = ArrayPrototypeSlice(args);
  while (remainingArgs.length > 0) {
    const arg = ArrayPrototypeShift(remainingArgs);
    const nextArg = remainingArgs[0];
    if (groupCount > 0)
      groupCount--;
    else
      index++;

    // Check if `arg` is an options terminator.
    // Guideline 10 in https://pubs.opengroup.org/onlinepubs/9699919799/basedefs/V1_chap12.html
    if (arg === '--') {
      // Everything after a bare '--' is considered a positional argument.
      ArrayPrototypePush(tokens, { kind: 'option-terminator', index });
      ArrayPrototypePushApply(
        tokens, ArrayPrototypeMap(remainingArgs, (arg) => {
          return { kind: 'positional', index: ++index, value: arg };
        }),
      );
      break; // Finished processing args, leave while loop.
    }

    if (isLoneShortOption(arg)) {
      // e.g. '-f'
      const shortOption = StringPrototypeCharAt(arg, 1);
      const longOption = findLongOptionForShort(shortOption, options);
      let value;
      let inlineValue;
      if (optionsGetOwn(options, longOption, 'type') === 'string' &&
          isOptionValue(nextArg)) {
        // e.g. '-f', 'bar'
        value = ArrayPrototypeShift(remainingArgs);
        inlineValue = false;
      }
      ArrayPrototypePush(
        tokens,
        { kind: 'option', name: longOption, rawName: arg,
          index, value, inlineValue });
      if (value != null) ++index;
      continue;
    }

    if (isShortOptionGroup(arg, options)) {
      // Expand -fXzy to -f -X -z -y
      const expanded = [];
      for (let index = 1; index < arg.length; index++) {
        const shortOption = StringPrototypeCharAt(arg, index);
        const longOption = findLongOptionForShort(shortOption, options);
        if (optionsGetOwn(options, longOption, 'type') !== 'string' ||
          index === arg.length - 1) {
          // Boolean option, or last short in group. Well formed.
          ArrayPrototypePush(expanded, `-${shortOption}`);
        } else {
          // String option in middle. Yuck.
          // Expand -abfFILE to -a -b -fFILE
          ArrayPrototypePush(expanded, `-${StringPrototypeSlice(arg, index)}`);
          break; // finished short group
        }
      }
      ArrayPrototypeUnshiftApply(remainingArgs, expanded);
      groupCount = expanded.length;
      continue;
    }

    if (isShortOptionAndValue(arg, options)) {
      // e.g. -fFILE
      const shortOption = StringPrototypeCharAt(arg, 1);
      const longOption = findLongOptionForShort(shortOption, options);
      const value = StringPrototypeSlice(arg, 2);
      ArrayPrototypePush(
        tokens,
        { kind: 'option', name: longOption, rawName: `-${shortOption}`,
          index, value, inlineValue: true });
      continue;
    }

    if (isLoneLongOption(arg)) {
      // e.g. '--foo'
      const longOption = StringPrototypeSlice(arg, 2);
      let value;
      let inlineValue;
      if (optionsGetOwn(options, longOption, 'type') === 'string' &&
          isOptionValue(nextArg)) {
        // e.g. '--foo', 'bar'
        value = ArrayPrototypeShift(remainingArgs);
        inlineValue = false;
      }
      ArrayPrototypePush(
        tokens,
        { kind: 'option', name: longOption, rawName: arg,
          index, value, inlineValue });
      if (value != null) ++index;
      continue;
    }

    if (isLongOptionAndValue(arg)) {
      // e.g. --foo=bar
      const equalIndex = StringPrototypeIndexOf(arg, '=');
      const longOption = StringPrototypeSlice(arg, 2, equalIndex);
      const value = StringPrototypeSlice(arg, equalIndex + 1);
      ArrayPrototypePush(
        tokens,
        { kind: 'option', name: longOption, rawName: `--${longOption}`,
          index, value, inlineValue: true });
      continue;
    }

    ArrayPrototypePush(tokens, { kind: 'positional', index, value: arg });
  }
  return tokens;
}

const parseArgs = (config = kEmptyObject) => {
  const args = objectGetOwn(config, 'args') ?? getMainArgs();
  const strict = objectGetOwn(config, 'strict') ?? true;
  const allowPositionals = objectGetOwn(config, 'allowPositionals') ?? !strict;
  const returnTokens = objectGetOwn(config, 'tokens') ?? false;
  const allowNegative = objectGetOwn(config, 'allowNegative') ?? false;
  const options = objectGetOwn(config, 'options') ?? { __proto__: null };
  // Bundle these up for passing to strict-mode checks.
  const parseConfig = { args, strict, options, allowPositionals, allowNegative };

  // Validate input configuration.
  validateArray(args, 'args');
  validateBoolean(strict, 'strict');
  validateBoolean(allowPositionals, 'allowPositionals');
  validateBoolean(returnTokens, 'tokens');
  validateBoolean(allowNegative, 'allowNegative');
  validateObject(options, 'options');
  ArrayPrototypeForEach(
    ObjectEntries(options),
    ({ 0: longOption, 1: optionConfig }) => {
      validateObject(optionConfig, `options.${longOption}`);

      // type is required
      const optionType = objectGetOwn(optionConfig, 'type');
      validateUnion(optionType, `options.${longOption}.type`, ['string', 'boolean']);

      if (ObjectHasOwn(optionConfig, 'short')) {
        const shortOption = optionConfig.short;
        validateString(shortOption, `options.${longOption}.short`);
        if (shortOption.length !== 1) {
          throw new ERR_INVALID_ARG_VALUE(
            `options.${longOption}.short`,
            shortOption,
            'must be a single character',
          );
        }
      }

      const multipleOption = objectGetOwn(optionConfig, 'multiple');
      if (ObjectHasOwn(optionConfig, 'multiple')) {
        validateBoolean(multipleOption, `options.${longOption}.multiple`);
      }

      const defaultValue = objectGetOwn(optionConfig, 'default');
      if (defaultValue !== undefined) {
        let validator;
        switch (optionType) {
          case 'string':
            validator = multipleOption ? validateStringArray : validateString;
            break;

          case 'boolean':
            validator = multipleOption ? validateBooleanArray : validateBoolean;
            break;
        }
        validator(defaultValue, `options.${longOption}.default`);
      }
    },
  );

  // Phase 1: identify tokens
  const tokens = argsToTokens(args, options);

  // Phase 2: process tokens into parsed option values and positionals
  const result = {
    values: { __proto__: null },
    positionals: [],
  };
  if (returnTokens) {
    result.tokens = tokens;
  }
  ArrayPrototypeForEach(tokens, (token) => {
    if (token.kind === 'option') {
      if (strict) {
        checkOptionUsage(parseConfig, token);
        checkOptionLikeValue(token);
      }
      storeOption(token, options, result.values, parseConfig.allowNegative);
    } else if (token.kind === 'positional') {
      if (!allowPositionals) {
        throw new ERR_PARSE_ARGS_UNEXPECTED_POSITIONAL(token.value);
      }
      ArrayPrototypePush(result.positionals, token.value);
    }
  });

  // Phase 3: fill in default values for missing args
  ArrayPrototypeForEach(ObjectEntries(options), ({ 0: longOption,
                                                   1: optionConfig }) => {
    const mustSetDefault = useDefaultValueOption(longOption,
                                                 optionConfig,
                                                 result.values);
    if (mustSetDefault) {
      storeDefaultOption(longOption,
                         objectGetOwn(optionConfig, 'default'),
                         result.values);
    }
  });


  return result;
};

module.exports = {
  parseArgs,
};

    },
    "internal/util/trace_sigint": function (exports, require, module, process, internalBinding, primordials) {
'use strict';

const { isMainThread } = require('worker_threads');
const {
  ERR_WORKER_UNSUPPORTED_OPERATION,
} = require('internal/errors').codes;

let sigintWatchdog;
function getSigintWatchdog() {
  if (!sigintWatchdog) {
    const { SigintWatchdog } = require('internal/watchdog');
    sigintWatchdog = new SigintWatchdog();
  }
  return sigintWatchdog;
}

function setTraceSigInt(enable) {
  if (!isMainThread)
    throw new ERR_WORKER_UNSUPPORTED_OPERATION('Calling util.setTraceSigInt');
  if (enable) {
    getSigintWatchdog().start();
  } else {
    getSigintWatchdog().stop();
  }
};

module.exports = {
  setTraceSigInt,
};

    },
    "internal/process/per_thread": function (exports, require, module, process, internalBinding, primordials) {
'use strict';

// This files contains process bootstrappers that can be
// run when setting up each thread, including the main
// thread and the worker threads.

const {
  ArrayPrototypeEvery,
  ArrayPrototypeForEach,
  ArrayPrototypeIncludes,
  ArrayPrototypeMap,
  ArrayPrototypePush,
  ArrayPrototypeSplice,
  BigUint64Array,
  Float64Array,
  FunctionPrototypeCall,
  NumberMAX_SAFE_INTEGER,
  ObjectDefineProperty,
  ObjectEntries,
  ObjectFreeze,
  ReflectApply,
  RegExpPrototypeExec,
  SafeArrayIterator,
  Set,
  SetPrototypeEntries,
  SetPrototypeValues,
  StringPrototypeEndsWith,
  StringPrototypeIncludes,
  StringPrototypeReplace,
  StringPrototypeSlice,
  Symbol,
  SymbolFor,
  SymbolIterator,
} = primordials;

const {
  ErrnoException,
  codes: {
    ERR_ASSERTION,
    ERR_FEATURE_UNAVAILABLE_ON_PLATFORM,
    ERR_INVALID_ARG_TYPE,
    ERR_INVALID_ARG_VALUE,
    ERR_OPERATION_FAILED,
    ERR_OUT_OF_RANGE,
    ERR_UNKNOWN_SIGNAL,
    ERR_WORKER_UNSUPPORTED_OPERATION,
  },
} = require('internal/errors');
const { emitExperimentalWarning } = require('internal/util');
const format = require('internal/util/inspect').format;
const {
  validateArray,
  validateNumber,
  validateObject,
  validateString,
} = require('internal/validators');

const dc = require('diagnostics_channel');
const execveDiagnosticChannel = dc.channel('process.execve');

const constants = internalBinding('constants').os.signals;

let getValidatedPath; // We need to lazy load it because of the circular dependency.

const kInternal = Symbol('internal properties');

function assert(x, msg) {
  if (!x) throw new ERR_ASSERTION(msg || 'assertion error');
}
const { exitCodes: { kNoFailure } } = internalBinding('errors');

const binding = internalBinding('process_methods');

// The 3 entries filled in by the original process.hrtime contains
// the upper/lower 32 bits of the second part of the value,
// and the remaining nanoseconds of the value.
const hrValues = binding.hrtimeBuffer;
// Use a BigUint64Array because this is actually a bit
// faster than simply returning a BigInt from C++ in V8 7.1.
const hrBigintValues = new BigUint64Array(binding.hrtimeBuffer.buffer, 0, 1);

function hrtime(time) {
  binding.hrtime();

  if (time !== undefined) {
    validateArray(time, 'time');
    if (time.length !== 2) {
      throw new ERR_OUT_OF_RANGE('time', 2, time.length);
    }

    const sec = (hrValues[0] * 0x100000000 + hrValues[1]) - time[0];
    const nsec = hrValues[2] - time[1];
    const needsBorrow = nsec < 0;
    return [needsBorrow ? sec - 1 : sec, needsBorrow ? nsec + 1e9 : nsec];
  }

  return [
    hrValues[0] * 0x100000000 + hrValues[1],
    hrValues[2],
  ];
}

function hrtimeBigInt() {
  binding.hrtimeBigInt();
  return hrBigintValues[0];
}

function nop() {}

// The execution of this function itself should not cause any side effects.
function wrapProcessMethods(binding) {
  const {
    cpuUsage: _cpuUsage,
    threadCpuUsage: _threadCpuUsage,
    memoryUsage: _memoryUsage,
    rss,
    resourceUsage: _resourceUsage,
    loadEnvFile: _loadEnvFile,
    execve: _execve,
  } = binding;

  function _rawDebug(...args) {
    binding._rawDebug(ReflectApply(format, null, args));
  }

  // Create the argument array that will be passed to the native function.
  const cpuValues = new Float64Array(2);

  // Replace the native function with the JS version that calls the native
  // function.
  function cpuUsage(prevValue) {
    // If a previous value was passed in, ensure it has the correct shape.
    if (prevValue) {
      if (!previousValueIsValid(prevValue.user)) {
        validateObject(prevValue, 'prevValue');

        validateNumber(prevValue.user, 'prevValue.user');
        throw new ERR_INVALID_ARG_VALUE.RangeError('prevValue.user',
                                                   prevValue.user);
      }

      if (!previousValueIsValid(prevValue.system)) {
        validateNumber(prevValue.system, 'prevValue.system');
        throw new ERR_INVALID_ARG_VALUE.RangeError('prevValue.system',
                                                   prevValue.system);
      }
    }

    // Call the native function to get the current values.
    _cpuUsage(cpuValues);

    // If a previous value was passed in, return diff of current from previous.
    if (prevValue) {
      return {
        user: cpuValues[0] - prevValue.user,
        system: cpuValues[1] - prevValue.system,
      };
    }

    // If no previous value passed in, return current value.
    return {
      user: cpuValues[0],
      system: cpuValues[1],
    };
  }

  const threadCpuValues = new Float64Array(2);

  // Replace the native function with the JS version that calls the native
  // function.
  function threadCpuUsage(prevValue) {
    // If a previous value was passed in, ensure it has the correct shape.
    if (prevValue) {
      if (!previousValueIsValid(prevValue.user)) {
        validateObject(prevValue, 'prevValue');

        validateNumber(prevValue.user, 'prevValue.user');
        throw new ERR_INVALID_ARG_VALUE.RangeError('prevValue.user',
                                                   prevValue.user);
      }

      if (!previousValueIsValid(prevValue.system)) {
        validateNumber(prevValue.system, 'prevValue.system');
        throw new ERR_INVALID_ARG_VALUE.RangeError('prevValue.system',
                                                   prevValue.system);
      }
    }

    if (process.platform === 'sunos') {
      throw new ERR_OPERATION_FAILED('threadCpuUsage is not available on SunOS');
    }

    // Call the native function to get the current values.
    _threadCpuUsage(threadCpuValues);

    // If a previous value was passed in, return diff of current from previous.
    if (prevValue) {
      return {
        user: threadCpuValues[0] - prevValue.user,
        system: threadCpuValues[1] - prevValue.system,
      };
    }

    // If no previous value passed in, return current value.
    return {
      user: threadCpuValues[0],
      system: threadCpuValues[1],
    };
  }

  // Ensure that a previously passed in value is valid. Currently, the native
  // implementation always returns numbers <= Number.MAX_SAFE_INTEGER.
  function previousValueIsValid(num) {
    return typeof num === 'number' &&
        num <= NumberMAX_SAFE_INTEGER &&
        num >= 0;
  }

  const memValues = new Float64Array(5);
  function memoryUsage() {
    _memoryUsage(memValues);
    return {
      rss: memValues[0],
      heapTotal: memValues[1],
      heapUsed: memValues[2],
      external: memValues[3],
      arrayBuffers: memValues[4],
    };
  }

  memoryUsage.rss = rss;

  function exit(code) {
    if (arguments.length !== 0) {
      process.exitCode = code;
    }

    if (!process._exiting) {
      process._exiting = true;
      process.emit('exit', process.exitCode || kNoFailure);
    }
    // FIXME(joyeecheung): This is an undocumented API that gets monkey-patched
    // in the user land. Either document it, or deprecate it in favor of a
    // better public alternative.
    process.reallyExit(process.exitCode || kNoFailure);

    // If this is a worker, v8::Isolate::TerminateExecution() is called above.
    // That function spoofs the stack pointer to cause the stack guard
    // check to throw the termination exception. Because v8 performs
    // stack guard check upon every function call, we give it a chance.
    //
    // Without this, user code after `process.exit()` would take effect.
    // test/parallel/test-worker-voluntarily-exit-followed-by-addition.js
    // test/parallel/test-worker-voluntarily-exit-followed-by-throw.js
    nop();
  }

  function kill(pid, sig) {
    let err;

    // eslint-disable-next-line eqeqeq
    if (pid != (pid | 0)) {
      throw new ERR_INVALID_ARG_TYPE('pid', 'number', pid);
    }

    // Preserve null signal
    if (sig === (sig | 0)) {
      // XXX(joyeecheung): we have to use process._kill here because
      // it's monkey-patched by tests.
      err = process._kill(pid, sig);
    } else {
      sig ||= 'SIGTERM';
      if (constants[sig]) {
        err = process._kill(pid, constants[sig]);
      } else {
        throw new ERR_UNKNOWN_SIGNAL(sig);
      }
    }

    if (err)
      throw new ErrnoException(err, 'kill');

    return true;
  }

  function execve(execPath, args = [], env = process.env) {
    emitExperimentalWarning('process.execve');

    const { isMainThread } = require('internal/worker');

    if (!isMainThread) {
      throw new ERR_WORKER_UNSUPPORTED_OPERATION('Calling process.execve');
    } else if (process.platform === 'win32' || process.platform === 'os400') {
      throw new ERR_FEATURE_UNAVAILABLE_ON_PLATFORM('process.execve');
    }

    validateString(execPath, 'execPath');
    validateArray(args, 'args');

    for (let i = 0; i < args.length; i++) {
      const arg = args[i];
      if (typeof arg !== 'string' || StringPrototypeIncludes(arg, '\u0000')) {
        throw new ERR_INVALID_ARG_VALUE(`args[${i}]`, arg, 'must be a string without null bytes');
      }
    }

    const envArray = [];
    validateObject(env, 'env');

    for (const { 0: key, 1: value } of ObjectEntries(env)) {
      if (
        typeof key !== 'string' ||
        typeof value !== 'string' ||
        StringPrototypeIncludes(key, '\u0000') ||
        StringPrototypeIncludes(value, '\u0000')
      ) {
        throw new ERR_INVALID_ARG_VALUE(
          'env', env, 'must be an object with string keys and values without null bytes',
        );
      } else {
        ArrayPrototypePush(envArray, `${key}=${value}`);
      }
    }

    if (execveDiagnosticChannel.hasSubscribers) {
      execveDiagnosticChannel.publish({ execPath, args, env: envArray });
    }

    // Perform the system call
    _execve(execPath, args, envArray);
  }

  const resourceValues = new Float64Array(16);
  function resourceUsage() {
    _resourceUsage(resourceValues);
    return {
      userCPUTime: resourceValues[0],
      systemCPUTime: resourceValues[1],
      maxRSS: resourceValues[2],
      sharedMemorySize: resourceValues[3],
      unsharedDataSize: resourceValues[4],
      unsharedStackSize: resourceValues[5],
      minorPageFault: resourceValues[6],
      majorPageFault: resourceValues[7],
      swappedOut: resourceValues[8],
      fsRead: resourceValues[9],
      fsWrite: resourceValues[10],
      ipcSent: resourceValues[11],
      ipcReceived: resourceValues[12],
      signalsCount: resourceValues[13],
      voluntaryContextSwitches: resourceValues[14],
      involuntaryContextSwitches: resourceValues[15],
    };
  }

  /**
   * Loads the `.env` file to process.env.
   * @param {string | URL | Buffer | undefined} path
   */
  function loadEnvFile(path = undefined) { // Provide optional value so that `loadEnvFile.length` returns 0
    if (path != null) {
      getValidatedPath ??= require('internal/fs/utils').getValidatedPath;
      path = getValidatedPath(path);
      _loadEnvFile(path);
    } else {
      _loadEnvFile();
    }
  }

  return {
    _rawDebug,
    cpuUsage,
    threadCpuUsage,
    resourceUsage,
    memoryUsage,
    kill,
    exit,
    execve,
    loadEnvFile,
  };
}

const replaceUnderscoresRegex = /_/g;
const leadingDashesRegex = /^--?/;
const trailingValuesRegex = /=.*$/;

// This builds the initial process.allowedNodeEnvironmentFlags
// from data in the config binding.
function buildAllowedFlags() {
  const {
    envSettings: { kAllowedInEnvvar },
    types: { kBoolean },
  } = internalBinding('options');
  const { getCLIOptionsInfo } = require('internal/options');
  const { options, aliases } = getCLIOptionsInfo();

  const allowedNodeEnvironmentFlags = [];
  for (const { 0: name, 1: info } of options) {
    if (info.envVarSettings === kAllowedInEnvvar) {
      ArrayPrototypePush(allowedNodeEnvironmentFlags, name);
      if (info.type === kBoolean) {
        const negatedName = `--no-${name.slice(2)}`;
        ArrayPrototypePush(allowedNodeEnvironmentFlags, negatedName);
      }
    }
  }

  function isAccepted(to) {
    if (!to.length || to[0] !== '-' || to === '--') return true;
    const recursiveExpansion = aliases.get(to);
    if (recursiveExpansion) {
      if (recursiveExpansion[0] === to)
        ArrayPrototypeSplice(recursiveExpansion, 0, 1);
      return ArrayPrototypeEvery(recursiveExpansion, isAccepted);
    }
    return options.get(to).envVarSettings === kAllowedInEnvvar;
  }
  for (const { 0: from, 1: expansion } of aliases) {
    if (ArrayPrototypeEvery(expansion, isAccepted)) {
      let canonical = from;
      if (StringPrototypeEndsWith(canonical, '='))
        canonical = StringPrototypeSlice(canonical, 0, canonical.length - 1);
      if (StringPrototypeEndsWith(canonical, ' <arg>'))
        canonical = StringPrototypeSlice(canonical, 0, canonical.length - 4);
      ArrayPrototypePush(allowedNodeEnvironmentFlags, canonical);
    }
  }

  const trimLeadingDashes =
    (flag) => StringPrototypeReplace(flag, leadingDashesRegex, '');

  // Save these for comparison against flags provided to
  // process.allowedNodeEnvironmentFlags.has() which lack leading dashes.
  const nodeFlags = ArrayPrototypeMap(allowedNodeEnvironmentFlags,
                                      trimLeadingDashes);

  class NodeEnvironmentFlagsSet extends Set {
    constructor(array) {
      super();
      this[kInternal] = { array };
    }

    add() {
      // No-op, `Set` API compatible
      return this;
    }

    delete() {
      // No-op, `Set` API compatible
      return false;
    }

    clear() {
      // No-op, `Set` API compatible
    }

    has(key) {
      // This will return `true` based on various possible
      // permutations of a flag, including present/missing leading
      // dash(es) and/or underscores-for-dashes.
      // Strips any values after `=`, inclusive.
      // TODO(addaleax): It might be more flexible to run the option parser
      // on a dummy option set and see whether it rejects the argument or
      // not.
      if (typeof key === 'string') {
        key = StringPrototypeReplace(key, replaceUnderscoresRegex, '-');
        if (RegExpPrototypeExec(leadingDashesRegex, key) !== null) {
          key = StringPrototypeReplace(key, trailingValuesRegex, '');
          return ArrayPrototypeIncludes(this[kInternal].array, key);
        }
        return ArrayPrototypeIncludes(nodeFlags, key);
      }
      return false;
    }

    entries() {
      this[kInternal].set ??=
        new Set(new SafeArrayIterator(this[kInternal].array));
      return SetPrototypeEntries(this[kInternal].set);
    }

    forEach(callback, thisArg = undefined) {
      ArrayPrototypeForEach(
        this[kInternal].array,
        (v) => ReflectApply(callback, thisArg, [v, v, this]),
      );
    }

    get size() {
      return this[kInternal].array.length;
    }

    values() {
      this[kInternal].set ??=
        new Set(new SafeArrayIterator(this[kInternal].array));
      return SetPrototypeValues(this[kInternal].set);
    }
  }
  const flagSetValues = NodeEnvironmentFlagsSet.prototype.values;
  ObjectDefineProperty(NodeEnvironmentFlagsSet.prototype, SymbolIterator, {
    __proto__: null,
    value: flagSetValues,
  });
  ObjectDefineProperty(NodeEnvironmentFlagsSet.prototype, 'keys', {
    __proto__: null,
    value: flagSetValues,
  });

  ObjectFreeze(NodeEnvironmentFlagsSet.prototype.constructor);
  ObjectFreeze(NodeEnvironmentFlagsSet.prototype);

  return ObjectFreeze(new NodeEnvironmentFlagsSet(
    allowedNodeEnvironmentFlags,
  ));
}

// Lazy load internal/trace_events_async_hooks only if the async_hooks
// trace event category is enabled.
let traceEventsAsyncHook;
// Dynamically enable/disable the traceEventsAsyncHook
function toggleTraceCategoryState(asyncHooksEnabled) {
  if (asyncHooksEnabled) {
    traceEventsAsyncHook ||= require('internal/trace_events_async_hooks').createHook();
    traceEventsAsyncHook.enable();
  } else if (traceEventsAsyncHook) {
    traceEventsAsyncHook.disable();
  }
}

const { arch, platform, version } = process;

let refSymbol;
function ref(maybeRefable) {
  if (maybeRefable == null) return;
  const fn = maybeRefable[refSymbol ??= SymbolFor('nodejs.ref')] || maybeRefable.ref;
  if (typeof fn === 'function') FunctionPrototypeCall(fn, maybeRefable);
}

let unrefSymbol;
function unref(maybeRefable) {
  if (maybeRefable == null) return;
  const fn = maybeRefable[unrefSymbol ??= SymbolFor('nodejs.unref')] || maybeRefable.unref;
  if (typeof fn === 'function') FunctionPrototypeCall(fn, maybeRefable);
}

module.exports = {
  toggleTraceCategoryState,
  assert,
  buildAllowedFlags,
  wrapProcessMethods,
  hrtime,
  hrtimeBigInt,
  arch,
  platform,
  version,
  ref,
  unref,
};

    },
    "util": function (exports, require, module, process, internalBinding, primordials) {
// Copyright Joyent, Inc. and other Node contributors.
//
// Permission is hereby granted, free of charge, to any person obtaining a
// copy of this software and associated documentation files (the
// "Software"), to deal in the Software without restriction, including
// without limitation the rights to use, copy, modify, merge, publish,
// distribute, sublicense, and/or sell copies of the Software, and to permit
// persons to whom the Software is furnished to do so, subject to the
// following conditions:
//
// The above copyright notice and this permission notice shall be included
// in all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS
// OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
// MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN
// NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
// DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
// OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE
// USE OR OTHER DEALINGS IN THE SOFTWARE.

'use strict';

const {
  ArrayIsArray,
  ArrayPrototypeJoin,
  ArrayPrototypePop,
  ArrayPrototypePush,
  ArrayPrototypeReduce,
  Date,
  DatePrototypeGetDate,
  DatePrototypeGetHours,
  DatePrototypeGetMinutes,
  DatePrototypeGetMonth,
  DatePrototypeGetSeconds,
  Error,
  ErrorCaptureStackTrace,
  FunctionPrototypeBind,
  NumberIsSafeInteger,
  ObjectDefineProperties,
  ObjectDefineProperty,
  ObjectGetOwnPropertyDescriptors,
  ObjectKeys,
  ObjectPrototypeToString,
  ObjectSetPrototypeOf,
  ObjectValues,
  ReflectApply,
  RegExp,
  RegExpPrototypeSymbolReplace,
  StringPrototypePadStart,
  StringPrototypeToWellFormed,
} = primordials;

const {
  ErrnoException,
  ExceptionWithHostPort,
  codes: {
    ERR_FALSY_VALUE_REJECTION,
    ERR_INVALID_ARG_TYPE,
    ERR_OUT_OF_RANGE,
  },
  isErrorStackTraceLimitWritable,
} = require('internal/errors');
const {
  format,
  formatWithOptions,
  inspect,
  stripVTControlCharacters,
} = require('internal/util/inspect');
const { debuglog } = require('internal/util/debuglog');
const {
  validateBoolean,
  validateFunction,
  validateNumber,
  validateString,
  validateOneOf,
  validateObject,
} = require('internal/validators');
const { isBuffer } = require('buffer').Buffer;
const {
  isReadableStream,
  isWritableStream,
  isNodeStream,
} = require('internal/streams/utils');
const types = require('internal/util/types');

let utilColors;
function lazyUtilColors() {
  utilColors ??= require('internal/util/colors');
  return utilColors;
}
const { getOptionValue } = require('internal/options');

const binding = internalBinding('util');

const {
  deprecate,
  getLazy,
  getSystemErrorMap,
  getSystemErrorName: internalErrorName,
  getSystemErrorMessage: internalErrorMessage,
  promisify,
  defineLazyProperties,
} = require('internal/util');

let abortController;

function lazyAbortController() {
  abortController ??= require('internal/abort_controller');
  return abortController;
}

let internalDeepEqual;

/**
 * @deprecated since v4.0.0
 * @param {any} arg
 * @returns {arg is boolean}
 */
function isBoolean(arg) {
  return typeof arg === 'boolean';
}

/**
 * @deprecated since v4.0.0
 * @param {any} arg
 * @returns {arg is null}
 */
function isNull(arg) {
  return arg === null;
}

/**
 * @deprecated since v4.0.0
 * @param {any} arg
 * @returns {arg is (null | undefined)}
 */
function isNullOrUndefined(arg) {
  return arg === null || arg === undefined;
}

/**
 * @deprecated since v4.0.0
 * @param {any} arg
 * @returns {arg is number}
 */
function isNumber(arg) {
  return typeof arg === 'number';
}

/**
 * @param {any} arg
 * @returns {arg is string}
 */
function isString(arg) {
  return typeof arg === 'string';
}

/**
 * @deprecated since v4.0.0
 * @param {any} arg
 * @returns {arg is symbol}
 */
function isSymbol(arg) {
  return typeof arg === 'symbol';
}

/**
 * @deprecated since v4.0.0
 * @param {any} arg
 * @returns {arg is undefined}
 */
function isUndefined(arg) {
  return arg === undefined;
}

/**
 * @deprecated since v4.0.0
 * @param {any} arg
 * @returns {a is NonNullable<object>}
 */
function isObject(arg) {
  return arg !== null && typeof arg === 'object';
}

/**
 * @deprecated since v4.0.0
 * @param {any} e
 * @returns {arg is Error}
 */
function isError(e) {
  return ObjectPrototypeToString(e) === '[object Error]' || e instanceof Error;
}

/**
 * @deprecated since v4.0.0
 * @param {any} arg
 * @returns {arg is Function}
 */
function isFunction(arg) {
  return typeof arg === 'function';
}

/**
 * @deprecated since v4.0.0
 * @param {any} arg
 * @returns {arg is (boolean | null | number | string | symbol | undefined)}
 */
function isPrimitive(arg) {
  return arg === null ||
         (typeof arg !== 'object' && typeof arg !== 'function');
}

/**
 * @param {number} n
 * @returns {string}
 */
function pad(n) {
  return StringPrototypePadStart(n.toString(), 2, '0');
}

/**
 * @param {string} [code]
 * @returns {string}
 */
function escapeStyleCode(code) {
  if (code === undefined) return '';
  return `\u001b[${code}m`;
}

/**
 * @param {string | string[]} format
 * @param {string} text
 * @param {object} [options={}]
 * @param {boolean} [options.validateStream=true] - Whether to validate the stream.
 * @param {Stream} [options.stream=process.stdout] - The stream used for validation.
 * @returns {string}
 */
function styleText(format, text, { validateStream = true, stream = process.stdout } = {}) {
  validateString(text, 'text');
  validateBoolean(validateStream, 'options.validateStream');

  let skipColorize;
  if (validateStream) {
    if (
      !isReadableStream(stream) &&
      !isWritableStream(stream) &&
      !isNodeStream(stream)
    ) {
      throw new ERR_INVALID_ARG_TYPE('stream', ['ReadableStream', 'WritableStream', 'Stream'], stream);
    }

    // If the stream is falsy or should not be colorized, set skipColorize to true
    skipColorize = !lazyUtilColors().shouldColorize(stream);
  }

  // If the format is not an array, convert it to an array
  const formatArray = ArrayIsArray(format) ? format : [format];

  const codes = [];
  for (const key of formatArray) {
    if (key === 'none') continue;
    const formatCodes = inspect.colors[key];
    // If the format is not a valid style, throw an error
    if (formatCodes == null) {
      validateOneOf(key, 'format', ObjectKeys(inspect.colors));
    }
    if (skipColorize) continue;
    ArrayPrototypePush(codes, formatCodes);
  }

  if (skipColorize) {
    return text;
  }

  // Build opening codes
  let openCodes = '';
  for (let i = 0; i < codes.length; i++) {
    openCodes += escapeStyleCode(codes[i][0]);
  }

  // Process the text to handle nested styles
  let processedText;
  if (codes.length > 0) {
    processedText = ArrayPrototypeReduce(
      codes,
      (text, code) => RegExpPrototypeSymbolReplace(
        // Find the reset code
        new RegExp(`\\u001b\\[${code[1]}m`, 'g'),
        text,
        (match, offset) => {
          // Check if there's more content after this reset
          if (offset + match.length < text.length) {
            if (
              code[0] === inspect.colors.dim[0] ||
              code[0] === inspect.colors.bold[0]
            ) {
              // Dim and bold are not mutually exclusive, so we need to reapply
              return `${match}${escapeStyleCode(code[0])}`;
            }
            return escapeStyleCode(code[0]);
          }
          return match;
        },
      ),
      text,
    );
  } else {
    processedText = text;
  }

  // Build closing codes in reverse order
  let closeCodes = '';
  for (let i = codes.length - 1; i >= 0; i--) {
    closeCodes += escapeStyleCode(codes[i][1]);
  }

  return `${openCodes}${processedText}${closeCodes}`;
}

const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep',
                'Oct', 'Nov', 'Dec'];

/**
 * @returns {string}  26 Feb 16:19:34
 */
function timestamp() {
  const d = new Date();
  const t = ArrayPrototypeJoin([
    pad(DatePrototypeGetHours(d)),
    pad(DatePrototypeGetMinutes(d)),
    pad(DatePrototypeGetSeconds(d)),
  ], ':');
  return `${DatePrototypeGetDate(d)} ${months[DatePrototypeGetMonth(d)]} ${t}`;
}

let console;
/**
 * Log is just a thin wrapper to console.log that prepends a timestamp
 * @deprecated since v6.0.0
 * @type {(...args: any[]) => void}
 */
function log(...args) {
  console ??= require('internal/console/global');
  console.log('%s - %s', timestamp(), format(...args));
}

/**
 * Inherit the prototype methods from one constructor into another.
 *
 * The Function.prototype.inherits from lang.js rewritten as a standalone
 * function (not on Function.prototype). NOTE: If this file is to be loaded
 * during bootstrapping this function needs to be rewritten using some native
 * functions as prototype setup using normal JavaScript does not work as
 * expected during bootstrapping (see mirror.js in r114903).
 * @param {Function} ctor Constructor function which needs to inherit the
 *     prototype.
 * @param {Function} superCtor Constructor function to inherit prototype from.
 * @throws {TypeError} Will error if either constructor is null, or if
 *     the super constructor lacks a prototype.
 */
function inherits(ctor, superCtor) {

  if (ctor === undefined || ctor === null)
    throw new ERR_INVALID_ARG_TYPE('ctor', 'Function', ctor);

  if (superCtor === undefined || superCtor === null)
    throw new ERR_INVALID_ARG_TYPE('superCtor', 'Function', superCtor);

  if (superCtor.prototype === undefined) {
    throw new ERR_INVALID_ARG_TYPE('superCtor.prototype',
                                   'Object', superCtor.prototype);
  }
  ObjectDefineProperty(ctor, 'super_', {
    __proto__: null,
    value: superCtor,
    writable: true,
    configurable: true,
  });
  ObjectSetPrototypeOf(ctor.prototype, superCtor.prototype);
}

/**
 * @deprecated since v6.0.0
 * @template T
 * @template S
 * @param {T} target
 * @param {S} source
 * @returns {S extends null ? T : (T & S)}
 */
function _extend(target, source) {
  // Don't do anything if source isn't an object
  if (source === null || typeof source !== 'object') return target;

  const keys = ObjectKeys(source);
  let i = keys.length;
  while (i--) {
    target[keys[i]] = source[keys[i]];
  }
  return target;
}

const callbackifyOnRejected = (reason, cb) => {
  // `!reason` guard inspired by bluebird (Ref: https://goo.gl/t5IS6M).
  // Because `null` is a special error value in callbacks which means "no error
  // occurred", we error-wrap so the callback consumer can distinguish between
  // "the promise rejected with null" or "the promise fulfilled with undefined".
  if (!reason) {
    reason = new ERR_FALSY_VALUE_REJECTION.HideStackFramesError(reason);
    ErrorCaptureStackTrace(reason, callbackifyOnRejected);
  }
  return cb(reason);
};

/**
 * @template {(...args: any[]) => Promise<any>} T
 * @param {T} original
 * @returns {T extends (...args: infer TArgs) => Promise<infer TReturn> ?
 *   ((...params: [...TArgs, ((err: Error, ret: TReturn) => any)]) => void) :
 *   never
 * }
 */
function callbackify(original) {
  validateFunction(original, 'original');

  // We DO NOT return the promise as it gives the user a false sense that
  // the promise is actually somehow related to the callback's execution
  // and that the callback throwing will reject the promise.
  function callbackified(...args) {
    const maybeCb = ArrayPrototypePop(args);
    validateFunction(maybeCb, 'last argument');
    const cb = FunctionPrototypeBind(maybeCb, this);
    // In true node style we process the callback on `nextTick` with all the
    // implications (stack, `uncaughtException`, `async_hooks`)
    ReflectApply(original, this, args)
      .then((ret) => process.nextTick(cb, null, ret),
            (rej) => process.nextTick(callbackifyOnRejected, rej, cb));
  }

  const descriptors = ObjectGetOwnPropertyDescriptors(original);
  // It is possible to manipulate a functions `length` or `name` property. This
  // guards against the manipulation.
  if (typeof descriptors.length.value === 'number') {
    descriptors.length.value++;
  }
  if (typeof descriptors.name.value === 'string') {
    descriptors.name.value += 'Callbackified';
  }
  const propertiesValues = ObjectValues(descriptors);
  for (let i = 0; i < propertiesValues.length; i++) {
  // We want to use null-prototype objects to not rely on globally mutable
  // %Object.prototype%.
    ObjectSetPrototypeOf(propertiesValues[i], null);
  }
  ObjectDefineProperties(callbackified, descriptors);
  return callbackified;
}

/**
 * @param {number} err
 * @returns {string}
 */
function getSystemErrorMessage(err) {
  validateNumber(err, 'err');
  if (err >= 0 || !NumberIsSafeInteger(err)) {
    throw new ERR_OUT_OF_RANGE('err', 'a negative integer', err);
  }
  return internalErrorMessage(err);
}

/**
 * @param {number} err
 * @returns {string}
 */
function getSystemErrorName(err) {
  validateNumber(err, 'err');
  if (err >= 0 || !NumberIsSafeInteger(err)) {
    throw new ERR_OUT_OF_RANGE('err', 'a negative integer', err);
  }
  return internalErrorName(err);
}

function _errnoException(...args) {
  if (isErrorStackTraceLimitWritable()) {
    const limit = Error.stackTraceLimit;
    Error.stackTraceLimit = 0;
    const e = new ErrnoException(...args);
    Error.stackTraceLimit = limit;
    ErrorCaptureStackTrace(e, _errnoException);
    return e;
  }
  return new ErrnoException(...args);
}

function _exceptionWithHostPort(...args) {
  if (isErrorStackTraceLimitWritable()) {
    const limit = Error.stackTraceLimit;
    Error.stackTraceLimit = 0;
    const e = new ExceptionWithHostPort(...args);
    Error.stackTraceLimit = limit;
    ErrorCaptureStackTrace(e, _exceptionWithHostPort);
    return e;
  }
  return new ExceptionWithHostPort(...args);
}

/**
 * Parses the content of a `.env` file.
 * @param {string} content
 * @returns {Record<string, string>}
 */
function parseEnv(content) {
  validateString(content, 'content');
  return binding.parseEnv(content);
}

const lazySourceMap = getLazy(() => require('internal/source_map/source_map_cache'));

/**
 * @typedef {object} CallSite // The call site
 * @property {string} scriptName // The name of the resource that contains the
 * script for the function for this StackFrame
 * @property {string} functionName // The name of the function associated with this stack frame
 * @property {number} lineNumber // The number, 1-based, of the line for the associate function call
 * @property {number} columnNumber // The 1-based column offset on the line for the associated function call
 */

/**
 * @param {CallSite} callSite // The call site object to reconstruct from source map
 * @returns {CallSite | undefined} // The reconstructed call site object
 */
function reconstructCallSite(callSite) {
  const { scriptName, lineNumber, columnNumber } = callSite;
  const sourceMap = lazySourceMap().findSourceMap(scriptName);
  if (!sourceMap) return;
  const entry = sourceMap.findEntry(lineNumber - 1, columnNumber - 1);
  if (!entry?.originalSource) return;
  return {
    __proto__: null,
    functionName: entry.name || callSite.functionName,
    scriptName: entry.originalSource,
    lineNumber: entry.originalLine + 1,
    column: entry.originalColumn + 1,
    columnNumber: entry.originalColumn + 1,
  };
}

/**
 *
 * The call site array to map
 * @param {CallSite[]} callSites
 * Array of objects with the reconstructed call site
 * @returns {CallSite[]}
 */
function mapCallSite(callSites) {
  const result = [];
  for (let i = 0; i < callSites.length; ++i) {
    const callSite = callSites[i];
    const found = reconstructCallSite(callSite);
    ArrayPrototypePush(result, found ?? callSite);
  }
  return result;
}

/**
 * @typedef {object} CallSiteOptions // The call site options
 * @property {boolean} sourceMap // Enable source map support
 */

/**
 * Returns the callSite
 * @param {number} frameCount
 * @param {CallSiteOptions} options
 * @returns {CallSite[]}
 */
function getCallSites(frameCount = 10, options) {
  // If options is not provided check if frameCount is an object
  if (options === undefined) {
    if (typeof frameCount === 'object') {
      // If frameCount is an object, it is the options object
      options = frameCount;
      validateObject(options, 'options');
      if (options.sourceMap !== undefined) {
        validateBoolean(options.sourceMap, 'options.sourceMap');
      }
      frameCount = 10;
    } else {
      // If options is not provided, set it to an empty object
      options = {};
    };
  } else {
    // If options is provided, validate it
    validateObject(options, 'options');
    if (options.sourceMap !== undefined) {
      validateBoolean(options.sourceMap, 'options.sourceMap');
    }
  }

  // Using kDefaultMaxCallStackSizeToCapture as reference
  validateNumber(frameCount, 'frameCount', 1, 200);
  // If options.sourceMaps is true or if sourceMaps are enabled but the option.sourceMaps is not set explicitly to false
  if (options.sourceMap === true || (getOptionValue('--enable-source-maps') && options.sourceMap !== false)) {
    return mapCallSite(binding.getCallSites(frameCount));
  }
  return binding.getCallSites(frameCount);
};

// Keep the `exports =` so that various functions can still be monkeypatched
module.exports = {
  _errnoException,
  _exceptionWithHostPort,
  _extend: deprecate(_extend,
                     'The `util._extend` API is deprecated. Please use Object.assign() instead.',
                     'DEP0060'),
  callbackify,
  debug: debuglog,
  debuglog,
  deprecate,
  format,
  styleText,
  formatWithOptions,
  // Deprecated getCallSite.
  // This API can be removed in next semver-minor release.
  getCallSite: deprecate(getCallSites,
                         'The `util.getCallSite` API has been renamed to `util.getCallSites()`.',
                         'ExperimentalWarning'),
  getCallSites,
  getSystemErrorMap,
  getSystemErrorName,
  getSystemErrorMessage,
  inherits,
  inspect,
  isArray: deprecate(ArrayIsArray,
                     'The `util.isArray` API is deprecated. Please use `Array.isArray()` instead.',
                     'DEP0044'),
  isBoolean: deprecate(isBoolean,
                       'The `util.isBoolean` API is deprecated.  Please use `typeof arg === "boolean"` instead.',
                       'DEP0045'),
  isBuffer: deprecate(isBuffer,
                      'The `util.isBuffer` API is deprecated. Please use `Buffer.isBuffer()` instead.',
                      'DEP0046'),
  isDeepStrictEqual(a, b) {
    if (internalDeepEqual === undefined) {
      internalDeepEqual = require('internal/util/comparisons')
        .isDeepStrictEqual;
    }
    return internalDeepEqual(a, b);
  },
  isNull: deprecate(isNull,
                    'The `util.isNull` API is deprecated. Please use `arg === null` instead.',
                    'DEP0050'),
  isNullOrUndefined: deprecate(isNullOrUndefined,
                               'The `util.isNullOrUndefined` API is deprecated. ' +
                               'Please use `arg === null || arg === undefined` instead.',
                               'DEP0051'),
  isNumber: deprecate(isNumber,
                      'The `util.isNumber` API is deprecated. Please use `typeof arg === "number"` instead.',
                      'DEP0052'),
  isString: deprecate(isString,
                      'The `util.isString` API is deprecated.  Please use `typeof arg === "string"` instead.',
                      'DEP0056'),
  isSymbol: deprecate(isSymbol,
                      'The `util.isSymbol` API is deprecated.  Please use `arg === "symbol"` instead.',
                      'DEP0057'),
  isUndefined: deprecate(isUndefined,
                         'The `util.isUndefined` API is deprecated. Please use `arg === undefined` instead.',
                         'DEP0058'),
  isRegExp: deprecate(types.isRegExp,
                      'The `util.isRegExp` API is deprecated. Please use `arg instanceof RegExp` instead.',
                      'DEP0055'),
  isObject: deprecate(isObject,
                      'The `util.isObject` API is deprecated. ' +
                      'Please use `arg !== null && typeof arg === "object"` instead.',
                      'DEP0053'),
  isDate: deprecate(types.isDate,
                    'The `util.isDate` API is deprecated.  Please use `arg instanceof Date` instead.',
                    'DEP0047'),
  isError: deprecate(isError,
                     'The `util.isError` API is deprecated. ' +
                     'Please use `ObjectPrototypeToString(e) === "[object Error]" ' +
                     '|| e instanceof Error` instead.',
                     'DEP0048'),
  isFunction: deprecate(isFunction,
                        'The `util.isFunction` API is deprecated.  Please use `typeof arg === "function"` instead.',
                        'DEP0049'),
  isPrimitive: deprecate(isPrimitive,
                         'The `util.isPrimitive` API is deprecated. ' +
                         'Please use `arg === null || ' +
                         '(typeof arg !== "object" && typeof arg !== "function")` instead.',
                         'DEP0054'),
  log: deprecate(log,
                 'The `util.log API is deprecated. ' +
                 'Please use console.log() with a custom formatter or a third-party logger instead.',
                 'DEP0059'),
  promisify,
  stripVTControlCharacters,
  toUSVString(input) {
    return StringPrototypeToWellFormed(`${input}`);
  },
  get transferableAbortSignal() {
    return lazyAbortController().transferableAbortSignal;
  },
  get transferableAbortController() {
    return lazyAbortController().transferableAbortController;
  },
  get aborted() {
    return lazyAbortController().aborted;
  },
  types,
  parseEnv,
};

defineLazyProperties(
  module.exports,
  'internal/util/parse_args/parse_args',
  ['parseArgs'],
);

defineLazyProperties(
  module.exports,
  'internal/encoding',
  ['TextDecoder', 'TextEncoder'],
);

defineLazyProperties(
  module.exports,
  'internal/mime',
  ['MIMEType', 'MIMEParams'],
);

defineLazyProperties(
  module.exports,
  'internal/util/diff',
  ['diff'],
);

defineLazyProperties(
  module.exports,
  'internal/util/trace_sigint',
  ['setTraceSigInt'],
);

    },
} };