// The one data hook every view fetches through.
//
// It reproduces what the vanilla render loop did, including the parts that were accidents of that
// loop and turned out to matter:
//
//   • `render()` AWAITED the view's fetch and only then called `mount()`. So the previous page
//     stayed on screen for the whole round-trip. `useAsync` keeps `data` from the last successful
//     run while a re-fetch is in flight — a re-fetch NEVER flashes the view empty. Losing that is
//     the most obvious way a naive React port feels worse than the thing it replaced.
//   • A view that threw painted `<div class="empty">error: …</div>` and nothing else. `error` here
//     is that, and it is sticky only until the next successful run.
//   • Navigating away mid-fetch mounted nothing. `cancelled` is that.
//
// `deps` is the route identity plus every invalidation signal — `useRefreshVersion()` (SSE + post-
// action) and `useStateMetaVersion()` (a view that painted against the built-in fallback repaints
// once `/api/state-meta` self-heals). It is spread into `useEffect`'s dependency array, so it must
// be a stable-length list of primitives, exactly like any other dependency array.
import { useEffect, useRef, useState } from "react";

export type Async<T> = {
  /** The last SUCCESSFUL result, or null before the first one lands. Survives a re-fetch. */
  data: T | null;
  /** The last error, cleared by the next success. */
  error: Error | null;
  /** True only while NO data has ever landed. A re-fetch over existing data is not "loading". */
  loading: boolean;
};

export function useAsync<T>(run: () => Promise<T>, deps: ReadonlyArray<unknown>): Async<T> {
  const [state, setState] = useState<Async<T>>({ data: null, error: null, loading: true });
  // `run` is a fresh closure on every render; depending on it would re-fetch on every parent state
  // change (a conn-LED flicker would re-fetch the page). Read it through a ref so the effect always
  // calls the latest one without listing it. This is the same trick bridge.tsx used for `run`.
  const runRef = useRef(run);
  runRef.current = run;

  useEffect(() => {
    let cancelled = false;
    // Do NOT clear `data` here. A re-fetch keeps the current view painted.
    void runRef.current().then(
      (data) => { if (!cancelled) setState({ data, error: null, loading: false }); },
      (e: unknown) => { if (!cancelled) setState((s) => ({ ...s, error: asError(e), loading: false })); },
    );
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `deps` IS the dependency array.
  }, deps);

  return state;
}

/** A thrown non-Error (a string, a rejected `undefined`) still has to render a message. */
export function asError(e: unknown): Error {
  return e instanceof Error ? e : new Error(String(e ?? "unknown error"));
}
