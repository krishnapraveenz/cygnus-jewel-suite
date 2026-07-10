# Glossary

Plain-language definitions of every trade term used in the app. The **In-app label** is
what users see; the **Meaning** is the explanation; **Notes** covers gotchas.

## Sales & ownership terms

### On Approval (take-home trial) — B2C
- **In-app label:** "On Approval" (alias shown on hover: "Take-Home Trial")
- **Meaning:** A piece a retail customer takes home to decide on. It is **not sold**, no
  payment is taken, and **you still own it**. Tracked with a return-by date.
- **Notes:** This is NOT an invoice. It produces only an **Approval Slip** (an
  acknowledgement of what left and when it is due back). A real tax invoice is generated
  **only if** the customer decides to buy. "Memo" is kept as a hidden search alias.

### Sale or Return — B2B
- **In-app label:** "Sale or Return"
- **Meaning:** Goods sent to another retailer to try to sell. **Title stays with you**
  until they sell or buy them. Common terms: 30/60/90 days.
- **Notes:** Not counted as a sale or revenue until invoiced. Produces a delivery note,
  not a tax invoice. This is the wholesale equivalent of the US trade term "memo".

### B2B Sales Invoice — B2B
- **In-app label:** "B2B Sales Invoice"
- **Meaning:** An outright sale to another jeweller/retailer. Ownership transfers
  immediately; a GST tax invoice is generated; revenue is recognized.
- **Notes:** Supports trade/tiered pricing, credit terms, and e-Way bills.

### Consignment
- **Meaning:** Longer-term goods placed with a partner who sells them and remits the
  proceeds. A longer-horizon variant of Sale or Return.

### Memo / Memorandum
- **Meaning:** US trade slang for goods delivered with title retained. We avoid this term
  in the UI in favour of "On Approval" / "Sale or Return", but keep it as a search alias.

## Metal & weight terms

| Term | Meaning |
|---|---|
| **Gross weight** | Total weight of a piece including stones and findings. |
| **Net weight** | Metal-only weight (gross minus stones and non-metal parts). |
| **Karat (K)** | Gold purity in 24ths. 22K = 22/24 pure. Used for gold. |
| **Fineness** | Purity as parts per 1000 (e.g., 916 = 91.6% = 22K). |
| **Tola** | Traditional weight unit (~11.6638 g). Supported alongside grams. |
| **Carat (ct)** | Weight unit for gemstones (1 ct = 0.2 g). Do not confuse with karat. |
| **Ratti** | Traditional Indian gemstone unit (≈ 0.911 ct ≈ 0.182 g; value configurable). |
| **Fineness grade** | Purity expressed per 1000, e.g., fine gold **999.9 / 995**, silver **999 / 925**. |
| **Per-gram-per-karat rate** | India default: a separate per-gram rate is set manually for each purity (24K/22K/18K…); rates are independent, not derived from one another. |
| **Stone pricing unit** | How a stone is priced: **per carat** (diamonds/most stones), **per gram** (some coloured stones), **per piece** (melee/fixed), or **per ratti**. |
| **Making charge** | Labour/craftsmanship charge — per-gram, %, flat, or slab. |
| **Wastage** | Allowance for metal lost in making, charged to the customer. |
| **Scrap lot** | Stock created from old gold taken in exchange; raw material. |

## Compliance terms

| Term | Meaning |
|---|---|
| **HUID** | Hallmark Unique Identification — 6-digit alphanumeric code on each hallmarked gold piece, linked to the BIS database. Mandatory in India since 1 Apr 2023. |
| **BIS** | Bureau of Indian Standards — runs the hallmarking scheme. |
| **GST** | Goods and Services Tax — split into CGST/SGST (intrastate) or IGST (interstate). |
| **HSN** | Harmonized System Nomenclature — product tax-classification code. |
| **e-Invoice (IRN)** | Government-registered invoice carrying an Invoice Reference Number + QR. |
| **e-Way bill** | Document required for movement of goods above a threshold value. |
| **IRP** | Invoice Registration Portal (run by NIC) that validates an invoice and returns the IRN + QR. We integrate with it **directly**. |
| **Direct NIC integration** | We connect straight to the government NIC e-invoice (IRP) and e-Way bill APIs — **no GSP** (GST Suvidha Provider) middleman. |

## Certification terms

| Term | Meaning |
|---|---|
| **GIA / IGI / EGL** | Gemological labs that certify diamonds/stones. |
| **4C** | Cut, Colour, Clarity, Carat — the grading attributes of a diamond. |
| **Certificate number** | The lab report ID stored on a stone's record. |

## Stock terms

> "Stock" is the term we use throughout (module **O3 Stock**). "Inventory" means the same
> thing and is kept here only so people searching for it find this page.

| Term | Meaning |
|---|---|
| **Serialized item** | A unique finished piece tracked as one record. |
| **Lot / parcel** | A quantity of loose stones or bulk metal tracked together. |
| **Parcel breaking** | Removing some stones from a lot; the system keeps weighted-average cost and carat accurate. |
| **Ownership state** | The current status of an item: In Stock / On Approval (Out) / Sale or Return (Out) / Received In / Sold / etc. |

## Staff, attendance & payroll terms

| Term | Meaning |
|---|---|
| **Biometric device** | A fingerprint/face attendance machine (eSSL, CP Plus, ZKTeco) on the shop LAN. |
| **ADMS / Push protocol** | Mode where the device **pushes** punch logs to the shop server over HTTP in real time (no port-forwarding). Preferred. |
| **Pull SDK** | Mode where the server **polls** the device over TCP **port 4370** to fetch logs (fallback). |
| **Punch / punch event** | A single in/out record from a device; stored immutably and deduplicated. |
| **Enrollment mapping** | Link between a device's user-id and a staff record. (Biometric templates stay on the device.) |
| **Shift / roster** | Defined work timing and the assignment of shifts/weekly-offs to staff. |
| **Regularization** | A manager-approved correction to attendance (e.g., a missed punch). |
| **Muster / attendance register** | The consolidated attendance sheet for a period. |
| **LOP (loss of pay)** | Salary deduction for unpaid absence. |
| **Payroll run** | The monthly process that turns attendance + salary structure into payslips. |
| **Payslip** | A staff member's salary statement for a period. |
| **PF / ESI / PT / TDS** | Indian statutory deductions: Provident Fund / Employees' State Insurance / Professional Tax / Tax Deducted at Source. |
| **Staff advance** | Money advanced to a staff member, auto-recovered from future salary. |
