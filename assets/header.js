async function loadHeader() {
  const mount = document.getElementById("headerMount");
  if (!mount) return;

  const isAdmin = location.pathname.includes("admin-");
  const url = isAdmin ? "/components/admin-header.html" : "/components/user-header.html";

  const html = await fetch(url, { cache: "no-cache" }).then(r => r.text());
  mount.innerHTML = html;

  const btn = document.getElementById("menuBtn");
  const drawer = document.getElementById("drawer");
  const overlay = document.getElementById("overlay");

  const open = () => { drawer.classList.add("open"); overlay.classList.add("show"); };
  const close = () => { drawer.classList.remove("open"); overlay.classList.remove("show"); };

  btn?.addEventListener("click", open);
  overlay?.addEventListener("click", close);
  drawer?.addEventListener("click", (e) => {
    if (e.target.tagName === "A") close();
  });

  // ESC to close
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") close();
  });
}

document.addEventListener("DOMContentLoaded", loadHeader);
