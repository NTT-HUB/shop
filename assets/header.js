async function loadHeader() {
  const mount = document.getElementById("headerMount");
  if (!mount) return;

  const isAdmin = location.pathname.includes("admin-");

  mount.innerHTML = `
    <header class="header ${isAdmin ? "header--admin" : ""}">
      <div class="brand">
        <a href="${isAdmin ? "/admin-dashboard.html" : "/"}" class="logo">SHOP</a>
        <small class="tagline">
          ${isAdmin ? "Admin – Quản trị hệ thống" : "Mua bán nhanh – an toàn"}
        </small>
      </div>

      <button class="hamburger" id="menuBtn">☰</button>

      <nav class="drawer" id="drawer">
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
          <a href="/login.html">Đăng nhập</a>
        `}
      </nav>

      <div class="overlay" id="overlay"></div>
    </header>
  `;

  const btn = document.getElementById("menuBtn");
  const drawer = document.getElementById("drawer");
  const overlay = document.getElementById("overlay");

  const open = () => {
    drawer.classList.add("open");
    overlay.classList.add("show");
  };

  const close = () => {
    drawer.classList.remove("open");
    overlay.classList.remove("show");
  };

  btn.onclick = open;
  overlay.onclick = close;

  drawer.onclick = (e) => {
    if (e.target.tagName === "A") close();
  };

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") close();
  });
}

document.addEventListener("DOMContentLoaded", loadHeader);
