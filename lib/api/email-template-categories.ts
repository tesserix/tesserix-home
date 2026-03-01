export type TemplateScope = "platform" | "mark8ly";

export interface TemplateVariable {
  name: string;
  description: string;
  example: string;
}

export interface CategoryConfig {
  value: string;
  label: string;
  description: string;
  scope: TemplateScope;
  variables: TemplateVariable[];
}

// ─── Platform categories ────────────────────────────────────────────────────

const platformCategories: CategoryConfig[] = [
  {
    value: "system_health",
    label: "System Health",
    description: "System health alerts and incident notifications",
    scope: "platform",
    variables: [
      { name: "service_name", description: "Name of the affected service", example: "notification-service" },
      { name: "alert_type", description: "Type of alert (warning, critical, resolved)", example: "critical" },
      { name: "alert_message", description: "Detailed alert message", example: "CPU usage exceeded 95%" },
      { name: "timestamp", description: "Time of the alert", example: "2026-02-10T14:30:00Z" },
      { name: "environment", description: "Deployment environment", example: "production" },
      { name: "dashboard_url", description: "Link to monitoring dashboard", example: "https://monitoring.tesserix.app/alerts/123" },
    ],
  },
  {
    value: "audit",
    label: "Audit",
    description: "Audit log and compliance notifications",
    scope: "platform",
    variables: [
      { name: "actor_name", description: "Name of the user who performed the action", example: "John Doe" },
      { name: "actor_email", description: "Email of the user", example: "john@tesserix.app" },
      { name: "action", description: "Action that was performed", example: "tenant.settings.updated" },
      { name: "resource_type", description: "Type of resource affected", example: "tenant" },
      { name: "resource_id", description: "ID of the resource", example: "t-12345" },
      { name: "timestamp", description: "Time of the action", example: "2026-02-10T14:30:00Z" },
      { name: "details", description: "Additional details about the action", example: "Changed store name from 'Old' to 'New'" },
    ],
  },
  {
    value: "security",
    label: "Security",
    description: "Security alerts and access notifications",
    scope: "platform",
    variables: [
      { name: "user_name", description: "Name of the affected user", example: "Jane Smith" },
      { name: "user_email", description: "Email of the affected user", example: "jane@example.com" },
      { name: "event_type", description: "Type of security event", example: "suspicious_login" },
      { name: "ip_address", description: "IP address of the event", example: "192.168.1.1" },
      { name: "location", description: "Geographic location", example: "New York, US" },
      { name: "timestamp", description: "Time of the event", example: "2026-02-10T14:30:00Z" },
      { name: "action_url", description: "Link to take action", example: "https://home.tesserix.app/admin/security/events/123" },
    ],
  },
  {
    value: "platform_admin",
    label: "Platform Admin",
    description: "Platform administration notifications",
    scope: "platform",
    variables: [
      { name: "admin_name", description: "Name of the platform admin", example: "Admin User" },
      { name: "admin_email", description: "Email of the admin", example: "admin@tesserix.app" },
      { name: "notification_type", description: "Type of admin notification", example: "new_tenant_signup" },
      { name: "details", description: "Notification details", example: "New tenant 'Acme Store' signed up" },
      { name: "timestamp", description: "Time of the notification", example: "2026-02-10T14:30:00Z" },
      { name: "dashboard_url", description: "Link to admin dashboard", example: "https://home.tesserix.app/admin/dashboard" },
    ],
  },
];

// ─── Mark8ly categories ─────────────────────────────────────────────────────

