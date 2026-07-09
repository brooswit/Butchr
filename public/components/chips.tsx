// The CHIP + BADGE cluster, in React. Grows one component per phase as the views that need it land;
// Phase 4b needs exactly one, the status pill, for views/metrics.tsx's status breakdown bars.
//
// >>> IMPORT THIS AS `"./chips.tsx"`, WITH THE EXTENSION. <<< The vanilla `components/chips.js` is
// still here — four vanilla views render chips through it — so `"./chips.js"` resolves to THAT file,
// not to this one, under both `tsc` and `bun build`. The explicit `.tsx` is what disambiguates, and
// tsconfig.public.json's `allowImportingTsExtensions` is what permits it. When Phase 4d deletes the
// last vanilla view it deletes chips.js with it, and the specifiers can go back to being extensionless.
//
// >>> THESE ARE CUSTOM, AND THAT IS A DECISION, NOT AN OMISSION. <<<
// RFC §7.2 (CTO decision 7) refutes mapping them onto LaunchPad's `Tag`. `Tag` has EIGHT variants —
// error | default | info | warning | success | beta | federal | new. butchr defines FOURTEEN status
// colours and SEVEN kind colours, each chosen deliberately: feedback states amber/orange, agent
// states blue/indigo, terminal states green/red/brown/gray, and thirteen of the fourteen re-tuned
// again for dark surfaces. Forcing 14 into 8 collapses rolling_back/rolled_back/failed into one red
// and spec_review/in_review into one amber — destroying the at-a-glance colour coding. So: a
// `<span>` styled by the existing `.chip.<status>` rules in style.css.
//
// ESCAPING IS STRUCTURAL AND THERE IS NO WAY TO OPT OUT. JSX escapes every interpolated string by
// construction — there is no `el()` to route around and no `esc()` to forget.
//
// `statusLabel` reads core/state-meta.ts's `STATUS_LABEL`, an `export let` that applyStateMeta
// REASSIGNS once `/api/state-meta` lands. It is called at RENDER time (never snapshotted into a
// module const), and a component that shows a chip must list `useStateMetaVersion()` among its deps
// so React learns the tables were rebuilt — see views/metrics.tsx.
import { statusLabel } from "../core/state-meta.js";

/** The status pill. `?? ""` keeps a null status from writing the literal string "undefined" into
 *  the class list — what the old `esc()` used to absorb. */
export function StatusChip({ status }: { status: string | null | undefined }) {
  return <span className={"chip " + (status ?? "")}>{statusLabel(status)}</span>;
}
