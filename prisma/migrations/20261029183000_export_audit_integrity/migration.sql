-- AlterTable
ALTER TABLE "AuditLog" ADD COLUMN     "details" JSONB;

-- CreateTable
CREATE TABLE "ReportExport" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "reportId" UUID NOT NULL,
    "actorId" UUID NOT NULL,
    "format" TEXT NOT NULL,
    "bytes" INTEGER NOT NULL,
    "contentHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReportExport_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ReportExport_organizationId_reportId_createdAt_idx" ON "ReportExport"("organizationId", "reportId", "createdAt");

-- AddForeignKey
ALTER TABLE "Feature" ADD CONSTRAINT "Feature_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Comparison" ADD CONSTRAINT "Comparison_organizationId_projectId_fkey" FOREIGN KEY ("organizationId", "projectId") REFERENCES "Project"("organizationId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReportExport" ADD CONSTRAINT "ReportExport_organizationId_reportId_fkey" FOREIGN KEY ("organizationId", "reportId") REFERENCES "Report"("organizationId", "id") ON DELETE CASCADE ON UPDATE CASCADE;
