const express = require("express");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const https = require("https");

const app = express();
const PORT = process.env.PORT || 4400;

// ─── Config ────────────────────────────────────────────────────────────────
const GITHUB_TOKEN = process.env.GITHUB_UPDATE_TOKEN || "";
const GITHUB_REPO = process.env.GITHUB_UPDATE_REPO || "krishnapraveenz/cygnus-jewel-suite";
const LICENSE_SECRET = process.env.LICENSE_SECRET || "cygnus-jewel-2026-secret-key";
const DATA_DIR = path.join(__dirname, "..", "data");

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
const LICENSES_FILE = path.join(DATA_DIR, "licenses.json");

// ─── Middleware ────────────────────────────────────────────────────────────
app.use(express.json());
app.use(express.static(path.join(__dirname, "..", "public")));

// ─── License helpers ───────────────────────────────────────────────────────

function loadLicenses() {
  if (!fs.existsSync(LICENSES_FILE)) return [];
  return JSON.parse(fs.readFileSync(LICENSES_FILE, "utf8"));
}

function saveLicenses(licenses) {
  fs.writeFileSync(LICENSES_FILE, JSON.stringify(licenses, null, 2));
}

function generateLicenseKey() {
  const seg = () => crypto.randomBytes(2).toString("hex").toUpperCase();
  return `CYG-${seg()}-${seg()}-${seg()}-${seg()}`;
}

function signLicense(payload) {
  const hmac = crypto.createHmac("sha256", LICENSE_SECRET);
  hmac.update(JSON.stringify(payload));
  return hmac.digest("hex");
}

// ─── License API ───────────────────────────────────────────────────────────

app.post("/api/licenses/generate", (req, res) => {
  const adminKey = req.headers["x-admin-key"];
  if (adminKey !== LICENSE_SECRET) return res.status(401).json({ error: "Unauthorized" });

  const { licensee, email, max_terminals, expires_at, plan } = req.body;
  if (!licensee) return res.status(400).json({ error: "licensee is required" });

  const license = {
    id: crypto.randomUUID(),
    key: generateLicenseKey(),
    licensee,
    email: email || "",
    plan: plan || "standard",
    max_terminals: max_terminals || 3,
    expires_at: expires_at || null,
    created_at: new Date().toISOString(),
    activated: false,
    activations: [],
    revoked: false,
  };

  const licenses = loadLicenses();
  licenses.push(license);
  saveLicenses(licenses);
  res.json({ success: true, license });
});

app.post("/api/licenses/validate", (req, res) => {
  const { key, machine_id } = req.body;
  if (!key) return res.status(400).json({ error: "key is required" });

  const licenses = loadLicenses();
  const license = licenses.find((l) => l.key === key);

  if (!license) return res.status(404).json({ valid: false, error: "License key not found" });
  if (license.revoked) return res.status(403).json({ valid: false, error: "License has been revoked" });
  if (license.expires_at && new Date(license.expires_at) < new Date()) {
    return res.status(403).json({ valid: false, error: "License has expired" });
  }

  if (machine_id) {
    const existing = license.activations.find((a) => a.machine_id === machine_id);
    if (!existing && license.activations.length >= license.max_terminals) {
      return res.status(403).json({ valid: false, error: "Activation limit reached" });
    }
  }

  const payload = { licensee: license.licensee, plan: license.plan, max_terminals: license.max_terminals, expires_at: license.expires_at };
  res.json({ valid: true, license: payload, signature: signLicense(payload) });
});

app.post("/api/licenses/activate", (req, res) => {
  const { key, machine_id, machine_name } = req.body;
  if (!key || !machine_id) return res.status(400).json({ error: "key and machine_id are required" });

  const licenses = loadLicenses();
  const license = licenses.find((l) => l.key === key);

  if (!license) return res.status(404).json({ valid: false, error: "License key not found" });
  if (license.revoked) return res.status(403).json({ valid: false, error: "License has been revoked" });
  if (license.expires_at && new Date(license.expires_at) < new Date()) {
    return res.status(403).json({ valid: false, error: "License has expired" });
  }

  const existing = license.activations.find((a) => a.machine_id === machine_id);
  if (existing) {
    existing.last_seen = new Date().toISOString();
    saveLicenses(licenses);
    const payload = { licensee: license.licensee, plan: license.plan, max_terminals: license.max_terminals, expires_at: license.expires_at, machine_id };
    return res.json({ success: true, already_active: true, license: payload, signature: signLicense(payload) });
  }

  if (license.activations.length >= license.max_terminals) {
    return res.status(403).json({ error: "Activation limit reached", max: license.max_terminals });
  }

  license.activated = true;
  license.activations.push({ machine_id, machine_name: machine_name || "Unknown", activated_at: new Date().toISOString(), last_seen: new Date().toISOString() });
  saveLicenses(licenses);

  const payload = { licensee: license.licensee, plan: license.plan, max_terminals: license.max_terminals, expires_at: license.expires_at, machine_id };
  res.json({ success: true, license: payload, signature: signLicense(payload) });
});

