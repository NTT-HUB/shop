const API = "https://shop-api.ntt-hub.workers.dev";

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

function formatPrice(cents) {
  if (cents == null || Number.isNaN(Number(cents))) return "0 đ";
  return (Number(cents) / 100).toLocaleString("vi-VN") + " đ";
}

function sanitizeNumberInput(value) {
  const n = Number(String(value).replace(/[^0-9.]/g, ""));
  return Number.isFinite(n) ? n : 0;
}
