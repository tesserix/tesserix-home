import 'server-only';
import { CapabilityError, getCurrentSession } from '@tesserix/platform-auth';
import { checkOperatorCapabilityLive } from '@/lib/auth/operator';
import { resolvePlatformApiToken } from '@/lib/auth/platform-token';

const segment = '[A-Za-z0-9_-]+';
const uuid = '[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}';
const uuidv7 = '[a-f0-9]{8}-[a-f0-9]{4}-7[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}';
const recoveryRoot = `orgs/${uuid}/staff-identities/${uuidv7}/recovery`;
const recoveryRoute = new RegExp(`^${recoveryRoot}(?:/.*)?$`);
const routes: ReadonlyArray<[RegExp, readonly string[]]> = [
 [new RegExp(`^${recoveryRoot}$`), ['GET']],
 [new RegExp(`^${recoveryRoot}/requests/${uuidv7}$`), ['GET', 'PUT']],
 [new RegExp(`^${recoveryRoot}/requests/${uuidv7}/decision$`), ['PUT']],
 [new RegExp(`^${recoveryRoot}/(observations|reconciliations)$`), ['POST']],
 [/^(me|audit)$/, ['GET']],
 [/^products$/, ['GET', 'POST']],
 [new RegExp(`^products/${segment}$`), ['GET']],
 [new RegExp(`^products/${segment}/manifests-acknowledged$`), ['POST']],
 [/^hospital-onboardings$/, ['POST']],
 [new RegExp(`^hospital-onboardings/${segment}$`), ['GET']],
 [/^orgs$/, ['GET', 'POST']],
 [/^orgs\/enrolments$/, ['POST']],
 [new RegExp(`^orgs/${segment}$`), ['GET']],
 [new RegExp(`^orgs/${segment}/(identity|audit)$`), ['GET']],
 [new RegExp(`^orgs/${segment}/(deactivate|reactivate)$`), ['POST']],
 [new RegExp(`^orgs/${segment}/(grants|domains|idps|members)$`), ['GET', 'POST']],
 [new RegExp(`^orgs/${segment}/(grants|idps|members)/${segment}$`), ['DELETE']],
 [new RegExp(`^orgs/${segment}/domains/[A-Za-z0-9.-]+$`), ['DELETE']],
 [new RegExp(`^orgs/${segment}/domains/[A-Za-z0-9.-]+/verify$`), ['POST']],
];
const failure=(status:number,detail:string)=>Response.json({detail},{status,headers:{'Cache-Control':'no-store'}});

// This boundary never accepts a browser bearer, upstream URL or identity header.
export async function proxyOnboarding(request: Request, segments: readonly string[]): Promise<Response> {
 const path=segments.join('/');
 if(segments.some(s=>s==='.'||s==='..'||/[/%\\]/.test(s)) || !routes.some(([pattern,methods])=>pattern.test(path)&&methods.includes(request.method))) return failure(404,'Not found');
 const recovery=recoveryRoute.test(path);
 if(recovery && request.url.includes('?')) return failure(400,'Recovery requests do not accept query parameters');
 const unsafe=request.method!=='GET';
 const readObservation=recovery && request.method==='POST' && path.endsWith('/observations');
 if(unsafe){
  const expected=process.env.NODE_ENV==='development'?new URL(request.url).origin:'https://console.tesserix.app';
  if(request.headers.get('origin')!==expected) return failure(403,'Same-origin request required');
 }
 const session=await getCurrentSession();
 if(!session) return failure(401,'Sign in to the console');
 try{
  await checkOperatorCapabilityLive(session,'platform');
  if(unsafe&&!readObservation) await checkOperatorCapabilityLive(session,'rotate-credentials');
  if(request.method==='DELETE'||path.endsWith('/deactivate')) await checkOperatorCapabilityLive(session,'hard-delete');
 }catch(cause){
  if(recovery&&!(cause instanceof CapabilityError))return failure(503,'Current authorization is unavailable');
  return failure(403,'Additional permission required');
 }
 const headers=new Headers({accept:'application/json'});
 let body:string|undefined;
 if(unsafe){
  const key=request.headers.get('idempotency-key');
  if(!key || !/^[A-Za-z0-9_-]{1,128}$/.test(key)) return failure(400,'A stable idempotency key is required');
  headers.set('idempotency-key',key);
  const reader=request.body?.getReader();
  const chunks:Uint8Array[]=[];let size=0;
  if(reader){for(;;){const next=await reader.read();if(next.done)break;size+=next.value.byteLength;if(size>262144){await reader.cancel();return failure(413,'Request too large')}chunks.push(next.value)}}
  const bytes=Buffer.concat(chunks);
  try{body=recovery?new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes):bytes.toString('utf8')}catch{return failure(400,'A UTF-8 JSON body is required')}
  if(body){try{JSON.parse(body)}catch{return failure(400,'A JSON body is required')}}
  headers.set('content-type','application/json');
 }
 const origin=process.env.ONBOARDING_API_ORIGIN?.replace(/\/+$/,'');
 if(!origin) return failure(503,'Onboarding is not configured');
 const {token,reauthRequired}=await resolvePlatformApiToken();
 if(!token) return failure(reauthRequired?401:503,reauthRequired?'Sign in again to continue':'Onboarding is unavailable');
 headers.set('authorization',`Bearer ${token}`);
 const query=new URL(request.url).searchParams;
 if(query.toString().length>4096) return failure(400,'Query too large');
 const target=new URL(`${origin}/v1/${path}`);
 for(const [key,value] of query){if(!['product','limit','after','cursor','state','orgId','productKey','actor','action'].includes(key))return failure(400,'Unknown query parameter');target.searchParams.append(key,value)}
 try{
  const upstream=await fetch(target.toString(),{method:request.method,headers,body,cache:'no-store',redirect:'error',signal:AbortSignal.timeout(12000)});
  const responseHeaders=new Headers({'Cache-Control':'no-store','Content-Type':'application/json'});
  const requestID=upstream.headers.get('x-request-id');if(requestID)responseHeaders.set('x-request-id',requestID);
  return new Response(upstream.status===204?null:await upstream.text(),{status:upstream.status,headers:responseHeaders});
 }catch{return failure(503,'The result could not be confirmed. Resume or retry with the same request key.')}
}
