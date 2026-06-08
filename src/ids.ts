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

/** Directory IDs: a stable short slug. */
export function generateDirectoryId(): string {
  return `dir-${hex4()}${hex4()}`;
}
