/** Authenticated controller channel to an already positively owned machine.
 * Implementations never replay uncertain commands or expose an outer-host shell. */
export interface MachineControlChannel {
  run(
    host: string,
    program: string[],
    input?: Uint8Array,
    options?: {
      signal?: AbortSignal;
      timeoutMs?: number;
      inputLimit?: number;
      outputLimit?: number;
    },
  ): Promise<{ stdout: Uint8Array; stderr: Uint8Array }>;
}
