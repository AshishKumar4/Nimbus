console.log('globalThis typeof:', typeof globalThis);
console.log('Buffer typeof:', typeof Buffer);
console.log('process typeof:', typeof process);
console.log('queueMicrotask typeof:', typeof queueMicrotask);
console.log('AbortController typeof:', typeof AbortController);
console.log('fetch typeof:', typeof fetch);
console.log('crypto typeof:', typeof crypto);
console.log('crypto.subtle typeof:', typeof (typeof crypto !== 'undefined' && crypto.subtle));
console.log('WebAssembly typeof:', typeof WebAssembly);