import type { Role } from './generated/prisma/client.js';
export type Permission = 'read'|'research'|'edit'|'team'|'billing'|'integrations'|'owner';
export const ROLE_PERMISSIONS:Record<Role,Permission[]>={OWNER:['read','research','edit','team','billing','integrations','owner'],ADMIN:['read','research','edit','team','integrations'],ANALYST:['read','research'],EDITOR:['read','edit'],VIEWER:['read'],BILLING_MANAGER:['billing']};
export function can(role:string,permission:Permission){return (ROLE_PERMISSIONS as Record<string,Permission[]>)[role]?.includes(permission)??false;}
