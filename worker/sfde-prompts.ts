import hero from "../contracts/hero-skins-v2.json";

const prompts = {
  ghost_hero: hero,
  streamer_hero: hero,
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
export const heroOptions = Object.freeze(Object.keys(hero.questions.hero.criteria));
