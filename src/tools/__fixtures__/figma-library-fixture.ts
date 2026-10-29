// Deterministic live-shaped Figma library fixture (B-1321). IDENTICAL copy in harmony-plugin.
// 76 component sets / 290 set variants + 1768 standalone components (44 unique names,
// 287 names repeated across size frames) = 2058 components. No randomness, no dates.
type Entry = {
  key: string;
  name: string;
  containing_frame: {
    name: string;
    nodeId: string;
    pageId: string;
    pageName: string;
    backgroundColor: { r: number; g: number; b: number; a: number };
    containingStateGroup?: { name: string; nodeId: string };
  };
};

export function makeLiveShapedComponents(): Entry[] {
  const out: Entry[] = [];
  let n = 0;
  const key = () => `f${String(++n).padStart(39, "0")}`;
  const bg = { r: 1, g: 1, b: 1, a: 1 };
  const variant = (set: string, setIdx: number, name: string) => {
    out.push({
      key: key(),
      name,
      containing_frame: {
        name: set,
        nodeId: `1:${setIdx}`,
        pageId: "0:1",
        pageName: "Components",
        backgroundColor: bg,
        containingStateGroup: { name: set, nodeId: `1:${setIdx}` },
      },
    });
  };
  const cross = (axes: [string, string[]][]) =>
    axes.reduce<string[]>(
      (acc, [axis, vals]) =>
        acc.flatMap((p) => vals.map((v) => (p ? `${p}, ` : "") + `${axis}=${v}`)),
      [""],
    );

  let setIdx = 0;
  const buttonLike = ["Variant=Primary", "Variant=Secondary"].flatMap((v) =>
    cross([
      ["State", ["Default", "Hover"]],
      ["Size", ["Small", "Medium", "Large"]],
    ]).map((rest) => `${v}, ${rest}`),
  );
  for (const set of ["Button", "Icon Button"]) {
    setIdx++;
    for (const v of buttonLike) variant(set, setIdx, v);
  }
  setIdx++;
  for (const v of cross([
    ["Scheme", ["Brand", "Neutral", "Success"]],
    ["State", ["Default", "Hover"]],
    ["Size", ["Small", "Medium"]],
  ]))
    variant("Tag", setIdx, v);
  variant("Tag", setIdx, "Variant=Primary, State=Default, Size=Medium");
  // 73 further sets: 34 with 4 variants, 39 with 3 (253 variants).
  const states = ["State=Default", "State=Hover", "State=Pressed", "State=Disabled"];
  for (let i = 1; i <= 73; i++) {
    setIdx++;
    const set = `Component ${String(i).padStart(2, "0")}`;
    const count = i <= 34 ? 4 : 3;
    for (let s = 0; s < count; s++) variant(set, setIdx, states[s]);
  }

  const standalone = (name: string, frame: string, page: string, node: number) => {
    out.push({
      key: key(),
      name,
      containing_frame: {
        name: frame,
        nodeId: `2:${node}`,
        pageId: page === "Icons" ? "0:2" : "0:3",
        pageName: page,
        backgroundColor: bg,
      },
    });
  };
  for (let i = 1; i <= 44; i++)
    standalone(`Illustration ${String(i).padStart(2, "0")}`, "Artwork", "Illustrations", i);
  const sizes = ["16", "20", "24", "32", "40", "48"];
  for (let i = 1; i <= 287; i++) {
    const name = `Icon ${String(i).padStart(3, "0")}`;
    for (const size of sizes) standalone(name, size, "Icons", i * 10 + Number(size));
    // Two names also appear in a seventh frame: 287 * 6 + 2 = 1724 icon components.
    if (i <= 2) standalone(name, "56", "Icons", i * 10 + 56);
  }
  return out;
}
