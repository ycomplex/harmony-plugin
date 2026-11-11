import { FigmaSetupError } from "./figma-errors.js";
import { describe, expect, it, vi } from "vitest";
import { withClaudeFigmaSignIn, resolveSignInNamespace, type MintPorts } from "./figma-claude-sign-in.js";
import { evaluateConductorConfig, loadConductorConfigSync } from "../config/conductor-config.js";
function fake() {
  const calls: string[][]=[];
  const p: MintPorts = { run: vi.fn(async args => {calls.push(args);}), capture: vi.fn(async () => ({ code: 0, out: "yes\n" })), namespace: vi.fn(() => "harmony-legs"), temp:vi.fn(()=>"/tmp/private-figma-test"), chmod:vi.fn(), remove:vi.fn(), report:vi.fn() };
  return { p,calls };
}
it("copies privately and confirms pod deletion before import; never mounts an existing profile",async()=>{
  const {p,calls}=fake();
  await withClaudeFigmaSignIn(async path=>{expect(path).toBe("/tmp/private-figma-test/credentials.json");expect(calls.at(-1)).toContain("delete");expect(p.chmod).toHaveBeenCalledWith(path);},p);
  expect(calls.flat().join(" ")).toContain("@anthropic-ai/claude-code@2.1.312");
  expect(calls.flat()).toContain("cp");expect(calls.flat()).not.toContain("logout");
  expect(p.remove).toHaveBeenCalled();expect(p.report).toHaveBeenCalledWith("Temporary sign-in files removed.");
});
it.each([0,1,2,3,4,5,6])("cleans up when pod command %i fails and never imports",async at=>{
  const {p}=fake();let n=0;p.run=vi.fn(async()=>{if(n++===at)throw new Error("command failed");});
  const consume=vi.fn();await expect(withClaudeFigmaSignIn(consume,p)).rejects.toThrow();
  expect(consume).not.toHaveBeenCalled();expect(p.remove).toHaveBeenCalled();
  expect(p.run).toHaveBeenLastCalledWith(expect.arrayContaining(["delete","pod"]));
});
it("removes temporary files after import failure",async()=>{
  const {p}=fake();await expect(withClaudeFigmaSignIn(async()=>{throw new Error("uncertain save");},p)).rejects.toThrow("uncertain save");expect(p.remove).toHaveBeenCalled();
});
it("interruption aborts pod work and still deletes it",async()=>{
  const {p}=fake();p.run=vi.fn(async(args,_interactive,signal)=>{if(args.includes("wait")){process.emit("SIGINT");signal?.throwIfAborted();}});
  const consume=vi.fn();await expect(withClaudeFigmaSignIn(consume,p)).rejects.toThrow();expect(consume).not.toHaveBeenCalled();expect(p.remove).toHaveBeenCalled();
});
it("retains cleanup warning on removal failure and never reports successful cleanup",async()=>{
  const {p}=fake();p.remove=()=>{throw new Error("denied");};await expect(withClaudeFigmaSignIn(async()=>{},p)).rejects.toThrow("cleanup");expect(p.report).not.toHaveBeenCalledWith("Temporary sign-in files removed.");
});
it("passes interruption to import so prompts can cancel and clean up",async()=>{
  const {p}=fake();await expect(withClaudeFigmaSignIn(async(_path,signal)=>{process.emit("SIGTERM");signal.throwIfAborted();},p)).rejects.toThrow();expect(p.remove).toHaveBeenCalled();
});

