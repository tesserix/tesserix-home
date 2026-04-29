"use client";

import {
  type Notification,
  type NotificationStatus,
} from "@/lib/api/email-templates";
import {
  Badge,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@tesserix/web";

function notificationStatusVariant(
  status: NotificationStatus,
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
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Notification Detail</DialogTitle>
        </DialogHeader>

        <div className="space-y-3 text-sm">
          <div className="min-w-0">
            <p className="text-muted-foreground">Recipient</p>
            <p className="font-medium break-words">{notification.recipient}</p>
          </div>
          <div className="min-w-0">
            <p className="text-muted-foreground">Subject</p>
            <p className="font-medium break-words">{notification.subject}</p>
          </div>
          <div>
            <p className="text-muted-foreground">Status</p>
            <Badge variant={notificationStatusVariant(notification.status)}>
              {notification.status}
            </Badge>
          </div>
          {notification.template_name && (
            <div className="min-w-0">
              <p className="text-muted-foreground">Template</p>
              <p className="font-medium break-words">
                {notification.template_name}
              </p>
            </div>
          )}
          {notification.sent_at && (
            <div className="min-w-0">
              <p className="text-muted-foreground">Sent At</p>
              <p className="font-medium">
                {new Date(notification.sent_at).toLocaleString()}
              </p>
            </div>
          )}
          {notification.delivered_at && (
            <div className="min-w-0">
              <p className="text-muted-foreground">Delivered At</p>
              <p className="font-medium">
                {new Date(notification.delivered_at).toLocaleString()}
              </p>
            </div>
          )}
          {notification.error_message && (
            <div className="min-w-0">
              <p className="text-muted-foreground">Error</p>
              <p className="text-destructive break-words">
                {notification.error_message}
              </p>
            </div>
          )}
          {notification.metadata &&
            Object.keys(notification.metadata).length > 0 && (
              <div>
                <p className="mb-1 text-muted-foreground">Metadata</p>
                <pre className="overflow-x-auto rounded-md bg-muted p-3 text-xs">
                  {JSON.stringify(notification.metadata, null, 2)}
                </pre>
              </div>
            )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
