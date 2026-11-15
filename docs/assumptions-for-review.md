# Arien simulation: what we assumed (please tell us what's wrong)

We're building a simulation of a solar site to test how drones, robots and technicians split up maintenance work. Every number below is our guess, not field data. If anything looks off, a quick note saying so helps a lot.

## The site

- **Assumption:** 800 panels in 20 rows of 40, with rows about 6 m (20 ft) apart.
- **Assumption:** panels are wired in strings of 20, so each row has 2 strings.
- **Assumption:** one tracker moves a whole row.

## Fault types

- **Hotspot (assumption):** affects one panel. It's the most common fault in the sim. It's usually minor but sometimes serious, and we assume about 4 in 10 end up needing the panel replaced rather than repaired.
- **Soiling (assumption):** dirt over 3 to 12 neighbouring panels in a row. It's never critical and always fixed by cleaning, never by replacement.
- **String outage (assumption):** one whole string of 20 panels goes down. It's usually serious, and about 15% need parts replaced.
- **Tracker stuck (assumption):** a whole row stops tracking. It's the rarest fault and usually serious, and about 10% need parts replaced.
- **Assumption:** faults show up far more often in the sim than on a real site, about 30 in 16 hours, so there's enough activity to watch. We know that's unrealistic.

## Workers and speeds

- **Drone (assumption):** flies at about 11 mph (5 m/s) in a straight line. It gets 25 minutes of flight per charge and takes 60 minutes to recharge from empty. It can fly any hour, like a drone-in-a-box. It only inspects.
- **Ground robot (assumption):** drives at about 2 mph (1 m/s) and runs any hour. Its battery lasts all day. It only does up-close checks.
- **Technician (assumption):** walks at about 3 mph (1.4 m/s). They can check, repair and replace.
- **Assumption:** people and robots can cut between panel rows anywhere. We know real sites usually only let you cross at the row ends.

## Shifts

- **Technician (assumption):** one 8-hour day shift, 8 am to 4 pm, every day. At 4 pm they stop whatever they're doing and head back, and the job waits until morning.
- **Drone and robot (assumption):** no shift, available around the clock.

## Time on site per job

- **Inspect, by drone (assumption):** 5 to 8 minutes.
- **Up-close check (assumption):** 5 to 20 minutes, depending on the fault.
- **Repair (assumption):** about 30 minutes for cleaning, 45 for a hotspot, an hour for a string outage and 90 minutes for a stuck tracker.
- **Replace (assumption):** 2 to 3 hours, and we assume parts are on hand.

## Questions for you

1. Which of these numbers is furthest from reality?
2. Is there a common fault or job we're missing?
3. Who actually does the "up-close check" on your sites today: a tech, a robot, or nobody?
4. How many people usually cover a site like this, and does the 8–4 single-shift setup match?
5. How do jobs get assigned to people, drones, and vendors today, and what goes wrong?
6. What are we missing: weather, drive time to site, access or lockout rules, parts availability?
