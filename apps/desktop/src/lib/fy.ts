// Indian financial year (Apr 1 – Mar 31) helpers.
export interface FY {
  label: string; // e.g. "2026-27"
  from: string; // YYYY-04-01
  to: string; // (YYYY+1)-03-31
}

function startYearOf(d: Date): number {
  const y = d.getFullYear();
  const m = d.getMonth() + 1; // 1–12
  return m >= 4 ? y : y - 1;
}

export function fyFromStartYear(startYear: number): FY {
  return {
    label: `${startYear}-${String((startYear + 1) % 100).padStart(2, "0")}`,
    from: `${startYear}-04-01`,
    to: `${startYear + 1}-03-31`,
  };
}

export function currentFY(): FY {
  return fyFromStartYear(startYearOf(new Date()));
}

/** FYs from the books-begin date (or 2 years back) up to the current FY, newest first. */
export function fyList(beginDate?: string): FY[] {
  const cur = startYearOf(new Date());
  let start = cur - 2;
  if (beginDate) {
    const d = new Date(beginDate);
    if (!Number.isNaN(d.getTime())) start = startYearOf(d);
  }
  const out: FY[] = [];
  for (let y = cur; y >= start; y--) out.push(fyFromStartYear(y));
  return out;
}
