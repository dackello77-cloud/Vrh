import { supabase } from "./supabase.js";

// Samostalna, mobilno-orijentisana stranica za Šifrarnik — izdvojena iz
// glavne app.js SPA (index.html) da se može otvoriti direktno na telefonu
// bez učitavanja cele (velike) glavne aplikacije. Koristi isti Supabase
// projekat/sesiju/RLS/RPC kao glavna app — nalozi, lozinke i dozvole
// ("sifrarnik" view/edit) se i dalje podešavaju u glavnoj app > Podešavanja
// > Nalozi/Role. Šifra se čuva šifrovana (sql/sifrarnik.sql) — lista OVDE
// namerno nikad ne traži password_encrypted; stvarna lozinka se dohvata tek
// na klik "Prikaži"/"Kopiraj", kroz reveal_sifrarnik_password() RPC koji
// upisuje ko/kad je otključao koju šifru (sifrarnik_audit_log).

const el = {
  pageLogin: document.getElementById("pageLogin"),
  loginForm: document.getElementById("loginForm"),
  loginEmail: document.getElementById("loginEmail"),
  loginPassword: document.getElementById("loginPassword"),
  loginError: document.getElementById("loginError"),
  app: document.getElementById("app"),
  logoutBtn: document.getElementById("logoutBtn"),
  sifrarnikToolbar: document.getElementById("sifrarnikToolbar"),
  sifrarnikSearch: document.getElementById("sifrarnikSearch"),
  sifrarnikAddBtn: document.getElementById("sifrarnikAddBtn"),
  sifrarnikList: document.getElementById("sifrarnikList"),
  noAccessState: document.getElementById("noAccessState"),
  sifrarnikModal: document.getElementById("sifrarnikModal"),
  sifrarnikModalTitle: document.getElementById("sifrarnikModalTitle"),
  sifrarnikForm: document.getElementById("sifrarnikForm"),
  sifrarnikGrupa: document.getElementById("sifrarnikGrupa"),
  sifrarnikIme: document.getElementById("sifrarnikIme"),
  sifrarnikUsername: document.getElementById("sifrarnikUsername"),
  sifrarnikPassword: document.getElementById("sifrarnikPassword"),
  sifrarnikLink: document.getElementById("sifrarnikLink"),
  sifrarnikPristup: document.getElementById("sifrarnikPristup"),
  sifrarnikKomentar: document.getElementById("sifrarnikKomentar"),
  sifrarnikNewGrupaBtn: document.getElementById("sifrarnikNewGrupaBtn"),
  sifrarnikClearGrupaBtn: document.getElementById("sifrarnikClearGrupaBtn"),
  sifrarnikDeleteGrupaBtn: document.getElementById("sifrarnikDeleteGrupaBtn"),
  cancelSifrarnikBtn: document.getElementById("cancelSifrarnikBtn"),
  shareModal: document.getElementById("shareModal"),
  cancelShareBtn: document.getElementById("cancelShareBtn"),
  shareOptionBtns: document.querySelectorAll(".share-option"),
  toast: document.getElementById("toast"),
};

const state = {
  permissions: {},
  sifrarnik: [],
  sifrarnikGrupe: [],
  expandedGroups: new Set(),
  editingId: null,
};

const BEZ_GRUPE_LABEL = "(bez grupe)";

const ICON_EYE =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7Z"/><circle cx="12" cy="12" r="3"/></svg>';
const ICON_EYE_OFF =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.94 10.94 0 0 1 12 19c-7 0-11-7-11-7a21.9 21.9 0 0 1 5.06-5.94M9.9 4.24A10.4 10.4 0 0 1 12 5c7 0 11 7 11 7a21.9 21.9 0 0 1-2.16 3.19M14.12 14.12a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>';
const ICON_COPY =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
const ICON_EDIT =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>';
const ICON_TRASH =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6m5 0V4a2 2 0 0 1 2-2h0a2 2 0 0 1 2 2v2"/></svg>';
const ICON_SHARE =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/></svg>';

function el_(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

let toastTimer = null;
function showToast(message, isError = false) {
  el.toast.textContent = message;
  el.toast.classList.toggle("error", isError);
  el.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.toast.hidden = true;
  }, 3000);
}

function canEdit() {
  return state.permissions.sifrarnik === "edit";
}

function canView() {
  const p = state.permissions.sifrarnik;
  return p === "view" || p === "edit";
}

// ---------- login / logout ----------

