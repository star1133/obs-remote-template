// Transition families shared by the UI, the simulator and the OBS agent.

/** Map an OBS transition name to the visual family the UI and the frame renderer understand. */
export function kindOf(name = "") {
  if (/cut/i.test(name)) return "cut";
  if (/fade to|dip|color/i.test(name)) return "dip";
  if (/swipe|wipe/i.test(name)) return "wipe";
  if (/slide|push/i.test(name)) return "slide";
  return "mix";
}

/** The stages each family passes through, with their share of the 0..1 transition position. */
export const STAGES = {
  cut: [{ label: "Instant cut", w: 1 }],
  mix: [{ label: "A cross-fades into B", w: 1 }],
  dip: [{ label: "A fades to black", w: 0.5 }, { label: "black fades up to B", w: 0.5 }],
  wipe: [{ label: "B wipes over A", w: 1 }],
  slide: [{ label: "B pushes A out", w: 1 }],
};
