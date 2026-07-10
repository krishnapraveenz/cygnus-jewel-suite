import { useEffect, useMemo, useState } from "react";
import { Hammer, Gem } from "lucide-react";
import * as api from "@/api";
import type { MetalOpt, OldGoldRow, SmithJobRow, SmithRow } from "@/api";
import { StonePicker } from "@/components/sales/StonePicker";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { cn, formatINR } from "@/lib/utils";

const TABS = ["smiths", "jobwork", "melt"] as const;
type Tab = (typeof TABS)[number];
const TAB_LABEL: Record<Tab, string> = { smiths: "Smiths", jobwork: "Job Work", melt: "Melt Scrap" };
const jobBadge: Record<string, "default" | "secondary" | "success" | "warning"> = {
  issued: "warning",
  received: "default",
  settled: "success",
};

export function Smiths() {
  const [tab, setTab] = useState<Tab>("smiths");
  const [smiths, setSmiths] = useState<SmithRow[]>([]);
  const [jobs, setJobs] = useState<SmithJobRow[]>([]);
  const [metals, setMetals] = useState<MetalOpt[]>([]);
  const [scrap, setScrap] = useState<OldGoldRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function load() {
    try {
      const [s, j, m, og] = await Promise.all([api.listSmiths(), api.listSmithJobs(), api.listMetals(), api.listOldGold()]);
      setSmiths(s);
      setJobs(j);
      setMetals(m);
      setScrap(og.filter((x) => x.status === "in_scrap"));
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    }
  }
  useEffect(() => {
    load();
  }, []);

  function flash(msg: string) {
    setOk(msg);
    setError(null);
  }
  function fail(e: unknown) {
    setError(String(e instanceof Error ? e.message : e));
    setOk(null);
  }

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-xl font-semibold">Smiths / Job Work</h2>
        <p className="text-sm text-muted-foreground">
          Issue metal to a smith, receive finished ornaments into stock, and settle making — full metal account.
        </p>
      </div>

      <div className="inline-flex h-9 items-center gap-0.5 border-b border-border">
        {TABS.map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={cn(
              "inline-flex items-center px-3 py-2 text-sm transition-colors",
              tab === t ? "border-b-2 border-primary text-foreground font-medium" : "text-muted-foreground hover:text-foreground",
            )}
          >
            {TAB_LABEL[t]}
          </button>
        ))}
      </div>

      {error && <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">{error}</div>}
      {ok && <div className="rounded-md border border-success/30 bg-success/5 px-3 py-2 text-sm text-success">{ok}</div>}

      {tab === "smiths" && <SmithsTab smiths={smiths} busy={busy} setBusy={setBusy} reload={load} flash={flash} fail={fail} />}
      {tab === "jobwork" && (
        <JobWorkTab smiths={smiths} jobs={jobs} metals={metals} busy={busy} setBusy={setBusy} reload={load} flash={flash} fail={fail} />
      )}
      {tab === "melt" && (
        <MeltTab metals={metals} scrap={scrap} busy={busy} setBusy={setBusy} reload={load} flash={flash} fail={fail} />
      )}
    </div>
  );
}

type Shared = {
  busy: boolean;
  setBusy: (b: boolean) => void;
  reload: () => Promise<void>;
  flash: (m: string) => void;
  fail: (e: unknown) => void;
};

