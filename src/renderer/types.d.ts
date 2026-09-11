import type { FleetPayload } from '../main/ipc.ts';

declare global {
  interface Window {
    // Optional, not asserted: Task 5 established that a failed preload
    // still leaves a normal-looking window, so this can genuinely be
    // undefined at runtime (the preload script errored or never ran).
    // Declaring it non-optional would let FleetView dereference it
    // straight through and throw at mount with no user-visible signal --
    // marking it optional forces every call site to check first.
    fleet?: {
      listFleet: () => Promise<FleetPayload>;
      onFleet: (cb: (payload: FleetPayload) => void) => () => void;
    };
  }
}
export {};
