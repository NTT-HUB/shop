export default {
  async fetch(req, env) {
    // ===== CORS =====
    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(req) });
    }

    const url = new URL(req.url);
    const path = url.pathname;

    const withCors = (res) => {
      const h = new Headers(res.headers);
      const cors = corsHeaders(req);
      for (const [k, v] of Object.entries(cors)) h.set(k, v);
      return new Response(res.body, { status: res.status, headers: h });
    };

    try {
      // -------- HEALTH / DEBUG --------
      if (path === "/api/health") {
        return withCors(ok({ ts: Date.now() }));
      }

      if (path === "/api/_debug") {
        return withCors(
          ok({
            pepper: typeof env.PASSWORD_PEPPER,
            hasDB: !!env.DB,
            hasSessionMaxAge: typeof env.SESSION_MAX_AGE_SEC,
          })
        );
      }

      // ===== DEV TOPUP (TEST ONLY) =====
if (path === "/api/dev/topup" && req.method === "POST") {
  const u = await requireAuth(req, env);
  if (!u) return withCors(bad("Unauthorized", 401));

  const body = await readJson(req);
  const amount = Number(body?.amount_cents || 0);
  if (amount <= 0) return withCors(bad("Invalid amount"));

  const now = Date.now();

  await env.DB.prepare(
    "UPDATE wallets SET balance_cents = balance_cents + ?, updated_at=? WHERE user_id=?"
  ).bind(amount, now, u.userId).run();

  await env.DB.prepare(
    `INSERT INTO wallet_ledger (id, user_id, type, amount_cents, ref_type, note, created_at)
     VALUES (?, ?, 'adjustment', ?, 'dev', 'Dev topup', ?)`
  ).bind(crypto.randomUUID(), u.userId, amount, now).run();

  return withCors(ok({ amount_cents: amount }));
}

// ===== LEDGER HISTORY =====
if (path === "/api/ledger" && req.method === "GET") {
  const u = await requireAuth(req, env);
  if (!u) return withCors(bad("Unauthorized", 401));

  const rows = await env.DB.prepare(
    `SELECT type, amount_cents, note, created_at
     FROM wallet_ledger
     WHERE user_id=?
     ORDER BY created_at DESC
     LIMIT 100`
  ).bind(u.userId).all();

  return withCors(ok({ items: rows.results || [] }));
}


      // -------- AUTH --------
      if (path === "/api/auth/register" && req.method === "POST") {
        const body = await readJson(req);
        if (!body) return withCors(bad("Invalid JSON"));

        const { username, email, phone, password } = body;

        if (!username || !email || !password) return withCors(bad("Missing fields"));
        if (String(password).length < 6) return withCors(bad("Password too short"));

        const now = Date.now();
        const id = crypto.randomUUID();

        let password_hash;
        try {
          password_hash = await hashPassword(String(password), env.PASSWORD_PEPPER);
        } catch (e) {
          console.error("HASH PASSWORD ERROR:", e);
          return withCors(bad("Password error", 500));
        }

        try {
          await env.DB.prepare(
            `INSERT INTO users (
              id, username, email, phone, password_hash,
              role, status, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, 'user', 'active', ?, ?)`
          )
            .bind(
              id,
              String(username),
              String(email),
              phone ? String(phone) : "", // không null để né unique/null issue
              password_hash,
              now,
              now
            )
            .run();

          await env.DB.prepare(
            `INSERT INTO wallets (user_id, balance_cents, updated_at)
             VALUES (?, 0, ?)`
          )
            .bind(id, now)
            .run();
        } catch (e) {
          console.error("REGISTER SQLITE ERROR:", e);
          if (String(e).includes("UNIQUE")) {
            return withCors(bad("Username / Email / Phone đã tồn tại", 409));
          }
          return withCors(bad("Register failed", 500));
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
          .first();

        if (!user || user.status !== "active") return withCors(bad("Invalid credentials", 401));

        const okPw = await verifyPassword(String(password), user.password_hash, env.PASSWORD_PEPPER);
        if (!okPw) return withCors(bad("Invalid credentials", 401));

        const token = crypto.randomUUID() + crypto.randomUUID();
        const tokenHash = await sha256Hex(token);

        const ua = req.headers.get("user-agent") || "";
        const uaHash = await sha256Hex(ua);

        const ipPrefix = ipPrefixFromReq(req);
        const now = Date.now();
        const maxAge = parseInt(env.SESSION_MAX_AGE_SEC || "2592000", 10);
        const expires = now + maxAge * 1000;

        // giới hạn 1 session/user
        await env.DB.prepare("DELETE FROM sessions WHERE user_id=?").bind(user.id).run();

        await env.DB.prepare(
          `INSERT INTO sessions (id, user_id, token_hash, ua_hash, ip_prefix, created_at, last_seen_at, expires_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        )
          .bind(crypto.randomUUID(), user.id, tokenHash, uaHash, ipPrefix, now, now, expires)
          .run();

        return withCors(json({ ok: true }, 200, { "Set-Cookie": setCookie("session", token, maxAge) }));
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
          .first();

        return withCors(ok({ user, balance_cents: wallet?.balance_cents ?? 0 }));
      }

// ===== MY ORDERS =====
if (path === "/api/my/orders" && req.method === "GET") {
  const u = await requireAuth(req, env);
  if (!u) return withCors(bad("Unauthorized", 401));

  const rows = await env.DB.prepare(
    `SELECT o.id, o.subtotal_cents, o.status, o.created_at,
            l.title, l.kind, l.contact_link,
            u.username AS seller_username
     FROM orders o
     JOIN listings l ON l.id=o.listing_id
     JOIN users u ON u.id=o.seller_id
     WHERE o.buyer_id=?
     ORDER BY o.created_at DESC`
  ).bind(u.userId).all();

  return withCors(ok({ items: rows.results || [] }));
}


      // -------- LISTINGS --------
      if (path === "/api/listings" && req.method === "GET") {
        const kind = url.searchParams.get("kind");
        const q = url.searchParams.get("q");
        const limit = Math.min(parseInt(url.searchParams.get("limit") || "20", 10), 50);
        const offset = Math.max(parseInt(url.searchParams.get("offset") || "0", 10), 0);

        let sql = `SELECT l.*, u.username as seller_username, u.reputation as seller_reputation
                   FROM listings l JOIN users u ON u.id=l.seller_id
                   WHERE l.status='active'`;
        const binds = [];

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

      async function computeQuota(env, userId) {
  // lấy uy tín + role
  const u = await env.DB.prepare(
    "SELECT reputation, role FROM users WHERE id=?"
  ).bind(userId).first();

  if (!u) return 0;

  // admin không giới hạn
  if (u.role === "admin") return 999999;

  // theo uy tín
  const rep = Number(u.reputation || 0);

  if (rep >= 100) return 20;
  if (rep >= 50)  return 15;
  if (rep >= 10)  return 10;

  // user mới
  return 5;
}


  if (path === "/api/listings" && req.method === "POST") {
  const u = await requireAuth(req, env);
  if (!u) return withCors(bad("Unauthorized", 401));

  // 🔒 kiểm tra trạng thái user
  const seller = await env.DB
    .prepare("SELECT status FROM users WHERE id=?")
    .bind(u.userId)
    .first();

  if (!seller || seller.status !== "active")
    return withCors(bad("Account banned", 403));

  const body = await readJson(req);
  if (!body) return withCors(bad("Invalid JSON"));

  const {
    kind,
    title,
    description,
    price_cents,
    quantity,
    contact_link,
    ac_secret_txt
  } = body;

  // ===== VALIDATE =====
  if (!kind || !title || price_cents == null)
    return withCors(bad("Missing fields"));

  if (!["product", "ac"].includes(kind))
    return withCors(bad("Invalid kind"));

  if (!Number.isFinite(Number(price_cents)) || Number(price_cents) < 20000)
    return withCors(bad("Price must be >= 20.000đ"));

  const qty = quantity == null ? 1 : Number(quantity);
  if (!Number.isFinite(qty) || qty <= 0)
    return withCors(bad("Invalid quantity"));

  if (kind === "ac" && !ac_secret_txt)
    return withCors(bad("Missing ac_secret_txt for AC"));

  // ===== QUOTA =====
  const quota = await computeQuota(env, u.userId);

  const used = await env.DB.prepare(
    "SELECT COUNT(*) as c FROM listings WHERE seller_id=? AND status='active'"
  )
    .bind(u.userId)
    .first();

  if ((used?.c ?? 0) >= quota)
    return withCors(
      bad(`Reached listing limit (${quota} active listings)`, 403)
    );

  // ===== INSERT LISTING =====
  const now = Date.now();
  const id = crypto.randomUUID();

  await env.DB.prepare(
    `INSERT INTO listings
     (id, seller_id, kind, title, description, price_cents, quantity,
      image_key, contact_link, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, 'active', ?, ?)`
  )
    .bind(
      id,
      u.userId,
      kind,
      String(title).slice(0, 200),
      description ? String(description).slice(0, 2000) : null,
      Number(price_cents),
      kind === "ac" ? 1 : qty,
      contact_link ? String(contact_link).slice(0, 500) : null,
      now,
      now
    )
    .run();

  // ===== AC SECRET =====
  if (kind === "ac") {
    await env.DB.prepare(
      `INSERT INTO listing_secrets
       (listing_id, encrypted_blob, created_at)
       VALUES (?, ?, ?)`
    )
      .bind(id, String(ac_secret_txt), now)
      .run();
  }

  return withCors(ok({
    listing_id: id,
    quota,
    used: (used?.c ?? 0) + 1
  }));
}


     if (path.startsWith("/api/listings/") && req.method === "GET") {
  const id = path.split("/").pop();

  const row = await env.DB.prepare(
    `SELECT
        l.*,
        u.username AS seller_username,
        u.reputation AS seller_reputation,
        u.status AS seller_status
     FROM listings l
     JOIN users u ON u.id = l.seller_id
     WHERE l.id = ?`
  ).bind(id).first();

  if (!row)
    return withCors(bad("Not found", 404));

  // 🔒 SELLER BỊ BAN → KHÔNG CHO XEM
  if (row.seller_status !== "active") {
    return withCors(bad("Seller is banned", 403));
  }

  // 🔒 LISTING BỊ ẨN
  if (row.status !== "active") {
    return withCors(bad("Listing not available", 404));
  }

  return withCors(ok({ item: row }));
}

if (path === "/api/admin/users" && req.method === "GET") {
  const admin = await requireAdmin(req, env);
  if (!admin) return withCors(bad("Unauthorized", 401));

  const rows = await env.DB.prepare(`
    SELECT 
      u.id,
      u.username,
      u.status,
      u.created_at,
      COALESCE(w.balance_cents, 0) AS balance_cents
    FROM users u
    LEFT JOIN wallets w ON w.user_id = u.id
    ORDER BY u.created_at DESC
    LIMIT 200
  `).all();

  return withCors(ok({ users: rows.results || [] }));
}

// POST /api/admin/users/delete
if (path === "/api/admin/users/delete" && req.method === "POST") {
  const admin = await requireAdmin(req, env);
  if (!admin) return withCors(bad("Unauthorized", 401));

  const body = await readJson(req);
  if (!body?.user_id) return withCors(bad("Missing user_id"));

  const now = Date.now();

  // 1️⃣ XÓA MỀM USER
  await env.DB.prepare(
    "UPDATE users SET status='deleted', updated_at=? WHERE id=?"
  ).bind(now, body.user_id).run();

  // 2️⃣ ẨN TOÀN BỘ SẢN PHẨM ĐANG BÁN
  await env.DB.prepare(
    "UPDATE listings SET status='hidden', updated_at=? WHERE seller_id=? AND status='active'"
  ).bind(now, body.user_id).run();

  return withCors(ok({ success: true }));
}


if (path === "/api/admin/users/ban" && req.method === "POST") {
  const admin = await requireAdmin(req, env);
  if (!admin) return withCors(bad("Unauthorized", 401));

  const { user_id, banned } = await readJson(req);
  if (!user_id) return withCors(bad("Missing user_id"));

  const status = banned ? "banned" : "active";
  const now = Date.now();

  // update user
  await env.DB.prepare(
    "UPDATE users SET status=?, updated_at=? WHERE id=?"
  ).bind(status, now, user_id).run();

  // ẨN / HIỆN listings
  if (banned) {
    await env.DB.prepare(
      "UPDATE listings SET status='hidden' WHERE seller_id=? AND status='active'"
    ).bind(user_id).run();
  } else {
    await env.DB.prepare(
      "UPDATE listings SET status='active' WHERE seller_id=? AND status='hidden'"
    ).bind(user_id).run();
  }

  return withCors(ok({ user_id, status }));
}

if (path === "/api/admin/users/balance" && req.method === "POST") {
  const admin = await requireAdmin(req, env);
  if (!admin) return withCors(bad("Unauthorized", 401));

  const { user_id, amount_cents, note } = await readJson(req);
  if (!user_id || !Number.isFinite(amount_cents) || amount_cents === 0)
    return withCors(bad("Invalid input"));

  const now = Date.now();

  // ensure wallet exists
  await env.DB.prepare(
    "INSERT INTO wallets(user_id, balance_cents, updated_at) VALUES (?, 0, ?) ON CONFLICT(user_id) DO NOTHING"
  ).bind(user_id, now).run();

  // update balance
  await env.DB.prepare(
    "UPDATE wallets SET balance_cents = balance_cents + ?, updated_at=? WHERE user_id=?"
  ).bind(amount_cents, now, user_id).run();

  // ledger
  await env.DB.prepare(
    `INSERT INTO wallet_ledger
     (id, user_id, type, amount_cents, ref_type, ref_id, note, created_at)
     VALUES (?, ?, 'admin_adjust', ?, 'admin', ?, ?, ?)`
  ).bind(
    crypto.randomUUID(),
    user_id,
    amount_cents,
    admin.userId,
    note || "Admin điều chỉnh số dư",
    now
  ).run();

  return withCors(ok({ user_id, amount_cents }));
}

if (path === "/api/admin/users/status" && req.method === "POST") {
  const admin = await requireAdmin(req, env);
  if (!admin) return withCors(bad("Unauthorized", 401));

  const { user_id, status } = await readJson(req);
  if (!user_id || !["active", "banned"].includes(status))
    return withCors(bad("Invalid input"));

  const now = Date.now();

  // update user
  await env.DB.prepare(
    "UPDATE users SET status=?, updated_at=? WHERE id=?"
  ).bind(status, now, user_id).run();

  // ẨN / HIỆN listing
  if (status === "banned") {
    await env.DB.prepare(
      "UPDATE listings SET status='hidden' WHERE seller_id=? AND status='active'"
    ).bind(user_id).run();
  } else {
    await env.DB.prepare(
      "UPDATE listings SET status='active' WHERE seller_id=? AND status='hidden'"
    ).bind(user_id).run();
  }

  return withCors(ok({ user_id, status }));
}

// DELETE /api/listings/:id
if (path.startsWith("/api/listings/") && req.method === "DELETE") {
  const u = await requireAuth(req, env);
  if (!u) return withCors(bad("Unauthorized", 401));

  const id = path.split("/").pop();

  const listing = await env.DB.prepare(
    "SELECT id, seller_id FROM listings WHERE id=?"
  ).bind(id).first();

  if (!listing) return withCors(bad("Not found", 404));
  if (listing.seller_id !== u.userId)
    return withCors(bad("Forbidden", 403));

  // 🔒 Kiểm tra CHƯA CÓ ĐƠN
  const hasOrder = await env.DB.prepare(
    "SELECT 1 FROM orders WHERE listing_id=? LIMIT 1"
  ).bind(id).first();

  if (hasOrder) {
    return withCors(bad(
      "Sản phẩm đã có đơn, không thể xóa",
      400
    ));
  }

  // ✅ XÓA CỨNG
  await env.DB.prepare(
    "DELETE FROM listings WHERE id=?"
  ).bind(id).run();

  return withCors(ok({ message: "Đã xóa sản phẩm" }));
}

// GET /api/my/listings  (SELLER: LIST MY LISTINGS)
if (path === "/api/my/listings" && req.method === "GET") {
  const u = await requireAuth(req, env);
  if (!u) return withCors(bad("Unauthorized", 401));

  const rows = await env.DB.prepare(`
    SELECT
      id, kind, title, description, price_cents, quantity, status, contact_link, created_at
    FROM listings
    WHERE seller_id=?
    ORDER BY created_at DESC
    LIMIT 200
  `).bind(u.userId).all();

  return withCors(ok({ items: rows.results || [] }));
}

// GET /api/users/:username/profile
if (path.startsWith("/api/users/") && path.endsWith("/profile") && req.method === "GET") {
  const username = decodeURIComponent(path.split("/")[3]);

  const user = await env.DB.prepare(`
    SELECT id, username, reputation
    FROM users
    WHERE username=?
  `).bind(username).first();

  if (!user)
    return withCors(bad("User not found", 404));

  // tổng đơn đã bán
  const sold = await env.DB.prepare(`
    SELECT COUNT(*) AS total
    FROM orders
    WHERE seller_id=?
      AND status='paid'
  `).bind(user.id).first();

  return withCors(ok({
    user: {
      username: user.username,
      reputation: user.reputation ?? 0
    },
    sold_orders: sold.total ?? 0
  }));
}

// GET /api/my/sales
if (path === "/api/my/sales" && req.method === "GET") {
  const u = await requireAuth(req, env);
  if (!u) return withCors(bad("Unauthorized", 401));

  const rows = await env.DB.prepare(`
    SELECT 
      o.id,
      o.quantity,
      o.seller_income_cents,
      o.created_at,
      l.title,
      u2.username AS buyer_username
    FROM orders o
    JOIN listings l ON l.id = o.listing_id
    JOIN users u2 ON u2.id = o.buyer_id
    WHERE o.seller_id = ?
    ORDER BY o.created_at DESC
    LIMIT 100
  `).bind(u.userId).all();

  return withCors(ok({ items: rows.results || [] }));
}

// GET /api/my/withdrawals
if (path === "/api/my/withdrawals" && req.method === "GET") {
  const u = await requireAuth(req, env);
  if (!u) return withCors(bad("Unauthorized", 401));

  try {
    const rows = await env.DB.prepare(`
      SELECT
        id,
        amount,        -- ✅ CỘT ĐÚNG
        method,
        status,
        created_at
      FROM withdrawals
      WHERE user_id=?
      ORDER BY created_at DESC
      LIMIT 100
    `).bind(u.userId).all();

    // chuẩn hoá cho frontend dùng formatPrice
    const items = (rows.results || []).map(w => ({
      id: w.id,
      amount_cents: w.amount * 100, // ✅ convert sang cents
      method: w.method,
      status: w.status,
      created_at: w.created_at
    }));

    const res = ok({ items });
    res.headers.set("Cache-Control", "no-store");
    return withCors(res);
  } catch (e) {
    return withCors(bad("Withdrawals SQL error: " + e.message, 500));
  }
}


// GET /api/users/:username/sold-listings
if (path.startsWith("/api/users/") && path.endsWith("/sold-listings") && req.method === "GET") {
  const username = decodeURIComponent(path.split("/")[3]);

  const user = await env.DB.prepare(
    "SELECT id FROM users WHERE username=?"
  ).bind(username).first();

  if (!user)
    return withCors(bad("User not found", 404));

  const rows = await env.DB.prepare(`
    SELECT
      l.id,
      l.title,
      l.price_cents,
      o.created_at AS sold_at
    FROM orders o
    JOIN listings l ON l.id=o.listing_id
    WHERE o.seller_id=?
      AND o.status='paid'
    ORDER BY o.created_at DESC
    LIMIT 50
  `).bind(user.id).all();

  return withCors(ok({ items: rows.results || [] }));
}

      // -------- PURCHASE --------
// POST /api/orders (BUY ALL)
if (path === "/api/orders" && req.method === "POST") {
  const u = await requireAuth(req, env);
  if (!u) return withCors(bad("Unauthorized", 401));

  const body = await readJson(req);
  if (!body || !body.listing_id)
    return withCors(bad("Missing listing_id"));

  // 🔒 LẤY LISTING + STATUS SELLER
  const listing = await env.DB.prepare(
    `SELECT
        l.id,
        l.seller_id,
        l.kind,
        l.price_cents,
        l.quantity,
        l.status,
        u.status AS seller_status
     FROM listings l
     JOIN users u ON u.id = l.seller_id
     WHERE l.id = ?`
  ).bind(body.listing_id).first();

  if (!listing)
    return withCors(bad("Listing not found", 404));

  // 🔒 CHECK LISTING
  if (listing.status !== "active")
    return withCors(bad("Listing not available", 404));

  // 🔒 CHECK SELLER
  if (listing.seller_status !== "active")
    return withCors(bad("Seller is banned", 403));

  // 🔒 KHÔNG MUA CỦA CHÍNH MÌNH
  if (listing.seller_id === u.userId)
    return withCors(bad("Cannot buy your own listing", 400));

  // 🔒 HẾT HÀNG
  if (listing.quantity <= 0)
    return withCors(bad("Out of stock", 400));

  // ✅ MUA TRỌN GÓI
  const boughtQty = listing.quantity;   // VD: 388
  const subtotal = listing.price_cents; // GIÁ TRỌN GÓI

  const platformFee = Math.round(subtotal * 0.05);
  const sellerIncome = subtotal - platformFee;

  // 🔒 CHECK WALLET BUYER
  const buyerWallet = await env.DB.prepare(
    "SELECT balance_cents FROM wallets WHERE user_id=?"
  ).bind(u.userId).first();

  if (!buyerWallet || buyerWallet.balance_cents < subtotal)
    return withCors(bad("Insufficient balance", 400));

  const now = Date.now();
  const orderId = crypto.randomUUID();

  // 🔐 ATOMIC LOCK – CHỈ 1 NGƯỜI MUA ĐƯỢC
  const lock = await env.DB.prepare(
    `UPDATE listings
     SET quantity = 0,
         status = 'sold_out',
         updated_at = ?
     WHERE id = ?
       AND quantity > 0
       AND status = 'active'`
  ).bind(now, listing.id).run();

  if (lock.changes === 0)
    return withCors(bad("Listing already sold", 409));

  // 1️⃣ TRỪ TIỀN BUYER
  await env.DB.prepare(
    "UPDATE wallets SET balance_cents = balance_cents - ?, updated_at=? WHERE user_id=?"
  ).bind(subtotal, now, u.userId).run();

  // 2️⃣ CỘNG TIỀN SELLER
  await env.DB.prepare(
    "UPDATE wallets SET balance_cents = balance_cents + ?, updated_at=? WHERE user_id=?"
  ).bind(sellerIncome, now, listing.seller_id).run();

  // 3️⃣ TẠO ORDER (LƯU TOÀN BỘ SỐ LƯỢNG)
  await env.DB.prepare(
    `INSERT INTO orders
     (id, buyer_id, seller_id, listing_id,
      unit_price_cents, quantity,
      subtotal_cents, platform_fee_cents, seller_income_cents,
      status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'paid', ?)`
  ).bind(
    orderId,
    u.userId,
    listing.seller_id,
    listing.id,
    listing.price_cents,
    boughtQty,          // ✅ mua hết
    subtotal,
    platformFee,
    sellerIncome,
    now
  ).run();

  // 4️⃣ LEDGER BUYER
  await env.DB.prepare(
    `INSERT INTO wallet_ledger
     (id, user_id, type, amount_cents, ref_type, ref_id, note, created_at)
     VALUES (?, ?, 'purchase', ?, 'order', ?, ?, ?)`
  ).bind(
    crypto.randomUUID(),
    u.userId,
    -subtotal,
    orderId,
    `Mua trọn gói đơn hàng ${orderId}`,
    now
  ).run();

  // 5️⃣ LEDGER SELLER
  await env.DB.prepare(
    `INSERT INTO wallet_ledger
     (id, user_id, type, amount_cents, ref_type, ref_id, note, created_at)
     VALUES (?, ?, 'sale_income', ?, 'order', ?, ?, ?)`
  ).bind(
    crypto.randomUUID(),
    listing.seller_id,
    sellerIncome,
    orderId,
    `Bán trọn gói đơn hàng ${orderId}`,
    now
  ).run();

  return withCors(ok({
    order_id: orderId,
    bought_quantity: boughtQty
  }));
}



// ===== ADMIN LIST DISPUTES =====
if (path === "/api/admin/disputes" && req.method === "GET") {
  const admin = await requireAdmin(req, env);
  if (!admin) return withCors(bad("Unauthorized", 401));

  const rows = await env.DB.prepare(
    `SELECT
        d.id,
        d.order_id,
        d.description,
        d.evidence_image_key,
        d.status,
        d.created_at,

        o.subtotal_cents,

        ub.username AS buyer_username,
        us.username AS seller_username
     FROM disputes d
     JOIN orders o ON o.id = d.order_id
     JOIN users ub ON ub.id = d.buyer_id
     JOIN users us ON us.id = d.seller_id
     WHERE d.status = 'open'
     ORDER BY d.created_at DESC`
  ).all();

  return withCors(ok({
    items: rows.results || []
  }));
}


// ===== ADMIN DECIDE DISPUTE (FIXED – D1 SAFE) =====
if (
  path.startsWith("/api/admin/disputes/") &&
  path.endsWith("/decision") &&
  req.method === "POST"
) {
  const admin = await requireAdmin(req, env);
  if (!admin) return withCors(bad("Unauthorized", 401));

  const parts = path.split("/");
  const disputeId = parts[4]; // /api/admin/disputes/{id}/decision

  const body = await readJson(req);
  if (!body || !body.action)
    return withCors(bad("Missing action"));

  if (body.action !== "approve" && body.action !== "reject")
    return withCors(bad("Invalid action"));

  const dispute = await env.DB.prepare(
    "SELECT * FROM disputes WHERE id=?"
  ).bind(disputeId).first();

  if (!dispute) return withCors(bad("Not found", 404));
  if (dispute.status !== "open")
    return withCors(bad("Already decided", 409));

  const order = await env.DB.prepare(
    "SELECT * FROM orders WHERE id=?"
  ).bind(dispute.order_id).first();

  if (!order) return withCors(bad("Order not found", 404));

  const now = Date.now();

  // ===== REJECT =====
  if (body.action === "reject") {
    await env.DB.prepare(
      `UPDATE disputes
       SET status='rejected',
           admin_id=?,
           admin_note=?,
           updated_at=?
       WHERE id=?`
    ).bind(
      admin.userId,
      body.admin_note || null,
      now,
      disputeId
    ).run();

    return withCors(ok({ status: "rejected" }));
  }

  // ===== APPROVE (SCAM) =====
  try {
    // 1️⃣ Hoàn tiền buyer
    await env.DB.prepare(
      "UPDATE wallets SET balance_cents = balance_cents + ?, updated_at=? WHERE user_id=?"
    ).bind(
      order.subtotal_cents,
      now,
      order.buyer_id
    ).run();

    await env.DB.prepare(
      `INSERT INTO wallet_ledger
       (id, user_id, type, amount_cents, ref_type, ref_id, note, created_at)
       VALUES (?, ?, 'refund', ?, 'dispute', ?, ?, ?)`
    ).bind(
      crypto.randomUUID(),
      order.buyer_id,
      order.subtotal_cents,
      disputeId,
      `Hoàn tiền đơn ${order.id}`,
      now
    ).run();

    // 2️⃣ Trừ tiền seller
    await env.DB.prepare(
      "UPDATE wallets SET balance_cents = balance_cents - ?, updated_at=? WHERE user_id=?"
    ).bind(
      order.seller_income_cents,
      now,
      order.seller_id
    ).run();

    await env.DB.prepare(
      `INSERT INTO wallet_ledger
       (id, user_id, type, amount_cents, ref_type, ref_id, note, created_at)
       VALUES (?, ?, 'adjustment', ?, 'dispute', ?, ?, ?)`
    ).bind(
      crypto.randomUUID(),
      order.seller_id,
      -order.seller_income_cents,
      disputeId,
      "Thu hồi tiền do scam",
      now
    ).run();

    // 3️⃣ Ban seller
    await env.DB.prepare(
      "UPDATE users SET status='banned', updated_at=? WHERE id=?"
    ).bind(
      now,
      order.seller_id
    ).run();

    // 4️⃣ Update order
    await env.DB.prepare(
      "UPDATE orders SET status='refunded' WHERE id=?"
    ).bind(order.id).run();

    // 5️⃣ Update dispute
    await env.DB.prepare(
      `UPDATE disputes
       SET status='approved',
           admin_id=?,
           admin_note=?,
           updated_at=?
       WHERE id=?`
    ).bind(
      admin.userId,
      body.admin_note || null,
      now,
      disputeId
    ).run();

    return withCors(ok({ status: "approved" }));
  } catch (e) {
    console.error("ADMIN APPROVE ERROR:", e);
    return withCors(bad("Approve scam failed", 500));
  }
}

// ===== ADMIN GET SETTINGS =====
if (path === "/api/admin/settings" && req.method === "GET") {
  const admin = await requireAdmin(req, env);
  if (!admin) return withCors(bad("Unauthorized", 401));

  const rows = await env.DB
    .prepare("SELECT key, value FROM system_settings")
    .all();

  const map = {};
  for (const r of (rows.results || [])) {
    map[r.key] = r.value;
  }

  return withCors(ok({
    settings: {
      /* ===== SITE ===== */
      site_name: map.site_name || "SHOP",
      site_tagline: map.site_tagline || "Chợ đồ số",

      /* ===== PHÍ ===== */
      bank_fee_percent: Number(map.bank_fee_percent || "0"),
      card_fee_percent: Number(map.card_fee_percent || "0"),

      /* ===== BANK ===== */
      bank_name: map.bank_name || "Ngân hàng",
      bank_account_name: map.bank_account_name || "",
      bank_account_number:
        map.web2m_bank_account || map.bank_account_number || "",
      bank_transfer_prefix:
        map.web2m_prefix || map.bank_transfer_prefix || "NAP",

      /* ===== WEB2M ===== */
      web2m_token: map.web2m_token || "",

      /* ===== CARD ===== */
      card_provider: map.card_provider || "thesieure",
      card_api_key: map.card_api_key || "",
      card_partner_id: map.card_partner_id || "",
      card_callback_domain: map.card_callback_domain || ""
    }
  }));
}



// ===== ADMIN UPDATE SETTINGS =====
if (path === "/api/admin/settings" && req.method === "POST") {
  const admin = await requireAdmin(req, env);
  if (!admin) return withCors(bad("Unauthorized", 401));

  const body = await readJson(req);
  if (!body) return withCors(bad("Invalid JSON"));

  // chỉ cho update whitelist key
const allow = new Set([
  // ===== SITE =====
  "site_name",
  "site_tagline",

  // ===== FEE =====
  "bank_fee_percent",
  "card_fee_percent",

  // ===== BANK INFO (HIỂN THỊ) =====
  "bank_name",              // 👈 TÊN NGÂN HÀNG
  "bank_account_name",      // 👈 CHỦ TÀI KHOẢN

  // ===== WEB2M =====
  "web2m_token",
  "web2m_bank_account",     // 👈 SỐ TÀI KHOẢN
  "web2m_prefix",

  // ===== CARD =====
  "card_provider",
  "card_api_key",
  "card_partner_id",
  "card_callback_domain"
]);


  const now = Date.now();
  const entries = Object.entries(body || {}).filter(([k]) => allow.has(k));

  for (const [k, v] of entries) {
    await env.DB.prepare(
      "INSERT INTO system_settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value"
    ).bind(k, String(v ?? "")).run();
  }

  return withCors(ok({ updated: entries.map(([k]) => k), ts: now }));
}

// GET /api/settings/public
if (path === "/api/settings/public" && req.method === "GET") {
  const rows = await env.DB.prepare(
    "SELECT key, value FROM system_settings WHERE key IN ('site_name','site_tagline')"
  ).all();

  const map = {};
  for (const r of rows.results || []) map[r.key] = r.value;

  return withCors(ok({
    settings: {
      site_name: map.site_name || "SHOP",
      site_tagline: map.site_tagline || "Chợ đồ số & tài khoản"
    }
  }));
}


// ===== CREATE DEPOSIT =====
if (path === "/api/deposits/create" && req.method === "POST") {
  const u = await requireAuth(req, env);
  if (!u) return withCors(bad("Unauthorized", 401));

  const body = await readJson(req);
  if (!body) return withCors(bad("Invalid JSON"));

  const method = String(body.method || "");
  const gross = Number(body.amount_cents || 0);

  if (!["bank","card"].includes(method))
    return withCors(bad("Invalid method"));

  if (!Number.isFinite(gross) || gross <= 0)
    return withCors(bad("Invalid amount"));

  /* ================= LOAD SETTINGS ================= */
  const sRows = await env.DB.prepare(
    "SELECT key,value FROM system_settings"
  ).all();

  const s = {};
  for (const r of (sRows.results || [])) s[r.key] = r.value;

  /* ================= AMOUNT ================= */
  const amount = Math.floor(gross / 100); // VNĐ

  const bankFeePercent = Number(s.bank_fee_percent || "0");
  const cardFeePercent = Number(s.card_fee_percent || "0");

  const feePercent = method === "bank" ? bankFeePercent : cardFeePercent;
  const fee = Math.round(amount * (feePercent / 100));
  const net = Math.max(0, amount - fee);

  /* ================= BANK INFO (KEY MỚI) ================= */
  const bank_name = s.bank_name;
  const bank_account_name = s.bank_account_name;
  const bank_account_number = s.bank_account_number;
  const prefix = String(s.bank_transfer_prefix || "NAP");

  if (method === "bank") {
    if (!bank_name || !bank_account_name || !bank_account_number) {
      return withCors(bad("Bank config missing", 500));
    }
  }

  /* ================= CREATE DEPOSIT ================= */
  const id = crypto.randomUUID();
  const now = Date.now();
  const provider = method === "bank"
    ? "bank_manual"
    : (s.card_provider || "thesieure");

  await env.DB.prepare(
    `INSERT INTO deposits
     (id, user_id, provider, gross_cents, fee_cents, net_cents,
      status, provider_txn_id, raw_payload, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'pending', NULL, NULL, ?, ?)`
  ).bind(
    id,
    u.userId,
    provider,
    gross,
    Math.round(fee * 100),
    Math.round(net * 100),
    now,
    now
  ).run();

  /* ================= PAY CODE ================= */
  const payCode = `${prefix}${id.slice(0, 8)}`;

  /* ================= BANK CODE MAP ================= */
  function mapBankCode(name) {
    const n = name.toLowerCase();
    if (n.includes("acb")) return "ACB";
    if (n.includes("mb")) return "MB";
    if (n.includes("vietcom")) return "VCB";
    if (n.includes("bidv")) return "BIDV";
    if (n.includes("tech")) return "TCB";
    return name.toUpperCase(); // fallback nếu admin nhập đúng code
  }

  /* ================= RESPONSE ================= */
  return withCors(ok({
    ok: true,
    deposit_id: id,
    method,

    // bank info cho frontend
    bank_code: method === "bank" ? mapBankCode(bank_name) : null,
    bank_name: bank_name || null,
    bank_account_name: bank_account_name || null,
    bank_account_number: bank_account_number || null,

    // money (VNĐ)
    amount,
    fee,
    net,

    pay_code: payCode,
    message:
      method === "bank"
        ? `Chuyển khoản đúng nội dung: ${payCode}`
        : `Nạp thẻ: hệ thống sẽ tự xử lý, mã: ${payCode}`
  }));
}

// ===== USER GET MY DEPOSITS =====
if (path === "/api/deposits/my" && req.method === "GET") {
  const u = await requireAuth(req, env);
  if (!u) return withCors(bad("Unauthorized", 401));

  const rows = await env.DB.prepare(`
    SELECT
      id,
      provider,
      gross_cents,
      fee_cents,
      net_cents,
      status,
      created_at
    FROM deposits
    WHERE user_id = ?
    ORDER BY created_at DESC
    LIMIT 50
  `).bind(u.userId).all();

  const items = (rows.results || []).map(r => ({
    id: r.id,
    provider: r.provider,
    gross: Math.floor(r.gross_cents / 100),
    fee: Math.floor(r.fee_cents / 100),
    net: Math.floor(r.net_cents / 100),
    status: r.status,
    created_at: r.created_at
  }));

  const res = ok({ items });
  res.headers.set("Cache-Control", "no-store");
  return withCors(res);
}


// ===== ADMIN MARK DEPOSIT PAID (manual/bridge) =====
if (path.startsWith("/api/admin/deposits/") && path.endsWith("/mark-paid") && req.method === "POST") {
  const admin = await requireAdmin(req, env);
  if (!admin) return withCors(bad("Unauthorized", 401));

  const parts = path.split("/");
  const depId = parts[4]; // /api/admin/deposits/{id}/mark-paid

  const dep = await env.DB.prepare("SELECT * FROM deposits WHERE id=?").bind(depId).first();
  if (!dep) return withCors(bad("Not found", 404));
  if (dep.status !== "pending") return withCors(bad("Already processed", 409));

  const now = Date.now();

  // cộng ví user
  await env.DB.prepare("UPDATE wallets SET balance_cents = balance_cents + ?, updated_at=? WHERE user_id=?")
    .bind(dep.net_cents, now, dep.user_id).run();

  // ledger
  await env.DB.prepare(
    `INSERT INTO wallet_ledger (id, user_id, type, amount_cents, ref_type, ref_id, note, created_at)
     VALUES (?, ?, 'deposit', ?, 'deposit', ?, ?, ?)`
  ).bind(crypto.randomUUID(), dep.user_id, dep.net_cents, dep.id, "Nạp tiền", now).run();

  // update tổng nạp để tính quota
  await env.DB.prepare("UPDATE users SET total_deposit_cents = total_deposit_cents + ?, updated_at=? WHERE id=?")
    .bind(dep.net_cents, now, dep.user_id).run();

  await env.DB.prepare("UPDATE deposits SET status='paid', updated_at=? WHERE id=?")
    .bind(now, dep.id).run();

  return withCors(ok({ status: "paid" }));
}

// ===== CARD WEBHOOK (generic) =====
if (path === "/api/webhooks/card" && req.method === "POST") {
  const body = await readJson(req);
  if (!body) return withCors(bad("Invalid JSON"));

  // bạn map theo provider:
  // - deposit_id (hoặc request_id)
  // - status: success/failed
  // - provider_txn_id
  // - gross_cents (nếu provider trả)
  const deposit_key = String(body.deposit_id || body.request_id || "");

  // Thế giới nạp thẻ hay trả status kiểu số (1=success, khác=fail) hoặc chuỗi.
  const stRaw = body.status;
  const status = normalizeCardStatus(stRaw);

  // trans_id của provider (nếu có)
  const provider_txn_id = String(body.provider_txn_id || body.trans_id || "");

  if (!deposit_key) return withCors(bad("Missing deposit_id"));

  // verify callback signature (nếu provider gửi)
  // Theo tài liệu chargingws/v2: callback_sign = md5(partner_key + card_code + card_serial)
  // (card_code = code, card_serial = serial)
  if (body.sign && body.code && body.serial) {
    const s = await getSettings(env);
    const partnerKey = String(s.card_api_key || "");
    if (partnerKey) {
      const expected = md5(partnerKey + String(body.code) + String(body.serial));
      if (String(body.sign) !== expected) {
        return withCors(bad("Invalid signature", 403));
      }
    }
  }

  // deposit_key có thể là UUID (id) hoặc request_id (đang lưu ở provider_txn_id)
  let dep = await env.DB.prepare("SELECT * FROM deposits WHERE id=?").bind(deposit_key).first();
  if (!dep) {
    dep = await env.DB.prepare("SELECT * FROM deposits WHERE provider_txn_id=?").bind(deposit_key).first();
  }
  if (!dep) return withCors(bad("Not found", 404));
  if (dep.status !== "pending") return withCors(ok({ status: dep.status })); // idempotent

  if (status !== "success") {
    await env.DB.prepare("UPDATE deposits SET status='failed', provider_txn_id=?, raw_payload=?, updated_at=? WHERE id=?")
      .bind(provider_txn_id || null, JSON.stringify(body), Date.now(), dep.id).run();
    return withCors(ok({ status: "failed" }));
  }

  const now = Date.now();

  // cộng ví
  await env.DB.prepare("UPDATE wallets SET balance_cents = balance_cents + ?, updated_at=? WHERE user_id=?")
    .bind(dep.net_cents, now, dep.user_id).run();

  await env.DB.prepare(
    `INSERT INTO wallet_ledger (id, user_id, type, amount_cents, ref_type, ref_id, note, created_at)
     VALUES (?, ?, 'deposit', ?, 'deposit', ?, ?, ?)`
  ).bind(crypto.randomUUID(), dep.user_id, dep.net_cents, dep.id, "Nạp thẻ", now).run();

  await env.DB.prepare("UPDATE users SET total_deposit_cents = total_deposit_cents + ?, updated_at=? WHERE id=?")
    .bind(dep.net_cents, now, dep.user_id).run();

  await env.DB.prepare("UPDATE deposits SET status='paid', provider_txn_id=?, raw_payload=?, updated_at=? WHERE id=?")
    .bind(provider_txn_id || null, JSON.stringify(body), now, dep.id).run();

  return withCors(ok({ status: "paid" }));
}


      // GET /api/orders/:id
      if (path.startsWith("/api/orders/") && req.method === "GET" && !path.endsWith("/secret") && !path.endsWith("/feedback")) {
        const u = await requireAuth(req, env);
        if (!u) return withCors(bad("Unauthorized", 401));

        const orderId = path.split("/").pop();
        const order = await env.DB.prepare("SELECT * FROM orders WHERE id=?").bind(orderId).first();
        if (!order) return withCors(bad("Not found", 404));
        if (order.buyer_id !== u.userId && order.seller_id !== u.userId && u.role !== "admin") {
          return withCors(bad("Forbidden", 403));
        }

// ===== AUTO TRUST FOR AC AFTER 3 MINUTES =====
const listingInfo = await env.DB.prepare(
  "SELECT kind FROM listings WHERE id=?"
).bind(order.listing_id).first();

if (listingInfo?.kind === "ac") {
  const deadline = order.created_at + 3 * 60 * 1000;

  if (Date.now() > deadline && order.status === "paid") {
    const fb = await env.DB.prepare(
      "SELECT order_id FROM feedback WHERE order_id=?"
    ).bind(order.id).first();

    if (!fb) {
      // auto trust
      await env.DB.prepare(
        `INSERT INTO feedback (order_id, buyer_id, seller_id, type, note, created_at)
         VALUES (?, ?, ?, 'trust', 'Auto trust (AC warranty expired)', ?)`
      ).bind(
        order.id,
        order.buyer_id,
        order.seller_id,
        Date.now()
      ).run().catch(() => {});

      await env.DB.prepare(
        "UPDATE users SET reputation = reputation + 1, updated_at=? WHERE id=?"
      ).bind(Date.now(), order.seller_id).run().catch(() => {});
    }
  }
}

        return withCors(ok({ order }));
      }

      // GET /api/orders/:id/secret
      if (path.startsWith("/api/orders/") && path.endsWith("/secret") && req.method === "GET") {
        const u = await requireAuth(req, env);
        if (!u) return withCors(bad("Unauthorized", 401));

        const parts = path.split("/");
        const orderId = parts[3];

        const order = await env.DB.prepare("SELECT * FROM orders WHERE id=?").bind(orderId).first();
        if (!order) return withCors(bad("Not found", 404));
        if (order.buyer_id !== u.userId) return withCors(bad("Forbidden", 403));
        if (order.status !== "paid") return withCors(bad("Order not paid", 400));

        const listing = await env.DB.prepare("SELECT kind FROM listings WHERE id=?").bind(order.listing_id).first();
        if (!listing || listing.kind !== "ac") return withCors(bad("Not an AC order", 400));

        const secret = await env.DB.prepare("SELECT encrypted_blob FROM listing_secrets WHERE listing_id=?")
          .bind(order.listing_id)
          .first();
        if (!secret) return withCors(bad("Secret not found", 404));

        return withCors(ok({ secret_txt: secret.encrypted_blob }));
      }

      // POST /api/orders/:id/feedback
      if (path.startsWith("/api/orders/") && path.endsWith("/feedback") && req.method === "POST") {
        const u = await requireAuth(req, env);
        if (!u) return withCors(bad("Unauthorized", 401));

        const parts = path.split("/");
        const orderId = parts[3];

        const body = await readJson(req);
        if (!body) return withCors(bad("Invalid JSON"));

        const { type, note } = body;
        if (type !== "trust" && type !== "scam") return withCors(bad("Invalid type"));

        const order = await env.DB.prepare("SELECT * FROM orders WHERE id=?").bind(orderId).first();
        if (!order) return withCors(bad("Not found", 404));
        if (order.buyer_id !== u.userId) return withCors(bad("Forbidden", 403));

        try {
          await env.DB.prepare(
            `INSERT INTO feedback (order_id, buyer_id, seller_id, type, note, created_at)
             VALUES (?, ?, ?, ?, ?, ?)`
          )
            .bind(orderId, u.userId, order.seller_id, type, note ? String(note) : null, Date.now())
            .run();
        } catch (e) {
          console.error("FEEDBACK ERROR:", e);
          return withCors(bad("Already feedbacked", 409));
        }

        if (type === "trust") {
          await env.DB.prepare("UPDATE users SET reputation = reputation + 1, updated_at=? WHERE id=?")
            .bind(Date.now(), order.seller_id)
            .run();
        } else {
          await env.DB.prepare("UPDATE orders SET status='disputed' WHERE id=?").bind(orderId).run();
        }

        return withCors(ok());
      }

      // ===== ADMIN DECIDE WITHDRAW =====
if (path.startsWith("/api/admin/withdrawals/") && path.endsWith("/decision") && req.method === "POST") {
  const admin = await requireAdmin(req, env);
  if (!admin) return withCors(bad("Unauthorized", 401));

  const id = path.split("/")[4];
  const body = await readJson(req);
  if (!body || !body.action) return withCors(bad("Missing action"));

  const w = await env.DB.prepare(
    "SELECT * FROM withdrawals WHERE id=?"
  ).bind(id).first();

  if (!w) return withCors(bad("Not found", 404));
  if (w.status !== "pending") return withCors(bad("Already processed", 409));

  const now = Date.now();

  // ===== HỦY =====
  if (body.action === "reject") {
    // hoàn tiền nhưng trừ phí 2%
    await env.DB.prepare(
      "UPDATE wallets SET balance_cents = balance_cents + ?, updated_at=? WHERE user_id=?"
    ).bind(w.net_cents, now, w.user_id).run();

    await env.DB.prepare(
      `INSERT INTO wallet_ledger
       (id, user_id, type, amount_cents, ref_type, ref_id, note, created_at)
       VALUES (?, ?, 'refund', ?, 'withdraw', ?, ?, ?)`
    ).bind(
      crypto.randomUUID(),
      w.user_id,
      w.net_cents,
      w.id,
      "Hoàn tiền rút (bị trừ 2% phí)",
      now
    ).run();

    await env.DB.prepare(
      "UPDATE withdrawals SET status='rejected', admin_id=?, updated_at=? WHERE id=?"
    ).bind(admin.userId, now, id).run();

    return withCors(ok({ status: "rejected" }));
  }

  // ===== HOÀN THÀNH =====
  if (body.action === "approve") {
    await env.DB.prepare(
      "UPDATE withdrawals SET status='paid', admin_id=?, updated_at=? WHERE id=?"
    ).bind(admin.userId, now, id).run();

    return withCors(ok({ status: "paid" }));
  }

  return withCors(bad("Invalid action"));
}

// POST /api/webhooks/card  (Thesieure callback)
if (path === "/api/webhooks/card" && req.method === "POST") {
  try {
    // Thesieure thường gửi form-data (x-www-form-urlencoded)
    const ct = req.headers.get("content-type") || "";
    let data = {};

    if (ct.includes("application/json")) {
      data = await req.json();
    } else {
      const form = await req.formData();
      for (const [k, v] of form.entries()) data[k] = String(v);
    }

    // Lấy settings
    const partnerIdRow = await env.DB.prepare(
      "SELECT value FROM system_settings WHERE key='card_partner_id'"
    ).first();
    const partnerKeyRow = await env.DB.prepare(
      "SELECT value FROM system_settings WHERE key='card_api_key'"
    ).first();

    const partnerKey = partnerKeyRow?.value || "";
    if (!partnerKey) return withCors(bad("Missing partner key", 500));

    // Verify signature (đang dùng giống submit: md5(partnerKey + code + serial))
    const code = data.code || "";
    const serial = data.serial || "";
    const sign = data.sign || data.signature || "";
    const mySign = md5(partnerKey + code + serial);

    if (!sign || sign !== mySign) {
      return withCors(bad("INVALID_SIGNATURE", 400));
    }

    // request_id bạn gửi khi submit
    const requestId = data.request_id || data.requestId || data.trans_id || "";
    if (!requestId) return withCors(bad("Missing request_id", 400));

    // status tuỳ Thesieure: success/failed/pending...
    const statusRaw = (data.status || data.status_card || "").toLowerCase();

    // map status
    let newStatus = "pending";
    if (statusRaw.includes("success") || statusRaw === "1") newStatus = "success";
    if (statusRaw.includes("fail") || statusRaw === "0") newStatus = "failed";

    // value/amount (mệnh giá thực nhận từ nhà mạng)
    const value = Number(String(data.value || data.amount || "0").replace(/\D/g, ""));
    const grossCents = Math.max(0, value) * 100;

    // fee % lấy từ settings
    const feeRow = await env.DB.prepare(
      "SELECT value FROM system_settings WHERE key='card_fee_percent'"
    ).first();
    const feePercent = Number(feeRow?.value || 0);
    const feeCents = Math.round(grossCents * (feePercent / 100));
    const netCents = Math.max(0, grossCents - feeCents);

    // Update deposits theo request_id (bạn nhớ lúc submit đã INSERT request_id vào deposits)
    await env.DB.prepare(`
      UPDATE deposits
      SET gross_cents=?, fee_cents=?, net_cents=?, status=?, updated_at=?
      WHERE id=? OR provider_ref=?
    `).bind(
      grossCents, feeCents, netCents, newStatus, Date.now(),
      requestId, requestId
    ).run();

    // Nếu success thì cộng ví (nếu bạn muốn cộng ở callback)
    // (tuỳ bạn thiết kế: có nơi cộng ngay lúc callback success)
    // -- Ví dụ (cần join deposits để lấy user_id):
    // const dep = await env.DB.prepare("SELECT user_id FROM deposits WHERE id=? OR provider_ref=?")
    //   .bind(requestId, requestId).first();
    // if (newStatus === "success" && dep?.user_id) { ... cộng wallets ... }

    // Thesieure thường chỉ cần trả "OK"
    return withCors(new Response("OK", { status: 200 }));
  } catch (e) {
    return withCors(bad("Server error", 500));
  }
}


// ===== ADMIN LIST WITHDRAWALS =====
if (path === "/api/admin/withdrawals" && req.method === "GET") {
  const admin = await requireAdmin(req, env);
  if (!admin) return withCors(bad("Unauthorized", 401));

  const rows = await env.DB.prepare(
    `SELECT w.*, u.username
     FROM withdrawals w
     JOIN users u ON u.id=w.user_id
     WHERE w.status='pending'
     ORDER BY w.created_at DESC`
  ).all();

  return withCors(ok({ items: rows.results || [] }));
}

// ===== ADMIN DASHBOARD =====
if (path === "/api/admin/dashboard" && req.method === "GET") {
  const admin = await requireAdmin(req, env);
  if (!admin) return withCors(bad("Unauthorized", 401));

  const users = await env.DB.prepare(
    "SELECT COUNT(*) as total, SUM(status='active') as active FROM users"
  ).first();

  const listings = await env.DB.prepare(
    "SELECT COUNT(*) as total FROM listings WHERE status='active'"
  ).first();

  const balances = await env.DB.prepare(
    "SELECT SUM(balance_cents) as total FROM wallets"
  ).first();

  const disputes = await env.DB.prepare(
    "SELECT COUNT(*) as total FROM disputes WHERE status='open'"
  ).first();

  const withdrawals = await env.DB.prepare(
    "SELECT COUNT(*) as total FROM withdrawals WHERE status='pending'"
  ).first();

  return withCors(ok({
    users: {
      total: users?.total || 0,
      active: users?.active || 0
    },
    listings: listings?.total || 0,
    wallet_total_cents: balances?.total || 0,
    disputes: disputes?.total || 0,
    withdrawals: withdrawals?.total || 0
  }));
}


// ===== WITHDRAW (MANUAL) =====
if (path === "/api/withdraw" && req.method === "POST") {
  const u = await requireAuth(req, env);
  if (!u) return withCors(bad("Unauthorized", 401));

  const body = await readJson(req);
  if (!body) return withCors(bad("Invalid JSON"));

  const { method, amount_cents, bank, card } = body;

  if (!method || !amount_cents || amount_cents <= 0) {
    return withCors(bad("Missing fields"));
  }

  if (method !== "bank" && method !== "thesieure") {
    return withCors(bad("Invalid method"));
  }

  // kiểm tra số dư
  const wallet = await env.DB.prepare(
    "SELECT balance_cents FROM wallets WHERE user_id=?"
  ).bind(u.userId).first();

  if (!wallet || wallet.balance_cents < amount_cents) {
    return withCors(bad("Insufficient balance"));
  }

  // validate info
  let bankInfo = "";

  if (method === "bank") {
    if (!bank?.name || !bank?.owner || !bank?.number) {
      return withCors(bad("Missing bank info"));
    }
    bankInfo = JSON.stringify({
      type: "bank",
      name: bank.name,
      owner: bank.owner,
      number: bank.number
    });
  }

  if (method === "thesieure") {
    if (!card?.username || !card?.contact) {
      return withCors(bad("Missing card info"));
    }
    bankInfo = JSON.stringify({
      type: "thesieure",
      username: card.username,
      contact: card.contact
    });
  }

  const fee = Math.round(amount_cents * 0.02); // 2% phí
  const net = amount_cents - fee;
  const now = Date.now();
  const wid = crypto.randomUUID();

  // trừ tiền user
  await env.DB.prepare(
    "UPDATE wallets SET balance_cents = balance_cents - ?, updated_at=? WHERE user_id=?"
  ).bind(amount_cents, now, u.userId).run();

  // ghi withdrawal
  await env.DB.prepare(
    `INSERT INTO withdrawals
     (id, user_id, gross_cents, fee_cents, net_cents, bank_info, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)`
  ).bind(
    wid,
    u.userId,
    amount_cents,
    fee,
    net,
    bankInfo,
    now,
    now
  ).run();

  // ghi ledger
  await env.DB.prepare(
    `INSERT INTO wallet_ledger
     (id, user_id, type, amount_cents, ref_type, ref_id, note, created_at)
     VALUES (?, ?, 'withdraw', ?, 'withdraw', ?, ?, ?)`
  ).bind(
    crypto.randomUUID(),
    u.userId,
    -amount_cents,
    wid,
    "Rút tiền (chờ duyệt)",
    now
  ).run();

  return withCors(ok({
    withdraw_id: wid,
    message: "Đơn của bạn sẽ được duyệt sau 2 ngày"
  }));
}

// ===== SUBMIT CARD (chargingws/v2) =====
// Lưu ý:
// - telco phải dạng VIETTEL / MOBIFONE / VINAPHONE / VNMOBI
// - sign = md5(partner_key + code + command + partner_id + request_id + serial + telco)
if (path === "/api/card/submit" && req.method === "POST") {
  const u = await requireAuth(req, env);
  if (!u) return withCors(bad("Unauthorized", 401));

  const body = await readJson(req);
  const card = body?.card;
  if (!card) return withCors(bad("Missing card info"));

  const telco = normalizeTelco(card.type);
  const amount = Number(card.amount);
  const code = String(card.code || "").trim();
  const serial = String(card.serial || "").trim();

  if (!telco || !code || !serial || !Number.isFinite(amount) || amount <= 0) {
    return withCors(bad("Invalid card data"));
  }

  // load settings
  const rows = await env.DB.prepare("SELECT key,value FROM system_settings").all();
  const s = {};
  for (const r of rows.results || []) s[r.key] = r.value;

  if ((s.card_provider || "thesieure") !== "thesieure") {
    return withCors(bad("Card provider not enabled"));
  }

  // card_partner_id = partner_id, card_api_key = partner_key (secret)
  const partnerId = String(s.card_partner_id || "").trim();
  const partnerKey = String(s.card_api_key || "").trim();
  if (!partnerId || !partnerKey) {
    return withCors(bad("Card settings missing (partner_id / partner_key)"));
  }

  const feePercent = Number(s.card_fee_percent || "0");
  const gross = amount;
  const fee = Math.round(gross * (feePercent / 100));
  const net = Math.max(0, gross - fee);

  const depositId = crypto.randomUUID();
  const requestId = depositId.replaceAll("-", "");
  const now = Date.now();

  // 1) tạo deposit pending (lưu requestId vào provider_txn_id để đối soát callback)
  await env.DB.prepare(
    `INSERT INTO deposits
     (id, user_id, provider, gross_cents, fee_cents, net_cents, status, provider_txn_id, raw_payload, created_at, updated_at)
     VALUES (?, ?, 'thesieure', ?, ?, ?, 'pending', ?, ?, ?, ?)`
  ).bind(
    depositId,
    u.userId,
    Math.round(gross * 100),
    Math.round(fee * 100),
    Math.round(net * 100),
    requestId,
    JSON.stringify({
      request_id: requestId,
      telco,
      amount: gross,
      code_last4: code.slice(-4),
      serial_last4: serial.slice(-4)
    }),
    now,
    now
  ).run();

  // 2) gọi API chargingws/v2
  const command = "charging";
  const sign = md5(partnerKey + code + command + partnerId + requestId + serial + telco);

  const payload = {
    partner_id: partnerId,
    request_id: requestId,
    telco,
    amount: gross,
    code,
    serial,
    command,
    sign
  };

  // Một số bên cho set callback_url; nếu không hỗ trợ thì họ sẽ ignore.
  const cbDomain = String(s.card_callback_domain || "").trim().replace(/^https?:\/\//i, "");
  if (cbDomain) payload.callback_url = `https://${cbDomain}/api/webhooks/card`;

  let data = null;
  try {
    const resp = await fetch("https://napthesieure.vn/chargingws/v2", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    data = await resp.json().catch(() => null);
  } catch (e) {
    data = { status: -1, message: "FETCH_ERROR", detail: String(e?.message || e) };
  }

  // status thường: 1 (nhận thẻ) hoặc 99 (đang xử lý)
  const st = Number(data?.status);
  const accepted = st === 1 || st === 99;

  await env.DB.prepare(
    "UPDATE deposits SET raw_payload=?, updated_at=? WHERE id=?"
  ).bind(JSON.stringify({ submit: data }), Date.now(), depositId).run();

  if (!accepted) {
    await env.DB.prepare(
      "UPDATE deposits SET status='failed', updated_at=? WHERE id=?"
    ).bind(Date.now(), depositId).run();

    return withCors(bad(data?.message || "Card rejected"));
  }

  return withCors(ok({
    deposit_id: depositId,
    request_id: requestId,
    message: data?.message || "Thẻ đã gửi, đang chờ xử lý"
  }));
}

async function depositCard() {
  if (!card_type.value || !card_amount.value || !card_code.value || !card_serial.value)
    return alert("Nhập đầy đủ thông tin thẻ");

  const r = await apiPost("/api/card/submit", {
    card: {
      type: card_type.value,
      amount: Number(card_amount.value),
      code: card_code.value,
      serial: card_serial.value
    }
  });

  if (!r.ok) return alert(r.error || "Nạp thẻ thất bại");

  card_out.innerHTML = `
    <div class="note">
      <b>Đã gửi thẻ thành công</b><br>
      <p class="muted">Thẻ đang được xử lý, tiền sẽ vào ví sau vài giây.</p>
    </div>
  `;
}

// ===== MY DEPOSITS HISTORY =====
if (path === "/api/my/deposits" && req.method === "GET") {
  const u = await requireAuth(req, env);
  if (!u) return withCors(bad("Unauthorized", 401));

  const rows = await env.DB.prepare(
    `SELECT
        id,
        provider,
        gross_cents,
        fee_cents,
        net_cents,
        status,
        created_at
     FROM deposits
     WHERE user_id=?
     ORDER BY created_at DESC
     LIMIT 100`
  ).bind(u.userId).all();

  return withCors(ok({
    items: rows.results || []
  }));
}


      // -------- DISPUTES --------
      if (path === "/api/disputes" && req.method === "POST") {
        const u = await requireAuth(req, env);
        if (!u) return withCors(bad("Unauthorized", 401));

        const body = await readJson(req);
        if (!body) return withCors(bad("Invalid JSON"));

        const { order_id, description, evidence_image_key } = body;
        if (!order_id || !description) return withCors(bad("Missing fields"));

        const order = await env.DB.prepare("SELECT * FROM orders WHERE id=?").bind(String(order_id)).first();
        if (!order) return withCors(bad("Order not found", 404));
        if (order.buyer_id !== u.userId) return withCors(bad("Forbidden", 403));

        const now = Date.now();
        const disputeId = crypto.randomUUID();

        try {
          await env.DB.prepare(
            `INSERT INTO disputes (id, order_id, buyer_id, seller_id, description, evidence_image_key, status, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, 'open', ?, ?)`
          )
            .bind(
              disputeId,
              order.id,
              u.userId,
              order.seller_id,
              String(description),
              evidence_image_key ? String(evidence_image_key) : null,
              now,
              now
            )
            .run();
        } catch (e) {
          console.error("DISPUTE CREATE ERROR:", e);
          return withCors(bad("Dispute already exists for this order", 409));
        }

        await env.DB.prepare("UPDATE orders SET status='disputed' WHERE id=?").bind(order.id).run();
        return withCors(ok({ dispute_id: disputeId }));
      }

      // -------- ADMIN decision --------
      if (path.startsWith("/api/admin/disputes/") && path.endsWith("/decision") && req.method === "POST") {
        const admin = await requireAdmin(req, env);
        if (!admin) return withCors(bad("Unauthorized", 401));

        const parts = path.split("/");
        const disputeId = parts[4];

        const body = await readJson(req);
        if (!body) return withCors(bad("Invalid JSON"));

        const { action, admin_note } = body;
        if (action !== "approve" && action !== "reject") return withCors(bad("Invalid action"));

        const dispute = await env.DB.prepare("SELECT * FROM disputes WHERE id=?").bind(disputeId).first();
        if (!dispute) return withCors(bad("Not found", 404));
        if (dispute.status !== "open") return withCors(bad("Already decided", 409));

        const order = await env.DB.prepare("SELECT * FROM orders WHERE id=?").bind(dispute.order_id).first();
        if (!order) return withCors(bad("Order not found", 404));

        const now = Date.now();

        if (action === "reject") {
          await env.DB.prepare("UPDATE disputes SET status='rejected', admin_id=?, admin_note=?, updated_at=? WHERE id=?")
            .bind(admin.userId, admin_note ? String(admin_note) : null, now, disputeId)
            .run();
          return withCors(ok());
        }

        try {
          await env.DB.prepare("BEGIN").run();

          await env.DB.prepare("UPDATE wallets SET balance_cents = balance_cents + ?, updated_at=? WHERE user_id=?")
            .bind(order.subtotal_cents, now, order.buyer_id)
            .run();

          await env.DB.prepare(
            `INSERT INTO wallet_ledger (id, user_id, type, amount_cents, ref_type, ref_id, note, created_at)
             VALUES (?, ?, 'refund', ?, 'dispute', ?, ?, ?)`
          )
            .bind(crypto.randomUUID(), order.buyer_id, order.subtotal_cents, disputeId, `Refund order ${order.id}`, now)
            .run();

          await env.DB.prepare("UPDATE wallets SET balance_cents = balance_cents - ?, updated_at=? WHERE user_id=?")
            .bind(order.seller_income_cents, now, order.seller_id)
            .run();

          await env.DB.prepare(
            `INSERT INTO wallet_ledger (id, user_id, type, amount_cents, ref_type, ref_id, note, created_at)
             VALUES (?, ?, 'adjustment', ?, 'dispute', ?, ?, ?)`
          )
            .bind(
              crypto.randomUUID(),
              order.seller_id,
              -order.seller_income_cents,
              disputeId,
              `Chargeback order ${order.id}`,
              now
            )
            .run();

          await env.DB.prepare("UPDATE users SET status='banned', updated_at=? WHERE id=?")
            .bind(now, order.seller_id)
            .run();

          await env.DB.prepare("UPDATE orders SET status='refunded' WHERE id=?").bind(order.id).run();

          await env.DB.prepare("UPDATE disputes SET status='approved', admin_id=?, admin_note=?, updated_at=? WHERE id=?")
            .bind(admin.userId, admin_note ? String(admin_note) : null, now, disputeId)
            .run();

          await env.DB.prepare("COMMIT").run();
        } catch (e) {
          console.error("ADMIN APPROVE ERROR:", e);
          await env.DB.prepare("ROLLBACK").run().catch(() => {});
          return withCors(bad("Approve failed", 500));
        }

        return withCors(ok());
      }

      return withCors(bad("Not found", 404));
    } catch (e) {
      console.error("FATAL API ERROR:", e);
      return withCors(json({ ok: false, error: "Server error" }, 500));
    }
  },
};

// ===== helpers =====
function corsHeaders(req) {
  const origin = req.headers.get("Origin") || "*";
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Credentials": "true",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET,POST,PATCH,DELETE,OPTIONS",
  };
}

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...extraHeaders },
  });
}

