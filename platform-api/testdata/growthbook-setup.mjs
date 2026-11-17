import {randomBytes} from "node:crypto";
import {mkdir, writeFile} from "node:fs/promises";
import {join} from "node:path";

const origin = "http://127.0.0.1:3100";
let headers = {};
let stage = "healthcheck";
async function request(method, path, body) {
  stage = method + " " + path;
  const response = await fetch(origin + path, {method, headers: {...headers, "Content-Type": "application/json"}, body: body === undefined ? undefined : JSON.stringify(body), redirect:"error", signal:AbortSignal.timeout(10_000)});
  if (!response.ok) throw new Error(`GrowthBook fixture request refused (${response.status})`);
  return response.json();
}

try {
  let ready = false;
  for (let attempt=0;attempt<90;attempt++) {
    try { const response=await fetch(origin+"/healthcheck", {signal:AbortSignal.timeout(1_000)}); if(response.ok){ready=true;break;} } catch {}
    await new Promise(resolve=>setTimeout(resolve,1_000));
  }
  if(!ready) throw new Error("GrowthBook fixture did not become ready");
  const {token}=await request("POST","/auth/firsttime",{email:"fixture@example.invalid",password:randomBytes(32).toString("hex"),name:"CI fixture",companyname:"Helivanta"});
  if(!token) throw new Error("Fixture authentication missing");
  headers={Authorization:"Bearer "+token};
  let {organizations}=await request("GET","/user");
  if(!organizations.length){await request("POST","/organization",{company:"Helivanta"});({organizations}=await request("GET","/user"));}
  if(organizations.length!==1)throw new Error("Unexpected fixture organization count");
  headers["x-organization"]=organizations[0].id;
  const definitions=await request("GET","/organization/definitions");
  const project=definitions.projects[0];
  if(!project?.id)throw new Error("Fixture project missing");
  await request("POST","/feature",{id:"helivanta.release.team_accounts",project:project.id,valueType:"boolean",defaultValue:"false",environmentSettings:{production:{enabled:true}},rules:[]});
  const {connection}=await request("POST","/sdk-connections",{name:"CI SDK reader",environment:"production",projects:[project.id],languages:["go"],encryptPayload:false});
  const {key}=await request("POST","/keys",{description:"CI project scoped manager",type:"admin"});
  if(typeof key?.key!=="string" || !connection?.key)throw new Error("Fixture credential missing");
  const keys=await request("GET","/keys");
  const listed=keys.keys.find(row=>row.id===key.id);
  if(!listed?.id || listed.secret!==true || listed.role!=="admin" || listed.userId || listed.disabled || listed.projectRoles?.length || listed.additionalRoles?.length || listed.limitAccessByEnvironment || listed.environments?.length)throw new Error("Management credential metadata contract mismatch");
  const directory=process.env.GROWTHBOOK_TEST_DIRECTORY;
  if(!directory)throw new Error("Fixture output directory required");
  await mkdir(directory,{recursive:true,mode:0o700});
  await writeFile(join(directory,"management-key"),key.key,{mode:0o600});
  await writeFile(join(directory,"fixture.json"),JSON.stringify({project:project.id,sdk:connection.key}),{mode:0o600});
  console.log("GrowthBook fixture ready; credentials stored in private test files.");
} catch { console.error("GrowthBook fixture setup failed at " + stage + "; no credentials were printed.");process.exitCode=1; }
