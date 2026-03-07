export type ServiceType = "backend" | "frontend";
export type AppGroup = "platform" | "mark8ly";
export type ServiceLang = "go" | "nextjs";
export type MigrationStrategy = "golang-migrate" | "gorm-auto" | "none";

export interface ServiceConfig {
  name: string;
  displayName: string;
  type: ServiceType;
  lang: ServiceLang;
  appGroup: AppGroup;
  repo: string;
  buildWorkflow: string;
  releaseWorkflow: string;
  hasDb: boolean;
  migration: MigrationStrategy;
  usesGoShared: boolean;
  sidecar: "cloud-sql-proxy" | "none";
  invokes: string[];
  publishesEvents: boolean;
  pubsubTopic: string;
  secrets: string[];
  storageApps: string[];
  managed: boolean;
}

const OWNER = "tesserix";

function svc(
  name: string,
  displayName: string,
  appGroup: AppGroup,
  opts: Partial<Omit<ServiceConfig, "name" | "displayName" | "appGroup" | "repo" | "buildWorkflow" | "releaseWorkflow">> = {}
): ServiceConfig {
  return {
    name,
    displayName,
    type: opts.type ?? "backend",
    lang: opts.lang ?? "go",
    appGroup,
    repo: `${OWNER}/${name}`,
    buildWorkflow: "ci.yml",
    releaseWorkflow: "release.yml",
    hasDb: opts.hasDb ?? false,
    migration: opts.migration ?? "none",
    usesGoShared: opts.usesGoShared ?? false,
    sidecar: opts.sidecar ?? "none",
    invokes: opts.invokes ?? [],
    publishesEvents: opts.publishesEvents ?? false,
    pubsubTopic: opts.pubsubTopic ?? "",
    secrets: opts.secrets ?? [],
    storageApps: opts.storageApps ?? [],
    managed: opts.managed ?? true,
  };
}

/** DB service shorthand — Go backend with DB + cloud-sql-proxy + go-shared */
function dbSvc(
  name: string,
  displayName: string,
  appGroup: AppGroup,
  opts: Partial<Omit<ServiceConfig, "name" | "displayName" | "appGroup" | "repo" | "buildWorkflow" | "releaseWorkflow">> = {}
): ServiceConfig {
  return svc(name, displayName, appGroup, {
    hasDb: true,
    sidecar: "cloud-sql-proxy",
    usesGoShared: true,
    ...opts,
  });
}

