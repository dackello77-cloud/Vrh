import { supabase } from "./supabase.js";

const MONTH_NAMES = [
  "Januar", "Februar", "Mart", "April", "Maj", "Jun",
  "Jul", "Avgust", "Septembar", "Oktobar", "Novembar", "Decembar",
];

const SUB_COLS = ["T", "S", "B", "A"];
const ELD_API_URL = "https://royal-paper-656b.dackello77.workers.dev/";

const now = new Date();

const state = {
  year: now.getFullYear(),
  month: now.getMonth(), // 0-indexed
  companies: [],
  counts: {}, // { companyId: { day: { total, start, basic, advanced } } }
  editingCompanyId: null,
  hasScrolledToToday: false,
  searchQuery: "",
  statusFilter: "all",
  modalMode: "edit", // "edit" | "new"
  pendingNewCompany: null, // { external_id, name, eld_group }
  newCompanyQueue: [],
  reportType: "daily", // "daily" | "behind" | "current"
};

const el = {
  navOverview: document.getElementById("navOverview"),
  navReports: document.getElementById("navReports"),
  pageOverview: document.getElementById("pageOverview"),
  pageReports: document.getElementById("pageReports"),
  reportTabDaily: document.getElementById("reportTabDaily"),
  reportTabBehind: document.getElementById("reportTabBehind"),
  reportTabCurrent: document.getElementById("reportTabCurrent"),
  reportDateLabel: document.getElementById("reportDateLabel"),
  reportDate: document.getElementById("reportDate"),
  generateReportBtn: document.getElementById("generateReportBtn"),
  downloadPdfBtn: document.getElementById("downloadPdfBtn"),
  reportContent: document.getElementById("reportContent"),
  prevMonth: document.getElementById("prevMonth"),
  nextMonth: document.getElementById("nextMonth"),
  monthLabel: document.getElementById("monthLabel"),
  totalVrh: document.getElementById("totalVrh"),
  totalRst: document.getElementById("totalRst"),
  searchInput: document.getElementById("searchInput"),
  statusFilter: document.getElementById("statusFilter"),
  importBtn: document.getElementById("importBtn"),
  importFile: document.getElementById("importFile"),
  tableWrap: document.querySelector(".table-wrap"),
  gridHeadRow1: document.getElementById("gridHeadRow1"),
  gridHeadRow2: document.getElementById("gridHeadRow2"),
  gridBody: document.getElementById("gridBody"),
  emptyState: document.getElementById("emptyState"),
  toast: document.getElementById("toast"),
  companyModal: document.getElementById("companyModal"),
  companyModalTitle: document.getElementById("companyModalTitle"),
  companyModalName: document.getElementById("companyModalName"),
  companyForm: document.getElementById("companyForm"),
  companyStatus: document.getElementById("companyStatus"),
  companyPrice: document.getElementById("companyPrice"),
  companyTax: document.getElementById("companyTax"),
  companyEntryColumn: document.getElementById("companyEntryColumn"),
  companyBillingStartsOn: document.getElementById("companyBillingStartsOn"),
  companyNotes: document.getElementById("companyNotes"),
  cancelCompanyBtn: document.getElementById("cancelCompanyBtn"),
};

function pad(n) {
  return String(n).padStart(2, "0");
}

function dateStr(year, month, day) {
  return `${year}-${pad(month + 1)}-${pad(day)}`;
}

function daysInMonth(year, month) {
  return new Date(year, month + 1, 0).getDate();
}

