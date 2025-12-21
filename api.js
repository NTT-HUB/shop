export interface Env {
  DB: D1Database;
  SESSION_MAX_AGE_SEC: string;
  PASSWORD_PEPPER: string; // secret
}

type Json = Record<string, any>;

function json(data: Json, status = 200, extraHeaders: Record<string, string> = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...extraHeaders,
    },
  });
}

function bad(message: string, status = 400) {
  return json({ ok: false, error: message }, status);
}

function ok(data: Json = {}) {
  return json({ ok: true, ...data });
}

function getCookie(req: Request, name: string): string | null {
  const cookie = req.headers.get("Cookie") || "";
  const m = cookie.match(new RegExp(`(?:^|; )${name}=([^;]+)`));
  return m ? decodeURIComponent(m[1]) : null;
}

function setCookie(name: string, value: string, maxAgeSec: number) {
  // HttpOnly + Secure + SameSite=Lax
  return `${name}=${encodeURIComponent(value)}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${maxAgeSec}`;
}

function clearCookie(name: string) {
  return `${name}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`;
}

function corsHeaders(req: Request) {
  const origin = req.headers.get("Origin") || "*";
  // Nếu bạn dùng frontend cùng domain thì có thể set cụ thể origin.
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Credentials": "true",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET,POST,PATCH,DELETE,OPTIONS",
  };
}

function ipPrefixFromReq(req: Request): string {
  const ip = req.headers.get("cf-connecting-ip") || "";
  // IPv4 prefix a.b.c ; nếu ipv6 thì lưu nguyên (hoặc cắt prefix)
  if (ip.includes(".")) return ip.split(".").slice(0, 3).join(".");
  return ip; // ipv6: bạn có thể cắt prefix sau
}

async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ===== Password hashing (PBKDF2) =====
// Worker không có bcrypt builtin ổn định, PBKDF2 là lựa chọn đủ dùng cho MVP.
// format: pbkdf2$iter$saltB64$hashB64
const PBKDF2_ITER = 120_000;
const KEY_LEN = 32;

function b64(bytes: ArrayBuffer) {
  const arr = new Uint8Array(bytes);
  let s = "";
  for (const b of arr) s += String.fromCharCode(b);
  return btoa(s);
}
function unb64(s: string) {
  const bin = atob(s);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return arr.buffer;
}

async function pbkdf2(password: string, salt: Uint8Array, iterations: number): Promise<ArrayBuffer> {
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  return crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations, hash: "SHA-256" },
    keyMaterial,
    KEY_LEN * 8
  );
}

async function hashPassword(password: string, pepper: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const derived = await pbkdf2(password + pepper, salt, PBKDF2_ITER);
  return `pbkdf2$${PBKDF2_ITER}$${b64(salt.buffer)}$${b64(derived)}`;
}

async function verifyPassword(password: string, stored: string, pepper: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 4 || parts[0] !== "pbkdf2") return false;
  const iter = parseInt(parts[1], 10);
  const salt = new Uint8Array(unb64(parts[2]));
  const expected = new Uint8Array(unb64(parts[3]));
  const derived = new Uint8Array(await pbkdf2(password + pepper, salt, iter));
  // constant-time compare
  if (derived.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < derived.length; i++) diff |= derived[i] ^ expected[i];
  return diff === 0;
}

// ===== Auth helpers =====
async function getUserFromSession(req: Request, env: Env): Promise<{ userId: string; role: string } | null> {
  const token = getCookie(req, "session");
  if (!token) return null;

  const tokenHash = await sha256Hex(token);
  const session = await env.DB.prepare(
    "SELECT user_id, ua_hash, ip_prefix, expires_at FROM sessions WHERE token_hash=?"
  )
    .bind(tokenHash)
    .first<{ user_id: string; ua_hash: string; ip_prefix: string; expires_at: number }>();

  if (!session) return null;
  if (session.expires_at < Date.now()) return null;

  const ua = req.headers.get("user-agent") || "";
  const uaHash = await sha256Hex(ua);
  if (session.ua_hash && uaHash !== session.ua_hash) return null;

  // IP prefix check (mềm): nếu khác thì vẫn cho qua? MVP: chặn.
  const ipPrefix = ipPrefixFromReq(req);
  if (session.ip_prefix && ipPrefix !== session.ip_prefix) return null;

  const user = await env.DB.prepare("SELECT id, role, status FROM users WHERE id=?")
    .bind(session.user_id)
    .first<{ id: string; role: string; status: string }>();

  if (!user || user.status !== "active") return null;

  // update last_seen (best effort)
  env.DB.prepare("UPDATE sessions SET last_seen_at=? WHERE token_hash=?").bind(Date.now(), tokenHash).run().catch(() => {});

  return { userId: user.id, role: user.role };
}

