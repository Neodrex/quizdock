-- CreateTable
CREATE TABLE "escape_site_hosts" (
    "oidc_subject" TEXT NOT NULL,
    "granted_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "escape_site_hosts_pkey" PRIMARY KEY ("oidc_subject")
);