function isCurrentMonth() {
  return state.year === now.getFullYear() && state.month === now.getMonth();
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

// ---------- data loading ----------

async function loadCompanies() {
  const { data, error } = await supabase
    .from("companies")
    .select("*")
    .order("name", { ascending: true });
  if (error) {
    showToast("Greška pri učitavanju firmi: " + error.message, true);
    return [];
  }
  return data ?? [];
}

// Supabase/PostgREST caps unpaginated queries at 1000 rows by default, so a
// month with more rows than that would silently lose the tail. Page through
// with .range() until a batch comes back short of the page size.
async function loadCounts(year, month) {
  const first = dateStr(year, month, 1);
  const last = dateStr(year, month, daysInMonth(year, month));
  const pageSize = 1000;
  const byCompany = {};
  let from = 0;

  while (true) {
    const { data, error } = await supabase
      .from("truck_counts")
      .select("*")
      .gte("date", first)
      .lte("date", last)
      .range(from, from + pageSize - 1);

    if (error) {
      showToast("Greška pri učitavanju podataka: " + error.message, true);
      break;
    }

    for (const row of data ?? []) {
      const day = Number(row.date.slice(8, 10));
      if (!byCompany[row.company_id]) byCompany[row.company_id] = {};
      byCompany[row.company_id][day] = {
        total: row.total,
        start: row.start,
        basic: row.basic,
        advanced: row.advanced,
      };
    }

    if (!data || data.length < pageSize) break;
    from += pageSize;
  }

  return byCompany;
}

async function refreshAll() {
  const [companies, counts] = await Promise.all([
    loadCompanies(),
    loadCounts(state.year, state.month),
  ]);
  state.companies = companies;
  state.counts = counts;
  render();
  scrollToToday();
}

// ---------- coloring rule ----------

// A day within a company's free/trial period (before billing_starts_on)
// is excluded from the month-max / added-truck highlight rules entirely.
function isFreeDay(year, month, day, billingStartsOn) {
  if (!billingStartsOn) return false;
  return dateStr(year, month, day) < billingStartsOn;
}

// T has one flat color for every cell except the first day the month's
// highest total is reached, which is marked red. Days still in the free
// period don't count toward the max and can't be marked red.
function monthMaxDay(companyCounts, nDays, year, month, billingStartsOn) {
  const counts = companyCounts || {};
  let max = -Infinity;
  for (let d = 1; d <= nDays; d++) {
    if (isFreeDay(year, month, d, billingStartsOn)) continue;
    const t = counts[d]?.total;
    if (t !== undefined && t !== null) max = Math.max(max, t);
  }
  if (max === -Infinity) return { max: null, firstDay: null };

  for (let d = 1; d <= nDays; d++) {
    if (isFreeDay(year, month, d, billingStartsOn)) continue;
    if (counts[d]?.total === max) return { max, firstDay: d };
  }
  return { max, firstDay: null };
}

// Highest total seen on any day strictly before `day` (skipping free-period
// days). -Infinity when there's no earlier data, so day 1 always counts as
// a fresh record.
function priorMax(companyCounts, day, year, month, billingStartsOn) {
  const counts = companyCounts || {};
  let max = -Infinity;
  for (let d = 1; d < day; d++) {
    if (isFreeDay(year, month, d, billingStartsOn)) continue;
    const t = counts[d]?.total;
    if (t !== undefined && t !== null) max = Math.max(max, t);
  }
  return max;
}

// A truck was "added" that day when the company's entry column (S, B, or A
// — configurable per company, default Advanced) has a positive value.
// Orange only when the total is a genuinely NEW record — strictly higher
// than any earlier day — not just tied with a level already reached (and
// already billed) before. Merely matching a past peak after a dip is green.
// During the free period there's no "billing max" to call out, so any
// addition is just marked green (purely visual, never orange/red there).
// Days with no addition stay uncolored either way.
function entryColor(dayData, entryCol, total, dayPriorMax, isFree) {
  const value = dayData[entryCol];
  if (!value || value <= 0) return null;
  if (isFree) return "green";
  return total !== undefined && total !== null && total > dayPriorMax ? "orange" : "green";
}

// ---------- rendering ----------

function fmtCell(v) {
  return v === undefined || v === null ? "" : String(v);
}

function render() {
  el.monthLabel.textContent = `${MONTH_NAMES[state.month]} ${state.year}`;

  const nDays = daysInMonth(state.year, state.month);
  const todayDay = isCurrentMonth() ? now.getDate() : null;

  // head row 1: fixed columns (rowspan 2) + one th per day (colspan 4)
  el.gridHeadRow1.innerHTML = "";
  el.gridHeadRow2.innerHTML = "";

  const fixedHeaders = [
    { text: "Firma", cls: "company-col" },
    { text: "Status", cls: "status-col" },
    { text: "Cena", cls: "price-col" },
  ];
  for (const h of fixedHeaders) {
    const th = document.createElement("th");
    th.textContent = h.text;
    th.className = h.cls;
    th.rowSpan = 2;
    el.gridHeadRow1.appendChild(th);
  }

  for (let d = 1; d <= nDays; d++) {
    const th = document.createElement("th");
    th.textContent = String(d);
    th.colSpan = 4;
    th.className = "day-group-header";
    if (d === todayDay) th.classList.add("today-col");
    el.gridHeadRow1.appendChild(th);

    for (const sub of SUB_COLS) {
      const subTh = document.createElement("th");
      subTh.textContent = sub;
      subTh.className = `sub-header sub-${sub.toLowerCase()}`;
      if (d === todayDay) subTh.classList.add("today-col");
      el.gridHeadRow2.appendChild(subTh);
    }
  }

  // body rows
  el.gridBody.innerHTML = "";

  const hasDataThisMonth = (company) => {
    const counts = state.counts[company.id];
    return counts && Object.keys(counts).length > 0;
  };
  const withData = state.companies.filter(hasDataThisMonth);

  const query = state.searchQuery.trim().toLowerCase();
  const matchesFilters = (company) => {
    if (query && !company.name.toLowerCase().includes(query)) return false;
    if (state.statusFilter !== "all" && company.status !== state.statusFilter) return false;
    return true;
  };
  const visibleCompanies = withData.filter(matchesFilters);
  el.emptyState.hidden = visibleCompanies.length > 0;

  const vrhCompanies = visibleCompanies.filter((c) => c.eld_group !== "RST");
  const rstCompanies = visibleCompanies.filter((c) => c.eld_group === "RST");

  for (const company of vrhCompanies) {
    el.gridBody.appendChild(renderCompanyRow(company, nDays, todayDay));
  }
  if (rstCompanies.length > 0) {
    el.gridBody.appendChild(renderSectionRow("RST", nDays));
    for (const company of rstCompanies) {
      el.gridBody.appendChild(renderCompanyRow(company, nDays, todayDay));
    }
  }

  // current month -> today's count; a past month -> that month's last day
  const referenceDay = isCurrentMonth() ? todayDay : nDays;
  updateTotals(
    withData.filter((c) => c.eld_group !== "RST"),
    withData.filter((c) => c.eld_group === "RST"),
    referenceDay
  );
}

// total for a company as of targetDay, walking backward to the most recent
// earlier day with data if targetDay itself hasn't synced yet.
function latestTotalUpTo(companyId, targetDay) {
  if (targetDay === null) return 0;
  const counts = state.counts[companyId] || {};
  for (let d = targetDay; d >= 1; d--) {
    const total = counts[d]?.total;
    if (total !== undefined && total !== null) return total;
  }
  return 0;
}

function updateTotals(vrhCompanies, rstCompanies, referenceDay) {
  const sum = (companies) =>
    companies.reduce((acc, c) => acc + latestTotalUpTo(c.id, referenceDay), 0);
  el.totalVrh.textContent = String(sum(vrhCompanies));
  el.totalRst.textContent = String(sum(rstCompanies));
}

function renderSectionRow(label, nDays) {
  const tr = document.createElement("tr");
  tr.className = "section-row";

  const tdLabel = document.createElement("td");
  tdLabel.colSpan = 3; // company + status + price
  tdLabel.className = "section-label";
  tdLabel.textContent = label;
  tr.appendChild(tdLabel);

  const tdFill = document.createElement("td");
  tdFill.colSpan = nDays * 4;
  tdFill.className = "section-fill";
  tr.appendChild(tdFill);

  return tr;
}

function renderCompanyRow(company, nDays, todayDay) {
  const tr = document.createElement("tr");

  const tdName = document.createElement("td");
  tdName.className = "company-col";
  const fullDisplayName = company.notes ? `${company.name} (${company.notes})` : company.name;
  tdName.dataset.fullname = fullDisplayName;
  const nameText = document.createElement("span");
  nameText.className = "company-name-text";
  const nameMain = document.createElement("span");
  nameMain.className = "company-name-main";
  nameMain.textContent = company.name;
  nameText.appendChild(nameMain);
  if (company.notes) {
    const nameNote = document.createElement("span");
    nameNote.className = "company-name-note";
    nameNote.textContent = ` (${company.notes})`;
    nameText.appendChild(nameNote);
  }
  tdName.appendChild(nameText);
  tdName.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    openCompanyModal(company);
  });
  tr.appendChild(tdName);

  const tdStatus = document.createElement("td");
  tdStatus.className = "status-col";
  const badge = document.createElement("span");
  badge.className = `company-status status-${company.status}`;
  badge.textContent = company.status === "behind" ? "Behind" : "Current";
  tdStatus.appendChild(badge);
  tr.appendChild(tdStatus);

  const tdPrice = document.createElement("td");
  tdPrice.className = "price-col";
  tdPrice.textContent = company.price === null || company.price === undefined ? "" : company.price;
  tr.appendChild(tdPrice);

  const billingStartsOn = company.billing_starts_on || null;
  const { max: monthMax, firstDay: redDay } = monthMaxDay(
    state.counts[company.id], nDays, state.year, state.month, billingStartsOn
  );
  const entryCol = company.entry_column || "advanced";

  for (let d = 1; d <= nDays; d++) {
    const dayData = (state.counts[company.id] || {})[d] || {};
    const isToday = d === todayDay;
    const isFree = isFreeDay(state.year, state.month, d, billingStartsOn);
    const isBillingStartDay = billingStartsOn && dateStr(state.year, state.month, d) === billingStartsOn;
    const dayPriorMax = priorMax(state.counts[company.id], d, state.year, state.month, billingStartsOn);

    const tdT = document.createElement("td");
    tdT.className = "sub-cell sub-t";
    if (isToday) tdT.classList.add("today-col");
    if (d === redDay || isBillingStartDay) tdT.classList.add("cell-red");
    if (isBillingStartDay) tdT.title = "Kraj besplatnog perioda — naplata počinje";

    // ELD sync runs at 15:00; before that today's total isn't in yet, so
    // carry yesterday's number forward as a placeholder.
    if (isToday && (dayData.total === undefined || dayData.total === null)) {
      const yesterday = (state.counts[company.id] || {})[d - 1];
      if (yesterday && yesterday.total !== undefined && yesterday.total !== null) {
        tdT.textContent = fmtCell(yesterday.total);
        tdT.classList.add("carried-forward");
        tdT.title = "Preneto sa juče — čeka ažuriranje u 15h";
      }
    } else {
      tdT.textContent = fmtCell(dayData.total);
    }
    tr.appendChild(tdT);

    for (const field of ["start", "basic", "advanced"]) {
      const letter = field[0]; // s, b, a
      const td = document.createElement("td");
      td.className = `sub-cell sub-${letter}`;
      if (isToday) td.classList.add("today-col");

      if (field === entryCol) {
        td.classList.add("sub-a-editable");
        const color = entryColor(dayData, entryCol, dayData.total, dayPriorMax, isFree);
        if (color === "orange") td.classList.add("cell-orange");
        if (color === "green") td.classList.add("cell-green");

        const input = document.createElement("input");
        input.type = "number";
        input.min = "0";
        input.className = "advanced-input";
        input.value = dayData[field] === undefined || dayData[field] === null ? "" : dayData[field];
        input.addEventListener("change", () => {
          saveEntry(company.id, d, entryCol, input.value);
        });
        td.appendChild(input);
      } else {
        td.textContent = fmtCell(dayData[field]);
      }

      tr.appendChild(td);
    }
  }

  return tr;
}

