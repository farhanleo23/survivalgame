# Runtime character models

All character assets are bundled with the game and loaded from this directory.
Nothing is fetched from a remote server at play time.

## Operator

`soldier.glb` — the animated Soldier model distributed with the official
Three.js skeletal-animation blending example.

- Source: https://github.com/mrdoob/three.js/blob/dev/examples/models/gltf/Soldier.glb
- Example: https://threejs.org/examples/webgl_animation_skinning_blending.html
- Original model credit shown by the example: Mixamo
- Clips: `Idle`, `Walk`, `Run`, `TPose`

## Infected

Downloaded from [Poly Pizza](https://poly.pizza). Each entry lists the licence
that model was published under.

| File | Model | Creator | Licence | Clips |
| --- | --- | --- | --- | --- |
| `zombie-shambler.glb` | Zombie | Quaternius | **CC-BY** | Attack, Bite_ground, Crawl, Die, Die2, Headbutt, Hit_reaction, Idle, Running_Crawl, Scream, Walk, Walk2 |
| `zombie-runner.glb` | Animated Zombie | Quaternius | **CC-BY** | ZombieBite, ZombieCrawl, ZombieIdle, ZombieRun, ZombieWalk |
| `zombie-spitter.glb` | Zombie half | Quaternius | **CC-BY** | Crawl, Death, HitReact, Idle, Jump, Run, Walk |
| `zombie-boomer.glb` | Zombie | Quaternius | CC0 | Attack, Death, HitRecieve, Idle, Jump, Run, Walk |
| `zombie-heavy.glb` | Zombie | Quaternius | CC0 | Crawl, Death, HitReact, Idle, Idle_Attack, Punch, Run, Run_Attack, Walk, + 7 more |

`zombie-heavy.glb` backs both the Brute and the Juggernaut, separated by scale
and by the armour, horns and reactor-core attachments built in code.

## Attribution

Three of the models above are published under CC-BY, which requires
attribution. The following notice satisfies it and must be kept anywhere the
game is distributed:

> Zombie character models by **Quaternius** (https://quaternius.com), sourced
> via Poly Pizza (https://poly.pizza), licensed under
> [CC-BY 4.0](https://creativecommons.org/licenses/by/4.0/).

The two CC0 models carry no attribution requirement, but Quaternius is credited
for those as well by the same notice.