async function requireAuth(req: Request, env: Env) {
  const u = await getUserFromSession(req, env);
  if (!u) return null;
  return u;
}

async function requireAdmin(req: Request, env: Env) {
  const u = await getUserFromSession(req, env);
  if (!u || u.role !== "admin") return null;
  return u;
}

// ===== Utilities =====
function uuid() {
  return crypto.randomUUID();
}

async function readJson(req: Request) {
  try {
    return await req.json();
  } catch {
    return null;
  }
}

// =========================================
// Routes
// =========================================
export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    // CORS preflight
    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(req) });
    }

    const url = new URL(req.url);
    const path = url.pathname;

    // Add CORS headers to every response
    const withCors = (res: Response) => {
      const h = new Headers(res.headers);
      const cors = corsHeaders(req);
      Object.entries(cors).forEach(([k, v]) => h.set(k, v));
      return new Response(res.body, { status: res.status, headers: h });
    };

    try {
      // Health
      if (path === "/api/health") {
        return withCors(ok({ ts: Date.now() }));
      }

      // ----------------------------
      // AUTH
      // ----------------------------
      if (path === "/api/auth/register" && req.method === "POST") {
        const body = await readJson(req);
        if (!body) return withCors(bad("Invalid JSON"));

        const { username, email, phone, password } = body;
        if (!username || !email || !password) return withCors(bad("Missing fields"));
        if (String(password).length < 6) return withCors(bad("Password too short"));

        const now = Date.now();
        const id = uuid();
        const password_hash = await hashPassword(String(password), env.PASSWORD_PEPPER);

        // Insert user
        try {
          await env.DB.prepare(
            `INSERT INTO users (id, username, email, phone, password_hash, role, status, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, 'user', 'active', ?, ?)`
          )
            .bind(id, String(username), String(email), phone ? String(phone) : null, password_hash, now, now)
            .run();

          // Create wallet
          await env.DB.prepare(
            `INSERT INTO wallets (user_id, balance_cents, updated_at) VALUES (?, 0, ?)`
          )
            .bind(id, now)
            .run();
        } catch (e: any) {
          return withCors(bad("Username/email/phone already exists", 409));
        }

        return withCors(ok({ user_id: id }));
      }

      if (path === "/api/auth/login" && req.method === "POST") {
        const body = await readJson(req);
        if (!body) return withCors(bad("Invalid JSON"));

        const { username, password } = body;
        if (!username || !password) return withCors(bad("Missing fields"));

        const user = await env.DB.prepare(
          "SELECT id, password_hash, status, role FROM users WHERE username=?"
        )
          .bind(String(username))
          .first<{ id: string; password_hash: string; status: string; role: string }>();

        if (!user || user.status !== "active") return withCors(bad("Invalid credentials", 401));
        const okPw = await verifyPassword(String(password), user.password_hash, env.PASSWORD_PEPPER);
        if (!okPw) return withCors(bad("Invalid credentials", 401));

        const token = uuid() + uuid();
        const tokenHash = await sha256Hex(token);
        const ua = req.headers.get("user-agent") || "";
        const uaHash = await sha256Hex(ua);
        const ipPrefix = ipPrefixFromReq(req);

        const now = Date.now();
        const maxAge = parseInt(env.SESSION_MAX_AGE_SEC || "2592000", 10);
        const expires = now + maxAge * 1000;

        // (optional) giới hạn số session/user: xoá session cũ
        await env.DB.prepare("DELETE FROM sessions WHERE user_id=?").bind(user.id).run();

        await env.DB.prepare(
          `INSERT INTO sessions (id, user_id, token_hash, ua_hash, ip_prefix, created_at, last_seen_at, expires_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        )
          .bind(uuid(), user.id, tokenHash, uaHash, ipPrefix, now, now, expires)
          .run();

        const headers: Record<string, string> = {
          "Set-Cookie": setCookie("session", token, maxAge),
        };
        return withCors(json({ ok: true }, 200, headers));
      }

      if (path === "/api/auth/logout" && req.method === "POST") {
        const token = getCookie(req, "session");
        if (token) {
          const tokenHash = await sha256Hex(token);
          await env.DB.prepare("DELETE FROM sessions WHERE token_hash=?").bind(tokenHash).run();
        }
        return withCors(json({ ok: true }, 200, { "Set-Cookie": clearCookie("session") }));
      }

      if (path === "/api/me" && req.method === "GET") {
        const u = await requireAuth(req, env);
        if (!u) return withCors(bad("Unauthorized", 401));

        const user = await env.DB.prepare(
          "SELECT id, username, email, phone, role, status, reputation, total_deposit_cents, created_at FROM users WHERE id=?"
        )
          .bind(u.userId)
          .first();

        const wallet = await env.DB.prepare("SELECT balance_cents FROM wallets WHERE user_id=?")
          .bind(u.userId)
          .first<{ balance_cents: number }>();

        return withCors(ok({ user, balance_cents: wallet?.balance_cents ?? 0 }));
      }

      // ----------------------------
      // LISTINGS
      // ----------------------------
      if (path === "/api/listings" && req.method === "GET") {
        const kind = url.searchParams.get("kind");
        const q = url.searchParams.get("q");
        const limit = Math.min(parseInt(url.searchParams.get("limit") || "20", 10), 50);
        const offset = Math.max(parseInt(url.searchParams.get("offset") || "0", 10), 0);

        let sql = `SELECT l.*, u.username as seller_username, u.reputation as seller_reputation
                   FROM listings l JOIN users u ON u.id=l.seller_id
                   WHERE l.status='active'`;
        const binds: any[] = [];

        if (kind && (kind === "product" || kind === "ac")) {
          sql += ` AND l.kind=?`;
          binds.push(kind);
        }
        if (q) {
          sql += ` AND (l.title LIKE ? OR l.description LIKE ?)`;
          binds.push(`%${q}%`, `%${q}%`);
        }
        sql += ` ORDER BY l.created_at DESC LIMIT ? OFFSET ?`;
        binds.push(limit, offset);

        const rows = await env.DB.prepare(sql).bind(...binds).all();
        return withCors(ok({ items: rows.results ?? [], limit, offset }));
      }

      if (path === "/api/listings" && req.method === "POST") {
        const u = await requireAuth(req, env);
        if (!u) return withCors(bad("Unauthorized", 401));

        // check user status again (banned)
        const seller = await env.DB.prepare("SELECT status FROM users WHERE id=?").bind(u.userId).first<{status:string}>();
        if (!seller || seller.status !== "active") return withCors(bad("Account banned", 403));

        const body = await readJson(req);
        if (!body) return withCors(bad("Invalid JSON"));

        const { kind, title, description, price_cents, quantity, image_key, contact_link, ac_secret_txt } = body;
        if (!kind || !title || price_cents == null) return withCors(bad("Missing fields"));
        if (kind !== "product" && kind !== "ac") return withCors(bad("Invalid kind"));
        if (Number(price_cents) < 0) return withCors(bad("Invalid price"));
        const qty = quantity == null ? 1 : Number(quantity);
        if (qty < 0) return withCors(bad("Invalid quantity"));

        // (MVP) quota check: count active listings vs quota
        const quota = await computeQuota(env, u.userId);
        const used = await env.DB.prepare("SELECT COUNT(*) as c FROM listings WHERE seller_id=? AND status='active'")
          .bind(u.userId)
          .first<{ c: number }>();
        if ((used?.c ?? 0) >= quota) return withCors(bad(`Reached listing limit (${quota})`, 403));

        const now = Date.now();
        const id = uuid();

        await env.DB.prepare(
          `INSERT INTO listings (id, seller_id, kind, title, description, price_cents, quantity, image_key, contact_link, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`
        )
          .bind(
            id,
            u.userId,
            kind,
            String(title),
            description ? String(description) : null,
            Number(price_cents),
            qty,
            image_key ? String(image_key) : null,
            contact_link ? String(contact_link) : null,
            now,
            now
          )
          .run();

        // AC secret: MVP lưu plaintext trong encrypted_blob là KHÔNG OK.
        // Tạm thời: bắt buộc bạn phải mã hoá ở backend sau này. Ở đây chặn nếu không có ac_secret_txt.
        if (kind === "ac") {
          if (!ac_secret_txt) return withCors(bad("Missing ac_secret_txt for kind=ac"));
          // Tạm thời lưu thẳng (KHÔNG AN TOÀN) -> bạn nên thay bằng AES-GCM.
          // Mình vẫn lưu để bạn test flow end-to-end trước.
          await env.DB.prepare(
            `INSERT INTO listing_secrets (listing_id, encrypted_blob, created_at) VALUES (?, ?, ?)`
          ).bind(id, String(ac_secret_txt), now).run();
        }

        return withCors(ok({ listing_id: id }));
      }

      // GET /api/listings/:id
      if (path.startsWith("/api/listings/") && req.method === "GET") {
        const id = path.split("/").pop()!;
        const row = await env.DB.prepare(
          `SELECT l.*, u.username as seller_username, u.reputation as seller_reputation
           FROM listings l JOIN users u ON u.id=l.seller_id
           WHERE l.id=?`
        )
          .bind(id)
          .first();

        if (!row) return withCors(bad("Not found", 404));
        return withCors(ok({ item: row }));
      }

      // ----------------------------
      // ORDERS (Purchase)
      // ----------------------------
      if (path === "/api/orders" && req.method === "POST") {
        const u = await requireAuth(req, env);
        if (!u) return withCors(bad("Unauthorized", 401));

        const body = await readJson(req);
        if (!body) return withCors(bad("Invalid JSON"));

        const { listing_id, quantity } = body;
        if (!listing_id) return withCors(bad("Missing listing_id"));
        const qty = Math.max(1, Number(quantity || 1));

        // Fetch listing
        const listing = await env.DB.prepare(
          "SELECT id, seller_id, kind, price_cents, quantity, status FROM listings WHERE id=?"
        )
          .bind(String(listing_id))
          .first<{ id: string; seller_id: string; kind: string; price_cents: number; quantity: number; status: string }>();

        if (!listing || listing.status !== "active") return withCors(bad("Listing not available", 404));
        if (listing.seller_id === u.userId) return withCors(bad("Cannot buy your own listing", 400));
        if (listing.quantity < qty) return withCors(bad("Not enough stock", 400));

        const subtotal = listing.price_cents * qty;
        const platformFee = Math.round(subtotal * 0.05);
        const sellerIncome = subtotal - platformFee;

        // Check buyer balance
        const buyerWallet = await env.DB.prepare("SELECT balance_cents FROM wallets WHERE user_id=?")
          .bind(u.userId)
          .first<{ balance_cents: number }>();
        if (!buyerWallet || buyerWallet.balance_cents < subtotal) return withCors(bad("Insufficient balance", 400));

        // Ensure seller active
        const seller = await env.DB.prepare("SELECT status FROM users WHERE id=?").bind(listing.seller_id).first<{status:string}>();
        if (!seller || seller.status !== "active") return withCors(bad("Seller not available", 400));

        const now = Date.now();
        const orderId = uuid();

        // Attempt transactional pattern
        try {
          await env.DB.prepare("BEGIN").run();

          // re-check stock (avoid race)
          const stockNow = await env.DB.prepare("SELECT quantity FROM listings WHERE id=?")
            .bind(listing.id)
            .first<{ quantity: number }>();
          if (!stockNow || stockNow.quantity < qty) {
            await env.DB.prepare("ROLLBACK").run();
            return withCors(bad("Not enough stock", 400));
          }

          // re-check buyer balance
          const balNow = await env.DB.prepare("SELECT balance_cents FROM wallets WHERE user_id=?")
            .bind(u.userId)
            .first<{ balance_cents: number }>();
          if (!balNow || balNow.balance_cents < subtotal) {
            await env.DB.prepare("ROLLBACK").run();
            return withCors(bad("Insufficient balance", 400));
          }

          // Decrease listing quantity; if becomes 0 -> sold_out
          const newQty = stockNow.quantity - qty;
          const newStatus = newQty === 0 ? "sold_out" : "active";
          await env.DB.prepare("UPDATE listings SET quantity=?, status=?, updated_at=? WHERE id=?")
            .bind(newQty, newStatus, now, listing.id)
            .run();

          // Create order
          await env.DB.prepare(
            `INSERT INTO orders
             (id, buyer_id, seller_id, listing_id, unit_price_cents, quantity, subtotal_cents, platform_fee_cents, seller_income_cents, status, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'paid', ?)`
          ).bind(
            orderId,
            u.userId,
            listing.seller_id,
            listing.id,
            listing.price_cents,
            qty,
            subtotal,
            platformFee,
            sellerIncome,
            now
          ).run();

          // Update wallets
          await env.DB.prepare("UPDATE wallets SET balance_cents = balance_cents - ?, updated_at=? WHERE user_id=?")
            .bind(subtotal, now, u.userId)
            .run();

          await env.DB.prepare("UPDATE wallets SET balance_cents = balance_cents + ?, updated_at=? WHERE user_id=?")
            .bind(sellerIncome, now, listing.seller_id)
            .run();

          // Ledger
          await env.DB.prepare(
            `INSERT INTO wallet_ledger (id, user_id, type, amount_cents, ref_type, ref_id, note, created_at)
             VALUES (?, ?, 'purchase', ?, 'order', ?, ?, ?)`
          ).bind(uuid(), u.userId, -subtotal, orderId, `Buy listing ${listing.id}`, now).run();

          await env.DB.prepare(
            `INSERT INTO wallet_ledger (id, user_id, type, amount_cents, ref_type, ref_id, note, created_at)
             VALUES (?, ?, 'sale_income', ?, 'order', ?, ?, ?)`
          ).bind(uuid(), listing.seller_id, sellerIncome, orderId, `Sold listing ${listing.id}`, now).run();

          await env.DB.prepare("COMMIT").run();
        } catch (e) {
          await env.DB.prepare("ROLLBACK").run().catch(() => {});
          return withCors(bad("Purchase failed", 500));
        }

        return withCors(ok({ order_id: orderId }));
      }

      // GET /api/orders/:id (buyer or seller)
      if (path.startsWith("/api/orders/") && req.method === "GET") {
        const u = await requireAuth(req, env);
        if (!u) return withCors(bad("Unauthorized", 401));

        const orderId = path.split("/").pop()!;
        const order = await env.DB.prepare("SELECT * FROM orders WHERE id=?").bind(orderId).first<any>();
        if (!order) return withCors(bad("Not found", 404));
        if (order.buyer_id !== u.userId && order.seller_id !== u.userId && u.role !== "admin") {
          return withCors(bad("Forbidden", 403));
        }
        return withCors(ok({ order }));
      }

      // Download secret for AC (buyer only)
      if (path.startsWith("/api/orders/") && path.endsWith("/secret") && req.method === "GET") {
        const u = await requireAuth(req, env);
        if (!u) return withCors(bad("Unauthorized", 401));

        const parts = path.split("/");
        const orderId = parts[3]; // /api/orders/:id/secret
        const order = await env.DB.prepare("SELECT * FROM orders WHERE id=?").bind(orderId).first<any>();
        if (!order) return withCors(bad("Not found", 404));
        if (order.buyer_id !== u.userId) return withCors(bad("Forbidden", 403));
        if (order.status !== "paid") return withCors(bad("Order not paid", 400));

        const listing = await env.DB.prepare("SELECT kind FROM listings WHERE id=?").bind(order.listing_id).first<{kind:string}>();
        if (!listing || listing.kind !== "ac") return withCors(bad("Not an AC order", 400));

        const secret = await env.DB.prepare("SELECT encrypted_blob FROM listing_secrets WHERE listing_id=?")
          .bind(order.listing_id)
          .first<{ encrypted_blob: string }>();
        if (!secret) return withCors(bad("Secret not found", 404));

        // MVP: trả thẳng (sau này bạn thay bằng giải mã AES-GCM)
        return withCors(ok({ secret_txt: secret.encrypted_blob }));
      }

      // ----------------------------
      // FEEDBACK
      // ----------------------------
      // POST /api/orders/:id/feedback { type: 'trust'|'scam', note? }
      if (path.startsWith("/api/orders/") && path.endsWith("/feedback") && req.method === "POST") {
        const u = await requireAuth(req, env);
        if (!u) return withCors(bad("Unauthorized", 401));

        const parts = path.split("/");
        const orderId = parts[3]; // /api/orders/:id/feedback
        const body = await readJson(req);
        if (!body) return withCors(bad("Invalid JSON"));
        const { type, note } = body;
        if (type !== "trust" && type !== "scam") return withCors(bad("Invalid type"));

        const order = await env.DB.prepare("SELECT * FROM orders WHERE id=?").bind(orderId).first<any>();
        if (!order) return withCors(bad("Not found", 404));
        if (order.buyer_id !== u.userId) return withCors(bad("Forbidden", 403));

        // insert feedback (PK order_id => only once)
        try {
          await env.DB.prepare(
            `INSERT INTO feedback (order_id, buyer_id, seller_id, type, note, created_at)
             VALUES (?, ?, ?, ?, ?, ?)`
          ).bind(orderId, u.userId, order.seller_id, type, note ? String(note) : null, Date.now()).run();
        } catch {
          return withCors(bad("Already feedbacked", 409));
        }

        if (type === "trust") {
          await env.DB.prepare("UPDATE users SET reputation = reputation + 1, updated_at=? WHERE id=?")
            .bind(Date.now(), order.seller_id)
            .run();
        } else {
          // scam: bạn nên yêu cầu user tạo dispute có evidence. Ở đây chỉ ghi feedback scam.
          await env.DB.prepare("UPDATE orders SET status='disputed' WHERE id=?").bind(orderId).run();
        }

        return withCors(ok());
      }

      // ----------------------------
      // DISPUTES (buyer tạo scam ticket)
      // ----------------------------
      if (path === "/api/disputes" && req.method === "POST") {
        const u = await requireAuth(req, env);
        if (!u) return withCors(bad("Unauthorized", 401));

        const body = await readJson(req);
        if (!body) return withCors(bad("Invalid JSON"));

        const { order_id, description, evidence_image_key } = body;
        if (!order_id || !description) return withCors(bad("Missing fields"));

        const order = await env.DB.prepare("SELECT * FROM orders WHERE id=?").bind(String(order_id)).first<any>();
        if (!order) return withCors(bad("Order not found", 404));
        if (order.buyer_id !== u.userId) return withCors(bad("Forbidden", 403));

        const now = Date.now();
        const disputeId = uuid();

        try {
          await env.DB.prepare(
            `INSERT INTO disputes (id, order_id, buyer_id, seller_id, description, evidence_image_key, status, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, 'open', ?, ?)`
          )
            .bind(disputeId, order.id, u.userId, order.seller_id, String(description), evidence_image_key ? String(evidence_image_key) : null, now, now)
            .run();
        } catch {
          return withCors(bad("Dispute already exists for this order", 409));
        }

        await env.DB.prepare("UPDATE orders SET status='disputed' WHERE id=?").bind(order.id).run();

        return withCors(ok({ dispute_id: disputeId }));
      }

      // ----------------------------
      // ADMIN: approve/reject dispute
      // POST /api/admin/disputes/:id/decision { action: 'approve'|'reject', admin_note? }
      // approve: refund buyer subtotal, ban seller, mark order refunded
      // ----------------------------
      if (path.startsWith("/api/admin/disputes/") && path.endsWith("/decision") && req.method === "POST") {
        const admin = await requireAdmin(req, env);
        if (!admin) return withCors(bad("Unauthorized", 401));

        const parts = path.split("/");
        const disputeId = parts[4]; // /api/admin/disputes/:id/decision

        const body = await readJson(req);
        if (!body) return withCors(bad("Invalid JSON"));
        const { action, admin_note } = body;
        if (action !== "approve" && action !== "reject") return withCors(bad("Invalid action"));

        const dispute = await env.DB.prepare("SELECT * FROM disputes WHERE id=?").bind(disputeId).first<any>();
        if (!dispute) return withCors(bad("Not found", 404));
        if (dispute.status !== "open") return withCors(bad("Already decided", 409));

        const order = await env.DB.prepare("SELECT * FROM orders WHERE id=?").bind(dispute.order_id).first<any>();
        if (!order) return withCors(bad("Order not found", 404));

        const now = Date.now();

        if (action === "reject") {
          await env.DB.prepare(
            "UPDATE disputes SET status='rejected', admin_id=?, admin_note=?, updated_at=? WHERE id=?"
          ).bind(admin.userId, admin_note ? String(admin_note) : null, now, disputeId).run();

          // keep order disputed or revert? MVP: keep disputed.
          return withCors(ok());
        }

        // approve => refund
        try {
          await env.DB.prepare("BEGIN").run();

          // Refund buyer +subtotal
          await env.DB.prepare("UPDATE wallets SET balance_cents = balance_cents + ?, updated_at=? WHERE user_id=?")
            .bind(order.subtotal_cents, now, order.buyer_id)
            .run();

          await env.DB.prepare(
            `INSERT INTO wallet_ledger (id, user_id, type, amount_cents, ref_type, ref_id, note, created_at)
             VALUES (?, ?, 'refund', ?, 'dispute', ?, ?, ?)`
          ).bind(uuid(), order.buyer_id, order.subtotal_cents, disputeId, `Refund order ${order.id}`, now).run();

          // Charge seller back seller_income (may go negative if seller withdrew; MVP allow negative or enforce >=0)
          await env.DB.prepare("UPDATE wallets SET balance_cents = balance_cents - ?, updated_at=? WHERE user_id=?")
            .bind(order.seller_income_cents, now, order.seller_id)
            .run();

          await env.DB.prepare(
            `INSERT INTO wallet_ledger (id, user_id, type, amount_cents, ref_type, ref_id, note, created_at)
             VALUES (?, ?, 'adjustment', ?, 'dispute', ?, ?, ?)`
          ).bind(uuid(), order.seller_id, -order.seller_income_cents, disputeId, `Chargeback order ${order.id}`, now).run();

          // Ban seller
          await env.DB.prepare("UPDATE users SET status='banned', updated_at=? WHERE id=?")
            .bind(now, order.seller_id)
            .run();

          // Update order & dispute
          await env.DB.prepare("UPDATE orders SET status='refunded' WHERE id=?").bind(order.id).run();
          await env.DB.prepare(
            "UPDATE disputes SET status='approved', admin_id=?, admin_note=?, updated_at=? WHERE id=?"
          ).bind(admin.userId, admin_note ? String(admin_note) : null, now, disputeId).run();

          await env.DB.prepare("COMMIT").run();
        } catch {
          await env.DB.prepare("ROLLBACK").run().catch(() => {});
          return withCors(bad("Approve failed", 500));
        }

        return withCors(ok());
      }

      // fallback
      return withCors(bad("Not found", 404));
    } catch (e: any) {
      return new Response(JSON.stringify({ ok: false, error: "Server error" }), {
        status: 500,
        headers: { "Content-Type": "application/json; charset=utf-8", ...corsHeaders(req) },
      });
    }
  },
};

// ===== Quota compute (base + deposit + reputation) =====
async function computeQuota(env: Env, userId: string): Promise<number> {
  const u = await env.DB.prepare("SELECT reputation, total_deposit_cents FROM users WHERE id=?")
    .bind(userId)
    .first<{ reputation: number; total_deposit_cents: number }>();
  if (!u) return 0;

  const base = await env.DB.prepare(
    "SELECT COALESCE(SUM(bonus_slots),0) AS v FROM quota_rules WHERE kind='base' AND is_active=1"
  ).first<{ v: number }>();

  const dep = await env.DB.prepare(
    "SELECT COALESCE(SUM(bonus_slots),0) AS v FROM quota_rules WHERE kind='deposit' AND is_active=1 AND ? >= threshold_cents"
  ).bind(u.total_deposit_cents).first<{ v: number }>();

  const rep = await env.DB.prepare(
    "SELECT COALESCE(SUM(bonus_slots),0) AS v FROM quota_rules WHERE kind='reputation' AND is_active=1 AND ? >= threshold_reputation"
  ).bind(u.reputation).first<{ v: number }>();

  return (base?.v ?? 0) + (dep?.v ?? 0) + (rep?.v ?? 0);
}