app.post("/api/licenses/deactivate", (req, res) => {
  const { key, machine_id } = req.body;
  if (!key || !machine_id) return res.status(400).json({ error: "key and machine_id are required" });

  const licenses = loadLicenses();
  const license = licenses.find((l) => l.key === key);
  if (!license) return res.status(404).json({ error: "License key not found" });

  license.activations = license.activations.filter((a) => a.machine_id !== machine_id);
  if (license.activations.length === 0) license.activated = false;
  saveLicenses(licenses);
  res.json({ success: true, remaining_activations: license.activations.length });
});

app.get("/api/licenses", (req, res) => {
  const adminKey = req.headers["x-admin-key"];
  if (adminKey !== LICENSE_SECRET) return res.status(401).json({ error: "Unauthorized" });
  res.json(loadLicenses());
});

app.post("/api/licenses/:id/revoke", (req, res) => {
  const adminKey = req.headers["x-admin-key"];
  if (adminKey !== LICENSE_SECRET) return res.status(401).json({ error: "Unauthorized" });

  const licenses = loadLicenses();
  const license = licenses.find((l) => l.id === req.params.id);
  if (!license) return res.status(404).json({ error: "Not found" });

  license.revoked = true;
  saveLicenses(licenses);
  res.json({ success: true });
});

// ─── OTA Update Proxy ──────────────────────────────────────────────────────

function httpsFetch(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const options = {
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      method: "GET",
      headers: {
        "User-Agent": "Cygnus-Update-Server/1.0",
        ...headers,
      },
    };

    const req = https.request(options, (resp) => {
      if (resp.statusCode >= 300 && resp.statusCode < 400 && resp.headers.location) {
        return httpsFetch(resp.headers.location, headers).then(resolve).catch(reject);
      }
      let data = [];
      resp.on("data", (chunk) => data.push(chunk));
      resp.on("end", () => {
        const body = Buffer.concat(data).toString("utf8");
        resolve({ status: resp.statusCode, body, headers: resp.headers });
      });
    });
    req.on("error", reject);
    req.setTimeout(20000, () => { req.destroy(); reject(new Error("timeout")); });
    req.end();
  });
}

app.get("/api/update/:target/:arch/:current_version", async (req, res) => {
  try {
    const { target, arch, current_version } = req.params;

    // Fetch latest release from GitHub
    const ghHeaders = {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    };
    if (GITHUB_TOKEN) ghHeaders.Authorization = `Bearer ${GITHUB_TOKEN}`;

    const releaseResp = await httpsFetch(
      `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`,
      ghHeaders
    );

    if (releaseResp.status !== 200) {
      console.error("[update] GitHub API returned", releaseResp.status);
      return res.status(204).end();
    }

    const release = JSON.parse(releaseResp.body);
    const latestAsset = (release.assets || []).find((a) => a.name === "latest.json");
    if (!latestAsset) {
      console.error("[update] No latest.json in release");
      return res.status(204).end();
    }

    // Download latest.json via browser_download_url (works for public repos)
    // For private repos, use the API asset URL with octet-stream accept
    let latestBody;
    if (release.html_url && !release.html_url.includes("/private/")) {
      // Public repo - use browser_download_url directly
      const dlResp = await httpsFetch(latestAsset.browser_download_url, {});
      latestBody = dlResp.body;
    } else {
      // Private repo - use API with token
      const dlResp = await httpsFetch(latestAsset.url, {
        ...ghHeaders,
        Accept: "application/octet-stream",
      });
      latestBody = dlResp.body;
    }

    const latest = JSON.parse(latestBody);

    // Version comparison
    const latestVersion = (latest.version || "0.0.0").replace(/^v/, "");
    const currentVersion = current_version.replace(/^v/, "");

    const parse = (v) => v.split(".").map(Number);
    const [lM, lm, lp] = parse(latestVersion);
    const [cM, cm, cp] = parse(currentVersion);
    const isNewer = lM > cM || (lM === cM && lm > cm) || (lM === cM && lm === cm && lp > cp);

    if (!isNewer) {
      return res.status(204).end();
    }

    // Find platform
    // Tauri sends target=windows-x86_64, arch=x86_64 but latest.json key is just "windows-x86_64"
    const platformKey = `${target}-${arch}`;
    const platformKeyShort = target; // fallback: target already contains arch
    const platform = latest.platforms?.[platformKey] || latest.platforms?.[platformKeyShort];
    if (!platform || !platform.signature || !platform.url) {
      console.error("[update] No platform for", platformKey);
      return res.status(204).end();
    }

    res.json({
      version: latestVersion,
      url: platform.url,
      signature: platform.signature,
      notes: latest.notes || "",
      pub_date: latest.pub_date || "",
    });
  } catch (err) {
    console.error("[update] Error:", err.message);
    res.status(204).end();
  }
});

// ─── Health ────────────────────────────────────────────────────────────────
app.get("/api/health", (req, res) => {
  res.json({ status: "ok", service: "cygnus-jewel-suite-web", time: new Date().toISOString() });
});

// ─── Catch-all: serve landing page ────────────────────────────────────────
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "..", "public", "index.html"));
});

// ─── Start ─────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`[cygnus-web] Running on port ${PORT}`);
  console.log(`[cygnus-web] GitHub repo: ${GITHUB_REPO}`);
  console.log(`[cygnus-web] GitHub token: ${GITHUB_TOKEN ? "configured" : "NOT SET"}`);
});
