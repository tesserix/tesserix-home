export class ApiError extends Error {
 constructor(message: string, readonly status: number) { super(message); this.name='ApiError'; }
}
type Options={method?:'GET'|'POST'|'PATCH'|'DELETE';body?:unknown;idempotencyKey?:string};
export async function apiFetch<T=unknown>(path:string,options:Options={}):Promise<T>{
 if(!path.startsWith('/v1/'))throw new ApiError('Invalid onboarding route',400);
 const method=options.method??'GET';
 const headers:Record<string,string>={Accept:'application/json'};
 if(method!=='GET'){
  headers['Content-Type']='application/json';
  headers['Idempotency-Key']=options.idempotencyKey??newIdempotencyKey();
 }
 const response=await fetch(`/api/onboarding/${path.slice(4)}`,{method,headers,credentials:'same-origin',body:options.body===undefined?undefined:JSON.stringify(options.body)});
 if(response.status===204)return null as T;
 const payload=await response.json().catch(()=>null);
 if(!response.ok)throw new ApiError(payload?.detail??`Request failed (${response.status})`,response.status);
 return payload as T;
}
export function newIdempotencyKey():string{return crypto.randomUUID()}
