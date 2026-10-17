import { proxyOnboarding } from '@/lib/provisioning/proxy';
export const dynamic = 'force-dynamic';
async function handle(request: Request, context: {params: Promise<{path: string[]}>}) {
 return proxyOnboarding(request,(await context.params).path);
}
export {handle as GET, handle as POST, handle as DELETE};