// ---------- saving an entry-column edit ----------

async function saveEntry(companyId, day, entryCol, rawValue) {
  const date = dateStr(state.year, state.month, day);
  const existing = (state.counts[companyId] || {})[day] || {};

  const value = rawValue === "" ? null : parseInt(rawValue, 10);
  if (rawValue !== "" && (Number.isNaN(value) || value < 0)) {
    showToast("Broj mora biti pozitivan", true);
    return;
  }

  const next = {
    start: existing.start ?? null,
    basic: existing.basic ?? null,
    advanced: existing.advanced ?? null,
    [entryCol]: value,
  };
  const total = (next.start || 0) + (next.basic || 0) + (next.advanced || 0);

  const { error } = await supabase
    .from("truck_counts")
    .upsert(
      { company_id: companyId, date, total, ...next },
      { onConflict: "company_id,date" }
    );

  if (error) {
    showToast("Greška pri upisu: " + error.message, true);
    return;
  }

  if (!state.counts[companyId]) state.counts[companyId] = {};
  state.counts[companyId][day] = { total, ...next };
  render();
  showToast("Sačuvano");
}

// ---------- company edit modal (right-click on name, or a new API company) ----------

function openCompanyModal(company) {
  state.modalMode = "edit";
  state.editingCompanyId = company.id;
  el.companyModalTitle.textContent = "Izmena firme";
  el.companyModalName.textContent = company.name;
  el.companyStatus.value = company.status;
  el.companyPrice.value = company.price === null || company.price === undefined ? "" : company.price;
  el.companyTax.value = company.tax === null || company.tax === undefined ? "" : company.tax;
  el.companyEntryColumn.value = company.entry_column || "advanced";
  el.companyBillingStartsOn.value = company.billing_starts_on || "";
  el.companyNotes.value = company.notes || "";
  el.companyModal.hidden = false;
}

function openNewCompanyModal(newCompany) {
  state.modalMode = "new";
  state.editingCompanyId = null;
  state.pendingNewCompany = newCompany;
  el.companyModalTitle.textContent = "Nova firma iz API-ja";
  el.companyModalName.textContent = `${newCompany.name} (${newCompany.eld_group})`;
  el.companyStatus.value = "current";
  el.companyPrice.value = "";
  el.companyTax.value = "";
  el.companyEntryColumn.value = "advanced";
  el.companyBillingStartsOn.value = "";
  el.companyNotes.value = "";
  el.companyModal.hidden = false;
}

