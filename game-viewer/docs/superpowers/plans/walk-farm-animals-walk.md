# Make the farm animals walk around the pen

**Game:** Little Meadow (`game-viewer/farm/`)
**Written:** 2026-09-13
**Status:** not built yet. This is a walkthrough, not a record of work done.

Line numbers below were correct on 2026-09-13. If they have drifted, search for the
function name instead; those are stable.

## The idea

Right now an animal has no position of its own. Its spot comes from its place in the
list: the 1st animal stands in slot 1, the 2nd in slot 2, and so on, in a fixed 4-wide
grid. That is `animalPosition(index)` in `farm/world.mjs`, line 10. That is why they
stand still.

To make them walk, each animal needs:

1. Its own spot (`x`, `y`), which changes as it moves.
2. A place it is heading: a random point inside the pen.
3. A short rest when it gets there, so it grazes instead of pacing like it is caged.

## Why this is not just a drawing change

The helpers had this exact problem. The drawing code showed them walking, but the game
rules did not know, so crops changed before anyone arrived.

Animals would break the same way. If only the drawing moved them, monsters would attack
the spot where the cow used to be, and helpers would feed empty grass. So the position
has to live in the game rules, and everything else reads it from there.

---

## Step 1 - `farm/world.mjs` (the map): add three things

```js
// The inside of the pen fence drawn in scene.mjs (lines 100-109). Adjust by eye.
export const PEN = Object.freeze({ left: 462, top: 168, right: 570, bottom: 244 });

// Pick a spot inside the pen. Deliberately not Math.random: the same number in
// always gives the same spot out, so the game and its tests act the same every run.
export function wanderPoint(seed) {
  const pick = n => Math.abs(Math.sin(seed * 12.9898 + n * 78.233) * 43758.5453) % 1;
  return { x: PEN.left + pick(1) * (PEN.right - PEN.left),
           y: PEN.top  + pick(2) * (PEN.bottom - PEN.top) };
}

// Where an animal is: its own spot once it has one, otherwise its old grid slot.
export function animalSpot(animals, animal) {
  return Number.isFinite(animal.x) ? { x: animal.x, y: animal.y }
                                   : animalPosition(animals.indexOf(animal));
}
```

Why each one:

- `PEN` - the game already keeps things out of buildings, but it knows nothing about
  fences. This is the fence.
- `wanderPoint` - gives an animal somewhere to walk. The game already fakes randomness
  with arithmetic instead of `Math.random` (see how raids pick spawn points in
  `combat.mjs`). Real randomness would make tests pass one run and fail the next.
- `animalSpot` - the one place that answers "where is this animal?" Every other file
  calls this instead of doing its own math.

---

## Step 2 - Swap the five places that ask where an animal is

| File | Line | Function | Change |
|---|---|---|---|
| `model.mjs` | 33 | `nearAnimal`: is your farmer close enough? | `animalPosition(i)` to `animalSpot(s.animals, s.animals[i])` |
| `model.mjs` | 153 | `jobTarget`: where a helper walks | `animalPosition(i)` to `animalSpot(s.animals, s.animals[i])` |
| `model.mjs` | 292 | `getInteractionTarget`: the Space key | `animalPosition(i)` to `animalSpot(s.animals, a)` |
| `combat.mjs` | 65 | `farmTargets`: what monsters attack | `(a, i) => ({ ...a, ...animalPosition(i),` to `a => ({ ...a, ...animalSpot(s.animals, a),` |
| `scene.mjs` | 104 | drawing each animal | `animalPosition(i)` to `animalSpot(state.animals, animal)` |

Add `animalSpot` to the `import` line at the top of each of those three files.

**Stop and run the tests here.** Nothing should look any different yet: no animal has
its own spot, so they all still fall back to their old slot. If tests fail at this step
you mistyped something, and it is much easier to find now than after animals are moving.

Bonus fix: today, when an animal dies or is slaughtered, the ones after it in the list
slide into its slot, because position is its place in the list. Once animals have their
own spot, that stops. The `combat.mjs` line also has a small existing bug: its `i` only
counts living animals, so it can point at the wrong slot.

