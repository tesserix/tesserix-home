import Link from 'next/link';
import {ConsolePageHeader} from '@/components/kit/page-header';
export default function ProvisioningPage(){
 return <div className="space-y-8"><ConsolePageHeader title="Identity onboarding" description="Register products and provision customer identity boundaries."/>
 <div className="grid gap-6 md:grid-cols-3">{[
 ['/platform/provisioning/products','Product onboarding','Review registered projects, clients and machine identities, or register a product.'],
 ['/platform/provisioning/orgs','Tenant onboarding','Create or adopt a customer organization and review its product grants.'],
 ['/platform/provisioning/orgs/hospital','Helivanta onboarding','Provision a hospital or group, adopt an existing tenant, or resume a retained request.'],
 ].map(([href,title,description])=><Link key={href} href={href} className="rounded-lg border border-border p-6"><h2 className="font-semibold">{title}</h2><p className="mt-2 text-sm text-muted-foreground">{description}</p></Link>)}</div>
 <p className="text-sm text-muted-foreground">A tenant is an independently administered customer or group. Its hospitals, branches, pharmacies and labs have explicit product permissions. Identity readiness does not complete clinical setup.</p>
 </div>;
}