const mark8lyCategories: CategoryConfig[] = [
  {
    value: "tenant_onboarding",
    label: "Tenant Onboarding",
    description: "Welcome and setup emails sent to new store owners",
    scope: "mark8ly",
    variables: [
      { name: "business_name", description: "Name of the new store/business", example: "Fresh Produce Co" },
      { name: "admin_url", description: "Admin panel URL for the store", example: "https://fresh-produce-admin.tesserix.app" },
      { name: "storefront_url", description: "Storefront URL for the store", example: "https://fresh-produce.tesserix.app" },
      { name: "email", description: "Store owner's email address", example: "owner@example.com" },
      { name: "tenant_slug", description: "Store identifier/slug", example: "fresh-produce" },
      { name: "support_email", description: "Platform support email", example: "support@tesserix.app" },
    ],
  },
  {
    value: "order",
    label: "Orders",
    description: "Order confirmation, updates, and shipping notifications",
    scope: "mark8ly",
    variables: [
      { name: "order_id", description: "Order ID", example: "ORD-12345" },
      { name: "customer_name", description: "Customer's full name", example: "John Doe" },
      { name: "customer_email", description: "Customer's email", example: "john@example.com" },
      { name: "order_total", description: "Order total amount", example: "$99.99" },
      { name: "order_items", description: "HTML list of ordered items", example: "<li>Product A x2</li>" },
      { name: "order_status", description: "Current order status", example: "shipped" },
      { name: "tracking_number", description: "Shipping tracking number", example: "1Z999AA10123456784" },
      { name: "tracking_url", description: "Tracking URL", example: "https://track.example.com/1Z999AA" },
      { name: "store_name", description: "Store name", example: "Acme Store" },
      { name: "store_url", description: "Store URL", example: "https://acme.tesserix.app" },
    ],
  },
  {
    value: "payment",
    label: "Payments",
    description: "Payment confirmations, refunds, and invoice notifications",
    scope: "mark8ly",
    variables: [
      { name: "customer_name", description: "Customer's full name", example: "John Doe" },
      { name: "payment_amount", description: "Payment amount", example: "$99.99" },
      { name: "payment_method", description: "Payment method used", example: "Visa ending in 4242" },
      { name: "transaction_id", description: "Transaction reference", example: "TXN-12345" },
      { name: "invoice_url", description: "Link to invoice", example: "https://acme.tesserix.app/invoices/12345" },
      { name: "refund_amount", description: "Refund amount (if applicable)", example: "$25.00" },
      { name: "store_name", description: "Store name", example: "Acme Store" },
    ],
  },
  {
    value: "customer",
    label: "Customers",
    description: "Welcome emails, account updates, and customer notifications",
    scope: "mark8ly",
    variables: [
      { name: "customer_name", description: "Customer's full name", example: "John Doe" },
      { name: "customer_email", description: "Customer's email", example: "john@example.com" },
      { name: "store_name", description: "Store name", example: "Acme Store" },
      { name: "store_url", description: "Store URL", example: "https://acme.tesserix.app" },
      { name: "action_url", description: "Action link (verify, reset, etc.)", example: "https://acme.tesserix.app/verify?token=abc" },
    ],
  },
  {
    value: "review",
    label: "Reviews",
    description: "Review request and moderation notifications",
    scope: "mark8ly",
    variables: [
      { name: "customer_name", description: "Customer's name", example: "John Doe" },
      { name: "product_name", description: "Reviewed product name", example: "Wireless Headphones" },
      { name: "review_rating", description: "Review rating", example: "4" },
      { name: "review_text", description: "Review content", example: "Great product!" },
      { name: "review_url", description: "Link to the review", example: "https://acme.tesserix.app/products/123#reviews" },
      { name: "store_name", description: "Store name", example: "Acme Store" },
    ],
  },
  {
    value: "ticket",
    label: "Tickets",
    description: "Support ticket notifications",
    scope: "mark8ly",
    variables: [
      { name: "ticket_id", description: "Ticket ID", example: "TKT-12345" },
      { name: "customer_name", description: "Customer's name", example: "John Doe" },
      { name: "ticket_subject", description: "Ticket subject", example: "Shipping delay" },
      { name: "ticket_status", description: "Current ticket status", example: "open" },
      { name: "ticket_url", description: "Link to the ticket", example: "https://acme.tesserix.app/tickets/12345" },
      { name: "store_name", description: "Store name", example: "Acme Store" },
    ],
  },
  {
    value: "vendor",
    label: "Vendors",
    description: "Vendor onboarding and management notifications",
    scope: "mark8ly",
    variables: [
      { name: "vendor_name", description: "Vendor's name", example: "Acme Suppliers" },
      { name: "vendor_email", description: "Vendor's email", example: "vendor@example.com" },
      { name: "store_name", description: "Store name", example: "Acme Store" },
      { name: "action_url", description: "Action link", example: "https://acme.tesserix.app/vendor/dashboard" },
    ],
  },
  {
    value: "coupon",
    label: "Coupons",
    description: "Coupon and discount notifications",
    scope: "mark8ly",
    variables: [
      { name: "customer_name", description: "Customer's name", example: "John Doe" },
      { name: "coupon_code", description: "Coupon code", example: "SAVE20" },
      { name: "discount_amount", description: "Discount amount or percentage", example: "20%" },
      { name: "expiry_date", description: "Coupon expiration date", example: "March 31, 2026" },
      { name: "store_name", description: "Store name", example: "Acme Store" },
      { name: "store_url", description: "Store URL", example: "https://acme.tesserix.app" },
    ],
  },
  {
    value: "inventory",
    label: "Inventory",
    description: "Stock alerts and inventory notifications",
    scope: "mark8ly",
    variables: [
      { name: "product_name", description: "Product name", example: "Wireless Headphones" },
      { name: "sku", description: "Product SKU", example: "WH-001" },
      { name: "current_stock", description: "Current stock level", example: "3" },
      { name: "threshold", description: "Low stock threshold", example: "5" },
      { name: "store_name", description: "Store name", example: "Acme Store" },
      { name: "inventory_url", description: "Link to inventory management", example: "https://acme.tesserix.app/admin/inventory" },
    ],
  },
  {
    value: "approval",
    label: "Approvals",
    description: "Approval workflow notifications",
    scope: "mark8ly",
    variables: [
      { name: "requester_name", description: "Name of person requesting approval", example: "Jane Smith" },
      { name: "approval_type", description: "Type of approval needed", example: "product_listing" },
      { name: "item_name", description: "Name of item requiring approval", example: "New Product Listing" },
      { name: "approval_url", description: "Link to approve/reject", example: "https://acme.tesserix.app/admin/approvals/123" },
      { name: "store_name", description: "Store name", example: "Acme Store" },
    ],
  },
  {
    value: "domain",
    label: "Domains",
    description: "Domain and DNS configuration notifications",
    scope: "mark8ly",
    variables: [
      { name: "domain_name", description: "Domain name", example: "shop.example.com" },
      { name: "dns_status", description: "DNS verification status", example: "verified" },
      { name: "ssl_status", description: "SSL certificate status", example: "active" },
      { name: "store_name", description: "Store name", example: "Acme Store" },
      { name: "settings_url", description: "Link to domain settings", example: "https://acme.tesserix.app/admin/settings/domains" },
    ],
  },
  {
    value: "campaign",
    label: "Campaigns",
    description: "Marketing campaign notifications",
    scope: "mark8ly",
    variables: [
      { name: "campaign_name", description: "Campaign name", example: "Summer Sale 2026" },
      { name: "campaign_status", description: "Campaign status", example: "active" },
      { name: "start_date", description: "Campaign start date", example: "June 1, 2026" },
      { name: "end_date", description: "Campaign end date", example: "June 30, 2026" },
      { name: "store_name", description: "Store name", example: "Acme Store" },
      { name: "campaign_url", description: "Link to campaign", example: "https://acme.tesserix.app/admin/campaigns/123" },
    ],
  },
  {
    value: "gift_card",
    label: "Gift Cards",
    description: "Gift card purchase and redemption notifications",
    scope: "mark8ly",
    variables: [
      { name: "recipient_name", description: "Gift card recipient name", example: "Jane Smith" },
      { name: "sender_name", description: "Gift card sender name", example: "John Doe" },
      { name: "gift_card_code", description: "Gift card code", example: "GC-ABCD-1234" },
      { name: "gift_card_amount", description: "Gift card amount", example: "$50.00" },
      { name: "gift_card_message", description: "Personal message", example: "Happy Birthday!" },
      { name: "redeem_url", description: "Link to redeem", example: "https://acme.tesserix.app/gift-cards/redeem" },
      { name: "store_name", description: "Store name", example: "Acme Store" },
    ],
  },
  {
    value: "staff",
    label: "Staff",
    description: "Staff invitation and management notifications",
    scope: "mark8ly",
    variables: [
      { name: "staff_name", description: "Staff member's name", example: "Jane Smith" },
      { name: "staff_email", description: "Staff member's email", example: "jane@example.com" },
      { name: "role", description: "Assigned role", example: "Store Manager" },
      { name: "inviter_name", description: "Name of person who sent the invite", example: "John Doe" },
      { name: "invite_url", description: "Link to accept invite", example: "https://acme.tesserix.app/invite/abc123" },
      { name: "store_name", description: "Store name", example: "Acme Store" },
    ],
  },
  {
    value: "auth",
    label: "Authentication",
    description: "Authentication and verification emails",
    scope: "mark8ly",
    variables: [
      { name: "user_name", description: "User's name", example: "John Doe" },
      { name: "user_email", description: "User's email", example: "john@example.com" },
      { name: "verification_code", description: "Verification code", example: "123456" },
      { name: "verification_url", description: "Verification link", example: "https://acme.tesserix.app/verify?token=abc" },
      { name: "reset_url", description: "Password reset link", example: "https://acme.tesserix.app/reset-password?token=abc" },
      { name: "store_name", description: "Store name", example: "Acme Store" },
    ],
  },
];

// ─── Exports ────────────────────────────────────────────────────────────────

const allCategories: CategoryConfig[] = [...platformCategories, ...mark8lyCategories];

export function getCategoriesForScope(scope: TemplateScope): CategoryConfig[] {
  return allCategories.filter((c) => c.scope === scope);
}

export function getCategoryConfig(category: string): CategoryConfig | undefined {
  return allCategories.find((c) => c.value === category);
}

export function getCategoryValues(scope: TemplateScope): string[] {
  return getCategoriesForScope(scope).map((c) => c.value);
}
