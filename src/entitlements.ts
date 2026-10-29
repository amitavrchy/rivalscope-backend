/** One policy for research, project creation and scheduled work. Saved data stays readable. */
export function hasActiveEntitlement(subscription: { status: string; currentPeriodEnd: Date | null; graceEndsAt: Date | null } | null, now = new Date()): boolean {
  if (!subscription) return false;
  if (subscription.status === 'past_due') return !!subscription.graceEndsAt && subscription.graceEndsAt > now;
  return ['active', 'trialing'].includes(subscription.status) && (!subscription.currentPeriodEnd || subscription.currentPeriodEnd > now);
}
type LimitKey='monthlyCredits'|'projectLimit'|'seatLimit'|'monitorLimit';
export function planLimit(plan:Record<LimitKey,number>&{entitlements?:{key:string;value:number}[]},key:LimitKey):number {
  return plan.entitlements?.find(item=>item.key===key)?.value??plan[key];
}
