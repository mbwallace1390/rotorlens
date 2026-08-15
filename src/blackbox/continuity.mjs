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
 * |Δ| everywhere else. Correct decoding gives ≈1. On the real 4.6 log the three
 * defects gave 33x (loopIteration), 17.9x (attitude[2]) and 5.0x (axisP[1]).
 *
 * It reports a measurement, never a diagnosis: which field, what ratio, how much
 * the field actually moved. What the wrong bits were is for a human to work out.
 */

/**
 * A field must move at least this much per I frame before a ratio means anything.
 *
 * A ratio is a quotient of two tiny numbers when a field barely moves, and then
 * it says nothing: a monotonic ESC capacity counter that ticks 28 times in a
 * whole flight reads 1.59x, and a field whose entire range is 0..5 and which
 * moves five times in 30,000 samples reads 7.75x. Both are arithmetic, not
 * evidence. 0.05 counts per I frame excludes those while keeping every field
 * that carried a real defect: the smallest was axisP[1] at 0.165.
 */
const DEFAULT_MOVEMENT_FLOOR = 0.05;

/**
 * Ratio at or above which a field is called out. Correct decoding sits near 1.
 *
 * Measured margin: across the real 4.6 log and three third-party logs — 224,429
 * samples in total — the worst correctly decoded field above the movement floor
 * reads 1.16x. The defects read 33x, 17.9x, 5.0x and 2.2x. 2.0 sits in the empty
 * band between those two populations.
 */
const DEFAULT_RATIO_THRESHOLD = 2;

/** Below this many I-frame transitions the two means are not comparable. */
const DEFAULT_MIN_TRANSITIONS = 16;

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
 * @returns {{measured: boolean, reason?: string, fields: object[], flagged: object[]}}
 */
export function measureIntraFrameContinuity(input, options = {}) {
  const {samples, intraSampleIndices, fields} = input;
  const ratioThreshold = options.ratioThreshold ?? DEFAULT_RATIO_THRESHOLD;
  const movementFloor = options.movementFloor ?? DEFAULT_MOVEMENT_FLOOR;
  const minTransitions = options.minTransitions ?? DEFAULT_MIN_TRANSITIONS;

  if (!Array.isArray(samples) || samples.length < 2 || fields.length === 0) {
    return {measured: false, reason: 'not enough samples', fields: [], flagged: []};
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
      flagged: []
    };
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
    const intraMean = intraSum[field] / intraTransitions;
    const interMean = interSum[field] / interTransitions;
    // A field that never moves on P frames but jumps at every I frame is the
    // purest form of this bug, so an empty denominator is a finding, not a skip.
    const ratio = interMean > 0 ? intraMean / interMean : (intraMean > 0 ? Infinity : 1);
    const moves = intraMean >= movementFloor;

    measurements.push({
      name: fields[field].name,
      index: field,
      intraMean,
      interMean,
      ratio,
      belowMovementFloor: !moves,
      flagged: moves && ratio >= ratioThreshold
    });
  }

  return {
    measured: true,
    intraTransitions,
    interTransitions,
    ratioThreshold,
    movementFloor,
    fields: measurements,
    flagged: measurements
      .filter(entry => entry.flagged)
      .sort((left, right) => right.ratio - left.ratio)
  };
}
