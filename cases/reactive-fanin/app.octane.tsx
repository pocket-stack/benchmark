// cases/reactive-fanin/app.octane.tsx — Octane variant of app.tsx.
// 100 independent useState slots fanning in to one Text. Octane keys hooks
// by CALL SITE and its compiler rejects useState inside a JS loop (one slot
// shared by every iteration), so the 100 states are UNROLLED into 100
// lexically distinct call sites — generated once; the loop shape lives in
// app.tsx. The component hands the 100 setters to module scope and mirrors
// the rendered sum there.
import { useLayoutEffect, useState } from "octane";
import { Text, View } from "@pocketjs/framework/octane/components";

const EXPECTED: Record<string, number> = { "set-one": 5950, "set-all": 104950, "set-back": 4950 };
let expected = 4950;
let renderedSum = 4950;
let setters: Array<(next: number) => void> | null = null;

export const bench = {
  version: 1,
  case: "reactive-fanin",
  actions: ["set-one", "set-all", "set-back"],
  run(action: string): void {
    expected = EXPECTED[action] ?? expected;
    if (!setters) return;
    if (action === "set-one") setters[0](1000);
    else if (action === "set-all") setters.forEach((set, i) => set(i + 1000));
    else if (action === "set-back") setters.forEach((set, i) => set(i));
  },
  post(action: string): boolean {
    return action === "mount" ? true : renderedSum === expected;
  },
  reset(): void {
    expected = 4950;
    if (setters) setters.forEach((set, i) => set(i));
  },
};

export default function App() {
  const [v0, s0] = useState(0);
  const [v1, s1] = useState(1);
  const [v2, s2] = useState(2);
  const [v3, s3] = useState(3);
  const [v4, s4] = useState(4);
  const [v5, s5] = useState(5);
  const [v6, s6] = useState(6);
  const [v7, s7] = useState(7);
  const [v8, s8] = useState(8);
  const [v9, s9] = useState(9);
  const [v10, s10] = useState(10);
  const [v11, s11] = useState(11);
  const [v12, s12] = useState(12);
  const [v13, s13] = useState(13);
  const [v14, s14] = useState(14);
  const [v15, s15] = useState(15);
  const [v16, s16] = useState(16);
  const [v17, s17] = useState(17);
  const [v18, s18] = useState(18);
  const [v19, s19] = useState(19);
  const [v20, s20] = useState(20);
  const [v21, s21] = useState(21);
  const [v22, s22] = useState(22);
  const [v23, s23] = useState(23);
  const [v24, s24] = useState(24);
  const [v25, s25] = useState(25);
  const [v26, s26] = useState(26);
  const [v27, s27] = useState(27);
  const [v28, s28] = useState(28);
  const [v29, s29] = useState(29);
  const [v30, s30] = useState(30);
  const [v31, s31] = useState(31);
  const [v32, s32] = useState(32);
  const [v33, s33] = useState(33);
  const [v34, s34] = useState(34);
  const [v35, s35] = useState(35);
  const [v36, s36] = useState(36);
  const [v37, s37] = useState(37);
  const [v38, s38] = useState(38);
  const [v39, s39] = useState(39);
  const [v40, s40] = useState(40);
  const [v41, s41] = useState(41);
  const [v42, s42] = useState(42);
  const [v43, s43] = useState(43);
  const [v44, s44] = useState(44);
  const [v45, s45] = useState(45);
  const [v46, s46] = useState(46);
  const [v47, s47] = useState(47);
  const [v48, s48] = useState(48);
  const [v49, s49] = useState(49);
  const [v50, s50] = useState(50);
  const [v51, s51] = useState(51);
  const [v52, s52] = useState(52);
  const [v53, s53] = useState(53);
  const [v54, s54] = useState(54);
  const [v55, s55] = useState(55);
  const [v56, s56] = useState(56);
  const [v57, s57] = useState(57);
  const [v58, s58] = useState(58);
  const [v59, s59] = useState(59);
  const [v60, s60] = useState(60);
  const [v61, s61] = useState(61);
  const [v62, s62] = useState(62);
  const [v63, s63] = useState(63);
  const [v64, s64] = useState(64);
  const [v65, s65] = useState(65);
  const [v66, s66] = useState(66);
  const [v67, s67] = useState(67);
  const [v68, s68] = useState(68);
  const [v69, s69] = useState(69);
  const [v70, s70] = useState(70);
  const [v71, s71] = useState(71);
  const [v72, s72] = useState(72);
  const [v73, s73] = useState(73);
  const [v74, s74] = useState(74);
  const [v75, s75] = useState(75);
  const [v76, s76] = useState(76);
  const [v77, s77] = useState(77);
  const [v78, s78] = useState(78);
  const [v79, s79] = useState(79);
  const [v80, s80] = useState(80);
  const [v81, s81] = useState(81);
  const [v82, s82] = useState(82);
  const [v83, s83] = useState(83);
  const [v84, s84] = useState(84);
  const [v85, s85] = useState(85);
  const [v86, s86] = useState(86);
  const [v87, s87] = useState(87);
  const [v88, s88] = useState(88);
  const [v89, s89] = useState(89);
  const [v90, s90] = useState(90);
  const [v91, s91] = useState(91);
  const [v92, s92] = useState(92);
  const [v93, s93] = useState(93);
  const [v94, s94] = useState(94);
  const [v95, s95] = useState(95);
  const [v96, s96] = useState(96);
  const [v97, s97] = useState(97);
  const [v98, s98] = useState(98);
  const [v99, s99] = useState(99);

  const values = [v0, v1, v2, v3, v4, v5, v6, v7, v8, v9, v10, v11, v12, v13, v14, v15, v16, v17, v18, v19, v20, v21, v22, v23, v24, v25, v26, v27, v28, v29, v30, v31, v32, v33, v34, v35, v36, v37, v38, v39, v40, v41, v42, v43, v44, v45, v46, v47, v48, v49, v50, v51, v52, v53, v54, v55, v56, v57, v58, v59, v60, v61, v62, v63, v64, v65, v66, v67, v68, v69, v70, v71, v72, v73, v74, v75, v76, v77, v78, v79, v80, v81, v82, v83, v84, v85, v86, v87, v88, v89, v90, v91, v92, v93, v94, v95, v96, v97, v98, v99];
  const currentSetters = [s0, s1, s2, s3, s4, s5, s6, s7, s8, s9, s10, s11, s12, s13, s14, s15, s16, s17, s18, s19, s20, s21, s22, s23, s24, s25, s26, s27, s28, s29, s30, s31, s32, s33, s34, s35, s36, s37, s38, s39, s40, s41, s42, s43, s44, s45, s46, s47, s48, s49, s50, s51, s52, s53, s54, s55, s56, s57, s58, s59, s60, s61, s62, s63, s64, s65, s66, s67, s68, s69, s70, s71, s72, s73, s74, s75, s76, s77, s78, s79, s80, s81, s82, s83, s84, s85, s86, s87, s88, s89, s90, s91, s92, s93, s94, s95, s96, s97, s98, s99];
  let total = 0;
  for (const value of values) total += value;
  renderedSum = total;
  useLayoutEffect(() => {
    setters = currentSetters;
  }, []);
  return (
    <View class="w-full h-full flex-col items-center justify-center gap-2 bg-slate-100">
      <Text class="text-xs text-slate-500 tracking-wide">FANIN SUM 0123456789:</Text>
      <Text class="text-4xl text-slate-950 font-bold">{String(total)}</Text>
    </View>
  );
}
