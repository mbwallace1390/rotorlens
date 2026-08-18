# RotorLens for pilots

How to get an answer out of this app, and what the answers mean.

Written for someone who has a Rotorflight helicopter and a phone, not for
someone who reads source code. If you only read one section, read the next one.

---

## Turn on the unfiltered gyro. Nothing else matters until you do

In the Rotorflight configurator, add **`gyroRAW`** to the Blackbox field set.

Vibration is judged on the raw gyro signal, because the filters take the
evidence out before anything can measure it. On a log that carries only the
filtered gyro, "nothing found" would only mean "nothing was left to look at" —
so RotorLens refuses to judge the airframe at all.

And every tuning suggestion sits behind that judgement, because **a shaking
helicopter cannot be tuned**. Without `gyroRAW`, RotorLens will tell you about
your tracking error and draw your traces, and it will never once tell you to
change a gain, no matter how well you fly.

One checkbox. It is the difference between a log that can be analysed and one
that cannot.

---

## Getting the log off the helicopter

1. Plug the flight controller into the phone.
2. Open the Rotorflight configurator, connect, go to the **Blackbox** tab.
3. Tap **activate mass storage device mode**. The board reboots and appears as a
   drive — and your phone should offer to open RotorLens. Tick the box on that
   dialog and it will happen automatically from then on.
4. Pick the `.bbl` file.
5. **Before you unplug**, turn mass storage mode off again, or eject the drive
   from your phone's storage notification. Pulling the cable while it is mounted
   is what makes Android warn that a device was removed unsafely. Your log is
   fine and the phone does not need restarting, but it is an alarming message to
   see for no reason.

A full dataflash takes a couple of minutes to copy — about 800 KB a second, so
an 85 MB dump is around two minutes. The bar is real; let it run.

If your controller logs to a removable SD card instead, a USB card reader skips
all of this.

---

## The flight that produces answers

Most flying produces no tuning evidence at all, and that is not a fault in the
app or in you. Across 110 real flights from three different boards, there was
**not one usable roll or pitch stop**. People simply do not fly that way unless
they are deliberately collecting data.

So fly one sortie on purpose. It takes about four minutes.

**Before you take off:** one governor setting, held for the whole flight. Do not
change headspeed. Gains behave differently at different rotor speeds, and a
flight that moves around cannot be compared against itself.

**For each axis — roll, then pitch, then yaw:**

1. Put in a definite command — **more than 80°/s**. That is firmer than most
   people expect; it is well past half stick.
2. **Hold it steady for about a second.**
3. **Release to centre in one clean motion.** Snap it. Easing the stick back is
   read as a dwell, not a stop, and is thrown away.
4. **Take your hand off for a full second.** Do not catch it, do not correct, do
   not re-command. That second is the measurement.
5. Do it **twice each way** — two left and two right.

Then **at least five long steady holds per axis**: five seconds or more of a
constant command each — a heading held, or a steady turn — with the other two
axes quiet. That is what the I term is measured on.

Five is not a round number picked for the sake of it. Comparing one flight
directly against the one before it needs three holds **on each side** (the
minimum was rederived per axis on 17 August 2026 — it was five, which no real
flight-axis had ever reached), and in the reference corpus 59% of otherwise
comparable flights carried exactly one. Two holds produce a flight the direct
comparison will then refuse, which is the most frustrating way to waste a
sortie — and five gives the comparison margin above its floor rather than
sitting exactly on it. (The learning model asks less of a single flight — two
holds — because it estimates its own scatter across many flights instead of
trusting two. Fly five and you feed both.)

Leave at least a second and a half of calm between stops so they do not run into
each other.

**The two mistakes that waste the flight**, both common:

- **Easing the stick back instead of releasing it.** The single most frequent
  reason a genuine stop is refused.
- **Correcting during the second after release.** It turns a stop into no stop
  at all. On one reference flight, four of five candidate roll stops died
  exactly this way.

If in doubt, exaggerate. A bigger, firmer, more clearly released input is easier
to measure and safer to fly than a marginal one.

---

## Reading what it tells you

Findings come in a fixed order, and the order is the point: **the airframe
first, then head speed, then gains, one axis at a time.** A gain suggestion
below a mechanical finding is not worth acting on until the mechanical one is
resolved.

**At most one card is marked START HERE.** That is the one change to make. Not
the first of several — the only one. Change it, fly again, and see.

Each card carries:

- **What it is**, in plain language before any jargon.
- **Which way**, when the evidence supports a direction.
- **Why** — the measurements behind it, so you can disagree with it. If a
  finding's reasoning does not match what you felt in the air, trust yourself and
  say so; the app is reading one log, and you were there.
