import { useState, useRef } from "react";

/* ================= RULES ENGINE (plain data — lexicon-skill hydratable) ================= */

const KINDS = {
  person: { label: "Person", tag: "natural person" },
  llc: { label: "LLC", tag: "single-member / disregarded" },
  scorp: { label: "S Corp", tag: "subch. S election" },
  trust: { label: "Trust", tag: "irrevocable" },
};

const WIRE_TYPES = [
  { id: "ownership", label: "Ownership / membership" },
  { id: "loan", label: "Loan" },
  { id: "gift", label: "Gift" },
  { id: "contribution", label: "Capital contribution" },
  { id: "draw", label: "Draw / distribution" },
  { id: "wages", label: "W-2 wages" },
  { id: "personal", label: "Pays personal expense" },
  { id: "a4v", label: "Discharge via 'private side'" },
];

const ST = {
  valid: { label: "HOLDS", color: "#A68B54" },
  fragile: { label: "FRAGILE", color: "#B4762E" },
  invalid: { label: "VOID", color: "#5C554A" },
  adjudicated: { label: "ADJUDICATED AGAINST", color: "#8E3B31" },
};

// evaluate(fromKind, toKind, type, ctx) -> spec
// ctx: { toIsOwnedByFrom, fromIsOwnerOfTo }
function evaluate(from, to, type, ctx) {
  const F = from.kind, T = to.kind;
  const spec = (s) => ({
    state: "valid", papers: [], upside: "", exposure: "", note: "",
    prov: { dist: "Convention", settled: "Settled", cite: "" }, ...s,
  });

  switch (type) {
    case "ownership": {
      if (T === "person") return spec({ state: "invalid", note: "Nothing owns a person. Dead wire.", prov: { dist: "Black letter", settled: "Settled", cite: "—" } });
      if (T === "scorp") {
        if (F === "person") return spec({ as: "Eligible shareholder", upside: "Baseline eligible S corp owner.", papers: ["Stock ledger entry", "Form 2553 consent on file"], prov: { dist: "Black letter", settled: "Settled", cite: "IRC §1361(b)(1)" } });
        if (F === "llc") return spec({ state: "fragile", as: "Held through disregarded LLC", exposure: "Only works while the LLC stays single-member and disregarded. Add a second member and the S election terminates.", papers: ["LLC remains single-member", "No entity classification election filed"], prov: { dist: "Agency / regs", settled: "Settled", cite: "Treas. Reg. §301.7701-3" } });
        if (F === "trust") return spec({ state: "fragile", as: "Trust shareholder — carve-out only", exposure: "An ordinary trust kills the election. Must qualify and elect QSST or ESBT.", papers: ["QSST or ESBT election filed", "Trust terms meet §1361(c)/(d)"], prov: { dist: "Black letter", settled: "Settled", cite: "IRC §1361(c)(2), (d)" } });
        return spec({ state: "invalid", note: "This owner class can't hold S corp shares — election terminates on contact.", prov: { dist: "Black letter", settled: "Settled", cite: "IRC §1361(b)(1)(B)" } });
      }
      if (T === "llc") return spec({ as: F === "trust" ? "Trust-owned LLC" : "Member interest", upside: "Liability wall between owner and the LLC's operations — if the wall is respected.", papers: ["State formation filing", "Operating agreement names this owner", "Separate bank account for the LLC"], prov: { dist: "Black letter", settled: "Settled", cite: "State LLC act" } });
      if (T === "trust") return spec({ as: "Settlor / grantor", note: "You don't 'own' an irrevocable trust — you fund it and surrender control. Retained strings pull it back into your estate.", state: "fragile", exposure: "Retained control = grantor trust / estate inclusion.", papers: ["Trust instrument executed", "Independent trustee (or clean powers)", "Assets actually retitled"], prov: { dist: "Black letter", settled: "Settled", cite: "IRC §§671–677; §2036" } });
      return spec({});
    }
    case "loan":
      return spec({
        state: "fragile", as: "Bona fide debt (if papered)",
        upside: "Money moves without gift tax and without equity dilution; principal comes back tax-free.",
        exposure: "Undocumented, the IRS picks the label: gift, contribution, or income — whichever costs more.",
        papers: ["Signed promissory note", "Interest at AFR or better", "Repayment history actually kept"],
        prov: { dist: "Black letter", settled: "Settled", cite: "IRC §7872" },
      });
    case "gift": {
      if (F !== "person") return spec({ state: "fragile", as: "'Gift' from an entity", exposure: "Entities don't make gifts to insiders — this gets recharacterized as a distribution or compensation.", papers: [], prov: { dist: "Case law", settled: "Settled", cite: "Recharacterization doctrine" } });
      if (T === "trust") return spec({ as: "Gift to trust", upside: "Moves value out of the estate; withdrawal powers can qualify it for the annual exclusion.", papers: ["Crummey notices sent + kept", "Form 709 if over exclusion"], prov: { dist: "Case law", settled: "Settled", cite: "Crummey v. Comm'r, 397 F.2d 82" } });
      if (T === "person") return spec({ as: "Gift", upside: "Receiver owes nothing.", papers: ["Form 709 if over annual exclusion"], prov: { dist: "Black letter", settled: "Settled", cite: "IRC §2503(b)" } });
      return spec({ state: "fragile", as: "'Gift' to an entity", exposure: "Money into an entity you touch isn't a gift — it's a contribution or a loan. Pick one and paper it.", papers: ["Reclassify: note or OA capital entry"], prov: { dist: "Convention", settled: "Settled", cite: "—" } });
    }
    case "contribution": {
      if (T === "person") return spec({ state: "invalid", note: "You contribute capital to an entity, not to a person.", prov: { dist: "Convention", settled: "Settled", cite: "—" } });
      if (T === "trust") return spec({ as: "Trust funding", papers: ["Assignment / deed retitles the asset", "Schedule of trust property updated"], upside: "The trust only protects what it actually holds title to.", prov: { dist: "Black letter", settled: "Settled", cite: "State trust code" } });
      return spec({
        as: "Capital contribution", upside: "No tax on the way in; builds basis for the way out.",
        state: "fragile",
        exposure: "Unbooked contributions blur into loans and gifts — and blur is what auditors bill by.",
        papers: ["Operating agreement reflects it", "Capital account booked"],
        prov: { dist: "Black letter", settled: "Settled", cite: "IRC §721 / §351" },
      });
    }
    case "draw": {
      if (F === "person") return spec({ state: "invalid", note: "Draws flow out of entities, not out of people.", prov: { dist: "Convention", settled: "Settled", cite: "—" } });
      if (!ctx.fromIsOwnedByTarget) return spec({ state: "fragile", as: "Distribution to a non-owner", exposure: "No ownership wire exists from this person into the entity — so this money is compensation or a gift wearing a costume.", papers: ["Add ownership wire, or reclassify as wages/1099"], prov: { dist: "Case law", settled: "Settled", cite: "Substance over form" } });
      if (F === "llc") return spec({ as: "Owner's draw", upside: "Not taxed at withdrawal — the profit already was. No payroll machinery.", papers: ["Drawn from the LLC's own account"], prov: { dist: "Agency / regs", settled: "Settled", cite: "Rev. Rul. 69-184" } });
      if (F === "scorp") return spec({ state: "fragile", as: "Shareholder distribution", exposure: "Distributions before reasonable W-2 wages get reclassified as wages — with payroll tax and penalties backdated.", upside: "Above reasonable wages, distributions skip employment tax. That's the whole S corp play.", papers: ["Reasonable W-2 wages running first", "Distributions proportionate to ownership"], prov: { dist: "Case law", settled: "Settled", cite: "Radtke v. U.S., 712 F. Supp. 143" } });
      if (F === "trust") return spec({ state: "fragile", as: "Trust distribution", exposure: "Off-instrument distributions are fiduciary breaches, not withdrawals.", papers: ["Authorized by the trust instrument", "Trustee minutes / records"], prov: { dist: "Case law", settled: "Settled", cite: "UTC §802" } });
      return spec({});
    }
    case "wages": {
      if (F === "person") return spec({ state: "invalid", note: "People don't issue W-2s to entities.", prov: { dist: "Convention", settled: "Settled", cite: "—" } });
      if (F === "llc" && ctx.fromIsOwnedByTarget) return spec({ state: "invalid", note: "The owner of a disregarded LLC cannot be its W-2 employee. This socket is dead — take a draw instead.", prov: { dist: "Agency / regs", settled: "Settled", cite: "Rev. Rul. 69-184" } });
      if (F === "scorp" && ctx.fromIsOwnedByTarget) return spec({ as: "Reasonable owner wages", upside: "The mandatory wire. Run it first and the distribution wire above it becomes defensible.", papers: ["Payroll actually run", "W-2 filed", "Comp defensible as 'reasonable'"], prov: { dist: "Case law", settled: "Settled", cite: "IRC §3121(d); Radtke" } });
      return spec({ as: "Employee wages", papers: ["Payroll run", "W-2 / withholding filed"], prov: { dist: "Black letter", settled: "Settled", cite: "IRC §3402" } });
    }
    case "personal":
      if (F === "person") return spec({ as: "Just spending", note: "Your account, your bill.", prov: { dist: "Black letter", settled: "Settled", cite: "—" } });
      return spec({
        state: "fragile", as: "Commingling",
        exposure: "The classic veil-piercer. No checklist cures this wire — every dollar through it is evidence the box was never real. The fix is routing: draw first, then pay the bill personally.",
        papers: [],
        prov: { dist: "Case law", settled: "Settled", cite: "Alter-ego doctrine" },
      });
    case "a4v":
      return spec({
        state: "adjudicated", as: "Redemption / A4V theory",
        exposure: "Cites real UCC text — zero distance to the document. But every court to hear the application has rejected it; sanctions and convictions have followed. The document exists; it doesn't say this.",
        papers: [],
        prov: { dist: "Case law", settled: "Adjudicated against", cite: "e.g., McLaughlin v. CitiMortgage, 726 F. Supp. 2d 201" },
      });
    default:
      return spec({});
  }
}

