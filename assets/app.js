const API = "https://shop-api.ntt-hub.workers.dev";

/* ================= API HELPERS ================= */

async function apiGet(url) {
  const r = await fetch(API + url, { credentials: "include" });
  return r.json();
}

async function apiPost(url, body) {
  const r = await fetch(API + url, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  return r.json();
}

/* ================= FORMAT ================= */

function formatPrice(cents) {
  if (cents == null || Number.isNaN(Number(cents))) return "0 đ";
  return (Number(cents) / 100).toLocaleString("vi-VN") + " đ";
}

function sanitizeNumberInput(value) {
  const n = Number(String(value).replace(/[^0-9.]/g, ""));
  return Number.isFinite(n) ? n : 0;
}

/* ================= SITE SETTINGS ================= */

/**
 * Tự load tên web + tagline
 * Admin sửa ở admin-settings là toàn site đổi theo
 */
async function loadSiteSettings() {
  try {
    const r = await fetch(API + "/api/settings/public", {
      cache: "no-store"
    }).then(r => r.json());

    if (!r || !r.ok || !r.settings) return;

    const name = r.settings.site_name;
    const tagline = r.settings.site_tagline;

    // Logo góc trái
    const brandLink = document.querySelector(".brand a");
    const brandSmall = document.querySelector(".brand small");

    if (brandLink && name) {
      brandLink.textContent = name;
      document.title = document.title.replace(/^SHOP/i, name);
    }

    if (brandSmall && tagline) {
      brandSmall.textContent = tagline;
    }
  } catch (e) {
    console.warn("Không load được site settings", e);
  }
}

/* ================= AUTO INIT ================= */

document.addEventListener("DOMContentLoaded", () => {
  loadSiteSettings();
});