- **What to fly next** to confirm it worked.

**Where it says it cannot tell, it means it.** "Not enough evidence" is the
normal answer, not a failure. The app is built to stay quiet rather than guess,
because a confident wrong answer about a machine with blades is worse than
silence.

### One thing to understand about D

When RotorLens says a gain is ringing, it also says it cannot rule out the
airframe. That is not hedging. Inside a single log, a dry bearing, a loose mount
or a tired damper looks **exactly** like a gain that is too high — both are a
narrowband oscillation after each input, quiet while you hold.

The confirming flight is what separates them:

- Lower the gain one step and the ringing shortens → it was the gain.
- Lower it and the ringing comes back **at the same frequency and the same
  size** → it was never the gain. Put the gain back where it was and inspect the
  aircraft. Blade tracking, damper condition, bearings, head play, anything
  loose.

Continuing to lower a gain into a mechanical fault leaves you with less control
authority and the fault still there, getting worse.

---

## Change one thing, fly again, compare

Save a flight, change **one** gain, fly the same manoeuvres, and open the new
log. RotorLens will show what moved.

It will also, very often, say the movement is too small to call — and that is
the feature working. Two flights with nothing changed between them usually
differ by less than 0.39°/s on the hold measurement, and have differed by as
much as 1.39°/s. A change smaller than that is weather, not tuning, and an app
that called it an improvement would be lying to you in a way you could not
check.

Several changes at once make the result unreadable, for you and for the app.

---

## What "learning" means here, and what it does not

Under each helicopter in the **Flight history** panel there is a short block
headed *What RotorLens has learned about this helicopter*. It is worth
understanding what it is doing, because it is not what most apps mean by the
word.

**It fits a line through your own flights, or it refuses to.** Nine cells, one
per gain — roll/pitch/yaw against P/I/D. Each shows how many of your saved
flights it can actually use for that gain, and one word about what they add up
to. Underneath, one sentence saying what would teach it next.

### What the words in the cells mean

| The cell says | It means |
| --- | --- |
| `0 of 6` | nothing usable yet. Six flights is where a line through them is worth attempting at all — it is a floor, not a target |
| `4 of 6` | four usable flights. Keep flying; this one is going somewhere |
| `8 a direction` | enough to say which way that gain moved things on your machine, but not how far |
| `8 measured` | an amount, fitted to your flights, printed in full below the grid |
| `— not measurable` | **more flying will not help.** Nothing here can ever read this gain |
| `6 disagree` | your flights contradict each other by more than two of your own unchanged flights do. Something the app cannot see moved — blades, a filter, the head. It also says this when the standing error got better while the tail hunted harder, which is what the edge of stability looks like from inside the range you have flown |
| `4 old setup` | those flights were flown on firmware or rate curves you are no longer on |

The one to understand is **not measurable**, and it is why D is always empty.
The only measurement with a known noise floor is the standing error while you
hold a heading, and D acts on how fast the error is *changing*, which during a
steady hold is nothing. That is an instrument that does not exist, not a
shortage of flights, and the app says so instead of letting you wait for it.

### What makes a flight usable

For a flight to count towards a gain, everything else has to have stayed still:

- the same helicopter, firmware and rate curves;
- **every other gain identical** — a roll change starts a new group for pitch
  too, because a helicopter cross-couples;
- the same head speed;
- at least two deliberate holds in the flight, which the sortie above produces
  five of.

Change two gains at once and neither flight helps. Fly at a different head
speed and it goes into its own group. This is why the counts move slowly, and
why the deliberate sortie is worth so much more than ordinary flying.

### Go back down again. This is the one that surprises people

Nudging a gain up, flying it, nudging it up again is the natural way to test
something, and it is the one pattern this app **cannot read at all**. If a gain
only ever climbs, it climbs with the calendar — and so does everything else that
changed over those weeks. New blades, a stretched belt, colder air, your own
thumbs getting better: every one of them looks exactly like the gain, and
nothing in a Blackbox log can tell them apart. A perfectly clean-looking trend
built that way is as likely to be the weather as the gain, and it will be
confidently pointed the wrong way about as often as the right one.

So the cheapest thing you can do for this feature is **fly a value you have
already flown, again, out of order.** Go 100, 140, then back to 100. That one
flight is worth more than three more rungs up the ladder, because it is the only
thing that separates the gain from the passage of time.

Until you do, the cell will say `too close` and the panel will ask for exactly
this. It is not asking for more flights. More flights further up cannot fix it.