function ok(data = {}) {
  return json({ ok: true, ...data });
}

function bad(message, status = 400) {
  return json({ ok: false, error: message }, status);
}

// ============================
// md5 (pure JS) – dùng để ký API nạp thẻ /chargingws/v2
// WebCrypto trên Workers thường không có MD5 nên phải dùng bản JS.
// ============================
function md5(str) {
  return hex(md51(String(str)));
}

function md51(s) {
  const txt = "";
  let n = s.length;
  const state = [1732584193, -271733879, -1732584194, 271733878];
  let i;
  for (i = 64; i <= n; i += 64) {
    md5cycle(state, md5blk(s.substring(i - 64, i)));
  }
  s = s.substring(i - 64);
  const tail = new Array(16).fill(0);
  for (i = 0; i < s.length; i++) tail[i >> 2] |= s.charCodeAt(i) << ((i % 4) << 3);
  tail[i >> 2] |= 0x80 << ((i % 4) << 3);
  if (i > 55) {
    md5cycle(state, tail);
    for (i = 0; i < 16; i++) tail[i] = 0;
  }
  // eslint-disable-next-line no-bitwise
  tail[14] = n * 8;
  md5cycle(state, tail);
  return state;
}

function md5blk(s) {
  const md5blks = [];
  for (let i = 0; i < 64; i += 4) {
    md5blks[i >> 2] =
      s.charCodeAt(i) +
      (s.charCodeAt(i + 1) << 8) +
      (s.charCodeAt(i + 2) << 16) +
      (s.charCodeAt(i + 3) << 24);
  }
  return md5blks;
}

