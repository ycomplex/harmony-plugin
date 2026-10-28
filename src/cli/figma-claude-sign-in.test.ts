import { FigmaSetupError } from "./figma-errors.js";
import { expect, it, vi } from "vitest";
import { withClaudeFigmaSignIn, type MintPorts } from "./figma-claude-sign-in.js";
function fake() {
  const calls: string[][]=[];
  const p: MintPorts = { run: vi.fn(async args => {calls.push(args);}), temp:vi.fn(()=>"/tmp/private-figma-test"), chmod:vi.fn(), remove:vi.fn(), report:vi.fn() };
  return { p,calls };
}
it("copies privately and confirms pod deletion before import; never mounts an existing profile",async()=>{
  const {p,calls}=fake();
  await withClaudeFigmaSignIn(async path=>{expect(path).toBe("/tmp/private-figma-test/credentials.json");expect(calls.at(-1)).toContain("delete");expect(p.chmod).toHaveBeenCalledWith(path);},p);
  expect(calls.flat().join(" ")).toContain("@anthropic-ai/claude-code@2.1.312");
  expect(calls.flat()).toContain("cp");expect(calls.flat()).not.toContain("logout");
  expect(p.remove).toHaveBeenCalled();expect(p.report).toHaveBeenCalledWith("Temporary sign-in files removed.");
});
it.each([1,2,3,4,5,6,7])("cleans up when pod command %i fails and never imports",async at=>{
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

it("preflights reachability before any directory or pod creation with actionable wording",async()=>{
 const {p}=fake();p.run=vi.fn(async()=>{throw new Error("Bearer SECRET");});
 await expect(withClaudeFigmaSignIn(async()=>{},p)).rejects.toThrow("kubectl could not reach the harmony cluster. Run `gcloud auth login`, then retry. No pod was created.");
 expect(p.run).toHaveBeenCalledOnce();expect(p.run).toHaveBeenCalledWith(expect.arrayContaining(["-n","harmony-legs","auth","can-i","create","pods","--quiet"]));
 expect(p.temp).not.toHaveBeenCalled();expect(p.remove).not.toHaveBeenCalled();
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
