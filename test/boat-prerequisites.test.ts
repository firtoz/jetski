import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import { BOAT_PREREQUISITES } from "../src/providers/boat-prerequisites.js";

const harness = String.raw`
import json,sys,shutil,subprocess
config=json.loads(sys.argv[1]); calls=[]
missing=set(config.get("missing",[])); cc=config.get("cc",True); headers=config.get("headers",True)
def which(tool):
    if tool in config.get("baseMissing",[]):return None
    if tool=="cc":return "/fixture/cc" if cc else None
    return "/fixture/"+tool
def run(argv,**kwargs):
    global cc,headers
    calls.append(argv)
    if argv[0]=="cc":
        assert "\n" in kwargs["input"] and chr(92)+"n" not in kwargs["input"], "real C line breaks required"
        return subprocess.CompletedProcess(argv,0 if headers else 1,"","")
    if argv[0]=="dpkg-query":
        assert argv[2]=="-f=$"+"{Package}\t$"+"{db:Status-Status}\n"
        out="".join(p+"\t"+config.get("status",{}).get(p,"installed")+"\n" for p in argv[3:] if p not in missing)
        return subprocess.CompletedProcess(argv,1 if missing else 0,out,"")
    assert argv[0]=="apt-get", "all host effects must be intercepted"
    if argv[1]=="install":
        missing.difference_update(argv[4:])
        if "gcc" in argv or "libc6-dev" in argv:cc=True;headers=True
    return subprocess.CompletedProcess(argv,0,"","")
shutil.which=which;subprocess.run=run
error=None
try:exec(sys.stdin.read(),{})
except Exception as e:error=str(e)
print(json.dumps({"calls":calls,"error":error}))
`;
const check = (config: object) => {
  assert.ok(
    !BOAT_PREREQUISITES.includes("'"),
    "fixed control argv forbids apostrophes",
  );
  return JSON.parse(
    execFileSync("python3", ["-c", harness, JSON.stringify(config)], {
      input: BOAT_PREREQUISITES,
      encoding: "utf8",
    }),
  ) as { calls: string[][]; error: string | null };
};
const installs = (result: ReturnType<typeof check>) =>
  result.calls
    .filter((c) => c[0] === "apt-get" && c[1] === "install")
    .map((c) => c.slice(4));

test("configured Boat hosts do not upgrade installed prerequisite packages", () => {
  const result = check({});
  assert.equal(result.error, null);
  assert.deepEqual(
    result.calls.filter((c) => c[0] === "apt-get"),
    [],
  );
});
test("one missing runtime package does not request installed compilers or libc", () => {
  const result = check({ missing: ["fuse-overlayfs"] });
  assert.equal(result.error, null);
  assert.deepEqual(installs(result), [["fuse-overlayfs"]]);
});
test("a working alternative compiler does not require the gcc package", () => {
  const result = check({ missing: ["gcc", "libc6-dev"] });
  assert.equal(result.error, null);
  assert.deepEqual(installs(result), []);
});
test("missing compiler prerequisites are installed and checked again", () => {
  const result = check({
    cc: false,
    headers: false,
    missing: ["gcc", "libc6-dev"],
  });
  assert.equal(result.error, null);
  assert.deepEqual(installs(result), [["gcc", "libc6-dev"]]);
});
test("ambiguous package metadata and unsupported bases fail without apt effects", () => {
  for (const config of [
    { status: { podman: "unknown-state" } },
    { baseMissing: ["systemctl"] },
  ]) {
    const result = check(config);
    assert.ok(result.error);
    assert.deepEqual(installs(result), []);
  }
});
test("a broken installed compiler is rejected rather than blindly upgrading packages", () => {
  const result = check({ headers: false });
  assert.equal(result.error, "prerequisite_tools_unavailable");
  assert.deepEqual(installs(result), []);
});
