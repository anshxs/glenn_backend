// Commission tier: <10 hosted → 3% | 10–24 → 4% | 25–49 → 4.5% | ≥50 → 5%
export function defaultOrganiserCommission(hostedCount: number): number {
  if (hostedCount < 10) return 3;
  if (hostedCount < 25) return 4;
  if (hostedCount < 50) return 4.5;
  return 5;
}
