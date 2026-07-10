import { useEffect, useState } from "react";
import { Plus, X, Wifi, RefreshCw, Trash2, Upload, Radar, Loader2, Pencil, CheckCircle2, XCircle } from "lucide-react";
import * as api from "@/api";
import type { BiometricDevice, DeviceReq, UnmatchedPunch, Staff, DeviceStatus, ScanResult } from "@/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card } from "@/components/ui/card";
import { formatDate } from "@/lib/utils";

const emptyDev: DeviceReq = { name: "", brand: "zkteco", ip: "", port: 4370, serial_no: "", enabled: true };
const BRAND_LABEL: Record<string, string> = { zkteco: "ZKTeco", essl: "eSSL", cpplus: "CP Plus", other: "Other" };

export function BiometricDevices() {
  const [list, setList] = useState<BiometricDevice[]>([]);
  const [status, setStatus] = useState<Record<number, DeviceStatus>>({});
  const [statusLoading, setStatusLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ id?: number; body: DeviceReq } | null>(null);
  const [csv, setCsv] = useState("");
  const [importDev, setImportDev] = useState(0);
  const [unmatched, setUnmatched] = useState<UnmatchedPunch[]>([]);
  const [staff, setStaff] = useState<Staff[]>([]);
  const [relinkTo, setRelinkTo] = useState<Record<string, number>>({});
  // Scan
  const [scanOpen, setScanOpen] = useState(false);
  const [scanBase, setScanBase] = useState("");
  const [scanPort, setScanPort] = useState(4370);
  const [scanning, setScanning] = useState(false);
  const [scan, setScan] = useState<ScanResult | null>(null);

  async function load() {
    try {
      const [d, u, st] = await Promise.all([api.listDevices(), api.listUnmatchedPunches(), api.listStaff()]);
      setList(d);
      setUnmatched(u);
      setStaff(st.filter((s) => s.status === "active"));
    } catch (e) { setError(String(e instanceof Error ? e.message : e)); }
  }
  async function refreshStatus() {
    setStatusLoading(true);
    try {
      const rows = await api.devicesStatus();
      setStatus(Object.fromEntries(rows.map((r) => [r.id, r])));
    } catch { /* ignore */ } finally { setStatusLoading(false); }
  }
  useEffect(() => { load(); }, []);
  useEffect(() => { if (list.length) refreshStatus(); /* eslint-disable-next-line */ }, [list.length]);

  async function save() {
    if (!editing) return;
    if (!editing.body.name.trim()) return setError("Name is required");
    setError(null);
    try {
      if (editing.id) await api.updateDevice(editing.id, editing.body);
      else await api.createDevice(editing.body);
      setEditing(null); await load();
    } catch (e) { setError(String(e instanceof Error ? e.message : e)); }
  }
  async function test(id: number) {
    setMsg(null); setError(null);
    try { const r = await api.testDevice(id); setStatus((s) => ({ ...s, [id]: { id, ok: r.ok, ms: r.ms } })); r.ok ? setMsg(`Connected in ${r.ms} ms`) : setError(`Connection failed: ${r.error}`); }
    catch (e) { setError(String(e instanceof Error ? e.message : e)); }
  }
  async function sync(id: number) {
    setMsg(null); setError(null);
    try { const r = await api.syncDevice(id); setMsg(r.message); await load(); } catch (e) { setError(String(e instanceof Error ? e.message : e)); }
  }
  async function del(id: number) {
    try { await api.deleteDevice(id); await load(); } catch (e) { setError(String(e instanceof Error ? e.message : e)); }
  }
  async function doImport() {
    if (!csv.trim()) return;
    setMsg(null); setError(null);
    try { const r = await api.importPunches(csv, importDev || undefined); setMsg(`Imported ${r.inserted} of ${r.received} punches`); setCsv(""); await load(); }
    catch (e) { setError(String(e instanceof Error ? e.message : e)); }
  }
  async function relink(bio: string) {
    const sid = relinkTo[bio];
    if (!sid) return setError("Pick a staff member to map to");
    setError(null); setMsg(null);
    try { const r = await api.relinkPunches(bio, sid); setMsg(`Linked ${r.linked_punches} punches`); await load(); }
    catch (e) { setError(String(e instanceof Error ? e.message : e)); }
  }
  async function runScan() {
    setScanning(true); setError(null); setScan(null);
    try { setScan(await api.scanDevices(scanBase, scanPort)); }
    catch (e) { setError(String(e instanceof Error ? e.message : e)); }
    finally { setScanning(false); }
  }
  function addFromScan(ip: string) {
    setScanOpen(false);
    setEditing({ body: { ...emptyDev, name: `Device ${ip}`, ip, port: scanPort } });
  }

  const pushUrl = `${window.location.protocol}//<this-PC-LAN-IP>:8787/iclock/cdata`;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-semibold">Biometric Devices</h2>
          <p className="text-sm text-muted-foreground">eSSL · CP Plus · ZKTeco on your LAN</p>
        </div>
        <div className="flex items-center gap-2">
          <Button size="sm" variant="outline" onClick={() => { setScanOpen(true); setScan(null); }}><Radar className="w-4 h-4 mr-1" /> Scan network</Button>
          <Button size="sm" variant="outline" onClick={refreshStatus} disabled={statusLoading}>{statusLoading ? <Loader2 className="w-4 h-4 mr-1 animate-spin" /> : <RefreshCw className="w-4 h-4 mr-1" />} Refresh status</Button>
          <Button size="sm" onClick={() => setEditing({ body: { ...emptyDev } })}><Plus className="w-4 h-4 mr-1" /> Add device</Button>
        </div>
      </div>

      {error && <div className="rounded-md bg-destructive/10 text-destructive px-3 py-2 text-sm">{error}</div>}
      {msg && <div className="rounded-md bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 px-3 py-2 text-sm">{msg}</div>}

      {/* Device cards */}
      {list.length === 0 ? (
        <Card className="p-10 text-center text-sm text-muted-foreground">
          No devices yet. <button className="text-primary underline" onClick={() => { setScanOpen(true); setScan(null); }}>Scan your network</button> to find one, or add it manually.
        </Card>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
          {list.map((d) => {
            const st = status[d.id];
            const dot = st ? (st.ok ? "bg-emerald-500" : "bg-red-500") : "bg-muted-foreground/40";
            return (
              <Card key={d.id} className="p-3">
                <div className="flex items-start justify-between">
                  <div className="flex items-center gap-2">
                    <span className={`inline-block w-2.5 h-2.5 rounded-full ${dot}`} title={st ? (st.ok ? `online ${st.ms}ms` : "offline") : "unknown"} />
                    <div>
                      <div className="font-medium leading-tight">{d.name}</div>
                      <div className="text-xs text-muted-foreground">{BRAND_LABEL[d.brand] ?? d.brand}</div>
                    </div>
                  </div>
                  <span className={`text-[11px] px-1.5 py-0.5 rounded-full ${st ? (st.ok ? "bg-emerald-500/10 text-emerald-600" : "bg-red-500/10 text-red-600") : "bg-muted text-muted-foreground"}`}>
                    {st ? (st.ok ? `online · ${st.ms}ms` : "offline") : "—"}
                  </span>
                </div>
                <div className="mt-2 space-y-1 text-xs">
                  <div className="flex justify-between"><span className="text-muted-foreground">Address</span><span className="font-mono">{d.ip ?? "—"} : {d.port}</span></div>
                  <div className="flex justify-between"><span className="text-muted-foreground">Serial</span><span className="font-mono">{d.serial_no ?? "—"}</span></div>
                  <div className="flex justify-between"><span className="text-muted-foreground">Last sync</span><span>{d.last_sync ? formatDate(d.last_sync) : "never"}</span></div>
                </div>
                <div className="mt-3 flex items-center gap-1 border-t border-border pt-2">
                  <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={() => test(d.id)}><Wifi className="w-3.5 h-3.5 mr-1" /> Test</Button>
                  <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={() => sync(d.id)}><RefreshCw className="w-3.5 h-3.5 mr-1" /> Sync</Button>
                  <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={() => setEditing({ id: d.id, body: { name: d.name, brand: d.brand, ip: d.ip ?? "", port: d.port, serial_no: d.serial_no ?? "", enabled: d.enabled } })}><Pencil className="w-3.5 h-3.5 mr-1" /> Edit</Button>
                  <Button size="sm" variant="ghost" className="h-7 px-2 text-xs text-destructive ml-auto" onClick={() => del(d.id)}><Trash2 className="w-3.5 h-3.5" /></Button>
                </div>
              </Card>
            );
          })}
        </div>
      )}

      {/* Unmatched punches */}
      {unmatched.length > 0 && (
        <Card className="p-3 border-amber-400/50">
          <div className="text-sm font-medium mb-2">Unmatched punches — {unmatched.length} unknown biometric ID(s)</div>
          <p className="text-xs text-muted-foreground mb-2">Punches from IDs not assigned to any staff. Map each to a staff member (also sets their Biometric user ID).</p>
          <div className="space-y-1.5">
            {unmatched.map((u) => (
              <div key={u.biometric_user_id} className="flex items-center gap-2 text-sm">
                <span className="font-mono w-24">#{u.biometric_user_id}</span>
                <span className="text-xs text-muted-foreground w-28">{u.count} punches</span>
                <select className="h-8 rounded-md border border-input bg-background px-2 text-sm" value={relinkTo[u.biometric_user_id] ?? 0} onChange={(e) => setRelinkTo({ ...relinkTo, [u.biometric_user_id]: Number(e.target.value) })}>
                  <option value={0}>Map to staff…</option>
                  {staff.map((s) => <option key={s.id} value={s.id}>{s.name} ({s.code})</option>)}
                </select>
                <Button size="sm" variant="outline" onClick={() => relink(u.biometric_user_id)}>Link</Button>
              </div>
            ))}
          </div>
        </Card>
      )}

      {/* Ingestion setup */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Card className="p-3">
          <div className="text-sm font-medium mb-1">Live LAN push (ADMS / iclock)</div>
          <p className="text-xs text-muted-foreground">In the device menu (Comm → Cloud Server / ADMS), set the server address to this PC; it pushes punches in real time, matched by <b>Biometric user ID</b>.</p>
          <div className="mt-2 rounded bg-muted px-2 py-1.5 font-mono text-xs break-all">{pushUrl}</div>
        </Card>
        <Card className="p-3">
          <div className="text-sm font-medium mb-1">Import punches (CSV / .dat export)</div>
          <p className="text-xs text-muted-foreground mb-2">One line per punch: <span className="font-mono">biometric_user_id,YYYY-MM-DD HH:MM:SS</span></p>
          <div className="flex items-center gap-2 mb-2">
            <select className="h-8 rounded-md border border-input bg-background px-2 text-sm" value={importDev} onChange={(e) => setImportDev(Number(e.target.value))}>
              <option value={0}>No device</option>
              {list.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
            </select>
            <Button size="sm" onClick={doImport}><Upload className="w-3.5 h-3.5 mr-1" /> Import</Button>
          </div>
          <textarea className="w-full h-20 rounded-md border border-input bg-background px-2 py-1 text-xs font-mono" placeholder={"101,2026-06-01 10:00:00\n101,2026-06-01 19:30:00"} value={csv} onChange={(e) => setCsv(e.target.value)} />
        </Card>
      </div>

      {/* Scan modal */}
      {scanOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={() => setScanOpen(false)}>
          <Card className="w-full max-w-lg" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between border-b border-border px-4 py-3">
              <div className="font-semibold flex items-center gap-2"><Radar className="w-4 h-4" /> Scan network for devices</div>
              <button onClick={() => setScanOpen(false)} className="rounded-md p-1 hover:bg-accent"><X className="w-4 h-4" /></button>
            </div>
            <div className="p-4 space-y-3">
              <div className="flex items-end gap-2">
                <div className="flex-1"><label className="text-xs text-muted-foreground">Subnet base (blank = auto-detect)</label><Input placeholder="192.168.1" value={scanBase} onChange={(e) => setScanBase(e.target.value)} /></div>
                <div><label className="text-xs text-muted-foreground">Port</label><Input className="w-24" inputMode="numeric" value={scanPort} onChange={(e) => setScanPort(Number(e.target.value))} /></div>
                <Button size="sm" onClick={runScan} disabled={scanning}>{scanning ? <><Loader2 className="w-4 h-4 mr-1 animate-spin" /> Scanning…</> : "Scan"}</Button>
              </div>
              {scan && (
                <div>
                  <div className="text-xs text-muted-foreground mb-1">Scanned {scan.base}.1–254 on port {scan.port} · {scan.found.length} device(s) responding</div>
                  <div className="rounded-md border border-border divide-y divide-border max-h-64 overflow-auto">
                    {scan.found.length === 0 && <div className="px-3 py-6 text-center text-sm text-muted-foreground">Nothing responded on port {scan.port}. Check the device is powered, on this LAN, and that this port is correct.</div>}
                    {scan.found.map((f) => (
                      <div key={f.ip} className="flex items-center justify-between px-3 py-2 text-sm">
                        <span className="flex items-center gap-2"><CheckCircle2 className="w-4 h-4 text-emerald-500" /> <span className="font-mono">{f.ip}</span> <span className="text-xs text-muted-foreground">{f.ms} ms</span></span>
                        {f.registered ? <span className="text-xs text-muted-foreground">already added</span> : <Button size="sm" variant="outline" onClick={() => addFromScan(f.ip)}>Add</Button>}
                      </div>
                    ))}
                  </div>
                </div>
              )}
              {!scan && !scanning && <div className="text-xs text-muted-foreground flex items-center gap-1"><XCircle className="w-3.5 h-3.5" /> This probes every host on your LAN for the biometric port — safe on your own network.</div>}
            </div>
          </Card>
        </div>
      )}

      {/* Add / edit modal */}
      {editing && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={() => setEditing(null)}>
          <Card className="w-full max-w-md" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between border-b border-border px-4 py-3">
              <div className="font-semibold">{editing.id ? "Edit device" : "Add device"}</div>
              <button onClick={() => setEditing(null)} className="rounded-md p-1 hover:bg-accent"><X className="w-4 h-4" /></button>
            </div>
            <div className="p-4 grid grid-cols-2 gap-3">
              <div className="col-span-2"><label className="text-xs text-muted-foreground">Name</label><Input value={editing.body.name} onChange={(e) => setEditing({ ...editing, body: { ...editing.body, name: e.target.value } })} /></div>
              <div><label className="text-xs text-muted-foreground">Brand</label>
                <select className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm" value={editing.body.brand} onChange={(e) => setEditing({ ...editing, body: { ...editing.body, brand: e.target.value } })}>
                  <option value="zkteco">ZKTeco</option><option value="essl">eSSL</option><option value="cpplus">CP Plus</option><option value="other">Other</option>
                </select>
              </div>
              <div><label className="text-xs text-muted-foreground">Port</label><Input inputMode="numeric" value={editing.body.port ?? 4370} onChange={(e) => setEditing({ ...editing, body: { ...editing.body, port: Number(e.target.value) } })} /></div>
              <div><label className="text-xs text-muted-foreground">IP address</label><Input value={editing.body.ip ?? ""} placeholder="192.168.1.201" onChange={(e) => setEditing({ ...editing, body: { ...editing.body, ip: e.target.value } })} /></div>
              <div><label className="text-xs text-muted-foreground">Serial no.</label><Input value={editing.body.serial_no ?? ""} onChange={(e) => setEditing({ ...editing, body: { ...editing.body, serial_no: e.target.value } })} /></div>
              <label className="col-span-2 flex items-center gap-2 text-sm"><input type="checkbox" checked={editing.body.enabled ?? true} onChange={(e) => setEditing({ ...editing, body: { ...editing.body, enabled: e.target.checked } })} /> Enabled</label>
            </div>
            <div className="flex justify-end gap-2 border-t border-border px-4 py-3">
              <Button variant="ghost" size="sm" onClick={() => setEditing(null)}>Cancel</Button>
              <Button size="sm" onClick={save}>Save</Button>
            </div>
          </Card>
        </div>
      )}
    </div>
  );
}