function SmithsTab({ smiths, busy, setBusy, reload, flash, fail }: Shared & { smiths: SmithRow[] }) {
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [gstin, setGstin] = useState("");
  const [registered, setRegistered] = useState(false);

  async function add() {
    if (!name.trim()) return fail("Smith name required");
    setBusy(true);
    try {
      await api.createSmith({ name, phone: phone || undefined, gstin: gstin || undefined, gst_registered: registered });
      flash(`Added ${name}`);
      setName("");
      setPhone("");
      setGstin("");
      setRegistered(false);
      await reload();
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <Card className="p-4">
        <div className="grid grid-cols-2 md:grid-cols-5 gap-3 items-end">
          <div>
            <Label>Name</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div>
            <Label>Phone</Label>
            <Input value={phone} onChange={(e) => setPhone(e.target.value)} />
          </div>
          <div>
            <Label>GSTIN</Label>
            <Input value={gstin} onChange={(e) => setGstin(e.target.value)} placeholder="optional" />
          </div>
          <label className="flex items-center gap-2 text-sm h-8">
            <input type="checkbox" checked={registered} onChange={(e) => setRegistered(e.target.checked)} />
            GST registered
          </label>
          <Button onClick={add} disabled={busy}>
            Add smith
          </Button>
        </div>
      </Card>

      <Card className="overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-muted/50 border-b border-border">
              <th className="text-left px-3 py-2 font-medium text-muted-foreground">Smith</th>
              <th className="text-left px-3 py-2 font-medium text-muted-foreground">Phone</th>
              <th className="text-center px-3 py-2 font-medium text-muted-foreground">GST</th>
              <th className="text-right px-3 py-2 font-medium text-muted-foreground">Metal held (fine g)</th>
              <th className="text-right px-3 py-2 font-medium text-muted-foreground">Cash payable</th>
            </tr>
          </thead>
          <tbody>
            {smiths.map((s) => (
              <tr key={s.id} className="border-b border-border last:border-0 hover:bg-accent">
                <td className="px-3 py-2">{s.name}</td>
                <td className="px-3 py-2 text-muted-foreground">{s.phone || "—"}</td>
                <td className="px-3 py-2 text-center">
                  <Badge variant={s.gst_registered ? "success" : "secondary"}>{s.gst_registered ? "Reg" : "Unreg (RCM)"}</Badge>
                </td>
                <td className="px-3 py-2 text-right font-mono">{Number(s.metal_balance).toFixed(3)}</td>
                <td className="px-3 py-2 text-right font-mono">{formatINR(s.cash_payable)}</td>
              </tr>
            ))}
            {smiths.length === 0 && (
              <tr>
                <td colSpan={5} className="px-3 py-10 text-center text-muted-foreground">
                  <Hammer className="w-8 h-8 mx-auto mb-2 opacity-40" />
                  <div className="text-sm">No smiths yet.</div>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </Card>
    </div>
  );
}

function JobWorkTab({
  smiths,
  jobs,
  metals,
  busy,
  setBusy,
  reload,
  flash,
  fail,
}: Shared & { smiths: SmithRow[]; jobs: SmithJobRow[]; metals: MetalOpt[] }) {
  // Issue form
  const [smithId, setSmithId] = useState<number | null>(null);
  const [metalId, setMetalId] = useState<number | null>(null);
  const [source, setSource] = useState<"refined" | "scrap">("refined");
  const [fine, setFine] = useState("");
  const [wastage, setWastage] = useState("");
  const [mpg, setMpg] = useState("");
  const [mpp, setMpp] = useState("");

  useEffect(() => {
    if (smithId === null && smiths.length) setSmithId(smiths[0].id);
    if (metalId === null && metals.length) setMetalId(metals[0].metal_type_id);
  }, [smiths, metals]);

  async function issue() {
    if (!smithId || !metalId || !fine || Number(fine) <= 0) return fail("Pick smith, metal and fine weight");
    setBusy(true);
    try {
      await api.issueSmithJob({
        smith_id: smithId,
        metal_type_id: metalId,
        source,
        issued_fine_weight: fine,
        wastage_percent_allowed: wastage || undefined,
        making_per_gram: mpg || undefined,
        making_per_piece: mpp || undefined,
      });
      flash("Metal issued to smith");
      setFine("");
      await reload();
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <Card className="p-4">
        <div className="text-sm font-medium mb-3">Issue metal to a smith</div>
        <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-7 gap-3 items-end">
          <div>
            <Label>Smith</Label>
            <select className="flex h-8 w-full rounded-md border border-input bg-background px-2 text-sm" value={smithId ?? ""} onChange={(e) => setSmithId(Number(e.target.value))}>
              {smiths.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <Label>Metal</Label>
            <select className="flex h-8 w-full rounded-md border border-input bg-background px-2 text-sm" value={metalId ?? ""} onChange={(e) => setMetalId(Number(e.target.value))}>
              {metals.map((m) => (
                <option key={m.metal_type_id} value={m.metal_type_id}>
                  {m.metal}
                </option>
              ))}
            </select>
          </div>
          <div>
            <Label>Source</Label>
            <select className="flex h-8 w-full rounded-md border border-input bg-background px-2 text-sm" value={source} onChange={(e) => setSource(e.target.value as "refined" | "scrap")}>
              <option value="refined">Refined (melted)</option>
              <option value="scrap">Scrap (direct)</option>
            </select>
          </div>
          <div>
            <Label>Fine issued (g)</Label>
            <Input value={fine} onChange={(e) => setFine(e.target.value)} inputMode="decimal" />
          </div>
          <div>
            <Label>Wastage % allowed</Label>
            <Input value={wastage} onChange={(e) => setWastage(e.target.value)} inputMode="decimal" />
          </div>
          <div>
            <Label>Making ₹/g</Label>
            <Input value={mpg} onChange={(e) => setMpg(e.target.value)} inputMode="decimal" />
          </div>
          <div>
            <Label>Making ₹/pc</Label>
            <Input value={mpp} onChange={(e) => setMpp(e.target.value)} inputMode="decimal" />
          </div>
        </div>
        <Button className="mt-3" onClick={issue} disabled={busy}>
          Issue
        </Button>
      </Card>

      <Card className="overflow-hidden">
        <div className="bg-muted/50 border-b border-border px-3 py-2 text-sm font-medium">Jobs</div>
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-muted/30 border-b border-border">
              <th className="text-left px-3 py-2 font-medium text-muted-foreground">#</th>
              <th className="text-left px-3 py-2 font-medium text-muted-foreground">Smith</th>
              <th className="text-center px-3 py-2 font-medium text-muted-foreground">Status</th>
              <th className="text-right px-3 py-2 font-medium text-muted-foreground">Issued fine</th>
              <th className="text-right px-3 py-2 font-medium text-muted-foreground">Recd fine</th>
              <th className="text-right px-3 py-2 font-medium text-muted-foreground">Wastage</th>
              <th className="text-right px-3 py-2 font-medium text-muted-foreground">Making</th>
              <th className="text-left px-3 py-2 font-medium text-muted-foreground">Item</th>
              <th className="text-right px-3 py-2 font-medium text-muted-foreground">Action</th>
            </tr>
          </thead>
          <tbody>
            {jobs.map((j) => (
              <JobRow key={j.id} job={j} metals={metals} busy={busy} setBusy={setBusy} reload={reload} flash={flash} fail={fail} />
            ))}
            {jobs.length === 0 && (
              <tr>
                <td colSpan={9} className="px-3 py-10 text-center text-muted-foreground text-sm">
                  No jobs yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </Card>
    </div>
  );
}

function JobRow({
  job,
  metals,
  busy,
  setBusy,
  reload,
  flash,
  fail,
}: Shared & { job: SmithJobRow; metals: MetalOpt[] }) {
  const [open, setOpen] = useState(false);
  const purities = useMemo(() => metals.flatMap((m) => m.purities), [metals]);
  const [purityId, setPurityId] = useState<number | null>(null);
  const [gross, setGross] = useState("");
  const [net, setNet] = useState("");
  const [recFine, setRecFine] = useState("");
  const [pieces, setPieces] = useState("1");
  const [stones, setStones] = useState<api.LineStoneReq[]>([]);
  const [stoneTypes, setStoneTypes] = useState<api.StoneTypeMaster[]>([]);
  const [picker, setPicker] = useState(false);
  const [cats, setCats] = useState<api.ItemCategory[]>([]);
  const [categoryId, setCategoryId] = useState<number | "">("");
  useEffect(() => {
    if (open && stoneTypes.length === 0) api.listStoneTypes().then(setStoneTypes).catch(() => {});
    if (open && cats.length === 0) api.listItemCategories().then((c) => setCats(c.filter((x) => x.active))).catch(() => {});
  }, [open, stoneTypes.length, cats.length]);

  async function receive() {
    if (!purityId || !gross || !net || !recFine) return fail("Fill purity, gross, net, fine");
    setBusy(true);
    try {
      const r = await api.receiveSmithJob(job.id, {
        purity_id: purityId,
        received_gross: gross,
        received_net: net,
        received_fine: recFine,
        pieces: Number(pieces) || 1,
        stones: stones.length ? stones : undefined,
        category_id: categoryId === "" ? undefined : Number(categoryId),
      });
      flash(`Received → ${r.sku}, making ${formatINR(r.making_charge)}${r.rcm ? " (RCM)" : ""}, wastage ${r.wastage_weight}g`);
      setOpen(false);
      setStones([]);
      await reload();
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  }

  async function settle() {
    if (!job.making_charge) return;
    setBusy(true);
    try {
      const r = await api.settleSmithJob(job.id, { amount: job.making_charge, mode: "bank_transfer" });
      flash(`Settled ${formatINR(r.paid)}`);
      await reload();
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <tr className="border-b border-border last:border-0 hover:bg-accent">
        <td className="px-3 py-2 font-mono text-xs">{job.id}</td>
        <td className="px-3 py-2">{job.smith}</td>
        <td className="px-3 py-2 text-center">
          <Badge variant={jobBadge[job.status] || "secondary"}>{job.status}</Badge>
        </td>
        <td className="px-3 py-2 text-right font-mono">{Number(job.issued_fine).toFixed(3)}</td>
        <td className="px-3 py-2 text-right font-mono">{job.received_fine ? Number(job.received_fine).toFixed(3) : "—"}</td>
        <td className="px-3 py-2 text-right font-mono">{job.wastage_weight ? `${Number(job.wastage_weight).toFixed(3)}g` : "—"}</td>
        <td className="px-3 py-2 text-right font-mono">{job.making_charge ? formatINR(job.making_charge) : "—"}</td>
        <td className="px-3 py-2 font-mono text-xs">{job.item_sku || "—"}</td>
        <td className="px-3 py-2 text-right whitespace-nowrap">
          {job.status === "issued" && (
            <Button size="sm" variant="outline" onClick={() => setOpen((v) => !v)}>
              {open ? "Cancel" : "Receive"}
            </Button>
          )}
          {job.status === "received" && (
            <Button size="sm" variant="ghost" className="text-success" disabled={busy} onClick={settle}>
              Settle
            </Button>
          )}
        </td>
      </tr>
      {open && (
        <tr className="bg-muted/20 border-b border-border">
          <td colSpan={9} className="px-3 py-3">
            <div className="grid grid-cols-2 md:grid-cols-6 gap-3 items-end">
              <div>
                <Label>Purity</Label>
                <select className="flex h-8 w-full rounded-md border border-input bg-background px-2 text-sm" value={purityId ?? ""} onChange={(e) => setPurityId(Number(e.target.value))}>
                  <option value="">Select…</option>
                  {purities.map((p) => (
                    <option key={p.purity_id} value={p.purity_id}>
                      {p.label}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <Label>Gross (g)</Label>
                <Input value={gross} onChange={(e) => setGross(e.target.value)} inputMode="decimal" />
              </div>
              <div>
                <Label>Net (g)</Label>
                <Input value={net} onChange={(e) => setNet(e.target.value)} inputMode="decimal" />
              </div>
              <div>
                <Label>Fine (g)</Label>
                <Input value={recFine} onChange={(e) => setRecFine(e.target.value)} inputMode="decimal" />
              </div>
              <div>
                <Label>Pieces</Label>
                <Input value={pieces} onChange={(e) => setPieces(e.target.value)} inputMode="numeric" />
              </div>
              <div>
                <Label>Category</Label>
                <select
                  className="flex h-8 w-full rounded-md border border-input bg-background px-2 text-sm"
                  value={categoryId}
                  onChange={(e) => setCategoryId(e.target.value ? Number(e.target.value) : "")}
                >
                  <option value="">—</option>
                  {cats.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
              </div>
              <Button onClick={receive} disabled={busy}>
                Receive into stock
              </Button>
            </div>
            <div className="mt-2 flex items-center gap-3 text-xs">
              <Button size="sm" variant="outline" onClick={() => setPicker(true)}>
                <Gem className="w-3.5 h-3.5 mr-1" /> Stones
              </Button>
              {stones.length > 0 ? (
                <span className="text-muted-foreground">
                  {stones.length} stone(s) · {formatINR(stones.reduce((a, s) => a + Number(s.value), 0))}
                </span>
              ) : (
                <span className="text-muted-foreground">no stones set</span>
              )}
            </div>
            {picker && (
              <StonePicker
                stoneTypes={stoneTypes}
                onApply={(_total, st) => {
                  setStones(st);
                  setPicker(false);
                }}
                onClose={() => setPicker(false)}
              />
            )}
          </td>
        </tr>
      )}
    </>
  );
}

function MeltTab({ metals, scrap, busy, setBusy, reload, flash, fail }: Shared & { metals: MetalOpt[]; scrap: OldGoldRow[] }) {
  const [metalId, setMetalId] = useState<number | null>(null);
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [fineRec, setFineRec] = useState("");

  useEffect(() => {
    if (metalId === null && metals.length) setMetalId(metals[0].metal_type_id);
  }, [metals]);

  // A melt batch is one metal: show only that metal's scrap, and clear picks when it changes.
  const selectedMetalName = metals.find((m) => m.metal_type_id === metalId)?.metal;
  const visibleScrap = scrap.filter((l) => !selectedMetalName || l.metal === selectedMetalName);
  useEffect(() => {
    setPicked(new Set());
  }, [metalId]);

  function toggle(id: number) {
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const pickedFine = visibleScrap
    .filter((l) => picked.has(l.id))
    .reduce((a, l) => a + Number(l.fine_weight ?? 0), 0);

  async function melt() {
    if (!metalId || picked.size === 0 || !fineRec) return fail("Pick metal, scrap lots and recovered fine");
    setBusy(true);
    try {
      const r = await api.createMelt({ metal_type_id: metalId, old_gold_lot_ids: [...picked], fine_recovered: fineRec });
      flash(`Melt #${r.melt_batch_id}: expected ${r.expected_fine}g → recovered ${r.fine_recovered}g (loss ${r.loss}g, variance ${r.variance}g)`);
      setPicked(new Set());
      setFineRec("");
      await reload();
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <Card className="p-4">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 items-end">
          <div>
            <Label>Metal</Label>
            <select className="flex h-8 w-full rounded-md border border-input bg-background px-2 text-sm" value={metalId ?? ""} onChange={(e) => setMetalId(Number(e.target.value))}>
              {metals.map((m) => (
                <option key={m.metal_type_id} value={m.metal_type_id}>
                  {m.metal}
                </option>
              ))}
            </select>
          </div>
          <div>
            <Label>Fine recovered (g)</Label>
            <Input value={fineRec} onChange={(e) => setFineRec(e.target.value)} inputMode="decimal" />
          </div>
          <div className="text-sm">
            <div className="text-muted-foreground text-xs">Selected fine content</div>
            <div className="font-mono">{pickedFine.toFixed(3)} g</div>
          </div>
          <Button onClick={melt} disabled={busy}>
            Melt batch
          </Button>
        </div>
      </Card>

      <Card className="overflow-hidden">
        <div className="bg-muted/50 border-b border-border px-3 py-2 text-sm font-medium">Scrap lots in stock</div>
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-muted/30 border-b border-border">
              <th className="px-3 py-2 w-8"></th>
              <th className="text-left px-3 py-2 font-medium text-muted-foreground">Lot</th>
              <th className="text-left px-3 py-2 font-medium text-muted-foreground">Type</th>
              <th className="text-left px-3 py-2 font-medium text-muted-foreground">Purity</th>
              <th className="text-right px-3 py-2 font-medium text-muted-foreground">Gross</th>
              <th className="text-right px-3 py-2 font-medium text-muted-foreground">Fine</th>
              <th className="text-left px-3 py-2 font-medium text-muted-foreground">From</th>
            </tr>
          </thead>
          <tbody>
            {visibleScrap.map((l) => (
              <tr key={l.id} className={cn("border-b border-border last:border-0 hover:bg-accent", picked.has(l.id) && "bg-accent")}>
                <td className="px-3 py-2 text-center">
                  <input type="checkbox" checked={picked.has(l.id)} onChange={() => toggle(l.id)} />
                </td>
                <td className="px-3 py-2 font-mono text-xs">#{l.id}</td>
                <td className="px-3 py-2 text-xs">{l.department || "—"}</td>
                <td className="px-3 py-2">{l.purity || "—"}</td>
                <td className="px-3 py-2 text-right font-mono">{Number(l.gross_weight).toFixed(3)}</td>
                <td className="px-3 py-2 text-right font-mono">{l.fine_weight ? Number(l.fine_weight).toFixed(3) : "—"}</td>
                <td className="px-3 py-2 text-xs text-muted-foreground">{l.customer_name || "—"}</td>
              </tr>
            ))}
            {visibleScrap.length === 0 && (
              <tr>
                <td colSpan={7} className="px-3 py-10 text-center text-muted-foreground text-sm">
                  No scrap lots in stock.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </Card>
    </div>
  );
}
