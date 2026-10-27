import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Command } from "commander";
import { getAuthenticatedContext } from "../auth.js";
import { registerFigmaCommands } from "./figma.js";
import { auth } from "@modelcontextprotocol/sdk/client/auth.js";
vi.mock("../auth.js",()=>({getAuthenticatedContext:vi.fn()}));
vi.mock("@modelcontextprotocol/sdk/client/auth.js",()=>({auth:vi.fn()}));
const mcp=vi.hoisted(()=>({connect:vi.fn(),callTool:vi.fn(),close:vi.fn()}));
vi.mock("@modelcontextprotocol/sdk/client/index.js",()=>({Client:class {connect=mcp.connect;callTool=mcp.callTool;close=mcp.close;}}));
const grant={access_token:"SYNTHETIC-ACCESS",refresh_token:"SYNTHETIC-REFRESH",client_secret:"SYNTHETIC-SECRET"};
let out: string;let role: string;let enabled: boolean;
const invoke=vi.fn();
beforeEach(()=>{
  vi.clearAllMocks();out="";role="owner";enabled=true;
  vi.spyOn(process.stderr,"write").mockImplementation(((v:string)=>{out+=v;return true;}) as never);
  vi.spyOn(process.stdout,"write").mockImplementation(((v:string)=>{out+=v;return true;}) as never);
  mcp.connect.mockResolvedValue(undefined);mcp.close.mockResolvedValue(undefined);
  mcp.callTool.mockResolvedValue({structuredContent:{handle:"design-seat",plans:[{name:"team",seat:"Full",tier:"Pro"}]}});
  invoke.mockResolvedValue({data:{metadata:{handle:"design-seat",seat:"Full",tier:"Pro"},lowBudget:false}});
  vi.mocked(getAuthenticatedContext).mockResolvedValue({projectId:"project",userId:"user",client:{
    from:(table:string)=>({select:()=>({eq(){return this;},single:async()=>({data:table==="projects"?{workspace_id:"workspace"}:{role}})})}),
    rpc:async()=>({data:{connections_enabled:enabled,generation:7}}),functions:{invoke},
  }} as never);
});
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllGlobals();process.exitCode=0;});
function ports(){return {prompt:vi.fn(async()=>"yes"),readGrant:vi.fn(()=>grant),mint:vi.fn(async(cb: (p:string,s:AbortSignal)=>Promise<unknown>)=>cb("/tmp/private",new AbortController().signal))};}
async function run(args:string[],p=ports()){const c=new Command();registerFigmaCommands(c,p as never);await c.parseAsync(["figma","connect",...args],{from:"user"});return p;}
it.each(["owner-off","member"])("%s refuses before private file access or pod mint",async mode=>{
  if(mode==="member")role="member";else enabled=false;
  const p=await run(["--claude-sign-in"]);expect(p.mint).not.toHaveBeenCalled();expect(p.readGrant).not.toHaveBeenCalled();expect(invoke).not.toHaveBeenCalled();
});
it("imports through existing validate-only and generation save, with no OAuth/refresh",async()=>{
  const p=await run(["--claude-credentials","/tmp/private"]);
  expect(p.readGrant).toHaveBeenCalledWith("/tmp/private");expect(auth).not.toHaveBeenCalled();
  expect(invoke).toHaveBeenCalledTimes(2);expect(invoke.mock.calls[0][1].body).toMatchObject({grant,generation:7,validate_only:true,confirm_library_plan:true});
  expect(invoke.mock.calls[1][1].body).not.toHaveProperty("validate_only");
  expect(out).toContain("Figma edits will be made as @design-seat.");expect(out).toContain("After handoff, remove the imported file");expect(out).not.toContain("SYNTHETIC");
});
it("uses the pod route and founder's accepted intro",async()=>{
  const p=await run(["--claude-sign-in"]);expect(p.mint).toHaveBeenCalledOnce();expect(out).toContain("It runs in a throwaway pod that is deleted afterwards.");
});
it("cancellation never reads credentials",async()=>{
  const p=ports();p.prompt.mockResolvedValue("no");await run(["--claude-credentials","/tmp/private"],p);expect(p.readGrant).not.toHaveBeenCalled();expect(invoke).not.toHaveBeenCalled();
});
it("validation failure preserves connection and redacts remote errors",async()=>{
  invoke.mockResolvedValue({data:{error:"SYNTHETIC-SECRET"}});await run(["--claude-credentials","/tmp/private"]);
  expect(invoke).toHaveBeenCalledOnce();expect(out).toContain("Your existing connection is unchanged");expect(out).not.toContain("SYNTHETIC");
});
it("uncertain save is not retried or claimed unchanged",async()=>{
  invoke.mockResolvedValueOnce({data:{metadata:{handle:"design-seat"}}}).mockRejectedValueOnce(new Error("SYNTHETIC-SECRET"));
  await run(["--claude-credentials","/tmp/private"]);expect(invoke).toHaveBeenCalledTimes(2);expect(out).toContain("Do not retry this import yet");expect(out).not.toContain("unchanged");expect(out).not.toContain("SYNTHETIC");
});
it("aborting at save confirmation cannot publish",async()=>{
  const p=ports();const controller=new AbortController();p.mint=vi.fn(async cb=>cb("private",controller.signal));
  p.prompt.mockImplementation(async prompt=>{if(prompt.startsWith("Save"))controller.abort();return "yes";});
  await run(["--claude-sign-in"],p);expect(invoke).toHaveBeenCalledOnce();
});
it("low-budget validation still receives explicit save confirmation",async()=>{
  invoke.mockResolvedValue({data:{metadata:{handle:"design-seat"},lowBudget:true}});const p=await run(["--claude-credentials","private"]);
  expect(out).toContain("about 20 MCP calls/month");expect(p.prompt).toHaveBeenCalledWith("Save this workspace connection? Type yes: ",undefined);
  expect(invoke.mock.calls[1][1].body.confirm_low_budget).toBe(true);
});
it.each([403,500])("only an identified registration 403 receives approved-client guidance (%i)",async status=>{
  vi.stubGlobal("fetch",vi.fn(async()=>new Response("SYNTHETIC-SECRET",{status})));
  vi.mocked(auth).mockImplementation(async(_provider,options)=>{
    await options!.fetchFn!("https://api.figma.com/register",{method:"POST",body:JSON.stringify({client_name:"Harmony workspace Figma"})});
    throw new Error("other");
  });
  await run([]);
  expect(out.includes("Figma has not approved this client")).toBe(status===403);expect(out).not.toContain("SYNTHETIC");
  if(status===403)expect(out.indexOf("--claude-sign-in")).toBeLessThan(out.indexOf("--claude-credentials"));
});

it("the recovery health command reads the existing credential-free context",async()=>{
  const c=new Command();registerFigmaCommands(c);await c.parseAsync(["figma","health"],{from:"user"});
  expect(out).toContain('"generation":7');expect(invoke).not.toHaveBeenCalled();expect(out).not.toContain("SYNTHETIC");
});

it("does not announce a completed setup when post-save cleanup fails",async()=>{
  const p=ports();p.mint=vi.fn(async cb=>{await cb("private",new AbortController().signal);throw new Error("Temporary sign-in cleanup could not be completed.");});
  await run(["--claude-sign-in"],p);expect(invoke).toHaveBeenCalledTimes(2);expect(out).toContain("cleanup could not be completed");expect(out).not.toContain("Figma connection saved.");expect(out).not.toContain("refresh job now owns");
});
