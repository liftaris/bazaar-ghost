const criteria = {
  Dooley: "A small, rounded robot with a single large circular eye, mechanical limbs, and orange and grey coloring.",
  Vanessa: "A female pirate with dark hair, sharp facial features, a slim athletic build, and red coloring.",
  "The Dragons": "Two youthful, horned, pointed-eared humanoid musicians, a singer and a guitarist, with purple and pink coloring.",
  Pygmalien: "A large, broad-built humanoid boar with a pig snout, protruding lower tusks, pointed ears, facial hair, and blue coloring.",
  Jules: "A four-armed, pointed-eared female chef with long hair and pink coloring.",
  Mak: "A male alchemist with an angular face, a full beard, thick eyebrows, and green coloring.",
  Stelle: "A dark-skinned female engineer and aviator with reddish-brown hair, goggles, and yellow coloring.",
  Karnok: "A rugged male hunter with an angular face and dark fur, also appearing as a large, shaggy, fanged beast. His primary colors are magenta and black.",
};
function hero(side: "LEFT" | "RIGHT", who: "streamer" | "ghost") {
  return {
    model: "clef-flash",
    state: `The image is the full-height ${side} HALF of a PvP matchup introduction from The Bazaar. It contains the ${who} hero artwork and its identity-color glow or blur at the BOTTOM-${side} corner. Identify the ONE illustrated hero using the character descriptions and the identity glow. Ignore the real webcam person, usernames, titles and rank badges. Identify the underlying hero, allowing cosmetic skins. Never infer identity from the person, username or game items. Corner identity glow colors: Dooley = orange; Vanessa = red; The Dragons = teal; Pygmalien = blue; Jules = pink; Mak = green; Stelle = yellow; Karnok = magenta. The corner glow is a UI identity cue, distinct from clothing color and the central background. If the corner is covered by a webcam or overlay, use visible character artwork; do not invent a hidden glow.`,
    questions: { hero: {
      type: "choice",
      instructions: "Which underlying hero is depicted in this single screen half? Select one hero. Cosmetic skins preserve hero identity.",
      criteria,
    } },
  };
}
const prompts = {
  ghost_hero: hero("RIGHT", "ghost"),
  streamer_hero: hero("LEFT", "streamer"),
  clock_day: {
    model: "clairic",
    state: "Read only the printed in-game DAY in this crop of The Bazaar clock medallion. The day can be dark digits on a light medallion or light digits on a dark medallion. In tournament mode a separate WINS-LOSSES score appears ABOVE the medallion: neither number of that score is the day. Never read or calculate day from tournament scores, wins, losses, or win boxes. Return null when the day medallion is unreadable. This crop may exclude all other clock fields; do not invent them.",
    fields: {
      day: { type: "number", integer: true, instructions: "Read the integer inside the day medallion, BELOW any wins-losses score. Never return a score component. Null if the medallion is unreadable." },
      wins_earned: { type: "number", integer: true, instructions: "Count blue-filled box interiors, 0 through 10; null unless all ten boxes are readable." },
      lethal: { type: "number", integer: true, instructions: "Bottom-left crown only: 0=orange whole safe, 1=grey cracked lethal, null=unclear or hidden." },
    },
  },
};
export type InferenceTask = keyof typeof prompts;
export function inferencePrompt(task: InferenceTask): Record<string, unknown> {
  return structuredClone(prompts[task]);
}
export const heroOptions = Object.freeze(Object.keys(criteria));
