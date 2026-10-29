import { z } from 'zod';
import type { OpenAPIObject, SchemaObject, OperationObject } from '@nestjs/swagger';
import { registerSchema } from './auth.js';
import { projectSchema } from './projects.js';
import { researchOptions, sourceUrl } from './research-schemas.js';
import { reauthentication } from './account-security.js';
import { alertRuleSchema } from './alert-rules.js';

const roles=z.enum(['ADMIN','ANALYST','EDITOR','VIEWER','BILLING_MANAGER']);
const plan=z.object({planId:z.enum(['starter','pro','agency','enterprise']),interval:z.enum(['monthly','annual'])}).strict();
const schemas:Record<string,z.ZodType>={
  'post /api/organizations/{orgId}/alert-rules':alertRuleSchema,
  'patch /api/organizations/{orgId}/alert-rules/{id}':alertRuleSchema.omit({monitorId:true}).partial().extend({enabled:z.boolean().optional()}).strict(),
  'post /api/auth/register':registerSchema,
  'post /api/auth/login':z.object({email:z.email(),password:z.string().min(1).max(128)}).strict(),
  'post /api/auth/forgot-password':z.object({email:z.email()}).strict(),
  'post /api/auth/resend-verification':z.object({email:z.email()}).strict(),
  'post /api/auth/verify':z.object({token:z.string().min(40).max(100)}).strict(),
  'post /api/auth/reset-password':z.object({token:z.string().min(40).max(100),password:z.string().min(12).max(128)}).strict(),
  'post /api/auth/mfa':z.object({challenge:z.string(),code:z.string()}).strict(),
  'post /api/auth/google/link':reauthentication,
  'patch /api/account/profile':z.object({name:z.string().min(2).max(80)}).strict(),
  'post /api/account/mfa/setup':reauthentication,
  'post /api/account/mfa/enable':reauthentication,
  'post /api/account/mfa/disable':reauthentication,
  'post /api/account/mfa/recovery-codes':reauthentication,
  'post /api/organizations':z.object({name:z.string().min(2).max(100)}).strict(),
  'post /api/organizations/{id}/transfer-ownership':reauthentication.extend({userId:z.uuid()}).strict(),
  'post /api/organizations/{id}/invitations':z.object({email:z.email(),role:roles}).strict(),
  'patch /api/organizations/{id}/team/{memberId}':z.object({role:roles}).strict(),
  'post /api/organizations/invitations/accept':z.object({token:z.string().min(40).max(100)}).strict(),
  'post /api/organizations/{orgId}/projects':projectSchema,
  'patch /api/organizations/{orgId}/projects/{id}':projectSchema.partial().extend({website:z.url().nullable().optional(),industry:z.string().max(100).nullable().optional(),targetMarket:z.string().max(300).nullable().optional()}).strict(),
  'post /api/organizations/{orgId}/projects/{projectId}/research/estimate':researchOptions,
  'post /api/organizations/{orgId}/projects/{projectId}/research':researchOptions.extend({idempotencyKey:z.string().min(8).max(100).regex(/^[a-zA-Z0-9-]+$/)}).strict(),
  'post /api/organizations/{orgId}/projects/{projectId}/copilot':z.object({question:z.string().min(5).max(2000),threadId:z.uuid().optional()}).strict(),
  'post /api/organizations/{orgId}/projects/{projectId}/comments':z.object({body:z.string().min(1).max(4000)}).strict(),
  'post /api/organizations/{orgId}/projects/{projectId}/bookmarks':z.object({note:z.string().max(2000)}).strict(),
  'post /api/organizations/{orgId}/projects/{projectId}/members':z.object({userId:z.uuid()}).strict(),
  'post /api/organizations/{orgId}/projects/{projectId}/intelligence/comparisons':z.object({name:z.string().min(2).max(100),competitorIds:z.array(z.uuid()).min(1).max(8)}).strict(),
  'post /api/organizations/{orgId}/reports/{id}/shares':z.object({audience:z.enum(['WORKSPACE','PUBLIC']),days:z.number().int().min(1).max(30),password:z.string().min(12).max(128).optional(),confirmPublic:z.boolean().default(false)}).strict(),
  'post /api/shared/{token}':z.object({password:z.string().max(128).optional()}).strict(),
  'post /api/organizations/{orgId}/monitors':z.object({projectId:z.uuid(),url:sourceUrl,everyHours:z.number().int().min(6).max(168).default(24)}).strict(),
  'patch /api/organizations/{orgId}/monitors/{id}':z.object({enabled:z.boolean(),everyHours:z.number().int().min(6).max(168).optional()}).strict(),
  'post /api/organizations/{orgId}/billing/checkout':plan,
  'post /api/organizations/{orgId}/billing/change-plan':plan,
  'post /api/organizations/{orgId}/billing/credit-packs/checkout':z.object({packId:z.string().min(1).max(80)}).strict(),
  'post /api/organizations/{orgId}/billing/sandbox/complete':z.object({checkoutId:z.uuid()}).strict(),
  'post /api/organizations/{orgId}/billing/sandbox/complete-addon':z.object({purchaseId:z.uuid()}).strict(),
  'post /api/organizations/{orgId}/api-keys':z.object({name:z.string().min(2).max(100),scopes:z.array(z.enum(['projects:read','reports:read'])).min(1).max(2),days:z.number().int().min(1).max(365).default(90)}).strict(),
  'post /api/organizations/{orgId}/webhooks':z.object({url:sourceUrl,events:z.array(z.enum(['research.completed','monitor.changed'])).min(1).max(2)}).strict(),
  'patch /api/organizations/{orgId}/webhooks/{id}':z.object({enabled:z.boolean()}).strict(),
  'post /api/organizations/{orgId}/notification-preferences':z.object({emailEnabled:z.boolean(),frequency:z.enum(['INSTANT','DAILY','WEEKLY'])}).strict(),
  'post /api/organizations/{orgId}/notification-integrations':z.object({provider:z.enum(['slack','discord']),url:z.url().max(2048)}).strict(),
  'post /api/privacy/account/delete':reauthentication.extend({confirmation:z.literal('DELETE MY ACCOUNT')}).strict(),
  'post /api/privacy/organizations/{id}/delete':reauthentication.extend({confirmation:z.literal('DELETE THIS WORKSPACE')}).strict(),
  'post /api/admin/organizations/{id}/credits':z.object({amount:z.number().int().min(-100000).max(100000),reason:z.string().min(10).max(300)}).strict(),
  'patch /api/admin/flags/{id}':z.object({enabled:z.boolean(),description:z.string().min(3).max(300)}).strict(),
  'patch /api/admin/settings/{id}':z.object({value:z.union([z.string().max(1000),z.number().int().min(1000).max(10000000)])}).strict(),
  'patch /api/admin/users/{id}/platform-role':reauthentication.extend({platformAdmin:z.boolean()}).strict(),
};

