"use client";

import { useState, useCallback, useMemo, use } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
  ArrowLeft,
  Save,
  Globe,
  Eye,
  EyeOff,
  Archive,
  Clock,
} from "lucide-react";
import { AdminHeader } from "@/components/admin/header";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { RichTextEditor } from "@/components/ui/rich-text-editor";
import {
  useContentPages,
  saveContentPages,
  createPage,
  updatePage,
  generateSlug,
  type ContentPage,
  type ContentPageType,
  type ContentPageStatus,
} from "@/lib/api/content";

function ContentEditorForm({
  existingPage,
  allPages,
  tenantId,
  isNew,
  pageId,
  slug,
  onMutate,
}: {
  existingPage: ContentPage | null;
  allPages: ContentPage[];
  tenantId: string;
  isNew: boolean;
  pageId: string;
  slug: string;
  onMutate: () => void;
}) {
  const router = useRouter();

  const [title, setTitle] = useState(existingPage?.title ?? "");
  const [pageSlug, setPageSlug] = useState(existingPage?.slug ?? "");
  const [content, setContent] = useState(existingPage?.content ?? "");
  const [excerpt, setExcerpt] = useState(existingPage?.excerpt ?? "");
  const [type, setType] = useState<ContentPageType>(existingPage?.type ?? "STATIC");
  const [status, setStatus] = useState<ContentPageStatus>(existingPage?.status ?? "DRAFT");
  const [metaTitle, setMetaTitle] = useState(existingPage?.metaTitle ?? "");
  const [metaDescription, setMetaDescription] = useState(existingPage?.metaDescription ?? "");
  const [featuredImage, setFeaturedImage] = useState(existingPage?.featuredImage ?? "");
  const [authorName, setAuthorName] = useState(existingPage?.authorName ?? "");
  const [showInMenu, setShowInMenu] = useState(existingPage?.showInMenu ?? false);
  const [showInFooter, setShowInFooter] = useState(existingPage?.showInFooter ?? false);
  const [isFeatured, setIsFeatured] = useState(existingPage?.isFeatured ?? false);
  const [slugManuallyEdited, setSlugManuallyEdited] = useState(!isNew);
  const [saving, setSaving] = useState(false);

  const displaySlug = useMemo(() => {
    if (slugManuallyEdited) return pageSlug;
    if (title) return generateSlug(title);
    return pageSlug;
  }, [title, pageSlug, slugManuallyEdited]);

  const handleContentChange = useCallback((val: string) => {
    setContent(val);
  }, []);

  async function handleSave() {
    if (!title.trim()) return;

    setSaving(true);

    const pageData = {
      title: title.trim(),
      slug: displaySlug.trim() || generateSlug(title),
      content,
      excerpt: excerpt.trim() || undefined,
      type,
      status,
      metaTitle: metaTitle.trim() || undefined,
      metaDescription: metaDescription.trim() || undefined,
      featuredImage: featuredImage.trim() || undefined,
      authorName: authorName.trim() || undefined,
      publishedAt: status === "PUBLISHED" ? new Date().toISOString() : undefined,
      showInMenu,
      showInFooter,
      isFeatured,
    };

    let updatedPages: ContentPage[];
    if (isNew) {
      updatedPages = createPage(allPages, pageData);
    } else {
      updatedPages = updatePage(allPages, pageId, pageData);
    }

    const { error } = await saveContentPages(tenantId, updatedPages);
    setSaving(false);

    if (!error) {
      router.push(`/admin/apps/${slug}/content`);
    }
  }

  async function handleStatusAction(action: "publish" | "unpublish" | "archive") {
    if (isNew) return;
    setSaving(true);

    const newStatus: ContentPageStatus =
      action === "publish" ? "PUBLISHED" : action === "unpublish" ? "DRAFT" : "ARCHIVED";

    const updates: Partial<ContentPage> = { status: newStatus };
    if (action === "publish") {
      updates.publishedAt = new Date().toISOString();
    }

    const updatedPages = updatePage(allPages, pageId, updates);
    const { error } = await saveContentPages(tenantId, updatedPages);
    setSaving(false);

    if (!error) {
      setStatus(newStatus);
      onMutate();
    }
  }

  return (
    <>
      <AdminHeader
        title={isNew ? "New Content Page" : "Edit Content Page"}
        description={isNew ? "Create a new page" : title}
      />

      <main className="p-6 space-y-6">
        {/* Top actions */}
        <div className="flex items-center justify-between">
          <Button
            variant="ghost"
            onClick={() => router.push(`/admin/apps/${slug}/content`)}
          >
            <ArrowLeft className="mr-2 h-4 w-4" />
            Back to Content Pages
          </Button>
          <Button onClick={handleSave} disabled={saving || !title.trim()}>
            <Save className="mr-2 h-4 w-4" />
            {saving ? "Saving..." : "Save"}
          </Button>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Left column */}
          <div className="lg:col-span-2 space-y-6">
            <div className="space-y-2">
              <Label htmlFor="title">Title</Label>
              <Input
                id="title"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="Page title"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="slug">Slug</Label>
              <div className="flex items-center gap-2">
                <span className="text-sm text-muted-foreground">/</span>
                <Input
                  id="slug"
                  value={displaySlug}
                  onChange={(e) => {
                    setPageSlug(e.target.value);
                    setSlugManuallyEdited(true);
                  }}
                  placeholder="page-slug"
                />
              </div>
            </div>

            <div className="space-y-2">
              <Label>Content</Label>
              <RichTextEditor
                value={content}
                onChange={handleContentChange}
                placeholder="Start writing your content..."
                minHeight="400px"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="excerpt">Excerpt</Label>
              <Textarea
                id="excerpt"
                value={excerpt}
                onChange={(e) => setExcerpt(e.target.value)}
                placeholder="Brief description of the page..."
                rows={3}
              />
            </div>
          </div>

          {/* Right column */}
          <div className="space-y-6">
            <Card>
              <CardHeader>
                <CardTitle className="text-sm font-medium">Status</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="flex items-center gap-2">
                  <Badge
                    variant={
                      status === "PUBLISHED"
                        ? "success"
                        : status === "DRAFT"
                        ? "warning"
                        : "secondary"
                    }
                  >
                    {status.toLowerCase()}
                  </Badge>
                  {existingPage?.publishedAt && status === "PUBLISHED" && (
                    <span className="text-xs text-muted-foreground">
                      Published{" "}
                      {new Date(existingPage.publishedAt).toLocaleDateString()}
                    </span>
                  )}
                </div>

                {!isNew && (
                  <div className="flex flex-col gap-2">
                    {status === "DRAFT" && (
                      <Button
                        size="sm"
                        onClick={() => handleStatusAction("publish")}
                        disabled={saving}
                      >
                        <Globe className="mr-2 h-4 w-4" />
                        Publish
                      </Button>
                    )}
                    {status === "PUBLISHED" && (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => handleStatusAction("unpublish")}
                        disabled={saving}
                      >
                        <EyeOff className="mr-2 h-4 w-4" />
                        Unpublish
                      </Button>
                    )}
                    {status !== "ARCHIVED" && (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => handleStatusAction("archive")}
                        disabled={saving}
                      >
                        <Archive className="mr-2 h-4 w-4" />
                        Archive
                      </Button>
                    )}
                  </div>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="text-sm font-medium">Page Type</CardTitle>
              </CardHeader>
              <CardContent>
                <Select
                  value={type}
                  onValueChange={(v) => setType(v as ContentPageType)}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="STATIC">Static Page</SelectItem>
                    <SelectItem value="BLOG">Blog Post</SelectItem>
                    <SelectItem value="FAQ">FAQ</SelectItem>
                    <SelectItem value="POLICY">Policy</SelectItem>
                    <SelectItem value="LANDING">Landing Page</SelectItem>
                    <SelectItem value="CUSTOM">Custom</SelectItem>
                  </SelectContent>
                </Select>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="text-sm font-medium">Display Options</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <label className="flex items-center gap-3 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={showInMenu}
                    onChange={(e) => setShowInMenu(e.target.checked)}
                    className="rounded border-border"
                  />
                  <span className="text-sm">Show in navigation menu</span>
                </label>
                <label className="flex items-center gap-3 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={showInFooter}
                    onChange={(e) => setShowInFooter(e.target.checked)}
                    className="rounded border-border"
                  />
                  <span className="text-sm">Show in footer</span>
                </label>
                <label className="flex items-center gap-3 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={isFeatured}
                    onChange={(e) => setIsFeatured(e.target.checked)}
                    className="rounded border-border"
                  />
                  <span className="text-sm">Featured page</span>
                </label>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="text-sm font-medium">SEO</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="metaTitle" className="text-xs">Meta Title</Label>
                  <Input
                    id="metaTitle"
                    value={metaTitle}
                    onChange={(e) => setMetaTitle(e.target.value)}
                    placeholder="SEO title"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="metaDescription" className="text-xs">Meta Description</Label>
                  <Textarea
                    id="metaDescription"
                    value={metaDescription}
                    onChange={(e) => setMetaDescription(e.target.value)}
                    placeholder="SEO description"
                    rows={3}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="featuredImage" className="text-xs">Featured Image URL</Label>
                  <Input
                    id="featuredImage"
                    value={featuredImage}
                    onChange={(e) => setFeaturedImage(e.target.value)}
                    placeholder="https://..."
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="authorName" className="text-xs">Author Name</Label>
                  <Input
                    id="authorName"
                    value={authorName}
                    onChange={(e) => setAuthorName(e.target.value)}
                    placeholder="Author name"
                  />
                </div>
              </CardContent>
            </Card>

            {existingPage && (
              <Card>
                <CardHeader>
                  <CardTitle className="text-sm font-medium">Info</CardTitle>
                </CardHeader>
                <CardContent className="space-y-2 text-sm">
                  <div className="flex items-center justify-between">
                    <span className="text-muted-foreground flex items-center gap-1">
                      <Eye className="h-3 w-3" /> Views
                    </span>
                    <span>{existingPage.viewCount}</span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-muted-foreground flex items-center gap-1">
                      <Clock className="h-3 w-3" /> Created
                    </span>
                    <span>
                      {new Date(existingPage.createdAt).toLocaleDateString()}
                    </span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-muted-foreground flex items-center gap-1">
                      <Clock className="h-3 w-3" /> Updated
                    </span>
                    <span>
                      {new Date(existingPage.updatedAt).toLocaleDateString()}
                    </span>
                  </div>
                </CardContent>
              </Card>
            )}
          </div>
        </div>
      </main>
    </>
  );
}

