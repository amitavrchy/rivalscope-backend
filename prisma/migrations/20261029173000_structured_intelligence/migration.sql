-- CreateTable
CREATE TABLE "Feature" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "normalizedName" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Feature_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CompetitorFeature" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "competitorId" UUID NOT NULL,
    "featureId" UUID NOT NULL,
    "sourceId" UUID NOT NULL,
    "quotation" TEXT NOT NULL,
    "observedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CompetitorFeature_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PricingHistory" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "pricingPlanId" UUID NOT NULL,
    "amount" DECIMAL(12,2),
    "currency" TEXT,
    "interval" TEXT,
    "sourceUrl" TEXT NOT NULL,
    "retrievedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PricingHistory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SwotItem" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "findingId" UUID NOT NULL,
    "category" TEXT NOT NULL,

    CONSTRAINT "SwotItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MarketOpportunity" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "findingId" UUID NOT NULL,

    CONSTRAINT "MarketOpportunity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Comparison" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "competitorIds" UUID[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Comparison_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Feature_organizationId_id_key" ON "Feature"("organizationId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "Feature_organizationId_normalizedName_key" ON "Feature"("organizationId", "normalizedName");

-- CreateIndex
CREATE UNIQUE INDEX "CompetitorFeature_organizationId_competitorId_featureId_key" ON "CompetitorFeature"("organizationId", "competitorId", "featureId");

-- CreateIndex
CREATE INDEX "PricingHistory_organizationId_pricingPlanId_retrievedAt_idx" ON "PricingHistory"("organizationId", "pricingPlanId", "retrievedAt");

-- CreateIndex
CREATE UNIQUE INDEX "SwotItem_organizationId_findingId_key" ON "SwotItem"("organizationId", "findingId");

-- CreateIndex
CREATE UNIQUE INDEX "MarketOpportunity_organizationId_findingId_key" ON "MarketOpportunity"("organizationId", "findingId");

-- CreateIndex
CREATE INDEX "Comparison_organizationId_projectId_idx" ON "Comparison"("organizationId", "projectId");

-- CreateIndex
CREATE UNIQUE INDEX "PricingPlan_organizationId_id_key" ON "PricingPlan"("organizationId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "PricingPlan_organizationId_competitorId_name_key" ON "PricingPlan"("organizationId", "competitorId", "name");

-- AddForeignKey
ALTER TABLE "CompetitorFeature" ADD CONSTRAINT "CompetitorFeature_organizationId_competitorId_fkey" FOREIGN KEY ("organizationId", "competitorId") REFERENCES "Competitor"("organizationId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CompetitorFeature" ADD CONSTRAINT "CompetitorFeature_organizationId_featureId_fkey" FOREIGN KEY ("organizationId", "featureId") REFERENCES "Feature"("organizationId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CompetitorFeature" ADD CONSTRAINT "CompetitorFeature_organizationId_sourceId_fkey" FOREIGN KEY ("organizationId", "sourceId") REFERENCES "Source"("organizationId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PricingHistory" ADD CONSTRAINT "PricingHistory_organizationId_pricingPlanId_fkey" FOREIGN KEY ("organizationId", "pricingPlanId") REFERENCES "PricingPlan"("organizationId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SwotItem" ADD CONSTRAINT "SwotItem_organizationId_findingId_fkey" FOREIGN KEY ("organizationId", "findingId") REFERENCES "Finding"("organizationId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MarketOpportunity" ADD CONSTRAINT "MarketOpportunity_organizationId_findingId_fkey" FOREIGN KEY ("organizationId", "findingId") REFERENCES "Finding"("organizationId", "id") ON DELETE CASCADE ON UPDATE CASCADE;
