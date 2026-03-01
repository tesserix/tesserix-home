"use client";

import { useMemo } from "react";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { type EmailTemplate } from "@/lib/api/email-templates";

interface TemplatePreviewDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  template: EmailTemplate;
}

function replaceVariables(html: string): string {
  return html
    .replace(/\{\{if \.(\w+)\}\}/g, "")
    .replace(/\{\{else\}\}/g, "")
    .replace(/\{\{end\}\}/g, "")
    .replace(/\{\{\.brand_primary_color\}\}/g, "#18181b")
    .replace(/\{\{\.brand_text_color\}\}/g, "#ffffff")
    .replace(/\{\{\.brand_logo_url\}\}/g, "")
    .replace(/\{\{\.platform_logo_url\}\}/g, "")
    .replace(/\{\{\.store_name\}\}/g, "Acme Store")
    .replace(/\{\{\.store_url\}\}/g, "#")
    .replace(/\{\{\.customer_name\}\}/g, "Jane Smith")
    .replace(/\{\{\.customer_email\}\}/g, "jane@example.com")
    .replace(/\{\{\.order_id\}\}/g, "ORD-12345")
    .replace(/\{\{\.order_total\}\}/g, "$129.00")
    .replace(/\{\{\.order_items\}\}/g, "2 items")
    .replace(/\{\{\.order_status\}\}/g, "Confirmed")
    .replace(/\{\{\.tracking_number\}\}/g, "TRK-9876543")
    .replace(/\{\{\.tracking_url\}\}/g, "#")
    .replace(/\{\{\.cancellation_reason\}\}/g, "Customer requested")
    .replace(/\{\{\.payment_amount\}\}/g, "$129.00")
    .replace(/\{\{\.payment_method\}\}/g, "Visa ending 4242")
    .replace(/\{\{\.transaction_id\}\}/g, "txn_abc123def456")
    .replace(/\{\{\.reset_link\}\}/g, "#")
    .replace(/\{\{\.verification_link\}\}/g, "#")
    .replace(/\{\{\.activation_link\}\}/g, "#")
    .replace(/\{\{\.review_link\}\}/g, "#")
    .replace(/\{\{\.dashboard_url\}\}/g, "#")
    .replace(/\{\{\.ticket_subject\}\}/g, "Order not received")
    .replace(/\{\{\.ticket_url\}\}/g, "#")
    .replace(/\{\{\.vendor_name\}\}/g, "Fresh Produce Co")
    .replace(/\{\{\.vendor_email\}\}/g, "vendor@example.com")
    .replace(/\{\{\.coupon_code\}\}/g, "SAVE20")
    .replace(/\{\{\.discount_value\}\}/g, "20% off")
    .replace(/\{\{\.expiry_date\}\}/g, "March 31, 2026")
    .replace(/\{\{\.product_name\}\}/g, "Wireless Headphones")
    .replace(/\{\{\.sku\}\}/g, "SKU-001")
    .replace(/\{\{\.current_stock\}\}/g, "3")
    .replace(/\{\{\.threshold\}\}/g, "10")
    .replace(/\{\{\.requester_name\}\}/g, "John Doe")
    .replace(/\{\{\.item_name\}\}/g, "New Product Listing")
    .replace(/\{\{\.approval_type\}\}/g, "Product")
    .replace(/\{\{\.approval_url\}\}/g, "#")
    .replace(/\{\{\.domain_name\}\}/g, "shop.example.com")
    .replace(/\{\{\.dns_status\}\}/g, "Verified")
    .replace(/\{\{\.ssl_status\}\}/g, "Active")
    .replace(/\{\{\.campaign_name\}\}/g, "Summer Sale")
    .replace(/\{\{\.start_date\}\}/g, "Feb 15, 2026")
    .replace(/\{\{\.end_date\}\}/g, "Mar 15, 2026")
    .replace(/\{\{\.gift_card_amount\}\}/g, "$50.00")
    .replace(/\{\{\.gift_card_code\}\}/g, "GIFT-ABCD-1234")
    .replace(/\{\{\.sender_name\}\}/g, "Alex Johnson")
    .replace(/\{\{\.recipient_name\}\}/g, "Jane Smith")
    .replace(/\{\{\.personal_message\}\}/g, "Enjoy this gift!")
    .replace(/\{\{\.redeem_url\}\}/g, "#")
    .replace(/\{\{\.staff_name\}\}/g, "Sam Wilson")
    .replace(/\{\{\.role\}\}/g, "Store Manager")
    .replace(/\{\{\.inviter_name\}\}/g, "Alex Johnson")
    .replace(/\{\{\.service_name\}\}/g, "API Gateway")
    .replace(/\{\{\.environment\}\}/g, "Production")
    .replace(/\{\{\.alert_type\}\}/g, "High CPU Usage")
    .replace(/\{\{\.alert_message\}\}/g, "CPU usage exceeded 90% for 5 minutes")
    .replace(/\{\{\.actor_name\}\}/g, "Admin User")
    .replace(/\{\{\.actor_email\}\}/g, "admin@example.com")
    .replace(/\{\{\.action\}\}/g, "user.permissions.update")
    .replace(/\{\{\.resource_type\}\}/g, "User")
    .replace(/\{\{\.resource_id\}\}/g, "usr_12345")
    .replace(/\{\{\.details\}\}/g, "New tenant registered: Fresh Produce Co")
    .replace(/\{\{\.event_type\}\}/g, "Suspicious Login")
    .replace(/\{\{\.user_name\}\}/g, "John Doe")
    .replace(/\{\{\.user_email\}\}/g, "john@example.com")
    .replace(/\{\{\.ip_address\}\}/g, "203.0.113.42")
    .replace(/\{\{\.location\}\}/g, "Sydney, AU")
    .replace(/\{\{\.support_email\}\}/g, "support@example.com")
    // Catch any remaining variables
    .replace(/\{\{\.(\w+)\}\}/g, "[$1]");
}

export function TemplatePreviewDialog({
  open,
  onOpenChange,
  template,
}: TemplatePreviewDialogProps) {
  const previewHtml = useMemo(
    () => (template.html_body ? replaceVariables(template.html_body) : ""),
    [template.html_body]
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-w-2xl p-0 gap-0 overflow-hidden"
        style={{ display: "flex", flexDirection: "column", height: "85vh" }}
      >
        <DialogHeader className="px-6 pt-6 pb-4 border-b" style={{ flexShrink: 0 }}>
          <div className="flex items-center gap-2">
            <DialogTitle className="text-base">{template.name}</DialogTitle>
            <Badge variant="outline" className="text-[10px] px-1.5 py-0">
              Preview
            </Badge>
          </div>
          <DialogDescription className="text-xs">
            {template.subject || "No subject"}
          </DialogDescription>
        </DialogHeader>
        <div
          className="bg-muted/30"
          style={{ flex: 1, minHeight: 0, overflow: "hidden" }}
        >
          {previewHtml ? (
            <iframe
              title="Email preview"
              srcDoc={previewHtml}
              sandbox=""
              style={{ width: "100%", height: "100%", border: "none", display: "block" }}
            />
          ) : (
            <div className="flex items-center justify-center h-full text-sm text-muted-foreground">
              No HTML body to preview
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
