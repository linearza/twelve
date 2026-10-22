// A style changes the whole trailer: what Claude writes, how the narrator
// delivers it, and how the picture is graded.
export interface Style {
  label: string;
  brief: string; // added to Claude's system prompt
  narrator?: string; // Voice Design prompt; without one the default narrator reads
  voice: { stability: number; similarity_boost: number; style: number };
  look: {
    grade: string; // ffmpeg eq options
    grain: boolean; // film grain, flicker and vignette
    cardColor: string;
  };
}

export const STYLES = {
  epic: {
    label: "Epic",
    brief: `Style: a big, brooding blockbuster. Treat the mundane as epic: a messy desk is a war zone, a team lunch is a heist crew assembling.
Open with "In a world...". Sound effects are trailer staples: booms, risers, whooshes. The score is dark and orchestral.`,
    voice: { stability: 0.35, similarity_boost: 0.8, style: 0.6 },
    look: { grade: "contrast=1.08:saturation=0.85", grain: true, cardColor: "white" },
  },
  comedy: {
    label: "Comedy",
    brief: `Style: a goofy family comedy trailer. Big setups, deadpan undercuts, at least one record-scratch moment where things go wrong.
Cards are punchlines ("OOPS.", "NOT AGAIN"). Sound effects are cartoon foley: boing, slide whistle, record scratch, rimshot, kazoo.
The score is bouncy and silly: pizzicato strings, tuba, xylophone.`,
    narrator: "Over-the-top family comedy trailer announcer: a middle-aged American man with a big, rubbery, goofy voice, booming but always on the edge of cracking up, perfect comic timing.",
    voice: { stability: 0.3, similarity_boost: 0.75, style: 0.85 },
    look: { grade: "contrast=1.05:saturation=1.4", grain: false, cardColor: "0xFFD23F" },
  },
  bricks: {
    label: "Bricks",
    brief: `Style: an animated toy-brick adventure movie, as if everything in the photo were built from plastic bricks and minifigures.
Everything is awesome, heroic and slightly absurd; reference studs, instructions, missing pieces and the pain of stepping on one.
Sound effects are plastic: bricks clicking together, a pile of bricks being rummaged, tiny plastic footsteps, a brick-built whoosh.
The score is an upbeat, heroic toy orchestra with glockenspiel and pop drums.`,
    narrator: "Earnest, heroic toy commercial announcer: a young American man with a bright, booming, wide-eyed voice, ridiculously enthusiastic about everything, like a Saturday morning cartoon.",
    voice: { stability: 0.35, similarity_boost: 0.8, style: 0.75 },
    look: { grade: "contrast=1.1:saturation=1.6", grain: false, cardColor: "0xFFD23F" },
  },
  nature: {
    label: "Nature doc",
    brief: `Style: a hushed wildlife documentary. Narrate the photo as if observing a rare species in its natural habitat: patient,
awed, full of whispered scientific observations about ordinary behaviour. No "In a world". Cards name the "species" or the season.
Sound effects are ambient and natural: birdsong, wind, rustling, a distant call. The score is sweeping strings and soft piano.`,
    narrator: "Hushed elderly British wildlife documentary narrator: soft, breathy and warm, speaking slowly in an awed near-whisper, as if not to disturb the animals.",
    voice: { stability: 0.6, similarity_boost: 0.8, style: 0.3 },
    look: { grade: "contrast=1.04:saturation=1.1", grain: false, cardColor: "white" },
  },
} satisfies Record<string, Style>;

export type StyleId = keyof typeof STYLES;
export const STYLE_IDS = Object.keys(STYLES) as StyleId[];
export const isStyle = (id: unknown): id is StyleId => typeof id === "string" && id in STYLES;
