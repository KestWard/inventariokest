
export async function api(
  path,
  method = "GET",
  body,
  headersAdicionales = {}
) {
  const token = localStorage.getItem("token");

  const r = await fetch("/api" + path, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...headersAdicionales,
      ...(token
        ? { Authorization: "Bearer " + token }
        : {})
    },
    body: body === undefined
      ? undefined
      : JSON.stringify(body)
  });

  // Si la sesión expira, volver al inicio de sesión.
  if (r.status === 401 && token) {
    localStorage.clear();
    window.location.reload();
    throw new Error("Sesión inválida o expirada.");
  }

  const data = await r.json().catch(() => ({}));

  if (!r.ok) {
    throw new Error(
      data.error || "Error de servidor"
    );
  }

  return data;
}
