/**
 * The test egress's PyPI project (NIMBUS_TEST_EGRESS=1): `nimbus-egress-canary`,
 * a pure wheel whose metadata the egress answers for pypi.org and whose
 * download it serves itself, over plain HTTP on the egress's host. A
 * `pip install nimbus-egress-canary` therefore succeeds only when both the
 * metadata read and the wheel download (made inside CPython, over a socket)
 * went out through the egress.
 *
 * The wheel: nimbus_egress_canary/__init__.py (`VIA = "the workspace
 * egress"`), its METADATA, WHEEL and RECORD; stored, 1142 bytes.
 */

export const CANARY_PROJECT = 'nimbus-egress-canary';
export const CANARY_WHEEL = 'nimbus_egress_canary-1.0-py3-none-any.whl';

const CANARY_WHEEL_BASE64 = [
  'UEsDBBQAAAAAAAAAR12PrHUDHQAAAB0AAAAgAAAAbmltYnVzX2VncmVzc19jYW5hcnkvX19pbml0X18ucHlWSUEgPSAidGhlIHdv',
  'cmtzcGFjZSBlZ3Jlc3MiClBLAwQUAAAAAAAAAEddoiZ5Yz4AAAA+AAAAKwAAAG5pbWJ1c19lZ3Jlc3NfY2FuYXJ5LTEuMC5kaXN0',
  'LWluZm8vTUVUQURBVEFNZXRhZGF0YS1WZXJzaW9uOiAyLjEKTmFtZTogbmltYnVzLWVncmVzcy1jYW5hcnkKVmVyc2lvbjogMS4w',
  'ClBLAwQUAAAAAAAAAEddktAQF1kAAABZAAAAKAAAAG5pbWJ1c19lZ3Jlc3NfY2FuYXJ5LTEuMC5kaXN0LWluZm8vV0hFRUxXaGVl',
  'bC1WZXJzaW9uOiAxLjAKR2VuZXJhdG9yOiBuaW1idXMtdGVzdC1lZ3Jlc3MKUm9vdC1Jcy1QdXJlbGliOiB0cnVlClRhZzogcHkz',
  'LW5vbmUtYW55ClBLAwQUAAAAAAAAAEddmSjd+kQBAABEAQAAKQAAAG5pbWJ1c19lZ3Jlc3NfY2FuYXJ5LTEuMC5kaXN0LWluZm8v',
  'UkVDT1JEbmltYnVzX2VncmVzc19jYW5hcnkvX19pbml0X18ucHksc2hhMjU2PWNzRTdVbjdFbTZUWnc2LUNKeHQ4WU1lRl9OSHNk',
  'c3lYTmNTV2xQWHI3dzAsMjkKbmltYnVzX2VncmVzc19jYW5hcnktMS4wLmRpc3QtaW5mby9NRVRBREFUQSxzaGEyNTY9X1NKUlM1',
  'ZWNwTEFoX0ZjUm1vN1A1eGVMdTdBTThuRUt4RGN3OGd1dG1iayw2MgpuaW1idXNfZWdyZXNzX2NhbmFyeS0xLjAuZGlzdC1pbmZv',
  'L1dIRUVMLHNoYTI1Nj1URi1wajNUbzRaUUJ1dXNNODU4MWx5VjUtZTZRZE4xaW9wUENsV2hiSVBNLDg5Cm5pbWJ1c19lZ3Jlc3Nf',
  'Y2FuYXJ5LTEuMC5kaXN0LWluZm8vUkVDT1JELCwKUEsBAhQDFAAAAAAAAABHXY+sdQMdAAAAHQAAACAAAAAAAAAAAAAAAKQBAAAA',
  'AG5pbWJ1c19lZ3Jlc3NfY2FuYXJ5L19faW5pdF9fLnB5UEsBAhQDFAAAAAAAAABHXaImeWM+AAAAPgAAACsAAAAAAAAAAAAAAKQB',
  'WwAAAG5pbWJ1c19lZ3Jlc3NfY2FuYXJ5LTEuMC5kaXN0LWluZm8vTUVUQURBVEFQSwECFAMUAAAAAAAAAEddktAQF1kAAABZAAAA',
  'KAAAAAAAAAAAAAAApAHiAAAAbmltYnVzX2VncmVzc19jYW5hcnktMS4wLmRpc3QtaW5mby9XSEVFTFBLAQIUAxQAAAAAAAAAR12Z',
  'KN36RAEAAEQBAAApAAAAAAAAAAAAAACkAYEBAABuaW1idXNfZWdyZXNzX2NhbmFyeS0xLjAuZGlzdC1pbmZvL1JFQ09SRFBLBQYA',
  'AAAABAAEAFQBAAAMAwAAAAA=',
].join('');

const CANARY_WHEEL_SHA256 = 'b26ea7e46356f037458eff9c7f4422db321b2e6dcb49bac13a74f8111472c3e9';

/** The wheel's bytes. */
export function canaryWheel(): Uint8Array {
  return Uint8Array.from(atob(CANARY_WHEEL_BASE64), (c) => c.charCodeAt(0));
}

/** PyPI's JSON for the project (and for its one version), the wheel at `wheelUrl`. */
export function canaryPypiJson(wheelUrl: string): unknown {
  const file = { filename: CANARY_WHEEL, packagetype: 'bdist_wheel', url: wheelUrl, digests: { sha256: CANARY_WHEEL_SHA256 }, yanked: false };
  return { info: { name: CANARY_PROJECT, version: '1.0', requires_dist: null }, releases: { '1.0': [file] }, urls: [file] };
}
