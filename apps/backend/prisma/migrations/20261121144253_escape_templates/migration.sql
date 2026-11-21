-- CreateEnum
CREATE TYPE "EscapeTemplateStatus" AS ENUM ('draft', 'published', 'archived');

-- CreateTable
CREATE TABLE "escape_templates" (
    "id" CHAR(26) NOT NULL,
    "owner_id" CHAR(26) NOT NULL,
    "title" TEXT NOT NULL,
    "status" "EscapeTemplateStatus" NOT NULL DEFAULT 'draft',
    "content" JSONB NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "escape_templates_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "escape_templates_owner_id_idx" ON "escape_templates"("owner_id");

-- AddForeignKey
ALTER TABLE "escape_templates" ADD CONSTRAINT "escape_templates_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;