function md5cycle(x, k) {
  let a = x[0];
  let b = x[1];
  let c = x[2];
  let d = x[3];

  a = ff(a, b, c, d, k[0], 7, -680876936);
  d = ff(d, a, b, c, k[1], 12, -389564586);
  c = ff(c, d, a, b, k[2], 17, 606105819);
  b = ff(b, c, d, a, k[3], 22, -1044525330);
  a = ff(a, b, c, d, k[4], 7, -176418897);
  d = ff(d, a, b, c, k[5], 12, 1200080426);
  c = ff(c, d, a, b, k[6], 17, -1473231341);
  b = ff(b, c, d, a, k[7], 22, -45705983);
  a = ff(a, b, c, d, k[8], 7, 1770035416);
  d = ff(d, a, b, c, k[9], 12, -1958414417);
  c = ff(c, d, a, b, k[10], 17, -42063);
  b = ff(b, c, d, a, k[11], 22, -1990404162);
  a = ff(a, b, c, d, k[12], 7, 1804603682);
  d = ff(d, a, b, c, k[13], 12, -40341101);
  c = ff(c, d, a, b, k[14], 17, -1502002290);
  b = ff(b, c, d, a, k[15], 22, 1236535329);

  a = gg(a, b, c, d, k[1], 5, -165796510);
  d = gg(d, a, b, c, k[6], 9, -1069501632);
  c = gg(c, d, a, b, k[11], 14, 643717713);
  b = gg(b, c, d, a, k[0], 20, -373897302);
  a = gg(a, b, c, d, k[5], 5, -701558691);
  d = gg(d, a, b, c, k[10], 9, 38016083);
  c = gg(c, d, a, b, k[15], 14, -660478335);
  b = gg(b, c, d, a, k[4], 20, -405537848);
  a = gg(a, b, c, d, k[9], 5, 568446438);
  d = gg(d, a, b, c, k[14], 9, -1019803690);
  c = gg(c, d, a, b, k[3], 14, -187363961);
  b = gg(b, c, d, a, k[8], 20, 1163531501);
  a = gg(a, b, c, d, k[13], 5, -1444681467);
  d = gg(d, a, b, c, k[2], 9, -51403784);
  c = gg(c, d, a, b, k[7], 14, 1735328473);
  b = gg(b, c, d, a, k[12], 20, -1926607734);

  a = hh(a, b, c, d, k[5], 4, -378558);
  d = hh(d, a, b, c, k[8], 11, -2022574463);
  c = hh(c, d, a, b, k[11], 16, 1839030562);
  b = hh(b, c, d, a, k[14], 23, -35309556);
  a = hh(a, b, c, d, k[1], 4, -1530992060);
  d = hh(d, a, b, c, k[4], 11, 1272893353);
  c = hh(c, d, a, b, k[7], 16, -155497632);
  b = hh(b, c, d, a, k[10], 23, -1094730640);
  a = hh(a, b, c, d, k[13], 4, 681279174);
  d = hh(d, a, b, c, k[0], 11, -358537222);
  c = hh(c, d, a, b, k[3], 16, -722521979);
  b = hh(b, c, d, a, k[6], 23, 76029189);
  a = hh(a, b, c, d, k[9], 4, -640364487);
  d = hh(d, a, b, c, k[12], 11, -421815835);
  c = hh(c, d, a, b, k[15], 16, 530742520);
  b = hh(b, c, d, a, k[2], 23, -995338651);

  a = ii(a, b, c, d, k[0], 6, -198630844);
  d = ii(d, a, b, c, k[7], 10, 1126891415);
  c = ii(c, d, a, b, k[14], 15, -1416354905);
  b = ii(b, c, d, a, k[5], 21, -57434055);
  a = ii(a, b, c, d, k[12], 6, 1700485571);
  d = ii(d, a, b, c, k[3], 10, -1894986606);
  c = ii(c, d, a, b, k[10], 15, -1051523);
  b = ii(b, c, d, a, k[1], 21, -2054922799);
  a = ii(a, b, c, d, k[8], 6, 1873313359);
  d = ii(d, a, b, c, k[15], 10, -30611744);
  c = ii(c, d, a, b, k[6], 15, -1560198380);
  b = ii(b, c, d, a, k[13], 21, 1309151649);
  a = ii(a, b, c, d, k[4], 6, -145523070);
  d = ii(d, a, b, c, k[11], 10, -1120210379);
  c = ii(c, d, a, b, k[2], 15, 718787259);
  b = ii(b, c, d, a, k[9], 21, -343485551);

  x[0] = add32(a, x[0]);
  x[1] = add32(b, x[1]);
  x[2] = add32(c, x[2]);
  x[3] = add32(d, x[3]);
}

