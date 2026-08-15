/**
 * Blackbox field predictors.
 *
 * Each field's encoded value is a residual against a prediction derived from
 * earlier frames or from header constants. Predictor identifiers come from the
 * log header (`H Field P predictor:...`) and are format facts.
 *
 * Predictions are computed from a small explicit context object rather than
 * from decoder-wide mutable state, so a bad frame can be discarded without
 * leaving the predictor history poisoned.
 */

import {DecodeError, DecodeErrorCode} from './errors.mjs';

export const Predictor = Object.freeze({
  NONE: 0,
  PREVIOUS: 1,
  STRAIGHT_LINE: 2,
  AVERAGE_2: 3,
  MIN_THROTTLE: 4,
  MOTOR_0: 5,
  INCREMENT: 6,
  HOME_COORD: 7,
  CONST_1500: 8,
  VBAT_REF: 9,
  LAST_MAIN_FRAME_TIME: 10,
  MIN_MOTOR: 11
});

/**
 * @param {number} predictor
 * @param {object} context
 * @param {number} context.previous       same field, previous frame
 * @param {number} context.previous2      same field, two frames back
 * @param {number[]} context.current      values decoded so far in this frame
 * @param {object} context.constants      header-derived constants
 * @param {number} context.motor0Index    field index of motor[0], or -1
 * @param {number} context.homeCoord      matching GPS home coordinate, or 0
 */
export function predict(predictor, context) {
  const {previous, previous2, current, constants} = context;

  switch (predictor) {
    case Predictor.NONE:
      return 0;

    case Predictor.PREVIOUS:
      return previous;

    case Predictor.STRAIGHT_LINE:
      // Linear extrapolation: the delta from two frames back, carried forward.
      return 2 * previous - previous2;

    case Predictor.AVERAGE_2:
      return Math.trunc((previous + previous2) / 2);

    case Predictor.MIN_THROTTLE:
      return constants.minthrottle;

    case Predictor.MOTOR_0:
      return context.motor0Index >= 0 ? current[context.motor0Index] ?? 0 : 0;

    case Predictor.INCREMENT:
      // Step is per session, not universally 1: only every Nth loop iteration is
      // logged. See `incrementStep` in headers.mjs for what a wrong step costs.
      return previous + (constants.incrementStep ?? 1);

    case Predictor.HOME_COORD:
      return context.homeCoord ?? 0;

    case Predictor.CONST_1500:
      return 1500;

    case Predictor.VBAT_REF:
      return constants.vbatref;

    case Predictor.LAST_MAIN_FRAME_TIME:
      return constants.lastMainFrameTime;

    case Predictor.MIN_MOTOR:
      return constants.minmotor;

    default:
      throw new DecodeError(
        DecodeErrorCode.UNSUPPORTED_PREDICTOR,
        `Unsupported field predictor ${predictor}`,
        {predictor}
      );
  }
}
