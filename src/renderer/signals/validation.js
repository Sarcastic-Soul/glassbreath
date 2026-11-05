// Validation code -> readable name. Table mirrors the SDK's ValidationCode
// enum; pass the SDK's own table to stay in sync with future codes.
export const DEFAULT_VALIDATION_CODES = Object.freeze({
  kOk: 0, kNoFaceFound: 1, kMultipleFacesFound: 2, kFaceNotCentered: 3, kFaceSizeOutOfRange: 4,
  kTooDark: 5, kTooBright: 6, kChestNotVisible: 7, kCameraTuning: 10, kFrameRateTooLow: 11,
  kExcessiveMotion: 12, kFaceTooClose: 13, kFaceTooFar: 14, kFaceTooHigh: 15, kFaceTooLow: 16,
  kFaceNotForward: 17,
});

export function makeValidationNamer(table = DEFAULT_VALIDATION_CODES) {
  const names = new Map(Object.entries(table).map(([k, v]) => [v, k.replace(/^k/, '')]));
  return (code) => names.get(Number(code)) ?? `Unknown${code}`;
}

export const validationName = makeValidationNamer();

/** Builds the `validation` event payload. */
export function validationPayload(code, hint, namer = validationName) {
  const c = Number(code);
  return { code: c, name: namer(c), hint: typeof hint === 'string' ? hint : '', ok: c === 0 };
}
