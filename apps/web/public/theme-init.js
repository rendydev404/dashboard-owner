// Pasang tema sebelum render supaya tidak berkedip (file terpisah karena CSP melarang script inline).
try { var t = localStorage.getItem("iklan-theme"); if (t === "light" || t === "dark") document.documentElement.dataset.theme = t; } catch (e) {}
