import Link from 'next/link';
import type { ReactNode } from 'react';
export default function ProvisioningLayout({children}:{children:ReactNode}){
 return <div className="space-y-6"><nav aria-label="Identity onboarding" className="flex flex-wrap gap-5 text-sm">
 <Link href="/platform/provisioning/products">Products</Link>
 <Link href="/platform/provisioning/orgs">Tenants</Link>
 <Link href="/platform/provisioning/orgs/hospital">Helivanta onboarding</Link>
 <Link href="/platform/provisioning/audit">Identity audit</Link>
 </nav>{children}</div>;
}