export default function AppContentEditorPage({
  params,
}: {
  params: Promise<{ slug: string; id: string }>;
}) {
  const { slug, id } = use(params);
  const router = useRouter();
  const searchParams = useSearchParams();
  const tenantId = searchParams.get("tenantId");
  const isNew = id === "new";

  const { data, isLoading, mutate } = useContentPages(tenantId);
  const allPages = useMemo(() => data?.data ?? [], [data]);

  const existingPage = isNew ? null : allPages.find((p) => p.id === id) ?? null;

  if (!tenantId) {
    return (
      <>
        <AdminHeader title="Content Editor" description="No tenant selected" />
        <main className="p-6">
          <p className="text-muted-foreground">
            A tenant ID is required. Go back to{" "}
            <button
              onClick={() => router.push(`/admin/apps/${slug}/content`)}
              className="text-primary underline"
            >
              Content Pages
            </button>
            .
          </p>
        </main>
      </>
    );
  }

  if (!isNew && isLoading) {
    return (
      <>
        <AdminHeader title="Loading..." description="" />
        <main className="p-6">
          <div className="animate-pulse space-y-4">
            <div className="h-8 bg-muted rounded w-1/3" />
            <div className="h-64 bg-muted rounded" />
          </div>
        </main>
      </>
    );
  }

  if (!isNew && !isLoading && !existingPage && allPages.length > 0) {
    return (
      <>
        <AdminHeader title="Page Not Found" description="" />
        <main className="p-6">
          <p className="text-muted-foreground">
            This content page does not exist.{" "}
            <button
              onClick={() => router.push(`/admin/apps/${slug}/content`)}
              className="text-primary underline"
            >
              Back to Content Pages
            </button>
          </p>
        </main>
      </>
    );
  }

  return (
    <ContentEditorForm
      key={existingPage?.id ?? "new"}
      existingPage={existingPage}
      allPages={allPages}
      tenantId={tenantId}
      isNew={isNew}
      pageId={id}
      slug={slug}
      onMutate={mutate}
    />
  );
}
