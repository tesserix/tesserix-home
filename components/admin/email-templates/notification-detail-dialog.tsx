"use client";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { type Notification, type NotificationStatus } from "@/lib/api/email-templates";

function notificationStatusVariant(
  status: NotificationStatus
): "success" | "destructive" | "warning" | "secondary" {
  switch (status) {
    case "sent":
      return "success";
    case "failed":
    case "bounced":
      return "destructive";
    case "pending":
      return "warning";
    default:
      return "secondary";
  }
}

interface NotificationDetailDialogProps {
  notification: Notification;
  onClose: () => void;
}

export function NotificationDetailDialog({
  notification,
  onClose,
}: NotificationDetailDialogProps) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="fixed inset-0 bg-black/50" onClick={onClose} />
      <div className="relative z-50 w-full max-w-lg rounded-lg bg-background p-6 shadow-lg">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-lg font-semibold">Notification Detail</h3>
          <Button variant="ghost" size="sm" onClick={onClose}>
            Close
          </Button>
        </div>

        <div className="space-y-3 text-sm">
          <div>
            <p className="text-muted-foreground">Recipient</p>
            <p className="font-medium">{notification.recipient}</p>
          </div>
          <div>
            <p className="text-muted-foreground">Subject</p>
            <p className="font-medium">{notification.subject}</p>
          </div>
          <div>
            <p className="text-muted-foreground">Status</p>
            <Badge variant={notificationStatusVariant(notification.status)}>
              {notification.status}
            </Badge>
          </div>
          {notification.template_name && (
            <div>
              <p className="text-muted-foreground">Template</p>
              <p className="font-medium">{notification.template_name}</p>
            </div>
          )}
          {notification.sent_at && (
            <div>
              <p className="text-muted-foreground">Sent At</p>
              <p className="font-medium">
                {new Date(notification.sent_at).toLocaleString()}
              </p>
            </div>
          )}
          {notification.delivered_at && (
            <div>
              <p className="text-muted-foreground">Delivered At</p>
              <p className="font-medium">
                {new Date(notification.delivered_at).toLocaleString()}
              </p>
            </div>
          )}
          {notification.error_message && (
            <div>
              <p className="text-muted-foreground">Error</p>
              <p className="text-destructive">{notification.error_message}</p>
            </div>
          )}
          {notification.metadata &&
            Object.keys(notification.metadata).length > 0 && (
              <div>
                <p className="text-muted-foreground mb-1">Metadata</p>
                <pre className="rounded-md bg-muted p-3 text-xs overflow-x-auto">
                  {JSON.stringify(notification.metadata, null, 2)}
                </pre>
              </div>
            )}
        </div>
      </div>
    </div>
  );
}
