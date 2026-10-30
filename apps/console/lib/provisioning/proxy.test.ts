import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('@tesserix/platform-auth',()=>({getCurrentSession:vi.fn(),CapabilityError:class extends Error{}}));
vi.mock('@/lib/auth/operator',()=>({checkOperatorCapabilityLive:vi.fn()}));
vi.mock('@/lib/auth/platform-token',()=>({resolvePlatformApiToken:vi.fn()}));
import { CapabilityError, getCurrentSession } from '@tesserix/platform-auth';
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

describe('staff recovery console boundary',()=>{
 beforeEach(()=>{vi.mocked(checkOperatorCapabilityLive).mockClear()});
 const tenant='019a3c26-1234-7123-8123-123456789abc';
 const command='019a3c26-1234-7123-8123-123456789abd';
 const review='019a3c26-1234-7123-8123-123456789abe';
 const root=`orgs/${tenant}/staff-identities/${command}/recovery`;
 it.each([[root,'GET'],[`${root}/requests/${review}`,'GET'],[`${root}/requests/${review}`,'PUT'],[`${root}/requests/${review}/decision`,'PUT'],[`${root}/observations`,'POST'],[`${root}/reconciliations`,'POST']])('forwards only exact recovery routes %s %s',async(path,method)=>{
  fetcher.mockResolvedValue(Response.json({schema_version:1}));
  const response=await proxyOnboarding(request(path,method,method==='PUT'?'{}':undefined),path.split('/'));
  expect(response.status).toBe(200);
  const [url,init]=fetcher.mock.calls[0];expect(url).toBe(`http://onboarding-api.onboarding.svc.cluster.local:8080/v1/${path}`);
  expect(new Headers(init.headers).get('authorization')).toBe('Bearer server-token');
  expect(init.cache).toBe('no-store');expect(response.headers.get('Cache-Control')).toBe('no-store');
  expect(vi.mocked(checkOperatorCapabilityLive).mock.calls.map(c=>c[1])).toEqual(method==='GET'||path.endsWith('/observations')?['platform']:['platform','rotate-credentials']);
 });
 it('dispatches PUT through the public Next route with resolved tenant command scope',async()=>{
  const route=await import('@/app/api/onboarding/[...path]/route');
  fetcher.mockResolvedValue(Response.json({schema_version:1}));
  const path=`${root}/requests/${review}/decision`;
  const response=await route.PUT(request(path,'PUT','{}'),{params:Promise.resolve({path:path.split('/')})});
  expect(response.status).toBe(200);expect(fetcher).toHaveBeenCalledOnce();
 });
 it.each(['source','dispatch','history','requests',`requests/${review}/approve`])('does not open unsupported product-only or guessed routes %s',async(suffix)=>{
  const path=`${root}/${suffix}`;expect((await proxyOnboarding(request(path,'POST'),path.split('/'))).status).toBe(404);expect(fetcher).not.toHaveBeenCalled();
 });
 it('rejects recovery query assertions and foreign-origin writes before source access',async()=>{
  expect((await proxyOnboarding(request(root+'?actor=forged'),root.split('/'))).status).toBe(400);
  expect((await proxyOnboarding(request(root+'/observations','POST',undefined,'https://evil.test'),(root+'/observations').split('/'))).status).toBe(403);
  expect(fetcher).not.toHaveBeenCalled();
 });
 it('rejects a dangling recovery query rather than stripping its meaning upstream',async()=>{
  fetcher.mockResolvedValue(Response.json({schema_version:1}));
  expect((await proxyOnboarding(request(root+'?'),root.split('/'))).status).toBe(400);
  expect(fetcher).not.toHaveBeenCalled();
 });
 it('rejects invalid UTF-8 rather than rewriting recovery evidence before forwarding',async()=>{
  fetcher.mockResolvedValue(Response.json({schema_version:1}));
  const path=`${root}/requests/${review}/decision`;
  const body=new Uint8Array([123,34,114,101,97,115,111,110,34,58,34,255,34,125]);
  const req=new Request(`https://console.tesserix.app/api/onboarding/${path}`,{method:'PUT',body,headers:{origin:'https://console.tesserix.app','idempotency-key':'stable-request'}});
  expect((await proxyOnboarding(req,path.split('/'))).status).toBe(400);
  expect(fetcher).not.toHaveBeenCalled();
 });
 it('reports an unavailable recovery authorization source without claiming revocation or forwarding',async()=>{
  vi.mocked(checkOperatorCapabilityLive).mockRejectedValue(new Error('private authorization driver details'));
  const response=await proxyOnboarding(request(root),root.split('/'));
  expect(response.status).toBe(503);expect(await response.text()).not.toContain('private authorization driver details');
  expect(fetcher).not.toHaveBeenCalled();
 });
 it('does not permit reads or writes after live capability withdrawal',async()=>{
  vi.mocked(checkOperatorCapabilityLive).mockRejectedValue(new CapabilityError('platform'));
  expect((await proxyOnboarding(request(root),root.split('/'))).status).toBe(403);
  expect((await proxyOnboarding(request(root+'/reconciliations','POST'),(root+'/reconciliations').split('/'))).status).toBe(403);
  expect(fetcher).not.toHaveBeenCalled();
 });
});
