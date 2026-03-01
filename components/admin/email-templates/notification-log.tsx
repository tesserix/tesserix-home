"use client";

import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { ErrorState } from "@/components/admin/error-state";
import { NotificationDetailDialog } from "./notification-detail-dialog";
import {
  useNotifications,
  type Notification,
  type NotificationStatus,
} from "@/lib/api/email-templates";

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

export function NotificationLog() {
  const [selectedNotification, setSelectedNotification] = useState<Notification | null>(null);
  const {
    data: notifications,
    isLoading,
    error,
    mutate,
  } = useNotifications();

  if (isLoading) {
    return (
      <div className="space-y-2">
        {Array.from({ length: 5 }).map((_, i) => (
          <Skeleton key={i} className="h-12 w-full" />
        ))}
      </div>
    );
  }

  if (error) {
    return <ErrorState message={error} onRetry={mutate} />;
  }

  if (!notifications || notifications.length === 0) {
    return (
      <Card>
        <CardContent className="py-12 text-center">
          <p className="text-muted-foreground">No notifications sent yet.</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <>
      <div className="rounded-md border">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b bg-muted/50">
              <th className="h-10 px-4 text-left font-medium text-muted-foreground">
                Recipient
              </th>
              <th className="h-10 px-4 text-left font-medium text-muted-foreground">
                Subject
              </th>
              <th className="h-10 px-4 text-left font-medium text-muted-foreground">
                Template
              </th>
              <th className="h-10 px-4 text-left font-medium text-muted-foreground">
                Status
              </th>
              <th className="h-10 px-4 text-left font-medium text-muted-foreground">
                Sent At
              </th>
            </tr>
          </thead>
          <tbody>
            {notifications.map((notif) => (
              <tr
                key={notif.id}
                className="border-b hover:bg-muted/30 cursor-pointer transition-colors"
                onClick={() => setSelectedNotification(notif)}
              >
                <td className="px-4 py-3">{notif.recipient}</td>
                <td className="px-4 py-3 max-w-xs truncate">{notif.subject}</td>
                <td className="px-4 py-3 text-muted-foreground">
                  {notif.template_name || "\u2014"}
                </td>
                <td className="px-4 py-3">
                  <Badge variant={notificationStatusVariant(notif.status)}>
                    {notif.status}
                  </Badge>
                </td>
                <td className="px-4 py-3 text-xs text-muted-foreground">
                  {notif.sent_at
                    ? new Date(notif.sent_at).toLocaleString()
                    : "\u2014"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {selectedNotification && (
        <NotificationDetailDialog
          notification={selectedNotification}
          onClose={() => setSelectedNotification(null)}
        />
      )}
    </>
  );
}
