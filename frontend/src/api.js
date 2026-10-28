export async function api(path, method = "GET", body) {
  const token = localStorage.getItem("token");
  const r = await fetch("/api" + path, { method, headers: { "Content-Type": "application/json", ...(token ? { Authorization: "Bearer " + token } : {}) }, body: body ? JSON.stringify(body) : undefined });
  // Token vencido: limpiar sesión y volver al login
  if (r.status === 401 && token) { localStorage.clear(); location.reload(); }
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || "Error de servidor");
  return data;
}
