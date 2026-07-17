// ============================================================
// trailingDebounce — collapse a burst of calls into one trailing invocation
// ============================================================
// Used to wrap realtime-subscription refetch callbacks: a single engine
// action fans into many postgres_changes events, and firing a full refetch
// pipeline per event is wasteful. A trailing-edge debounce runs `fn` once,
// `ms` after the LAST call in a burst.
//
// One instance PER fetch target (courts / waitlist / matches …) so unrelated
// streams don't cross-trigger each other's pipelines. `cancel()` clears a
// pending timer — call it from the subscription effect's cleanup so a refetch
// never fires after unmount (the fetchSeq guards make a late fire harmless,
// but cancelling is cleaner).

export type TrailingDebouncer = {
  /** Schedule `fn` to run `ms` after this call, replacing any pending run. */
  run: () => void;
  /** Clear any pending run (e.g. on unmount). */
  cancel: () => void;
};

export function trailingDebounce(fn: () => void, ms: number): TrailingDebouncer {
  let timer: ReturnType<typeof setTimeout> | null = null;
  return {
    run: () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        fn();
      }, ms);
    },
    cancel: () => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    },
  };
}
