export const shouldScrollDetailedStatus = (
  previousAncestors: number | undefined,
  ancestors: number | undefined,
) =>
  typeof previousAncestors === 'number' &&
  typeof ancestors === 'number' &&
  previousAncestors < ancestors;
