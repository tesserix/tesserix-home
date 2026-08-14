import { Fragment, type ReactNode } from "react";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
  PageHeader as WebPageHeader,
  PageHeaderActions,
  PageHeaderContent,
  PageHeaderDescription,
  PageHeaderHeading,
  PageHeaderTitle,
  PageHeaderTop,
} from "@tesserix/web";

export interface Breadcrumbable {
  label: string;
  href?: string;
}

export interface ConsolePageHeaderProps {
  title: string;
  description?: string;
  breadcrumbs?: Breadcrumbable[];
  actions?: ReactNode;
}

/**
 * Props-shaped wrapper over `@tesserix/web`'s compound PageHeader, so eight
 * surfaces declare a header rather than reassembling the same seven parts.
 */
export function ConsolePageHeader({
  title,
  description,
  breadcrumbs,
  actions,
}: ConsolePageHeaderProps) {
  return (
    <WebPageHeader>
      {breadcrumbs?.length ? (
        <PageHeaderTop>
          <Breadcrumb>
            <BreadcrumbList>
              {breadcrumbs.map((crumb, index) => {
                const isLast = index === breadcrumbs.length - 1;
                return (
                  <Fragment key={`${crumb.label}-${index}`}>
                    <BreadcrumbItem>
                      {crumb.href && !isLast ? (
                        <BreadcrumbLink href={crumb.href}>{crumb.label}</BreadcrumbLink>
                      ) : (
                        <BreadcrumbPage>{crumb.label}</BreadcrumbPage>
                      )}
                    </BreadcrumbItem>
                    {isLast ? null : <BreadcrumbSeparator />}
                  </Fragment>
                );
              })}
            </BreadcrumbList>
          </Breadcrumb>
        </PageHeaderTop>
      ) : null}
      <PageHeaderContent>
        <PageHeaderHeading>
          <PageHeaderTitle>{title}</PageHeaderTitle>
          {description ? <PageHeaderDescription>{description}</PageHeaderDescription> : null}
        </PageHeaderHeading>
        {actions ? <PageHeaderActions>{actions}</PageHeaderActions> : null}
      </PageHeaderContent>
    </WebPageHeader>
  );
}
