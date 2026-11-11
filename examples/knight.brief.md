# Rigged knight: art brief

The figure an agent starts from for a stocky or armoured character, or one that carries something still: a guard, a dwarf, a robot, a soldier with a banner. An original knight in plate seen from the side, facing right. The design is our own; nothing is taken from a game.

- **Canvas and display:** 32×32, origin `[16, 31]` (the anchor under the feet), `rig.ground` 29 (the ankle row). The sabatons' soles sit on row 30. Review at 1× and 6×. The attack's wind-up and the hurt recoil stay inside the canvas.
- **Landmarks:** a round helmet with a dark visor slit and breath holes, as wide as the chest; a gold-rimmed heater shield with a red boss, held in front at chest height; a sword pointing forward and up; a red plume trailing behind the crown.
- **Blocks:** three that read apart in colour and in grayscale: steel above (helmet), gold and red in the middle (shield over a red tabard), steel below (legs). The hero is slim bones in cloth; a recoloured hero with a helmet reads as a thin column, which is why this is a separate build.
- **Construction:** a red `mass` at the hips is the rig body and the tabard's skirt. The chest is a red bone standing on it (`width [7, 8]`). The legs are steel bones four long with `flat` ankle caps no wider than the sabatons, and the two thighs hang three pixels apart (`at` beside `attach`), so two legs show at rest. A grid pauldron sits over the shoulder, drawn last.
- **Shield arm:** `shieldUpper` and `shieldFore` hang from the shoulder like any arm but are left out of `rig.arms`, so no template swings them: the shield holds its place through the walk and the attack. The sword arm, the far one, is the only chain in `rig.arms`; it swings against the legs and strikes.
- **Plume:** two red bones from the chest's `crest` point, above the helmet, named in `rig.tail`: they trail in the walk and whip after a strike.
- **Palette (13 colours):** `k` outline. Steel `A B C D`, red `r s t`, gold `g G H`, and `c w` for the sword's grip. Light comes from the upper left (225°). Near limbs are a ramp step lighter than far ones.
- **Motion:** idle, walk (speed 20, stride 8: a heavier step than the hero's), attack and hurt at the templates' defaults.
- **Weaknesses:** the tabard shows only as a red edge behind the shield arm. In the walk's last frame the lifted near foot sits a row above the planted far one, which reads as a thick sole. The sabatons are flat grids without roll views, and the shield never moves, even when struck.
