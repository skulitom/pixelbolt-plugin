// The Effects lab's presets and controls, and how control values become an edited pixelforge-fx source. No DOM
// access, so tests can import it: test/effects-controls.test.js checks that every listed preset compiles on its own (no
// file references), comes back unchanged with the controls at rest, and still compiles at their extremes.
export const EFFECT_PRESETS = [
  { file: 'slash-hit', title: 'Slash hit', note: 'Crescent and sparks · one-shot' },
  { file: 'fire-explosion', title: 'Fire explosion', note: 'Fireball and smoke · one-shot' },
  { file: 'fireball', title: 'Fireball', note: 'Loop · eight directions' },
  { file: 'lightning-strike', title: 'Lightning strike', note: 'Bolt and flash · one-shot' },
  { file: 'healing-circle', title: 'Healing circle', note: 'Magic circle and pillar · one-shot' },
  { file: 'vortex', title: 'Vortex', note: 'Swirl and turbulence · loop' },
  { file: 'meteor', title: 'Meteor', note: 'Moving emitters · one-shot' },
  { file: 'shield', title: 'Shield bubble', note: 'Boiling ring and halo · loop' },
  { file: 'water', title: 'Cel water', note: 'Geyser, whip, ring, dome, curl' },
  { file: 'fire-spells', title: 'Fire spells', note: 'Projectile, impact, area, buff' },
  { file: 'ice-spells', title: 'Ice spells', note: 'Projectile, impact, area, buff' },
  { file: 'lightning-spells', title: 'Lightning spells', note: 'Projectile, impact, area, buff' },
  { file: 'water-spells', title: 'Water spells', note: 'Projectile, impact, area, buff' },
  { file: 'poison-spells', title: 'Poison spells', note: 'Projectile, impact, area, buff' },
  { file: 'holy-spells', title: 'Holy spells', note: 'Projectile, impact, area, buff' },
  { file: 'shadow-spells', title: 'Shadow spells', note: 'Projectile, impact, area, buff' },
  { file: 'effects', title: 'Particles', note: 'Sparks, embers, dust, leaves, shards' }
];
// Both controls are relative, so every preset starts at 1: Strength scales the chosen effect's emitter rates and
// bursts, Speed its frame timing (2 plays twice as fast).
export const EFFECT_SLIDERS = [
  { key: 'strength', label: 'Strength (particles)', min: 0.25, max: 2, step: 0.05, show: v => `× ${v.toFixed(2)}` },
  { key: 'speed', label: 'Speed', min: 0.5, max: 2, step: 0.05, show: v => `× ${v.toFixed(2)}` }
];
const round = value => Math.round(value * 1000) / 1000;
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const ms = (duration, speed) => clamp(Math.round(duration / speed), 1, 60000);
// A duration in any of its forms (one number, one per frame, or a { from, to, ease } curve) played `speed` times faster.
function faster(duration, speed) {
  if (typeof duration === 'number') return ms(duration, speed);
  if (Array.isArray(duration)) return duration.map(d => ms(d, speed));
  return { ...duration, from: ms(duration.from, speed), to: ms(duration.to, speed) };
}
// The animation an effect's controls apply to: a turned copy (fireball-45) edits the effect it was turned from.
// A part drawn behind or in front of a character (buff-back) edits the effect it is part of, which may itself be a turned copy.
export const effectOf = (metadata, animation) => {
  const effect = metadata.effects[animation];
  return effect?.part ? effectOf(metadata, effect.part.of) : effect?.turn?.of ?? animation;
};
// The source with the controls and seed applied to one effect; settings left at rest are not written.
export function editedEffects(original, name, values, seed) {
  const source = structuredClone(original), effect = source.effects[name], before = original.effects[name];
  const strength = values.strength ?? 1, speed = values.speed ?? 1;
  if (strength !== 1) for (const emitter of effect.emitters ?? []) {
    if (typeof emitter.rate === 'number') emitter.rate = round(clamp(emitter.rate * strength, 0.001, 64));
    else if (Array.isArray(emitter.rate)) emitter.rate = emitter.rate.map(v => round(clamp(v * strength, 0, 64)));
    if (emitter.burst !== undefined) emitter.burst = clamp(Math.round(emitter.burst * strength), 1, 1024);
  }
  if (speed !== 1) effect.duration = faster(before.duration ?? 100, speed);
  if (seed !== (before.seed ?? 1)) effect.seed = seed;
  return source;
}