/* ================= APP ================= */

let uid = 100;
const F = {
  d: "'Merriweather', Georgia, serif",
  b: "'Inter', -apple-system, sans-serif",
  m: "'IBM Plex Mono', ui-monospace, monospace",
};

export default function StructureCanvas() {
  const [boxes, setBoxes] = useState([
    { id: "b1", kind: "person", name: "You", x: 30, y: 30 },
    { id: "b2", kind: "person", name: "Dad", x: 210, y: 30 },
    { id: "b3", kind: "llc", name: "Operating LLC", x: 115, y: 210 },
  ]);
  const [wires, setWires] = useState([
    { id: "w1", from: "b1", to: "b3", type: "ownership", papers: { 0: true, 1: true, 2: true } },
    { id: "w2", from: "b2", to: "b3", type: "loan", papers: {} },
  ]);
  const [wiringFrom, setWiringFrom] = useState(null);
  const [picker, setPicker] = useState(null);
  const [selWire, setSelWire] = useState("w2");
  const drag = useRef(null);
  const canvasRef = useRef(null);

  const box = (id) => boxes.find((b) => b.id === id);
  const owners = (entityId) => wires.filter((w) => w.type === "ownership" && w.to === entityId).map((w) => w.from);

  const evalWire = (w) => {
    const from = box(w.from), to = box(w.to);
    const ctx = { fromIsOwnedByTarget: owners(w.from).includes(w.to), toIsOwnedByFrom: owners(w.to).includes(w.from) };
    const spec = evaluate(from, to, w.type, ctx);
    let state = spec.state;
    if (state === "fragile" && spec.papers.length > 0 && spec.papers.every((_, i) => w.papers[i])) state = "valid";
    return { ...spec, state };
  };

  const onBoxTap = (id) => {
    if (wiringFrom === null) return;
    if (wiringFrom === id) { setWiringFrom(null); return; }
    setPicker({ from: wiringFrom, to: id });
    setWiringFrom(null);
  };
  const addWire = (type) => {
    const w = { id: "w" + uid++, from: picker.from, to: picker.to, type, papers: {} };
    setWires([...wires, w]); setPicker(null); setSelWire(w.id);
  };
  const addBox = (kind) => {
    const n = boxes.filter((b) => b.kind === kind).length + 1;
    setBoxes([...boxes, { id: "b" + uid++, kind, name: `${KINDS[kind].label} ${n}`, x: 20 + Math.random() * 180, y: 120 + Math.random() * 140 }]);
  };
  const startDrag = (e, id) => {
    const b = box(id);
    drag.current = { id, ox: e.clientX - b.x, oy: e.clientY - b.y };
    e.target.setPointerCapture?.(e.pointerId);
  };
  const moveDrag = (e) => {
    if (!drag.current) return;
    const { id, ox, oy } = drag.current;
    const rect = canvasRef.current.getBoundingClientRect();
    setBoxes((bs) => bs.map((b) => b.id === id ? {
      ...b,
      x: Math.max(4, Math.min(rect.width - 118, e.clientX - ox)),
      y: Math.max(4, Math.min(rect.height - 64, e.clientY - oy)),
    } : b));
  };

  const sel = wires.find((w) => w.id === selWire);
  const selSpec = sel ? evalWire(sel) : null;

  return (
    <div style={{ minHeight: "100vh", background: "#191410", color: "#D9CDB8", fontFamily: F.b, padding: "18px 12px 70px" }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Merriweather:wght@700;900&family=Inter:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500&display=swap');
        *{box-sizing:border-box;-webkit-tap-highlight-color:transparent} button{cursor:pointer;font-family:inherit}
        @media (prefers-reduced-motion:reduce){*{transition:none!important}}
      `}</style>
      <div style={{ maxWidth: 560, margin: "0 auto" }}>

        <div style={{ fontFamily: F.m, fontSize: 10, letterSpacing: ".25em", color: "#A68B54", marginBottom: 6 }}>STRUCTURE CANVAS · WORKBENCH v0.1</div>
        <h1 style={{ fontFamily: F.d, fontWeight: 900, fontSize: 22, margin: "0 0 6px", color: "#EFE6D4" }}>Wire it. Watch where it fails.</h1>
        <p style={{ fontSize: 12.5, color: "#9c8c74", margin: "0 0 14px", lineHeight: 1.55 }}>
          Tap <b style={{ color: "#D9CDB8" }}>Wire</b>, then a source box, then a target. Tap any wire's terminal to inspect it — the checklist on fragile wires changes their state as the paper becomes real.
        </p>

        {/* toolbar */}
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 10 }}>
          <button onClick={() => setWiringFrom(wiringFrom === "arm" ? null : "arm")}
            style={{ padding: "7px 14px", borderRadius: 4, fontSize: 12, fontWeight: 600, border: `1px solid ${wiringFrom ? "#A68B54" : "#4a3f30"}`, background: wiringFrom ? "#A68B5422" : "#221b13", color: wiringFrom ? "#EFE6D4" : "#b3a186" }}>
            {wiringFrom && wiringFrom !== "arm" ? `Wiring from ${box(wiringFrom).name} — tap target` : wiringFrom === "arm" ? "Tap source box…" : "⌁ Wire"}
          </button>
          {Object.keys(KINDS).map((k) => (
            <button key={k} onClick={() => addBox(k)} style={{ padding: "7px 10px", borderRadius: 4, fontSize: 11.5, border: "1px solid #3a3226", background: "#221b13", color: "#9c8c74" }}>+ {KINDS[k].label}</button>
          ))}
        </div>

        {/* canvas */}
        <div ref={canvasRef} onPointerMove={moveDrag} onPointerUp={() => (drag.current = null)}
          style={{
            position: "relative", height: 330, borderRadius: 8, overflow: "hidden", touchAction: "none",
            border: "1px solid #3a3226",
            background: "linear-gradient(#1e1812,#1a1510), repeating-linear-gradient(0deg,transparent,transparent 23px,#241d1533 24px), repeating-linear-gradient(90deg,transparent,transparent 23px,#241d1533 24px)",
            backgroundBlendMode: "normal",
          }}>
          <svg style={{ position: "absolute", inset: 0, width: "100%", height: "100%", pointerEvents: "none" }}>
            {wires.map((w) => {
              const a = box(w.from), b = box(w.to);
              if (!a || !b) return null;
              const spec = evalWire(w);
              const x1 = a.x + 57, y1 = a.y + 30, x2 = b.x + 57, y2 = b.y + 30;
              const mx = (x1 + x2) / 2, my = (y1 + y2) / 2;
              const c = ST[spec.state].color;
              const on = w.id === selWire;
              return (
                <g key={w.id}>
                  <line x1={x1} y1={y1} x2={x2} y2={y2} stroke={c} strokeWidth={on ? 2 : 1.2}
                    strokeDasharray={spec.state === "invalid" ? "4 4" : "none"} opacity={on ? 1 : 0.75} />
                  <circle cx={mx} cy={my} r={on ? 7 : 5.5} fill="#191410" stroke={c} strokeWidth={1.5}
                    style={{ pointerEvents: "all", cursor: "pointer" }}
                    onClick={() => setSelWire(w.id)} />
                  {spec.state !== "valid" && (
                    <text x={mx} y={my + 3} textAnchor="middle" fontSize="7" fill={c} style={{ pointerEvents: "none", fontFamily: F.m }}>!</text>
                  )}
                </g>
              );
            })}
          </svg>
          {boxes.map((b) => {
            const isSrc = wiringFrom === b.id;
            return (
              <div key={b.id}
                onPointerDown={(e) => { if (!wiringFrom) startDrag(e, b.id); }}
                onClick={() => { if (wiringFrom === "arm") setWiringFrom(b.id); else onBoxTap(b.id); }}
                style={{
                  position: "absolute", left: b.x, top: b.y, width: 114, padding: "9px 10px", borderRadius: 5,
                  background: "linear-gradient(180deg,#2c2318,#241c12)",
                  border: `1px solid ${isSrc ? "#A68B54" : "#443929"}`,
                  boxShadow: isSrc ? "0 0 0 1px #A68B5455, 0 4px 12px rgba(0,0,0,.5)" : "0 3px 10px rgba(0,0,0,.45), inset 0 1px 0 rgba(255,235,200,.05)",
                  cursor: wiringFrom ? "pointer" : "grab", userSelect: "none",
                }}>
                <div style={{ fontFamily: F.d, fontWeight: 700, fontSize: 13, color: "#EFE6D4", lineHeight: 1.2 }}>{b.name}</div>
                <div style={{ fontFamily: F.m, fontSize: 8.5, color: "#8f7f66", marginTop: 3, letterSpacing: ".06em" }}>{KINDS[b.kind].tag.toUpperCase()}</div>
              </div>
            );
          })}
        </div>

        {/* wire-type picker */}
        {picker && (
          <div style={{ marginTop: 12, border: "1px solid #4a3f30", borderRadius: 6, background: "#20190f", padding: 12 }}>
            <div style={{ fontFamily: F.m, fontSize: 10, letterSpacing: ".15em", color: "#A68B54", marginBottom: 8 }}>
              {box(picker.from).name} → {box(picker.to).name} · CHOOSE THE FLOW
            </div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
              {WIRE_TYPES.map((t) => {
                const spec = evaluate(box(picker.from), box(picker.to), t.id, {
                  fromIsOwnedByTarget: owners(picker.from).includes(picker.to),
                  toIsOwnedByFrom: owners(picker.to).includes(picker.from),
                });
                const c = ST[spec.state].color;
                return (
                  <button key={t.id} onClick={() => addWire(t.id)}
                    style={{ padding: "7px 11px", borderRadius: 4, fontSize: 11.5, border: `1px solid ${c}55`, background: "#191410", color: "#c9b998", display: "flex", alignItems: "center", gap: 6 }}>
                    <span style={{ width: 7, height: 7, borderRadius: "50%", background: c, display: "inline-block" }} />
                    {t.label}
                  </button>
                );
              })}
            </div>
            <button onClick={() => setPicker(null)} style={{ marginTop: 10, background: "none", border: "none", color: "#8f7f66", fontSize: 11 }}>cancel</button>
          </div>
        )}

        {/* inspector */}
        {sel && selSpec && (
          <div style={{ marginTop: 14, borderRadius: 6, border: `1px solid ${ST[selSpec.state].color}44`, borderLeft: `3px solid ${ST[selSpec.state].color}`, background: "#1e1710", padding: "14px 14px 12px" }}>
            <div style={{ display: "flex", justifyContent: "space-between", gap: 8, alignItems: "baseline" }}>
              <div style={{ fontFamily: F.d, fontWeight: 700, fontSize: 15, color: "#EFE6D4" }}>
                {box(sel.from).name} → {box(sel.to).name}
                <span style={{ fontFamily: F.m, fontWeight: 400, fontSize: 10, color: "#8f7f66", marginLeft: 8 }}>
                  {WIRE_TYPES.find((t) => t.id === sel.type).label.toUpperCase()}
                </span>
              </div>
              <span style={{ fontFamily: F.m, fontSize: 10, color: ST[selSpec.state].color, whiteSpace: "nowrap" }}>{ST[selSpec.state].label}</span>
            </div>
            {selSpec.as && <div style={{ fontSize: 12.5, color: "#c9b998", marginTop: 6 }}>Reads as: <b style={{ color: "#EFE6D4" }}>{selSpec.as}</b></div>}
            {selSpec.note && <p style={{ fontSize: 12.5, color: "#b3a186", lineHeight: 1.55, margin: "8px 0 0" }}>{selSpec.note}</p>}
            {selSpec.upside && (
              <div style={{ marginTop: 10 }}>
                <div style={{ fontFamily: F.m, fontSize: 9, letterSpacing: ".18em", color: "#A68B54" }}>WORKS FOR YOU</div>
                <p style={{ fontSize: 12.5, color: "#b3a186", lineHeight: 1.55, margin: "3px 0 0" }}>{selSpec.upside}</p>
              </div>
            )}
            {selSpec.exposure && (
              <div style={{ marginTop: 10 }}>
                <div style={{ fontFamily: F.m, fontSize: 9, letterSpacing: ".18em", color: "#B4762E" }}>EXPOSURE</div>
                <p style={{ fontSize: 12.5, color: "#b3a186", lineHeight: 1.55, margin: "3px 0 0" }}>{selSpec.exposure}</p>
              </div>
            )}
            {selSpec.papers.length > 0 && (
              <div style={{ marginTop: 12 }}>
                <div style={{ fontFamily: F.m, fontSize: 9, letterSpacing: ".18em", color: "#8f7f66", marginBottom: 6 }}>PAPER THAT MAKES IT REAL</div>
                {selSpec.papers.map((p, i) => (
                  <label key={i} style={{ display: "flex", gap: 9, alignItems: "flex-start", marginBottom: 6, fontSize: 12.5, color: sel.papers[i] ? "#c9b998" : "#8f7f66" }}>
                    <input type="checkbox" checked={!!sel.papers[i]}
                      onChange={() => setWires((ws) => ws.map((w) => w.id === sel.id ? { ...w, papers: { ...w.papers, [i]: !w.papers[i] } } : w))}
                      style={{ accentColor: "#A68B54", marginTop: 2 }} />
                    {p}
                  </label>
                ))}
              </div>
            )}
            <div style={{ display: "flex", gap: 6, alignItems: "center", marginTop: 12, flexWrap: "wrap" }}>
              <span style={{ fontFamily: F.m, fontSize: 9.5, padding: "3px 8px", border: "1px solid #A68B5466", borderRadius: 3, color: "#A68B54" }}>{selSpec.prov.dist}</span>
              <span style={{ fontFamily: F.m, fontSize: 9.5, padding: "3px 8px", border: `1px solid ${selSpec.prov.settled === "Adjudicated against" ? "#8E3B31" : "#6f7f5c"}66`, borderRadius: 3, color: selSpec.prov.settled === "Adjudicated against" ? "#8E3B31" : "#93a37e" }}>{selSpec.prov.settled}</span>
              <span style={{ fontFamily: F.m, fontSize: 9.5, color: "#6e6152" }}>{selSpec.prov.cite}</span>
              <button onClick={() => { setWires(wires.filter((w) => w.id !== sel.id)); setSelWire(null); }}
                style={{ marginLeft: "auto", background: "none", border: "1px solid #3a3226", borderRadius: 3, color: "#8f7f66", fontSize: 10, padding: "3px 8px" }}>cut wire</button>
            </div>
          </div>
        )}

        <p style={{ marginTop: 18, fontFamily: F.m, fontSize: 9.5, color: "#5c5142", lineHeight: 1.6 }}>
          rules table is plain data keyed (entity, entity, flow) — shaped for lexicon hydration · evaluation is structural, not advisory · not legal advice; every claim carries its cite
        </p>
      </div>
    </div>
  );
}
