import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('@tesserix/platform-auth',()=>({getCurrentSession:vi.fn(),CapabilityError:class extends Error{}}));
vi.mock('@/lib/auth/operator',()=>({checkOperatorCapabilityLive:vi.fn()}));
vi.mock('@/lib/auth/platform-token',()=>({resolvePlatformApiToken:vi.fn()}));
import { getCurrentSession } from '@tesserix/platform-auth';
import { checkOperatorCapabilityLive } from '@/lib/auth/operator';
import { resolvePlatformApiToken } from '@/lib/auth/platform-token';
import { proxyOnboarding } from './proxy';
const fetcher=vi.fn();
const request=(path:string,method='GET',body?:string,origin='https://console.tesserix.app')=>new Request('https://console.tesserix.app/api/onboarding/'+path,{method,body,headers:{origin,'idempotency-key':'stable-request','authorization':'Bearer attacker','cookie':'attacker-cookie'}});
beforeEach(()=>{
 vi.stubEnv('ONBOARDING_API_ORIGIN','http://onboarding-api.onboarding.svc.cluster.local:8080');
 vi.stubGlobal('fetch',fetcher);
 fetcher.mockReset();
 vi.mocked(getCurrentSession).mockResolvedValue({sub:'operator',sid:'session',roles:['platform','rotate-credentials']} as never);
 vi.mocked(checkOperatorCapabilityLive).mockResolvedValue(undefined);
 vi.mocked(resolvePlatformApiToken).mockResolvedValue({token:'server-token',reauthRequired:false});
});
describe('console onboarding boundary',()=>{
 it('forwards only the operator credential and stable key to an allowed API route',async()=>{
  fetcher.mockResolvedValue(new Response('{"spec":{"tenantId":"tenant"}}',{status:202}));
  const response=await proxyOnboarding(request('hospital-onboardings','POST','{"product":"helivanta"}'),['hospital-onboardings']);
  expect(response.status).toBe(202);
  const [url,init]=fetcher.mock.calls[0];
  expect(url).toBe('http://onboarding-api.onboarding.svc.cluster.local:8080/v1/hospital-onboardings');
  expect(new Headers(init.headers).get('authorization')).toBe('Bearer server-token');
  expect(new Headers(init.headers).get('cookie')).toBeNull();
  expect(new Headers(init.headers).get('idempotency-key')).toBe('stable-request');
  expect(init.body).toBe('{"product":"helivanta"}');
 });
 it('denies a missing session before network access',async()=>{vi.mocked(getCurrentSession).mockResolvedValue(null);expect((await proxyOnboarding(request('products'),['products'])).status).toBe(401);expect(fetcher).not.toHaveBeenCalled()});
 it('denies a revoked capability',async()=>{vi.mocked(checkOperatorCapabilityLive).mockRejectedValue(new Error('revoked'));expect((await proxyOnboarding(request('products'),['products'])).status).toBe(403);expect(fetcher).not.toHaveBeenCalled()});
 it('requires same origin for cookie-authenticated writes even with an attacker bearer',async()=>{expect((await proxyOnboarding(request('products','POST','{}','https://evil.test'),['products'])).status).toBe(403);expect(fetcher).not.toHaveBeenCalled()});
 it.each([['internal','v1','hospital-enrolments'],['..','products'],['orgs','a%2fb'],['registry','credentials']])('rejects non-console paths %j',async(...path)=>{expect((await proxyOnboarding(request('products'),path)).status).toBe(404);expect(fetcher).not.toHaveBeenCalled()});
 it('requires a key for writes',async()=>{const r=request('products','POST','{}');r.headers.delete('idempotency-key');expect((await proxyOnboarding(r,['products'])).status).toBe(400);expect(fetcher).not.toHaveBeenCalled()});
 it('preserves anti-enumeration and conflict responses',async()=>{for(const status of [404,409]){fetcher.mockResolvedValue(new Response('{"detail":"refused"}',{status}));expect((await proxyOnboarding(request('products'),['products'])).status).toBe(status)}});
 it('bounds the request and fails without a token',async()=>{expect((await proxyOnboarding(request('products','POST','x'.repeat(262145)),['products'])).status).toBe(413);vi.mocked(resolvePlatformApiToken).mockResolvedValue({token:null,reauthRequired:true});expect((await proxyOnboarding(request('products'),['products'])).status).toBe(401);expect(fetcher).not.toHaveBeenCalled()});
 it('does not expose upstream exceptions',async()=>{fetcher.mockRejectedValue(new Error('private connection secret'));const r=await proxyOnboarding(request('products'),['products']);expect(r.status).toBe(503);expect(await r.text()).not.toContain('secret')});
});