**Expect zeros for a long time, and expect silence after that.** Nine cells at
zero is the normal state, not a fault.

### Where each suggestion comes from

On every gain suggestion, one line says which it is:

- **general convention** — which way to move it, from how these controllers
  behave in general. This is what every suggestion says today, and what most of
  them will always say.
- **measured on your helicopter** — an amount fitted to your own flights, with
  the number of flights behind it printed beside it.

If you ever see the second, read the flights behind it before acting on it.
They are all listed one disclosure down, each with its gain value and what your
hold error did. And read the sentence carefully: it says what *happened*
between two values you have actually flown. It is not a setting, and it says
nothing about values outside that range.

**Deleting a flight deletes what it taught.** Nothing is fitted and stored:
everything is worked out afresh from the flights you can see, every time the
panel is drawn. Tap Forget and watch the counts fall in the same tap — and
sometimes watch a measured amount disappear altogether, because the flights
that made it believable have gone. That is the design working. You can always
disagree with this app by removing the evidence.

**A flight where you changed nothing is not a wasted flight** — it is one of
the most valuable ones. Those are what measure how much *your* helicopter
wanders between two identical sorties, which is the bar every result has to
clear. Until you have a few, RotorLens is using a figure measured on somebody
else's machine, and it will not put an amount on anything at all.

---

## What it keeps, and what it never does

- **Saving a flight keeps about 4.4 kB of numbers** on your device — never the
  log, never a position of any kind, never a date, never a file name. The History
  screen shows that data, with buttons to forget one flight, one helicopter, or
  all of it.
- **Answering the optional future-sharing question stores your answer.** If you
  turn sharing on, RotorLens also creates a random 100-bit identity for each saved
  helicopter and associates it with the craft-name/board key already used by the
  history. This release has no upload transport. The Sharing screen shows this
  state and can erase the preference and identities; Forget everything erases
  both native files.
- **Current RotorLens builds contain no upload transport and make no network
  requests.** On Android, RotorLens additionally requests no `INTERNET`
  permission, so the operating system prevents the app itself from opening a
  network connection. iOS has no equivalent permission switch; its release gate
  verifies the same no-network behavior directly.
- **It never connects to or writes to your flight controller.** Every change is
  one you make yourself, in your own configurator.

---

## If you send a log to somebody, read this first

Some of the thresholds RotorLens judges your aircraft against are measured on two
helicopters, both belonging to the person who wrote it. More machines is the only
thing that fixes that, so donated logs are genuinely wanted — and the flights
worth sending are not the ones you would expect. **Two ordinary flights with
nothing changed between them are the most useful thing you can send.** That pair
is how the noise floor gets measured, and without it nothing else can be told
apart from the weather.

Send the `.bbl`, and four lines with it: what the aircraft is, what headspeed you
fly, what you changed since the flight before (*"nothing" is an answer, and a good
one*), and whether `gyroRAW` was in the field set.

**Now the part that is about you rather than about the data.** The line above —
no upload transport in current builds, plus Android's missing network permission
— is a property of the app.
**It protects you from the app. It does not protect you from yourself.** A `.bbl`
you attach to a message is the whole file, and if GPS was logged it contains the
coordinates of where you flew, which for most people is a home field and for some
people is the garden.

So before you send one:

- **Check whether GPS is in it.** If your flight controller logs GPS, your
  coordinates are in that file, and handing it over is not undoable.
- **Sending a log to somebody to look at is not permission to publish it.** If
  anyone asks to put your log in a public repository or ship it in a product,
  that is a separate question, and you are entitled to be asked it separately, in
  writing, about that specific file.
- The same goes for a Discord channel, an issue tracker, or a cloud folder link.

None of that is a reason not to share. It is the reason to decide deliberately
rather than by attaching a file.

---

## The honest limits

- Every suggestion is read out of one log from one flight. It does not know your
  blade weight, your servo speed, your linkage or your head condition. It knows
  what you changed last time only for flights you chose to save, and only as the
  numbers off the header.
- **A measured amount describes your past flights, not your next setting.** It
  says what happened between two values you have flown, on this machine, in this
  configuration. It says nothing outside that range, and it cannot see your
  blades, your belts, your filters or your governor — any of which can move the
  same measurement.
- Every suggestion is a starting point for your next test flight, not a setting
  to trust.
- You are the pilot in command. Ground-check after any change, hover before you
  commit, and build inputs up gradually.
- Rotor blades cause serious injury. Fly within your ability, at a permitted
  site, and follow local law and your manufacturer's guidance.

RotorLens is an independent product, not affiliated with or endorsed by the
Rotorflight or Betaflight projects.
