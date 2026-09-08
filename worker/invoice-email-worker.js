// VRH: slanje faktura emailom (Izveštaj > Detaljan prikaz > "Napravi fakturu" > Pošalji)
//
// Ovo NIJE deo statičnog sajta — deploy-uje se kao poseban Cloudflare Worker
// (isti postupak kao postojeći ELD sync worker, royal-paper-656b), pošto
// GitHub Pages ne može sam da šalje email. App (js/app.js) zove ovaj worker
// direktno iz browsera (fetch), worker zove Resend API (resend.com) da
// stvarno pošalje mejl, i vraća rezultat nazad app-u.
//
// DEPLOY:
// 1. Cloudflare dashboard > Workers & Pages > Create > Create Worker.
// 2. Zalepi ceo ovaj fajl u editor, Deploy.
// 3. Worker > Settings > Variables and Secrets > Add > ime "RESEND_API_KEY",
//    vrednost = API key sa resend.com (Encrypt/Secret, ne obican var).
// 4. Kopiraj URL workera (npr. https://ime-workera.tvoj-nalog.workers.dev/)
//    i stavi ga u js/app.js kao INVOICE_EMAIL_WORKER_URL.
//
// Samo Origin sa ALLOWED_ORIGINS liste ispod sme da zove ovaj worker (osnovna
// zastita od zloupotrebe/spam-a tudje Resend kvote) - ako menjas domen sajta
// ili testiras sa drugog porta, dodaj ga ovde.
const ALLOWED_ORIGINS = [
  "https://dackello77-cloud.github.io",
  "http://localhost:8000",
  "http://127.0.0.1:8000",
];

const FROM_ADDRESS = "VRH Tracking Technologies LLC <onboarding@resend.dev>";

function corsHeaders(origin) {
  const allowed = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    "Access-Control-Allow-Origin": allowed,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    const headers = corsHeaders(origin);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers });
    }

    if (!ALLOWED_ORIGINS.includes(origin)) {
      return new Response(JSON.stringify({ error: "Origin nije dozvoljen" }), {
        status: 403,
        headers: { ...headers, "Content-Type": "application/json" },
      });
    }

    if (request.method !== "POST") {
      return new Response(JSON.stringify({ error: "Samo POST" }), {
        status: 405,
        headers: { ...headers, "Content-Type": "application/json" },
      });
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return new Response(JSON.stringify({ error: "Neispravan JSON" }), {
        status: 400,
        headers: { ...headers, "Content-Type": "application/json" },
      });
    }

    const { to, subject, html, attachments } = body;
    if (!to || !subject || !html) {
      return new Response(JSON.stringify({ error: "Nedostaje to/subject/html" }), {
        status: 400,
        headers: { ...headers, "Content-Type": "application/json" },
      });
    }

    const resendResp = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: FROM_ADDRESS,
        to: [to],
        subject,
        html,
        ...(attachments && attachments.length ? { attachments } : {}),
      }),
    });

    const resendData = await resendResp.json();

    if (!resendResp.ok) {
      return new Response(JSON.stringify({ error: resendData.message || "Resend greška" }), {
        status: 502,
        headers: { ...headers, "Content-Type": "application/json" },
      });
    }

    return new Response(JSON.stringify({ ok: true, id: resendData.id }), {
      status: 200,
      headers: { ...headers, "Content-Type": "application/json" },
    });
  },
};