async function loadMyPermissions() {
  const { data, error } = await supabase.rpc("my_permissions");
  if (error) {
    console.error(error);
    state.permissions = {};
    return;
  }
  state.permissions = data || {};
}

function showLoginPage(message) {
  el.app.hidden = true;
  el.pageLogin.hidden = false;
  if (message) {
    el.loginError.textContent = message;
    el.loginError.hidden = false;
  } else {
    el.loginError.hidden = true;
  }
}

async function bootstrapAfterLogin() {
  await loadMyPermissions();
  el.pageLogin.hidden = true;
  el.app.hidden = false;
  el.loginEmail.value = "";
  el.loginPassword.value = "";

  if (!canView()) {
    el.sifrarnikList.hidden = true;
    el.sifrarnikToolbar.hidden = true;
    el.noAccessState.hidden = false;
    return;
  }

  el.sifrarnikList.hidden = false;
  el.sifrarnikToolbar.hidden = false;
  el.noAccessState.hidden = true;
  el.sifrarnikAddBtn.hidden = !canEdit();

  await Promise.all([loadSifrarnik(), loadSifrarnikGrupe()]);
  renderSifrarnik();
}

el.loginForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const email = el.loginEmail.value.trim();
  const password = el.loginPassword.value;
  const { error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) {
    showLoginPage("Pogrešan email ili lozinka.");
    return;
  }
  await bootstrapAfterLogin();
});

el.logoutBtn.addEventListener("click", async () => {
  await supabase.auth.signOut();
  location.reload();
});

// ---------- šifrarnik: učitavanje ----------

async function loadSifrarnik() {
  const { data, error } = await supabase
    .from("sifrarnik")
    .select("id,grupa_id,ime,username,link,pristup,komentar")
    .order("ime", { ascending: true });
  if (error) {
    showToast("Greška pri učitavanju šifrarnika: " + error.message, true);
    state.sifrarnik = [];
    return;
  }
  state.sifrarnik = data || [];
}

async function loadSifrarnikGrupe() {
  const { data, error } = await supabase.from("sifrarnik_grupe").select("id,naziv").order("naziv");
  if (error) {
    showToast("Greška pri učitavanju grupa: " + error.message, true);
    state.sifrarnikGrupe = [];
    return;
  }
  state.sifrarnikGrupe = data || [];
}

// ---------- šifrarnik: prikaz (kartice, grupisano) ----------

function renderSifrarnik() {
  el.sifrarnikList.innerHTML = "";
  const grupaNameById = new Map(state.sifrarnikGrupe.map((g) => [g.id, g.naziv]));
  const q = (el.sifrarnikSearch.value || "").trim().toLowerCase();
  const rows = q
    ? state.sifrarnik.filter((r) =>
        [grupaNameById.get(r.grupa_id), r.ime, r.username, r.pristup].some((v) =>
          (v || "").toLowerCase().includes(q)
        )
      )
    : state.sifrarnik;

  if (rows.length === 0) {
    el.sifrarnikList.appendChild(
      el_("div", "empty-state", state.sifrarnik.length ? "Nema rezultata pretrage." : "Nema unetih šifara.")
    );
    return;
  }

  const groups = new Map(); // groupKey -> { label, isNone, rows: [] }
  for (const row of rows) {
    const groupName = grupaNameById.get(row.grupa_id) || null;
    const key = groupName || BEZ_GRUPE_LABEL;
    if (!groups.has(key)) groups.set(key, { label: groupName || BEZ_GRUPE_LABEL, isNone: !groupName, rows: [] });
    groups.get(key).rows.push(row);
  }
  const groupKeys = Array.from(groups.keys()).sort((a, b) => {
    const ga = groups.get(a);
    const gb = groups.get(b);
    if (ga.isNone && !gb.isNone) return 1;
    if (!ga.isNone && gb.isNone) return -1;
    return a.localeCompare(b);
  });

  const editable = canEdit();

  for (const key of groupKeys) {
    const group = groups.get(key);
    group.rows.sort((a, b) => (a.ime || "").localeCompare(b.ime || ""));

    // Grupe su podrazumevano zatvorene — klik otvara/zatvara. Dok se
    // pretražuje, sve grupe se prikazuju otvorene (ne menja trajno stanje).
    const expanded = q !== "" || state.expandedGroups.has(key);

    const groupBtn = el_("button", "keys-group-btn", `${expanded ? "▾" : "▸"} ${group.label} (${group.rows.length})`);
    groupBtn.type = "button";
    groupBtn.addEventListener("click", () => {
      if (state.expandedGroups.has(key)) state.expandedGroups.delete(key);
      else state.expandedGroups.add(key);
      renderSifrarnik();
    });
    el.sifrarnikList.appendChild(groupBtn);

    if (!expanded) continue;

    for (const row of group.rows) {
      el.sifrarnikList.appendChild(renderKeyCard(row, editable));
    }
  }
}