function closeCompanyModal() {
  el.companyModal.hidden = true;
  el.companyForm.reset();
  state.editingCompanyId = null;
  state.pendingNewCompany = null;
}

el.cancelCompanyBtn.addEventListener("click", () => {
  const wasNew = state.modalMode === "new";
  closeCompanyModal();
  if (wasNew) openNextNewCompanyPrompt();
});
el.companyModal.addEventListener("click", (e) => {
  if (e.target === el.companyModal) {
    const wasNew = state.modalMode === "new";
    closeCompanyModal();
    if (wasNew) openNextNewCompanyPrompt();
  }
});

el.companyForm.addEventListener("submit", async (e) => {
  e.preventDefault();

  const payload = {
    status: el.companyStatus.value,
    price: el.companyPrice.value === "" ? null : parseFloat(el.companyPrice.value),
    tax: el.companyTax.value === "" ? null : parseFloat(el.companyTax.value),
    entry_column: el.companyEntryColumn.value,
    billing_starts_on: el.companyBillingStartsOn.value === "" ? null : el.companyBillingStartsOn.value,
    notes: el.companyNotes.value.trim() === "" ? null : el.companyNotes.value.trim(),
  };

  if (state.modalMode === "new") {
    if (!state.pendingNewCompany) return;
    const { error } = await supabase.from("companies").insert({
      ...payload,
      name: state.pendingNewCompany.name,
      external_id: state.pendingNewCompany.external_id,
      eld_group: state.pendingNewCompany.eld_group,
    });
    if (error) {
      showToast("Greška pri dodavanju firme: " + error.message, true);
      return;
    }
    closeCompanyModal();
    await refreshAll();
    showToast("Nova firma dodata");
    openNextNewCompanyPrompt();
    return;
  }

  if (!state.editingCompanyId) return;

  const { error } = await supabase
    .from("companies")
    .update(payload)
    .eq("id", state.editingCompanyId);

  if (error) {
    showToast("Greška pri čuvanju firme: " + error.message, true);
    return;
  }

  closeCompanyModal();
  await refreshAll();
  showToast("Sačuvano");
});

// ---------- detect new companies appearing in the ELD API ----------

function openNextNewCompanyPrompt() {
  if (state.newCompanyQueue.length === 0) return;
  const next = state.newCompanyQueue.shift();
  openNewCompanyModal(next);
}

async function checkForNewCompanies() {
  let apiData;
  try {
    const resp = await fetch(ELD_API_URL);
    apiData = (await resp.json())?.data?.companies;
  } catch (err) {
    console.error("checkForNewCompanies fetch failed", err);
    return;
  }
  if (!apiData) return;

  const knownExternalIds = new Set(
    state.companies.map((c) => c.external_id).filter(Boolean)
  );
  const skipNames = new Set(["test_vrh", "vrh training"]);

  const found = [];
  for (const [externalId, v] of Object.entries(apiData)) {
    const name = (v.name || "").trim();
    if (!name || skipNames.has(name.toLowerCase())) continue;
    if (knownExternalIds.has(externalId)) continue;
    found.push({
      external_id: externalId,
      name,
      eld_group: v.account_name === "VRHELD" ? "VRH" : "RST",
    });
  }

  if (found.length > 0) {
    state.newCompanyQueue.push(...found);
    if (el.companyModal.hidden) openNextNewCompanyPrompt();
  }
}

// ---------- scroll so today's column is centered on first load ----------

function scrollToToday() {
  if (state.hasScrolledToToday || !isCurrentMonth()) return;
  const todayHeader = el.gridHeadRow1.querySelector(".day-group-header.today-col");
  const priceHeader = el.gridHeadRow1.querySelector(".price-col");
  if (!todayHeader || !priceHeader || !el.tableWrap) return;

  const stickyWidth = priceHeader.offsetLeft + priceHeader.offsetWidth;
  const containerWidth = el.tableWrap.clientWidth;
  const target =
    todayHeader.offsetLeft +
    todayHeader.offsetWidth / 2 -
    stickyWidth -
    (containerWidth - stickyWidth) / 2;

  el.tableWrap.scrollLeft = Math.max(0, target);
  state.hasScrolledToToday = true;
}

// ---------- search & status filter ----------

el.searchInput.addEventListener("input", () => {
  state.searchQuery = el.searchInput.value;
  render();
});

el.statusFilter.addEventListener("change", () => {
  state.statusFilter = el.statusFilter.value;
  render();
});

// ---------- month navigation ----------

el.prevMonth.addEventListener("click", async () => {
  state.month -= 1;
  if (state.month < 0) {
    state.month = 11;
    state.year -= 1;
  }
  state.counts = await loadCounts(state.year, state.month);
  render();
});

el.nextMonth.addEventListener("click", async () => {
  state.month += 1;
  if (state.month > 11) {
    state.month = 0;
    state.year += 1;
  }
  state.counts = await loadCounts(state.year, state.month);
  render();
});

// ---------- excel import ----------

el.importBtn.addEventListener("click", () => el.importFile.click());

el.importFile.addEventListener("change", async () => {
  const file = el.importFile.files[0];
  el.importFile.value = "";
  if (!file) return;

  try {
    await importExcelFile(file);
  } catch (err) {
    console.error(err);
    showToast("Greška pri uvozu: " + err.message, true);
  }
});

const METADATA_HEADERS = {
  price: ["cena", "price"],
  status: ["status", "rola", "role"],
  trial: ["trial", "trial do", "trial_until", "trial period"],
  name: ["firma", "naziv", "company", "name"],
};

function matchHeader(label, list) {
  return list.includes(String(label).trim().toLowerCase());
}

function excelDateToStr(value) {
  // XLSX date cells come through as JS Date objects when cellDates:true
  if (value instanceof Date) {
    return dateStr(value.getFullYear(), value.getMonth(), value.getDate());
  }
  return null;
}

