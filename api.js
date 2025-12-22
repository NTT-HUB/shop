export default {
  async fetch(req, env) {
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
      if (path === "/api/health") {
        return withCors(ok({ ts: Date.now() }));
      }

      if (path === "/api/_debug") {
        return withCors(ok({
          pepper: typeof env.PASSWORD_PEPPER,
          hasDB: !!env.DB
        }));
      }

      // ===== REGISTER =====
      if (path === "/api/auth/register" && req.method === "POST") {
        const body = await readJson(req);
        if (!body) return withCors(bad("Invalid JSON"));

        const { username, email, phone, password } = body;
        if (!username || !email || !password) {
          return withCors(bad("Missing fields"));
        }
        if (String(password).length < 6) {
          return withCors(bad("Password too short"));
        }

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
            `INSERT INTO users
             (id, username, email, phone, password_hash, role, status, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, 'user', 'active', ?, ?)`
          ).bind(
            id,
            String(username),
            String(email),
            phone ? String(phone) : "",
            password_hash,
            now,
            now
          ).run();

          await env.DB.prepare(
            `INSERT INTO wallets (user_id, balance_cents, updated_at)
             VALUES (?, 0, ?)`
          ).bind(id, now).run();
        } catch (e) {
          console.error("REGISTER SQLITE ERROR:", e);
          if (String(e).includes("UNIQUE")) {
            return withCors(bad("Username / Email / Phone đã tồn tại", 409));
          }
          return withCors(bad("Register failed", 500));
        }

        return withCors(ok({ user_id: id }));
      }

      // ===== LOGIN =====
      if (path === "/api/auth/login" && req.method === "POST") {
        const body = await readJson(req);
        if (!body) return withCors(bad("Invalid JSON"));

        const { username, password } = body;
        if (!username || !password) return withCors(bad("Missing fields"));

        const user = await env.DB.prepare(
          "SELECT id, password_hash, status, role FROM users WHERE username=?"
        ).bind(String(username)).first();

        if (!user || user.status !== "active") {
          return withCors(bad("Invalid credentials", 401));
        }

        const okPw = await verifyPassword(
          String(password),
          user.password_hash,
          env.PASSWORD_PEPPER
        );

        if (!okPw) return withCors(bad("Invalid credentials", 401));

        const token = crypto.randomUUID() + crypto.randomUUID();
        const tokenHash = await sha256Hex(token);

        const ua = req.headers.get("user-agent") || "";
        const uaHash = await sha256Hex(ua);
        const ipPrefix = ipPrefixFromReq(req);

        const now = Date.now();
        const maxAge = parseInt(env.SESSION_MAX_AGE_SEC || "2592000", 10);
        const expires = now + maxAge * 1000;

        await env.DB.prepare("DELETE FROM sessions WHERE user_id=?")
          .bind(user.id).run();

        await env.DB.prepare(
          `INSERT INTO sessions
           (id, user_id, token_hash, ua_hash, ip_prefix, created_at, last_seen_at, expires_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        ).bind(
          crypto.randomUUID(),
          user.id,
          tokenHash,
          uaHash,
          ipPrefix,
          now,
          now,
          expires
        ).run();

        return withCors(
          json({ ok: true }, 200, {
            "Set-Cookie": setCookie("session", token, maxAge)
          })
        );
      }

      return withCors(bad("Not found", 404));
    } catch (e) {
      console.error("FATAL API ERROR:", e);
      return withCors(json({ ok: false, error: "Server error" }, 500));
    }
  }
};

// ===== HELPERS =====
function corsHeaders(req) {
  const origin = req.headers.get("Origin") || "*";
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Credentials": "true",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  };
}

function json(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...extra }
  });
}

function ok(data = {}) {
  return json({ ok: true, ...data });
}

function bad(msg, status = 400) {
  return json({ ok: false, error: msg }, status);
}

function setCookie(name, value, maxAge) {
  return `${name}=${value}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${maxAge}`;
}

function ipPrefixFromReq(req) {
  const ip = req.headers.get("cf-connecting-ip") || "";
  return ip.includes(".") ? ip.split(".").slice(0, 3).join(".") : ip;
}

async function readJson(req) {
  try { return await req.json(); } catch { return null; }
}

async function sha256Hex(input) {
  const buf = new TextEncoder().encode(input);
  const hash = await crypto.subtle.digest("SHA-256", buf);
  return [...new Uint8Array(hash)].map(b => b.toString(16).padStart(2, "0")).join("");
}

// ===== PASSWORD HASH (ỔN ĐỊNH 100%) =====
async function hashPassword(password, pepper) {
  const salt = crypto.randomUUID();
  const hash = await sha256Hex(password + pepper + salt);
  return `sha256$${salt}$${hash}`;
}

async function verifyPassword(password, stored, pepper) {
  const [tag, salt, hash] = stored.split("$");
  if (tag !== "sha256") return false;
  const check = await sha256Hex(password + pepper + salt);
  return check === hash;
}
