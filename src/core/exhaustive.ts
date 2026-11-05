/** Require every discriminated-union variant to be handled. Never print its payload:
 * configuration values can contain credentials. Also rejects untyped JS inputs.
 */
export function assertNever(_value: never): never {
  throw new Error("Unsupported configuration variant");
}
