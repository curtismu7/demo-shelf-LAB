// The packed range for NEW standalone apps. One port per app, handed out in order, so ports stay a small resource.
// Existing apps keep the ports they have (they sit below this range); only new apps are allocated here.
export const PACKED_RANGE = { lo: 7800, hi: 7999 };

// The next `count` free ports in the packed range, lowest first. `used` is any iterable of port numbers
// (the registry's ports). Throws when the range cannot supply `count` ports.
export function nextFreePorts(used, count = 1, range = PACKED_RANGE) {
  if (!Number.isInteger(count) || count < 1) throw new Error('count must be a whole number of 1 or more');
  const taken = new Set([...used].map(Number));
  const free = [];
  for (let p = range.lo; p <= range.hi && free.length < count; p += 1) if (!taken.has(p)) free.push(p);
  if (free.length < count) throw new Error(`the packed range ${range.lo}-${range.hi} has only ${free.length} free port(s), ${count} asked for`);
  return free;
}

export function packedRangeSummary(used, range = PACKED_RANGE) {
  const taken = new Set([...used].map(Number));
  let inUse = 0;
  for (let p = range.lo; p <= range.hi; p += 1) if (taken.has(p)) inUse += 1;
  const size = range.hi - range.lo + 1;
  return { size, inUse, free: size - inUse };
}
