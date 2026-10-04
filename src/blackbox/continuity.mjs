/**
 * I-frame continuity: the check that can see a permuted bit layout.
 *
 * Every other guard we had was blind to a whole class of decoder bug. An
 * encoding that selects per-field widths from a header byte can have those
 * widths handed to the wrong fields without changing how many bytes the group
 * consumes — so the frame stream stays aligned, no error is raised, no resync
 * happens, and the sample interval stays perfect. Round-trip cannot see it
 * either, because our own writer packs the byte the same way the reader unpacks
 * it: both halves agree, and both are wrong. Two encodings shipped with exactly
 * that defect (TAG8_4S16, then TAG2_3S32 selector 3), and a predictor shipped
 * with a related one (INCREMENT with the wrong step).
 *
 * What all three have in common is that they corrupt *deltas*, not *absolutes*.
 * A P frame carries a residual against a prediction; an I frame carries the
 * truth. So a wrong delta accumulates for the length of the I-frame period and
 * is then yanked back to reality at the next I frame. Averaged over a log, the
 * per-sample change at an I-frame position is enormously larger than it is
 * anywhere else — while a correctly decoded field is just a signal, and a signal
 * does not know where the keyframes are.
 *
 * This module measures exactly that: mean |Δ| entering an I frame, against mean
 * |Δ| everywhere else. Correct decoding gives ≈1. Put back into the decoder, the
 * three defects read on the real 4.6 log: TAG8_4S16 346x on setpoint[3],
 * INCREMENT 33x on loopIteration, and TAG2_3S32 selector 3 17.9x on attitude[2]
 * and 5.0x on axisP[1]. Those are ratios alone, which as below are no longer the
 * whole rule.
 *
 * A RATIO ABOVE THE THRESHOLD IS NOT ENOUGH ON ITS OWN, and the 109 sessions of
 * two private dataflash dumps are what showed it. Under the ratio alone 32 of
 * them failed, and not one was a decoding fault: each flag was carried by one or
 * two keyframes on which something in the flight genuinely changed — the
 * governor engaging, a throttle cut moving four fields on one sample, an ESC
 * telemetry update, a heading wrapping 3599 -> 0. A flight's moments do not know
 * where the keyframes are either: of 112,517 step moments in those sessions,
 * 3.10% and 3.14% landed on one, against 3.13% by chance. But a step that does
 * land on one has 31x the leverage it would have on a delta frame, so on a field
 * that otherwise barely moves, one lucky moment IS the ratio.
 *
 * Setting the largest few keyframes aside cures that, and on its own it would
 * have hidden a real defect. TAG2_3S32 selector 3 mis-read only seven groups of
 * the reference log, so its excess was carried by two keyframes as well:
 * attitude[2] fell from 17.9x to below 2x once they were removed, and so did
 * axisP[1]. What tells the two apart is what the keyframe DOES. A mis-read
 * delta is carried forward until the next keyframe undoes it — axisP[1] jumped
 * 352 at a keyframe after its delta frames had moved it 353 the other way. A
 * genuine step is not undoing anything: govI was 0 at the keyframe before and 0
 * on the sample before, then 450.
 *
 * So a field is called out only when the excess has one of the two shapes a
 * delta defect leaves behind:
 *   - BROAD: it survives setting the largest keyframe jumps aside, because the
 *     defect corrupts every keyframe period the field moves in; or
 *   - REVERSING: the keyframes undo movement the delta frames made since the
 *     keyframe before, and that undoing alone clears the threshold.
 * An excess with neither shape is treated as a moment that landed on a keyframe.
 * It is still reported, with the sample it happened at, as `concentrated`.
 * Setting `concentrationKeyframes` to 0 gives back the ratio-only rule.
 *
 * It reports a measurement, never a diagnosis: which field, what ratio, how much
 * the field actually moved. What the wrong bits were is for a human to work out.
 */

/**
 * A field must move at least this much per I frame before a ratio means anything.
 *
 * A ratio is a quotient of two tiny numbers when a field barely moves, and then
 * it says nothing. Measured on real logs, 2026-10-03: the reference flight's ESC
 * capacity counter (EscCap) moves 0.0067 counts per I frame and reads 1.59x, and
 * in one session of a real dump the MCU temperature (Tmcu), whose whole range is
 * 36..39 and which changes five times in 91,850 samples, reads 7.75x. Both are
 * arithmetic, not evidence, and 0.05 counts per I frame excludes them. (The
 * 7.75x example used to be a 0..5 field in 30,000 samples, measured on a
 * simulator file the decoder now refuses; see docs/BLACKBOX_FORMAT_NOTES.md.)
 *
 * The floor gates the mean a field is called out on: the mean left after setting
 * the largest keyframe jumps aside, or the mean taken back at keyframes (see
 * `broad` and `reversing` below). Under the ratio-only rule every field that
 * carried a real defect cleared it, the smallest being attitude[0] under
 * TAG2_3S32 selector 3 at 0.105. Under this rule the narrowest defect still
 * called out, axisP[1] under the same selector, clears it on its taken-back mean
 * of 0.147.
 */