function classifyHeader(value) {
  if (value === null || value === undefined || value === "") return { type: "skip" };

  if (typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 31) {
    return { type: "day", day: value };
  }

  if (value instanceof Date) {
    return { type: "date", date: excelDateToStr(value) };
  }

  const label = String(value).trim();
  if (matchHeader(label, METADATA_HEADERS.name)) return { type: "name" };
  if (matchHeader(label, METADATA_HEADERS.price)) return { type: "price" };
  if (matchHeader(label, METADATA_HEADERS.status)) return { type: "status" };
  if (matchHeader(label, METADATA_HEADERS.trial)) return { type: "trial" };

  if (/^\d{1,2}$/.test(label)) {
    const day = parseInt(label, 10);
    if (day >= 1 && day <= 31) return { type: "day", day };
  }

  const isoMatch = label.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (isoMatch) return { type: "date", date: label };

  const euMatch = label.match(/^(\d{1,2})[.\/](\d{1,2})[.\/](\d{4})$/);
  if (euMatch) {
    const [, dd, mm, yyyy] = euMatch;
    return { type: "date", date: `${yyyy}-${pad(Number(mm))}-${pad(Number(dd))}` };
  }

  return { type: "skip" };
}

async function importExcelFile(file) {
  const buffer = await file.arrayBuffer();
  const workbook = XLSX.read(buffer, { type: "array", cellDates: true });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: true, defval: "" });

  if (rows.length < 2) {
    showToast("Fajl nema podataka", true);
    return;
  }

  const headerRow = rows[0];
  const columns = headerRow.map((h, idx) => (idx === 0 ? { type: "name" } : classifyHeader(h)));

  const existingByName = new Map(state.companies.map((c) => [c.name.trim().toLowerCase(), c]));

  let companiesImported = 0;
  let countsImported = 0;

  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    if (!row || row.every((v) => v === "" || v === undefined || v === null)) continue;

    const name = String(row[0] ?? "").trim();
    if (!name) continue;

    const companyPayload = { name };
    const dayCounts = []; // { date, total }

    for (let c = 1; c < columns.length; c++) {
      const col = columns[c];
      const raw = row[c];
      if (col.type === "skip" || raw === "" || raw === undefined || raw === null) continue;

      if (col.type === "price") {
        const num = parseFloat(raw);
        if (!Number.isNaN(num)) companyPayload.price = num;
      } else if (col.type === "status") {
        const s = String(raw).trim().toLowerCase();
        companyPayload.status = s === "behind" ? "behind" : "current";
      } else if (col.type === "trial") {
        const d = excelDateToStr(raw) || String(raw).trim();
        if (d) companyPayload.billing_starts_on = d;
      } else if (col.type === "day") {
        const total = parseInt(raw, 10);
        if (!Number.isNaN(total)) {
          dayCounts.push({ date: dateStr(state.year, state.month, col.day), total });
        }
      } else if (col.type === "date") {
        const total = parseInt(raw, 10);
        if (!Number.isNaN(total) && col.date) {
          dayCounts.push({ date: col.date, total });
        }
      }
    }

    let companyId = existingByName.get(name.toLowerCase())?.id;

    if (companyId) {
      if (Object.keys(companyPayload).length > 1) {
        await supabase.from("companies").update(companyPayload).eq("id", companyId);
      }
    } else {
      const { data, error } = await supabase
        .from("companies")
        .insert(companyPayload)
        .select("id")
        .single();
      if (error) {
        console.error(error);
        continue;
      }
      companyId = data.id;
      existingByName.set(name.toLowerCase(), { id: companyId, name });
      companiesImported++;
    }

    if (dayCounts.length > 0) {
      const { error } = await supabase
        .from("truck_counts")
        .upsert(
          dayCounts.map((dc) => ({ company_id: companyId, date: dc.date, total: dc.total })),
          { onConflict: "company_id,date" }
        );
      if (!error) countsImported += dayCounts.length;
    }
  }

  await refreshAll();
  showToast(`Uvezeno: ${companiesImported} novih firmi, ${countsImported} unosa`);
}

// ---------- page navigation ----------

function showPage(page) {
  el.pageOverview.hidden = page !== "overview";
  el.pageReports.hidden = page !== "reports";
  el.navOverview.classList.toggle("is-active", page === "overview");
  el.navReports.classList.toggle("is-active", page === "reports");
  if (page === "reports" && !el.reportContent.dataset.rendered) {
    runReport();
  }
}

el.navOverview.addEventListener("click", () => showPage("overview"));
el.navReports.addEventListener("click", () => showPage("reports"));

// ---------- reports: shared scaffolding ----------

el.reportDate.value = dateStr(now.getFullYear(), now.getMonth(), now.getDate());

function setReportType(type) {
  state.reportType = type;
  el.reportTabDaily.classList.toggle("is-active", type === "daily");
  el.reportTabBehind.classList.toggle("is-active", type === "behind");
  el.reportTabCurrent.classList.toggle("is-active", type === "current");
  el.reportDateLabel.firstChild.textContent =
    type === "behind" || type === "current" ? "Mesec (bilo koji dan) " : "Datum ";
  delete el.reportContent.dataset.rendered;
  runReport();
}

el.reportTabDaily.addEventListener("click", () => setReportType("daily"));
el.reportTabBehind.addEventListener("click", () => setReportType("behind"));
el.reportTabCurrent.addEventListener("click", () => setReportType("current"));

el.generateReportBtn.addEventListener("click", runReport);

function runReport() {
  if (state.reportType === "behind") {
    generateBehindReport(el.reportDate.value);
  } else if (state.reportType === "current") {
    generateCurrentReport(el.reportDate.value);
  } else {
    generateDailyReport(el.reportDate.value);
  }
}

el.downloadPdfBtn.addEventListener("click", () => {
  if (!el.reportContent.dataset.rendered) {
    showToast("Prvo generiši izveštaj", true);
    return;
  }
  const label = state.reportType === "behind" ? "behind-izvestaj" : "dnevni-izvestaj";
  const filename = `${label}-${el.reportDate.value}.pdf`;
  html2pdf()
    .set({
      filename,
      margin: 10,
      html2canvas: { scale: 2 },
      jsPDF: { unit: "mm", format: "a4", orientation: "portrait" },
      pagebreak: { mode: ["css", "legacy"] },
    })
    .from(el.reportContent)
    .save();
});