function keyRow(label, valueNode) {
  const row = el_("div", "key-row");
  row.appendChild(el_("div", "key-row-label", label));
  const valueWrap = el_("div", "key-row-value");
  if (typeof valueNode === "string") valueWrap.textContent = valueNode;
  else valueWrap.appendChild(valueNode);
  row.appendChild(valueWrap);
  return row;
}

function renderKeyCard(row, editable) {
  const card = el_("div", "key-card");

  const head = el_("div", "key-card-head");
  head.appendChild(el_("div", "key-card-name", row.ime || ""));
  if (editable) {
    const actions = el_("div", "key-card-actions");
    const editBtn = document.createElement("button");
    editBtn.type = "button";
    editBtn.className = "keys-icon-btn";
    editBtn.innerHTML = ICON_EDIT;
    editBtn.title = "Izmeni";
    editBtn.addEventListener("click", () => openSifrarnikModal(row));
    actions.appendChild(editBtn);

    const shareBtn = document.createElement("button");
    shareBtn.type = "button";
    shareBtn.className = "keys-icon-btn";
    shareBtn.innerHTML = ICON_SHARE;
    shareBtn.title = "Podeli";
    shareBtn.addEventListener("click", () => openShareModal(row));
    actions.appendChild(shareBtn);

    const delBtn = document.createElement("button");
    delBtn.type = "button";
    delBtn.className = "keys-icon-btn keys-icon-btn-danger";
    delBtn.innerHTML = ICON_TRASH;
    delBtn.title = "Obriši";
    delBtn.addEventListener("click", () => deleteSifrarnik(row));
    actions.appendChild(delBtn);

    head.appendChild(actions);
  }
  card.appendChild(head);

  if (row.username) card.appendChild(keyRow("Username", row.username));

  const passWrap = el_("div", "key-pass-value");
  const passText = el_("span", "key-pass-mask", "••••••••");
  passWrap.appendChild(passText);
  if (editable) {
    const showBtn = document.createElement("button");
    showBtn.type = "button";
    showBtn.className = "keys-icon-btn";
    showBtn.innerHTML = ICON_EYE;
    showBtn.title = "Prikaži";
    showBtn.addEventListener("click", () => toggleSifrarnikPassword(row.id, passText, showBtn));
    passWrap.appendChild(showBtn);

    const copyBtn = document.createElement("button");
    copyBtn.type = "button";
    copyBtn.className = "keys-icon-btn";
    copyBtn.innerHTML = ICON_COPY;
    copyBtn.title = "Kopiraj lozinku";
    copyBtn.addEventListener("click", () => copySifrarnikPassword(row.id, passText));
    passWrap.appendChild(copyBtn);
  }
  card.appendChild(keyRow("Password", passWrap));

  if (row.link) {
    const a = document.createElement("a");
    a.href = /^https?:\/\//i.test(row.link) ? row.link : `https://${row.link}`;
    a.textContent = row.link;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    card.appendChild(keyRow("Link", a));
  }

  if (row.pristup) card.appendChild(keyRow("Pristup", row.pristup));
  if (row.komentar) card.appendChild(keyRow("Komentar", row.komentar));

  return card;
}

el.sifrarnikSearch.addEventListener("input", renderSifrarnik);

async function toggleSifrarnikPassword(id, textEl, btnEl) {
  if (textEl.dataset.revealed === "1") {
    textEl.textContent = "••••••••";
    textEl.classList.remove("is-revealed");
    textEl.dataset.revealed = "0";
    btnEl.innerHTML = ICON_EYE;
    btnEl.title = "Prikaži";
    return;
  }
  const { data, error } = await supabase.rpc("reveal_sifrarnik_password", { p_id: id });
  if (error) {
    showToast("Greška: " + error.message, true);
    return;
  }
  textEl.textContent = data || "(nema lozinke)";
  textEl.classList.add("is-revealed");
  textEl.dataset.revealed = "1";
  btnEl.innerHTML = ICON_EYE_OFF;
  btnEl.title = "Sakrij";
}

