// Task / directory ID generation.
// Task IDs: adjective-noun-4digithex, e.g. swift-falcon-3a2f.
// Doubles as git branch name and worktree directory name, so the wordlists
// stay lowercase a-z only (safe as branch/path segments).

const ADJECTIVES = [
  "swift", "brave", "calm", "clever", "bold", "bright", "keen", "lucky",
  "merry", "noble", "proud", "quick", "quiet", "sharp", "shiny", "sly",
  "wise", "witty", "eager", "gentle", "jolly", "lively", "mighty", "nimble",
  "plucky", "rapid", "spry", "sturdy", "sunny", "vivid", "amber", "azure",
  "cosmic", "crimson", "golden", "ivory", "jade", "scarlet", "silver", "teal",
];

const NOUNS = [
  "falcon", "otter", "lynx", "heron", "badger", "marten", "raven", "wren",
  "fox", "hawk", "ibex", "koala", "lemur", "mole", "newt", "owl",
  "puma", "quail", "robin", "seal", "tapir", "vole", "wolf", "yak",
  "comet", "ember", "fern", "grove", "harbor", "meadow", "pebble", "ridge",
  "summit", "thicket", "willow", "anchor", "beacon", "cinder", "delta", "flint",
];

function pick<T>(arr: readonly T[]): T {
  return arr[Math.floor(Math.random() * arr.length)]!;
}

function hex4(): string {
  return Math.floor(Math.random() * 0x10000)
    .toString(16)
    .padStart(4, "0");
}

/** Generate a candidate task ID. Caller should verify uniqueness. */
export function generateTaskId(): string {
  return `${pick(ADJECTIVES)}-${pick(NOUNS)}-${hex4()}`;
}

/** Generate a unique task ID, retrying against an existence predicate. */
export function uniqueTaskId(exists: (id: string) => boolean): string {
  for (let i = 0; i < 100; i++) {
    const id = generateTaskId();
    if (!exists(id)) return id;
  }
  // Astronomically unlikely; fall back to extra entropy.
  return `${generateTaskId()}-${hex4()}`;
}

/** Directory IDs: a stable short slug. */
export function generateDirectoryId(): string {
  return `dir-${hex4()}${hex4()}`;
}