const DEFAULT_MOVEMENT_FLOOR = 0.05;

/**
 * Ratio at or above which a field is called out. Correct decoding sits near 1.
 *
 * Measured margin on the real 4.6 reference log (134,429 samples), on the ratio
 * alone: the worst correctly decoded field above the movement floor reads 1.16x,
 * and the defects read 346x, 33x, 17.9x, 5.0x and 2.2x. 2.0 sits in the empty
 * band between those two populations on that log. (This said 224,429 samples
 * across four logs until 2026-10-03; the other three were simulator files, not
 * firmware output.)
 *
 * The two real dumps do not show that empty band: 32 of their 109 sessions have
 * a field above the movement floor at 2x or more. Investigated 2026-10-03, every
 * one is a genuine step that landed on a keyframe — see the header above. The
 * same 2x is what each of the two shapes there must clear: over all 110 real
 * sessions the worst correctly decoded field reaches 1.59x broad and 1.63x
 * reversing, and the narrowest defect, selector 3 on axisP[1], reverses at
 * 4.41x. That selector's other two fields, attitude[2] (17.9x) and attitude[0]
 * (2.2x) on the ratio, clear neither shape and are no longer called out.
 */
const DEFAULT_RATIO_THRESHOLD = 2;

/** Below this many I-frame transitions the two means are not comparable. */
const DEFAULT_MIN_TRANSITIONS = 16;

/**
 * How many of the largest keyframe jumps may be a moment in the flight.
 *
 * Measured over 110 real sessions: each of the 52 field flags the ratio alone
 * raised was carried by at most two keyframes, and setting three aside leaves
 * the worst correctly decoded field at 1.59x. The broad defects barely notice —
 * TAG8_4S16 permuted stays at 10.0x and above, INCREMENT at 33.0x, TAG8_8SVB
 * reversed at 28.6x, AVERAGE_2 with floor at 9.96x — because they corrupt every
 * keyframe period, not three of them.
 */
const DEFAULT_CONCENTRATION_KEYFRAMES = 3;

/** Mean over `count`, against `interMean`, with the empty-denominator rule below. */
function ratioOf(sum, count, interMean) {
  const mean = count > 0 ? sum / count : 0;
  // A field that never moves on P frames but jumps at every I frame is the
  // purest form of this bug, so an empty denominator is a finding, not a skip.
  return {mean, ratio: interMean > 0 ? mean / interMean : (mean > 0 ? Infinity : 1)};
}

/**
 * Measures per-field continuity across I-frame boundaries.
 *
 * @param {object} input
 * @param {number[][]} input.samples             decoded samples, in log order
 * @param {number[]} input.intraSampleIndices    sample positions that came from an I frame
 * @param {{name: string}[]} input.fields        main-frame field list, index-aligned to samples
 * @param {object} [options]
 * @param {number} [options.ratioThreshold]      flag at or above this ratio
 * @param {number} [options.movementFloor]       ignore fields that barely move
 * @param {number} [options.minTransitions]      minimum transitions of each kind
 * @param {number} [options.concentrationKeyframes] largest keyframe jumps that
 *   may be moments in the flight rather than evidence about the decoder
 * @returns {{measured: boolean, reason?: string, fields: object[],
 *   flagged: object[], concentrated: object[]}}
 */
