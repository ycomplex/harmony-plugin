import { expect, it, vi } from "vitest";
import { withClaudeFigmaSignIn, type MintPorts } from "./figma-claude-sign-in.js";
function fake() {
  const calls: string[][]=[];
  const p: MintPorts = { run: vi.fn(async args => {calls.push(args);}), temp:()=>"/tmp/private-figma-test", chmod:vi.fn(), remove:vi.fn(), report:vi.fn() };
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
