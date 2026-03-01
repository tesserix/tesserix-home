export type ServiceType = "backend" | "frontend";
export type AppGroup = "mark8ly" | "global";

export interface ServiceConfig {
  name: string;
  displayName: string;
  type: ServiceType;
  repo: string;
  buildWorkflow: string;
  releaseWorkflow: string;
  imageRepo: string;
  argoApp: string;
  namespace: string;
  appGroup: AppGroup;
}

const OWNER = "Tesseract-Nexus";

function globalService(
  name: string,
  displayName: string,
  overrides?: { argoApp?: string; namespace?: string }
): ServiceConfig {
  return {
    name,
    displayName,
    type: "backend",
    repo: `${OWNER}/global-services`,
    buildWorkflow: `${name}-build.yml`,
    releaseWorkflow: `${name}-release.yml`,
    imageRepo: `ghcr.io/${OWNER.toLowerCase()}/global-services/${name}`,
    argoApp: overrides?.argoApp ?? name,
    namespace: overrides?.namespace ?? "marketplace",
    appGroup: "global",
  };
}

function marketplaceService(name: string, displayName: string): ServiceConfig {
  return {
    name,
    displayName,
    type: "backend",
    repo: `${OWNER}/marketplace-services`,
    buildWorkflow: `${name}-build.yml`,
    releaseWorkflow: `${name}-release.yml`,
    imageRepo: `ghcr.io/${OWNER.toLowerCase()}/marketplace-services/${name}`,
    argoApp: name,
    namespace: "marketplace",
    appGroup: "mark8ly",
  };
}

function clientApp(name: string, displayName: string): ServiceConfig {
  return {
    name,
    displayName,
    type: "frontend",
    repo: `${OWNER}/marketplace-clients`,
    buildWorkflow: `${name}-build.yml`,
    releaseWorkflow: `${name}-release.yml`,
    imageRepo: `ghcr.io/${OWNER.toLowerCase()}/marketplace-clients/${name}`,
    argoApp: name,
    namespace: "marketplace",
    appGroup: "mark8ly",
  };
}

export const SERVICE_REGISTRY: ServiceConfig[] = [
  // Global Services (15 Kargo-managed backends)
  globalService("settings-service", "Settings Service"),
  globalService("auth-service", "Auth Service"),
  globalService("tickets-service", "Tickets Service"),
  globalService("document-service", "Document Service"),
  globalService("location-service", "Location Service"),
  globalService("tenant-service", "Tenant Service"),
  globalService("verification-service", "Verification Service"),
  globalService("translation-service", "Translation Service", {
    argoApp: "bergamot-service",
    namespace: "translation",
  }),
  globalService("analytics-service", "Analytics Service"),
  globalService("audit-service", "Audit Service"),
  globalService("feature-flags-service", "Feature Flags Service"),
  globalService("notification-service", "Notification Service"),
  globalService("notification-hub", "Notification Hub"),
  globalService("search-service", "Search Service"),
  globalService("subscription-service", "Subscription Service"),

  // Marketplace Services (7 Kargo-managed backends)
  marketplaceService("products-service", "Products Service"),
  marketplaceService("categories-service", "Categories Service"),
  marketplaceService("orders-service", "Orders Service"),
  marketplaceService("coupons-service", "Coupons Service"),
  marketplaceService("staff-service", "Staff Service"),
  marketplaceService("vendor-service", "Vendor Service"),
  marketplaceService("reviews-service", "Reviews Service"),

  // Marketplace Clients (3 frontends)
  clientApp("admin", "Admin Portal"),
  clientApp("storefront", "Storefront"),
  clientApp("tenant-onboarding", "Tenant Onboarding"),
];

/** Unique repos that have workflows. */
export const REPOS_WITH_WORKFLOWS = [
  ...new Set(SERVICE_REGISTRY.filter((s) => s.repo).map((s) => s.repo)),
];

export function getServiceByName(name: string): ServiceConfig | undefined {
  return SERVICE_REGISTRY.find((s) => s.name === name);
}

export function getServicesByAppGroup(group: AppGroup): ServiceConfig[] {
  return SERVICE_REGISTRY.filter((s) => s.appGroup === group);
}

/** Parse "Owner/repo" into { owner, repo }. */
export function parseRepo(fullRepo: string): { owner: string; repo: string } {
  const [owner, repo] = fullRepo.split("/");
  return { owner, repo };
}
