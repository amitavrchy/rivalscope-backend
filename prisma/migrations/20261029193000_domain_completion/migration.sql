BEGIN;
-- CreateTable
CREATE TABLE "Permission" (
    "id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "description" TEXT NOT NULL,

    CONSTRAINT "Permission_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RolePermission" (
    "id" UUID NOT NULL,
    "role" "Role" NOT NULL,
    "permissionId" UUID NOT NULL,

    CONSTRAINT "RolePermission_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Entitlement" (
    "id" UUID NOT NULL,
    "planId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "value" INTEGER NOT NULL,

    CONSTRAINT "Entitlement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UsageEvent" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "ledgerId" UUID NOT NULL,
    "category" TEXT NOT NULL,
    "units" INTEGER NOT NULL,
    "referenceId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UsageEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Metric" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "period" DATE NOT NULL,
    "value" DECIMAL(20,6) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Metric_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProjectCompetitor" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "competitorId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProjectCompetitor_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AlertRule" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "monitorId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "phrase" TEXT NOT NULL,
    "condition" TEXT NOT NULL,
    "severity" TEXT NOT NULL DEFAULT 'INFO',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AlertRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Alert" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "ruleId" UUID NOT NULL,
    "changeId" UUID NOT NULL,
    "severity" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Alert_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Permission_key_key" ON "Permission"("key");

-- CreateIndex
CREATE UNIQUE INDEX "RolePermission_role_permissionId_key" ON "RolePermission"("role", "permissionId");

-- CreateIndex
CREATE UNIQUE INDEX "Entitlement_planId_key_key" ON "Entitlement"("planId", "key");

-- CreateIndex
CREATE UNIQUE INDEX "UsageEvent_ledgerId_key" ON "UsageEvent"("ledgerId");

-- CreateIndex
CREATE INDEX "UsageEvent_organizationId_createdAt_idx" ON "UsageEvent"("organizationId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "UsageEvent_organizationId_ledgerId_key" ON "UsageEvent"("organizationId", "ledgerId");

-- CreateIndex
CREATE UNIQUE INDEX "Metric_organizationId_name_period_key" ON "Metric"("organizationId", "name", "period");

-- CreateIndex
CREATE UNIQUE INDEX "ProjectCompetitor_organizationId_projectId_competitorId_key" ON "ProjectCompetitor"("organizationId", "projectId", "competitorId");

-- CreateIndex
CREATE INDEX "AlertRule_organizationId_monitorId_idx" ON "AlertRule"("organizationId", "monitorId");

-- CreateIndex
CREATE UNIQUE INDEX "AlertRule_organizationId_id_key" ON "AlertRule"("organizationId", "id");

-- CreateIndex
CREATE INDEX "Alert_organizationId_createdAt_idx" ON "Alert"("organizationId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Alert_organizationId_ruleId_changeId_key" ON "Alert"("organizationId", "ruleId", "changeId");

-- CreateIndex
CREATE UNIQUE INDEX "ChangeEvent_organizationId_id_key" ON "ChangeEvent"("organizationId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "CreditLedger_organizationId_id_key" ON "CreditLedger"("organizationId", "id");

-- AddForeignKey
ALTER TABLE "RolePermission" ADD CONSTRAINT "RolePermission_permissionId_fkey" FOREIGN KEY ("permissionId") REFERENCES "Permission"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Entitlement" ADD CONSTRAINT "Entitlement_planId_fkey" FOREIGN KEY ("planId") REFERENCES "Plan"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UsageEvent" ADD CONSTRAINT "UsageEvent_organizationId_ledgerId_fkey" FOREIGN KEY ("organizationId", "ledgerId") REFERENCES "CreditLedger"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UsageEvent" ADD CONSTRAINT "UsageEvent_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Metric" ADD CONSTRAINT "Metric_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProjectCompetitor" ADD CONSTRAINT "ProjectCompetitor_organizationId_projectId_fkey" FOREIGN KEY ("organizationId", "projectId") REFERENCES "Project"("organizationId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProjectCompetitor" ADD CONSTRAINT "ProjectCompetitor_organizationId_competitorId_fkey" FOREIGN KEY ("organizationId", "competitorId") REFERENCES "Competitor"("organizationId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AlertRule" ADD CONSTRAINT "AlertRule_organizationId_monitorId_fkey" FOREIGN KEY ("organizationId", "monitorId") REFERENCES "Monitor"("organizationId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Alert" ADD CONSTRAINT "Alert_organizationId_ruleId_fkey" FOREIGN KEY ("organizationId", "ruleId") REFERENCES "AlertRule"("organizationId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Alert" ADD CONSTRAINT "Alert_organizationId_changeId_fkey" FOREIGN KEY ("organizationId", "changeId") REFERENCES "ChangeEvent"("organizationId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

INSERT INTO "Permission" (id,key,description)
SELECT gen_random_uuid(),key,'Workspace '||key||' permission'
FROM unnest(ARRAY['read','research','edit','team','billing','integrations','owner']) AS key;
INSERT INTO "RolePermission" (id,role,"permissionId")
SELECT gen_random_uuid(),r.role::"Role",p.id FROM "Permission" p CROSS JOIN
(VALUES ('OWNER',ARRAY['read','research','edit','team','billing','integrations','owner']),('ADMIN',ARRAY['read','research','edit','team','integrations']),('ANALYST',ARRAY['read','research']),('EDITOR',ARRAY['read','edit']),('VIEWER',ARRAY['read']),('BILLING_MANAGER',ARRAY['billing'])) r(role,keys)
WHERE p.key=ANY(r.keys);
INSERT INTO "Entitlement" (id,"planId",key,value)
SELECT gen_random_uuid(),p.id,e.key,e.value FROM "Plan" p CROSS JOIN LATERAL
(VALUES ('monthlyCredits',p."monthlyCredits"),('projectLimit',p."projectLimit"),('seatLimit',p."seatLimit"),('monitorLimit',p."monitorLimit")) e(key,value);
INSERT INTO "ProjectCompetitor" (id,"organizationId","projectId","competitorId")
SELECT gen_random_uuid(),"organizationId","projectId",id FROM "Competitor";
INSERT INTO "UsageEvent" (id,"organizationId","ledgerId",category,units,"referenceId","createdAt")
SELECT gen_random_uuid(),"organizationId",id,CASE WHEN kind='SETTLE' THEN 'RESEARCH' WHEN "idempotencyKey" LIKE 'chat-%' THEN 'COPILOT' ELSE 'MONITORING' END,-amount,"referenceId","createdAt"
FROM "CreditLedger" WHERE kind IN ('SETTLE','CONSUME') AND amount<=0;
ALTER TABLE "UsageEvent" ADD CONSTRAINT "UsageEvent_units_nonnegative" CHECK (units>=0);
ALTER TABLE "Entitlement" ADD CONSTRAINT "Entitlement_value_nonnegative" CHECK (value>=0);
CREATE TRIGGER "UsageEvent_immutable" BEFORE UPDATE OR DELETE ON "UsageEvent" FOR EACH ROW EXECUTE FUNCTION reject_immutable_mutation();
DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['UsageEvent','Metric','ProjectCompetitor','AlertRule','Alert'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',table_name);
    EXECUTE format('CREATE POLICY tenant_reader_scope ON %I FOR SELECT TO rivalscope_tenant_reader USING ("organizationId" = NULLIF(current_setting(''app.organization_id'',true),'''')::uuid)',table_name);
    EXECUTE format('GRANT SELECT ON %I TO rivalscope_tenant_reader',table_name);
  END LOOP;
END $$;

COMMIT;
