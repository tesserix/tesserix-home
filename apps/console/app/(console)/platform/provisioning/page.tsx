import Link from 'next/link';
import {ConsolePageHeader} from '@/components/kit/page-header';
export default function ProvisioningPage(){
 return <div className="space-y-8"><ConsolePageHeader title="Identity onboarding" description="Register products and provision customer identity boundaries."/>
 <div className="grid gap-6 md:grid-cols-2 xl:grid-cols-4">{[
 ['/platform/provisioning/products','Product onboarding','Review registered projects, clients and machine identities, or register a product.'],
 ['/platform/provisioning/orgs','Tenant onboarding','Create or adopt a customer organization and review its product grants.'],
 ['/platform/provisioning/staff-recovery','Staff identity recovery','Inspect retained identity commands and independently review uncertain account creation.'],
 ['/platform/provisioning/orgs/hospital','Helivanta onboarding','Provision a hospital or group, adopt an existing tenant, or resume a retained request.'],
 ].map(([href,title,description])=><Link key={href} href={href} className="rounded-lg border border-border p-6"><h2 className="font-semibold">{title}</h2><p className="mt-2 text-sm text-muted-foreground">{description}</p></Link>)}</div>
 <form method="get" action="/platform/provisioning/orgs/hospital" className="space-y-3 rounded-lg border border-border p-6">
 <h2 className="font-semibold">Resume an existing request</h2>
 <label htmlFor="resume-tenant" className="block text-sm">Tenant UUID</label>
 <input id="resume-tenant" name="tenantId" required maxLength={36} pattern="[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}" className="h-11 w-full rounded-lg border border-input bg-background px-3 md:max-w-md"/>
 <button type="submit" className="block rounded-lg border border-border px-4 py-2 text-sm font-medium">Resume hospital onboarding</button>
 </form>
 <p className="text-sm text-muted-foreground">A tenant is an independently administered customer or group. Its hospitals, branches, pharmacies and labs have explicit product permissions. Identity readiness does not complete clinical setup.</p>
 </div>;
}