export function measureIntraFrameContinuity(input, options = {}) {
  const {samples, intraSampleIndices, fields} = input;
  const ratioThreshold = options.ratioThreshold ?? DEFAULT_RATIO_THRESHOLD;
  const movementFloor = options.movementFloor ?? DEFAULT_MOVEMENT_FLOOR;
  const minTransitions = options.minTransitions ?? DEFAULT_MIN_TRANSITIONS;
  const concentrationKeyframes = options.concentrationKeyframes ?? DEFAULT_CONCENTRATION_KEYFRAMES;

  if (!Array.isArray(samples) || samples.length < 2 || fields.length === 0) {
    return {measured: false, reason: 'not enough samples', fields: [], flagged: [], concentrated: []};
  }

  // Sample 0 has no predecessor, so it contributes no transition.
  const isIntra = new Uint8Array(samples.length);
  for (const index of intraSampleIndices ?? []) {
    if (index > 0 && index < samples.length) {
      isIntra[index] = 1;
    }
  }

  let intraTransitions = 0;
  for (let index = 1; index < samples.length; index += 1) {
    intraTransitions += isIntra[index];
  }
  const interTransitions = samples.length - 1 - intraTransitions;

  if (intraTransitions < minTransitions || interTransitions < minTransitions) {
    return {
      measured: false,
      reason: `only ${intraTransitions} I-frame and ${interTransitions} P-frame transitions`,
      fields: [],
      flagged: [],
      concentrated: []
    };
  }

  // Each keyframe with the absolute sample before it — the previous keyframe, or
  // sample 0 when the log opens on one. Between those two anchors only delta
  // frames moved the field, so their net movement is what the decoder CLAIMED
  // happened, and the keyframe is what did.
  const keyframes = [];
  const anchors = [];
  let lastAbsolute = (intraSampleIndices ?? []).some(index => index === 0) ? 0 : -1;
  for (let index = 1; index < samples.length; index += 1) {
    if (isIntra[index]) {
      keyframes.push(index);
      anchors.push(lastAbsolute);
      lastAbsolute = index;
    }
  }

  const fieldCount = fields.length;
  const intraSum = new Float64Array(fieldCount);
  const interSum = new Float64Array(fieldCount);

  for (let index = 1; index < samples.length; index += 1) {
    const current = samples[index];
    const previous = samples[index - 1];
    const target = isIntra[index] ? intraSum : interSum;

    for (let field = 0; field < fieldCount; field += 1) {
      // Absolute change only: direction is not evidence of anything here, and
      // summing signed deltas would cancel a sawtooth out to nothing.
      const delta = current[field] - previous[field];
      target[field] += delta < 0 ? -delta : delta;
    }
  }

  const measurements = [];
  for (let field = 0; field < fieldCount; field += 1) {
    const interMean = interSum[field] / interTransitions;
    const {mean: intraMean, ratio} = ratioOf(intraSum[field], intraTransitions, interMean);
    const moves = intraMean >= movementFloor;

    // The largest keyframe jumps, kept with where they happened so a person can
    // go and look; and how much of every keyframe's jump undoes the movement the
    // delta frames claimed since the anchor before it.
    const largest = [];
    let reversalSum = 0;
    for (let position = 0; position < keyframes.length; position += 1) {
      const at = keyframes[position];
      const anchor = anchors[position];
      const jump = samples[at][field] - samples[at - 1][field];
      const size = jump < 0 ? -jump : jump;
      const claimed = anchor >= 0 ? samples[at - 1][field] - samples[anchor][field] : 0;

      // Opposite signs: the keyframe is taking the delta frames' movement back.
      // Only the part it takes back counts — a heading that crept up 20 and then
      // wrapped 3599 -> 0 on a keyframe took back 20, not 3599.
      if (jump * claimed < 0) {
        const taken = claimed < 0 ? -claimed : claimed;
        reversalSum += taken < size ? taken : size;
      }

      if (concentrationKeyframes > 0 &&
          (largest.length < concentrationKeyframes || size > largest[largest.length - 1].size)) {
        if (largest.length === concentrationKeyframes) {
          largest.pop();
        }
        let slot = largest.length;
        while (slot > 0 && largest[slot - 1].size < size) {
          slot -= 1;
        }
        largest.splice(slot, 0, {sampleIndex: at, size});
      }
    }

    const largestSum = largest.reduce((sum, entry) => sum + entry.size, 0);
    // Neither mean can exceed `intraMean`: setting the largest jumps aside cannot
    // raise an average, and no keyframe takes back more than it jumps. So both
    // shapes below imply the field moves.
    const trimmed = ratioOf(intraSum[field] - largestSum, intraTransitions - largest.length, interMean);
    const reversal = ratioOf(reversalSum, intraTransitions, interMean);
    const broad = trimmed.mean >= movementFloor && trimmed.ratio >= ratioThreshold;
    const reversing = reversal.mean >= movementFloor && reversal.ratio >= ratioThreshold;
    const flagged = broad || reversing;

    measurements.push({
      name: fields[field].name,
      index: field,
      intraMean,
      interMean,
      ratio,
      trimmedRatio: trimmed.ratio,
      trimmedMean: trimmed.mean,
      reversalRatio: reversal.ratio,
      reversalMean: reversal.mean,
      broad,
      reversing,
      largestKeyframeJumps: largest.filter(entry => entry.size > 0),
      belowMovementFloor: !moves,
      // Over the threshold on the ratio alone, but carried by a few keyframes
      // that take back too little to have the shape of a mis-read: the shape of
      // a moment in the flight landing on a keyframe. A mis-read confined to a
      // keyframe or two can share it (attitude[2] under TAG2_3S32 selector 3).
      concentrated: moves && ratio >= ratioThreshold && !flagged,
      flagged
    });
  }

  const byRatio = (left, right) => right.ratio - left.ratio;
  return {
    measured: true,
    intraTransitions,
    interTransitions,
    ratioThreshold,
    movementFloor,
    concentrationKeyframes,
    fields: measurements,
    flagged: measurements.filter(entry => entry.flagged).sort(byRatio),
    concentrated: measurements.filter(entry => entry.concentrated).sort(byRatio)
  };
}
