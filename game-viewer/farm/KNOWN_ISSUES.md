# Playtest feedback

## Physical helpers and nearby-action gating — September 12, 2026

Two related reports: crops replanted and animals were milked the instant a helper
or the player issued the order, even from across the map, which read as unearned
and made the walking sprites feel decorative rather than real. Helper positions
now live in the model and are routed with the same movement/collision as guards
and monsters; a job's progress (till, plant, water, weed, clear, feed, collect)
only advances once the assigned helper has actually walked over to its target —
the specific animal it tends, not a generic spot by the pen — so a plot a monster
destroyed stays ruined until a helper walks over to clear and replant it. The
player's Tend, Harvest, Collect, Slaughter, and healing an animal now require the
farmer standing within the same reach the Space-key hint already uses; a
too-far button disables itself with its own "Walk closer to…" label instead of a
popup, and re-enables the moment the farmer arrives. Buying, selling, choosing a
crop, healing yourself or a protector, and Harvest all ready still work from
anywhere. Planting now uses a throwing-items pose instead of the hoe. Confirm the
new pacing and the button labels feel right in a browser playtest.

## Attack reach — revised September 11, 2026

The first playtest reported “Move closer” while standing in front of or behind
an enemy. Combat now shares actual actor coordinates between simulation and
rendering. Player reach uses body radii plus sword reach from all directions,
with a live nearby-action hint. Empty swings no longer produce a repeated error.
Automated tests cover all four sides, cooldowns, obstacles, and body collisions.
Confirm the feel in the next browser playtest; visual browser QA was unavailable.

## Balance — first progression pass

New farms start with three plots and slower crops. Existing saves keep all their
land/resources; use the confirmed New farm flow to test the revised opening.
Harvest tiers, raid compositions, prices, and timings are initial tuning values
and should be adjusted using playtest feedback.

## Defense floor — September 12, 2026

Defense now reduces a hit to zero damage, replacing the old rule that every hit
landed at least 1. At shipped defaults this changes one matchup: a bog slime
(3 power) can no longer hurt a knight (3 defense) at all. Raise slime power or
lower knight defense in the Balance editor if that reads wrong in play.

## Base stats — first editable pass

Every damageable type now carries editable health and defense, and fighters carry
attack, interval, reach and speed. Shipped values are unchanged from the previous
build. Owned land is damageable with or without a crop; ruined land keeps its
ownership and is repaired by tending. Confirm the feel in a browser playtest.

## Protectors fight to the death — September 12, 2026

Protectors no longer retreat automatically at low health. A patrolling protector
reduced to zero health in combat now dies and is removed from the roster
permanently, upgrades included, with a journal entry, the same way an animal
dies; only combat can kill a protector, so expedition wear can leave one critical
but never kill it. This also fixed a bug where a protector sent home to heal
never went back on patrol: it now resumes patrol automatically once fully
healed. Sending any protector onto patrol or an expedition is always allowed
now, even while wounded — that risk is the player's call. Confirm the new
stakes feel right in a browser playtest.