async function copySifrarnikPassword(id, textEl) {
  let plain = textEl.dataset.revealed === "1" ? textEl.textContent : null;
  if (!plain) {
    const { data, error } = await supabase.rpc("reveal_sifrarnik_password", { p_id: id });
    if (error) {
      showToast("Greška: " + error.message, true);
      return;
    }
    plain = data;
  }
  if (!plain) {
    showToast("Nema unete lozinke", true);
    return;
  }
  try {
    await navigator.clipboard.writeText(plain);
    showToast("Lozinka kopirana");
  } catch {
    showToast("Kopiranje nije uspelo — dozvoli pristup clipboard-u", true);
  }
}

// ---------- šifrarnik: grupe (u modalu) ----------

function populateSifrarnikGrupaSelect(selectedId) {
  el.sifrarnikGrupa.innerHTML = "";
  el.sifrarnikGrupa.appendChild(new Option(BEZ_GRUPE_LABEL, ""));
  for (const g of state.sifrarnikGrupe) {
    el.sifrarnikGrupa.appendChild(new Option(g.naziv, g.id));
  }
  el.sifrarnikGrupa.value = selectedId || "";
}

el.sifrarnikNewGrupaBtn.addEventListener("click", async () => {
  const naziv = window.prompt("Naziv nove grupe:", "");
  if (naziv === null) return;
  const trimmed = naziv.trim();
  if (!trimmed) return;

  const existing = state.sifrarnikGrupe.find((g) => g.naziv.toLowerCase() === trimmed.toLowerCase());
  if (existing) {
    populateSifrarnikGrupaSelect(existing.id);
    return;
  }

  const { data, error } = await supabase.from("sifrarnik_grupe").insert({ naziv: trimmed }).select().single();
  if (error) {
    showToast("Greška: " + error.message, true);
    return;
  }
  state.sifrarnikGrupe.push(data);
  state.sifrarnikGrupe.sort((a, b) => a.naziv.localeCompare(b.naziv));
  populateSifrarnikGrupaSelect(data.id);
});

el.sifrarnikClearGrupaBtn.addEventListener("click", () => {
  el.sifrarnikGrupa.value = "";
});

el.sifrarnikDeleteGrupaBtn.addEventListener("click", async () => {
  const id = el.sifrarnikGrupa.value;
  if (!id) {
    showToast("Nije izabrana grupa", true);
    return;
  }
  const grupa = state.sifrarnikGrupe.find((g) => g.id === id);
  if (!grupa) return;

  const usedCount = state.sifrarnik.filter((s) => s.grupa_id === id).length;
  if (usedCount > 0) {
    showToast(
      `Grupa "${grupa.naziv}" se koristi u ${usedCount} ${usedCount === 1 ? "šifri" : "šifara"} — prvo im promeni grupu, pa tek onda obriši grupu.`,
      true
    );
    return;
  }

  if (!confirm(`Obriši grupu "${grupa.naziv}" iz spiska?`)) return;

  const { error } = await supabase.from("sifrarnik_grupe").delete().eq("id", id);
  if (error) {
    showToast("Greška: " + error.message, true);
    return;
  }
  state.sifrarnikGrupe = state.sifrarnikGrupe.filter((g) => g.id !== id);
  populateSifrarnikGrupaSelect("");
  showToast("Grupa obrisana");
});

// ---------- šifrarnik: dodaj / izmeni / obriši ----------

function openSifrarnikModal(row) {
  state.editingId = row ? row.id : null;
  el.sifrarnikModalTitle.textContent = row ? "Izmena šifre" : "Nova šifra";
  populateSifrarnikGrupaSelect(row?.grupa_id || "");
  el.sifrarnikIme.value = row?.ime || "";
  el.sifrarnikUsername.value = row?.username || "";
  el.sifrarnikPassword.value = "";
  el.sifrarnikPassword.placeholder = row ? "Ostavi prazno da zadržiš postojeću" : "";
  el.sifrarnikLink.value = row?.link || "";
  el.sifrarnikPristup.value = row?.pristup || "";
  el.sifrarnikKomentar.value = row?.komentar || "";
  el.sifrarnikModal.hidden = false;
}

function closeSifrarnikModal() {
  el.sifrarnikModal.hidden = true;
  el.sifrarnikForm.reset();
  state.editingId = null;
}

el.sifrarnikAddBtn.addEventListener("click", () => openSifrarnikModal(null));
el.cancelSifrarnikBtn.addEventListener("click", closeSifrarnikModal);
el.sifrarnikModal.addEventListener("click", (e) => {
  if (e.target === el.sifrarnikModal) closeSifrarnikModal();
});

