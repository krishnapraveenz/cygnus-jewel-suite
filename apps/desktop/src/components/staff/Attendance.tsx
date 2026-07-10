import { useEffect, useMemo, useState } from "react";
import { CalendarPlus, Trash2, Wand2 } from "lucide-react";
import * as api from "@/api";
import type { Staff, AttendanceRow, Holiday } from "@/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { DateField } from "@/components/ui/date-field";
import { MonthField } from "@/components/ui/month-field";
import { formatDate } from "@/lib/utils";

const CYCLE = ["present", "half_day", "absent", "leave", "week_off", "holiday"] as const;
const META: Record<string, { c: string; cls: string }> = {
  present: { c: "P", cls: "bg-emerald-500/15 text-emerald-600" },
  half_day: { c: "½", cls: "bg-amber-500/15 text-amber-600" },
  absent: { c: "A", cls: "bg-red-500/15 text-red-600" },
  leave: { c: "L", cls: "bg-sky-500/15 text-sky-600" },
  week_off: { c: "W", cls: "bg-slate-400/15 text-slate-500" },
  holiday: { c: "H", cls: "bg-violet-500/15 text-violet-600" },
};
const thisMonth = () => new Date().toISOString().slice(0, 7);
const dim = (m: string) => { const [y, mo] = m.split("-").map(Number); return new Date(y, mo, 0).getDate(); };

