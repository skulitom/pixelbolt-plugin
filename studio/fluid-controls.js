// The Fluid lab's presets and sliders, and how slider values become an edited fluid source. No DOM access, so tests can
// import it: test/fluid-controls.test.js checks that every shipped preset's settings fit these sliders exactly and come
// back unchanged, so a preset always shows and restores its own values.
export const FLUID_PRESETS = [
  { file: 'campfire', title: 'Campfire', note: 'Gas · loop' }, { file: 'explosion', title: 'Explosion', note: 'Gas · one-shot' },
  { file: 'smoke-puff', title: 'Smoke puff', note: 'Gas · one-shot' }, { file: 'steam-vent', title: 'Steam vent', note: 'Gas · loop' },
  { file: 'magic-swirl', title: 'Magic swirl', note: 'Gas · loop' }, { file: 'torch', title: 'Torch', note: 'Gas · loop' },
  { file: 'splash', title: 'Splash', note: 'Liquid · one-shot' }, { file: 'waterfall', title: 'Waterfall', note: 'Liquid · loop' },
  { file: 'drip', title: 'Drip', note: 'Liquid · loop' }, { file: 'potion', title: 'Bubbling potion', note: 'Liquid · loop' },
  { file: 'honey', title: 'Honey', note: 'Viscous liquid · loop' }, { file: 'slime', title: 'Slime', note: 'Yield-stress liquid · one-shot' },
  { file: 'roof-snow', title: 'Snow off a roof', note: 'Smooth obstacle · one-shot' }, { file: 'dam-break', title: 'Dam break', note: 'Moving obstacle · one-shot' },
  { file: 'dust-wave', title: 'Dust wave', note: 'Carried gas · one-shot' }, { file: 'slime-burst', title: 'Bursting slime', note: 'Burst fill · one-shot' },
  { file: 'honey-drop', title: 'Honey let-go', note: 'Keyed liquid · one-shot' }, { file: 'aquarium', title: 'Aquarium bubbles', note: 'Bubbles · loop' },
  { file: 'honey-dipper', title: 'Honey dipper', note: 'Sticky moving obstacle · one-shot' },
  { file: 'glug', title: 'Glugging bottle', note: 'Air pockets · one-shot' },
  { file: 'jacobs-ladder', title: "Jacob's ladder", note: 'Electric arc · loop' }, { file: 'lightning', title: 'Lightning', note: 'Electric gas · one-shot' },
  { file: 'tesla-coil', title: 'Tesla coil', note: 'Electric gas · loop' }, { file: 'plasma-globe', title: 'Plasma globe', note: 'Electric gas · loop' },
  { file: 'ice-melt', title: 'Ice cube melting', note: 'Heat · one-shot' }, { file: 'pond-freeze', title: 'Pond freezing', note: 'Heat · one-shot' },
  { file: 'boiling-pot', title: 'Boiling pot', note: 'Heat, vapour · loop' }, { file: 'frost-window', title: 'Frosted window', note: 'Frost · one-shot' },
  { file: 'dry-ice', title: 'Dry-ice fog', note: 'Sublimation · one-shot' },
  { file: 'lightning-pond', title: 'Lightning into a pond', note: 'Arcs into water · one-shot' }
];
// Each slider sets one setting of the preset's effect; Strength scales every emitter's rate or burst. A slider's range
// and step must hold every preset's value exactly: a range input clamps to its range and snaps to its step.
const strength = { key: 'strength', label: 'Strength', min: 0.25, max: 2, step: 0.05, initial: () => 1, show: v => `× ${v.toFixed(2)}` };
export const FLUID_SLIDERS = {
  gas: [strength,
    { key: 'buoyancy', label: 'Rise (buoyancy)', min: 0, max: 1, step: 0.01, initial: e => e.buoyancy ?? 0.15 },
    { key: 'vorticity', label: 'Curl (vorticity)', min: 0, max: 1, step: 0.01, initial: e => e.vorticity ?? 0.25 },
    { key: 'dissipation', label: 'Fade (dissipation)', min: 0, max: 0.4, step: 0.0025, initial: e => e.dissipation ?? 0.03 }],
  liquid: [strength,
    { key: 'gravity', label: 'Gravity', min: 0, max: 0.6, step: 0.01, initial: e => (e.gravity ?? [0, 0.3])[1] },
    { key: 'flip', label: 'Liveliness (flip)', min: 0, max: 1, step: 0.01, initial: e => e.flip ?? 0.9 },
    // Thickness slows spreading and keeps streams whole without slowing a fall; resistance (drag) slows everything,
    // falling included, as if the liquid moved through something thick.
    // 64 is the compiler's own limit for viscosity, and the honey let-go starts there.
    { key: 'viscosity', label: 'Thickness (viscosity)', min: 0, max: 64, step: 0.5, initial: e => e.viscosity ?? 0 },
    // 16 is the compiler's own limit for yield, and the slime preset uses all of it.
    { key: 'yield', label: 'Firmness (yield)', min: 0, max: 16, step: 0.1, initial: e => e.yield ?? 0 },
    { key: 'drag', label: 'Resistance (drag)', min: 0, max: 0.3, step: 0.005, initial: e => e.drag ?? 0 }]
};
export const fluidEffect = source => Object.values(source.effects)[0];
export const fluidSliders = source => FLUID_SLIDERS[fluidEffect(source).kind === 'liquid' ? 'liquid' : 'gas'];
const round = value => Math.round(value * 1000) / 1000;
// The value a range input holds after being set to `value`: clamped to the range and snapped to the nearest step from
// the minimum (the larger one on a tie), as browsers do, without binary rounding noise.
export function sliderValue(slider, value) {
  const decimals = Math.max(...[slider.min, slider.step].map(n => (String(n).split('.')[1] ?? '').length));
  const steps = Math.floor((Math.min(slider.max, Math.max(slider.min, value)) - slider.min) / slider.step + 0.5 + 1e-9);
  return Math.min(slider.max, Number((slider.min + steps * slider.step).toFixed(decimals)));
}
// The preset with the sliders and seed applied; settings left where the preset had them are not written.
export function editedSource(original, values, seed) {
  const source = structuredClone(original), effect = fluidEffect(source), before = fluidEffect(original);
  for (const slider of fluidSliders(original)) {
    const value = values[slider.key];
    if (value === slider.initial(before)) continue;
    if (slider.key === 'strength') {
      for (const emitter of effect.emitters) for (const field of ['rate', 'burst']) if (emitter[field] !== undefined) emitter[field] = round(Math.min(64, Math.max(0.01, emitter[field] * value)));
    } else if (slider.key === 'gravity') effect.gravity = [(before.gravity ?? [0, 0.3])[0], value];
    else effect[slider.key] = value;
  }
  if (seed !== (before.seed ?? 1)) effect.seed = seed;
  return source;
}