---

## Step 3 - `farm/model.mjs`, function `stepAnimals`: make them walk

`stepAnimals` runs 20 times per game second and already handles hunger and milk/wool.
Add this at the **end** of its `for (const a of s.animals)` loop, so hunger and
milk/wool never get skipped:

```js
    // First tick: start at its old slot.
    const spot = animalSpot(s.animals, a);
    a.x ??= spot.x; a.y ??= spot.y;

    // Hold still while a helper is working on it (see "the trap" below).
    if (s.workers.some(w => w.job?.targetId === a.id)) continue;

    // Resting and grazing.
    if (a.rest > 0) { a.rest -= STEP; continue; }

    // Pick somewhere to go, then amble there at 8 pixels a second.
    a.goal ??= wanderPoint(s.time * 13 + s.animals.indexOf(a));
    if (!moveActor(a, a.goal, 8, STEP, 1)) {
      a.goal = null;                    // arrived (or blocked): forget this goal
      a.rest = 3 + (s.time * 7) % 5;    // graze for 3 to 8 seconds
    }
```

Add `animalSpot` and `wanderPoint` to the import from `./world.mjs` at the top.
`moveActor` is already imported; it is the same walking code helpers and monsters use.

For scale: helpers walk at 63, a slime at 16, so 8 is a slow amble.

**The trap, and why the "hold still" line matters most:** a helper only feeds or milks
once it is within 3 pixels of the animal. Without that line the cow keeps wandering off,
the helper keeps chasing, and the animal never gets fed. That is the bug you would hit
first.

---

## Step 4 - `farm/scene.mjs`: face the way they walk

`moveActor` already records which way the animal is facing. Flip the picture when it
walks left, the same trick used for monsters just below in that file:

```js
      const { x, y } = animalSpot(state.animals, animal);
      const left = animal.facing === 'left';
      shadow(x + 16, y + 26, 13);
      ctx.save();
      if (left) { ctx.translate(Math.round(x + 32), 0); ctx.scale(-1, 1); }
      sprite(ctx, images, animal.kind, left ? 0 : x, y, Math.floor(motion * 2 + i) % 4, 0);
      ctx.restore();
```

If they end up walking backwards, the art faces the other way by default. Change
`'left'` to `'right'`.

---

## Step 5 - `farm/storage.mjs`, function `offlineFarm`: do not save where they stand

Add one line before `return farm;`:

```js
  for (const a of farm.animals) { delete a.x; delete a.y; delete a.goal; delete a.rest; delete a.facing; }
```

Why: helpers already are not saved. Leaving out where an animal is standing means the
save format does not change, so every existing save keeps loading.

The cost: after a reload, animals start back at their old slots and wander off from
there. Nobody will notice a cow moved.

The other way is to save positions. That means a version 4 save plus conversion code for
old saves, which is not worth it for cows.

---

## Step 6 - Tests

| File | What to check |
|---|---|
| `tests/farm-model.test.ts` | Run 10 minutes of game time: every animal stays inside `PEN` the whole time. |
| `tests/farm-model.test.ts` | An animal holds still while a helper is feeding it, and the feeding finishes. |
| `tests/farm-model.test.ts` | Move a cow by hand. The Space key and `nearAnimal` find it at its new spot. |
| `tests/farm-storage.test.ts` | A saved farm contains no animal `x`/`y`, and an old save still loads. |
| `tests/farm-scene.test.ts` | The drawing code puts the animal at its own `x`/`y`. |

Run them with `./run.sh --test`.

---

## Worth knowing

- The pen numbers in `PEN` are an estimate taken from the fence drawing. Watch them
  wander and nudge the numbers if a sheep clips the fence.
- The water trough and feed box drawn inside the pen are not solid, so animals will walk
  over them. Fine for a first version.
- Monsters will now chase animals around. That is correct, but a spear goblin chasing a
  cow may look like it is herding.
- A green test suite does not mean this looks right. Watch it in the browser before
  calling it done.
