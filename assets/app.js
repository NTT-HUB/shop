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
