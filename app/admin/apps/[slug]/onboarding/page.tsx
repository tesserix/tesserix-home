"use client";

import { useState, useMemo, useEffect, use, useCallback } from "react";
import { useRouter } from "next/navigation";
import {
  Search,
  Plus,
  MoreHorizontal,
  ChevronRight,
  Pencil,
  Trash2,
  Eye,
  EyeOff,
  ExternalLink,
  CheckCircle,
  XCircle,
  MessageSquare,
} from "lucide-react";
import Link from "next/link";
import {
  useToast,
  Button,
  Input,
  Badge,
  Label,
  Textarea,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
  Tabs,
  TabsList,
  TabsTrigger,
  TabsContent,
  ErrorState,
  EmptyState,
  EmptyStateTitle,
  EmptyStateDescription,
  ConfirmDialog,
} from "@tesserix/web";
import { AdminHeader } from "@/components/admin/header";
import { TableSkeleton } from "@/components/admin/table-skeleton";
import {
  useOnboardingContent,
  createOnboardingItem,
  updateOnboardingItem,
  deleteOnboardingItem,
  approveTestimonial,
  rejectTestimonial,
  requestTestimonialRevision,
  CONTENT_TYPES,
  type ContentType,
  type FAQ,
  type Feature,
  type Testimonial,
  type TrustBadge,
  type Contact,
  type CountryDefault,
  type Integration,
  type Guide,
  type PresentationSlide,
} from "@/lib/api/onboarding-content";

const APP_NAMES: Record<string, string> = {
  mark8ly: "Mark8ly",
};

const ONBOARDING_SITE_URL = process.env.NEXT_PUBLIC_ONBOARDING_SITE_URL || "https://dev-onboarding.tesserix.app";

function useDebounce(value: string, delay: number) {
  const [debouncedValue, setDebouncedValue] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedValue(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);
  return debouncedValue;
}

// ─── Simple type inline editing dialogs ────────────────────────────────────

interface EditDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  children: React.ReactNode;
  onSave: () => void;
  saving: boolean;
}

function EditDialog({ open, onOpenChange, title, children, onSave, saving }: EditDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>Fill in the details below.</DialogDescription>
        </DialogHeader>
        <div className="space-y-4 py-2">
          {children}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={onSave} disabled={saving}>
            {saving ? "Saving..." : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function FormField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-2">
      <Label>{label}</Label>
      {children}
    </div>
  );
}

// ─── Content type table renderers ────────────────────────────────────────────

