// Task / workspace ID generation.
// Task IDs: adjective-noun-4digithex, e.g. swift-falcon-3a2f.
// Doubles as git branch name and worktree directory name, so the wordlists
// stay lowercase a-z only (safe as branch/path segments).

const ADJECTIVES = [
  "swift", "brave", "calm", "clever", "bold", "bright", "keen", "lucky",
  "merry", "noble", "proud", "quick", "quiet", "sharp", "shiny", "sly",
  "wise", "witty", "eager", "gentle", "jolly", "lively", "mighty", "nimble",
  "plucky", "rapid", "spry", "sturdy", "sunny", "vivid", "amber", "azure",
  "cosmic", "crimson", "golden", "ivory", "jade", "scarlet", "silver", "teal",
  "agile", "alert", "ample", "balmy", "blithe", "breezy", "briny", "bubbly",
  "cheery", "chipper", "classy", "cozy", "crisp", "dapper", "daring", "deft",
  "dewy", "dreamy", "dulcet", "fancy", "feisty", "fiery", "fleet", "fluffy",
  "frisky", "fond", "fresh", "funny", "fuzzy", "glad", "gleaming", "gleeful",
  "glossy", "glowing", "grand", "hardy", "hearty", "honest", "humble", "jaunty",
  "jovial", "joyful", "kindly", "limber", "lithe", "loyal", "lush", "mellow",
  "mild", "modest", "peppy", "perky", "placid", "playful", "plush", "polite",
  "prime", "prized", "pure", "radiant", "regal", "robust", "rosy", "rugged",
  "sage", "sandy", "serene", "sleek", "smooth", "snappy", "snug", "soft",
  "sound", "spirited", "lucid", "stalwart", "stately", "steady", "stellar", "stout",
  "suave", "sublime", "sunlit", "supple", "tender", "tidy", "tireless", "tranquil",
  "trusty", "upbeat", "valiant", "velvety", "vibrant", "warm", "zany", "zappy",
  "zealous", "zesty", "zippy", "blue", "bronze", "coral", "cyan", "emerald",
  "indigo", "lilac", "maroon", "ochre", "olive", "pearly", "auburn", "russet",
  "sable", "sienna", "tawny", "umber", "violet", "dusky", "frosty", "glacial",
  "hazy", "misty", "snowy", "stormy", "wintry",
];

const NOUNS = [
  "falcon", "otter", "lynx", "heron", "badger", "marten", "raven", "wren",
  "fox", "hawk", "ibex", "koala", "lemur", "mole", "newt", "owl",
  "puma", "quail", "robin", "seal", "tapir", "vole", "wolf", "yak",
  "comet", "ember", "fern", "grove", "harbor", "meadow", "pebble", "ridge",
  "summit", "thicket", "willow", "anchor", "beacon", "cinder", "delta", "flint",
  "bison", "beaver", "bobcat", "boar", "camel", "cobra", "cougar", "coyote",
  "crane", "deer", "dingo", "dove", "eagle", "egret", "elk", "ferret",
  "finch", "gecko", "gibbon", "goose", "hare", "jackal", "jaguar", "kestrel",
  "lark", "leopard", "llama", "loon", "magpie", "marmot", "mink", "moose",
  "moth", "ocelot", "orca", "osprey", "oryx", "panda", "panther", "pelican",
  "pony", "possum", "quokka", "rabbit", "salmon", "sparrow", "stag", "stoat",
  "stork", "swan", "tiger", "toad", "trout", "turtle", "viper", "walrus",
  "weasel", "whale", "zebra", "basin", "bay", "bluff", "brook", "butte",
  "canyon", "cave", "cliff", "cove", "crag", "creek", "dale", "dune",
  "fjord", "forest", "gorge", "glade", "glen", "gully", "hill", "isle",
  "knoll", "lagoon", "lake", "marsh", "mesa", "moor", "oasis", "pond",
  "reef", "river", "shore", "slope", "spring", "stream", "valley", "vale",
  "aurora", "breeze", "cloud", "dawn", "dusk", "frost", "gale", "mist",
  "rain", "sleet", "snow", "storm", "zephyr", "vapor", "agate", "basalt",
  "beryl", "copper", "coral", "crystal", "diamond", "garnet", "geode", "granite",
  "gypsum", "jasper", "marble", "onyx", "opal", "pyrite", "quartz", "slate",
  "topaz", "zircon", "cosmos", "eclipse", "galaxy", "meteor", "moon", "nebula",
  "nova", "orbit", "planet", "pulsar", "quasar", "star", "sun", "zenith",
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

/**
 * Workspace IDs: a stable short slug. Newly minted ids carry the `ws-` prefix;
 * legacy `dir-…` ids (minted before the directory→workspace rename) remain valid
 * opaque keys — we never rewrite existing id VALUES, only stop minting new `dir-` ones.
 */
export function generateWorkspaceId(): string {
  return `ws-${hex4()}${hex4()}`;
}

/**
 * Story IDs: a stable short slug carrying the `st-` prefix (mirrors the workspace id
 * shape). Caller should verify uniqueness against existing rows. See src/stories.ts.
 */
export function generateStoryId(): string {
  return `st-${hex4()}${hex4()}`;
}

/**
 * Project IDs: a stable short slug carrying the `pj-` prefix (REVAMP-4 Phase 3 / P3c — the
 * project-node analog of a story `st-` id). A project is a work_kind='project' `tasks` NODE;
 * the distinct prefix keeps it unmistakable from a leaf/story/workspace id. Caller should verify
 * uniqueness against existing rows. See workspaces.createProject.
 */
export function generateProjectId(): string {
  return `pj-${hex4()}${hex4()}`;
}

/**
 * Initiative IDs: a stable short slug carrying the `ini-` prefix (REVAMP-4 Phase 3 / P3e). A
 * cross-repo project initiative fans one brief into MULTIPLE member-repo child stories, all
 * grouped by ONE initiative id stamped on each child node's `initiative_id` column. UNLIKE a
 * story/project id this is a GROUPING KEY, not a `tasks` row id — the distinct prefix keeps it
 * unmistakable. Caller should verify uniqueness against existing `initiative_id` values.
 * See stories.createCrossRepoInitiative.
 */
export function generateInitiativeId(): string {
  return `ini-${hex4()}${hex4()}`;
}
