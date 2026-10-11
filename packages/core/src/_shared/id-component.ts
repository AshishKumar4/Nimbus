export const ID_COMPONENT_RE = /^[A-Za-z0-9._-]{1,128}$/;

export function isNimbusIdComponent(value: unknown): value is string {
  return typeof value === 'string' && ID_COMPONENT_RE.test(value);
}
