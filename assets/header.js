async function loadHeader() {
  const mount = document.getElementById("headerMount");
  if (!mount) return;

  const isAdmin = location.pathname.includes("admin-");

  mount.innerHTML = `
    <header class="site-header ${isAdmin ? "is-admin" : ""}">
      <div class="brand">
        <a href="${isAdmin ? "/admin-dashboard.html" : "/"}" id="siteName">Neko Shop</a>
        <small id="siteTagline">${isAdmin ? "Admin – Quản trị hệ thống" : "mua bán - giao dịch nhanh"}</small>
      </div>

      <button class="site-hamburger" id="menuBtn" aria-label="Mở menu" aria-expanded="false">☰</button>

      <nav class="site-drawer" id="drawer" aria-hidden="true">
        ${isAdmin ? `
          <a href="/admin-dashboard.html">Dashboard</a>
          <a href="/admin-users.html">Users</a>
          <a href="/admin-disputes.html">Disputes</a>
          <a href="/admin-withdrawals.html">Withdrawals</a>
          <a href="/admin-settings.html">Settings</a>
          <a href="/">← Về User</a>
        ` : `
          <a href="/create.html">Đăng bán</a>
          <a href="/dashboard.html">Tài khoản</a>
          <a href="/orders.html">Đơn hàng</a>
          <a href="/deposit.html">Nạp tiền</a>
          <a href="/withdraw.html">Rút tiền</a>
          <a href="/sales-history.html">Lịch sử bán</a>
          <a href="/withdraw-history.html">Lịch sử rút tiền</a>
          <a href="/deposit-history.html">Lịch sử giao dịch</a>
          <a href="/login.html">Đăng nhập</a>
        `}
      </nav>

      <div class="site-overlay" id="overlay"></div>
    </header>
  `;

  const btn = document.getElementById("menuBtn");
  const drawer = document.getElementById("drawer");
  const overlay = document.getElementById("overlay");

  const open = () => {
    drawer.classList.add("open");
    overlay.classList.add("show");
    btn.setAttribute("aria-expanded", "true");
    drawer.setAttribute("aria-hidden", "false");
  };

  const close = () => {
    drawer.classList.remove("open");
    overlay.classList.remove("show");
    btn.setAttribute("aria-expanded", "false");
    drawer.setAttribute("aria-hidden", "true");
  };

  btn.addEventListener("click", () => {
    drawer.classList.contains("open") ? close() : open();
  });

  overlay.addEventListener("click", close);

  drawer.addEventListener("click", (e) => {
    if (e.target.tagName === "A") close();
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") close();
  });
}

document.addEventListener("DOMContentLoaded", loadHeader);