export function Attendance() {
  const [month, setMonth] = useState(thisMonth());
  const [staff, setStaff] = useState<Staff[]>([]);
  const [rows, setRows] = useState<AttendanceRow[]>([]);
  const [holidays, setHolidays] = useState<Holiday[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [showHol, setShowHol] = useState(false);
  const [holDay, setHolDay] = useState("");
  const [holName, setHolName] = useState("");
  const [cfg, setCfg] = useState<Record<string, string>>({});

  async function saveCfg(key: string, value: string) {
    try { await api.setSetting(key, value); setCfg((c) => ({ ...c, [key]: value })); } catch (e) { setError(String(e instanceof Error ? e.message : e)); }
  }
  useEffect(() => { api.getSettings().then(setCfg).catch(() => {}); }, []);

  async function load() {
    try {
      const [st, at, hol] = await Promise.all([api.listStaff(), api.listAttendance(month), api.listHolidays(month)]);
      setStaff(st.filter((s) => s.status === "active"));
      setRows(at);
      setHolidays(hol);
    } catch (e) { setError(String(e instanceof Error ? e.message : e)); }
  }
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [month]);

  async function fill() {
    setMsg(null); setError(null);
    try { const r = await api.fillCalendar(month); setMsg(`Marked ${r.holidays_marked} holiday + ${r.week_offs_marked} week-off entries`); await load(); }
    catch (e) { setError(String(e instanceof Error ? e.message : e)); }
  }
  async function addHoliday() {
    if (!holDay || !holName.trim()) return;
    try { await api.createHoliday(holDay, holName); setHolDay(""); setHolName(""); await load(); }
    catch (e) { setError(String(e instanceof Error ? e.message : e)); }
  }
  async function delHoliday(id: number) {
    try { await api.deleteHoliday(id); await load(); } catch (e) { setError(String(e instanceof Error ? e.message : e)); }
  }

  const map = useMemo(() => {
    const m = new Map<string, string>();
    for (const r of rows) m.set(`${r.staff_id}-${r.day}`, r.status);
    return m;
  }, [rows]);

  const days = Array.from({ length: dim(month) }, (_, i) => i + 1);
  const dow = (d: number) => new Date(`${month}-${String(d).padStart(2, "0")}T00:00:00`).getDay();

  async function cycle(staffId: number, d: number) {
    const day = `${month}-${String(d).padStart(2, "0")}`;
    const cur = map.get(`${staffId}-${day}`);
    const idx = CYCLE.indexOf(cur as typeof CYCLE[number]);
    const next = CYCLE[(idx + 1) % CYCLE.length];
    setRows((xs) => {
      const others = xs.filter((r) => !(r.staff_id === staffId && r.day === day));
      return [...others, { id: 0, staff_id: staffId, staff_name: "", day, status: next, check_in: null, check_out: null, hours: "0", source: "manual", note: null }];
    });
    try { await api.markAttendance({ staff_id: staffId, day, status: next }); } catch (e) { setError(String(e instanceof Error ? e.message : e)); }
  }

  function count(staffId: number, status: string) {
    return days.filter((d) => map.get(`${staffId}-${month}-${String(d).padStart(2, "0")}`) === status).length;
  }

  // Right-click a cell to clear (unset) it.
  async function clearCell(staffId: number, d: number) {
    const day = `${month}-${String(d).padStart(2, "0")}`;
    setRows((xs) => xs.filter((r) => !(r.staff_id === staffId && r.day === day)));
    try { await api.markAttendance({ staff_id: staffId, day, status: "clear" }); } catch (e) { setError(String(e instanceof Error ? e.message : e)); }
  }

  // Click a date header → mark every not-yet-marked staff present for that day (fast daily entry).
  async function markDayPresent(d: number) {
    const day = `${month}-${String(d).padStart(2, "0")}`;
    const toMark = staff.filter((s) => !map.get(`${s.id}-${day}`));
    if (toMark.length === 0) { setMsg("Everyone is already marked for that day."); return; }
    setRows((xs) => [...xs, ...toMark.map((s) => ({ id: 0, staff_id: s.id, staff_name: "", day, status: "present", check_in: null, check_out: null, hours: "0", source: "manual", note: null }))]);
    try { await Promise.all(toMark.map((s) => api.markAttendance({ staff_id: s.id, day, status: "present" }))); setMsg(`Marked ${toMark.length} present on ${formatDate(day)}.`); }
    catch (e) { setError(String(e instanceof Error ? e.message : e)); }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-semibold">Attendance</h2>
          <p className="text-sm text-muted-foreground">Click a cell to cycle P → ½ → A → L → W → H · right-click to clear · click a date header to mark all present. Device/imported punches fill automatically.</p>
        </div>
        <div className="flex items-center gap-2">
          <Button size="sm" variant="outline" onClick={() => setShowHol((v) => !v)}><CalendarPlus className="w-3.5 h-3.5 mr-1" /> Holidays</Button>
          <Button size="sm" variant="outline" onClick={fill} title="Mark week-offs & holidays for the month"><Wand2 className="w-3.5 h-3.5 mr-1" /> Fill offs</Button>
          <MonthField value={month} onChange={setMonth} />
        </div>
      </div>

      {error && <div className="rounded-md bg-destructive/10 text-destructive px-3 py-2 text-sm">{error}</div>}
      {msg && <div className="rounded-md bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 px-3 py-2 text-sm">{msg}</div>}

      {showHol && (
        <div className="rounded-lg border border-border p-3 space-y-2">
          <div className="text-sm font-medium">Holidays — {month}</div>
          <div className="flex items-center gap-2">
            <DateField value={holDay} onChange={setHolDay} />
            <Input className="w-56" placeholder="Holiday name" value={holName} onChange={(e) => setHolName(e.target.value)} />
            <Button size="sm" onClick={addHoliday}>Add</Button>
          </div>
          <div className="flex flex-wrap gap-2">
            {holidays.map((h) => (
              <span key={h.id} className="inline-flex items-center gap-1 rounded-full bg-violet-500/10 text-violet-700 dark:text-violet-300 px-2 py-0.5 text-xs">
                {formatDate(h.day)} · {h.name}
                <button className="hover:text-destructive" onClick={() => delHoliday(h.id)}><Trash2 className="w-3 h-3" /></button>
              </span>
            ))}
            {holidays.length === 0 && <span className="text-xs text-muted-foreground">No holidays this month.</span>}
          </div>
          <div className="border-t border-border pt-2 mt-1">
            <div className="text-sm font-medium mb-1">Shift rules (device attendance)</div>
            <div className="flex items-end gap-3 text-sm flex-wrap">
              <div><label className="text-xs text-muted-foreground">Work start (HH:MM)</label><Input className="w-28" defaultValue={cfg["attendance.work_start"] ?? "10:00"} onBlur={(e) => saveCfg("attendance.work_start", e.target.value)} /></div>
              <div><label className="text-xs text-muted-foreground">Half-day under (hrs)</label><Input className="w-24" defaultValue={cfg["attendance.half_day_hours"] ?? "4"} onBlur={(e) => saveCfg("attendance.half_day_hours", e.target.value)} /></div>
              <div><label className="text-xs text-muted-foreground">Late grace (min)</label><Input className="w-24" defaultValue={cfg["attendance.late_grace_min"] ?? "15"} onBlur={(e) => saveCfg("attendance.late_grace_min", e.target.value)} /></div>
            </div>
          </div>
        </div>
      )}

      <div className="flex items-center gap-3 text-xs text-muted-foreground">
        {Object.entries(META).map(([k, v]) => <span key={k} className="flex items-center gap-1"><span className={`inline-flex w-5 h-5 items-center justify-center rounded ${v.cls} font-medium`}>{v.c}</span>{k.replace("_", " ")}</span>)}
      </div>

      <div className="rounded-lg border border-border overflow-x-auto">
        <table className="text-xs border-collapse">
          <thead>
            <tr className="bg-muted/50">
              <th className="sticky left-0 bg-muted/50 text-left px-3 py-2 font-medium min-w-[150px] z-10">Staff</th>
              {days.map((d) => (
                <th key={d} className={`px-0 py-2 w-7 text-center font-medium ${[0, 6].includes(dow(d)) ? "text-red-500" : "text-muted-foreground"}`}>
                  <button onClick={() => markDayPresent(d)} title="Mark all present this day" className="w-full hover:text-emerald-600">{d}</button>
                </th>
              ))}
              <th className="px-2 py-2 text-center font-medium border-l border-border">P</th>
              <th className="px-2 py-2 text-center font-medium">A</th>
              <th className="px-2 py-2 text-center font-medium">L</th>
              <th className="px-2 py-2 text-center font-medium" title="Week-off + holiday">Off</th>
              <th className="px-2 py-2 text-center font-medium" title="Payable days = present + ½·half + leave + week-off + holiday">Pay</th>
              <th className="px-2 py-2 text-center font-medium">%</th>
            </tr>
          </thead>
          <tbody>
            {staff.length === 0 && <tr><td colSpan={days.length + 7} className="px-3 py-8 text-center text-muted-foreground">No active staff.</td></tr>}
            {staff.map((s) => (
              <tr key={s.id} className="border-t border-border">
                <td className="sticky left-0 bg-card px-3 py-1.5 font-medium z-10">{s.name}<span className="text-muted-foreground font-normal"> · {s.code}</span></td>
                {days.map((d) => {
                  const st = map.get(`${s.id}-${month}-${String(d).padStart(2, "0")}`);
                  const m = st ? META[st] : null;
                  return (
                    <td key={d} className="p-0.5 text-center">
                      <button onClick={() => cycle(s.id, d)} onContextMenu={(e) => { e.preventDefault(); clearCell(s.id, d); }} title="Click to cycle · right-click to clear" className={`w-6 h-6 rounded text-[11px] font-medium ${m ? m.cls : "hover:bg-accent text-muted-foreground"}`}>{m ? m.c : "·"}</button>
                    </td>
                  );
                })}
                {(() => {
                  const pr = count(s.id, "present"); const hf = count(s.id, "half_day");
                  const ab = count(s.id, "absent"); const lv = count(s.id, "leave");
                  const off = count(s.id, "week_off") + count(s.id, "holiday");
                  const present = pr + hf * 0.5;
                  const payable = present + lv + off;
                  const denom = pr + hf + ab + lv;
                  return (<>
                    <td className="px-2 text-center font-semibold border-l border-border">{present}</td>
                    <td className="px-2 text-center text-red-600">{ab || "—"}</td>
                    <td className="px-2 text-center text-sky-600">{lv || "—"}</td>
                    <td className="px-2 text-center text-muted-foreground">{off || "—"}</td>
                    <td className="px-2 text-center font-semibold">{payable}</td>
                    <td className="px-2 text-center text-muted-foreground">{denom > 0 ? `${Math.round((present / denom) * 100)}%` : "—"}</td>
                  </>);
                })()}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
