# Deadwave bundled assets

All runtime models are local. The game never fetches a model during a run, and
the selected set keeps first-wave loading predictable.

## Characters

`survivor.glb`, `zombie-shambler.glb`, `zombie-runner.glb`, and
`zombie-boomer.glb` are selected glTF exports from the [Quaternius Zombie
Apocalypse Kit](https://quaternius.com/packs/zombieapocalypsekit.html). The kit
is CC0 and includes the playable survivor and HitReact, Death, Idle, Walk, and
Run clips used here. `zombie-spitter.glb` and `zombie-heavy.glb` are retained
from the existing Quaternius kit exports for the spitter and boss roles.
The pack's license record is included in `LICENSE-QUATERNIUS.txt`.

The Brute shares the shambler mesh with a larger silhouette; Juggernaut shares
the heavy mesh with its armour and reactor attachments. This preserves all six
gameplay roles without multiplying download size.

## Industrial scenery

The selected GLBs in `industrial/` come from [Kenney's City Kit
Industrial](https://kenney.nl/assets/city-kit-industrial), licensed CC0. The
kit's `License.txt` is bundled beside the models. They are used as perimeter
buildings, shipping containers, tanks, a pickup, solar panels, and a water
tower. The runtime scales each clone to the existing collision footprint.

## Menu images

`../images/operator.webp` and the four weapon WebPs are local thumbnails
rendered from the same operator rig and procedural weapon models used in the
game. They are generated build assets, not a second art pipeline.

## Sounds

The concrete footsteps and metal/soft impact clips in `../audio/` come from
[Kenney's Impact Sounds](https://kenney.nl/assets/impact-sounds), licensed CC0.
`../audio/LICENSE.txt` is copied from the archive; the synthesized weapon tones
remain layered underneath these short material cues.