function FAQsTable({ items, onEdit, onDelete, onToggleActive }: TableProps<FAQ>) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Question</TableHead>
          <TableHead>Context</TableHead>
          <TableHead>Order</TableHead>
          <TableHead>Status</TableHead>
          <TableHead className="w-10"></TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {items.map((faq) => (
          <TableRow key={faq.id}>
            <TableCell>
              <div className="font-medium">{faq.question}</div>
              <p className="text-sm text-muted-foreground line-clamp-1">{faq.answer}</p>
            </TableCell>
            <TableCell>
              <Badge variant="secondary">{faq.pageContext}</Badge>
            </TableCell>
            <TableCell className="text-muted-foreground">{faq.sortOrder}</TableCell>
            <TableCell>
              <Badge variant={faq.active ? "success" : "secondary"}>
                {faq.active ? "Active" : "Inactive"}
              </Badge>
            </TableCell>
            <TableCell>
              <ActionMenu item={faq} onEdit={onEdit} onDelete={onDelete} onToggleActive={onToggleActive} />
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function FeaturesTable({ items, onEdit, onDelete, onToggleActive }: TableProps<Feature>) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Title</TableHead>
          <TableHead>Category</TableHead>
          <TableHead>Icon</TableHead>
          <TableHead>Order</TableHead>
          <TableHead>Status</TableHead>
          <TableHead className="w-10"></TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {items.map((feature) => (
          <TableRow key={feature.id}>
            <TableCell>
              <div className="font-medium">{feature.title}</div>
              <p className="text-sm text-muted-foreground line-clamp-1">{feature.description}</p>
            </TableCell>
            <TableCell>{feature.category || "-"}</TableCell>
            <TableCell className="text-muted-foreground">{feature.iconName || "-"}</TableCell>
            <TableCell className="text-muted-foreground">{feature.sortOrder}</TableCell>
            <TableCell>
              <Badge variant={feature.active ? "success" : "secondary"}>
                {feature.active ? "Active" : "Inactive"}
              </Badge>
            </TableCell>
            <TableCell>
              <ActionMenu item={feature} onEdit={onEdit} onDelete={onDelete} onToggleActive={onToggleActive} />
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

interface TestimonialTableProps extends TableProps<Testimonial> {
  onApprove: (item: Testimonial) => void;
  onReject: (item: Testimonial) => void;
  onRequestRevision: (item: Testimonial) => void;
}

function TestimonialsTable({ items, onEdit, onDelete, onToggleActive, onApprove, onReject, onRequestRevision }: TestimonialTableProps) {
  const getStatusBadge = (status: string) => {
    switch (status) {
      case 'pending':
        return <Badge variant="warning">Pending Review</Badge>;
      case 'approved':
        return <Badge variant="success">Approved</Badge>;
      case 'rejected':
        return <Badge variant="destructive">Rejected</Badge>;
      case 'revision_needed':
        return <Badge variant="secondary">Needs Revision</Badge>;
      default:
        return <Badge variant="secondary">{status}</Badge>;
    }
  };

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Name</TableHead>
          <TableHead>Quote</TableHead>
          <TableHead>Rating</TableHead>
          <TableHead>Approval Status</TableHead>
          <TableHead>Active</TableHead>
          <TableHead className="w-10"></TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {items.map((testimonial) => (
          <TableRow key={testimonial.id}>
            <TableCell>
              <div className="font-medium">{testimonial.name}</div>
              <p className="text-sm text-muted-foreground">{testimonial.role} {testimonial.company && `@ ${testimonial.company}`}</p>
            </TableCell>
            <TableCell>
              <p className="text-sm line-clamp-2">{testimonial.quote}</p>
            </TableCell>
            <TableCell className="text-muted-foreground">{"★".repeat(testimonial.rating)}</TableCell>
            <TableCell>
              {getStatusBadge(testimonial.status)}
            </TableCell>
            <TableCell>
              <Badge variant={testimonial.active ? "success" : "secondary"}>
                {testimonial.active ? "Active" : "Inactive"}
              </Badge>
            </TableCell>
            <TableCell>
              <div className="flex items-center gap-2">
                {testimonial.status === 'pending' && (
                  <>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => onApprove(testimonial)}
                      title="Approve"
                    >
                      <CheckCircle className="h-4 w-4 text-green-600" />
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => onReject(testimonial)}
                      title="Reject"
                    >
                      <XCircle className="h-4 w-4 text-red-600" />
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => onRequestRevision(testimonial)}
                      title="Request Revision"
                    >
                      <MessageSquare className="h-4 w-4 text-orange-600" />
                    </Button>
                  </>
                )}
                <ActionMenu item={testimonial} onEdit={onEdit} onDelete={onDelete} onToggleActive={onToggleActive} />
              </div>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function TrustBadgesTable({ items, onEdit, onDelete, onToggleActive }: TableProps<TrustBadge>) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Label</TableHead>
          <TableHead>Icon</TableHead>
          <TableHead>Order</TableHead>
          <TableHead>Status</TableHead>
          <TableHead className="w-10"></TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {items.map((badge) => (
          <TableRow key={badge.id}>
            <TableCell>
              <div className="font-medium">{badge.label}</div>
              {badge.description && <p className="text-sm text-muted-foreground line-clamp-1">{badge.description}</p>}
            </TableCell>
            <TableCell className="text-muted-foreground">{badge.iconName || "-"}</TableCell>
            <TableCell className="text-muted-foreground">{badge.sortOrder}</TableCell>
            <TableCell>
              <Badge variant={badge.active ? "success" : "secondary"}>
                {badge.active ? "Active" : "Inactive"}
              </Badge>
            </TableCell>
            <TableCell>
              <ActionMenu item={badge} onEdit={onEdit} onDelete={onDelete} onToggleActive={onToggleActive} />
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function ContactsTable({ items, onEdit, onDelete, onToggleActive }: TableProps<Contact>) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Label</TableHead>
          <TableHead>Type</TableHead>
          <TableHead>Contact Info</TableHead>
          <TableHead>Status</TableHead>
          <TableHead className="w-10"></TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {items.map((contact) => (
          <TableRow key={contact.id}>
            <TableCell className="font-medium">{contact.label}</TableCell>
            <TableCell><Badge variant="secondary">{contact.type}</Badge></TableCell>
            <TableCell className="text-muted-foreground">
              {contact.email || contact.phone || "-"}
            </TableCell>
            <TableCell>
              <Badge variant={contact.active ? "success" : "secondary"}>
                {contact.active ? "Active" : "Inactive"}
              </Badge>
            </TableCell>
            <TableCell>
              <ActionMenu item={contact} onEdit={onEdit} onDelete={onDelete} onToggleActive={onToggleActive} />
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function CountryDefaultsTable({ items, onEdit, onDelete, onToggleActive }: TableProps<CountryDefault>) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Country</TableHead>
          <TableHead>Code</TableHead>
          <TableHead>Currency</TableHead>
          <TableHead>Timezone</TableHead>
          <TableHead>Status</TableHead>
          <TableHead className="w-10"></TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {items.map((country) => (
          <TableRow key={country.id}>
            <TableCell className="font-medium">
              {country.flagEmoji && `${country.flagEmoji} `}{country.countryName}
            </TableCell>
            <TableCell className="text-muted-foreground">{country.countryCode}</TableCell>
            <TableCell className="text-muted-foreground">{country.defaultCurrency}</TableCell>
            <TableCell className="text-muted-foreground text-sm">{country.defaultTimezone}</TableCell>
            <TableCell>
              <Badge variant={country.active ? "success" : "secondary"}>
                {country.active ? "Active" : "Inactive"}
              </Badge>
            </TableCell>
            <TableCell>
              <ActionMenu item={country} onEdit={onEdit} onDelete={onDelete} onToggleActive={onToggleActive} />
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

// Complex types — table with link to detail page

function IntegrationsTable({ items, onDelete, onToggleActive, slug }: TableProps<Integration> & { slug: string }) {
  const router = useRouter();
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Name</TableHead>
          <TableHead>Category</TableHead>
          <TableHead>Features</TableHead>
          <TableHead>Integration Status</TableHead>
          <TableHead>Active</TableHead>
          <TableHead className="w-10"></TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {items.map((integration) => (
          <TableRow key={integration.id}>
            <TableCell>
              <button
                onClick={() => router.push(`/admin/apps/${slug}/onboarding/integrations/${integration.id}`)}
                className="text-left font-medium hover:underline"
              >
                {integration.name}
              </button>
              {integration.description && <p className="text-sm text-muted-foreground line-clamp-1">{integration.description}</p>}
            </TableCell>
            <TableCell><Badge variant="secondary">{integration.category}</Badge></TableCell>
            <TableCell className="text-muted-foreground">{integration.features?.length || 0}</TableCell>
            <TableCell><Badge variant="secondary">{integration.status}</Badge></TableCell>
            <TableCell>
              <Badge variant={integration.active ? "success" : "secondary"}>
                {integration.active ? "Active" : "Inactive"}
              </Badge>
            </TableCell>
            <TableCell>
              <ActionMenu
                item={integration}
                onEdit={() => router.push(`/admin/apps/${slug}/onboarding/integrations/${integration.id}`)}
                onDelete={onDelete}
                onToggleActive={onToggleActive}
              />
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function GuidesTable({ items, onDelete, onToggleActive, slug }: TableProps<Guide> & { slug: string }) {
  const router = useRouter();
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Title</TableHead>
          <TableHead>Slug</TableHead>
          <TableHead>Duration</TableHead>
          <TableHead>Steps</TableHead>
          <TableHead>Status</TableHead>
          <TableHead className="w-10"></TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {items.map((guide) => (
          <TableRow key={guide.id}>
            <TableCell>
              <button
                onClick={() => router.push(`/admin/apps/${slug}/onboarding/guides/${guide.id}`)}
                className="text-left font-medium hover:underline"
              >
                {guide.title}
              </button>
              {guide.description && <p className="text-sm text-muted-foreground line-clamp-1">{guide.description}</p>}
            </TableCell>
            <TableCell className="text-muted-foreground">{guide.slug}</TableCell>
            <TableCell className="text-muted-foreground">{guide.duration || "-"}</TableCell>
            <TableCell className="text-muted-foreground">{guide.steps?.length || 0}</TableCell>
            <TableCell>
              <Badge variant={guide.active ? "success" : "secondary"}>
                {guide.active ? "Active" : "Inactive"}
              </Badge>
            </TableCell>
            <TableCell>
              <ActionMenu
                item={guide}
                onEdit={() => router.push(`/admin/apps/${slug}/onboarding/guides/${guide.id}`)}
                onDelete={onDelete}
                onToggleActive={onToggleActive}
              />
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function SlidesTable({ items, onDelete, onToggleActive, slug }: TableProps<PresentationSlide> & { slug: string }) {
  const router = useRouter();
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>#</TableHead>
          <TableHead>Title</TableHead>
          <TableHead>Type</TableHead>
          <TableHead>Label</TableHead>
          <TableHead>Status</TableHead>
          <TableHead className="w-10"></TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {items.map((slide) => (
          <TableRow key={slide.id}>
            <TableCell className="font-medium">{slide.slideNumber}</TableCell>
            <TableCell>
              <button
                onClick={() => router.push(`/admin/apps/${slug}/onboarding/slides/${slide.id}`)}
                className="text-left font-medium hover:underline"
              >
                {slide.title || "(untitled)"}
              </button>
              {slide.subtitle && <p className="text-sm text-muted-foreground line-clamp-1">{slide.subtitle}</p>}
            </TableCell>
            <TableCell><Badge variant="secondary">{slide.type}</Badge></TableCell>
            <TableCell className="text-muted-foreground">{slide.label || "-"}</TableCell>
            <TableCell>
              <Badge variant={slide.active ? "success" : "secondary"}>
                {slide.active ? "Active" : "Inactive"}
              </Badge>
            </TableCell>
            <TableCell>
              <ActionMenu
                item={slide}
                onEdit={() => router.push(`/admin/apps/${slug}/onboarding/slides/${slide.id}`)}
                onDelete={onDelete}
                onToggleActive={onToggleActive}
              />
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

// ─── Shared components ──────────────────────────────────────────────────────

interface TableProps<T extends { id: string; active?: boolean }> {
  items: T[];
  onEdit: (item: T) => void;
  onDelete: (item: T) => void;
  onToggleActive: (item: T) => void;
}

function ActionMenu<T extends { id: string; active?: boolean }>({
  item,
  onEdit,
  onDelete,
  onToggleActive,
}: {
  item: T;
  onEdit: (item: T) => void;
  onDelete: (item: T) => void;
  onToggleActive: (item: T) => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon">
          <MoreHorizontal className="h-4 w-4" />
          <span className="sr-only">Actions</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent>
        <DropdownMenuItem onClick={() => onEdit(item)}>
          <Pencil className="mr-2 h-4 w-4" />
          Edit
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => onToggleActive(item)}>
          {item.active ? (
            <>
              <EyeOff className="mr-2 h-4 w-4" />
              Deactivate
            </>
          ) : (
            <>
              <Eye className="mr-2 h-4 w-4" />
              Activate
            </>
          )}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem className="text-destructive" onClick={() => onDelete(item)}>
          <Trash2 className="mr-2 h-4 w-4" />
          Delete
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// ─── Form fields per content type ────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function FAQFormFields({ form, setForm }: { form: any; setForm: (f: any) => void }) {
  return (
    <>
      <FormField label="Question">
        <Input value={form.question || ""} onChange={(e) => setForm({ ...form, question: e.target.value })} />
      </FormField>
      <FormField label="Answer">
        <Textarea value={form.answer || ""} onChange={(e) => setForm({ ...form, answer: e.target.value })} rows={4} />
      </FormField>
      <div className="grid grid-cols-2 gap-4">
        <FormField label="Page Context">
          <Input value={form.pageContext || "home"} onChange={(e) => setForm({ ...form, pageContext: e.target.value })} />
        </FormField>
        <FormField label="Sort Order">
          <Input type="number" value={form.sortOrder ?? 0} onChange={(e) => setForm({ ...form, sortOrder: parseInt(e.target.value) || 0 })} />
        </FormField>
      </div>
    </>
  );
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function FeatureFormFields({ form, setForm }: { form: any; setForm: (f: any) => void }) {
  return (
    <>
      <FormField label="Title">
        <Input value={form.title || ""} onChange={(e) => setForm({ ...form, title: e.target.value })} />
      </FormField>
      <FormField label="Description">
        <Textarea value={form.description || ""} onChange={(e) => setForm({ ...form, description: e.target.value })} rows={3} />
      </FormField>
      <div className="grid grid-cols-2 gap-4">
        <FormField label="Icon Name">
          <Input value={form.iconName || ""} onChange={(e) => setForm({ ...form, iconName: e.target.value })} />
        </FormField>
        <FormField label="Category">
          <Input value={form.category || ""} onChange={(e) => setForm({ ...form, category: e.target.value })} />
        </FormField>
      </div>
      <div className="grid grid-cols-2 gap-4">
        <FormField label="Page Context">
          <Input value={form.pageContext || "home"} onChange={(e) => setForm({ ...form, pageContext: e.target.value })} />
        </FormField>
        <FormField label="Sort Order">
          <Input type="number" value={form.sortOrder ?? 0} onChange={(e) => setForm({ ...form, sortOrder: parseInt(e.target.value) || 0 })} />
        </FormField>
      </div>
    </>
  );
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function TestimonialFormFields({ form, setForm }: { form: any; setForm: (f: any) => void }) {
  return (
    <>
      <FormField label="Quote">
        <Textarea value={form.quote || ""} onChange={(e) => setForm({ ...form, quote: e.target.value })} rows={3} />
      </FormField>
      <div className="grid grid-cols-2 gap-4">
        <FormField label="Name">
          <Input value={form.name || ""} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        </FormField>
        <FormField label="Role">
          <Input value={form.role || ""} onChange={(e) => setForm({ ...form, role: e.target.value })} />
        </FormField>
      </div>
      <div className="grid grid-cols-2 gap-4">
        <FormField label="Company">
          <Input value={form.company || ""} onChange={(e) => setForm({ ...form, company: e.target.value })} />
        </FormField>
        <FormField label="Rating (1-5)">
          <Input type="number" min={1} max={5} value={form.rating ?? 5} onChange={(e) => setForm({ ...form, rating: parseInt(e.target.value) || 5 })} />
        </FormField>
      </div>
      <FormField label="Sort Order">
        <Input type="number" value={form.sortOrder ?? 0} onChange={(e) => setForm({ ...form, sortOrder: parseInt(e.target.value) || 0 })} />
      </FormField>
    </>
  );
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function TrustBadgeFormFields({ form, setForm }: { form: any; setForm: (f: any) => void }) {
  return (
    <>
      <FormField label="Label">
        <Input value={form.label || ""} onChange={(e) => setForm({ ...form, label: e.target.value })} />
      </FormField>
      <FormField label="Description">
        <Textarea value={form.description || ""} onChange={(e) => setForm({ ...form, description: e.target.value })} rows={2} />
      </FormField>
      <div className="grid grid-cols-2 gap-4">
        <FormField label="Icon Name">
          <Input value={form.iconName || ""} onChange={(e) => setForm({ ...form, iconName: e.target.value })} />
        </FormField>
        <FormField label="Sort Order">
          <Input type="number" value={form.sortOrder ?? 0} onChange={(e) => setForm({ ...form, sortOrder: parseInt(e.target.value) || 0 })} />
        </FormField>
      </div>
    </>
  );
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function ContactFormFields({ form, setForm }: { form: any; setForm: (f: any) => void }) {
  return (
    <>
      <div className="grid grid-cols-2 gap-4">
        <FormField label="Label">
          <Input value={form.label || ""} onChange={(e) => setForm({ ...form, label: e.target.value })} />
        </FormField>
        <FormField label="Type">
          <Input value={form.type || ""} onChange={(e) => setForm({ ...form, type: e.target.value })} placeholder="email, phone, address..." />
        </FormField>
      </div>
      <div className="grid grid-cols-2 gap-4">
        <FormField label="Email">
          <Input type="email" value={form.email || ""} onChange={(e) => setForm({ ...form, email: e.target.value })} />
        </FormField>
        <FormField label="Phone">
          <Input value={form.phone || ""} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
        </FormField>
      </div>
      <FormField label="Sort Order">
        <Input type="number" value={form.sortOrder ?? 0} onChange={(e) => setForm({ ...form, sortOrder: parseInt(e.target.value) || 0 })} />
      </FormField>
    </>
  );
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function CountryDefaultFormFields({ form, setForm }: { form: any; setForm: (f: any) => void }) {
  return (
    <>
      <div className="grid grid-cols-2 gap-4">
        <FormField label="Country Code">
          <Input value={form.countryCode || ""} onChange={(e) => setForm({ ...form, countryCode: e.target.value.toUpperCase() })} maxLength={2} placeholder="IN" />
        </FormField>
        <FormField label="Country Name">
          <Input value={form.countryName || ""} onChange={(e) => setForm({ ...form, countryName: e.target.value })} placeholder="India" />
        </FormField>
      </div>
      <div className="grid grid-cols-2 gap-4">
        <FormField label="Default Currency">
          <Input value={form.defaultCurrency || ""} onChange={(e) => setForm({ ...form, defaultCurrency: e.target.value.toUpperCase() })} maxLength={3} placeholder="INR" />
        </FormField>
        <FormField label="Default Timezone">
          <Input value={form.defaultTimezone || ""} onChange={(e) => setForm({ ...form, defaultTimezone: e.target.value })} placeholder="Asia/Kolkata" />
        </FormField>
      </div>
      <div className="grid grid-cols-3 gap-4">
        <FormField label="Language">
          <Input value={form.defaultLanguage || "en"} onChange={(e) => setForm({ ...form, defaultLanguage: e.target.value })} />
        </FormField>
        <FormField label="Calling Code">
          <Input value={form.callingCode || ""} onChange={(e) => setForm({ ...form, callingCode: e.target.value })} placeholder="+91" />
        </FormField>
        <FormField label="Flag Emoji">
          <Input value={form.flagEmoji || ""} onChange={(e) => setForm({ ...form, flagEmoji: e.target.value })} />
        </FormField>
      </div>
    </>
  );
}

// Simple types that use inline modal editing
const SIMPLE_TYPES: ContentType[] = ["faqs", "features", "testimonials", "trust-badges", "contacts", "country-defaults"];
// Complex types that link to detail pages
const COMPLEX_TYPES: ContentType[] = ["integrations", "guides", "presentation-slides"];

// ─── Main Page ──────────────────────────────────────────────────────────────

export default function OnboardingPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = use(params);
  const appName = APP_NAMES[slug] || slug;
  const router = useRouter();
  const { toast } = useToast();
  const [activeTab, setActiveTab] = useState<ContentType>("faqs");
  const [search, setSearch] = useState("");
  const debouncedSearch = useDebounce(search, 300);

  // Fetch data for active tab
  const { data, isLoading, error, mutate } = useOnboardingContent(activeTab);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const items = useMemo(() => (data as any)?.data ?? [], [data]);

  // Filter items by search
  const filteredItems = useMemo(() => {
    if (!debouncedSearch) return items;
    const q = debouncedSearch.toLowerCase();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return items.filter((item: any) => {
      const searchable = [
        item.question, item.answer, item.title, item.description,
        item.name, item.quote, item.label, item.countryName,
        item.slug, item.feature, item.subtitle,
      ].filter(Boolean).join(" ").toLowerCase();
      return searchable.includes(q);
    });
  }, [items, debouncedSearch]);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [deleteTarget, setDeleteTarget] = useState<any>(null);
  const [deleteLoading, setDeleteLoading] = useState(false);

  // Dialog state for inline editing
  const [dialogOpen, setDialogOpen] = useState(false);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [editingItem, setEditingItem] = useState<any>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [form, setForm] = useState<any>({});
  const [saving, setSaving] = useState(false);

  const openCreate = useCallback(() => {
    setEditingItem(null);
    setForm({});
    setDialogOpen(true);
  }, []);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const openEdit = useCallback((item: any) => {
    setEditingItem(item);
    setForm({ ...item });
    setDialogOpen(true);
  }, []);

  const handleSave = useCallback(async () => {
    setSaving(true);
    try {
      if (editingItem) {
        const { error: err } = await updateOnboardingItem(activeTab, editingItem.id, form);
        if (err) { toast({ title: err, variant: "destructive" }); return; }
        toast({ title: "Item updated successfully", variant: "success" });
      } else {
        const { error: err } = await createOnboardingItem(activeTab, form);
        if (err) { toast({ title: err, variant: "destructive" }); return; }
        toast({ title: "Item created successfully", variant: "success" });
      }
      setDialogOpen(false);
      mutate();
    } finally {
      setSaving(false);
    }
  }, [editingItem, activeTab, form, mutate]);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const handleDelete = useCallback((item: any) => {
    setDeleteTarget(item);
  }, []);

  const confirmDelete = useCallback(async () => {
    if (!deleteTarget) return;
    setDeleteLoading(true);
    const { error: err } = await deleteOnboardingItem(activeTab, deleteTarget.id);
    setDeleteLoading(false);
    if (err) { toast({ title: err, variant: "destructive" }); setDeleteTarget(null); return; }
    toast({ title: "Item deleted", variant: "success" });
    setDeleteTarget(null);
    mutate();
  }, [activeTab, deleteTarget, mutate]);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const handleToggleActive = useCallback(async (item: any) => {
    const { error: err } = await updateOnboardingItem(activeTab, item.id, { active: !item.active });
    if (err) { toast({ title: err, variant: "destructive" }); return; }
    toast({ title: item.active ? "Item deactivated" : "Item activated", variant: "success" });
    mutate();
  }, [activeTab, mutate]);

  // Testimonial approval handlers
  const handleApprove = useCallback(async (testimonial: Testimonial) => {
    const { error: err } = await approveTestimonial(testimonial.id, { pageContext: 'home' });
    if (err) { toast({ title: err, variant: "destructive" }); return; }
    toast({ title: "Testimonial approved successfully", variant: "success" });
    mutate();
  }, [mutate]);

  const handleReject = useCallback(async (testimonial: Testimonial) => {
    const { error: err } = await rejectTestimonial(testimonial.id, {});
    if (err) { toast({ title: err, variant: "destructive" }); return; }
    toast({ title: "Testimonial rejected", variant: "success" });
    mutate();
  }, [mutate]);

  const [revisionDialogOpen, setRevisionDialogOpen] = useState(false);
  const [revisionTarget, setRevisionTarget] = useState<Testimonial | null>(null);
  const [revisionNotes, setRevisionNotes] = useState("");

  const handleRequestRevision = useCallback((testimonial: Testimonial) => {
    setRevisionTarget(testimonial);
    setRevisionNotes("");
    setRevisionDialogOpen(true);
  }, []);

  const confirmRequestRevision = useCallback(async () => {
    if (!revisionTarget || !revisionNotes.trim()) {
      toast({ title: "Please provide revision notes", variant: "destructive" });
      return;
    }
    const { error: err } = await requestTestimonialRevision(revisionTarget.id, { revisionNotes });
    if (err) { toast({ title: err, variant: "destructive" }); return; }
    toast({ title: "Revision requested successfully", variant: "success" });
    setRevisionDialogOpen(false);
    setRevisionTarget(null);
    setRevisionNotes("");
    mutate();
  }, [revisionTarget, revisionNotes, mutate]);

  const handleCreateComplex = useCallback(() => {
    // For complex types, we create first then navigate to detail page
    const doCreate = async () => {
      let defaults = {};
      switch (activeTab) {
        case "integrations":
          defaults = { name: "New Integration", category: "other" };
          break;
        case "guides":
          defaults = { title: "New Guide", slug: "new-guide" };
          break;
        case "presentation-slides":
          defaults = { slideNumber: (items.length || 0) + 1, type: "content" };
          break;
      }
      const { data: result, error: err } = await createOnboardingItem(activeTab, defaults);
      if (err) { toast({ title: err, variant: "destructive" }); return; }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const newItem = (result as any)?.data;
      if (!newItem?.id) { mutate(); return; }
      const typeSlug = activeTab === "presentation-slides" ? "slides"
        : activeTab;
      router.push(`/admin/apps/${slug}/onboarding/${typeSlug}/${newItem.id}`);
    };
    doCreate();
  }, [activeTab, items, slug, router, mutate]);

  const isSimple = SIMPLE_TYPES.includes(activeTab);

  // Get form fields for the active simple type
  function renderFormFields() {
    switch (activeTab) {
      case "faqs": return <FAQFormFields form={form} setForm={setForm} />;
      case "features": return <FeatureFormFields form={form} setForm={setForm} />;
      case "testimonials": return <TestimonialFormFields form={form} setForm={setForm} />;
      case "trust-badges": return <TrustBadgeFormFields form={form} setForm={setForm} />;
      case "contacts": return <ContactFormFields form={form} setForm={setForm} />;
      case "country-defaults": return <CountryDefaultFormFields form={form} setForm={setForm} />;
      default: return null;
    }
  }

  function renderTable() {
    const tableProps = {
      items: filteredItems,
      onEdit: isSimple ? openEdit : () => {},
      onDelete: handleDelete,
      onToggleActive: handleToggleActive,
    };

    switch (activeTab) {
      case "faqs": return <FAQsTable {...tableProps} />;
      case "features": return <FeaturesTable {...tableProps} />;
      case "testimonials": return <TestimonialsTable {...tableProps} onApprove={handleApprove} onReject={handleReject} onRequestRevision={handleRequestRevision} />;
      case "trust-badges": return <TrustBadgesTable {...tableProps} />;
      case "contacts": return <ContactsTable {...tableProps} />;
      case "country-defaults": return <CountryDefaultsTable {...tableProps} />;
      case "integrations": return <IntegrationsTable {...tableProps} slug={slug} />;
      case "guides": return <GuidesTable {...tableProps} slug={slug} />;
      case "presentation-slides": return <SlidesTable {...tableProps} slug={slug} />;
      default: return null;
    }
  }

  const activeTypeConfig = CONTENT_TYPES.find((t) => t.key === activeTab);

  return (
    <>
      <AdminHeader
        title="Onboarding Content"
        description={`Manage onboarding page content for ${appName}`}
      />

      <main className="p-6 space-y-6">
        {/* Breadcrumb + Preview */}
        <div className="flex items-center justify-between">
          <nav className="flex items-center gap-1 text-sm text-muted-foreground">
            <Link href={`/admin/apps/${slug}`} className="hover:text-foreground transition-colors">
              {appName}
            </Link>
            <ChevronRight className="h-4 w-4" />
            <span className="text-foreground font-medium">Onboarding</span>
          </nav>
          <Button variant="outline" size="sm" asChild>
            <a href={ONBOARDING_SITE_URL} target="_blank" rel="noopener noreferrer">
              <ExternalLink className="mr-2 h-4 w-4" />
              Preview Site
            </a>
          </Button>
        </div>

        {/* Tabs */}
        <Tabs value={activeTab} onValueChange={(v) => { setActiveTab(v as ContentType); setSearch(""); }}>
          <div className="flex items-center justify-between gap-4">
            <TabsList className="flex-wrap h-auto gap-1">
              {CONTENT_TYPES.map((ct) => (
                <TabsTrigger key={ct.key} value={ct.key}>
                  {ct.shortLabel}
                </TabsTrigger>
              ))}
            </TabsList>
          </div>

          {/* Search + Create */}
          <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 mt-4">
            <div className="relative flex-1 max-w-md">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                placeholder={`Search ${activeTypeConfig?.label || ""}...`}
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="pl-9"
              />
            </div>
            <Button onClick={isSimple ? openCreate : handleCreateComplex}>
              <Plus className="mr-2 h-4 w-4" />
              Add {activeTypeConfig?.shortLabel}
            </Button>
          </div>

          {/* Tab content — all share the same loading/error/table pattern */}
          {CONTENT_TYPES.map((ct) => (
            <TabsContent key={ct.key} value={ct.key}>
              {isLoading ? (
                <TableSkeleton columns={5} rows={5} />
              ) : error ? (
                <ErrorState message={error} onRetry={mutate} />
              ) : filteredItems.length === 0 ? (
                <EmptyState>
                  <EmptyStateTitle>{`No ${ct.label.toLowerCase()} found`}</EmptyStateTitle>
                  <EmptyStateDescription>
                    {debouncedSearch
                      ? "Try adjusting your search"
                      : `Create the first ${ct.label.toLowerCase()} item`}
                  </EmptyStateDescription>
                </EmptyState>
              ) : (
                <div className="rounded-lg border bg-card">
                  {renderTable()}
                </div>
              )}

              <p className="text-sm text-muted-foreground mt-2">
                Showing {filteredItems.length} of {items.length} {ct.label.toLowerCase()}
              </p>
            </TabsContent>
          ))}
        </Tabs>

        {/* Inline edit dialog for simple types */}
        {isSimple && (
          <EditDialog
            open={dialogOpen}
            onOpenChange={setDialogOpen}
            title={editingItem ? `Edit ${activeTypeConfig?.shortLabel}` : `New ${activeTypeConfig?.shortLabel}`}
            onSave={handleSave}
            saving={saving}
          >
            {renderFormFields()}
          </EditDialog>
        )}

        <ConfirmDialog
          open={!!deleteTarget}
          onOpenChange={(open) => { if (!open) setDeleteTarget(null); }}
          title="Delete Item"
          description="Are you sure you want to delete this item? This action cannot be undone."
          confirmLabel="Delete"
          variant="destructive"
          onConfirm={confirmDelete}
          loading={deleteLoading}
        />

        {/* Revision Request Dialog */}
        <Dialog open={revisionDialogOpen} onOpenChange={setRevisionDialogOpen}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Request Revision</DialogTitle>
              <DialogDescription>
                Provide feedback for the testimonial author to make revisions.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-4">
              <div>
                <Label htmlFor="revision-notes">Revision Notes</Label>
                <Textarea
                  id="revision-notes"
                  value={revisionNotes}
                  onChange={(e) => setRevisionNotes(e.target.value)}
                  placeholder="Please explain what needs to be revised..."
                  rows={4}
                  className="mt-2"
                />
              </div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setRevisionDialogOpen(false)}>
                Cancel
              </Button>
              <Button onClick={confirmRequestRevision}>
                Send Request
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </main>
    </>
  );
}