function cmn(q, a, b, x, s, t) {
  a = add32(add32(a, q), add32(x, t));
  return add32((a << s) | (a >>> (32 - s)), b);
}
function ff(a, b, c, d, x, s, t) { return cmn((b & c) | (~b & d), a, b, x, s, t); }
function gg(a, b, c, d, x, s, t) { return cmn((b & d) | (c & ~d), a, b, x, s, t); }
function hh(a, b, c, d, x, s, t) { return cmn(b ^ c ^ d, a, b, x, s, t); }
function ii(a, b, c, d, x, s, t) { return cmn(c ^ (b | ~d), a, b, x, s, t); }

function hex(x) {
  for (let i = 0; i < x.length; i++) x[i] = rhex(x[i]);
  return x.join("");
}

function rhex(n) {
  const s = "0123456789abcdef";
  let j = 0;
  let out = "";
  for (; j < 4; j++) out += s.charAt((n >> (j * 8 + 4)) & 0x0f) + s.charAt((n >> (j * 8)) & 0x0f);
  return out;
}

function add32(a, b) {
  // eslint-disable-next-line no-bitwise
  return (a + b) | 0;
}

function maskKeepLast4(v) {
  const s = String(v ?? "").replace(/\s+/g, "");
  if (s.length <= 4) return s;
  return "*".repeat(Math.max(0, s.length - 4)) + s.slice(-4);
}

