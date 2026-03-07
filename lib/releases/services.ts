export type ServiceType = "backend" | "frontend";
export type AppGroup = "platform" | "mark8ly";

export interface ServiceConfig {
  name: string;
  displayName: string;
  type: ServiceType;
  repo: string;
  buildWorkflow: string;
  releaseWorkflow: string;
  appGroup: AppGroup;
}

const OWNER = "tesserix";

function service(
  name: string,
  displayName: string,
  appGroup: AppGroup,
  type: ServiceType = "backend"
): ServiceConfig {
  return {
    name,
    displayName,
    type,
    repo: `${OWNER}/${name}`,
    buildWorkflow: "ci.yml",
    releaseWorkflow: "release.yml",
    appGroup,
  };
}

export const SERVICE_REGISTRY: ServiceConfig[] = [
  // Platform Services
  service("auth-bff", "Auth BFF", "platform"),
  service("audit-service", "Audit Service", "platform"),
  service("tickets-service", "Tickets Service", "platform"),
  service("document-service", "Document Service", "platform"),
  service("location-service", "Location Service", "platform"),
  service("tenant-service", "Tenant Service", "platform"),
  service("verification-service", "Verification Service", "platform"),
  service("analytics-service", "Analytics Service", "platform"),
  service("feature-flags-service", "Feature Flags Service", "platform"),
  service("notification-service", "Notification Service", "platform"),
  service("subscription-service", "Subscription Service", "platform"),
  service("status-service", "Status Service", "platform"),
  service("qr-service", "QR Service", "platform"),

  // Marketplace Services
  service("tenant-router-service", "Tenant Router Service", "mark8ly"),

  // Frontend Apps
  service("tesserix-home", "Tesserix Home", "platform", "frontend"),
  service("marketplace-onboarding", "Marketplace Onboarding", "mark8ly", "frontend"),
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