it("preflights the permission through the captured answer, in the resolved namespace, without --quiet",async()=>{
 const {p}=fake();
 await withClaudeFigmaSignIn(async()=>{},p);
 expect(p.capture).toHaveBeenCalledOnce();
 expect(p.capture).toHaveBeenCalledWith(["--request-timeout=15s","-n","harmony-legs","auth","can-i","create","pods"]);
});
it.each([[{code:null,out:""}],[{code:1,out:"Unable to connect to the server"}],[{code:0,out:""}],[{code:1,out:"error: You must be logged in"}]])("says the cluster is unreachable for %j, before any directory or pod creation",async result=>{
 const {p}=fake();p.capture=vi.fn(async()=>result);
 await expect(withClaudeFigmaSignIn(async()=>{},p)).rejects.toThrow("kubectl could not reach the harmony cluster. Run `gcloud auth login`, then retry. No pod was created.");
 expect(p.run).not.toHaveBeenCalled();expect(p.temp).not.toHaveBeenCalled();expect(p.remove).not.toHaveBeenCalled();
});
it("never surfaces kubectl output from a failed preflight",async()=>{
 const {p}=fake();p.capture=vi.fn(async()=>({code:1,out:"Bearer SECRET"}));
 let message="";try{await withClaudeFigmaSignIn(async()=>{},p);}catch(e){message=(e as Error).message;}
 expect(message).not.toContain("SECRET");
});
it.each(["no","no - RBAC: access denied\n"])("names the missing permission and the namespace when can-i answers %j, with no gcloud hint",async out=>{
 const {p}=fake();p.namespace=vi.fn(()=>"team-legs");p.capture=vi.fn(async()=>({code:1,out}));
 let message="";try{await withClaudeFigmaSignIn(async()=>{},p);}catch(e){message=(e as Error).message;}
 expect(message).toBe("Your account may not create pods in team-legs (kubectl auth can-i create pods was denied). Ask a cluster admin for permission to create pods there, then retry. No pod was created.");
 expect(message).not.toContain("gcloud");expect(message).not.toContain("RBAC");
 expect(p.run).not.toHaveBeenCalled();expect(p.temp).not.toHaveBeenCalled();expect(p.remove).not.toHaveBeenCalled();
});
it("uses a non-default namespace for the permission check, pod commands and the cleanup hint",async()=>{
 const {p,calls}=fake();p.namespace=vi.fn(()=>"team-legs");
 p.run=vi.fn(async args=>{calls.push(args);if(args.includes("wait"))throw new FigmaSetupError("Figma sign-in pod command failed.");if(args.includes("delete"))throw new Error("denied");});
 let message="";try{await withClaudeFigmaSignIn(async()=>{},p);}catch(e){message=(e as Error).message;}
 expect(p.capture).toHaveBeenCalledWith(expect.arrayContaining(["-n","team-legs","auth","can-i"]));
 expect(calls.length).toBeGreaterThan(0);
 for(const args of calls){expect(args).toEqual(expect.arrayContaining(["-n","team-legs"]));expect(args).not.toContain("harmony-legs");}
 expect(message).toMatch(/Remove pod harmony-figma-.* in team-legs before reconnecting\./);expect(message).not.toContain("harmony-legs");
});
describe("resolveSignInNamespace",()=>{
 const env = { HARMONY_HOME: "/fixture/home" };
 const hostPath = "/fixture/home/conductor-host.json";
 const projectPath = "/fixture/workspace/.harmony/conductor.json";
 const host = JSON.stringify({gcp:{project:"fixture-project"},gcloud:{account:"operator@example.test"},secrets:{api_token:"fixture-secret-name"}});
 const fixture = (files: Record<string,string>) => ({
  cwd: "/fixture/workspace", exists: (path:string)=>Object.hasOwn(files,path),
  read: vi.fn((path:string)=>{if(!Object.hasOwn(files,path))throw new Error("missing");return files[path];}),
 });
 it("accepts a driver-only host and defaults to harmony-legs without requiring a project",()=>{
  const io=fixture({[hostPath]:host});
  expect(resolveSignInNamespace(env,io)).toBe("harmony-legs");
  expect(io.read).toHaveBeenCalledExactlyOnceWith(hostPath);
 });
 it("does not relax the conductor loader itself",()=>{
  const io=fixture({[hostPath]:host});
  expect(()=>loadConductorConfigSync({env,existsSync:io.exists,readFileSync:io.read,warn:()=>{}})).toThrow("no project file");
 });
 it("honours the workspace namespace while ignoring unrelated launch keys",()=>{
  const io=fixture({[hostPath]:host,[projectPath]:JSON.stringify({gke:{namespace:"team-legs"},profile:"not-a-launch-profile"})});
  expect(resolveSignInNamespace(env,io)).toBe("team-legs");
  expect(evaluateConductorConfig({env:{...env,HARMONY_CONDUCTOR_PROJECT_FILE:projectPath},existsSync:io.exists,readFileSync:io.read})?.issues.length).toBeGreaterThan(0);
 });
 it("prefers explicit project over snapshot and cwd, and snapshot over cwd",()=>{
  const snapshot=JSON.stringify({version:1,source:{repo:"fixture/repo",ref:"main",path:".harmony/conductor.json"},etag:null,sha:null,fetched_at:"2026-11-11T00:00:00Z",content:JSON.stringify({gke:{namespace:"snapshot-legs"}})});
  const io=fixture({"/explicit":JSON.stringify({gke:{namespace:"explicit-legs"}}),"/fixture/home/conductor-snapshot.json":snapshot,[projectPath]:JSON.stringify({gke:{namespace:"cwd-legs"}})});
  expect(resolveSignInNamespace({...env,HARMONY_CONDUCTOR_PROJECT_FILE:"/explicit"},io)).toBe("explicit-legs");
  expect(resolveSignInNamespace(env,io)).toBe("snapshot-legs");
 });
 it("preserves host and modern env overrides, then legacy env and default fallbacks",()=>{
  const io=fixture({[hostPath]:JSON.stringify({gke:{namespace:"host-legs"}}),[projectPath]:JSON.stringify({gke:{namespace:"project-legs"}})});
  expect(resolveSignInNamespace(env,io)).toBe("host-legs");
  expect(resolveSignInNamespace({...env,HARMONY_CONDUCTOR_GKE_NAMESPACE:"override-legs"},io)).toBe("override-legs");
  expect(resolveSignInNamespace({...env,HARMONY_GKE_NAMESPACE:"env-legs"},fixture({}))).toBe("env-legs");
  expect(resolveSignInNamespace(env,fixture({}))).toBe("harmony-legs");
 });
 it.each(["", "--context=other", "Team_Legs", "a".repeat(64), 42, false, null])("rejects malformed namespace %j before any pod command",async ns=>{
  const io=fixture({[projectPath]:JSON.stringify({gke:{namespace:ns}})});
  const {p}=fake();p.namespace=()=>resolveSignInNamespace(env,io);
  await expect(withClaudeFigmaSignIn(async()=>{},p)).rejects.toThrow("not a valid Kubernetes namespace name");
  expect(p.capture).not.toHaveBeenCalled();expect(p.run).not.toHaveBeenCalled();expect(p.temp).not.toHaveBeenCalled();
 });
 it("refuses unreadable explicit files and malformed JSON without exposing file contents",()=>{
  expect(()=>resolveSignInNamespace({...env,HARMONY_CONDUCTOR_PROJECT_FILE:"/missing"},fixture({}))).toThrow("Cannot read the conductor file");
  expect(()=>resolveSignInNamespace(env,fixture({[projectPath]:"invalid private contents"}))).toThrow("invalid conductor JSON");
 });
});