/** Add runtime-schema-backed request contracts and explicit auth to reflection output. */
export function installApiContracts(document:OpenAPIObject) {
  document.openapi='3.1.0';document.components??={};document.components.securitySchemes??={};
  document.components.securitySchemes.customerApiKey={type:'http',scheme:'bearer',description:'Workspace API key; read scope and 60 requests/minute per key required.'};
  for(const [path,item] of Object.entries(document.paths))for(const method of ['get','post','patch','delete'] as const){
    const op=item?.[method] as OperationObject|undefined;if(!op)continue;
    const customer=path.startsWith('/api/v1/');const protectedPath=/^\/api\/(?:organizations|account|privacy|admin)(?:\/|$)/.test(path)||['/api/auth/me','/api/auth/logout','/api/auth/logout-all','/api/auth/refresh','/api/auth/google/link'].includes(path);
    if(customer)op.security=[{customerApiKey:[]}];else if(protectedPath)op.security=[{cookie:[]}];
    if(method!=='get'&&!customer&&path!=='/api/billing/webhook')op.parameters=[...(op.parameters??[]),{name:'Origin',in:'header',required:true,schema:{type:'string'},description:'Configured browser application origin; required for CSRF protection.'}];
    const schema=schemas[`${method} ${path}`];
    if(schema)op.requestBody={required:true,content:{'application/json':{schema:z.toJSONSchema(schema,{io:'input',unrepresentable:'any'}) as SchemaObject}}};
    else if(method!=='get'&&path!=='/api/billing/webhook')op.requestBody={required:false,content:{'application/json':{schema:{type:'object'}}}};
    if(path.startsWith('/api/admin'))op.description=[op.description,'Verified platform administrator required; workspace administrator is a separate role.'].filter(Boolean).join(' ');
    for(const [status,description] of Object.entries({'400':'Invalid request','401':'Authentication required or expired','403':'Permission, origin, entitlement or budget denied','404':'Record unavailable in the authorized tenant','429':'Request limit reached','503':'Provider or dependency requires setup or is unavailable'}))op.responses[status]??={description};
  }
  return document;
}