function normalizeTelco(input) {
  const s = String(input ?? "").trim().toUpperCase();
  if (s === "VIETTEL" || s === "VIETTEL TELECOM") return "VIETTEL";
  if (s === "MOBIFONE" || s === "MOBI" || s === "MOBI FONE") return "MOBIFONE";
  if (s === "VINAPHONE" || s === "VINA" || s === "VINA PHONE") return "VINAPHONE";
  if (s === "VNMOBI" || s === "VIETNAMMOBILE" || s === "VIETNAM MOBILE") return "VNMOBI";
  return s;
}

function normalizeCardStatus(v) {
  const s = String(v ?? "").trim().toLowerCase();
  if (!s) return "failed";
  if (s === "success" || s === "paid" || s === "ok") return "success";
  if (s === "pending" || s === "processing" || s === "wait" || s === "99") return "pending";
  if (s === "failed" || s === "error" || s === "2" || s === "3" || s === "4") return "failed";
  // nếu provider trả số
  const n = Number(s);
  if (Number.isFinite(n)) return n === 1 ? "success" : n === 99 ? "pending" : "failed";
  return "failed";
}

function normalizeCallbackDomain(domain) {
  let d = String(domain ?? "").trim();
  if (!d) return "";
  d = d.replace(/^https?:\/\//i, "");
  d = d.replace(/\/+$/, "");
  return d;
}

function safeJsonStringify(obj) {
  try {
    return JSON.stringify(obj ?? null);
  } catch {
    return "";
  }
}

function getCookie(req, name) {
  const cookie = req.headers.get("Cookie") || "";
  const m = cookie.match(new RegExp(`(?:^|; )${name}=([^;]+)`));
  return m ? decodeURIComponent(m[1]) : null;
}

function setCookie(name, value, maxAgeSec) {
  return `${name}=${encodeURIComponent(value)}; HttpOnly; Secure; SameSite=None; Path=/; Max-Age=${maxAgeSec}`;
}

function clearCookie(name) {
  return `${name}=; HttpOnly; Secure; SameSite=None; Path=/; Max-Age=0`;
}


function ipPrefixFromReq(req) {
  const ip = req.headers.get("cf-connecting-ip") || "";
  if (ip.includes(".")) return ip.split(".").slice(0, 3).join(".");
  return ip;
}

async function sha256Hex(input) {
  const data = new TextEncoder().encode(input);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function readJson(req) {
  try {
    return await req.json();
  } catch {
    return null;
  }
}

// ===== PASSWORD HASH (SHA-256 + salt + pepper) =====
// Ổn định 100% trên Workers, không Buffer, không PBKDF2.
async function hashPassword(password, pepper) {
  if (!pepper || typeof pepper !== "string") throw new Error("PEPPER_INVALID");
  const salt = crypto.randomUUID();
  const hash = await sha256Hex(password + pepper + salt);
  return `sha256$${salt}$${hash}`;
}

async function verifyPassword(password, stored, pepper) {
  try {
    const [tag, salt, hash] = stored.split("$");
    if (tag !== "sha256") return false;
    const check = await sha256Hex(password + pepper + salt);
    return check === hash;
  } catch (e) {
    console.error("VERIFY PASSWORD ERROR:", e);
    return false;
  }
}

// ===== auth =====
async function getUserFromSession(req, env) {
  const token = getCookie(req, "session");
  if (!token) return null;

  const tokenHash = await sha256Hex(token);
  const session = await env.DB.prepare(
    "SELECT user_id, ua_hash, ip_prefix, expires_at FROM sessions WHERE token_hash=?"
  )
    .bind(tokenHash)
    .first();

  if (!session) return null;
  if (session.expires_at < Date.now()) return null;

  const ua = req.headers.get("user-agent") || "";
  const uaHash = await sha256Hex(ua);
  if (session.ua_hash && uaHash !== session.ua_hash) return null;

  const ipPrefix = ipPrefixFromReq(req);
  if (session.ip_prefix && ipPrefix !== session.ip_prefix) return null;

  const user = await env.DB.prepare("SELECT id, role, status FROM users WHERE id=?")
    .bind(session.user_id)
    .first();
  if (!user || user.status !== "active") return null;

  env.DB.prepare("UPDATE sessions SET last_seen_at=? WHERE token_hash=?")
    .bind(Date.now(), tokenHash)
    .run()
    .catch(() => {});

  return { userId: user.id, role: user.role };
}

async function requireAuth(req, env) {
  return await getUserFromSession(req, env);
}

async function requireAdmin(req, env) {
  const u = await getUserFromSession(req, env);
  if (!u || u.role !== "admin") return null;
  return u;
}

// ===== quota compute =====
async function computeQuota(env, userId) {
  const u = await env.DB.prepare("SELECT reputation, total_deposit_cents FROM users WHERE id=?").bind(userId).first();
  if (!u) return 0;

  const base = await env.DB.prepare(
    "SELECT COALESCE(SUM(bonus_slots),0) AS v FROM quota_rules WHERE kind='base' AND is_active=1"
  ).first();

  const dep = await env.DB.prepare(
    "SELECT COALESCE(SUM(bonus_slots),0) AS v FROM quota_rules WHERE kind='deposit' AND is_active=1 AND ? >= threshold_cents"
  )
    .bind(u.total_deposit_cents)
    .first();

  const rep = await env.DB.prepare(
    "SELECT COALESCE(SUM(bonus_slots),0) AS v FROM quota_rules WHERE kind='reputation' AND is_active=1 AND ? >= threshold_reputation"
  )
    .bind(u.reputation)
    .first();

  return (base?.v ?? 0) + (dep?.v ?? 0) + (rep?.v ?? 0);
}