el.sifrarnikForm.addEventListener("submit", async (e) => {
  e.preventDefault();

  const ime = el.sifrarnikIme.value.trim();
  if (!ime) {
    showToast("Ime je obavezno", true);
    return;
  }

  const payload = {
    grupa_id: el.sifrarnikGrupa.value || null,
    ime,
    username: el.sifrarnikUsername.value.trim() || null,
    link: el.sifrarnikLink.value.trim() || null,
    pristup: el.sifrarnikPristup.value.trim() || null,
    komentar: el.sifrarnikKomentar.value.trim() || null,
  };
  // Prazno = zadrži postojeću lozinku (vidi sifrarnik_encrypt_password()
  // trigger u sql/sifrarnik.sql).
  if (el.sifrarnikPassword.value !== "") {
    payload.password_plain = el.sifrarnikPassword.value;
  }

  const { error } = state.editingId
    ? await supabase.from("sifrarnik").update(payload).eq("id", state.editingId)
    : await supabase.from("sifrarnik").insert(payload);

  if (error) {
    showToast("Greška: " + error.message, true);
    return;
  }
  closeSifrarnikModal();
  await loadSifrarnik();
  renderSifrarnik();
  showToast("Sačuvano");
});

async function deleteSifrarnik(row) {
  if (!confirm(`Obriši šifru "${row.ime}"?`)) return;
  const { error } = await supabase.from("sifrarnik").delete().eq("id", row.id);
  if (error) {
    showToast("Greška: " + error.message, true);
    return;
  }
  await loadSifrarnik();
  renderSifrarnik();
  showToast("Obrisano");
}

// ---------- šifrarnik: podeli (WhatsApp/Viber/Telegram/Email) ----------
// Svaki klik na "Podeli" dohvata lozinku kroz istu reveal_sifrarnik_password()
// RPC kao dugme "Prikaži"/"Kopiraj" (upisuje se u sifrarnik_audit_log), pa se
// tekst poruke sastavlja i šalje preko izabranog kanala. Sam sadržaj poruke
// napušta app (spolja se ne može kontrolisati šta WhatsApp/Viber/Telegram/
// mejl klijent dalje rade s njim) — dugme je namerno dostupno samo korisniku
// sa edit dozvolom, isto kao Prikaži/Kopiraj/Izmeni/Obriši.
let shareMessage = "";
let shareSubject = "";

async function openShareModal(row) {
  const { data, error } = await supabase.rpc("reveal_sifrarnik_password", { p_id: row.id });
  if (error) {
    showToast("Greška: " + error.message, true);
    return;
  }
  const lines = [row.ime || ""];
  if (row.username) lines.push(`Username: ${row.username}`);
  lines.push(`Password: ${data || "(nema lozinke)"}`);
  if (row.link) lines.push(`Link: ${row.link}`);
  if (row.pristup) lines.push(`Pristup: ${row.pristup}`);
  if (row.komentar) lines.push(`Komentar: ${row.komentar}`);
  shareMessage = lines.join("\n");
  shareSubject = row.ime || "Šifrarnik";
  el.shareModal.hidden = false;
}

function closeShareModal() {
  el.shareModal.hidden = true;
  shareMessage = "";
  shareSubject = "";
}

el.cancelShareBtn.addEventListener("click", closeShareModal);
el.shareModal.addEventListener("click", (e) => {
  if (e.target === el.shareModal) closeShareModal();
});

el.shareOptionBtns.forEach((btn) => {
  btn.addEventListener("click", () => {
    const text = encodeURIComponent(shareMessage);
    switch (btn.dataset.share) {
      case "whatsapp":
        window.open(`https://wa.me/?text=${text}`, "_blank", "noopener");
        break;
      case "viber":
        window.location.href = `viber://forward?text=${text}`;
        break;
      case "telegram":
        window.open(`https://t.me/share/url?url=&text=${text}`, "_blank", "noopener");
        break;
      case "email":
        window.location.href = `mailto:?subject=${encodeURIComponent(shareSubject)}&body=${text}`;
        break;
    }
    closeShareModal();
  });
});

// ---------- init ----------

el.app.hidden = true;

supabase.auth.getSession().then(({ data }) => {
  if (data.session) {
    bootstrapAfterLogin();
  } else {
    showLoginPage();
  }
});

// Odjava iz drugog taba / istekla sesija.
supabase.auth.onAuthStateChange((event) => {
  if (event === "SIGNED_OUT") {
    location.reload();
  }
});