it("preserves primary failure before cleanup and lists only the pod that remains",async()=>{
 const {p}=fake();p.run=vi.fn(async args=>{if(args.includes("wait"))throw new FigmaSetupError("Figma sign-in pod command failed.");if(args.includes("delete"))throw new Error("Bearer SECRET");});
 let message="";try{await withClaudeFigmaSignIn(async()=>{},p);}catch(e){message=(e as Error).message;}
 expect(message.startsWith("Figma sign-in pod command failed.\nTemporary sign-in cleanup could not be completed.")).toBe(true);
 expect(message).toMatch(/Remove pod harmony-figma-.* in harmony-legs before reconnecting\./);
 expect(message).not.toContain("private directory");expect(message).not.toContain("Do not use this sign-in");expect(message).not.toContain("SECRET");
});
it("lists only a directory left after successful pod cleanup, and warns only after completed sign-in",async()=>{
 const {p}=fake();p.remove=()=>{throw new Error("SECRET");};
 await expect(withClaudeFigmaSignIn(async()=>{},p)).rejects.toThrow("Temporary sign-in cleanup could not be completed.\nRemove private directory /tmp/private-figma-test before reconnecting.\nDo not use this sign-in in Claude Code again.");
});
it("does not leak an arbitrary consume failure when cleanup also fails",async()=>{
 const {p}=fake();p.remove=()=>{throw new Error("SECRET");};
 await expect(withClaudeFigmaSignIn(async()=>{throw new Error("Bearer SECRET");},p)).rejects.toThrow("Figma sign-in failed.\nTemporary sign-in cleanup");
});