function el_(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function buildReportList(items, valueLabel) {
  const ul = el_("ul", "report-list");
  if (items.length === 0) {
    ul.appendChild(el_("li", "empty", "Nema"));
    return ul;
  }
  for (const item of items) {
    const li = document.createElement("li");
    li.appendChild(el_("span", null, item.name));
    li.appendChild(el_("span", null, `${valueLabel} ${item.value}`));
    ul.appendChild(li);
  }
  return ul;
}

async function generateDailyReport(dateValue) {
  if (!dateValue) return;
  const [y, m, d] = dateValue.split("-").map(Number);
  const year = y;
  const month = m - 1; // 0-indexed
  const day = d;
  const nDays = daysInMonth(year, month);

  el.reportContent.innerHTML = "";
  el.reportContent.appendChild(el_("p", "section-hint", "Učitavanje..."));

  const counts = await loadCounts(year, month);
  const companies = state.companies.filter((c) => {
    const cCounts = counts[c.id];
    return cCounts && Object.keys(cCounts).length > 0;
  });

  const vrh = companies.filter((c) => c.eld_group !== "RST");
  const rst = companies.filter((c) => c.eld_group === "RST");

  const totalFor = (list) =>
    list.reduce((acc, c) => {
      const dc = counts[c.id] || {};
      for (let dd = day; dd >= 1; dd--) {
        const t = dc[dd]?.total;
        if (t !== undefined && t !== null) return acc + t;
      }
      return acc;
    }, 0);

  const addedFor = (list) => {
    const out = [];
    for (const c of list) {
      const dc = counts[c.id] || {};
      const entryCol = c.entry_column || "advanced";
      const val = dc[day]?.[entryCol];
      if (val && val > 0) {
        const billingStartsOn = c.billing_starts_on || null;
        const isFree = isFreeDay(year, month, day, billingStartsOn);
        // treat the report's date as "today": only compare against days
        // strictly before it, so a bigger count that happened afterward
        // (out of scope for a historical report) can't affect this day,
        // and merely re-reaching an already-billed past peak isn't orange.
        const dayPriorMax = priorMax(dc, day, year, month, billingStartsOn);
        const total = dc[day]?.total;
        const color = entryColor(dc[day], entryCol, total, dayPriorMax, isFree);
        // billable quantity is only the part that's a genuinely new record —
        // e.g. if the count dipped and this day's raw addition climbs back
        // past an already-billed peak, only the excess past that peak counts.
        const billable = total !== undefined && total !== null && total > dayPriorMax
          ? Math.min(val, total - dayPriorMax)
          : 0;
        out.push({ name: c.name, value: val, billable, company: c, color });
      }
    }
    return out;
  };

  const removedFor = (list) => {
    const out = [];
    for (const c of list) {
      const dc = counts[c.id] || {};
      const today = dc[day]?.total;
      const prev = dc[day - 1]?.total;
      if (today !== undefined && today !== null && prev !== undefined && prev !== null && today < prev) {
        out.push({ name: c.name, value: prev - today });
      }
    }
    return out;
  };

  const vrhAdded = addedFor(vrh);
  const rstAdded = addedFor(rst);
  const vrhRemoved = removedFor(vrh);
  const rstRemoved = removedFor(rst);

  // detailed pricing: current-status companies whose total set a new
  // all-time record today. price is prorated: (monthly price / days in
  // month) * days remaining in the month (including today), multiplied by
  // only the billable (genuinely new) devices — see addedFor().
  const remainingDays = nDays - day + 1;
  const detailRows = [...vrhAdded, ...rstAdded]
    .filter((item) => item.company.status === "current" && item.color === "orange" && item.billable > 0)
    .map((item) => {
      const price = item.company.price || 0;
      const dailyRate = price / nDays;
      const proratedPrice = dailyRate * remainingDays;
      const amount = proratedPrice * item.billable;
      return { name: item.name, added: item.billable, proratedPrice, amount };
    });
  const grandTotal = detailRows.reduce((acc, r) => acc + r.amount, 0);

  // ---- render ----
  el.reportContent.innerHTML = "";
  el.reportContent.dataset.rendered = "1";

  const totalsRow = el_("div", "report-totals");
  const vrhCard = el_("div", "report-total-card");
  vrhCard.appendChild(el_("div", "label", "VRH"));
  vrhCard.appendChild(el_("div", "value", String(totalFor(vrh))));
  totalsRow.appendChild(vrhCard);
  const rstCard = el_("div", "report-total-card");
  rstCard.appendChild(el_("div", "label", "RST"));
  rstCard.appendChild(el_("div", "value", String(totalFor(rst))));
  totalsRow.appendChild(rstCard);
  const grandCard = el_("div", "report-total-card highlight");
  grandCard.appendChild(el_("div", "label", "Ukupno"));
  grandCard.appendChild(el_("div", "value", String(totalFor(vrh) + totalFor(rst))));
  totalsRow.appendChild(grandCard);
  el.reportContent.appendChild(totalsRow);

  const addedSection = el_("section", "report-section");
  addedSection.appendChild(el_("h2", null, "Dodati uređaji"));
  const addedCols = el_("div", "report-columns");
  const vrhAddedGroup = el_("div", "report-group");
  vrhAddedGroup.appendChild(el_("h3", null, "VRH"));
  vrhAddedGroup.appendChild(buildReportList(vrhAdded, "+"));
  addedCols.appendChild(vrhAddedGroup);
  const rstAddedGroup = el_("div", "report-group");
  rstAddedGroup.appendChild(el_("h3", null, "RST"));
  rstAddedGroup.appendChild(buildReportList(rstAdded, "+"));
  addedCols.appendChild(rstAddedGroup);
  addedSection.appendChild(addedCols);
  el.reportContent.appendChild(addedSection);

  const removedSection = el_("section", "report-section");
  removedSection.appendChild(el_("h2", null, "Uklonjeni uređaji"));
  const removedCols = el_("div", "report-columns");
  const vrhRemovedGroup = el_("div", "report-group");
  vrhRemovedGroup.appendChild(el_("h3", null, "VRH"));
  vrhRemovedGroup.appendChild(buildReportList(vrhRemoved, "−"));
  removedCols.appendChild(vrhRemovedGroup);
  const rstRemovedGroup = el_("div", "report-group");
  rstRemovedGroup.appendChild(el_("h3", null, "RST"));
  rstRemovedGroup.appendChild(buildReportList(rstRemoved, "−"));
  removedCols.appendChild(rstRemovedGroup);
  removedSection.appendChild(removedCols);
  el.reportContent.appendChild(removedSection);

  const detailSection = el_("section", "report-section");
  detailSection.appendChild(el_("h2", null, "Detaljan prikaz (current)"));
  detailSection.appendChild(el_(
    "p", "section-hint",
    `Samo aktivacije koje su dostigle mesečni maksimum (narandžasto). Cena je proporcionalna preostalim danima u mesecu (${remainingDays} od ${nDays})`
  ));
  const table = document.createElement("table");
  table.className = "report-table";
  const thead = document.createElement("thead");
  const headRow = document.createElement("tr");
  for (const h of ["Firma", "Novi uređaji", "Cena po uređaju", "Iznos"]) {
    headRow.appendChild(el_("th", null, h));
  }
  thead.appendChild(headRow);
  table.appendChild(thead);

  const tbody = document.createElement("tbody");
  if (detailRows.length === 0) {
    const tr = document.createElement("tr");
    const td = el_("td", "section-hint", "Nema aktivacija current firmi ovog dana");
    td.colSpan = 4;
    td.style.textAlign = "center";
    tr.appendChild(td);
    tbody.appendChild(tr);
  } else {
    for (const r of detailRows) {
      const tr = document.createElement("tr");
      tr.appendChild(el_("td", null, r.name));
      tr.appendChild(el_("td", null, String(r.added)));
      tr.appendChild(el_("td", null, r.proratedPrice.toFixed(2)));
      tr.appendChild(el_("td", null, r.amount.toFixed(2)));
      tbody.appendChild(tr);
    }
  }
  table.appendChild(tbody);

  const tfoot = document.createElement("tfoot");
  const footRow = document.createElement("tr");
  const footLabel = el_("td", null, "Ukupno");
  footLabel.colSpan = 3;
  footRow.appendChild(footLabel);
  footRow.appendChild(el_("td", null, grandTotal.toFixed(2)));
  tfoot.appendChild(footRow);
  table.appendChild(tfoot);

  detailSection.appendChild(table);
  el.reportContent.appendChild(detailSection);
}

// ---------- behind report (25th of prev month through 24th of this month) ----------

function getCycleDates(year, month) {
  let prevYear = year;
  let prevMonth = month - 1;
  if (prevMonth < 0) {
    prevMonth = 11;
    prevYear -= 1;
  }
  const prevDays = daysInMonth(prevYear, prevMonth);
  const dates = [];
  for (let d = 25; d <= prevDays; d++) dates.push({ year: prevYear, month: prevMonth, day: d });
  for (let d = 1; d <= 24; d++) dates.push({ year, month, day: d });
  return { prevYear, prevMonth, dates };
}

async function generateBehindReport(dateValue) {
  if (!dateValue) return;
  const [y, m] = dateValue.split("-").map(Number);
  const year = y;
  const month = m - 1;

  el.reportContent.innerHTML = "";
  el.reportContent.appendChild(el_("p", "section-hint", "Učitavanje..."));

  const { prevYear, prevMonth, dates } = getCycleDates(year, month);
  const [countsPrev, countsCur] = await Promise.all([
    loadCounts(prevYear, prevMonth),
    loadCounts(year, month),
  ]);

  const dayInfo = (companyId, d) => {
    const src = d.year === prevYear && d.month === prevMonth ? countsPrev : countsCur;
    return (src[companyId] || {})[d.day] || {};
  };

  const behindCompanies = state.companies.filter((c) => c.status === "behind");

  const companyBlocks = [];

  for (const c of behindCompanies) {
    const entryCol = c.entry_column || "advanced";
    const billingStartsOn = c.billing_starts_on || null;
    const price = c.price || 0;

    // baseline: count as of the cycle's first day (25th of prev month)
    let baselineCount = null;
    const startInfo = dayInfo(c.id, dates[0]);
    if (startInfo.total !== undefined && startInfo.total !== null) {
      baselineCount = startInfo.total;
    } else {
      // walk backward through the rest of the previous month if the 25th itself is a gap
      for (let dd = dates[0].day - 1; dd >= 1; dd--) {
        const t = (countsPrev[c.id] || {})[dd]?.total;
        if (t !== undefined && t !== null) {
          baselineCount = t;
          break;
        }
      }
    }

    let runningMax = baselineCount !== null ? baselineCount : -Infinity;
    const additions = [];

    for (let i = 1; i < dates.length; i++) {
      const d = dates[i];
      const info = dayInfo(c.id, d);
      const total = info.total;
      const addedVal = info[entryCol];
      const isFree = isFreeDay(d.year, d.month, d.day, billingStartsOn);

      if (addedVal && addedVal > 0 && !isFree && total !== undefined && total !== null && total > runningMax) {
        // only the genuinely new portion is billable — if this day's raw
        // addition climbs back past an already-billed peak (after a dip),
        // the recovered units don't count again, only the true excess.
        const billable = Math.min(addedVal, total - runningMax);
        if (billable > 0) {
          // prorate against the billing CYCLE (25th–24th), not the calendar
          // month — a device added Aug 4 is only owed through the cycle's
          // Aug 24 end, not through Aug 31.
          const remainingInCycle = dates.length - i;
          const proratedPrice = (price / dates.length) * remainingInCycle;
          const amount = proratedPrice * billable;
          additions.push({ date: dateStr(d.year, d.month, d.day), added: billable, proratedPrice, amount });
        }
      }
      if (total !== undefined && total !== null) runningMax = Math.max(runningMax, total);
    }

    if (baselineCount === null && additions.length === 0) continue;

    const baselineAmount = (baselineCount || 0) * price;
    const additionsTotal = additions.reduce((acc, a) => acc + a.amount, 0);
    const companyTotal = baselineAmount + additionsTotal;

    companyBlocks.push({ company: c, baselineCount: baselineCount || 0, price, baselineAmount, additions, companyTotal });
  }

  const grandTotal = companyBlocks.reduce((acc, b) => acc + b.companyTotal, 0);

  el.reportContent.innerHTML = "";
  el.reportContent.dataset.rendered = "1";

  el.reportContent.appendChild(el_(
    "p", "section-hint",
    `Obračunski period: ${dateStr(prevYear, prevMonth, 25)} — ${dateStr(year, month, 24)}`
  ));

  if (companyBlocks.length === 0) {
    el.reportContent.appendChild(el_("p", "section-hint", "Nema behind firmi sa podacima u ovom periodu."));
    return;
  }

  for (const block of companyBlocks) {
    const section = el_("section", "report-section");
    section.appendChild(el_("h2", null, block.company.name));

    const table = document.createElement("table");
    table.className = "report-table";
    const thead = document.createElement("thead");
    const headRow = document.createElement("tr");
    for (const h of ["Stavka", "Uređaji", "Cena po uređaju", "Iznos"]) {
      headRow.appendChild(el_("th", null, h));
    }
    thead.appendChild(headRow);
    table.appendChild(thead);

    const tbody = document.createElement("tbody");
    const baseRow = document.createElement("tr");
    baseRow.appendChild(el_("td", null, `Stanje na ${dateStr(prevYear, prevMonth, 25)} (puna cena)`));
    baseRow.appendChild(el_("td", null, String(block.baselineCount)));
    baseRow.appendChild(el_("td", null, block.price.toFixed(2)));
    baseRow.appendChild(el_("td", null, block.baselineAmount.toFixed(2)));
    tbody.appendChild(baseRow);

    for (const a of block.additions) {
      const tr = document.createElement("tr");
      tr.appendChild(el_("td", null, `Novi uređaj — ${a.date}`));
      tr.appendChild(el_("td", null, String(a.added)));
      tr.appendChild(el_("td", null, a.proratedPrice.toFixed(2)));
      tr.appendChild(el_("td", null, a.amount.toFixed(2)));
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);

    const tfoot = document.createElement("tfoot");
    const footRow = document.createElement("tr");
    const footLabel = el_("td", null, "Ukupno za firmu");
    footLabel.colSpan = 3;
    footRow.appendChild(footLabel);
    footRow.appendChild(el_("td", null, block.companyTotal.toFixed(2)));
    tfoot.appendChild(footRow);
    table.appendChild(tfoot);

    section.appendChild(table);
    el.reportContent.appendChild(section);
  }

  const grandSection = el_("section", "report-section");
  const grandCard = el_("div", "report-total-card highlight");
  grandCard.appendChild(el_("div", "label", "Ukupno — sve behind firme"));
  grandCard.appendChild(el_("div", "value", grandTotal.toFixed(2)));
  grandSection.appendChild(grandCard);
  el.reportContent.appendChild(grandSection);
}

// ---------- current report (all current companies, priced from the 1st of the month) ----------

async function generateCurrentReport(dateValue) {
  if (!dateValue) return;
  const [y, m] = dateValue.split("-").map(Number);
  const year = y;
  const month = m - 1;

  el.reportContent.innerHTML = "";
  el.reportContent.appendChild(el_("p", "section-hint", "Učitavanje..."));

  const counts = await loadCounts(year, month);
  const currentCompanies = state.companies.filter((c) => c.status === "current");

  const rows = [];
  for (const c of currentCompanies) {
    const dc = counts[c.id] || {};
    const count = dc[1]?.total;
    if (count === undefined || count === null) continue;
    const price = c.price || 0;
    const amount = count * price;
    rows.push({ name: c.name, count, price, amount });
  }
  const grandTotal = rows.reduce((acc, r) => acc + r.amount, 0);

  el.reportContent.innerHTML = "";
  el.reportContent.dataset.rendered = "1";

  el.reportContent.appendChild(el_(
    "p", "section-hint",
    `Stanje na 1.${pad(month + 1)}.${year}, puna mesečna cena za sve current firme`
  ));

  const section = el_("section", "report-section");
  const table = document.createElement("table");
  table.className = "report-table";
  const thead = document.createElement("thead");
  const headRow = document.createElement("tr");
  for (const h of ["Firma", "Uređaji (1. u mesecu)", "Cena po uređaju", "Iznos"]) {
    headRow.appendChild(el_("th", null, h));
  }
  thead.appendChild(headRow);
  table.appendChild(thead);

  const tbody = document.createElement("tbody");
  if (rows.length === 0) {
    const tr = document.createElement("tr");
    const td = el_("td", "section-hint", "Nema current firmi sa podacima za 1. u mesecu");
    td.colSpan = 4;
    td.style.textAlign = "center";
    tr.appendChild(td);
    tbody.appendChild(tr);
  } else {
    for (const r of rows) {
      const tr = document.createElement("tr");
      tr.appendChild(el_("td", null, r.name));
      tr.appendChild(el_("td", null, String(r.count)));
      tr.appendChild(el_("td", null, r.price.toFixed(2)));
      tr.appendChild(el_("td", null, r.amount.toFixed(2)));
      tbody.appendChild(tr);
    }
  }
  table.appendChild(tbody);

  const tfoot = document.createElement("tfoot");
  const footRow = document.createElement("tr");
  const footLabel = el_("td", null, "Ukupno");
  footLabel.colSpan = 3;
  footRow.appendChild(footLabel);
  footRow.appendChild(el_("td", null, grandTotal.toFixed(2)));
  tfoot.appendChild(footRow);
  table.appendChild(tfoot);

  section.appendChild(table);
  el.reportContent.appendChild(section);

  const grandSection = el_("section", "report-section");
  const grandCard = el_("div", "report-total-card highlight");
  grandCard.appendChild(el_("div", "label", "Ukupno — sve current firme"));
  grandCard.appendChild(el_("div", "value", grandTotal.toFixed(2)));
  grandSection.appendChild(grandCard);
  el.reportContent.appendChild(grandSection);
}

// ---------- init ----------

refreshAll().then(checkForNewCompanies);