export const SERVICE_REGISTRY: ServiceConfig[] = [
  // --- Platform Services ---
  svc("auth-bff", "Auth BFF", "platform", {
    usesGoShared: true,
    invokes: ["openfga", "tenant-service"],
    publishesEvents: true,
    pubsubTopic: "tesserix-audit-events",
    secrets: ["auth-bff-cookie-encryption-key", "auth-bff-csrf-secret", "openfga-preshared-key", "platform-client-secret"],
  }),
  dbSvc("openfga", "OpenFGA", "platform", {
    managed: false,
    usesGoShared: false,
    secrets: ["openfga-preshared-key", "openfga-db-password", "openfga-db-uri"],
  }),
  dbSvc("audit-service", "Audit Service", "platform", {
    migration: "gorm-auto",
    invokes: ["openfga"],
    secrets: ["audit-db-password", "openfga-preshared-key"],
  }),
  dbSvc("tenant-service", "Tenant Service", "platform", {
    invokes: ["openfga"],
    secrets: ["tenants-db-password", "openfga-preshared-key"],
  }),
  dbSvc("notification-service", "Notification Service", "platform", {
    secrets: ["notifications-db-password", "sendgrid-api-key"],
  }),
  dbSvc("settings-service", "Settings Service", "platform", {
    usesGoShared: false,
    secrets: ["settings-db-password"],
  }),
  dbSvc("subscription-service", "Subscription Service", "platform", {
    migration: "golang-migrate",
    publishesEvents: true,
    pubsubTopic: "tesserix-subscription-events",
    secrets: ["subscriptions-db-password", "stripe-secret-key"],
  }),
  svc("feature-flags-service", "Feature Flags Service", "platform", {
    usesGoShared: true,
    secrets: ["growthbook-api-key"],
  }),
  dbSvc("tickets-service", "Tickets Service", "platform", {
    migration: "golang-migrate",
    invokes: ["openfga", "tenant-service", "notification-service", "document-service"],
    publishesEvents: true,
    pubsubTopic: "tesserix-ticket-events",
    secrets: ["tickets-db-password", "openfga-preshared-key"],
  }),
  dbSvc("document-service", "Document Service", "platform", {
    secrets: ["documents-db-password"],
    storageApps: ["platform"],
  }),
  dbSvc("location-service", "Location Service", "platform"),
  dbSvc("verification-service", "Verification Service", "platform", {
    invokes: ["notification-service"],
    publishesEvents: true,
    pubsubTopic: "tesserix-notification-events",
    secrets: ["verifications-db-password", "shared-internal-service-key", "verification-encryption-key"],
  }),
  dbSvc("analytics-service", "Analytics Service", "platform", {
    secrets: ["analytics-db-password"],
  }),
  svc("status-service", "Status Service", "platform", { usesGoShared: true }),
  svc("qr-service", "QR Service", "platform", { usesGoShared: true }),
  svc("tesserix-home", "Tesserix Home", "platform", {
    type: "frontend",
    lang: "nextjs",
    invokes: ["auth-bff"],
    secrets: ["shared-internal-service-key"],
  }),

  // --- Marketplace Services ---
  svc("tenant-router-service", "Tenant Router Service", "mark8ly", { usesGoShared: true }),
  svc("marketplace-onboarding", "Marketplace Onboarding", "mark8ly", {
    type: "frontend",
    lang: "nextjs",
  }),
  svc("mp-storefront", "Marketplace Storefront", "mark8ly", {
    type: "frontend",
    lang: "nextjs",
    invokes: ["mp-products", "mp-categories", "mp-reviews", "auth-bff"],
  }),
  dbSvc("mp-products", "Products Service", "mark8ly", {
    invokes: ["openfga"],
    publishesEvents: true,
    pubsubTopic: "mp-product-events",
    secrets: ["mp_products-db-password", "openfga-preshared-key"],
    storageApps: ["marketplace"],
  }),
  dbSvc("mp-orders", "Orders Service", "mark8ly", {
    invokes: ["openfga", "mp-inventory", "mp-payments", "notification-service"],
    publishesEvents: true,
    pubsubTopic: "mp-order-events",
    secrets: ["mp_orders-db-password", "openfga-preshared-key"],
  }),
  dbSvc("mp-payments", "Payments Service", "mark8ly", {
    invokes: ["openfga"],
    publishesEvents: true,
    pubsubTopic: "mp-payment-events",
    secrets: ["mp_payments-db-password", "stripe-secret-key", "stripe-webhook-secret"],
  }),
  dbSvc("mp-inventory", "Inventory Service", "mark8ly", {
    publishesEvents: true,
    pubsubTopic: "mp-inventory-events",
    secrets: ["mp_inventory-db-password"],
  }),
  dbSvc("mp-shipping", "Shipping Service", "mark8ly", {
    secrets: ["mp_shipping-db-password"],
  }),
  dbSvc("mp-categories", "Categories Service", "mark8ly", {
    secrets: ["mp_categories-db-password"],
  }),
  dbSvc("mp-coupons", "Coupons Service", "mark8ly", {
    secrets: ["mp_coupons-db-password"],
  }),
  dbSvc("mp-reviews", "Reviews Service", "mark8ly", {
    invokes: ["openfga"],
    secrets: ["mp_reviews-db-password", "openfga-preshared-key"],
    storageApps: ["marketplace"],
  }),
  dbSvc("mp-vendors", "Vendors Service", "mark8ly", {
    invokes: ["openfga"],
    secrets: ["mp_vendors-db-password", "openfga-preshared-key"],
    storageApps: ["marketplace"],
  }),
  dbSvc("mp-customers", "Customers Service", "mark8ly", {
    invokes: ["openfga"],
    secrets: ["mp_customers-db-password", "openfga-preshared-key"],
  }),
];

/** Unique repos that have workflows. */
export const REPOS_WITH_WORKFLOWS = [
  ...new Set(SERVICE_REGISTRY.filter((s) => s.repo && s.managed).map((s) => s.repo)),
];

export function getServiceByName(name: string): ServiceConfig | undefined {
  return SERVICE_REGISTRY.find((s) => s.name === name);
}

export function getServicesByAppGroup(group: AppGroup): ServiceConfig[] {
  return SERVICE_REGISTRY.filter((s) => s.appGroup === group);
}

/** Services that depend on go-shared. */
export function getGoSharedConsumers(): ServiceConfig[] {
  return SERVICE_REGISTRY.filter((s) => s.usesGoShared);
}

/** Services that this service invokes (outbound). */
export function getServiceDependencies(name: string): ServiceConfig[] {
  const svc = getServiceByName(name);
  if (!svc) return [];
  return svc.invokes
    .map((n) => getServiceByName(n))
    .filter((s): s is ServiceConfig => !!s);
}

/** Services that invoke this service (inbound). */
export function getServiceDependents(name: string): ServiceConfig[] {
  return SERVICE_REGISTRY.filter((s) => s.invokes.includes(name));
}

/** Parse "Owner/repo" into { owner, repo }. */
export function parseRepo(fullRepo: string): { owner: string; repo: string } {
  const [owner, repo] = fullRepo.split("/");
  return { owner, repo };
}
