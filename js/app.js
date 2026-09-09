import { supabase, supabaseAdminCreate } from "./supabase.js";

const MONTH_NAMES = [
  "Januar", "Februar", "Mart", "April", "Maj", "Jun",
  "Jul", "Avgust", "Septembar", "Oktobar", "Novembar", "Decembar",
];

const SUB_COLS = ["T", "S", "B", "A"];
const ELD_API_URL = "https://royal-paper-656b.dackello77.workers.dev/";
// Cloudflare Worker koji stvarno šalje fakturu emailom (Resend API) — vidi
// worker/invoice-email-worker.js za kod i uputstvo za deploy.
const INVOICE_EMAIL_WORKER_URL = "https://vrh-invoice-email.dackello77.workers.dev/";
// Test faza: sve fakture idu ovde bez obzira na email upisan kod firme u
// Podešavanjima (to polje se tek popunjava, za kasnije kad se pređe na
// slanje na stvarne adrese firmi).
const TEST_INVOICE_EMAIL = "dackello77@gmail.com";
// Fiksna cena za "S - Start" nivo, nezavisno od company.price — Start firme
// (bilo koji status) se tretiraju kao behind i naplaćuju po ovoj ceni umesto
// proporcionalnog "current" obračuna. Vidi computeCurrentDetailRows i
// generateBehindReport.
const START_TIER_PRICE = 25;
const MANUALLY_VISIBLE_COMPANIES_KEY = "vrhManuallyVisibleCompanyIds";
const LAST_PAGE_KEY = "vrhLastPage";
const VALID_PAGES = ["home", "overview", "reports", "naplata", "orders", "stock", "settings"];
const PAGE_LABELS = {
  home: "Početna",
  overview: "Pregled uređaja",
  reports: "Izveštaj",
  naplata: "Naplata",
  orders: "Porudžbine",
  stock: "Stanje uređaja",
  settings: "Podešavanja",
};
const NAV_BTN_BY_PAGE = {
  home: "navHome",
  overview: "navOverview",
  reports: "navReports",
  naplata: "navNaplata",
  orders: "navOrders",
  stock: "navStock",
  settings: "navSettings",
};

const now = new Date();

// Pamti poslednju otvorenu stranu da refresh (F5) ostane tu gde je korisnik
// bio, umesto da uvek vraća na Početnu.
function loadLastPage() {
  try {
    const p = localStorage.getItem(LAST_PAGE_KEY);
    return VALID_PAGES.includes(p) ? p : "home";
  } catch {
    return "home";
  }
}

function saveLastPage(page) {
  try {
    localStorage.setItem(LAST_PAGE_KEY, page);
  } catch {
    // npr. privatni režim bez localStorage — refresh će vratiti na Početnu
  }
}

// Firme sačuvane kroz "Nova firma iz API-ja" modal treba da se odmah vide u
// Pregled kamiona, i pre nego što stigne prva ELD sinhronizacija brojeva
// (koja bi ih inače filtrirala kao "nema podataka ovaj mesec" — vidi
// hasDataThisMonth u render()). Čuva se u localStorage da ostane vidljivo i
// posle refresh-a stranice dok ne stignu stvarni podaci.
function loadManuallyVisibleCompanyIds() {
  try {
    const raw = localStorage.getItem(MANUALLY_VISIBLE_COMPANIES_KEY);
    return new Set(raw ? JSON.parse(raw) : []);
  } catch {
    return new Set();
  }
}

function markCompanyManuallyVisible(companyId) {
  state.manuallyVisibleCompanyIds.add(companyId);
  try {
    localStorage.setItem(MANUALLY_VISIBLE_COMPANIES_KEY, JSON.stringify([...state.manuallyVisibleCompanyIds]));
  } catch {
    // npr. privatni režim bez localStorage — firma ostaje vidljiva samo u ovoj sesiji
  }
}

const state = {
  year: now.getFullYear(),
  month: now.getMonth(), // 0-indexed
  companies: [],
  counts: {}, // { companyId: { day: { total, start, basic, advanced } } }
  prevMonthTailCounts: {}, // { companyId: total } — poslednji dan prethodnog meseca, za 1. u mesecu dok danasnji sync ne stigne
  editingCompanyId: null,
  hasScrolledToToday: false,
  searchQuery: "",
  statusFilter: "all",
  modalMode: "edit", // "edit" | "new"
  pendingNewCompany: null, // { external_id, name, eld_group }
  newCompanyQueue: [],
  manuallyVisibleCompanyIds: loadManuallyVisibleCompanyIds(), // firme sačuvane iz "Nova firma iz API-ja" modala — vidljive u Pregled kamiona i pre nego što stigne prva ELD sinhronizacija brojeva
  reportType: "daily", // "daily" | "behind" | "current"
  lastCurrentReport: null, // { dateValue, rows } — poslednje generisan Current izveštaj, za "Pošalji u naplatu"
  currentInvoice: null, // otvorena faktura u invoiceModal (red iz "invoices" tabele)
  currentInvoiceCompany: null,
  currentInvoiceButton: null, // dugme u "Detaljan prikaz" tabeli koje je otvorilo modal — oboji se narandžasto posle uspešnog slanja
  manualInvoice: null, // otvorena faktura u behindInvoiceModal (red iz "invoices" tabele, manual: true)
  manualInvoiceCompany: null,
  manualInvoiceItems: [], // [{ id, type: "basic"|"advanced", note, qty, rate }] — editable stavke ručne Behind fakture
  manualInvoiceButton: null, // dugme u Behind izveštaju koje je otvorilo modal
  naplata: [],
  naplataLoaded: false,
  naplataTab: "active", // "active" | "closed"
  naplataModalMode: "edit", // "edit" | "new"
  editingNaplataId: null,
  expandedNaplataGroups: new Set(), // company_id set — which grouped active rows are expanded
  naplataGroupsSeen: new Set(), // active: group keys already auto-opened once — lets a manual collapse stick
  expandedNaplataMonths: new Set([`${now.getFullYear()}-${pad(now.getMonth() + 1)}`]), // Zatvoreno: tekući mesec otvoren po defaultu
  naplataStatsMonth: `${now.getFullYear()}-${pad(now.getMonth() + 1)}`, // mesec izabran u statistici u sidebaru
  products: [],
  productsLoaded: false,
  companyPrices: [], // [{ id, company_id, product_id, price }]
  companyPricesLoaded: false,
  companyPriceLookup: [], // [{ id, name_key, display_name, price, source, updated_at }] — istorijski cenovnik iz Billing count control.xlsx
  companyPriceLookupLoaded: false,
  deviceUnits: [],
  deviceUnitsLoaded: false,
  ocrCandidateSerials: [], // [{ text, checked }] radni spisak dok se pregledaju OCR rezultati
  stockPendingItems: [], // [{ type:"device", productId, productName, serial } | { type:"connector", productId, productName, qty }] - lista u "+ Dodaj" modalu pre klika na Sačuvaj
  expandedStockDeviceTypes: new Set(), // product_id skup — koji spiskovi serijskih brojeva su otvoreni (podrazumevano zatvoreni, da lista ne bude beskrajna)
  settingsCompanySearch: "",
  settingsCompanyPriceSearch: "",
  orders: [],
  ordersLoaded: false,
  ordersSearch: "",
  expandedOrdersMonths: new Set([`${now.getFullYear()}-${pad(now.getMonth() + 1)}`]), // tekući mesec otvoren po defaultu
  orderItems: [], // [{ id, order_id, product_id, product_name, price, count }] — stavke ručno unetih porudžbina
  orderItemsLoaded: false,
  orderFormMode: "new", // "new" | "edit"
  editingOrderId: null,
  newOrderItems: [], // radni spisak artikala dok se popunjava "+ Nova porudžbina" forma
  permissions: {}, // { pageKey: "none"|"view"|"edit" } — moje dozvole, iz my_permissions() RPC-a posle logina
  roles: [],
  rolesLoaded: false,
  editingRoleId: null,
  users: [], // profiles redovi (email + role_id) — samo za korisnike sa settings edit dozvolom
  usersLoaded: false,
};

const el = {
  navHome: document.getElementById("navHome"),
  pageHome: document.getElementById("pageHome"),
  homeStatMonthStart: document.getElementById("homeStatMonthStart"),
  homeStatToday: document.getElementById("homeStatToday"),
  homeDailyReportBtn: document.getElementById("homeDailyReportBtn"),
  homeStockBtn: document.getElementById("homeStockBtn"),
  homeStockCards: document.getElementById("homeStockCards"),
  homeRecentNaplata: document.getElementById("homeRecentNaplata"),
  homeRecentOrders: document.getElementById("homeRecentOrders"),
  navOverview: document.getElementById("navOverview"),
  navReports: document.getElementById("navReports"),
  pageOverview: document.getElementById("pageOverview"),
  pageReports: document.getElementById("pageReports"),
  pageNaplata: document.getElementById("pageNaplata"),
  navNaplata: document.getElementById("navNaplata"),
  pageOrders: document.getElementById("pageOrders"),
  navOrders: document.getElementById("navOrders"),
  ordersSearchInput: document.getElementById("ordersSearchInput"),
  ordersImportBtn: document.getElementById("ordersImportBtn"),
  ordersImportFile: document.getElementById("ordersImportFile"),
  ordersTable: document.getElementById("ordersTable"),
  ordersBody: document.getElementById("ordersBody"),
  ordersEmptyState: document.getElementById("ordersEmptyState"),
  orderDetailModal: document.getElementById("orderDetailModal"),
  orderDetailSubtitle: document.getElementById("orderDetailSubtitle"),
  orderDetailList: document.getElementById("orderDetailList"),
  closeOrderDetailBtn: document.getElementById("closeOrderDetailBtn"),
  ordersAddBtn: document.getElementById("ordersAddBtn"),
  newOrderModal: document.getElementById("newOrderModal"),
  newOrderForm: document.getElementById("newOrderForm"),
  newOrderCompany: document.getElementById("newOrderCompany"),
  newOrderCompanyOptions: document.getElementById("newOrderCompanyOptions"),
  newOrderDate: document.getElementById("newOrderDate"),
  newOrderQbInvoice: document.getElementById("newOrderQbInvoice"),
  newOrderWoo: document.getElementById("newOrderWoo"),
  newOrderShipmentType: document.getElementById("newOrderShipmentType"),
  newOrderInvoiceStatus: document.getElementById("newOrderInvoiceStatus"),
  newOrderAddItemBtn: document.getElementById("newOrderAddItemBtn"),
  newOrderItemsList: document.getElementById("newOrderItemsList"),
  newOrderAmount: document.getElementById("newOrderAmount"),
  newOrderModalTitle: document.getElementById("newOrderModalTitle"),
  newOrderShippingDate: document.getElementById("newOrderShippingDate"),
  newOrderContactName: document.getElementById("newOrderContactName"),
  newOrderPhone: document.getElementById("newOrderPhone"),
  newOrderEmail: document.getElementById("newOrderEmail"),
  newOrderCustomerType: document.getElementById("newOrderCustomerType"),
  newOrderSerialNumber: document.getElementById("newOrderSerialNumber"),
  newOrderPaperwork: document.getElementById("newOrderPaperwork"),
  newOrderShippingDept: document.getElementById("newOrderShippingDept"),
  newOrderTrackingNumber: document.getElementById("newOrderTrackingNumber"),
  newOrderEmailConfirmation: document.getElementById("newOrderEmailConfirmation"),
  newOrderAddress: document.getElementById("newOrderAddress"),
  newOrderNotes: document.getElementById("newOrderNotes"),
  cancelNewOrderBtn: document.getElementById("cancelNewOrderBtn"),
  pageSettings: document.getElementById("pageSettings"),
  navSettings: document.getElementById("navSettings"),
  settingsMenuProducts: document.getElementById("settingsMenuProducts"),
  settingsSectionProducts: document.getElementById("settingsSectionProducts"),
  settingsProductList: document.getElementById("settingsProductList"),
  settingsProductForm: document.getElementById("settingsProductForm"),
  settingsProductGroup: document.getElementById("settingsProductGroup"),
  settingsProductInput: document.getElementById("settingsProductInput"),
  settingsMenuCompanies: document.getElementById("settingsMenuCompanies"),
  settingsSectionCompanies: document.getElementById("settingsSectionCompanies"),
  settingsCompanySearch: document.getElementById("settingsCompanySearch"),
  settingsCompanyImportBtn: document.getElementById("settingsCompanyImportBtn"),
  settingsCompanyImportFile: document.getElementById("settingsCompanyImportFile"),
  settingsCompaniesTable: document.getElementById("settingsCompaniesTable"),
  settingsCompaniesHeadRow: document.getElementById("settingsCompaniesHeadRow"),
  settingsCompaniesBody: document.getElementById("settingsCompaniesBody"),
  settingsMenuCompanyPrices: document.getElementById("settingsMenuCompanyPrices"),
  settingsSectionCompanyPrices: document.getElementById("settingsSectionCompanyPrices"),
  settingsCompanyPriceSearch: document.getElementById("settingsCompanyPriceSearch"),
  settingsCompanyPriceImportBtn: document.getElementById("settingsCompanyPriceImportBtn"),
  settingsCompanyPriceImportFile: document.getElementById("settingsCompanyPriceImportFile"),
  settingsCompanyPricesBody: document.getElementById("settingsCompanyPricesBody"),
  navStock: document.getElementById("navStock"),
  pageStock: document.getElementById("pageStock"),
  stockAddBtn: document.getElementById("stockAddBtn"),
  stockAddModal: document.getElementById("stockAddModal"),
  stockModalCloseBtn: document.getElementById("stockModalCloseBtn"),
  stockDeviceProduct: document.getElementById("stockDeviceProduct"),
  stockDeviceAddSection: document.getElementById("stockDeviceAddSection"),
  stockDeviceSerial: document.getElementById("stockDeviceSerial"),
  stockDeviceAddBtn: document.getElementById("stockDeviceAddBtn"),
  stockConnectorAddSection: document.getElementById("stockConnectorAddSection"),
  stockConnectorQtyInput: document.getElementById("stockConnectorQtyInput"),
  stockConnectorQtyAddBtn: document.getElementById("stockConnectorQtyAddBtn"),
  stockOcrFile: document.getElementById("stockOcrFile"),
  stockOcrStatus: document.getElementById("stockOcrStatus"),
  stockOcrPreviews: document.getElementById("stockOcrPreviews"),
  stockOcrResult: document.getElementById("stockOcrResult"),
  stockOcrRawText: document.getElementById("stockOcrRawText"),
  stockOcrCandidates: document.getElementById("stockOcrCandidates"),
  stockOcrConfirmBtn: document.getElementById("stockOcrConfirmBtn"),
  stockPendingList: document.getElementById("stockPendingList"),
  stockSaveBtn: document.getElementById("stockSaveBtn"),
  stockSaveBtnCount: document.getElementById("stockSaveBtnCount"),
  stockDeviceSections: document.getElementById("stockDeviceSections"),
  stockConnectorsList: document.getElementById("stockConnectorsList"),
  naplataTabActive: document.getElementById("naplataTabActive"),
  naplataTabClosed: document.getElementById("naplataTabClosed"),
  naplataAddBtn: document.getElementById("naplataAddBtn"),
  naplataImportBtn: document.getElementById("naplataImportBtn"),
  naplataImportFile: document.getElementById("naplataImportFile"),
  naplataTable: document.getElementById("naplataTable"),
  naplataBody: document.getElementById("naplataBody"),
  naplataEmptyState: document.getElementById("naplataEmptyState"),
  naplataModal: document.getElementById("naplataModal"),
  naplataModalTitle: document.getElementById("naplataModalTitle"),
  naplataModalSubtitle: document.getElementById("naplataModalSubtitle"),
  naplataForm: document.getElementById("naplataForm"),
  naplataStatsMonth: document.getElementById("naplataStatsMonth"),
  naplataStatNotCollected: document.getElementById("naplataStatNotCollected"),
  naplataStatCollected: document.getElementById("naplataStatCollected"),
  naplataStatClosed: document.getElementById("naplataStatClosed"),
  naplataStatTotal: document.getElementById("naplataStatTotal"),
  naplataCompanyLabel: document.getElementById("naplataCompanyLabel"),
  naplataCompany: document.getElementById("naplataCompany"),
  naplataCompanyOptions: document.getElementById("naplataCompanyOptions"),
  naplataDate: document.getElementById("naplataDate"),
  naplataCycle: document.getElementById("naplataCycle"),
  naplataAmount: document.getElementById("naplataAmount"),
  naplataInvoiceNumber: document.getElementById("naplataInvoiceNumber"),
  naplataPaymentMethod: document.getElementById("naplataPaymentMethod"),
  naplataCollected: document.getElementById("naplataCollected"),
  naplataCollectionDate: document.getElementById("naplataCollectionDate"),
  naplataComment: document.getElementById("naplataComment"),
  cancelNaplataBtn: document.getElementById("cancelNaplataBtn"),
  reportTabDaily: document.getElementById("reportTabDaily"),
  reportTabBehind: document.getElementById("reportTabBehind"),
  reportTabCurrent: document.getElementById("reportTabCurrent"),
  reportDateLabel: document.getElementById("reportDateLabel"),
  reportDate: document.getElementById("reportDate"),
  generateReportBtn: document.getElementById("generateReportBtn"),
  sendCurrentToNaplataBtn: document.getElementById("sendCurrentToNaplataBtn"),
  downloadPdfBtn: document.getElementById("downloadPdfBtn"),
  reportContent: document.getElementById("reportContent"),
  syncStatus: document.getElementById("syncStatus"),
  reportSyncStatus: document.getElementById("reportSyncStatus"),
  prevMonth: document.getElementById("prevMonth"),
  nextMonth: document.getElementById("nextMonth"),
  monthLabel: document.getElementById("monthLabel"),
  totalVrh: document.getElementById("totalVrh"),
  totalRst: document.getElementById("totalRst"),
  searchInput: document.getElementById("searchInput"),
  statusFilter: document.getElementById("statusFilter"),
  syncBtn: document.getElementById("syncBtn"),
  importBtn: document.getElementById("importBtn"),
  importFile: document.getElementById("importFile"),
  tableWrap: document.querySelector(".table-wrap"),
  pageNav: document.querySelector(".page-nav"),
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
  invoiceModal: document.getElementById("invoiceModal"),
  invoiceModalSubtitle: document.getElementById("invoiceModalSubtitle"),
  invoicePreview: document.getElementById("invoicePreview"),
  invoiceSendTo: document.getElementById("invoiceSendTo"),
  closeInvoiceBtn: document.getElementById("closeInvoiceBtn"),
  sendInvoiceBtn: document.getElementById("sendInvoiceBtn"),
  behindInvoiceModal: document.getElementById("behindInvoiceModal"),
  behindInvoiceModalSubtitle: document.getElementById("behindInvoiceModalSubtitle"),
  behindInvoiceSummaryLine: document.getElementById("behindInvoiceSummaryLine"),
  behindInvoiceItems: document.getElementById("behindInvoiceItems"),
  addBehindBasicRowBtn: document.getElementById("addBehindBasicRowBtn"),
  addBehindAdvancedRowBtn: document.getElementById("addBehindAdvancedRowBtn"),
  behindInvoiceTotal: document.getElementById("behindInvoiceTotal"),
  behindInvoicePreview: document.getElementById("behindInvoicePreview"),
  behindInvoiceSendTo: document.getElementById("behindInvoiceSendTo"),
  closeBehindInvoiceBtn: document.getElementById("closeBehindInvoiceBtn"),
  saveBehindInvoiceBtn: document.getElementById("saveBehindInvoiceBtn"),
  sendBehindInvoiceBtn: document.getElementById("sendBehindInvoiceBtn"),
  pageLogin: document.getElementById("pageLogin"),
  loginForm: document.getElementById("loginForm"),
  loginEmail: document.getElementById("loginEmail"),
  loginPassword: document.getElementById("loginPassword"),
  loginError: document.getElementById("loginError"),
  logoutBtn: document.getElementById("logoutBtn"),
  settingsMenuRoles: document.getElementById("settingsMenuRoles"),
  settingsMenuUsers: document.getElementById("settingsMenuUsers"),
  settingsSectionRoles: document.getElementById("settingsSectionRoles"),
  settingsSectionUsers: document.getElementById("settingsSectionUsers"),
  rolesBody: document.getElementById("rolesBody"),
  usersBody: document.getElementById("usersBody"),
  roleAddBtn: document.getElementById("roleAddBtn"),
  userAddBtn: document.getElementById("userAddBtn"),
  roleModal: document.getElementById("roleModal"),
  roleModalTitle: document.getElementById("roleModalTitle"),
  roleForm: document.getElementById("roleForm"),
  roleModalName: document.getElementById("roleModalName"),
  roleModalPerms: document.getElementById("roleModalPerms"),
  roleModalCancel: document.getElementById("roleModalCancel"),
  userModal: document.getElementById("userModal"),
  userForm: document.getElementById("userForm"),
  userModalEmail: document.getElementById("userModalEmail"),
  userModalPassword: document.getElementById("userModalPassword"),
  userModalRole: document.getElementById("userModalRole"),
  userModalCancel: document.getElementById("userModalCancel"),
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

function isWeekend(year, month, day) {
  const dow = new Date(year, month, day).getDay();
  return dow === 0 || dow === 6;
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
      .order("id", { ascending: true })
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

// 1. u mesecu, pre nego sto danasnji ELD sync (13h UTC) upise prvi red za
// novi mesec, state.counts[company.id] za taj mesec jos nema nista na dan 1,
// pa "yesterday" (d - 1 === 0) ne postoji u toj tabeli - carry-forward
// placeholder ispod bi ostao prazan. Ucitaj poslednji POSTOJECI total pre
// pocetka meseca, po firmi - ne nuzno tacno kalendarski poslednji dan
// prethodnog meseca, jer taj dan moze da nedostaje (npr. ELD worker nije
// odradio sync tog dana) - u tom slucaju uzima sledeci najskoriji dan koji
// stvarno ima podatak, isti princip kao fallback u collect_eld_sync (sql/sync.sql).
async function loadPrevMonthLastDayCounts(year, month) {
  const firstOfMonth = dateStr(year, month, 1);
  const cutoff = new Date(year, month, 1);
  cutoff.setDate(cutoff.getDate() - 30);
  const cutoffDate = dateStr(cutoff.getFullYear(), cutoff.getMonth(), cutoff.getDate());

  const { data, error } = await supabase
    .from("truck_counts")
    .select("company_id, total, date")
    .gte("date", cutoffDate)
    .lt("date", firstOfMonth)
    .order("date", { ascending: false });

  if (error) return {};

  // Poredjano opadajuce po datumu - prvo pojavljivanje po firmi je njen
  // najskoriji poznat total pre ovog meseca.
  const byCompany = {};
  for (const row of data ?? []) {
    if (!(row.company_id in byCompany)) byCompany[row.company_id] = row.total;
  }
  return byCompany;
}

async function loadPrevMonthTailIfCurrent(year, month) {
  if (year === now.getFullYear() && month === now.getMonth()) {
    return await loadPrevMonthLastDayCounts(year, month);
  }
  return {};
}

// ---------- status poslednje ELD sinhronizacije ----------
// collect_eld_sync() (sql/sync.sql) upisuje last_collect_at/last_collect_summary
// u eld_sync_state pri svakom pokusaju (uspeh, preskoceno zbog neradnog dana,
// ili greska) - ovde se to samo cita i prikazuje na vrhu Pregled kamiona i
// Izvestaj stranice, da se odmah vidi ako automatski cron u 13h UTC nije
// prosao (umesto da se to otkrije tek kad tabela ostane prazna).
async function loadSyncStatus() {
  const { data, error } = await supabase
    .from("eld_sync_state")
    .select("last_collect_at, last_collect_summary")
    .eq("id", 1)
    .maybeSingle();
  if (error || !data) return null;
  return data;
}

// Uvek prikazuje Europe/Belgrade vreme, bez obzira na vremensku zonu
// racunara/browsera na kom je app otvoren (sync je vezan za 13h UTC = 15h
// Beograd leti, pa lokalno vreme korisnika samo zbunjuje ako je drugacija zona).
function formatBelgradeDateTime(dt) {
  const parts = new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Europe/Belgrade",
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(dt);
  const get = (type) => parts.find((p) => p.type === type)?.value;
  return `${get("day")}.${get("month")}. u ${get("hour")}:${get("minute")}`;
}

function formatSyncStatusText(status) {
  if (!status || !status.last_collect_at) {
    return { text: "Sinhronizacija: još nikad pokrenuta", isError: false };
  }
  const dt = new Date(status.last_collect_at);
  const timeStr = formatBelgradeDateTime(dt);
  const summary = status.last_collect_summary || {};

  if (summary.error) {
    return { text: `Poslednja sinhronizacija ${timeStr} — GREŠKA: ${summary.error}`, isError: true };
  }
  if (summary.skipped) {
    return {
      text: `Poslednja sinhronizacija ${timeStr} — preskočeno (${summary.reason || "neradni dan"})`,
      isError: false,
    };
  }
  const rowsWritten = summary.rows_written ?? 0;
  const companiesSynced = summary.companies_synced ?? 0;
  const warn = rowsWritten === 0;
  return {
    text:
      `Poslednja sinhronizacija ${timeStr} — ${companiesSynced} firmi, ${rowsWritten} redova` +
      (warn ? " (upozorenje: 0 redova upisano)" : ""),
    isError: warn,
  };
}

async function refreshSyncStatusUI() {
  const status = await loadSyncStatus();
  const { text, isError } = formatSyncStatusText(status);
  for (const node of [el.syncStatus, el.reportSyncStatus]) {
    if (!node) continue;
    node.textContent = text;
    node.classList.toggle("sync-status-error", isError);
  }
}

async function refreshAll() {
  const [companies, counts, prevMonthTailCounts] = await Promise.all([
    loadCompanies(),
    loadCounts(state.year, state.month),
    loadPrevMonthTailIfCurrent(state.year, state.month),
  ]);
  state.companies = companies;
  state.counts = counts;
  state.prevMonthTailCounts = prevMonthTailCounts;
  render();
  scrollToToday();
  refreshSyncStatusUI();
}

// ---------- coloring rule ----------

// A day within a company's free/trial period (before billing_starts_on)
// is excluded from the month-max / added-truck highlight rules entirely.
function isFreeDay(year, month, day, billingStartsOn) {
  if (!billingStartsOn) return false;
  return dateStr(year, month, day) < billingStartsOn;
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

// Most recent day strictly before `day` that actually has a total (skips
// gaps — e.g. a company added mid-month, or a day sync never wrote a row).
// Same fallback the backend uses in collect_eld_sync (sql/sync.sql): walk
// back to the last real row instead of only looking at day-1, otherwise a
// single missing day would hide a genuine increase/decrease on the next
// one. Falls back to last month's tail total when nothing earlier exists
// in this month (day 1, or every earlier day this month is a gap) — and to
// 0 when there's no prior month total either (brand new company, first day
// it's ever had any trucks at all). No earlier data means "had nothing",
// not "unknown" — otherwise a company's very first day with a truck never
// gets marked as a new record.
function priorDayTotal(companyCounts, day, prevMonthTailTotal) {
  const counts = companyCounts || {};
  for (let d = day - 1; d >= 1; d--) {
    const t = counts[d]?.total;
    if (t !== undefined && t !== null) return t;
  }
  return prevMonthTailTotal ?? 0;
}

// T is colored from the total itself, compared to the most recent earlier
// day that has data (see priorDayTotal) — not from the entry column's
// delta. Weekends/holidays carry Friday's total forward unchanged (see
// carry_forward_last_working_day in sql/sync.sql), so this naturally
// compares Monday against Friday without any weekend-skipping needed here.
// Doing it this way (rather than relying on the S/B/A delta) means a real
// increase in trucks always shows on T even if the entry-column delta
// calc missed it for some reason.
//   - higher than yesterday AND a new month record -> orange
//   - higher than yesterday but not a new record (recovered after a dip) -> green
//   - lower than yesterday -> blue
//   - unchanged, or no data for either day -> no color
function totalColor(total, prevTotal, dayPriorMax, isFree) {
  if (total === undefined || total === null) return null;
  if (prevTotal === undefined || prevTotal === null) return null;
  if (total === prevTotal) return null;
  if (total < prevTotal) return "blue";
  if (isFree) return "green";
  return total > dayPriorMax ? "orange" : "green";
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

  // Skip companies that never actually had a truck this month — either no
  // rows at all, or rows that are all zero (e.g. onboarded but not ramped
  // up yet). A company with at least one day above 0 still shows.
  const hasDataThisMonth = (company) => {
    if (state.manuallyVisibleCompanyIds.has(company.id)) return true;
    const counts = state.counts[company.id];
    if (counts && Object.values(counts).some((day) => day && day.total && day.total > 0)) {
      return true;
    }
    // 1. u mesecu, pre nego sto danasnji sync upise prvi red, ovaj (novi)
    // mesec jos nema nijedan podatak - ali firma i dalje treba da se vidi
    // ako je imala kamione poslednjeg dana prethodnog meseca (carried-forward
    // placeholder u renderCompanyRow ce prikazati taj broj).
    const prevTail = (state.prevMonthTailCounts || {})[company.id];
    return !!(prevTail && prevTail > 0);
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
    if (!canEdit("overview")) return;
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
  const entryCol = company.entry_column || "advanced";

  for (let d = 1; d <= nDays; d++) {
    const dayData = (state.counts[company.id] || {})[d] || {};
    const isToday = d === todayDay;
    const isFree = isFreeDay(state.year, state.month, d, billingStartsOn);
    // Behind firme se ne naplaćuju kroz "current" dnevni obračun (idu kroz
    // poseban Behind izveštaj, sa svojim ciklusom 25.–24.) — narandžasto bi
    // ovde lažno sugerisalo novi naplativi rekord u tom obračunu, pa se za
    // njih porast uvek markira samo zeleno, isto kao tokom free perioda.
    const neverOrange = isFree || company.status === "behind";
    const isBillingStartDay = billingStartsOn && dateStr(state.year, state.month, d) === billingStartsOn;
    const dayPriorMax = priorMax(state.counts[company.id], d, state.year, state.month, billingStartsOn);
    const prevTotal = priorDayTotal(
      state.counts[company.id], d, (state.prevMonthTailCounts || {})[company.id]
    );

    const tdT = document.createElement("td");
    tdT.className = "sub-cell sub-t";
    if (isToday) tdT.classList.add("today-col");
    if (isWeekend(state.year, state.month, d)) {
      tdT.classList.add("cell-weekend");
      tdT.title = "Vikend — preneto sa petka";
    }
    if (isBillingStartDay) {
      tdT.classList.add("cell-red");
      tdT.title = "Kraj besplatnog perioda — naplata počinje";
    } else {
      const tColor = totalColor(dayData.total, prevTotal, dayPriorMax, neverOrange);
      if (tColor === "orange") tdT.classList.add("cell-orange");
      else if (tColor === "green") tdT.classList.add("cell-green");
      else if (tColor === "blue") tdT.classList.add("cell-blue");
    }

    // ELD sync runs at 15:00; before that today's total isn't in yet, so
    // carry yesterday's number forward as a placeholder. Na 1. u mesecu
    // "juce" nije u ovoj (novoj) mesecnoj tabeli, nego je poslednji dan
    // prethodnog meseca (state.prevMonthTailCounts).
    if (isToday && (dayData.total === undefined || dayData.total === null)) {
      if (prevTotal !== undefined && prevTotal !== null) {
        tdT.textContent = fmtCell(prevTotal);
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
        const color = entryColor(dayData, entryCol, dayData.total, dayPriorMax, neverOrange);
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
  el.companyModalName.textContent =
    newCompany.price !== null && newCompany.price !== undefined
      ? `${newCompany.name} (${newCompany.eld_group}) — cena preuzeta iz istorije naplate`
      : `${newCompany.name} (${newCompany.eld_group})`;
  el.companyStatus.value = "current";
  el.companyPrice.value = newCompany.price === null || newCompany.price === undefined ? "" : newCompany.price;
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

    // ELD ume da dodeli nov external_id istoj firmi (reset/re-kreiran nalog)
    // — checkForNewCompanies to ne vidi (proverava samo external_id), pa je
    // nudi kao "novu". Ako firma sa istim imenom već postoji, poveži je sa
    // novim external_id-om umesto da praviš duplikat (companies.name je unique).
    const existing = state.companies.find(
      (c) => c.name.trim().toLowerCase() === state.pendingNewCompany.name.trim().toLowerCase()
    );

    if (existing) {
      const { error } = await supabase
        .from("companies")
        .update({
          ...payload,
          external_id: state.pendingNewCompany.external_id,
          eld_group: state.pendingNewCompany.eld_group,
        })
        .eq("id", existing.id);
      if (error) {
        showToast("Greška pri povezivanju firme: " + error.message, true);
        return;
      }
      markCompanyManuallyVisible(existing.id);
      await syncCompanyPriceLookup(state.pendingNewCompany.name, payload.price);
      closeCompanyModal();
      await refreshAll();
      showToast("Firma povezana sa postojećim zapisom (isto ime, nov ID sa ELD-a)");
      openNextNewCompanyPrompt();
      manualSync(); // povuci današnji broj kamiona odmah, ne čekaj automatski sync u 15h
      return;
    }

    const { data: inserted, error } = await supabase
      .from("companies")
      .insert({
        ...payload,
        name: state.pendingNewCompany.name,
        external_id: state.pendingNewCompany.external_id,
        eld_group: state.pendingNewCompany.eld_group,
      })
      .select()
      .single();
    if (error) {
      showToast("Greška pri dodavanju firme: " + error.message, true);
      return;
    }
    if (inserted) markCompanyManuallyVisible(inserted.id);
    await syncCompanyPriceLookup(state.pendingNewCompany.name, payload.price);
    closeCompanyModal();
    await refreshAll();
    showToast("Nova firma dodata");
    openNextNewCompanyPrompt();
    manualSync(); // povuci današnji broj kamiona odmah, ne čekaj automatski sync u 15h
    return;
  }

  if (!state.editingCompanyId) return;

  const editedCompanyName = state.companies.find((c) => c.id === state.editingCompanyId)?.name;

  const { error } = await supabase
    .from("companies")
    .update(payload)
    .eq("id", state.editingCompanyId);

  if (error) {
    showToast("Greška pri čuvanju firme: " + error.message, true);
    return;
  }

  if (editedCompanyName) await syncCompanyPriceLookup(editedCompanyName, payload.price);
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
  if (!state.companyPriceLookupLoaded) await loadCompanyPriceLookup();

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
  const priceByKey = new Map(state.companyPriceLookup.map((r) => [r.name_key, r.price]));

  const found = [];
  for (const [externalId, v] of Object.entries(apiData)) {
    const name = (v.name || "").trim();
    if (!name || skipNames.has(name.toLowerCase())) continue;
    if (knownExternalIds.has(externalId)) continue;
    const knownPrice = priceByKey.get(normalizeCompanyNameKey(name));
    found.push({
      external_id: externalId,
      name,
      eld_group: v.account_name === "VRHELD" ? "VRH" : "RST",
      price: knownPrice === undefined ? null : knownPrice,
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
  // Stranica Pregled kamiona nije podrazumevano vidljiva (Početna je) — dok
  // je sakrivena (hidden), offsetLeft/offsetWidth su svi 0, pa bi se ovde
  // izračunala besmislena pozicija i (pošto se hasScrolledToToday postavlja
  // niže) funkcija se nikad ne bi ponovo pokrenula kad se strana stvarno
  // otvori. offsetParent je null dok je element sakriven — bezbedan test.
  if (el.tableWrap && el.tableWrap.offsetParent === null) return;

  const todayHeader = el.gridHeadRow1.querySelector(".day-group-header.today-col");
  const priceHeader = el.gridHeadRow1.querySelector(".price-col");
  if (!todayHeader || !priceHeader || !el.tableWrap) return;

  const stickyWidth = priceHeader.offsetLeft + priceHeader.offsetWidth;
  // "Danas" odmah posle cena (levo poravnato uz sticky kolone), ne na sredini.
  const target = todayHeader.offsetLeft - stickyWidth;

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
  state.prevMonthTailCounts = await loadPrevMonthTailIfCurrent(state.year, state.month);
  render();
});

el.nextMonth.addEventListener("click", async () => {
  state.month += 1;
  if (state.month > 11) {
    state.month = 0;
    state.year += 1;
  }
  state.counts = await loadCounts(state.year, state.month);
  state.prevMonthTailCounts = await loadPrevMonthTailIfCurrent(state.year, state.month);
  render();
});

// ---------- rucna sinhronizacija ----------

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Automatska sinhronizacija se desava svaki dan u ~15h, ali ELD izvor ume
// da kasni sa objavljivanjem dnevnog broja u tom trenutku, pa taj dan ostane
// nepovucen dok se sync ne pokrene ponovo. Ovo dugme radi tacno taj isti
// kickoff -> (sacekaj) -> collect ciklus rucno, na zahtev.
async function manualSync() {
  const originalText = el.syncBtn.textContent;
  el.syncBtn.disabled = true;
  el.syncBtn.textContent = "Sinhronizujem...";

  try {
    const { data: reqId, error: kickoffError } = await supabase.rpc("kickoff_eld_sync");
    if (kickoffError) throw new Error(kickoffError.message);

    if (reqId === null || reqId === undefined) {
      showToast("Danas je neradni dan — sinhronizacija se ne pokreće.");
      return;
    }

    // pg_net salje zahtev async - odgovor obicno stigne za par sekundi.
    let result = null;
    let lastError = null;
    for (let attempt = 0; attempt < 5; attempt++) {
      await sleep(2000);
      const { data, error } = await supabase.rpc("collect_eld_sync");
      if (!error) {
        result = data;
        break;
      }
      lastError = error;
    }

    if (!result) throw new Error(lastError?.message || "Odgovor od ELD API-ja nije stigao na vreme");

    if (result.skipped) {
      showToast("Preskočeno — neradni dan.");
    } else {
      showToast(`Sinhronizovano: ${result.companies_synced} firmi, ${result.rows_written} redova.`);
    }

    state.counts = await loadCounts(state.year, state.month);
    state.prevMonthTailCounts = await loadPrevMonthTailIfCurrent(state.year, state.month);
    render();
    refreshSyncStatusUI();
  } catch (error) {
    showToast("Greška pri sinhronizaciji: " + error.message, true);
    refreshSyncStatusUI();
  } finally {
    el.syncBtn.disabled = false;
    el.syncBtn.textContent = originalText;
  }
}

el.syncBtn.addEventListener("click", manualSync);

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

// ---------- auth / dozvole ----------

function canView(page) {
  const p = state.permissions[page];
  return p === "view" || p === "edit";
}

function canEdit(page) {
  return state.permissions[page] === "edit";
}

function firstAccessiblePage() {
  return VALID_PAGES.find((p) => canView(p)) || null;
}

function applyNavPermissions() {
  for (const page of VALID_PAGES) {
    const btn = el[NAV_BTN_BY_PAGE[page]];
    if (btn) btn.hidden = !canView(page);
  }
}

// Guard za mutating dugmad/formu: ako trenutna stranica nije "edit", sakrij
// dugme/onemogući formu umesto da se korisnik oslanja samo na server-side
// RLS grešku. Ovo je UX sloj — prava zaštita je RLS u sql/auth_roles.sql.
function hideIfNoEdit(page, ...elements) {
  const hide = !canEdit(page);
  for (const node of elements) {
    if (!node) continue;
    node.hidden = hide;
  }
}

function showPage(page) {
  if (!canView(page)) {
    const fallback = firstAccessiblePage();
    if (!fallback) {
      showToast("Nemate dozvolu ni za jednu stranicu. Obratite se administratoru.", true);
      return;
    }
    showPage(fallback);
    return;
  }
  saveLastPage(page);
  el.pageHome.hidden = page !== "home";
  el.pageOverview.hidden = page !== "overview";
  el.pageReports.hidden = page !== "reports";
  el.pageNaplata.hidden = page !== "naplata";
  el.pageOrders.hidden = page !== "orders";
  el.pageStock.hidden = page !== "stock";
  el.pageSettings.hidden = page !== "settings";
  el.navHome.classList.toggle("is-active", page === "home");
  el.navOverview.classList.toggle("is-active", page === "overview");
  el.navReports.classList.toggle("is-active", page === "reports");
  el.navNaplata.classList.toggle("is-active", page === "naplata");
  el.navOrders.classList.toggle("is-active", page === "orders");
  el.navStock.classList.toggle("is-active", page === "stock");
  el.navSettings.classList.toggle("is-active", page === "settings");
  if (page === "home") {
    loadHomeDashboard();
  }
  if (page === "overview") {
    requestAnimationFrame(scrollToToday);
    hideIfNoEdit("overview", el.importBtn, el.syncBtn);
  }
  // Naplata/Porudžbine/Izveštaj se ponovo učitavaju/generišu SVAKI PUT kad
  // se strana otvori (bez "već učitano" zaštite) - namerno, da ne postoji
  // nijedan slučaj u kom bi zaglavljena zastavica iz jednog neuspešnog
  // pokušaja (npr. tranzijentna greška odmah posle logina) sprečila prikaz
  // bez punog refresh-a stranice.
  if (page === "reports") {
    runReport();
  }
  if (page === "naplata") {
    loadNaplata().then(afterNaplataLoad);
    hideIfNoEdit("naplata", el.naplataAddBtn, el.naplataImportBtn);
  }
  if (page === "orders") {
    Promise.all([loadOrders(), loadOrderItems(), loadProducts()]).then(renderOrders);
    hideIfNoEdit("orders", el.ordersAddBtn, el.ordersImportBtn);
  }
  if (page === "stock") {
    hideIfNoEdit("stock", el.stockAddBtn);
    const need = [];
    if (!state.productsLoaded) need.push(loadProducts());
    if (!state.deviceUnitsLoaded) need.push(loadDeviceUnits());
    Promise.all(need).then(() => {
      renderStockDevices();
      renderStockConnectors();
    });
  }
  if (page === "settings" && !state.productsLoaded) {
    loadProducts().then(renderSettingsProducts);
  }
  if (page === "settings") {
    hideIfNoEdit(
      "settings",
      el.settingsProductForm,
      el.settingsCompanyImportBtn,
      el.settingsCompanyPriceImportBtn,
      el.roleAddBtn,
      el.userAddBtn,
      el.settingsMenuRoles,
      el.settingsMenuUsers
    );
  }
}

el.navHome.addEventListener("click", () => showPage("home"));
el.navOverview.addEventListener("click", () => showPage("overview"));
el.navReports.addEventListener("click", () => showPage("reports"));
el.navNaplata.addEventListener("click", () => showPage("naplata"));
el.navOrders.addEventListener("click", () => showPage("orders"));
el.navStock.addEventListener("click", () => showPage("stock"));
el.navSettings.addEventListener("click", () => showPage("settings"));

// ---------- naplata ----------

// Supabase/PostgREST caps unpaginated queries at 1000 rows by default — page
// through with .range() until a batch comes back short of the page size
// (same pattern as loadCounts()), so older data doesn't silently push the
// most recent rows (e.g. this month's) out of the result.
async function loadNaplata() {
  const pageSize = 1000;
  const all = [];
  let from = 0;

  while (true) {
    const { data, error } = await supabase
      .from("naplata")
      .select("*")
      .order("invoice_date", { ascending: true })
      .range(from, from + pageSize - 1);

    if (error) {
      showToast("Greška pri učitavanju naplate: " + error.message, true);
      break;
    }

    all.push(...(data ?? []));
    if (!data || data.length < pageSize) break;
    from += pageSize;
  }

  state.naplata = all;
  state.naplataLoaded = true;
}

// A row can't be closed/all-checked until someone has actually looked at
// it: invoice number assigned, a naplaćeno decision made (true or false —
// null means "not decided yet"), and a collection date entered.
function naplataIsIncomplete(row) {
  return !row.invoice_number || row.collected === null || row.collected === undefined || !row.collection_date;
}

// HEHO CORPORATION, North Shore Freight i Brunex Corporation postoje kao
// više odvojenih redova u companies (svaki sa svojim ELD external_id, za
// posebnu flotu) — ali su za Naplatu ista firma i treba da se grupišu
// zajedno. ALL STATES je poznat izuzetak: dve stvarno različite firme
// sličnog imena, ne spajaju se — grupišu se po company_id kao inače.
const NAPLATA_GROUP_NAME_EXCEPTIONS = new Set(["ALL STATES", "ALL STATES EXPRESS"]);

function normalizeCompanyNameForGrouping(name) {
  let s = (name || "").trim();
  s = s.replace(/\(.*?\)/g, "");
  s = s.toUpperCase();
  s = s.replace(/L\.L\.C\.?/g, "LLC");
  s = s.replace(/[.,'-]/g, "");
  s = s.replace(/\b(INC|LLC|CORP|CORPORATION|CO|INCORPORATED|LTD|LC)\b/g, "");
  s = s.replace(/\s+/g, " ").trim();
  return s;
}

function naplataGroupKey(row) {
  const normalized = normalizeCompanyNameForGrouping(row.company_name);
  if (NAPLATA_GROUP_NAME_EXCEPTIONS.has(normalized)) {
    return `id:${row.company_id || row.company_name}`;
  }
  return `name:${normalized}`;
}

// Companies with more than one naplata row in the given list collapse into
// a single summary row (sum of amounts) with an expand arrow — used for
// active rows (all together) and for closed rows (scoped to one month at a
// time). keyPrefix keeps the two contexts' expand/collapse state separate
// even when it's the same company in both.
function groupRowsByCompany(rows, keyPrefix) {
  const byKey = new Map();
  for (const row of rows) {
    const key = keyPrefix + naplataGroupKey(row);
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(row);
  }
  const out = [];
  for (const [key, group] of byKey) {
    if (group.length > 1) {
      const total = group.reduce((acc, r) => acc + Number(r.amount), 0);
      out.push({
        type: "group",
        key,
        companyName: group[0].company_name,
        total,
        rows: group.slice().sort((a, b) => (a.invoice_date < b.invoice_date ? -1 : 1)),
      });
    } else {
      out.push({ type: "single", row: group[0] });
    }
  }
  return out;
}

function naplataCycleBadge(cycle) {
  const span = el_("span", `badge badge-${cycle === "current" ? "current" : "behind"}`, cycle === "current" ? "Current" : "Behind");
  return span;
}

function buildNaplataRow(row, indented = false) {
  const tr = document.createElement("tr");
  if (indented) tr.className = "naplata-child-row";
  const incomplete = naplataIsIncomplete(row);

  tr.appendChild(el_("td", "naplata-status-cell", incomplete ? "▲" : ""));
  tr.appendChild(el_("td", null, row.invoice_date));
  tr.appendChild(el_("td", null, row.invoice_number || "—"));
  tr.appendChild(el_("td", null, row.company_name));

  const cycleTd = document.createElement("td");
  cycleTd.appendChild(naplataCycleBadge(row.cycle));
  tr.appendChild(cycleTd);

  tr.appendChild(el_("td", "naplata-amount", Number(row.amount).toFixed(2)));
  tr.appendChild(el_("td", null, row.payment_method || "—"));
  tr.appendChild(el_("td", null, row.collection_date || "—"));
  const collectedTd = document.createElement("td");
  const collectedState = row.collected === true ? "yes" : row.collected === false ? "no" : "unknown";
  const collectedBtn = el_(
    "button",
    `naplata-collected-btn naplata-collected-${collectedState}`,
    row.collected === true ? "Da" : row.collected === false ? "Ne" : "—"
  );
  const naplataEditable = canEdit("naplata");
  collectedBtn.type = "button";
  collectedBtn.title = "Klikni da promeniš naplaćeno (Da/Ne)";
  collectedBtn.disabled = !naplataEditable;
  collectedBtn.addEventListener("click", () => {
    updateNaplataField(row.id, "collected", row.collected !== true);
  });
  collectedTd.appendChild(collectedBtn);
  tr.appendChild(collectedTd);

  tr.appendChild(el_("td", "naplata-comment", row.comment || ""));

  const allCheckTd = document.createElement("td");
  const allCheckInput = document.createElement("input");
  allCheckInput.type = "checkbox";
  allCheckInput.checked = !!row.all_checked;
  allCheckInput.disabled = incomplete || !naplataEditable;
  allCheckInput.title = incomplete ? "Popuni broj računa, naplaćeno i datum naplate pre nego što možeš da čekiraš ovo" : "";
  allCheckInput.addEventListener("change", () => updateNaplataField(row.id, "all_checked", allCheckInput.checked));
  allCheckTd.appendChild(allCheckInput);
  tr.appendChild(allCheckTd);

  const closedTd = document.createElement("td");
  const closedInput = document.createElement("input");
  closedInput.type = "checkbox";
  closedInput.checked = !!row.closed;
  closedInput.disabled = incomplete || !naplataEditable;
  closedInput.title = incomplete ? "Popuni broj računa, naplaćeno i datum naplate pre nego što možeš da čekiraš ovo" : "";
  closedInput.addEventListener("change", () => handleClosedToggle(row, closedInput));
  closedTd.appendChild(closedInput);
  tr.appendChild(closedTd);

  const pencilTd = document.createElement("td");
  if (naplataEditable) {
    const pencilBtn = el_("button", "icon-btn icon-pencil", "✎");
    pencilBtn.type = "button";
    pencilBtn.title = "Izmeni stavku";
    pencilBtn.addEventListener("click", () => openNaplataModal("edit", row));
    pencilTd.appendChild(pencilBtn);
  }
  tr.appendChild(pencilTd);

  return tr;
}

function buildNaplataGroupRow(item) {
  const tr = document.createElement("tr");
  tr.className = "naplata-group-row";
  const expanded = state.expandedNaplataGroups.has(item.key);

  const arrowTd = document.createElement("td");
  const arrowBtn = el_("button", "naplata-arrow-btn", expanded ? "▾" : "▸");
  arrowBtn.type = "button";
  arrowBtn.title = expanded ? "Sakrij pojedinačne naplate" : "Prikaži pojedinačne naplate";
  arrowBtn.addEventListener("click", () => {
    if (expanded) state.expandedNaplataGroups.delete(item.key);
    else state.expandedNaplataGroups.add(item.key);
    renderNaplata();
  });
  arrowTd.appendChild(arrowBtn);
  tr.appendChild(arrowTd);

  tr.appendChild(el_("td")); // datum
  tr.appendChild(el_("td")); // broj računa
  tr.appendChild(el_("td", null, `${item.companyName} (${item.rows.length} otvorene naplate)`));
  tr.appendChild(el_("td")); // ciklus
  tr.appendChild(el_("td", "naplata-amount", item.total.toFixed(2)));
  for (let i = 0; i < 6; i++) tr.appendChild(el_("td")); // način naplate, datum naplate, naplaćeno, komentar, all check, zatvoreno
  tr.appendChild(el_("td")); // olovčica

  return tr;
}

function appendGroupedItems(items) {
  for (const item of items) {
    if (item.type === "single") {
      el.naplataBody.appendChild(buildNaplataRow(item.row));
    } else {
      el.naplataBody.appendChild(buildNaplataGroupRow(item));
      if (state.expandedNaplataGroups.has(item.key)) {
        for (const r of item.rows) {
          el.naplataBody.appendChild(buildNaplataRow(r, true));
        }
      }
    }
  }
}

function renderNaplataActive() {
  const rows = state.naplata.filter((r) => !r.closed);
  const items = groupRowsByCompany(rows, "active:");
  // groups start open by default — only auto-open the first time we see a
  // given company's group, so a manual collapse afterward still sticks.
  for (const item of items) {
    if (item.type === "group" && !state.naplataGroupsSeen.has(item.key)) {
      state.naplataGroupsSeen.add(item.key);
      state.expandedNaplataGroups.add(item.key);
    }
  }
  el.naplataBody.innerHTML = "";
  el.naplataEmptyState.hidden = items.length > 0;
  el.naplataTable.hidden = items.length === 0;
  appendGroupedItems(items);
}

function naplataMonthKey(dateValue) {
  return dateValue.slice(0, 7); // "YYYY-MM"
}

function naplataMonthLabel(monthKey) {
  const [y, m] = monthKey.split("-").map(Number);
  return `${MONTH_NAMES[m - 1]} ${y}`;
}

function buildNaplataMonthHeaderRow(monthKey, count) {
  const tr = document.createElement("tr");
  tr.className = "naplata-month-row";
  const expanded = state.expandedNaplataMonths.has(monthKey);
  const td = document.createElement("td");
  td.colSpan = 13;
  const btn = el_("button", "naplata-month-btn", `${expanded ? "▾" : "▸"} ${naplataMonthLabel(monthKey)} (${count})`);
  btn.type = "button";
  btn.addEventListener("click", () => {
    if (expanded) state.expandedNaplataMonths.delete(monthKey);
    else state.expandedNaplataMonths.add(monthKey);
    renderNaplataClosed();
  });
  td.appendChild(btn);
  tr.appendChild(td);
  return tr;
}

// Zatvoreno: grupisano po mesecu (najnoviji prvi, tekući mesec otvoren po
// defaultu), a unutar svakog meseca po firmi (isto pravilo kao Aktivan).
function renderNaplataClosed() {
  const rows = state.naplata.filter((r) => r.closed);
  const byMonth = new Map();
  for (const r of rows) {
    const key = naplataMonthKey(r.invoice_date);
    if (!byMonth.has(key)) byMonth.set(key, []);
    byMonth.get(key).push(r);
  }
  const months = Array.from(byMonth.keys()).sort().reverse();

  el.naplataBody.innerHTML = "";
  el.naplataEmptyState.hidden = rows.length > 0;
  el.naplataTable.hidden = rows.length === 0;

  for (const monthKey of months) {
    const monthRows = byMonth.get(monthKey);
    el.naplataBody.appendChild(buildNaplataMonthHeaderRow(monthKey, monthRows.length));
    if (state.expandedNaplataMonths.has(monthKey)) {
      const sorted = monthRows.slice().sort((a, b) => (a.invoice_date < b.invoice_date ? 1 : -1));
      appendGroupedItems(groupRowsByCompany(sorted, `closed:${monthKey}:`));
    }
  }
}

// Sidebar: mesečna statistika — nezavisna od Aktivan/Zatvoreno taba, uvek
// gleda sve stavke tog meseca (bez obzira koji je tab trenutno prikazan).
function populateNaplataStatsMonthOptions() {
  const months = new Set(state.naplata.map((r) => naplataMonthKey(r.invoice_date)));
  const currentKey = `${now.getFullYear()}-${pad(now.getMonth() + 1)}`;
  months.add(currentKey);
  const sorted = Array.from(months).sort().reverse();

  el.naplataStatsMonth.innerHTML = "";
  for (const key of sorted) {
    const opt = document.createElement("option");
    opt.value = key;
    opt.textContent = naplataMonthLabel(key);
    el.naplataStatsMonth.appendChild(opt);
  }

  state.naplataStatsMonth = sorted.includes(state.naplataStatsMonth) ? state.naplataStatsMonth : (sorted.includes(currentKey) ? currentKey : sorted[0]);
  el.naplataStatsMonth.value = state.naplataStatsMonth;
}

function renderNaplataStats() {
  if (!el.naplataStatsMonth.value) return;
  const monthKey = state.naplataStatsMonth;
  const rows = state.naplata.filter((r) => naplataMonthKey(r.invoice_date) === monthKey);

  let notCollected = 0;
  let collected = 0;
  let closed = 0;
  let total = 0;

  for (const r of rows) {
    const amt = Number(r.amount) || 0;
    total += amt;
    if (r.collected === true) collected += amt;
    else notCollected += amt;
    if (r.closed) closed += amt;
  }

  el.naplataStatNotCollected.textContent = notCollected.toFixed(2);
  el.naplataStatCollected.textContent = collected.toFixed(2);
  el.naplataStatClosed.textContent = closed.toFixed(2);
  el.naplataStatTotal.textContent = total.toFixed(2);
}

el.naplataStatsMonth.addEventListener("change", () => {
  state.naplataStatsMonth = el.naplataStatsMonth.value;
  renderNaplataStats();
});

// Poziva se posle svakog svežeg učitavanja iz baze (mesta gde su se mogli
// pojaviti novi meseci): ponovo popuni listu meseci pa iscrtaj sve.
function afterNaplataLoad() {
  populateNaplataStatsMonthOptions();
  renderNaplata();
}

function renderNaplata() {
  el.naplataTabActive.classList.toggle("is-active", state.naplataTab === "active");
  el.naplataTabClosed.classList.toggle("is-active", state.naplataTab === "closed");
  if (state.naplataTab === "active") {
    renderNaplataActive();
  } else {
    renderNaplataClosed();
  }
  renderNaplataStats();
}

async function updateNaplataField(id, field, value) {
  const { error } = await supabase
    .from("naplata")
    .update({ [field]: value, updated_at: new Date().toISOString() })
    .eq("id", id);
  if (error) {
    showToast("Greška: " + error.message, true);
    return;
  }
  const row = state.naplata.find((r) => r.id === id);
  if (row) row[field] = value;
  renderNaplata();
}

// Closing needs no extra input. Reopening (unchecking "Zatvoreno") requires
// a note explaining why — appended to the row's comment — so the history
// stays traceable instead of items silently bouncing between tabs.
async function handleClosedToggle(row, checkboxEl) {
  if (checkboxEl.checked) {
    await updateNaplataField(row.id, "closed", true);
    return;
  }

  const note = window.prompt("Zašto se stavka vraća u Aktivan? (obavezan komentar)", "");
  if (!note || !note.trim()) {
    checkboxEl.checked = true;
    showToast("Vraćanje u Aktivan zahteva komentar", true);
    return;
  }

  const stamp = dateStr(now.getFullYear(), now.getMonth(), now.getDate());
  const existing = row.comment ? row.comment.trim() : "";
  const newComment = existing
    ? `${existing}\n[vraćeno u Aktivan ${stamp}]: ${note.trim()}`
    : `[vraćeno u Aktivan ${stamp}]: ${note.trim()}`;

  const { error } = await supabase
    .from("naplata")
    .update({ closed: false, comment: newComment, updated_at: new Date().toISOString() })
    .eq("id", row.id);
  if (error) {
    showToast("Greška: " + error.message, true);
    checkboxEl.checked = true;
    return;
  }
  row.closed = false;
  row.comment = newComment;
  renderNaplata();
}

el.naplataTabActive.addEventListener("click", () => {
  state.naplataTab = "active";
  renderNaplata();
});
el.naplataTabClosed.addEventListener("click", () => {
  state.naplataTab = "closed";
  renderNaplata();
});

// ---------- naplata: modal (izmena postojeće ili nova ručna stavka) ----------

function openNaplataModal(mode, row) {
  state.naplataModalMode = mode;
  state.editingNaplataId = row ? row.id : null;
  el.naplataCompanyLabel.hidden = mode === "edit";

  if (mode === "new") {
    el.naplataModalTitle.textContent = "Nova naplata";
    el.naplataModalSubtitle.textContent = "";
    el.naplataCompany.value = "";
    el.naplataCompanyOptions.innerHTML = "";
    for (const c of state.companies) {
      const opt = document.createElement("option");
      opt.value = c.name;
      el.naplataCompanyOptions.appendChild(opt);
    }
    el.naplataDate.value = dateStr(now.getFullYear(), now.getMonth(), now.getDate());
    el.naplataCycle.value = "behind";
    el.naplataAmount.value = "";
    el.naplataInvoiceNumber.value = "";
    el.naplataPaymentMethod.value = "";
    el.naplataCollected.value = "";
    el.naplataCollectionDate.value = "";
    el.naplataComment.value = "";
  } else {
    el.naplataModalTitle.textContent = "Izmena naplate";
    el.naplataModalSubtitle.textContent = row.company_name;
    el.naplataDate.value = row.invoice_date;
    el.naplataCycle.value = row.cycle;
    el.naplataAmount.value = row.amount;
    el.naplataInvoiceNumber.value = row.invoice_number || "";
    el.naplataPaymentMethod.value = row.payment_method || "";
    el.naplataCollected.value = row.collected === true ? "yes" : row.collected === false ? "no" : "";
    el.naplataCollectionDate.value = row.collection_date || "";
    el.naplataComment.value = row.comment || "";
  }

  el.naplataModal.hidden = false;
}

function closeNaplataModal() {
  el.naplataModal.hidden = true;
}

el.naplataAddBtn.addEventListener("click", () => openNaplataModal("new", null));
el.cancelNaplataBtn.addEventListener("click", closeNaplataModal);
el.naplataModal.addEventListener("click", (e) => {
  if (e.target === el.naplataModal) closeNaplataModal();
});

el.naplataForm.addEventListener("submit", async (e) => {
  e.preventDefault();

  const amount = parseFloat(el.naplataAmount.value);
  if (Number.isNaN(amount) || amount < 0) {
    showToast("Iznos mora biti pozitivan broj", true);
    return;
  }

  const collectedValue =
    el.naplataCollected.value === "yes" ? true : el.naplataCollected.value === "no" ? false : null;

  const payload = {
    invoice_date: el.naplataDate.value,
    cycle: el.naplataCycle.value,
    amount,
    invoice_number: el.naplataInvoiceNumber.value.trim() || null,
    payment_method: el.naplataPaymentMethod.value.trim() || null,
    collected: collectedValue,
    collection_date: el.naplataCollectionDate.value || null,
    comment: el.naplataComment.value.trim() || null,
    updated_at: new Date().toISOString(),
  };

  if (state.naplataModalMode === "new") {
    const typedName = el.naplataCompany.value.trim().toLowerCase();
    const company = state.companies.find((c) => c.name.trim().toLowerCase() === typedName);
    if (!company) {
      showToast("Firma nije pronađena — izaberi je iz predloga dok kucaš", true);
      return;
    }
    payload.company_id = company.id;
    payload.company_name = company.name;
    payload.source = "manual";
    const { error } = await supabase.from("naplata").insert(payload);
    if (error) {
      showToast("Greška pri čuvanju: " + error.message, true);
      return;
    }
  } else {
    const { error } = await supabase.from("naplata").update(payload).eq("id", state.editingNaplataId);
    if (error) {
      showToast("Greška pri čuvanju: " + error.message, true);
      return;
    }
  }

  closeNaplataModal();
  await loadNaplata();
  afterNaplataLoad();
  showToast("Sačuvano");
});

// ---------- naplata: jednokratni uvoz istorije iz Excel taba "Naplata" ----------
// Kolone (posle header reda): DATUM, INVOICE #, KOMPANIJA, Billing Cycle,
// IZNOS, Prorated w/o ORD, Nacin naplate, DATUM NAPLATE, NAPLACENO,
// ALL CHECKED, ZATVOREN NALOG, KOMENTAR — vidi docs/2025_2026 VRH - Tabela
// nedeljnih naplata_isplata.xlsx, tab "Naplata".

el.naplataImportBtn.addEventListener("click", () => el.naplataImportFile.click());

el.naplataImportFile.addEventListener("change", async () => {
  const file = el.naplataImportFile.files[0];
  el.naplataImportFile.value = "";
  if (!file) return;
  try {
    await importNaplataHistoryFile(file);
  } catch (err) {
    console.error(err);
    showToast("Greška pri uvozu naplate: " + err.message, true);
  }
});

function naplataToBoolOrNull(v) {
  if (v === true || v === false) return v;
  if (v === "" || v === undefined || v === null) return null;
  const s = String(v).trim().toLowerCase();
  if (s === "true" || s === "1" || s === "da") return true;
  if (s === "false" || s === "0" || s === "ne") return false;
  return Boolean(v);
}

function naplataDedupeKey(companyName, invoiceDate, invoiceNumber, amount) {
  const namePart = (companyName || "").trim().toLowerCase();
  const invPart = invoiceNumber ? `inv:${String(invoiceNumber).trim().toLowerCase()}` : `amt:${Number(amount).toFixed(2)}`;
  return `${namePart}|${invoiceDate}|${invPart}`;
}

async function importNaplataHistoryFile(file) {
  if (!state.naplataLoaded) await loadNaplata();

  const buffer = await file.arrayBuffer();
  const workbook = XLSX.read(buffer, { type: "array", cellDates: true });
  const sheetName =
    workbook.SheetNames.find((n) => n.trim().toLowerCase() === "naplata") || workbook.SheetNames[0];
  const sheet = workbook.Sheets[sheetName];
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: true, defval: "" });

  if (rows.length < 2) {
    showToast("Fajl nema podataka", true);
    return;
  }

  const companiesByName = new Map(state.companies.map((c) => [c.name.trim().toLowerCase(), c]));
  const existingKeys = new Set(
    state.naplata.map((r) => naplataDedupeKey(r.company_name, r.invoice_date, r.invoice_number, r.amount))
  );

  const toInsert = [];
  let skippedInvalid = 0;
  let skippedDuplicate = 0;

  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    if (!row || row.every((v) => v === "" || v === undefined || v === null)) continue;

    const invoiceDate = excelDateToStr(row[0]);
    const companyName = String(row[2] ?? "").trim();
    const amount = parseFloat(row[4]);

    if (!invoiceDate || !companyName || Number.isNaN(amount)) {
      skippedInvalid++;
      continue;
    }

    const invRaw = row[1];
    const invoiceNumber = invRaw === "" || invRaw === undefined || invRaw === null ? null : String(invRaw).trim();

    const key = naplataDedupeKey(companyName, invoiceDate, invoiceNumber, amount);
    if (existingKeys.has(key)) {
      skippedDuplicate++;
      continue;
    }
    existingKeys.add(key);

    const cycleRaw = String(row[3] ?? "").trim().toLowerCase();
    const proratedRaw = row[5];
    const prorated = proratedRaw === "" || proratedRaw === undefined ? null : parseFloat(proratedRaw);
    const paymentMethod = row[6] ? String(row[6]).trim() : null;
    const collectionDate = row[7] instanceof Date ? excelDateToStr(row[7]) : null;
    const comment = row[11] ? String(row[11]).trim() : null;
    const company = companiesByName.get(companyName.toLowerCase());

    toInsert.push({
      company_id: company ? company.id : null,
      company_name: companyName,
      invoice_date: invoiceDate,
      invoice_number: invoiceNumber,
      cycle: cycleRaw === "behind" ? "behind" : "current",
      amount,
      prorated_wo_ord: Number.isNaN(prorated) ? null : prorated,
      payment_method: paymentMethod,
      collected: naplataToBoolOrNull(row[8]),
      collection_date: collectionDate,
      all_checked: naplataToBoolOrNull(row[9]) ?? false,
      closed: naplataToBoolOrNull(row[10]) ?? false,
      comment,
      source: "import",
    });
  }

  const batchSize = 200;
  let imported = 0;
  for (let i = 0; i < toInsert.length; i += batchSize) {
    const batch = toInsert.slice(i, i + batchSize);
    const { error } = await supabase.from("naplata").insert(batch);
    if (error) {
      console.error(error);
      showToast("Greška pri uvozu (deo podataka): " + error.message, true);
      continue;
    }
    imported += batch.length;
  }

  await loadNaplata();
  afterNaplataLoad();
  showToast(`Uvezeno: ${imported} stavki, preskočeno ${skippedDuplicate} duplikata, ${skippedInvalid} neispravnih redova`);
}

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

// Rucno "Posalji u naplatu" za Current izvestaj — upisuje tacno ono sto je
// prikazano na ekranu (state.lastCurrentReport, postavljeno u
// generateCurrentReport) kao naplata red po firmi, source='manual'.
// Ponovni klik za isti datum azurira postojeci red umesto da pravi
// duplikat — osim ako je covek vec poceo da ga popunjava (broj fakture ili
// naplaceno/nenaplaceno vec upisano), isti princip zastite kao kod
// upsertAutoNaplataRow.
el.sendCurrentToNaplataBtn.addEventListener("click", async () => {
  if (state.reportType !== "current") {
    showToast("Ova opcija je samo za Current izveštaj", true);
    return;
  }
  if (!state.lastCurrentReport || !el.reportContent.dataset.rendered) {
    showToast("Prvo generiši izveštaj", true);
    return;
  }
  const { dateValue, rows } = state.lastCurrentReport;
  if (rows.length === 0) {
    showToast("Nema redova za slanje", true);
    return;
  }

  const originalText = el.sendCurrentToNaplataBtn.textContent;
  el.sendCurrentToNaplataBtn.disabled = true;
  el.sendCurrentToNaplataBtn.textContent = "Šaljem...";

  let created = 0;
  let updated = 0;
  let skipped = 0;

  try {
    for (const r of rows) {
      const { data: existing, error: selErr } = await supabase
        .from("naplata")
        .select("id, invoice_number, collected")
        .eq("company_id", r.companyId)
        .eq("invoice_date", dateValue)
        .eq("cycle", "current")
        .eq("source", "manual")
        .maybeSingle();

      if (selErr) {
        console.error(selErr);
        skipped++;
        continue;
      }

      if (!existing) {
        const { error } = await supabase.from("naplata").insert({
          company_id: r.companyId,
          company_name: r.name,
          invoice_date: dateValue,
          cycle: "current",
          amount: r.amount,
          source: "manual",
        });
        if (error) {
          console.error(error);
          skipped++;
        } else {
          created++;
        }
        continue;
      }

      if (existing.invoice_number === null && existing.collected === null) {
        const { error } = await supabase.from("naplata").update({ amount: r.amount }).eq("id", existing.id);
        if (error) {
          console.error(error);
          skipped++;
        } else {
          updated++;
        }
      } else {
        skipped++;
      }
    }

    await loadNaplata();
    afterNaplataLoad();
    showToast(
      `Poslato u naplatu: ${created} novo, ${updated} ažurirano` +
        (skipped ? `, ${skipped} preskočeno (već obrađeno ili greška)` : "")
    );
  } finally {
    el.sendCurrentToNaplataBtn.disabled = false;
    el.sendCurrentToNaplataBtn.textContent = originalText;
  }
});

function el_(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function sumValues(items) {
  return items.reduce((acc, item) => acc + item.value, 0);
}

// "TODAY TOTAL" red iz screenshot-a: dodato minus uklonjeno za dan, kao
// zaseban red na dnu liste uklonjenih uredjaja (isto mesto kao na slici).
function appendNetRow(ul, net, netClass) {
  const li = el_("li", `report-list-net ${netClass}`);
  li.appendChild(el_("span", null, "Ukupno danas"));
  li.appendChild(el_("span", null, String(net)));
  ul.appendChild(li);
}

function buildReportList(items, valueLabel, totalLabel) {
  const ul = el_("ul", "report-list");
  if (items.length === 0) {
    ul.appendChild(el_("li", "empty", "Nema"));
  } else {
    for (const item of items) {
      const li = document.createElement("li");
      li.appendChild(el_("span", null, item.name));
      li.appendChild(el_("span", null, `${valueLabel} ${item.value}`));
      ul.appendChild(li);
    }
  }
  if (totalLabel) {
    const total = items.reduce((acc, item) => acc + item.value, 0);
    const totalLi = el_("li", "report-list-total");
    totalLi.appendChild(el_("span", null, totalLabel));
    totalLi.appendChild(el_("span", null, `${valueLabel} ${total}`));
    ul.appendChild(totalLi);
  }
  return ul;
}

// A truck was "added" that day (per company entry column) and whether that
// addition is a genuinely new billing record (orange) — shared by the daily
// report's "Dodati uređaji" section and computeCurrentDetailRows() below.
function computeAddedItems(list, counts, year, month, day) {
  const out = [];
  const todayStr = dateStr(year, month, day);
  for (const c of list) {
    const dc = counts[c.id] || {};
    const entryCol = c.entry_column || "advanced";
    const billingStartsOn = c.billing_starts_on || null;
    const total = dc[day]?.total;
    // Dan kad se završava trial (billing_starts_on je baš danas): računa se
    // ceo trenutni broj kamiona, ne samo ono što je promenjeno baš tog dana —
    // firma dotad nije naplaćivana nijedan dan (bila je u trial-u), pa nema
    // ranijeg obračunatog broja da se od ukupnog izdvoji samo razlika.
    const isTrialEndDay = billingStartsOn === todayStr;
    const val = isTrialEndDay && total > 0 ? total : dc[day]?.[entryCol];
    if (val && val > 0) {
      const isFree = isFreeDay(year, month, day, billingStartsOn);
      // treat the report's date as "today": only compare against days
      // strictly before it, so a bigger count that happened afterward
      // (out of scope for a historical report) can't affect this day,
      // and merely re-reaching an already-billed past peak isn't orange.
      const dayPriorMax = priorMax(dc, day, year, month, billingStartsOn);
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
}

// Current-status companies whose total set a new all-time record on `day`
// (the "Detaljan prikaz (current)" table in the daily report). Price is
// prorated: (monthly price / days in month) * days remaining in the month
// (including `day`), multiplied by only the billable (genuinely new)
// devices. Reused by generateDailyReport (rendering) and runNaplataAutoSync
// (writing Naplata rows) so both stay in sync on the same math.
//
// entry_column "start" is excluded regardless of status — a Start-tier
// truck is always billed at the fixed START_TIER_PRICE through the Behind
// report instead (see generateBehindReport), never auto-synced to Naplata.
function computeCurrentDetailRows(counts, companies, year, month, day) {
  const nDays = daysInMonth(year, month);
  const remainingDays = nDays - day + 1;
  const added = computeAddedItems(companies, counts, year, month, day);
  return added
    .filter((item) =>
      item.company.status === "current" &&
      item.company.entry_column !== "start" &&
      item.color === "orange" &&
      item.billable > 0
    )
    .map((item) => {
      const price = item.company.price || 0;
      const dailyRate = price / nDays;
      const proratedPrice = dailyRate * remainingDays;
      const amount = proratedPrice * item.billable;
      return { name: item.name, added: item.billable, proratedPrice, amount, company: item.company };
    });
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

  const addedFor = (list) => computeAddedItems(list, counts, year, month, day);

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
  // all-time record today — see computeCurrentDetailRows().
  const remainingDays = nDays - day + 1;
  // Sortirano VRH-VRH pa RST-RST (umesto naizmenično, kako companies dođe iz
  // baze) - stabilan sort, ne menja redosled unutar svake grupe.
  const detailRows = computeCurrentDetailRows(counts, companies, year, month, day).sort((a, b) => {
    const aRst = a.company.eld_group === "RST" ? 1 : 0;
    const bRst = b.company.eld_group === "RST" ? 1 : 0;
    return aRst - bRst;
  });
  const grandTotal = detailRows.reduce((acc, r) => acc + r.amount, 0);

  // Dugme "Napravi fakturu" je crveno dok faktura nije poslata, i narandžasto
  // ("Vidi fakturu") čim jeste — pročitaj unapred koje (company_id, dan)
  // kombinacije iz detailRows već imaju poslatu fakturu.
  const sentInvoiceCompanyIds = new Set();
  const detailCompanyIds = detailRows.map((r) => r.company.id);
  if (detailCompanyIds.length > 0) {
    const { data: existingInvoices } = await supabase
      .from("invoices")
      .select("company_id, sent_at")
      .eq("invoice_date", dateValue)
      .in("company_id", detailCompanyIds);
    for (const inv of existingInvoices || []) {
      if (inv.sent_at) sentInvoiceCompanyIds.add(inv.company_id);
    }
  }

  // ---- render ----
  el.reportContent.innerHTML = "";
  el.reportContent.dataset.rendered = "1";

  const totalsRow = el_("div", "report-totals");
  const vrhCard = el_("div", "report-total-card card-vrh");
  vrhCard.appendChild(el_("div", "label", "VRH"));
  vrhCard.appendChild(el_("div", "value", String(totalFor(vrh))));
  totalsRow.appendChild(vrhCard);
  const rstCard = el_("div", "report-total-card card-rst");
  rstCard.appendChild(el_("div", "label", "RST"));
  rstCard.appendChild(el_("div", "value", String(totalFor(rst))));
  totalsRow.appendChild(rstCard);
  const grandCard = el_("div", "report-total-card highlight");
  grandCard.appendChild(el_("div", "label", "Ukupno"));
  grandCard.appendChild(el_("div", "value", String(totalFor(vrh) + totalFor(rst))));
  totalsRow.appendChild(grandCard);
  el.reportContent.appendChild(totalsRow);

  // Desktop: dve sekcije (Dodati / Uklonjeni), svaka sa VRH|RST kolonama
  // jedna pored druge. Na mobilnoj je preglednije obrnuto grupisano - prvo
  // sve za VRH (dodato+uklonjeno), pa sve za RST - vidi mobileGroups ispod.
  const addedSection = el_("section", "report-section home-desktop-only");
  addedSection.appendChild(el_("h2", null, "Dodati uređaji"));
  const addedCols = el_("div", "report-columns");
  const vrhAddedGroup = el_("div", "report-group group-vrh");
  vrhAddedGroup.appendChild(el_("h3", null, "VRH"));
  vrhAddedGroup.appendChild(buildReportList(vrhAdded, "+", "Ukupno dodato"));
  addedCols.appendChild(vrhAddedGroup);
  const rstAddedGroup = el_("div", "report-group group-rst");
  rstAddedGroup.appendChild(el_("h3", null, "RST"));
  rstAddedGroup.appendChild(buildReportList(rstAdded, "+", "Ukupno dodato"));
  addedCols.appendChild(rstAddedGroup);
  addedSection.appendChild(addedCols);
  el.reportContent.appendChild(addedSection);

  const removedSection = el_("section", "report-section home-desktop-only");
  removedSection.appendChild(el_("h2", null, "Uklonjeni uređaji"));
  const removedCols = el_("div", "report-columns");
  const vrhRemovedGroup = el_("div", "report-group group-vrh");
  vrhRemovedGroup.appendChild(el_("h3", null, "VRH"));
  const vrhRemovedList = buildReportList(vrhRemoved, "−", "Ukupno uklonjeno");
  appendNetRow(vrhRemovedList, sumValues(vrhAdded) - sumValues(vrhRemoved), "net-vrh");
  vrhRemovedGroup.appendChild(vrhRemovedList);
  removedCols.appendChild(vrhRemovedGroup);
  const rstRemovedGroup = el_("div", "report-group group-rst");
  rstRemovedGroup.appendChild(el_("h3", null, "RST"));
  const rstRemovedList = buildReportList(rstRemoved, "−", "Ukupno uklonjeno");
  appendNetRow(rstRemovedList, sumValues(rstAdded) - sumValues(rstRemoved), "net-rst");
  rstRemovedGroup.appendChild(rstRemovedList);
  removedCols.appendChild(rstRemovedGroup);
  removedSection.appendChild(removedCols);
  el.reportContent.appendChild(removedSection);

  const mobileGroups = el_("div", "home-mobile-only daily-mobile-groups");
  for (const [label, addedList, removedList, netClass] of [
    ["VRH", vrhAdded, vrhRemoved, "net-vrh"],
    ["RST", rstAdded, rstRemoved, "net-rst"],
  ]) {
    const group = el_("section", `report-section report-group group-${label.toLowerCase()}`);
    group.appendChild(el_("h2", null, label));
    group.appendChild(el_("h3", null, "Dodati uređaji"));
    group.appendChild(buildReportList(addedList, "+", "Ukupno dodato"));
    group.appendChild(el_("h3", null, "Uklonjeni uređaji"));
    const removedListEl = buildReportList(removedList, "−", "Ukupno uklonjeno");
    appendNetRow(removedListEl, sumValues(addedList) - sumValues(removedList), netClass);
    group.appendChild(removedListEl);
    mobileGroups.appendChild(group);
  }
  el.reportContent.appendChild(mobileGroups);

  const detailSection = el_("section", "report-section");
  detailSection.appendChild(el_("h2", null, "Detaljan prikaz (current)"));
  detailSection.appendChild(el_(
    "p", "section-hint",
    `Samo aktivacije koje su dostigle mesečni maksimum (narandžasto). Cena je proporcionalna preostalim danima u mesecu (${remainingDays} od ${nDays})`
  ));
  const table = document.createElement("table");
  table.className = "report-table report-table-green";
  const thead = document.createElement("thead");
  const headRow = document.createElement("tr");
  for (const h of ["Firma", "Novi uređaji", "Cena po uređaju", "Iznos", "Faktura"]) {
    headRow.appendChild(el_("th", null, h));
  }
  thead.appendChild(headRow);
  table.appendChild(thead);

  const tbody = document.createElement("tbody");
  if (detailRows.length === 0) {
    const tr = document.createElement("tr");
    const td = el_("td", "section-hint", "Nema aktivacija current firmi ovog dana");
    td.colSpan = 5;
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
      const tdInvoice = el_("td", null);
      const alreadySent = sentInvoiceCompanyIds.has(r.company.id);
      const invoiceBtn = el_(
        "button",
        `btn invoice-report-btn${alreadySent ? " invoice-report-btn-sent" : ""}`,
        alreadySent ? "Vidi fakturu" : "Napravi fakturu"
      );
      invoiceBtn.type = "button";
      invoiceBtn.addEventListener("click", () => openInvoiceModal(r, dateValue, invoiceBtn));
      tdInvoice.appendChild(invoiceBtn);
      tr.appendChild(tdInvoice);
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

// ---------- fakture (Detaljan prikaz > "Napravi fakturu") ----------

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
}

function fmtUsd(n) {
  return Number(n).toFixed(2);
}

// dateValue je "YYYY-MM-DD" (isti format kao dateStr/invoice_date) -> "MM/DD/YYYY"
function fmtInvoiceDate(dateValue) {
  const [y, m, d] = dateValue.split("-");
  return `${m}/${d}/${y}`;
}

// "YYYY-MM-DD" -> "MM-DD" (koristi se u opisu stavke, isti format kao na
// referentnoj fakturi screen/Invoice_5252_from_VRH_Tracking_Technologies_LLC.pdf)
function fmtInvoiceDateShort(dateValue) {
  const [, m, d] = dateValue.split("-");
  return `${m}-${d}`;
}

// Naziv paketa i osnovni opis stavke na fakturi — po nivou firme (isto S/B/A
// kao kolone u Pregled uređaja i companyEntryColumn u Podešavanjima). Kad se
// faktura pravi za konkretan dan, na osnovni opis se dodaje " prorated
// (MM-DD)" (vidi getOrCreateInvoice) — to je jedini deo koji se menja po danu.
// TODO: description za "basic" i "start" su privremeno isti kao "advanced" —
// zameniti pravim tekstom kad korisnik pošalje tačnu formulaciju za te pakete.
const INVOICE_PACKAGE_INFO = {
  advanced: { label: "VRH ADVANCED PACKAGE", description: "Basic subscription with level 2 Technical Support" },
  basic: { label: "VRH BASIC PACKAGE", description: "Basic subscription with level 2 Technical Support" },
  start: { label: "VRH START PACKAGE", description: "Basic subscription with level 2 Technical Support" },
};

function invoicePackageInfo(entryColumn) {
  return INVOICE_PACKAGE_INFO[entryColumn] || INVOICE_PACKAGE_INFO.advanced;
}

// Jedna faktura po firmi po danu — ponovni klik na "Napravi fakturu" za isti
// red vraća već postojeću (isti broj), ne pravi duplikat (unique constraint
// na (company_id, invoice_date) u sql/invoices.sql).
async function getOrCreateInvoice(detailRow, dateValue) {
  const company = detailRow.company;

  const { data: existing, error: selErr } = await supabase
    .from("invoices")
    .select("*")
    .eq("company_id", company.id)
    .eq("invoice_date", dateValue)
    .maybeSingle();
  if (selErr) throw selErr;
  if (existing) return existing;

  const { label: productLabel, description: baseDescription } = invoicePackageInfo(company.entry_column || "advanced");
  const { data: created, error: insErr } = await supabase
    .from("invoices")
    .insert({
      company_id: company.id,
      invoice_date: dateValue,
      description: `${productLabel} — ${baseDescription} prorated (${fmtInvoiceDateShort(dateValue)})`,
      qty: detailRow.added,
      rate: detailRow.proratedPrice,
      amount: detailRow.amount,
    })
    .select()
    .single();
  if (insErr) throw insErr;
  return created;
}

// Sama faktura (bez pozdravnog teksta) — ovo isto ide i u PDF prilog emaila
// (vidi buildInvoicePdfBase64) i u telo emaila (buildInvoiceHtml ispod), da
// izgled uvek bude identičan. Stilovi su inline (ne CSS klase) jer i email
// klijenti i html2pdf ignorišu <style> tagove/spoljni CSS.
function buildInvoiceDocumentHtml(invoice, company, items) {
  const billName = escapeHtml(company.contact_name || company.name);
  const addressLines = (company.address || "")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => `${escapeHtml(l)}<br>`)
    .join("");
  const dateFmt = fmtInvoiceDate(invoice.invoice_date);
  const rows = items && items.length ? items : [invoice];
  const total = items && items.length ? items.reduce((acc, it) => acc + Number(it.amount), 0) : invoice.amount;

  return `
<div style="font-family: Arial, Helvetica, sans-serif; color:#1f2328; max-width:600px; margin:0 auto; background:#ffffff;">
  <h2 style="border-bottom:2px solid #2563eb; padding-bottom:8px; font-size:18px; margin-top:0;">INVOICE</h2>

  <table style="width:100%; background:#f1f3f5; border-collapse:collapse; margin-top:8px;">
    <tr>
      <td style="vertical-align:top; padding:16px; font-size:13px; line-height:1.5;">
        <strong>VRH Tracking Technologies LLC</strong><br>
        734 NE 90th St<br>
        Miami, FL 33138<br>
        info@vrheld.com<br>
        +1 (630) 286-1674
      </td>
      <td style="vertical-align:top; padding:16px; font-size:13px; line-height:1.5;">
        <strong>Bill To</strong><br>
        ${billName}<br>
        ${escapeHtml(company.name)}<br>
        ${addressLines}
      </td>
      <td style="vertical-align:top; padding:16px; font-size:13px; line-height:1.5; white-space:nowrap;">
        Invoice #: ${invoice.invoice_number}<br>
        Invoice date: ${dateFmt}<br>
        Due date: ${dateFmt}<br>
        Terms: Due on receipt
      </td>
    </tr>
  </table>

  <table style="width:100%; border-collapse:collapse; margin-top:16px;">
    <thead>
      <tr style="text-align:left; color:#6b7280; font-size:12px;">
        <th style="padding:8px 0; border-bottom:1px solid #d0d5dd;">Description</th>
        <th style="padding:8px 0; border-bottom:1px solid #d0d5dd; text-align:right;">Qty</th>
        <th style="padding:8px 0; border-bottom:1px solid #d0d5dd; text-align:right;">Rate</th>
        <th style="padding:8px 0; border-bottom:1px solid #d0d5dd; text-align:right;">Amount</th>
      </tr>
    </thead>
    <tbody>
      ${rows.map((r) => `
      <tr>
        <td style="padding:12px 0; font-size:13px;">${escapeHtml(r.description)}</td>
        <td style="padding:12px 0; font-size:13px; text-align:right;">${r.qty}</td>
        <td style="padding:12px 0; font-size:13px; text-align:right;">$${fmtUsd(r.rate)}</td>
        <td style="padding:12px 0; font-size:13px; text-align:right;">$${fmtUsd(r.amount)}</td>
      </tr>`).join("")}
    </tbody>
  </table>

  <table style="width:100%; border-collapse:collapse; margin-top:4px;">
    <tr style="border-top:2px solid #1f2328;">
      <td></td>
      <td style="padding:10px 0; text-align:right; font-weight:700; font-size:13px;">Total</td>
      <td style="padding:10px 0; text-align:right; font-weight:700; font-size:13px; width:110px;">$${fmtUsd(total)}</td>
    </tr>
  </table>

  <table style="width:100%; background:#f1f3f5; border-collapse:collapse; margin-top:16px;">
    <tr>
      <td style="padding:16px; font-weight:700;">Amount Due</td>
      <td style="padding:16px; text-align:right; font-weight:700; color:#16a34a; font-size:16px;">$${fmtUsd(total)}</td>
    </tr>
  </table>
</div>`;
}

// Telo emaila / prikaz u popup-u — pozdravni tekst + ista faktura kao u PDF
// prilogu (WYSIWYG: šta vidiš u popup-u, to stigne u inbox, plus PDF u prilogu).
function buildInvoiceHtml(invoice, company, items) {
  const billName = escapeHtml(company.contact_name || company.name);
  return `
<div style="font-family: Arial, Helvetica, sans-serif; color:#1f2328; max-width:600px; margin:0 auto;">
  <p>Dear ${billName},</p>
  <p>Please find your invoice attached. If you have any questions, feel free to reach out to us at
    <a href="mailto:info@vrheld.com">info@vrheld.com</a> or at +1&nbsp;(630)&nbsp;286-1674.</p>
  <p>Thank you for your business.<br>VRH Tracking Technologies LLC</p>
  <div style="margin-top:24px;">${buildInvoiceDocumentHtml(invoice, company, items)}</div>
</div>`;
}

// Izgled samog PDF priloga — prati tačno strukturu stvarne fakture iz
// screen/Invoice_5252_from_VRH_Tracking_Technologies_LLC.pdf (odvojeno od
// buildInvoiceDocumentHtml koji se koristi za telo emaila/preview, taj ima
// drugačiji, "email" izgled sa Amount Due trakom).
const VRH_LOGO_DATA_URI = "data:image/png;base64,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";

function invoiceProductAndDetail(description) {
  const idx = description.indexOf(" — ");
  if (idx === -1) return { product: description, detail: "" };
  return { product: description.slice(0, idx), detail: description.slice(idx + 3) };
}

function buildInvoicePdfDocumentHtml(invoice, company, items) {
  const billName = escapeHtml(company.contact_name || company.name);
  const addressLines = (company.address || "")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => `${escapeHtml(l)}<br>`)
    .join("");
  const dateFmt = fmtInvoiceDate(invoice.invoice_date);
  const rows = items && items.length
    ? items.map((it, i) => ({ n: i + 1, ...invoiceProductAndDetail(it.description), qty: it.qty, rate: it.rate, amount: it.amount }))
    : [{ n: 1, ...invoiceProductAndDetail(invoice.description), qty: invoice.qty, rate: invoice.rate, amount: invoice.amount }];
  const total = items && items.length ? items.reduce((acc, it) => acc + Number(it.amount), 0) : invoice.amount;

  // Mere (pt), boje i sadržaj su izmereni direktno iz vektorskog PDF-a
  // screen/Invoice_5252_from_VRH_Tracking_Technologies_LLC.pdf (US Letter,
  // 612x792pt) preko PyMuPDF-a (font size/pozicije/boje po span-u, i
  // pozadinski pravougaonici preko page.get_drawings()) — ne procena na oko.
  // Container je namerno tačno 612pt širok (== širina Letter stranice) i
  // buildInvoicePdfBase64 koristi jsPDF format:'letter', unit:'pt', margin:0,
  // tako da nema razmere/stretch — 1pt u ovom HTML-u je tačno 1pt u PDF-u.
  return `
<div style="font-family: Helvetica, Arial, sans-serif; color:#393a3d; width:612pt; background:#ffffff;">
  <div style="padding:22pt 45pt 0 32.25pt;">
    <table style="width:100%; border-collapse:collapse; table-layout:fixed;">
      <tr>
        <td style="vertical-align:top; width:142pt;">
          <div style="font-size:12pt; font-weight:700; color:#223947; margin-bottom:5pt;">INVOICE</div>
          <div style="font-size:7.5pt; line-height:1.55;">
            <span style="font-weight:700;">VRH Tracking Technologies LLC</span><br>
            734 NE 90th St<br>
            Miami, FL 33138
          </div>
        </td>
        <td style="vertical-align:top; padding-top:15.5pt; font-size:7.5pt; line-height:1.55;">
          info@vrheld.com<br>
          +1 (630) 286-1674<br>
          http://vrheld.com
        </td>
        <td style="vertical-align:top; width:68pt; text-align:right; padding-top:12pt; padding-right:10pt;">
          <img src="${VRH_LOGO_DATA_URI}" alt="" style="width:68pt; height:auto; display:inline-block;">
        </td>
      </tr>
    </table>
  </div>

  <div style="background:#edeff0; padding:15pt 45pt 17pt 32.25pt; margin-top:22pt;">
    <div style="font-size:7.5pt; font-weight:700; margin-bottom:5pt;">Bill to</div>
    <div style="font-size:9pt; line-height:1.5;">
      ${billName}<br>
      ${escapeHtml(company.name)}<br>
      ${addressLines}
    </div>
    <div style="border-top:0.75pt solid #d4d7dc; margin:25pt 0;"></div>
    <div style="font-size:9pt; font-weight:700; margin-bottom:5pt;">Invoice details</div>
    <div style="font-size:9pt; line-height:1.5;">
      Invoice no.: ${invoice.invoice_number}<br>
      Terms: Due on receipt<br>
      Invoice date: ${dateFmt}<br>
      Due date: ${dateFmt}
    </div>
  </div>

  <div style="padding:20pt 45pt 30pt 32.25pt;">
    <table style="width:100%; border-collapse:collapse; font-size:9pt; color:#000000;">
      <thead>
        <tr style="text-align:left;">
          <th style="padding-bottom:8pt; border-bottom:0.75pt solid #e3e5e8; font-weight:400; width:18pt;">#</th>
          <th style="padding-bottom:8pt; border-bottom:0.75pt solid #e3e5e8; font-weight:400; width:50pt;">Date</th>
          <th style="padding-bottom:8pt; border-bottom:0.75pt solid #e3e5e8; font-weight:400;">Product or service</th>
          <th style="padding-bottom:8pt; border-bottom:0.75pt solid #e3e5e8; font-weight:400;">Description</th>
          <th style="padding-bottom:8pt; border-bottom:0.75pt solid #e3e5e8; font-weight:400; text-align:right; width:32pt;">Qty</th>
          <th style="padding-bottom:8pt; border-bottom:0.75pt solid #e3e5e8; font-weight:400; text-align:right; width:55pt;">Rate</th>
          <th style="padding-bottom:8pt; border-bottom:0.75pt solid #e3e5e8; font-weight:400; text-align:right; width:60pt;">Amount</th>
        </tr>
      </thead>
      <tbody>
        ${rows.map((r) => `
        <tr style="font-size:8pt; color:#393a3d;">
          <td style="padding-top:9pt; vertical-align:top;">${r.n}.</td>
          <td style="padding-top:9pt; vertical-align:top;"></td>
          <td style="padding-top:9pt; vertical-align:top; font-weight:700;">${escapeHtml(r.product)}</td>
          <td style="padding-top:9pt; vertical-align:top;">${escapeHtml(r.detail)}</td>
          <td style="padding-top:9pt; vertical-align:top; text-align:right;">${r.qty}</td>
          <td style="padding-top:9pt; vertical-align:top; text-align:right;">$${fmtUsd(r.rate)}</td>
          <td style="padding-top:9pt; vertical-align:top; text-align:right;">$${fmtUsd(r.amount)}</td>
        </tr>`).join("")}
      </tbody>
    </table>

    <table style="width:195pt; margin-left:auto; border-collapse:collapse; margin-top:8pt;">
      <tr style="border-top:0.75pt solid #e3e5e8;">
        <td style="padding:10pt 0 4pt 0; font-size:8pt; line-height:16pt; font-weight:700; color:#393a3d;">Total</td>
        <td style="padding:10pt 0 4pt 0; text-align:right; font-weight:700; font-size:12pt; line-height:16pt; color:#393a3d;">$${fmtUsd(total)}</td>
      </tr>
    </table>
  </div>
</div>`;
}

// Pravi PDF preko html2pdf.js (isti way rendering kao dugme "Preuzmi PDF" u
// Izveštaju) — output ide kao base64 string za email prilog, ne kao download.
async function buildInvoicePdfBase64(invoice, company, items) {
  // html2canvas vraća canvas visine 0 (prazan PDF) kad je container
  // pozicioniran van ekrana preko position:fixed/absolute + negativan
  // offset — umesto toga ga sakrivamo preko overflow:hidden wrapper-a
  // (visina/širina 0) dok je sam container unutra normalno pozicioniran
  // (static), što html2canvas ispravno renderuje.
  const wrapper = document.createElement("div");
  wrapper.style.overflow = "hidden";
  wrapper.style.height = "0";
  wrapper.style.width = "0";

  const container = document.createElement("div");
  container.style.width = "612pt";
  container.style.background = "#ffffff";
  container.innerHTML = buildInvoicePdfDocumentHtml(invoice, company, items);

  wrapper.appendChild(container);
  document.body.appendChild(wrapper);
  try {
    // format:'letter' (612x792pt, US Letter — isto kao original) + margin:0
    // jer su margine već deo HTML-a (padding u pt) — container je tačno
    // 612pt širok, tj. tačno širina strane, bez ikakvog razmeravanja/stretch.
    const dataUri = await html2pdf()
      .set({
        margin: 0,
        html2canvas: { scale: 3 },
        jsPDF: { unit: "pt", format: "letter", orientation: "portrait" },
      })
      .from(container)
      .outputPdf("datauristring");
    return dataUri.split(",")[1];
  } finally {
    wrapper.remove();
  }
}

async function openInvoiceModal(detailRow, dateValue, triggerBtn) {
  const company = detailRow.company;
  let invoice;
  try {
    invoice = await getOrCreateInvoice(detailRow, dateValue);
  } catch (error) {
    showToast("Greška pri kreiranju fakture: " + error.message, true);
    return;
  }

  state.currentInvoice = invoice;
  state.currentInvoiceCompany = company;
  state.currentInvoiceButton = triggerBtn || null;

  el.invoiceModalSubtitle.textContent = `${company.name} — faktura #${invoice.invoice_number}`;
  el.invoicePreview.innerHTML = buildInvoiceHtml(invoice, company);
  el.invoiceSendTo.value = invoice.sent_to || company.email || TEST_INVOICE_EMAIL;
  el.sendInvoiceBtn.textContent = invoice.sent_at
    ? `Pošalji ponovo (poslato ${new Date(invoice.sent_at).toLocaleString("sr-RS")})`
    : "Pošalji";
  el.invoiceModal.hidden = false;
}

function closeInvoiceModal() {
  el.invoiceModal.hidden = true;
  state.currentInvoice = null;
  state.currentInvoiceCompany = null;
  state.currentInvoiceButton = null;
}

el.closeInvoiceBtn.addEventListener("click", closeInvoiceModal);
el.invoiceModal.addEventListener("click", (e) => {
  if (e.target === el.invoiceModal) closeInvoiceModal();
});

el.sendInvoiceBtn.addEventListener("click", async () => {
  const invoice = state.currentInvoice;
  const company = state.currentInvoiceCompany;
  if (!invoice || !company) return;

  const to = el.invoiceSendTo.value.trim();
  if (!to) {
    showToast("Unesi email adresu", true);
    return;
  }
  if (!INVOICE_EMAIL_WORKER_URL) {
    showToast("Worker za slanje email-a još nije podešen (INVOICE_EMAIL_WORKER_URL u js/app.js)", true);
    return;
  }

  el.sendInvoiceBtn.disabled = true;
  try {
    const html = buildInvoiceHtml(invoice, company);
    const pdfBase64 = await buildInvoicePdfBase64(invoice, company);
    const resp = await fetch(INVOICE_EMAIL_WORKER_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        to,
        subject: `Faktura #${invoice.invoice_number} — VRH Tracking Technologies LLC`,
        html,
        attachments: [
          { filename: `Faktura_${invoice.invoice_number}.pdf`, content: pdfBase64 },
        ],
      }),
    });
    const result = await resp.json();
    if (!resp.ok) throw new Error(result.error || "Slanje nije uspelo");

    const sentAt = new Date().toISOString();
    const { error: updErr } = await supabase
      .from("invoices")
      .update({ sent_to: to, sent_at: sentAt })
      .eq("id", invoice.id);
    if (updErr) throw updErr;

    invoice.sent_to = to;
    invoice.sent_at = sentAt;
    if (state.currentInvoiceButton) {
      state.currentInvoiceButton.textContent = "Vidi fakturu";
      state.currentInvoiceButton.classList.add("invoice-report-btn-sent");
    }
    showToast(`Faktura poslata na ${to}`);
    closeInvoiceModal();
  } catch (error) {
    showToast("Greška pri slanju: " + error.message, true);
  } finally {
    el.sendInvoiceBtn.disabled = false;
  }
});

// ---------- ručna Behind faktura (Behind izveštaj > "Napravi fakturu") ----------
// Naplata Behind firmi je specifična po firmi (mešavina Basic + više Advanced
// stavki, svaka sa sopstvenim napomenom npr. "V:772; 4 weeks") i ne uklapa se
// u jednoobrazan automatski obračun — zato operater ovde ručno pravi fakturu
// sa proizvoljnim brojem stavki (vidi sql/invoice_items.sql). Automatski
// obračun iznad (baseline + additions) ostaje kao referenca, faktura se pravi
// nezavisno od njega.

const ADVANCED_ITEM_DESCRIPTION = "Basic subscription with level 2 Technical Support";

function manualItemDescription(item) {
  if (item.type === "basic") return "VRH START — Basic subscription";
  const note = (item.note || "").trim();
  return `VRH ADVANCED PACKAGE — ${ADVANCED_ITEM_DESCRIPTION}${note ? ` (${note})` : ""}`;
}

function manualItemAmount(item) {
  return (Number(item.qty) || 0) * (Number(item.rate) || 0);
}

function newBasicManualItem(defaultRate) {
  return { id: null, type: "basic", note: "", qty: 1, rate: defaultRate };
}

function newAdvancedManualItem(defaultRate) {
  return { id: null, type: "advanced", note: "", qty: 1, rate: defaultRate };
}

// Rekonstruiše editabilni oblik stavke iz sačuvanog invoice_items reda —
// koristi se kad se faktura ponovo otvori (već ima sačuvane stavke). Tip se
// prepoznaje po opisu (ne po poziciji — redovi se sad mogu dodavati/brisati
// slobodnim redosledom, Basic više nije uvek prvi).
function parseManualInvoiceItemRow(row) {
  if (row.description.startsWith("VRH START —")) {
    return { id: row.id, type: "basic", note: "", qty: row.qty, rate: row.rate };
  }
  const m = row.description.match(/\(([^)]*)\)\s*$/);
  return { id: row.id, type: "advanced", note: m ? m[1] : "", qty: row.qty, rate: row.rate };
}

function computeManualInvoiceTotal() {
  return state.manualInvoiceItems.reduce((acc, item) => acc + manualItemAmount(item), 0);
}

// Živi pregled fakture (isti "email" izgled kao kod Current faktura) — ne
// diramo DOM redova (ne bi radio full renderManualInvoiceItems() na svaki
// tasterr jer bi to izgubilo fokus iz input polja dok se kuca).
// Samo opis stavki (bez zaglavlja firme/pozdrava/iznosa — to se već vidi u
// poljima iznad) — služi da se proveri kako će tačno da glasi tekst na fakturi.
function renderManualInvoicePreview() {
  if (state.manualInvoiceItems.length === 0) {
    el.behindInvoicePreview.innerHTML = '<p class="section-hint">Dodaj bar jednu stavku da vidiš pregled fakture.</p>';
    return;
  }
  const ol = document.createElement("ol");
  ol.className = "manual-invoice-preview-list";
  for (const item of state.manualInvoiceItems) {
    ol.appendChild(el_("li", null, manualItemDescription(item)));
  }
  el.behindInvoicePreview.innerHTML = "";
  el.behindInvoicePreview.appendChild(ol);
}

function refreshManualInvoiceSummary() {
  el.behindInvoiceTotal.textContent = `Ukupno: $${fmtUsd(computeManualInvoiceTotal())}`;
  renderManualInvoicePreview();
}

// Informativni prikaz automatskog obračuna — identična tabela kao u Behind
// izveštaju (buildBehindCompanyTable), samo referenca, ne menja se dok
// operater kuca ručne stavke ispod, i ne upisuje se u fakturu.
function renderAutoCalcSummary(block) {
  el.behindInvoiceSummaryLine.innerHTML = "";
  el.behindInvoiceSummaryLine.appendChild(el_("div", "manual-invoice-auto-summary-title", "Automatski obračun (Pregled uređaja):"));
  el.behindInvoiceSummaryLine.appendChild(buildBehindCompanyTable(block));
}

function buildManualInvoiceRow(item, index) {
  const isBasic = item.type === "basic";
  const row = el_("div", `manual-invoice-row${isBasic ? " manual-invoice-row-basic" : ""}`);
  row.appendChild(el_("div", "manual-invoice-label", isBasic ? "VRH START — Basic subscription" : `VRH ADVANCED PACKAGE — ${ADVANCED_ITEM_DESCRIPTION}`));

  if (!isBasic) {
    const noteField = el_("label", "manual-invoice-field manual-invoice-field-note", "Napomena (npr. V:772; 4 weeks)");
    const noteInput = document.createElement("input");
    noteInput.type = "text";
    noteInput.value = item.note;
    noteInput.placeholder = "V:772; 4 weeks";
    noteInput.addEventListener("input", () => {
      item.note = noteInput.value;
      renderManualInvoicePreview();
    });
    noteField.appendChild(noteInput);
    row.appendChild(noteField);
  }

  const qtyField = el_("label", "manual-invoice-field manual-invoice-field-qty", "Kol.");
  const qtyInput = document.createElement("input");
  qtyInput.type = "number";
  qtyInput.min = "0";
  qtyInput.step = "1";
  qtyInput.value = item.qty;
  qtyField.appendChild(qtyInput);
  row.appendChild(qtyField);

  const rateField = el_("label", "manual-invoice-field manual-invoice-field-rate", "Cena");
  const rateInput = document.createElement("input");
  rateInput.type = "number";
  rateInput.min = "0";
  rateInput.step = "0.01";
  rateInput.value = item.rate;
  rateField.appendChild(rateInput);
  row.appendChild(rateField);

  const amount = el_("div", "manual-invoice-amount", `$${fmtUsd(manualItemAmount(item))}`);
  const refreshAmount = () => {
    item.qty = Number(qtyInput.value) || 0;
    item.rate = Number(rateInput.value) || 0;
    amount.textContent = `$${fmtUsd(manualItemAmount(item))}`;
    refreshManualInvoiceSummary();
  };
  qtyInput.addEventListener("input", refreshAmount);
  rateInput.addEventListener("input", refreshAmount);
  row.appendChild(amount);

  const removeBtn = el_("button", "manual-invoice-remove", "×");
  removeBtn.type = "button";
  removeBtn.title = "Ukloni stavku";
  removeBtn.addEventListener("click", () => {
    state.manualInvoiceItems.splice(index, 1);
    renderManualInvoiceItems();
  });
  row.appendChild(removeBtn);

  return row;
}

function renderManualInvoiceItems() {
  el.behindInvoiceItems.innerHTML = "";
  state.manualInvoiceItems.forEach((item, index) => {
    el.behindInvoiceItems.appendChild(buildManualInvoiceRow(item, index));
  });
  refreshManualInvoiceSummary();
}

// Jedna (ručna) faktura po firmi po ciklusu — invoice_date je uvek poslednji
// dan ciklusa (24.), bez obzira koji je dan izabran u date pickeru izveštaja,
// da ponovni klik na isti ciklus uvek vrati istu fakturu (isti broj), ne
// pravi duplikat (unique constraint na (company_id, invoice_date)).
async function getOrCreateManualInvoice(company, invoiceDateValue) {
  const { data: existing, error: selErr } = await supabase
    .from("invoices")
    .select("*")
    .eq("company_id", company.id)
    .eq("invoice_date", invoiceDateValue)
    .maybeSingle();
  if (selErr) throw selErr;
  if (existing) return existing;

  const { data: created, error: insErr } = await supabase
    .from("invoices")
    .insert({ company_id: company.id, invoice_date: invoiceDateValue, manual: true, amount: 0 })
    .select()
    .single();
  if (insErr) throw insErr;
  return created;
}

async function saveManualInvoiceItems() {
  const invoice = state.manualInvoice;
  const rows = state.manualInvoiceItems.map((item, i) => ({
    invoice_id: invoice.id,
    position: i,
    description: manualItemDescription(item),
    qty: Number(item.qty) || 0,
    rate: Number(item.rate) || 0,
    amount: manualItemAmount(item),
  }));

  const { error: delErr } = await supabase.from("invoice_items").delete().eq("invoice_id", invoice.id);
  if (delErr) throw delErr;

  let saved = [];
  if (rows.length > 0) {
    const { data, error: insErr } = await supabase.from("invoice_items").insert(rows).select();
    if (insErr) throw insErr;
    // ne oslanjaj se na redosled vraćen iz baze — sortiraj po position (isto
    // polje koje smo upisali) da tačno odgovara redosledu u state.manualInvoiceItems
    saved = data.slice().sort((a, b) => a.position - b.position);
  }

  const total = saved.reduce((acc, r) => acc + Number(r.amount), 0);
  const { data: updated, error: updErr } = await supabase
    .from("invoices")
    .update({ amount: total })
    .eq("id", invoice.id)
    .select()
    .single();
  if (updErr) throw updErr;

  state.manualInvoice = updated;
  // vrati id-jeve novosačuvanih redova u editabilne stavke, po istom redosledu
  state.manualInvoiceItems.forEach((item, i) => {
    item.id = saved[i] ? saved[i].id : null;
  });
  return saved;
}

async function openBehindInvoiceModal(block, invoiceDateValue, triggerBtn) {
  const company = block.company;
  let invoice;
  try {
    invoice = await getOrCreateManualInvoice(company, invoiceDateValue);
  } catch (error) {
    showToast("Greška pri kreiranju fakture: " + error.message, true);
    return;
  }

  const { data: existingItems, error: itemsErr } = await supabase
    .from("invoice_items")
    .select("*")
    .eq("invoice_id", invoice.id)
    .order("position", { ascending: true });
  if (itemsErr) {
    showToast("Greška pri učitavanju stavki: " + itemsErr.message, true);
    return;
  }

  state.manualInvoice = invoice;
  state.manualInvoiceCompany = company;
  state.manualInvoiceButton = triggerBtn || null;

  // Prazno po defaultu (bez auto-popune iz automatskog obračuna) — operater
  // ručno dodaje Basic/Advanced stavke preko dugmadi ispod liste.
  state.manualInvoiceItems = existingItems ? existingItems.map(parseManualInvoiceItemRow) : [];

  el.behindInvoiceModalSubtitle.textContent = `${company.name} — faktura #${invoice.invoice_number}`;
  renderAutoCalcSummary(block);
  renderManualInvoiceItems();
  el.behindInvoiceSendTo.value = invoice.sent_to || company.email || TEST_INVOICE_EMAIL;
  el.sendBehindInvoiceBtn.textContent = invoice.sent_at
    ? `Pošalji ponovo (poslato ${new Date(invoice.sent_at).toLocaleString("sr-RS")})`
    : "Pošalji";
  el.behindInvoiceModal.hidden = false;
}

function closeBehindInvoiceModal() {
  el.behindInvoiceModal.hidden = true;
  el.behindInvoiceSummaryLine.innerHTML = "";
  state.manualInvoice = null;
  state.manualInvoiceCompany = null;
  state.manualInvoiceItems = [];
  state.manualInvoiceButton = null;
}

el.addBehindBasicRowBtn.addEventListener("click", () => {
  state.manualInvoiceItems.push(newBasicManualItem(START_TIER_PRICE));
  renderManualInvoiceItems();
});

el.addBehindAdvancedRowBtn.addEventListener("click", () => {
  const defaultRate = state.manualInvoiceCompany ? (state.manualInvoiceCompany.price || 200) : 200;
  state.manualInvoiceItems.push(newAdvancedManualItem(defaultRate));
  renderManualInvoiceItems();
});

el.closeBehindInvoiceBtn.addEventListener("click", closeBehindInvoiceModal);
el.behindInvoiceModal.addEventListener("click", (e) => {
  if (e.target === el.behindInvoiceModal) closeBehindInvoiceModal();
});

el.saveBehindInvoiceBtn.addEventListener("click", async () => {
  if (!state.manualInvoice) return;
  el.saveBehindInvoiceBtn.disabled = true;
  try {
    await saveManualInvoiceItems();
    showToast("Faktura sačuvana");
  } catch (error) {
    showToast("Greška pri čuvanju: " + error.message, true);
  } finally {
    el.saveBehindInvoiceBtn.disabled = false;
  }
});

el.sendBehindInvoiceBtn.addEventListener("click", async () => {
  const company = state.manualInvoiceCompany;
  if (!state.manualInvoice || !company) return;

  const to = el.behindInvoiceSendTo.value.trim();
  if (!to) {
    showToast("Unesi email adresu", true);
    return;
  }
  if (!INVOICE_EMAIL_WORKER_URL) {
    showToast("Worker za slanje email-a još nije podešen (INVOICE_EMAIL_WORKER_URL u js/app.js)", true);
    return;
  }

  el.sendBehindInvoiceBtn.disabled = true;
  try {
    const items = await saveManualInvoiceItems();
    const invoice = state.manualInvoice;
    const html = buildInvoiceHtml(invoice, company, items);
    const pdfBase64 = await buildInvoicePdfBase64(invoice, company, items);
    const resp = await fetch(INVOICE_EMAIL_WORKER_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        to,
        subject: `Faktura #${invoice.invoice_number} — VRH Tracking Technologies LLC`,
        html,
        attachments: [
          { filename: `Faktura_${invoice.invoice_number}.pdf`, content: pdfBase64 },
        ],
      }),
    });
    const result = await resp.json();
    if (!resp.ok) throw new Error(result.error || "Slanje nije uspelo");

    const sentAt = new Date().toISOString();
    const { error: updErr } = await supabase
      .from("invoices")
      .update({ sent_to: to, sent_at: sentAt })
      .eq("id", invoice.id);
    if (updErr) throw updErr;

    invoice.sent_to = to;
    invoice.sent_at = sentAt;
    if (state.manualInvoiceButton) {
      state.manualInvoiceButton.textContent = "Vidi fakturu";
      state.manualInvoiceButton.classList.add("invoice-report-btn-sent");
    }
    showToast(`Faktura poslata na ${to}`);
    closeBehindInvoiceModal();
  } catch (error) {
    showToast("Greška pri slanju: " + error.message, true);
  } finally {
    el.sendBehindInvoiceBtn.disabled = false;
  }
});

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

// Tabela automatskog obračuna za jednu Behind firmu (Stavka/Uređaji/Cena po
// uređaju/Iznos) — izdvojena da izgleda identično i u izveštaju ispod i u
// popup-u ručne fakture (vidi renderAutoCalcSummary).
function buildBehindCompanyTable(block) {
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
  baseRow.appendChild(el_("td", null, `Stanje na ${block.baselineDateLabel} (puna cena)`));
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

  return table;
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

  // "Start" firme se tretiraju kao behind bez obzira na status polje — vidi
  // computeCurrentDetailRows, koji ih zbog toga izuzima iz current obračuna.
  const behindCompanies = state.companies.filter((c) => c.status === "behind" || c.entry_column === "start");

  const companyBlocks = [];

  for (const c of behindCompanies) {
    const entryCol = c.entry_column || "advanced";
    const billingStartsOn = c.billing_starts_on || null;
    const price = entryCol === "start" ? START_TIER_PRICE : c.price || 0;

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

    companyBlocks.push({
      company: c,
      baselineCount: baselineCount || 0,
      baselineDateLabel: dateStr(prevYear, prevMonth, 25),
      price,
      baselineAmount,
      additions,
      companyTotal,
    });
  }

  const grandTotal = companyBlocks.reduce((acc, b) => acc + b.companyTotal, 0);

  // Faktura po firmi je uvek ista za ceo ciklus (vidi getOrCreateManualInvoice)
  // — poslednji dan ciklusa (24.), bez obzira koji je dan izabran u date pickeru.
  const invoiceDateValue = dateStr(year, month, 24);
  const sentInvoiceCompanyIds = new Set();
  const blockCompanyIds = companyBlocks.map((b) => b.company.id);
  if (blockCompanyIds.length > 0) {
    const { data: existingInvoices } = await supabase
      .from("invoices")
      .select("company_id, sent_at")
      .eq("invoice_date", invoiceDateValue)
      .in("company_id", blockCompanyIds);
    for (const inv of existingInvoices || []) {
      if (inv.sent_at) sentInvoiceCompanyIds.add(inv.company_id);
    }
  }

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
    const sectionHeader = el_("div", "report-section-header");
    sectionHeader.appendChild(el_("h2", null, block.company.name));
    const alreadySent = sentInvoiceCompanyIds.has(block.company.id);
    const invoiceBtn = el_(
      "button",
      `btn invoice-report-btn${alreadySent ? " invoice-report-btn-sent" : ""}`,
      alreadySent ? "Vidi fakturu" : "Napravi fakturu"
    );
    invoiceBtn.type = "button";
    invoiceBtn.addEventListener("click", () => openBehindInvoiceModal(block, invoiceDateValue, invoiceBtn));
    sectionHeader.appendChild(invoiceBtn);
    section.appendChild(sectionHeader);

    section.appendChild(buildBehindCompanyTable(block));
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
  const [y, m, d] = dateValue.split("-").map(Number);
  const year = y;
  const month = m - 1;
  const day = d;

  el.reportContent.innerHTML = "";
  el.reportContent.appendChild(el_("p", "section-hint", "Učitavanje..."));

  const counts = await loadCounts(year, month);
  // "Start" firme se tretiraju kao behind bez obzira na status — vidi
  // computeCurrentDetailRows / generateBehindReport.
  const currentCompanies = state.companies.filter((c) => c.status === "current" && c.entry_column !== "start");

  const rows = [];
  for (const c of currentCompanies) {
    const dc = counts[c.id] || {};
    const count = dc[day]?.total;
    if (count === undefined || count === null) continue;
    const price = c.price || 0;
    const amount = count * price;
    rows.push({ name: c.name, count, price, amount, companyId: c.id });
  }
  const grandTotal = rows.reduce((acc, r) => acc + r.amount, 0);

  // Pamti tacno ove redove (i tacan izabrani datum) da "Posalji u naplatu"
  // upise ono sto je stvarno prikazano na ekranu, bez ponovnog racunanja.
  state.lastCurrentReport = { dateValue, rows };

  el.reportContent.innerHTML = "";
  el.reportContent.dataset.rendered = "1";

  el.reportContent.appendChild(el_(
    "p", "section-hint",
    `Stanje na ${day}.${pad(month + 1)}.${year}, puna mesečna cena za sve current firme`
  ));

  const section = el_("section", "report-section");
  const table = document.createElement("table");
  table.className = "report-table";
  const thead = document.createElement("thead");
  const headRow = document.createElement("tr");
  for (const h of ["Firma", `Uređaji (${day}. u mesecu)`, "Cena po uređaju", "Iznos"]) {
    headRow.appendChild(el_("th", null, h));
  }
  thead.appendChild(headRow);
  table.appendChild(thead);

  const tbody = document.createElement("tbody");
  if (rows.length === 0) {
    const tr = document.createElement("tr");
    const td = el_("td", "section-hint", `Nema current firmi sa podacima za ${day}. u mesecu`);
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

// ---------- naplata: auto-sync current rows from the daily report ----------

function addDaysStr(dateValue, days) {
  const [y, m, d] = dateValue.split("-").map(Number);
  const dt = new Date(y, m - 1, d + days);
  return dateStr(dt.getFullYear(), dt.getMonth(), dt.getDate());
}

async function loadNaplataAutoState() {
  const { data, error } = await supabase
    .from("naplata_auto_state")
    .select("last_processed_date")
    .eq("id", 1)
    .single();
  if (error) {
    console.error(error);
    return undefined;
  }
  return data?.last_processed_date ?? null;
}

async function setNaplataAutoState(dateValue) {
  await supabase.from("naplata_auto_state").update({ last_processed_date: dateValue }).eq("id", 1);
}

// Writes/refreshes an auto-generated naplata row for one company+day, but
// never overwrites a row a human has already started completing (invoice
// number or naplaćeno decision present) — see sql/naplata.sql's partial
// unique index on (company_id, invoice_date) where source='auto_daily'.
async function upsertAutoNaplataRow(companyId, companyName, invoiceDate, amount) {
  const { data: existing, error: selErr } = await supabase
    .from("naplata")
    .select("id, invoice_number, collected")
    .eq("company_id", companyId)
    .eq("invoice_date", invoiceDate)
    .eq("source", "auto_daily")
    .maybeSingle();

  if (selErr) {
    console.error(selErr);
    return;
  }

  if (!existing) {
    const { error } = await supabase.from("naplata").insert({
      company_id: companyId,
      company_name: companyName,
      invoice_date: invoiceDate,
      cycle: "current",
      amount,
      source: "auto_daily",
    });
    if (error) console.error(error);
    return;
  }

  if (existing.invoice_number === null && existing.collected === null) {
    const { error } = await supabase.from("naplata").update({ amount }).eq("id", existing.id);
    if (error) console.error(error);
  }
}

// Runs once per app load. First run ever (last_processed_date is null)
// just sets the baseline to yesterday and writes nothing — history already
// lives in the database via the one-time Excel import, so auto-sync should
// only pick up from "today" onward. Later runs catch up any days missed
// since the last time the app was opened.
//
// Watermark je namerno zaglavljen na "juče" (nikad ne odmakne do danas) —
// ELD podaci za DANAS mogu stici kasnije (automatski sync u 15h, ručni
// "Sinhronizuj sada", ili ELD izvor koji kasni sa objavom), pa ako bi se
// danas markiralo kao "obrađeno" pri prvom pokretanju u toku dana, svaka
// aktivacija koja stigne posle toga bi tiho ostala neupisana u Naplatu
// (upravo to se desilo — samo firma čiji je podatak već stigao pre prvog
// pokretanja se upisala). Prošli dani i dalje ostaju obrađeni tačno jednom
// (efikasno), a današnji dan se svaki put iznova preračunava —
// upsertAutoNaplataRow je bezbedan za ponovno pisanje, ne dira redove koje
// je čovek već počeo da popunjava.
async function runNaplataAutoSync() {
  const today = dateStr(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterday = addDaysStr(today, -1);
  const lastProcessed = await loadNaplataAutoState();
  if (lastProcessed === undefined) return; // load failed, already logged

  if (lastProcessed === null) {
    await setNaplataAutoState(yesterday);
    return;
  }

  if (lastProcessed >= today) return;

  const monthCountsCache = {};
  const loadMonthCounts = async (year, month) => {
    const key = `${year}-${month}`;
    if (!monthCountsCache[key]) monthCountsCache[key] = await loadCounts(year, month);
    return monthCountsCache[key];
  };

  let cursor = addDaysStr(lastProcessed, 1);
  while (cursor <= today) {
    const [y, m, d] = cursor.split("-").map(Number);
    const month = m - 1;
    const counts = await loadMonthCounts(y, month);
    const rows = computeCurrentDetailRows(counts, state.companies, y, month, d);
    for (const r of rows) {
      await upsertAutoNaplataRow(r.company.id, r.company.name, cursor, r.amount);
    }
    cursor = addDaysStr(cursor, 1);
  }

  await setNaplataAutoState(yesterday);
}

// ---------- porudžbine (Orders.xlsx: lista + detalji) ----------

async function loadOrders() {
  const pageSize = 1000;
  const all = [];
  let from = 0;
  while (true) {
    const { data, error } = await supabase
      .from("orders")
      .select("*")
      .order("order_date", { ascending: false })
      .range(from, from + pageSize - 1);
    if (error) {
      showToast("Greška pri učitavanju porudžbina: " + error.message, true);
      break;
    }
    all.push(...(data ?? []));
    if (!data || data.length < pageSize) break;
    from += pageSize;
  }
  state.orders = all;
  state.ordersLoaded = true;
}

async function loadOrderItems() {
  const pageSize = 1000;
  const all = [];
  let from = 0;
  while (true) {
    const { data, error } = await supabase
      .from("order_items")
      .select("*")
      .order("id", { ascending: true })
      .range(from, from + pageSize - 1);
    if (error) {
      showToast("Greška pri učitavanju stavki porudžbina: " + error.message, true);
      break;
    }
    all.push(...(data ?? []));
    if (!data || data.length < pageSize) break;
    from += pageSize;
  }
  state.orderItems = all;
  state.orderItemsLoaded = true;
}

// Jedinstven spisak "šta je poručeno" za jednu porudžbinu: ručno unete
// porudžbine (source='manual') drže artikle u order_items (proizvoljan
// broj); istorijski uvezene (source='import') nemaju order_items redove pa
// se linije grade iz device_*/connector_* kolona direktno na orders — bez
// migracije istorije, oba prikaza izgledaju isto na listi.
function getOrderItemLines(order) {
  const items = state.orderItems.filter((it) => it.order_id === order.id);
  if (items.length > 0) {
    return items.map((it) => formatOrderItemLine(it.product_name, it.price, it.count)).filter(Boolean);
  }
  return [
    formatOrderItemLine(order.device_name, order.device_price, order.device_count),
    formatOrderItemLine(order.connector_name, order.connector_price, order.connector_count),
  ].filter(Boolean);
}

// Način isporuke i status fakture su slobodan tekst iz Orders.xlsx (19+
// varijanti svaki, bez čiste dobro/loše semantike) — svakoj različitoj
// vrednosti se dodeljuje sopstvena stabilna boja (heš teksta -> nijansa),
// umesto fiksne palete koju bi trebalo ručno održavati za svaku varijantu.
function stringToHue(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = str.charCodeAt(i) + ((hash << 5) - hash);
  }
  return Math.abs(hash) % 360;
}

function applyValueBadgeColor(el, value) {
  const hue = stringToHue(value.trim().toLowerCase());
  el.style.background = `hsl(${hue}, 60%, 90%)`;
  el.style.color = `hsl(${hue}, 55%, 28%)`;
}

// "3x PT30 @ $130.00 = $390.00" — jedan red po stavci (uređaj i/ili konektor);
// prikazuju se jedna ispod druge u ćeliji ako porudžbina ima oba.
function formatOrderItemLine(name, price, count) {
  if (!name) return null;
  const c = count !== null && count !== undefined && count !== "" && !Number.isNaN(Number(count)) ? Number(count) : 1;
  const p = price !== null && price !== undefined && price !== "" && !Number.isNaN(Number(price)) ? Number(price) : null;
  let line = `${c}x ${name}`;
  if (p !== null) {
    line += ` @ $${p.toFixed(2)} = $${(p * c).toFixed(2)}`;
  }
  return line;
}

// ---------- storno porudžbine (porudžbina ostaje, uređaji/konektori se vraćaju na stanje) ----------

async function cancelOrder(order) {
  if (order.cancelled) return;
  if (
    !confirm(
      `Sigurno da storniraš porudžbinu za "${order.company_name}"?\n\nUređaji i konektori sa ove porudžbine vraćaju se na stanje.`
    )
  ) {
    return;
  }

  const { error: releaseError } = await supabase
    .from("device_units")
    .update({ status: "in_stock", order_id: null, order_item_id: null, shipped_at: null })
    .eq("order_id", order.id);
  if (releaseError) {
    showToast("Greška pri vraćanju uređaja na stanje: " + releaseError.message, true);
    return;
  }
  for (const u of state.deviceUnits) {
    if (u.order_id === order.id) {
      u.status = "in_stock";
      u.order_id = null;
      u.order_item_id = null;
    }
  }

  const items = state.orderItems.filter((it) => it.order_id === order.id);
  for (const it of items) {
    const product = state.products.find((p) => p.id === it.product_id);
    if (product && product.type === "connector") {
      const qty = parseFloat(it.count) || 0;
      const newQty = (product.stock_quantity || 0) + qty;
      const { error: qtyError } = await supabase.from("products").update({ stock_quantity: newQty }).eq("id", product.id);
      if (!qtyError) product.stock_quantity = newQty;
    }
  }
  // legacy porudzbine (flat connector_* kolone, bez order_items) - iste
  // konektore vratimo po istom principu kao gore.
  if (items.length === 0 && order.connector_id) {
    const product = state.products.find((p) => p.id === order.connector_id);
    if (product && product.type === "connector") {
      const qty = parseFloat(order.connector_count) || 0;
      const newQty = (product.stock_quantity || 0) + qty;
      const { error: qtyError } = await supabase.from("products").update({ stock_quantity: newQty }).eq("id", product.id);
      if (!qtyError) product.stock_quantity = newQty;
    }
  }

  const cancelledAt = new Date().toISOString();
  const { error } = await supabase.from("orders").update({ cancelled: true, cancelled_at: cancelledAt }).eq("id", order.id);
  if (error) {
    showToast("Greška pri storniranju: " + error.message, true);
    return;
  }

  order.cancelled = true;
  order.cancelled_at = cancelledAt;
  renderOrders();
  showToast("Porudžbina stornirana — uređaji/konektori vraćeni na stanje");
}

// Samo skida oznaku storna - NE dodeljuje ponovo uređaje/konektore
// automatski (mogli su u međuvremenu biti poslati na drugoj porudžbini) -
// po potrebi ih ručno ponovo izabrati kroz Izmeni.
async function restoreOrder(order) {
  if (!order.cancelled) return;
  if (
    !confirm(
      `Vratiti porudžbinu za "${order.company_name}" iz storna?\n\nNapomena: uređaji/konektori se NEĆE automatski ponovo dodeliti — po potrebi ih ponovo izaberi kroz Izmeni.`
    )
  ) {
    return;
  }

  const { error } = await supabase.from("orders").update({ cancelled: false, cancelled_at: null }).eq("id", order.id);
  if (error) {
    showToast("Greška: " + error.message, true);
    return;
  }
  order.cancelled = false;
  order.cancelled_at = null;
  renderOrders();
  showToast("Storno poništen");
}

function buildOrderRow(order, rowIndex) {
  const tr = document.createElement("tr");
  tr.className = `orders-row ${rowIndex % 2 === 0 ? "orders-row-even" : "orders-row-odd"}${
    order.cancelled ? " orders-row-cancelled" : ""
  }`;
  tr.appendChild(el_("td", null, order.order_date || "—"));
  tr.appendChild(el_("td", null, order.qb_invoice_number || "—"));
  tr.appendChild(el_("td", null, order.woocommerce_order_number || "—"));

  const companyTd = el_("td", "orders-company-cell", order.company_name);
  if (order.cancelled) {
    companyTd.appendChild(document.createTextNode(" "));
    companyTd.appendChild(el_("span", "badge orders-cancelled-badge", "STORNIRANO"));
  }
  tr.appendChild(companyTd);

  const itemsTd = document.createElement("td");
  itemsTd.className = "orders-items-cell";
  const lines = getOrderItemLines(order);
  if (lines.length === 0) {
    itemsTd.textContent = "—";
  } else {
    for (const line of lines) itemsTd.appendChild(el_("div", "orders-item-line", line));
  }
  tr.appendChild(itemsTd);

  tr.appendChild(
    el_("td", "naplata-amount", order.amount !== null && order.amount !== undefined ? Number(order.amount).toFixed(2) : "—")
  );

  tr.appendChild(el_("td", null, order.shipping_date || "—"));

  const shipmentTd = document.createElement("td");
  shipmentTd.className = "orders-compact-col";
  if (order.shipment_type) {
    const badge = el_("span", "badge orders-compact-badge", order.shipment_type);
    badge.title = order.shipment_type;
    applyValueBadgeColor(badge, order.shipment_type);
    shipmentTd.appendChild(badge);
  } else {
    shipmentTd.textContent = "—";
  }
  tr.appendChild(shipmentTd);

  const statusTd = document.createElement("td");
  statusTd.className = "orders-compact-col";
  if (order.invoice_status) {
    const badge = el_("span", "badge orders-compact-badge", order.invoice_status);
    badge.title = order.invoice_status;
    applyValueBadgeColor(badge, order.invoice_status);
    statusTd.appendChild(badge);
  } else {
    statusTd.textContent = "—";
  }
  tr.appendChild(statusTd);

  const editTd = document.createElement("td");
  editTd.className = "orders-actions-cell";
  if (canEdit("orders")) {
    if (!order.cancelled) {
      const editBtn = el_("button", "icon-btn icon-pencil", "✎");
      editBtn.type = "button";
      editBtn.title = "Izmeni porudžbinu";
      editBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        openOrderForm("edit", order);
      });
      editTd.appendChild(editBtn);

      const cancelBtn = el_("button", "icon-btn icon-cancel-order", "⊘");
      cancelBtn.type = "button";
      cancelBtn.title = "Storniraj porudžbinu — uređaji/konektori se vraćaju na stanje";
      cancelBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        cancelOrder(order);
      });
      editTd.appendChild(cancelBtn);
    } else {
      const restoreBtn = el_("button", "icon-btn icon-restore-order", "↺");
      restoreBtn.type = "button";
      restoreBtn.title = "Poništi storno";
      restoreBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        restoreOrder(order);
      });
      editTd.appendChild(restoreBtn);
    }
  }
  tr.appendChild(editTd);

  tr.addEventListener("click", () => openOrderDetail(order));
  return tr;
}

function buildOrdersMonthHeaderRow(monthKey, count, labelOverride) {
  const tr = document.createElement("tr");
  tr.className = "naplata-month-row";
  const expanded = state.expandedOrdersMonths.has(monthKey);
  const td = document.createElement("td");
  td.colSpan = 10;
  const label = labelOverride || naplataMonthLabel(monthKey);
  const btn = el_("button", "naplata-month-btn", `${expanded ? "▾" : "▸"} ${label} (${count})`);
  btn.type = "button";
  btn.addEventListener("click", () => {
    if (expanded) state.expandedOrdersMonths.delete(monthKey);
    else state.expandedOrdersMonths.add(monthKey);
    renderOrders();
  });
  td.appendChild(btn);
  tr.appendChild(td);
  return tr;
}

// Grupisano po mesecu porudžbine (najnoviji prvi, tekući mesec otvoren po
// defaultu) — isti obrazac kao Naplata → Zatvoreno.
function renderOrders() {
  const query = state.ordersSearch.trim().toLowerCase();
  const rows = state.orders.filter((o) => !query || o.company_name.toLowerCase().includes(query));

  el.ordersEmptyState.hidden = rows.length > 0;
  el.ordersTable.hidden = rows.length === 0;
  el.ordersBody.innerHTML = "";

  const byMonth = new Map();
  const noDate = [];
  for (const o of rows) {
    if (!o.order_date) {
      noDate.push(o);
      continue;
    }
    const key = naplataMonthKey(o.order_date);
    if (!byMonth.has(key)) byMonth.set(key, []);
    byMonth.get(key).push(o);
  }

  const months = Array.from(byMonth.keys()).sort().reverse();
  for (const monthKey of months) {
    const monthRows = byMonth.get(monthKey).slice().sort((a, b) => (b.order_date || "").localeCompare(a.order_date || ""));
    el.ordersBody.appendChild(buildOrdersMonthHeaderRow(monthKey, monthRows.length));
    if (state.expandedOrdersMonths.has(monthKey)) {
      monthRows.forEach((order, idx) => el.ordersBody.appendChild(buildOrderRow(order, idx)));
    }
  }

  if (noDate.length > 0) {
    el.ordersBody.appendChild(buildOrdersMonthHeaderRow("no-date", noDate.length, "Bez datuma"));
    if (state.expandedOrdersMonths.has("no-date")) {
      noDate.forEach((order, idx) => el.ordersBody.appendChild(buildOrderRow(order, idx)));
    }
  }
}

el.ordersSearchInput.addEventListener("input", () => {
  state.ordersSearch = el.ordersSearchInput.value;
  renderOrders();
});

// ---------- porudžbine: detalj modal ----------

const ORDER_DETAIL_FIELDS = [
  ["contact_name", "Ovlašćeno lice"],
  ["phone", "Telefon"],
  ["email", "Email"],
  ["customer_type", "Tip kupca"],
  ["serial_number", "Serijski broj"],
  ["paperwork", "Papirologija"],
  ["address", "Adresa"],
  ["notes", "Napomene"],
  ["shipping_department", "Odeljenje za dostavu"],
  ["usps_tracking_number", "USPS tracking broj"],
  ["shipping_date", "Datum slanja"],
  ["email_confirmation", "Email potvrda"],
];

function openOrderDetail(order) {
  el.orderDetailSubtitle.textContent = `${order.company_name}${order.order_date ? " — " + order.order_date : ""}`;
  el.orderDetailList.innerHTML = "";

  const lines = getOrderItemLines(order);
  el.orderDetailList.appendChild(el_("dt", null, "Šta je poručeno"));
  const itemsDd = el_("dd", null);
  itemsDd.textContent = lines.length > 0 ? "" : "—";
  for (const line of lines) itemsDd.appendChild(el_("div", null, line));
  el.orderDetailList.appendChild(itemsDd);

  el.orderDetailList.appendChild(el_("dt", null, "Ukupno"));
  el.orderDetailList.appendChild(
    el_("dd", null, order.amount !== null && order.amount !== undefined ? `$${Number(order.amount).toFixed(2)}` : "—")
  );

  for (const [field, label] of ORDER_DETAIL_FIELDS) {
    el.orderDetailList.appendChild(el_("dt", null, label));
    el.orderDetailList.appendChild(el_("dd", null, order[field] ? String(order[field]) : "—"));
  }
  el.orderDetailModal.hidden = false;
}

el.closeOrderDetailBtn.addEventListener("click", () => {
  el.orderDetailModal.hidden = true;
});
el.orderDetailModal.addEventListener("click", (e) => {
  if (e.target === el.orderDetailModal) el.orderDetailModal.hidden = true;
});

// ---------- porudžbine: "+ Nova porudžbina" (proizvoljan broj artikala) ----------

function createEmptyNewOrderItem() {
  return { tempId: `tmp-${Date.now()}-${Math.random().toString(36).slice(2)}`, productId: "", price: "", count: 1 };
}

function getSelectedNewOrderCompanyId() {
  const typed = el.newOrderCompany.value.trim().toLowerCase();
  const company = state.companies.find((c) => c.name.trim().toLowerCase() === typed);
  return company ? company.id : null;
}

function findCompanyPriceForProduct(companyId, productId) {
  if (!companyId || !productId) return null;
  const cp = state.companyPrices.find((p) => p.company_id === companyId && p.product_id === productId);
  return cp ? cp.price : null;
}

function updateNewOrderTotal() {
  const total = state.newOrderItems.reduce((acc, it) => {
    const price = parseFloat(it.price);
    const count = parseFloat(it.count);
    if (Number.isNaN(price) || Number.isNaN(count)) return acc;
    return acc + price * count;
  }, 0);
  el.newOrderAmount.value = total.toFixed(2);
}

function buildNewOrderItemRow(item) {
  const row = document.createElement("div");
  row.className = "new-order-item-row";

  const productSelect = document.createElement("select");
  productSelect.appendChild(new Option("— izaberi proizvod —", ""));
  const devices = state.products.filter((p) => p.type === "device");
  const connectors = state.products.filter((p) => p.type === "connector");
  if (devices.length) {
    const grp = document.createElement("optgroup");
    grp.label = "Uređaji";
    for (const p of devices) grp.appendChild(new Option(p.name, p.id));
    productSelect.appendChild(grp);
  }
  if (connectors.length) {
    const grp = document.createElement("optgroup");
    grp.label = "Konektori";
    for (const p of connectors) grp.appendChild(new Option(p.name, p.id));
    productSelect.appendChild(grp);
  }
  productSelect.value = item.productId || "";
  productSelect.addEventListener("change", () => {
    item.productId = productSelect.value;
    const autoPrice = findCompanyPriceForProduct(getSelectedNewOrderCompanyId(), item.productId);
    if (autoPrice !== null) item.price = autoPrice;
    const newProduct = state.products.find((p) => p.id === item.productId);
    if (newProduct && newProduct.type === "device") {
      if (!item.selectedSerials) item.selectedSerials = [];
      item.count = item.selectedSerials.length;
    }
    renderNewOrderItems();
  });

  const priceInput = document.createElement("input");
  priceInput.type = "number";
  priceInput.step = "0.01";
  priceInput.min = "0";
  priceInput.placeholder = "Cena";
  priceInput.value = item.price === "" || item.price === null ? "" : item.price;
  priceInput.addEventListener("input", () => {
    item.price = priceInput.value;
    updateNewOrderTotal();
  });

  // Za uređaje (PT30/PT40 i sl.): nema ručnog unosa količine — količina se
  // postavlja automatski na broj čekiranih serijskih brojeva (ispod). Za
  // konektore ostaje ručni unos količine, kao i pre.
  const product = state.products.find((p) => p.id === item.productId);
  const isDevice = product && product.type === "device";

  let countInput = null;
  let qtyBadge = null;
  if (isDevice) {
    if (!item.selectedSerials) item.selectedSerials = [];
    item.count = item.selectedSerials.length;
    qtyBadge = document.createElement("span");
    qtyBadge.className = "new-order-item-qty-badge";
    qtyBadge.title = "Količina — automatski, broj izabranih serijskih brojeva ispod";
    qtyBadge.textContent = String(item.selectedSerials.length);
  } else {
    countInput = document.createElement("input");
    countInput.type = "number";
    countInput.step = "1";
    countInput.min = "1";
    countInput.value = item.count;
    countInput.addEventListener("input", () => {
      item.count = countInput.value;
      updateNewOrderTotal();
    });
  }

  const removeBtn = document.createElement("button");
  removeBtn.type = "button";
  removeBtn.className = "icon-btn";
  removeBtn.textContent = "×";
  removeBtn.title = "Ukloni artikal";
  removeBtn.addEventListener("click", () => {
    state.newOrderItems = state.newOrderItems.filter((it) => it.tempId !== item.tempId);
    if (state.newOrderItems.length === 0) state.newOrderItems.push(createEmptyNewOrderItem());
    renderNewOrderItems();
  });

  row.appendChild(productSelect);
  row.appendChild(priceInput);
  row.appendChild(isDevice ? qtyBadge : countInput);
  row.appendChild(removeBtn);

  const wrapper = document.createElement("div");
  wrapper.className = "new-order-item-wrapper";
  wrapper.appendChild(row);

  // Za uređaje (ne konektore): biranje konkretnih serijskih brojeva sa
  // stanja — čekiranjem se postavlja i količina (badge iznad), nema
  // odvojenog gornjeg limita osim stvarnog stanja na lageru.
  if (isDevice) {
    // I uredjaji koji su vec dodeljeni ovoj stavci (status "shipped", oslobadja
    // ih se tek na Sacuvaj - vidi submit handler) moraju da se vide u listi kao
    // vec cekirani, ne samo ono sto je trenutno slobodno na stanju - inace bi
    // izmena postojece porudzbine prikazala prazan spisak iako je kolicina > 0.
    const available = state.deviceUnits.filter(
      (u) => u.product_id === product.id && (u.status === "in_stock" || item.selectedSerials.includes(u.id))
    );

    const pickerWrap = document.createElement("div");
    pickerWrap.className = "new-order-serial-picker";
    pickerWrap.appendChild(
      el_(
        "div", "new-order-serial-label",
        `Izaberi serijske brojeve — količina se postavlja automatski (na stanju: ${available.length})`
      )
    );

    if (available.length === 0) {
      pickerWrap.appendChild(el_("div", "section-hint", "Nema uređaja na stanju za ovaj tip"));
    } else {
      const list = document.createElement("div");
      list.className = "new-order-serial-list";
      for (const unit of available) {
        const optLabel = document.createElement("label");
        optLabel.className = "new-order-serial-option";
        const cb = document.createElement("input");
        cb.type = "checkbox";
        cb.checked = item.selectedSerials.includes(unit.id);
        cb.addEventListener("change", () => {
          if (cb.checked) {
            item.selectedSerials.push(unit.id);
          } else {
            item.selectedSerials = item.selectedSerials.filter((id) => id !== unit.id);
          }
          item.count = item.selectedSerials.length;
          qtyBadge.textContent = String(item.selectedSerials.length);
          updateNewOrderTotal();
        });
        optLabel.appendChild(cb);
        optLabel.appendChild(document.createTextNode(unit.serial_number));
        list.appendChild(optLabel);
      }
      pickerWrap.appendChild(list);
    }
    wrapper.appendChild(pickerWrap);
  }

  return wrapper;
}

function renderNewOrderItems() {
  el.newOrderItemsList.innerHTML = "";
  for (const item of state.newOrderItems) {
    el.newOrderItemsList.appendChild(buildNewOrderItemRow(item));
  }
  updateNewOrderTotal();
}

// Kad se stara (uvezena) porudžbina otvori za izmenu, njen uređaj/konektor
// (flat kolone) se prikazuju kao obični redovi artikala — ako se sačuva,
// prelaze u order_items, a flat kolone se čiste (vidi submit handler).
function legacyFieldsAsItemRows(order) {
  const rows = [];
  if (order.device_name) {
    rows.push({
      tempId: createEmptyNewOrderItem().tempId,
      productId: order.device_id || "",
      price: order.device_price ?? "",
      count: order.device_count || 1,
    });
  }
  if (order.connector_name) {
    rows.push({
      tempId: createEmptyNewOrderItem().tempId,
      productId: order.connector_id || "",
      price: order.connector_price ?? "",
      count: order.connector_count || 1,
    });
  }
  return rows;
}

const NEW_ORDER_MAIN_FIELDS = [
  ["newOrderQbInvoice", "qb_invoice_number"],
  ["newOrderWoo", "woocommerce_order_number"],
  ["newOrderShipmentType", "shipment_type"],
  ["newOrderInvoiceStatus", "invoice_status"],
  ["newOrderContactName", "contact_name"],
  ["newOrderPhone", "phone"],
  ["newOrderEmail", "email"],
  ["newOrderCustomerType", "customer_type"],
  ["newOrderSerialNumber", "serial_number"],
  ["newOrderPaperwork", "paperwork"],
  ["newOrderShippingDept", "shipping_department"],
  ["newOrderTrackingNumber", "usps_tracking_number"],
  ["newOrderEmailConfirmation", "email_confirmation"],
  ["newOrderAddress", "address"],
  ["newOrderNotes", "notes"],
];

async function openOrderForm(mode, order) {
  if (!state.companyPricesLoaded) await loadCompanyPrices();
  if (!state.productsLoaded) await loadProducts();
  if (!state.deviceUnitsLoaded) await loadDeviceUnits();

  state.orderFormMode = mode;
  state.editingOrderId = order ? order.id : null;
  el.newOrderModalTitle.textContent = mode === "edit" ? "Izmena porudžbine" : "Nova porudžbina";

  el.newOrderCompanyOptions.innerHTML = "";
  for (const c of state.companies) el.newOrderCompanyOptions.appendChild(new Option(c.name, c.name));

  if (mode === "edit" && order) {
    el.newOrderCompany.value = order.company_name || "";
    el.newOrderDate.value = order.order_date || "";
    el.newOrderShippingDate.value = order.shipping_date || "";
    el.newOrderAmount.value = order.amount !== null && order.amount !== undefined ? order.amount : "";
    for (const [elKey, field] of NEW_ORDER_MAIN_FIELDS) el[elKey].value = order[field] || "";

    const existingItems = state.orderItems.filter((it) => it.order_id === order.id);
    state.newOrderItems =
      existingItems.length > 0
        ? existingItems.map((it) => ({
            tempId: `existing-${it.id}`,
            productId: it.product_id || "",
            price: it.price,
            count: it.count,
            // uredjaji vec dodeljeni ovoj stavci (status jos "shipped" dok se
            // ne klikne Sacuvaj - release u "in_stock" desi se tek u submit-u
            // ispod) - moraju da se ucitaju kao vec cekirani, inace bi otvaranje
            // pa cuvanje bez dodira ispraznilo ovu stavku (selectedSerials.length
            // === 0 => stavka se preskace pri cuvanju, vidi submit handler).
            selectedSerials: state.deviceUnits.filter((u) => u.order_item_id === it.id).map((u) => u.id),
          }))
        : legacyFieldsAsItemRows(order);
    if (state.newOrderItems.length === 0) state.newOrderItems = [createEmptyNewOrderItem()];
  } else {
    el.newOrderCompany.value = "";
    el.newOrderDate.value = dateStr(now.getFullYear(), now.getMonth(), now.getDate());
    el.newOrderShippingDate.value = "";
    el.newOrderAmount.value = "";
    for (const [elKey] of NEW_ORDER_MAIN_FIELDS) el[elKey].value = "";
    state.newOrderItems = [createEmptyNewOrderItem()];
  }

  renderNewOrderItems();
  el.newOrderModal.hidden = false;
}

function closeNewOrderModal() {
  el.newOrderModal.hidden = true;
}

el.ordersAddBtn.addEventListener("click", () => openOrderForm("new", null));
el.cancelNewOrderBtn.addEventListener("click", closeNewOrderModal);
el.newOrderModal.addEventListener("click", (e) => {
  if (e.target === el.newOrderModal) closeNewOrderModal();
});
el.newOrderAddItemBtn.addEventListener("click", () => {
  state.newOrderItems.push(createEmptyNewOrderItem());
  renderNewOrderItems();
});

el.newOrderForm.addEventListener("submit", async (e) => {
  e.preventDefault();

  const typedName = el.newOrderCompany.value.trim();
  const company = state.companies.find((c) => c.name.trim().toLowerCase() === typedName.toLowerCase());
  if (!company) {
    showToast("Firma nije pronađena — izaberi je iz predloga dok kucaš", true);
    return;
  }

  const amount = parseFloat(el.newOrderAmount.value);
  const payload = {
    order_date: el.newOrderDate.value || null,
    company_id: company.id,
    company_name: company.name,
    amount: Number.isNaN(amount) ? null : amount,
    shipping_date: el.newOrderShippingDate.value || null,
  };
  for (const [elKey, field] of NEW_ORDER_MAIN_FIELDS) payload[field] = el[elKey].value.trim() || null;

  let orderId;
  if (state.orderFormMode === "edit") {
    orderId = state.editingOrderId;
    // artikli sad žive u order_items — očisti stare flat kolone da
    // getOrderItemLines() ubuduće čita iz order_items za ovu porudžbinu.
    payload.device_id = null;
    payload.device_name = null;
    payload.device_price = null;
    payload.device_count = null;
    payload.connector_id = null;
    payload.connector_name = null;
    payload.connector_price = null;
    payload.connector_count = null;
    payload.updated_at = new Date().toISOString();

    const { error } = await supabase.from("orders").update(payload).eq("id", orderId);
    if (error) {
      showToast("Greška pri čuvanju porudžbine: " + error.message, true);
      return;
    }

    // vrati na stanje sve uređaje koji su bili poslati na ovoj porudžbini —
    // ponovo se dodeljuju ispod, prema trenutnom izboru u formi
    const { error: releaseError } = await supabase
      .from("device_units")
      .update({ status: "in_stock", order_id: null, order_item_id: null, shipped_at: null })
      .eq("order_id", orderId);
    if (releaseError) {
      showToast("Greška pri oslobađanju starih uređaja: " + releaseError.message, true);
      return;
    }
    for (const u of state.deviceUnits) {
      if (u.order_id === orderId) {
        u.status = "in_stock";
        u.order_id = null;
        u.order_item_id = null;
      }
    }

    const { error: delError } = await supabase.from("order_items").delete().eq("order_id", orderId);
    if (delError) {
      showToast("Greška pri brisanju starih stavki: " + delError.message, true);
      return;
    }
  } else {
    payload.source = "manual";
    const { data: orderRow, error } = await supabase.from("orders").insert(payload).select().single();
    if (error) {
      showToast("Greška pri čuvanju porudžbine: " + error.message, true);
      return;
    }
    orderId = orderRow.id;

    // Nova porudžbina automatski otvara i stavku u Naplati — naplaćeno
    // kreće kao "Ne", način naplate ostaje prazan da se ručno podesi.
    if (orderRow.company_id && orderRow.amount !== null && orderRow.amount !== undefined) {
      const { error: naplataError } = await supabase.from("naplata").insert({
        company_id: orderRow.company_id,
        company_name: orderRow.company_name,
        invoice_date: orderRow.order_date || dateStr(now.getFullYear(), now.getMonth(), now.getDate()),
        invoice_number: orderRow.qb_invoice_number || null,
        cycle: "current",
        amount: orderRow.amount,
        payment_method: null,
        collected: false,
        collection_date: null,
        comment: orderRow.woocommerce_order_number ? `Iz porudžbine (Woo #${orderRow.woocommerce_order_number})` : "Iz porudžbine",
        source: "manual",
      });
      if (naplataError) {
        showToast("Porudžbina sačuvana, ali greška pri upisu u Naplatu: " + naplataError.message, true);
      } else {
        state.naplataLoaded = false; // sledeća poseta Naplata stranici učitaće svež spisak
      }
    }
  }

  const validItems = state.newOrderItems.filter(
    (it) => it.productId && it.price !== "" && !Number.isNaN(parseFloat(it.price))
  );

  let skippedDeviceCount = 0;

  for (const it of validItems) {
    const product = state.products.find((p) => p.id === it.productId);
    const isDevice = product && product.type === "device";

    // Uređaj bez izabranog serijskog broja nema šta da se pošalje — bez ove
    // provere bi se upisala fantomska stavka "1x" (parseFloat(it.count)||1
    // ispod bi tiho pretvorio 0 u 1) bez ijednog stvarno poslatog uređaja.
    if (isDevice && (!it.selectedSerials || it.selectedSerials.length === 0)) {
      skippedDeviceCount++;
      continue;
    }

    const count = isDevice ? it.selectedSerials.length : parseFloat(it.count) || 1;

    const { data: itemRow, error: itemError } = await supabase
      .from("order_items")
      .insert({
        order_id: orderId,
        product_id: it.productId,
        product_name: product ? product.name : "?",
        price: parseFloat(it.price),
        count,
      })
      .select()
      .single();
    if (itemError) {
      showToast("Greška pri stavci: " + itemError.message, true);
      continue;
    }

    if (product && product.type === "device" && it.selectedSerials && it.selectedSerials.length > 0) {
      for (const unitId of it.selectedSerials) {
        const { error: unitError } = await supabase
          .from("device_units")
          .update({ status: "shipped", order_id: orderId, order_item_id: itemRow.id, shipped_at: new Date().toISOString() })
          .eq("id", unitId);
        if (!unitError) {
          const u = state.deviceUnits.find((x) => x.id === unitId);
          if (u) {
            u.status = "shipped";
            u.order_id = orderId;
            u.order_item_id = itemRow.id;
          }
        }
      }
    } else if (product && product.type === "connector") {
      const newQty = Math.max(0, (product.stock_quantity || 0) - count);
      const { error: qtyError } = await supabase.from("products").update({ stock_quantity: newQty }).eq("id", product.id);
      if (!qtyError) product.stock_quantity = newQty;
    }
  }

  closeNewOrderModal();
  await Promise.all([loadOrders(), loadOrderItems()]);
  renderOrders();
  showToast(
    skippedDeviceCount > 0
      ? `Porudžbina sačuvana (preskočeno ${skippedDeviceCount} stavki uređaja bez izabranog serijskog broja)`
      : "Porudžbina sačuvana"
  );
});

// ---------- porudžbine: jednokratni uvoz istorije iz Orders.xlsx ----------

function strOrNull(raw) {
  if (raw === null || raw === undefined) return null;
  const s = String(raw).trim();
  return s ? s : null;
}

// Orders.xlsx koristi redove kao "May 2023" / "Novembar 2023" kao vizuelne
// razdelnike meseci unutar tabele, i povremeno ponovi header red ("Name")
// usred podataka — ovo nisu firme, treba ih preskočiti pri uvozu.
const MONTH_NAME_ROW = new RegExp(
  "^(January|February|March|April|May|June|July|August|September|October|November|December|" +
    "Januar|Februar|Mart|April|Maj|Jun|Jul|Avgust|Septembar|Oktobar|Novembar|Decembar)\\s+\\d{4}$",
  "i"
);
const JUNK_NAME_VALUES = new Set(["name", "subitems", "orders"]);

function looksLikeJunkOrderName(name) {
  const s = name.trim();
  if (JUNK_NAME_VALUES.has(s.toLowerCase())) return true;
  if (MONTH_NAME_ROW.test(s)) return true;
  return false;
}

// prirodni ključ za sprečavanje duplikata pri ponovnom uvozu
function ordersDedupeKey(companyName, orderDate, amount, qbInvoice) {
  const namePart = (companyName || "").trim().toLowerCase();
  const invPart = qbInvoice ? `inv:${String(qbInvoice).trim().toLowerCase()}` : `amt:${Number(amount || 0).toFixed(2)}`;
  return `${namePart}|${orderDate || ""}|${invPart}`;
}

el.ordersImportBtn.addEventListener("click", () => el.ordersImportFile.click());

el.ordersImportFile.addEventListener("change", async () => {
  const file = el.ordersImportFile.files[0];
  el.ordersImportFile.value = "";
  if (!file) return;
  try {
    await importOrdersHistoryFile(file);
  } catch (err) {
    console.error(err);
    showToast("Greška pri uvozu porudžbina: " + err.message, true);
  }
});

async function importOrdersHistoryFile(file) {
  if (!state.ordersLoaded) await loadOrders();
  if (!state.productsLoaded) await loadProducts();

  const buffer = await file.arrayBuffer();
  const workbook = XLSX.read(buffer, { type: "array", cellDates: true });

  const companiesByName = new Map(state.companies.map((c) => [c.name.trim().toLowerCase(), c]));
  const productByKey = new Map(state.products.map((p) => [`${p.type}:${p.name}`, p]));
  const existingKeys = new Set(
    state.orders.map((o) => ordersDedupeKey(o.company_name, o.order_date, o.amount, o.qb_invoice_number))
  );

  const toInsert = [];
  let skippedDuplicate = 0;
  let skippedInvalid = 0;

  for (const sheetName of workbook.SheetNames) {
    const layout = detectOrdersSheetLayout(workbook.Sheets[sheetName]);
    if (!layout) continue;
    const { headerRow, dataRows } = layout;

    const nameCol = findCol(headerRow, "Name");
    const contactCol = findCol(headerRow, "First and last name");
    const phoneCol = findCol(headerRow, "Phone");
    const emailCol = findCol(headerRow, "Email");
    const customerTypeCol = findCol(headerRow, "Customer type");
    const dateCol = findCol(headerRow, "Date of order");
    const dPriceCol = findCol(headerRow, "Device price");
    const deviceCountCol = findCol(headerRow, "Count", dPriceCol);
    const deviceCol = findCol(headerRow, "Device");
    const serialCol = findCol(headerRow, "Serial number");
    const cPriceCol = findCol(headerRow, "Connector price");
    const connectorCountCol = findCol(headerRow, "Count", cPriceCol);
    const connCol = findCol(headerRow, "Connector");
    const paperworkCol = findCol(headerRow, "Paperwork");
    const shipmentTypeCol = findCol(headerRow, "Shipment type");
    const wooCol = findCol(headerRow, "Order # woo commerce");
    const amountCol = findCol(headerRow, "Amount");
    const qbInvoiceCol = findCol(headerRow, "Invoice # Quckbook");
    const invoiceStatusCol = findCol(headerRow, "Invoice status");
    const addressCol = findCol(headerRow, "Address");
    const notesCol = findCol(headerRow, "Notes");
    const shippingDeptCol = findCol(headerRow, "Shipping department");
    const trackingCol = findCol(headerRow, "USPS tracking number");
    const shippingDateCol = findCol(headerRow, "Shipping date");
    const emailConfirmCol = findCol(headerRow, "Email confirmation");

    for (const row of dataRows) {
      const rawName = row[nameCol];
      if (typeof rawName !== "string" || !rawName.trim()) continue;
      const companyName = rawName.trim();
      if (looksLikeJunkOrderName(companyName)) continue;

      const dateRaw = row[dateCol];
      const orderDate = dateRaw instanceof Date ? excelDateToStr(dateRaw) : null;
      const amount = parsePrice(row[amountCol]);
      const qbInvoice = strOrNull(row[qbInvoiceCol]);

      const key = ordersDedupeKey(companyName, orderDate, amount, qbInvoice);
      if (existingKeys.has(key)) {
        skippedDuplicate++;
        continue;
      }
      existingKeys.add(key);

      const company = companiesByName.get(companyName.toLowerCase());
      const deviceRaw = row[deviceCol];
      const deviceNorm = normalizeDeviceSingle(deviceRaw);
      const deviceProduct = deviceNorm ? productByKey.get(`device:${deviceNorm}`) : null;
      const connectorRaw = row[connCol];
      const connectorNorm = normalizeConnectorSingle(connectorRaw);
      const connectorProduct = connectorNorm ? productByKey.get(`connector:${connectorNorm}`) : null;
      const shippingDateRaw = row[shippingDateCol];

      toInsert.push({
        order_date: orderDate,
        qb_invoice_number: qbInvoice,
        woocommerce_order_number: strOrNull(row[wooCol]),
        company_id: company ? company.id : null,
        company_name: companyName,
        device_id: deviceProduct ? deviceProduct.id : null,
        device_name: strOrNull(deviceRaw),
        device_price: parsePrice(row[dPriceCol]),
        device_count: parsePrice(row[deviceCountCol]),
        connector_id: connectorProduct ? connectorProduct.id : null,
        connector_name: strOrNull(connectorRaw),
        connector_price: parsePrice(row[cPriceCol]),
        connector_count: parsePrice(row[connectorCountCol]),
        amount,
        shipment_type: strOrNull(row[shipmentTypeCol]),
        invoice_status: strOrNull(row[invoiceStatusCol]),
        contact_name: strOrNull(row[contactCol]),
        phone: strOrNull(row[phoneCol]),
        email: strOrNull(row[emailCol]),
        customer_type: strOrNull(row[customerTypeCol]),
        serial_number: strOrNull(row[serialCol]),
        paperwork: strOrNull(row[paperworkCol]),
        address: strOrNull(row[addressCol]),
        notes: strOrNull(row[notesCol]),
        shipping_department: strOrNull(row[shippingDeptCol]),
        usps_tracking_number: strOrNull(row[trackingCol]),
        shipping_date: shippingDateRaw instanceof Date ? excelDateToStr(shippingDateRaw) : null,
        email_confirmation: strOrNull(row[emailConfirmCol]),
        source: "import",
        source_sheet: sheetName,
      });

      if (!orderDate && amount === null) skippedInvalid++;
    }
  }

  const batchSize = 200;
  let imported = 0;
  for (let i = 0; i < toInsert.length; i += batchSize) {
    const batch = toInsert.slice(i, i + batchSize);
    const { error } = await supabase.from("orders").insert(batch);
    if (error) {
      console.error(error);
      showToast("Greška pri uvozu (deo podataka): " + error.message, true);
      continue;
    }
    imported += batch.length;
  }

  await loadOrders();
  renderOrders();
  showToast(
    `Uvezeno: ${imported} porudžbina, preskočeno ${skippedDuplicate} duplikata${skippedInvalid ? `, ${skippedInvalid} bez datuma/iznosa` : ""}`
  );
}

// ---------- podešavanja: proizvodi (uređaji i konektori, bez cena) ----------

async function loadProducts() {
  const { data, error } = await supabase
    .from("products")
    .select("*")
    .order("name", { ascending: true });
  if (error) {
    showToast("Greška pri učitavanju proizvoda: " + error.message, true);
    return;
  }
  state.products = data ?? [];
  state.productsLoaded = true;
}

function renderSettingsProducts() {
  const items = state.products
    .slice()
    .sort((a, b) => a.type.localeCompare(b.type) || a.name.localeCompare(b.name));
  el.settingsProductList.innerHTML = "";
  if (items.length === 0) {
    el.settingsProductList.appendChild(el_("li", "empty", "Nema stavki"));
    return;
  }
  for (const item of items) {
    const li = document.createElement("li");
    const left = el_("span", "settings-product-row-main");
    left.appendChild(
      el_("span", `badge ${item.type === "device" ? "badge-current" : "badge-neutral"}`, item.type === "device" ? "Uređaj" : "Konektor")
    );
    left.appendChild(el_("span", null, item.name));
    li.appendChild(left);
    const delBtn = el_("button", "icon-btn", "×");
    delBtn.type = "button";
    delBtn.title = "Obriši";
    delBtn.addEventListener("click", () => deleteProduct(item.id));
    li.appendChild(delBtn);
    el.settingsProductList.appendChild(li);
  }
}

async function addProduct(type, name) {
  const { data, error } = await supabase.from("products").insert({ type, name }).select().single();
  if (error) {
    showToast("Greška pri dodavanju: " + error.message, true);
    return;
  }
  state.products.push(data);
  renderSettingsProducts();
  showToast("Dodato");
}

async function deleteProduct(id) {
  const { error } = await supabase.from("products").delete().eq("id", id);
  if (error) {
    showToast("Greška: " + error.message, true);
    return;
  }
  state.products = state.products.filter((p) => p.id !== id);
  renderSettingsProducts();
  showToast("Obrisano");
}

el.settingsProductForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const name = el.settingsProductInput.value.trim();
  if (!name) return;
  await addProduct(el.settingsProductGroup.value, name);
  el.settingsProductInput.value = "";
});

// ---------- podešavanja: kompanije (ovlašćeno lice, adresa, cena po proizvodu) ----------

async function loadCompanyPrices() {
  const pageSize = 1000;
  const all = [];
  let from = 0;
  while (true) {
    const { data, error } = await supabase
      .from("company_product_prices")
      .select("*")
      .order("id", { ascending: true })
      .range(from, from + pageSize - 1);
    if (error) {
      showToast("Greška pri učitavanju cena: " + error.message, true);
      break;
    }
    all.push(...(data ?? []));
    if (!data || data.length < pageSize) break;
    from += pageSize;
  }
  state.companyPrices = all;
  state.companyPricesLoaded = true;
}

function companyPriceKey(companyId, productId) {
  return `${companyId}:${productId}`;
}

function buildEditableTextCell(company, field) {
  const td = document.createElement("td");
  const input = document.createElement("input");
  input.type = "text";
  input.className = "settings-inline-input";
  input.value = company[field] || "";
  input.disabled = !canEdit("settings");
  input.addEventListener("change", async () => {
    const value = input.value.trim() || null;
    const { error } = await supabase.from("companies").update({ [field]: value }).eq("id", company.id);
    if (error) {
      showToast("Greška: " + error.message, true);
      return;
    }
    company[field] = value;
    showToast("Sačuvano");
  });
  td.appendChild(input);
  return td;
}

function buildEditablePriceCell(companyId, productId, existingRow) {
  const td = document.createElement("td");
  const input = document.createElement("input");
  input.type = "number";
  input.step = "0.01";
  input.min = "0";
  input.className = "settings-inline-input settings-price-input";
  input.placeholder = "—";
  if (existingRow) input.value = existingRow.price;
  input.disabled = !canEdit("settings");

  input.addEventListener("change", async () => {
    const raw = input.value.trim();

    if (raw === "") {
      if (existingRow) {
        const { error } = await supabase.from("company_product_prices").delete().eq("id", existingRow.id);
        if (error) {
          showToast("Greška: " + error.message, true);
          return;
        }
        state.companyPrices = state.companyPrices.filter((cp) => cp.id !== existingRow.id);
        showToast("Obrisano");
      }
      return;
    }

    const price = parseFloat(raw);
    if (Number.isNaN(price) || price < 0) {
      showToast("Cena mora biti pozitivan broj", true);
      return;
    }

    const { data, error } = await supabase
      .from("company_product_prices")
      .upsert(
        { company_id: companyId, product_id: productId, price, updated_at: new Date().toISOString() },
        { onConflict: "company_id,product_id" }
      )
      .select()
      .single();
    if (error) {
      showToast("Greška: " + error.message, true);
      return;
    }
    const idx = state.companyPrices.findIndex((cp) => cp.company_id === companyId && cp.product_id === productId);
    if (idx >= 0) state.companyPrices[idx] = data;
    else state.companyPrices.push(data);
    showToast("Sačuvano");
  });

  td.appendChild(input);
  return td;
}

function renderSettingsCompanies() {
  const priceMap = new Map(state.companyPrices.map((cp) => [companyPriceKey(cp.company_id, cp.product_id), cp]));
  const devices = state.products.filter((p) => p.type === "device").sort((a, b) => a.name.localeCompare(b.name));
  const connectors = state.products.filter((p) => p.type === "connector").sort((a, b) => a.name.localeCompare(b.name));
  const productCols = [...devices, ...connectors];

  el.settingsCompaniesHeadRow.innerHTML = "";
  for (const h of ["Naziv", "Ovlašćeno lice", "Adresa", "Email"]) {
    el.settingsCompaniesHeadRow.appendChild(el_("th", null, h));
  }
  for (const p of productCols) {
    el.settingsCompaniesHeadRow.appendChild(el_("th", null, p.name));
  }

  const query = state.settingsCompanySearch.trim().toLowerCase();
  const rows = state.companies
    .filter((c) => !query || c.name.toLowerCase().includes(query))
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name));

  el.settingsCompaniesBody.innerHTML = "";
  for (const company of rows) {
    const tr = document.createElement("tr");
    tr.appendChild(el_("td", "settings-company-name-cell", company.name));
    tr.appendChild(buildEditableTextCell(company, "contact_name"));
    tr.appendChild(buildEditableTextCell(company, "address"));
    tr.appendChild(buildEditableTextCell(company, "email"));
    for (const p of productCols) {
      tr.appendChild(buildEditablePriceCell(company.id, p.id, priceMap.get(companyPriceKey(company.id, p.id))));
    }
    el.settingsCompaniesBody.appendChild(tr);
  }
}

el.settingsCompanySearch.addEventListener("input", () => {
  state.settingsCompanySearch = el.settingsCompanySearch.value;
  renderSettingsCompanies();
});

// ---------- podešavanja: kompanije cene (istorijski cenovnik, samo za referencu) ----------
// Ova tabela se nikad ne menja ručno u svojoj stranici — puni se uvozom iz
// Billing count control.xlsx i automatski prati izmene companies.price
// napravljene kroz modal za izmenu firme u Pregled kamiona (vidi companyForm
// submit handler niže).

// Normalizuje ime firme za poklapanje: skida prateću "(...)" napomenu,
// trim, lowercase, kolapsuje razmake. Koristi ga i uvoz i matching kod nove
// firme sa ELD API-ja, da oba mesta primenjuju isto pravilo.
function normalizeCompanyNameKey(name) {
  return String(name || "")
    .replace(/\s*\([^)]*\)\s*$/, "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function cleanCompanyDisplayName(name) {
  return String(name || "")
    .replace(/\s*\([^)]*\)\s*$/, "")
    .trim()
    .replace(/\s+/g, " ");
}

async function loadCompanyPriceLookup() {
  const pageSize = 1000;
  const all = [];
  let from = 0;
  while (true) {
    const { data, error } = await supabase
      .from("company_price_lookup")
      .select("*")
      .order("id", { ascending: true })
      .range(from, from + pageSize - 1);
    if (error) {
      showToast("Greška pri učitavanju cenovnika: " + error.message, true);
      break;
    }
    all.push(...(data ?? []));
    if (!data || data.length < pageSize) break;
    from += pageSize;
  }
  state.companyPriceLookup = all;
  state.companyPriceLookupLoaded = true;
}

function upsertCompanyPriceLookupLocal(row) {
  const idx = state.companyPriceLookup.findIndex((r) => r.name_key === row.name_key);
  if (idx >= 0) state.companyPriceLookup[idx] = row;
  else state.companyPriceLookup.push(row);
}

// Piše u company_price_lookup kad se cena firme promeni kroz Pregled kamiona
// (companyForm submit handler) — jedini put pisanja u ovu tabelu van uvoza.
async function syncCompanyPriceLookup(name, price) {
  if (price === null || price === undefined) return;
  const nameKey = normalizeCompanyNameKey(name);
  if (!nameKey) return;
  const { data, error } = await supabase
    .from("company_price_lookup")
    .upsert(
      {
        name_key: nameKey,
        display_name: cleanCompanyDisplayName(name),
        price,
        source: "company_edit",
        updated_at: new Date().toISOString(),
      },
      { onConflict: "name_key" }
    )
    .select()
    .single();
  if (error) {
    console.error("syncCompanyPriceLookup failed", error);
    return;
  }
  upsertCompanyPriceLookupLocal(data);
  if (!el.settingsSectionCompanyPrices.hidden) renderSettingsCompanyPrices();
}

function renderSettingsCompanyPrices() {
  const query = state.settingsCompanyPriceSearch.trim().toLowerCase();
  const rows = state.companyPriceLookup
    .filter((r) => !query || r.display_name.toLowerCase().includes(query))
    .slice()
    .sort((a, b) => a.display_name.localeCompare(b.display_name));

  el.settingsCompanyPricesBody.innerHTML = "";
  if (rows.length === 0) {
    const tr = document.createElement("tr");
    const td = el_("td", null, "Nema podataka — uvezi Billing count control.xlsx");
    td.colSpan = 3;
    td.style.textAlign = "center";
    td.style.color = "var(--muted)";
    tr.appendChild(td);
    el.settingsCompanyPricesBody.appendChild(tr);
    return;
  }
  for (const row of rows) {
    const tr = document.createElement("tr");
    tr.appendChild(el_("td", "settings-company-name-cell", row.display_name));
    tr.appendChild(el_("td", null, row.price));
    tr.appendChild(el_("td", null, row.updated_at ? row.updated_at.slice(0, 10) : ""));
    el.settingsCompanyPricesBody.appendChild(tr);
  }
}

el.settingsCompanyPriceSearch.addEventListener("input", () => {
  state.settingsCompanyPriceSearch = el.settingsCompanyPriceSearch.value;
  renderSettingsCompanyPrices();
});

// ---------- kompanije: uvoz ovlašćenog lica / adrese / cena iz Orders.xlsx ----------
// Samo tačna poklapanja imena firme (case-insensitive) se povezuju — Orders.xlsx
// ima 215 naziva, od kojih se samo ~63 tačno poklapaju sa postojećim firmama
// (ostalo su ili đubre-redovi pokupljeni greškom kao "ime firme", ili firme sa
// malo drugačijim imenom). Radije preskoči nego pogodi pogrešnu firmu — cena je
// novac. Za svaki uređaj/konektor uzima se POSLEDNJA (najnovija po datumu
// porudžbine) cena; kombinovani redovi konektora ("3x16PIN, 7x9PIN") se
// preskaču jer se ne može sa sigurnošću odrediti cena po pojedinačnom tipu.

function detectOrdersSheetLayout(sheet) {
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: true, defval: "" });
  for (let r = 0; r < Math.min(rows.length, 10); r++) {
    const row = rows[r];
    if (row.includes("Device") && row.includes("Name") && row.includes("Connector")) {
      return { headerRow: row, dataRows: rows.slice(r + 1) };
    }
  }
  return null;
}

// "Count" appears twice in Orders.xlsx (once for Device, once for Connector) —
// searching from an anchor column (e.g. right after "Device price") picks the
// correct one instead of always resolving to the first "Count" in the sheet.
function findCol(headerRow, label, afterIdx = -1) {
  for (let i = afterIdx + 1; i < headerRow.length; i++) {
    if (headerRow[i] === label) return i;
  }
  return -1;
}

function normalizeDeviceSingle(raw) {
  if (raw === null || raw === undefined || raw === "") return null;
  const s = String(raw).trim().toUpperCase().replace(/\s+/g, "");
  if (s === "PT30") return "PT30";
  if (s === "PT40") return "PT40";
  return null; // combos ("PT30 + PT40"), notes ("PT30, SIM card"), "/" -> skip
}

function normalizeConnectorSingle(raw) {
  if (raw === null || raw === undefined || raw === "") return null;
  let s = String(raw).trim();
  if (/[,;/]/.test(s)) return null; // combo of multiple connectors -> skip
  s = s.replace(/^\d+\s*[xX]\s*/, "").trim(); // strip leading qty like "3x", "1X "
  const upper = s.toUpperCase().replace(/\s+/g, " ").trim();
  const pinMatch = upper.match(/(\d+)\s*PIN/);
  if (!pinMatch) return null;
  const pin = pinMatch[1];
  if (/HEAVY\s*DUTY|\bHD\b/.test(upper)) return `${pin}PIN HD`;
  if (/LIGHT\s*DUTY|\bLD\b/.test(upper)) return `${pin}PIN LD`;
  if (upper === `${pin}PIN`) return `${pin}PIN`;
  return null; // anything with extra notes attached -> skip, too ambiguous
}

function parsePrice(raw) {
  if (raw === null || raw === undefined || raw === "") return null;
  if (typeof raw === "number") return raw;
  const cleaned = String(raw).replace(/[^0-9.]/g, "");
  if (!cleaned) return null;
  const num = parseFloat(cleaned);
  return Number.isNaN(num) ? null : num;
}

// true if `candidateDate` should replace `currentDate` as the "most recent" pick
function isNewerDate(currentDate, candidateDate) {
  if (!currentDate) return true;
  if (!candidateDate) return false;
  return candidateDate.getTime() > currentDate.getTime();
}

el.settingsCompanyImportBtn.addEventListener("click", () => el.settingsCompanyImportFile.click());

el.settingsCompanyImportFile.addEventListener("change", async () => {
  const file = el.settingsCompanyImportFile.files[0];
  el.settingsCompanyImportFile.value = "";
  if (!file) return;
  try {
    await importCompanyPricingFile(file);
  } catch (err) {
    console.error(err);
    showToast("Greška pri uvozu: " + err.message, true);
  }
});

async function importCompanyPricingFile(file) {
  if (!state.productsLoaded) await loadProducts();
  if (!state.companyPricesLoaded) await loadCompanyPrices();

  const buffer = await file.arrayBuffer();
  const workbook = XLSX.read(buffer, { type: "array", cellDates: true });

  const companiesByName = new Map(state.companies.map((c) => [c.name.trim().toLowerCase(), c]));
  const productByKey = new Map(state.products.map((p) => [`${p.type}:${p.name}`, p]));

  // company_id -> { contactName, contactDate, address, addressDate, prices: Map(productKey -> {price, date}) }
  const profiles = new Map();
  const getProfile = (companyId) => {
    if (!profiles.has(companyId)) {
      profiles.set(companyId, { contactName: null, contactDate: null, address: null, addressDate: null, prices: new Map() });
    }
    return profiles.get(companyId);
  };

  for (const sheetName of workbook.SheetNames) {
    const layout = detectOrdersSheetLayout(workbook.Sheets[sheetName]);
    if (!layout) continue;
    const { headerRow, dataRows } = layout;
    const nameCol = findCol(headerRow, "Name");
    const contactCol = findCol(headerRow, "First and last name");
    const addressCol = findCol(headerRow, "Address");
    const dateCol = findCol(headerRow, "Date of order");
    const dPriceCol = findCol(headerRow, "Device price");
    const deviceCol = findCol(headerRow, "Device");
    const cPriceCol = findCol(headerRow, "Connector price");
    const connCol = findCol(headerRow, "Connector");

    for (const row of dataRows) {
      const rawName = nameCol >= 0 ? row[nameCol] : "";
      if (typeof rawName !== "string") continue;
      const company = companiesByName.get(rawName.trim().toLowerCase());
      if (!company) continue;

      const profile = getProfile(company.id);
      const rowDate = row[dateCol] instanceof Date ? row[dateCol] : null;

      const contact = contactCol !== undefined ? row[contactCol] : "";
      if (typeof contact === "string" && contact.trim() && isNewerDate(profile.contactDate, rowDate)) {
        profile.contactName = contact.trim();
        profile.contactDate = rowDate;
      }

      const address = addressCol !== undefined ? row[addressCol] : "";
      if (typeof address === "string" && address.trim() && isNewerDate(profile.addressDate, rowDate)) {
        profile.address = address.trim();
        profile.addressDate = rowDate;
      }

      const device = normalizeDeviceSingle(row[deviceCol]);
      const dPrice = parsePrice(row[dPriceCol]);
      if (device && dPrice !== null) {
        const key = `device:${device}`;
        const entry = profile.prices.get(key);
        if (!entry || isNewerDate(entry.date, rowDate)) {
          profile.prices.set(key, { price: dPrice, date: rowDate });
        }
      }

      const connector = normalizeConnectorSingle(row[connCol]);
      const cPrice = parsePrice(row[cPriceCol]);
      if (connector && cPrice !== null) {
        const key = `connector:${connector}`;
        const entry = profile.prices.get(key);
        if (!entry || isNewerDate(entry.date, rowDate)) {
          profile.prices.set(key, { price: cPrice, date: rowDate });
        }
      }
    }
  }

  let companiesUpdated = 0;
  let pricesWritten = 0;
  for (const [companyId, profile] of profiles) {
    const patch = {};
    if (profile.contactName) patch.contact_name = profile.contactName;
    if (profile.address) patch.address = profile.address;
    if (Object.keys(patch).length > 0) {
      const { error } = await supabase.from("companies").update(patch).eq("id", companyId);
      if (!error) {
        companiesUpdated++;
        const c = state.companies.find((x) => x.id === companyId);
        if (c) Object.assign(c, patch);
      }
    }

    for (const [key, entry] of profile.prices) {
      const product = productByKey.get(key);
      if (!product) continue;
      const { data, error } = await supabase
        .from("company_product_prices")
        .upsert(
          { company_id: companyId, product_id: product.id, price: entry.price, updated_at: new Date().toISOString() },
          { onConflict: "company_id,product_id" }
        )
        .select()
        .single();
      if (!error) {
        pricesWritten++;
        const idx = state.companyPrices.findIndex((cp) => cp.company_id === companyId && cp.product_id === product.id);
        if (idx >= 0) state.companyPrices[idx] = data;
        else state.companyPrices.push(data);
      }
    }
  }

  renderSettingsCompanies();
  showToast(
    `Uvoz gotov: ${profiles.size} firmi povezano (tačno poklapanje imena), ${companiesUpdated} ažurirano (lice/adresa), ${pricesWritten} cena upisano/ažurirano`
  );
}

// ---------- kompanije cene: uvoz istorijskog cenovnika iz Billing count control.xlsx ----------
// Svaki mesečni tab (Januar → Avgust) ima "Companies" u A1 kao marker layouta
// (sheet_to_json header:1, red 1 = header, red 2 = pod-header T/S/B/A, podaci
// od reda 3). Kolona A = ime firme, kolona C ("§") = mesečna cena. Tabovi se
// obrađuju po redosledu u fajlu (hronološki), poslednji nađeni sheet za dato
// ime pobeđuje — tako se dobija trenutna (najnovija) cena čak i kad se cena
// menjala tokom godine.

function isBillingSheet(rows) {
  return rows.length > 0 && String(rows[0]?.[0] || "").trim() === "Companies";
}

async function importCompanyPriceLookupFromBilling(file) {
  if (!state.companyPriceLookupLoaded) await loadCompanyPriceLookup();

  const buffer = await file.arrayBuffer();
  const workbook = XLSX.read(buffer, { type: "array" });

  const found = new Map(); // name_key -> { name_key, display_name, price }

  for (const sheetName of workbook.SheetNames) {
    const rows = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { header: 1, raw: true, defval: "" });
    if (!isBillingSheet(rows)) continue;

    for (const row of rows.slice(2)) {
      const rawName = row[0];
      if (typeof rawName !== "string" || !rawName.trim()) continue;
      const price = parsePrice(row[2]);
      if (price === null) continue;

      const nameKey = normalizeCompanyNameKey(rawName);
      if (!nameKey) continue;
      found.set(nameKey, { name_key: nameKey, display_name: cleanCompanyDisplayName(rawName), price });
    }
  }

  if (found.size === 0) {
    showToast("Nijedna firma nije prepoznata u fajlu", true);
    return;
  }

  const now = new Date().toISOString();
  const rowsToUpsert = Array.from(found.values()).map((r) => ({ ...r, source: "billing_import", updated_at: now }));

  const { data, error } = await supabase
    .from("company_price_lookup")
    .upsert(rowsToUpsert, { onConflict: "name_key" })
    .select();

  if (error) {
    showToast("Greška pri uvozu: " + error.message, true);
    return;
  }

  for (const row of data ?? []) upsertCompanyPriceLookupLocal(row);
  renderSettingsCompanyPrices();
  showToast(`Uvoz gotov: ${data?.length ?? 0} firmi u cenovniku`);
}

el.settingsCompanyPriceImportBtn.addEventListener("click", () => el.settingsCompanyPriceImportFile.click());

el.settingsCompanyPriceImportFile.addEventListener("change", async () => {
  const file = el.settingsCompanyPriceImportFile.files[0];
  el.settingsCompanyPriceImportFile.value = "";
  if (!file) return;
  try {
    await importCompanyPriceLookupFromBilling(file);
  } catch (err) {
    console.error(err);
    showToast("Greška pri uvozu: " + err.message, true);
  }
});

function showSettingsSection(section) {
  el.settingsSectionProducts.hidden = section !== "products";
  el.settingsSectionCompanies.hidden = section !== "companies";
  el.settingsSectionCompanyPrices.hidden = section !== "companyPrices";
  el.settingsSectionRoles.hidden = section !== "roles";
  el.settingsSectionUsers.hidden = section !== "users";
  el.settingsMenuProducts.classList.toggle("is-active", section === "products");
  el.settingsMenuCompanies.classList.toggle("is-active", section === "companies");
  el.settingsMenuCompanyPrices.classList.toggle("is-active", section === "companyPrices");
  el.settingsMenuRoles.classList.toggle("is-active", section === "roles");
  el.settingsMenuUsers.classList.toggle("is-active", section === "users");
  if (section === "roles" && !state.rolesLoaded) {
    loadRoles().then(renderRoles);
  }
  if (section === "users") {
    Promise.all([state.rolesLoaded ? Promise.resolve() : loadRoles(), loadUsers()]).then(() => {
      renderUsers();
    });
  }
  if (section === "companies") {
    // Uvek re-renderuj (state.products/companyPrices su već u memoriji ako su
    // ranije učitani) - samo fetch treba da se preskoči kad je već svež, inače
    // novododat proizvod iz Podešavanja > Proizvodi ne bi odmah dobio svoju
    // kolonu ovde bez punog reload-a stranice.
    const need = [];
    if (!state.productsLoaded) need.push(loadProducts());
    if (!state.companyPricesLoaded) need.push(loadCompanyPrices());
    Promise.all(need).then(renderSettingsCompanies);
  }
  if (section === "companyPrices") {
    // companyPriceLookup se često već učita ranije (checkForNewCompanies pri
    // startu aplikacije, radi popune cene u "Nova firma" modalu) — pre nego
    // što korisnik uopšte otvori ovaj tab. Bez ovog else grane, render se
    // nikad ne bi pozvao pri otvaranju taba i tabela bi ostala prazna.
    if (!state.companyPriceLookupLoaded) {
      loadCompanyPriceLookup().then(renderSettingsCompanyPrices);
    } else {
      renderSettingsCompanyPrices();
    }
  }
}

el.settingsMenuProducts.addEventListener("click", () => showSettingsSection("products"));
el.settingsMenuCompanies.addEventListener("click", () => showSettingsSection("companies"));
el.settingsMenuCompanyPrices.addEventListener("click", () => showSettingsSection("companyPrices"));
el.settingsMenuRoles.addEventListener("click", () => showSettingsSection("roles"));
el.settingsMenuUsers.addEventListener("click", () => showSettingsSection("users"));

// ---------- stanje uređaja (serijski brojevi) i konektora (broj) — posebna stranica ----------

async function loadDeviceUnits() {
  const pageSize = 1000;
  const all = [];
  let from = 0;
  while (true) {
    const { data, error } = await supabase
      .from("device_units")
      .select("*")
      .order("created_at", { ascending: false })
      .range(from, from + pageSize - 1);
    if (error) {
      showToast("Greška pri učitavanju stanja uređaja: " + error.message, true);
      break;
    }
    all.push(...(data ?? []));
    if (!data || data.length < pageSize) break;
    from += pageSize;
  }
  state.deviceUnits = all;
  state.deviceUnitsLoaded = true;
}

// Select u "+ Dodaj" modalu obuhvata i uređaje i konektore (grupisano), da se
// sa jednog mesta dodaje bilo šta na stanje — vidi syncStockModalProductType.
function populateStockProductSelect(selectEl) {
  const prev = selectEl.value;
  selectEl.innerHTML = "";
  const devices = state.products.filter((p) => p.type === "device");
  const connectors = state.products.filter((p) => p.type === "connector");

  if (devices.length) {
    const group = document.createElement("optgroup");
    group.label = "Uređaji";
    for (const p of devices) {
      const opt = document.createElement("option");
      opt.value = p.id;
      opt.textContent = p.name;
      opt.dataset.type = "device";
      group.appendChild(opt);
    }
    selectEl.appendChild(group);
  }
  if (connectors.length) {
    const group = document.createElement("optgroup");
    group.label = "Konektori";
    for (const p of connectors) {
      const opt = document.createElement("option");
      opt.value = p.id;
      opt.textContent = p.name;
      opt.dataset.type = "connector";
      group.appendChild(opt);
    }
    selectEl.appendChild(group);
  }
  if (prev) selectEl.value = prev;
}

// Jedna sekcija po tipu uređaja (PT30, PT40, ...), jedna ispod druge, svaka
// sa svojim brojem na stanju. Spisak serijskih brojeva je podrazumevano
// skupljen (samo naziv + broj na stanju) - klik na header ga otvara/zatvara,
// da lista ne bude beskonačna kad ima puno uređaja na stanju.
function renderStockDevices() {
  populateStockProductSelect(el.stockDeviceProduct);

  const devices = state.products.filter((p) => p.type === "device");
  el.stockDeviceSections.innerHTML = "";

  for (const p of devices) {
    const units = state.deviceUnits
      .filter((u) => u.product_id === p.id)
      .slice()
      .sort((a, b) => (b.created_at || "").localeCompare(a.created_at || ""));
    const inStock = units.filter((u) => u.status === "in_stock").length;
    const expanded = state.expandedStockDeviceTypes.has(p.id);

    const section = document.createElement("div");
    section.className = "stock-device-type-section";
    const header = document.createElement("div");
    header.className = "stock-type-header stock-type-header-toggle";
    header.appendChild(el_("div", "stock-type-toggle-arrow", expanded ? "▾" : "▸"));
    header.appendChild(el_("div", "stock-type-name", p.name));
    header.appendChild(el_("div", "stock-type-count", String(inStock)));
    header.appendChild(el_("div", "stock-type-sublabel", "na stanju"));
    header.addEventListener("click", () => {
      if (expanded) state.expandedStockDeviceTypes.delete(p.id);
      else state.expandedStockDeviceTypes.add(p.id);
      renderStockDevices();
    });
    section.appendChild(header);

    if (!expanded) {
      el.stockDeviceSections.appendChild(section);
      continue;
    }

    const wrap = document.createElement("div");
    wrap.className = "table-wrap";
    const table = document.createElement("table");
    table.className = "grid stock-device-type-table";
    const thead = document.createElement("thead");
    const headRow = document.createElement("tr");
    for (const h of ["Serijski broj", "Status", "Porudžbina", ""]) headRow.appendChild(el_("th", null, h));
    thead.appendChild(headRow);
    table.appendChild(thead);

    const tbody = document.createElement("tbody");
    if (units.length === 0) {
      const tr = document.createElement("tr");
      const td = el_("td", "section-hint", "Nema uređaja ove vrste na stanju");
      td.colSpan = 4;
      tr.appendChild(td);
      tbody.appendChild(tr);
    } else {
      for (const unit of units) {
        const tr = document.createElement("tr");
        tr.appendChild(el_("td", null, unit.serial_number));

        const statusTd = document.createElement("td");
        statusTd.appendChild(
          el_(
            "span",
            `badge ${unit.status === "in_stock" ? "badge-current" : "badge-neutral"}`,
            unit.status === "in_stock" ? "Na stanju" : "Poslato"
          )
        );
        tr.appendChild(statusTd);

        tr.appendChild(el_("td", null, unit.order_id ? "Da" : "—"));

        const delTd = document.createElement("td");
        if (unit.status === "in_stock" && canEdit("stock")) {
          const delBtn = el_("button", "icon-btn", "×");
          delBtn.type = "button";
          delBtn.title = "Obriši";
          delBtn.addEventListener("click", () => deleteDeviceUnit(unit.id));
          delTd.appendChild(delBtn);
        }
        tr.appendChild(delTd);
        tbody.appendChild(tr);
      }
    }
    table.appendChild(tbody);
    wrap.appendChild(table);
    section.appendChild(wrap);
    el.stockDeviceSections.appendChild(section);
  }
}

async function addDeviceUnit(productId, serialNumber, opts = {}) {
  const { data, error } = await supabase
    .from("device_units")
    .insert({ product_id: productId, serial_number: serialNumber.trim() })
    .select()
    .single();
  if (error) {
    if (!opts.silent) showToast("Greška pri dodavanju: " + error.message, true);
    return null;
  }
  state.deviceUnits.unshift(data);
  if (!opts.silent) {
    renderStockDevices();
    showToast("Dodato na stanje");
  }
  return data;
}

async function deleteDeviceUnit(id) {
  const { error } = await supabase.from("device_units").delete().eq("id", id);
  if (error) {
    showToast("Greška: " + error.message, true);
    return;
  }
  state.deviceUnits = state.deviceUnits.filter((u) => u.id !== id);
  renderStockDevices();
  showToast("Obrisano");
}

// Prikazuje serijski-broj/OCR deo za uređaje, ili prosto polje za količinu
// za konektore, zavisno od izabrane stavke u zajedničkom select-u.
function syncStockModalProductType() {
  const opt = el.stockDeviceProduct.selectedOptions[0];
  const type = opt ? opt.dataset.type : "device";
  el.stockDeviceAddSection.hidden = type !== "device";
  el.stockConnectorAddSection.hidden = type !== "connector";
}

el.stockDeviceProduct.addEventListener("change", syncStockModalProductType);

// "+ Dodaj" modal ne upisuje u bazu na svaki klik — svaka stavka (serijski
// broj ili količina konektora) se prvo doda u state.stockPendingItems i
// prikaže na dnu modala, a tek "Sačuvaj" upisuje sve odjednom. Ovo je
// namerno — kad stigne veći broj artikala odjednom, korisnik ne mora da
// čeka/potvrđuje posle svakog pojedinačnog dodavanja.
function renderStockPendingList() {
  el.stockPendingList.innerHTML = "";
  el.stockSaveBtnCount.textContent = String(state.stockPendingItems.length);
  if (state.stockPendingItems.length === 0) {
    el.stockPendingList.hidden = true;
    return;
  }
  el.stockPendingList.hidden = false;
  state.stockPendingItems.forEach((item, idx) => {
    const row = document.createElement("div");
    row.className = "stock-pending-row";
    const label =
      item.type === "device" ? `${item.productName} — SN ${item.serial}` : `${item.productName} — +${item.qty} kom`;
    row.appendChild(el_("span", null, label));
    const delBtn = el_("button", "icon-btn", "×");
    delBtn.type = "button";
    delBtn.title = "Ukloni iz liste";
    delBtn.addEventListener("click", () => {
      state.stockPendingItems.splice(idx, 1);
      renderStockPendingList();
    });
    row.appendChild(delBtn);
    el.stockPendingList.appendChild(row);
  });
}

function openStockAddModal() {
  populateStockProductSelect(el.stockDeviceProduct);
  syncStockModalProductType();
  el.stockDeviceSerial.value = "";
  el.stockConnectorQtyInput.value = "";
  el.stockOcrFile.value = "";
  el.stockOcrStatus.textContent = "";
  el.stockOcrPreviews.innerHTML = "";
  el.stockOcrResult.hidden = true;
  state.ocrCandidateSerials = [];
  state.stockPendingItems = [];
  renderStockPendingList();
  el.stockAddModal.hidden = false;
}

function closeStockAddModal() {
  if (state.stockPendingItems.length > 0) {
    const ok = confirm(`Imaš ${state.stockPendingItems.length} nesačuvanih stavki u listi. Zatvoriti bez čuvanja?`);
    if (!ok) return;
  }
  state.stockPendingItems = [];
  el.stockAddModal.hidden = true;
  renderStockDevices();
  renderStockConnectors();
}

el.stockAddBtn.addEventListener("click", openStockAddModal);
el.stockModalCloseBtn.addEventListener("click", closeStockAddModal);
el.stockAddModal.addEventListener("click", (e) => {
  if (e.target === el.stockAddModal) closeStockAddModal();
});

el.stockSaveBtn.addEventListener("click", async () => {
  if (state.stockPendingItems.length === 0) {
    el.stockAddModal.hidden = true;
    return;
  }
  let savedCount = 0;
  let failedCount = 0;
  for (const item of state.stockPendingItems) {
    if (item.type === "device") {
      const saved = await addDeviceUnit(item.productId, item.serial, { silent: true });
      if (saved) savedCount++;
      else failedCount++;
    } else {
      const ok = await adjustConnectorStock(item.productId, item.qty, { silent: true });
      if (ok) savedCount++;
      else failedCount++;
    }
  }
  state.stockPendingItems = [];
  renderStockDevices();
  renderStockConnectors();
  showToast(
    failedCount ? `Sačuvano ${savedCount}, ${failedCount} nije uspelo (proveri duplikate serijskih brojeva)` : `Sačuvano ${savedCount} stavki`,
    failedCount > 0
  );
  el.stockAddModal.hidden = true;
});

el.stockDeviceAddBtn.addEventListener("click", () => {
  const productId = el.stockDeviceProduct.value;
  const opt = el.stockDeviceProduct.selectedOptions[0];
  const serial = el.stockDeviceSerial.value.trim();
  if (!productId || !serial) {
    showToast("Izaberi uređaj i unesi serijski broj", true);
    return;
  }
  state.stockPendingItems.push({ type: "device", productId, productName: opt.textContent, serial });
  el.stockDeviceSerial.value = "";
  renderStockPendingList();
});

el.stockConnectorQtyAddBtn.addEventListener("click", () => {
  const productId = el.stockDeviceProduct.value;
  const opt = el.stockDeviceProduct.selectedOptions[0];
  const qty = parseInt(el.stockConnectorQtyInput.value, 10);
  if (!productId || !qty || qty <= 0) {
    showToast("Izaberi konektor i unesi količinu veću od 0", true);
    return;
  }
  const existing = state.stockPendingItems.find((it) => it.type === "connector" && it.productId === productId);
  if (existing) existing.qty += qty;
  else state.stockPendingItems.push({ type: "connector", productId, productName: opt.textContent, qty });
  el.stockConnectorQtyInput.value = "";
  renderStockPendingList();
});

function renderStockConnectors() {
  const connectors = state.products.filter((p) => p.type === "connector");
  el.stockConnectorsList.innerHTML = "";
  if (connectors.length === 0) {
    el.stockConnectorsList.appendChild(el_("div", "section-hint", "Nema konektora u katalogu"));
    return;
  }
  for (const p of connectors) {
    const section = document.createElement("div");
    section.className = "stock-device-type-section";

    const header = document.createElement("div");
    header.className = "stock-type-header";
    header.appendChild(el_("div", "stock-type-name", p.name));
    header.appendChild(el_("div", "stock-type-count", String(p.stock_quantity ?? 0)));
    header.appendChild(el_("div", "stock-type-sublabel", "na stanju"));
    section.appendChild(header);

    el.stockConnectorsList.appendChild(section);
  }
}

async function adjustConnectorStock(productId, delta, opts = {}) {
  const product = state.products.find((p) => p.id === productId);
  if (!product) return false;
  const newQty = Math.max(0, (product.stock_quantity || 0) + delta);
  const { error } = await supabase.from("products").update({ stock_quantity: newQty }).eq("id", productId);
  if (error) {
    if (!opts.silent) showToast("Greška: " + error.message, true);
    return false;
  }
  product.stock_quantity = newQty;
  if (!opts.silent) {
    renderStockConnectors();
    showToast("Sačuvano");
  }
  return true;
}

// ---------- OCR: čitanje serijskog broja sa slike (Tesseract.js, u browseru) ----------

let tesseractLoadPromise = null;
function loadTesseract() {
  if (window.Tesseract) return Promise.resolve();
  if (tesseractLoadPromise) return tesseractLoadPromise;
  tesseractLoadPromise = new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js";
    script.onload = () => resolve();
    script.onerror = () => reject(new Error("Ne mogu da učitam OCR biblioteku (proveri internet konekciju)"));
    document.head.appendChild(script);
  });
  return tesseractLoadPromise;
}

// Izvuci moguće SERIJSKE BROJEVE (SN) iz sirovog OCR teksta (slika može imati
// više uređaja na nalepnicama). Nalepnice na uređajima uvek imaju red oblika
// "SN: 3B5000xxxxxx" pored MAC/CODE/FCC ID/IC redova — zato prvo tražimo baš
// red uz "SN"/"S/N" oznaku (da ne pokupimo MAC/CODE/FCC kao serijski broj), pa
// dopunimo poznatim VRH SN formatom (3B5000 + 6 cifara) ako OCR omane oko same
// oznake. Korisnik svakako pregleda/otštiklira/ispravlja pre potvrde.
const SN_JUNK_WORDS = new Set([
  "DESIGNED", "CALIFORNIA", "ASSEMBLED", "CHINA", "THIS", "SIDE", "DOWN",
  "FCC", "MAC", "CODE", "ID",
]);

// Tesseract često pogrešno pročita slovo "B" kao cifru "8" (npr. "3B5000..."
// postane "385000..."). Znamo da VRH SN uvek ima "B" na toj poziciji, pa
// vraćamo ispravljenu verziju kad prepoznamo taj obrazac.
function normalizeKnownSerial(s) {
  const m = s.match(/^3[B8]5000([0-9]{6})$/i);
  return m ? `3B5000${m[1]}` : s;
}

// Samo tokeni nađeni uz "SN"/"S/N" oznaku ili u poznatom VRH formatu
// (3B5000 + 6 cifara). Ovo je jedini izvor kandidata dok god BAR JEDAN prolaz
// (cela slika ili neka od pojedinačno isečenih nalepnica) nešto nađe — MAC,
// CODE, FCC ID i sličan šum se namerno nikad ne vraćaju odavde.
function extractAnchoredSerials(text) {
  const anchored = [];
  const seenAnchored = new Set();

  // Namerno strogo: "S" i "N" moraju biti neposredno jedno uz drugo (bez
  // razmaka između, kao na pravoj nalepnici — dozvoljeno je samo "S/N"), i
  // MORA postojati ":" ili ";" posle (Tesseract zna ":" da pročita kao ";").
  // Bez ovoga bi slučajno "S...N" negde u OCR šumu (bez stvarne SN oznake)
  // lažno prošlo kao kandidat. /g hvata SVE pojave u tekstu, ne samo prvu po
  // redu — Tesseract često spoji više nalepnica u isti "red" teksta.
  const anchorRe = /\bS\/?N\s*[:;]\s*([A-Z0-9][A-Z0-9-]{5,})/gi;
  let m;
  while ((m = anchorRe.exec(text)) !== null) {
    const clean = normalizeKnownSerial(m[1].toUpperCase().replace(/[^A-Z0-9-]/g, ""));
    if (clean.length >= 6 && !seenAnchored.has(clean)) {
      seenAnchored.add(clean);
      anchored.push(clean);
    }
  }

  const knownFormat = text.match(/\b3[B8]5000[0-9]{6}\b/gi) || [];
  for (const raw of knownFormat) {
    const clean = normalizeKnownSerial(raw.toUpperCase());
    if (!seenAnchored.has(clean)) {
      seenAnchored.add(clean);
      anchored.push(clean);
    }
  }
  return anchored;
}

// Poslednja linija odbrane kad NIJEDAN prolaz (ni cela slika, ni ijedna
// pojedinačno isečena nalepnica) nije našao ništa uz "SN" oznaku — tek tada
// vredi ponuditi generički spisak (bez očiglednog šuma sa nalepnice) da
// korisnik ipak ima od čega da bira i ručno ispravi.
function extractGenericTokens(text) {
  const matches = text.match(/[A-Z0-9-]{6,}/gi) || [];
  const seen = new Set();
  const out = [];
  for (const m of matches) {
    const clean = m.toUpperCase();
    if (SN_JUNK_WORDS.has(clean)) continue;
    if (!seen.has(clean)) {
      seen.add(clean);
      out.push(clean);
    }
  }
  return out;
}

function loadImageElement(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Ne mogu da učitam sliku"));
    img.src = URL.createObjectURL(file);
  });
}

// Pronađi nalepnice na slici i vrati tačan isečak oko svake, da se svaka
// OCR-uje izolovano. Kad je na slici više uređaja, OCR nad CELIM kadrom
// često "proguta" po jednu nalepnicu zbog okolnog šuma (drvo, šrafovi,
// barkod, reljefni "THIS SIDE DOWN") — testom je potvrđeno da isti tekst
// pouzdano pročita samo kad se posmatra izolovano. Fiksni kvadranti su se
// pokazali nedovoljni (i dalje previše okolnog šuma po komadu), pa umesto
// toga tražimo stvarne nalepnice: to su bele/kremaste pravougaone površine
// (visok luminitet, NISKA zasićenost boje — za razliku od osvetljenog drveta
// koje je i dalje žuto-braon) na tamnom kućištu uređaja.
function detectLabelCrops(imgEl) {
  const W = imgEl.naturalWidth;
  const H = imgEl.naturalHeight;
  const maxDim = 480;
  const scale = Math.min(1, maxDim / Math.max(W, H));
  const sw = Math.max(1, Math.round(W * scale));
  const sh = Math.max(1, Math.round(H * scale));

  const smallCanvas = document.createElement("canvas");
  smallCanvas.width = sw;
  smallCanvas.height = sh;
  const sctx = smallCanvas.getContext("2d");
  sctx.drawImage(imgEl, 0, 0, sw, sh);
  const { data } = sctx.getImageData(0, 0, sw, sh);

  const cell = 6;
  const cols = Math.ceil(sw / cell);
  const rows = Math.ceil(sh / cell);
  const bright = new Uint8Array(cols * rows);

  for (let cy = 0; cy < rows; cy++) {
    for (let cx = 0; cx < cols; cx++) {
      const x0 = cx * cell;
      const y0 = cy * cell;
      const x1 = Math.min(sw, x0 + cell);
      const y1 = Math.min(sh, y0 + cell);
      let sumLum = 0;
      let sumSat = 0;
      let n = 0;
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const idx = (y * sw + x) * 4;
          const r = data[idx];
          const g = data[idx + 1];
          const b = data[idx + 2];
          sumLum += 0.299 * r + 0.587 * g + 0.114 * b;
          sumSat += Math.max(r, g, b) - Math.min(r, g, b);
          n++;
        }
      }
      const avgLum = n ? sumLum / n : 0;
      const avgSat = n ? sumSat / n : 999;
      bright[cy * cols + cx] = avgLum > 170 && avgSat < 28 ? 1 : 0;
    }
  }

  // Flood fill povezanih "svetlih" ćelija u regione (kandidate za nalepnice)
  const visited = new Uint8Array(cols * rows);
  const boxes = [];
  for (let cy = 0; cy < rows; cy++) {
    for (let cx = 0; cx < cols; cx++) {
      const startIdx = cy * cols + cx;
      if (!bright[startIdx] || visited[startIdx]) continue;
      let minX = cx, maxX = cx, minY = cy, maxY = cy, size = 0;
      const stack = [startIdx];
      visited[startIdx] = 1;
      while (stack.length) {
        const cur = stack.pop();
        const y = Math.floor(cur / cols);
        const x = cur % cols;
        size++;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
        const neighbors = [
          [x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1],
        ];
        for (const [nx, ny] of neighbors) {
          if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
          const nIdx = ny * cols + nx;
          if (bright[nIdx] && !visited[nIdx]) {
            visited[nIdx] = 1;
            stack.push(nIdx);
          }
        }
      }
      if (size < 6) continue;
      const bw = (maxX - minX + 1) * cell;
      const bh = (maxY - minY + 1) * cell;
      // Nalepnica je pravougaona i zauzima razuman deo kadra — filtriraj
      // sitan šum i preterano velike/izdužene regione (npr. osvetljen zid).
      if (bw < sw * 0.12 || bh < sh * 0.04 || bw > sw * 0.85 || bh > sh * 0.6) continue;
      boxes.push({ x: minX * cell, y: minY * cell, w: bw, h: bh });
    }
  }

  // Nazad na originalnu rezoluciju, uz malo dopune (padding) da se ne odseče
  // ivica nalepnice ili poslednja cifra.
  const pad = 0.15;
  return boxes.map((b) => {
    const ox = b.x / scale;
    const oy = b.y / scale;
    const ow = b.w / scale;
    const oh = b.h / scale;
    const padX = ow * pad;
    const padY = oh * pad;
    const x0 = Math.max(0, ox - padX);
    const y0 = Math.max(0, oy - padY);
    const x1 = Math.min(W, ox + ow + padX);
    const y1 = Math.min(H, oy + oh + padY);
    const cw = Math.round(x1 - x0);
    const ch = Math.round(y1 - y0);
    const canvas = document.createElement("canvas");
    canvas.width = cw;
    canvas.height = ch;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(imgEl, x0, y0, cw, ch, 0, 0, cw, ch);
    return canvas;
  });
}

function canvasToBlob(canvas) {
  return new Promise((resolve) => canvas.toBlob((blob) => resolve(blob), "image/png"));
}

// Telefon često snima uređaje "na bok" (nalepnica ispada vertikalna na
// slici) — OCR pouzdano čita tekst samo kad je približno horizontalan, pa
// za svaku nalepnicu probamo sve 4 rotacije dok neka ne da pogodak uz "SN".
function rotateCanvas(sourceCanvas, degrees) {
  if (degrees === 0) return sourceCanvas;
  const rad = (degrees * Math.PI) / 180;
  const w = sourceCanvas.width;
  const h = sourceCanvas.height;
  const swap = degrees === 90 || degrees === 270;
  const canvas = document.createElement("canvas");
  canvas.width = swap ? h : w;
  canvas.height = swap ? w : h;
  const ctx = canvas.getContext("2d");
  ctx.translate(canvas.width / 2, canvas.height / 2);
  ctx.rotate(rad);
  ctx.drawImage(sourceCanvas, -w / 2, -h / 2);
  return canvas;
}

function renderOcrCandidates(candidates) {
  state.ocrCandidateSerials = candidates.map((c) => ({ text: c, checked: true }));
  el.stockOcrCandidates.innerHTML = "";
  if (state.ocrCandidateSerials.length === 0) {
    el.stockOcrCandidates.appendChild(el_("div", "section-hint", "Ništa nije prepoznato — unesi ručno gore."));
    return;
  }
  for (const cand of state.ocrCandidateSerials) {
    const row = document.createElement("label");
    row.className = "stock-ocr-candidate";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = cand.checked;
    cb.addEventListener("change", () => {
      cand.checked = cb.checked;
    });
    const input = document.createElement("input");
    input.type = "text";
    input.value = cand.text;
    input.addEventListener("input", () => {
      cand.text = input.value;
    });
    row.appendChild(cb);
    row.appendChild(input);
    el.stockOcrCandidates.appendChild(row);
  }
}

el.stockOcrFile.addEventListener("change", async () => {
  const files = Array.from(el.stockOcrFile.files || []);
  if (files.length === 0) return;

  if (!el.stockDeviceProduct.value) {
    showToast("Prvo izaberi uređaj (PT30/PT40) gore", true);
    el.stockOcrFile.value = "";
    return;
  }

  el.stockOcrResult.hidden = true;
  el.stockOcrPreviews.innerHTML = "";
  for (const f of files) {
    const img = document.createElement("img");
    img.className = "stock-ocr-preview";
    img.src = URL.createObjectURL(f);
    el.stockOcrPreviews.appendChild(img);
  }
  el.stockOcrStatus.textContent = "Učitavanje OCR biblioteke...";

  try {
    await loadTesseract();
    let combinedText = "";
    const allTexts = [];
    const anchoredSeen = new Set();
    const anchoredCandidates = [];

    for (let i = 0; i < files.length; i++) {
      el.stockOcrStatus.textContent = `Čitanje slike ${i + 1}/${files.length}...`;
      const result = await window.Tesseract.recognize(files[i], "eng");
      const text = (result.data.text || "").trim();
      combinedText += (combinedText ? "\n---\n" : "") + text;
      allTexts.push(text);
      for (const c of extractAnchoredSerials(text)) {
        if (!anchoredSeen.has(c)) {
          anchoredSeen.add(c);
          anchoredCandidates.push(c);
        }
      }

      // Dopunski prolaz po pojedinačno detektovanim nalepnicama — hvata
      // uređaje koje OCR nad celim kadrom promaši zbog okolnog šuma kad ima
      // više uređaja na slici.
      try {
        const imgEl = await loadImageElement(files[i]);
        const labelCanvases = detectLabelCrops(imgEl);
        for (let li = 0; li < labelCanvases.length; li++) {
          // Nalepnica na slici može biti fotografisana "na bok" — probaj sve
          // 4 rotacije i stani čim neka da pogodak uz "SN" (nema potrebe
          // trošiti vreme na preostale uglove za tu istu nalepnicu).
          for (const angle of [0, 90, 180, 270]) {
            el.stockOcrStatus.textContent = `Čitanje slike ${i + 1}/${files.length} (nalepnica ${li + 1}/${labelCanvases.length}, ugao ${angle}°)...`;
            const canvas = rotateCanvas(labelCanvases[li], angle);
            const blob = await canvasToBlob(canvas);
            if (!blob) continue;
            const lResult = await window.Tesseract.recognize(blob, "eng");
            const lText = (lResult.data.text || "").trim();
            allTexts.push(lText);
            const found = extractAnchoredSerials(lText);
            if (found.length > 0) {
              for (const c of found) {
                if (!anchoredSeen.has(c)) {
                  anchoredSeen.add(c);
                  anchoredCandidates.push(c);
                }
              }
              break;
            }
          }
        }
      } catch (err) {
        console.warn("Čitanje po nalepnicama nije uspelo:", err);
      }
    }

    // Generički fallback (bez SN oznake) se koristi SAMO ako baš nijedan
    // prolaz nije našao nijedan pravi SN — inače bi jedan "prljav" prolaz
    // (npr. cela slika) zatrpao listu sa MAC/CODE/FCC šumom pored pravih SN
    // vrednosti koje je neki drugi (čistiji) prolaz uredno našao.
    let finalCandidates = anchoredCandidates;
    if (finalCandidates.length === 0) {
      const genericSeen = new Set();
      finalCandidates = [];
      for (const t of allTexts) {
        for (const c of extractGenericTokens(t)) {
          if (!genericSeen.has(c)) {
            genericSeen.add(c);
            finalCandidates.push(c);
          }
        }
      }
    }

    el.stockOcrStatus.textContent = finalCandidates.length
      ? `Pronađeno ${finalCandidates.length} mogućih serijskih brojeva sa ${files.length} slik${files.length === 1 ? "e" : "a"} — proveri ispod pre dodavanja.`
      : "Nije prepoznat nijedan mogući serijski broj — proveri sirov tekst ili unesi ručno.";
    el.stockOcrRawText.value = combinedText;
    renderOcrCandidates(finalCandidates);
    el.stockOcrResult.hidden = false;
  } catch (err) {
    console.error(err);
    el.stockOcrStatus.textContent = "Greška pri OCR čitanju: " + err.message;
  }
});

el.stockOcrConfirmBtn.addEventListener("click", () => {
  const productId = el.stockDeviceProduct.value;
  const opt = el.stockDeviceProduct.selectedOptions[0];
  if (!productId) {
    showToast("Izaberi uređaj", true);
    return;
  }
  const toAdd = state.ocrCandidateSerials.filter((c) => c.checked && c.text.trim());
  if (toAdd.length === 0) {
    showToast("Nijedan serijski broj nije izabran", true);
    return;
  }

  for (const c of toAdd) {
    state.stockPendingItems.push({ type: "device", productId, productName: opt.textContent, serial: c.text.trim() });
  }
  showToast(`Dodato ${toAdd.length} u listu za čuvanje`);

  el.stockOcrResult.hidden = true;
  el.stockOcrPreviews.innerHTML = "";
  el.stockOcrFile.value = "";
  el.stockOcrStatus.textContent = "";
  state.ocrCandidateSerials = [];
  renderStockPendingList();
});

// ---------- početna (dashboard) ----------

// Ukupno uređaja (kamiona) na dan 1 tekućeg meseca vs danas — isti "hodaj
// unazad do poslednjeg poznatog dana" obrazac kao u dnevnom izveštaju.
async function computeHomeTruckStats() {
  const year = now.getFullYear();
  const month = now.getMonth();
  const today = now.getDate();
  const counts = await loadCounts(year, month);

  let startTotal = 0;
  let todayTotal = 0;
  for (const c of state.companies) {
    const dc = counts[c.id];
    if (!dc) continue;

    const startVal = dc[1]?.total;
    if (startVal !== undefined && startVal !== null) startTotal += startVal;

    for (let dd = today; dd >= 1; dd--) {
      const t = dc[dd]?.total;
      if (t !== undefined && t !== null) {
        todayTotal += t;
        break;
      }
    }
  }
  return { startTotal, todayTotal };
}

const HOME_STOCK_CARD_COLORS = ["home-stat-card-green", "home-stat-card-purple", "home-stat-card-orange", "home-stat-card-pink"];

function renderHomeStockCards() {
  el.homeStockCards.innerHTML = "";
  const devices = state.products.filter((x) => x.type === "device");
  devices.forEach((p, idx) => {
    const inStock = state.deviceUnits.filter((u) => u.product_id === p.id && u.status === "in_stock").length;
    const card = document.createElement("div");
    card.className = `home-stat-card ${HOME_STOCK_CARD_COLORS[idx % HOME_STOCK_CARD_COLORS.length]}`;
    card.appendChild(el_("div", "home-stat-label", `${p.name} na stanju`));
    card.appendChild(el_("div", "home-stat-value", String(inStock)));
    el.homeStockCards.appendChild(card);
  });
}

function renderHomeRecentNaplata() {
  const rows = state.naplata
    .slice()
    .sort((a, b) => (b.invoice_date || "").localeCompare(a.invoice_date || ""))
    .slice(0, 5);

  el.homeRecentNaplata.innerHTML = "";
  if (rows.length === 0) {
    el.homeRecentNaplata.appendChild(el_("div", "section-hint", "Nema stavki"));
    return;
  }
  for (const r of rows) {
    const item = document.createElement("div");
    item.className = "home-recent-item";
    const top = el_("div", "home-recent-title", r.company_name);
    top.appendChild(naplataCycleBadge(r.cycle));
    item.appendChild(top);
    item.appendChild(
      el_("div", "home-recent-meta", `${r.invoice_date || "—"} · $${Number(r.amount || 0).toFixed(2)}`)
    );
    el.homeRecentNaplata.appendChild(item);
  }
}

function renderHomeRecentOrders() {
  const rows = state.orders
    .slice()
    .sort((a, b) => (b.order_date || "").localeCompare(a.order_date || ""))
    .slice(0, 5);

  el.homeRecentOrders.innerHTML = "";
  if (rows.length === 0) {
    el.homeRecentOrders.appendChild(el_("div", "section-hint", "Nema porudžbina"));
    return;
  }
  for (const o of rows) {
    const item = document.createElement("div");
    item.className = "home-recent-item";
    item.appendChild(el_("div", "home-recent-title", o.company_name));
    const lines = getOrderItemLines(o);
    item.appendChild(el_("div", "home-recent-meta", lines.length ? lines.join(" · ") : "—"));
    item.appendChild(
      el_(
        "div",
        "home-recent-meta",
        `${o.order_date || "—"} · ${o.amount !== null && o.amount !== undefined ? "$" + Number(o.amount).toFixed(2) : "—"}`
      )
    );
    el.homeRecentOrders.appendChild(item);
  }
}

// Teži deo (stanje uređaja + poslednjih 5 naplata/porudžbina) prikazuje se
// samo na desktopu — na mobilnom se uopšte ne učitava, da stranica ostane
// brza (mobilni prikaz ima samo dva dugmeta koja vode na te iste podatke).
function isDesktopViewport() {
  return window.matchMedia("(min-width: 641px)").matches;
}

async function loadHomeDashboard() {
  const desktop = isDesktopViewport();
  const need = [];
  if (desktop) {
    // "|| .length === 0" - vidi napomenu uz isti obrazac u showPage(): samo
    // "loaded" flag bi ostao zauvek true ako prvi pokušaj vrati praznu
    // listu, i sprečio svaki naredni pokušaj bez punog refresh-a stranice.
    if (!state.naplataLoaded || state.naplata.length === 0) need.push(loadNaplata());
    if (!state.ordersLoaded || state.orders.length === 0) need.push(Promise.all([loadOrders(), loadOrderItems()]));
    if (!state.productsLoaded || state.products.length === 0) need.push(loadProducts());
    if (!state.deviceUnitsLoaded || state.deviceUnits.length === 0) need.push(loadDeviceUnits());
  }

  const [truckStats] = await Promise.all([computeHomeTruckStats(), ...need]);
  el.homeStatMonthStart.textContent = truckStats.startTotal;
  el.homeStatToday.textContent = truckStats.todayTotal;

  if (desktop) {
    renderHomeStockCards();
    renderHomeRecentNaplata();
    renderHomeRecentOrders();
  }
}

// Sinhronizacija sa ELD API-jem ide u 15h po Beograđanskom vremenu — pre
// toga dnevni izveštaj za "danas" još nema svež upis, pa dugme umesto toga
// otvara izveštaj za prethodni dan. Računa se po Europe/Belgrade zoni, ne po
// lokalnom vremenu uređaja, da radi isto bez obzira odakle se otvara app.
function belgradeNowParts() {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "Europe/Belgrade",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hour12: false,
  });
  const parts = Object.fromEntries(fmt.formatToParts(new Date()).map((p) => [p.type, p.value]));
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour) % 24,
  };
}

el.homeDailyReportBtn.addEventListener("click", () => {
  const bg = belgradeNowParts();
  let y = bg.year;
  let m = bg.month; // 1-indexed
  let d = bg.day;
  if (bg.hour < 15) {
    const prev = new Date(y, m - 1, d - 1);
    y = prev.getFullYear();
    m = prev.getMonth() + 1;
    d = prev.getDate();
  }
  showPage("reports");
  el.reportDate.value = `${y}-${pad(m)}-${pad(d)}`;
  setReportType("daily");
});

// Sa Početne (mobilna verzija): vodi na punu Stanje uređaja stranicu (koja je
// već read-only na mobilnoj — vidi mobile @media blok u style.css).
el.homeStockBtn.addEventListener("click", () => {
  showPage("stock");
});

// ---------- role i korisnici (Settings > Nalozi) ----------

async function loadRoles() {
  const { data, error } = await supabase.from("roles").select("*").order("name");
  if (error) {
    showToast("Greška pri učitavanju rola: " + error.message, true);
    return;
  }
  state.roles = data || [];
  state.rolesLoaded = true;
}

async function loadUsers() {
  const { data, error } = await supabase.from("profiles").select("*").order("email");
  if (error) {
    showToast("Greška pri učitavanju korisnika: " + error.message, true);
    return;
  }
  state.users = data || [];
  state.usersLoaded = true;
}

function permBadge(page, level) {
  const cls =
    level === "edit" ? "role-perm-badge-edit" : level === "view" ? "role-perm-badge-view" : "role-perm-badge-none";
  const label = level === "edit" ? "Izmena" : "Pregled";
  return el_("span", `role-perm-badge ${cls}`, `${PAGE_LABELS[page]}: ${label}`);
}

function renderRoles() {
  el.rolesBody.innerHTML = "";
  if (state.roles.length === 0) {
    const tr = document.createElement("tr");
    const td = el_("td", "empty-state-cell", "Nema rola. Napravi prvu.");
    td.colSpan = 3;
    tr.appendChild(td);
    el.rolesBody.appendChild(tr);
    return;
  }
  for (const role of state.roles) {
    const tr = document.createElement("tr");
    tr.appendChild(el_("td", null, role.name));

    const permsTd = document.createElement("td");
    const badges = document.createElement("div");
    badges.className = "role-perm-badges";
    for (const page of VALID_PAGES) {
      const level = role.permissions?.[page];
      if (level !== "view" && level !== "edit") continue;
      badges.appendChild(permBadge(page, level));
    }
    if (!badges.children.length) badges.appendChild(el_("span", "role-perm-badge role-perm-badge-none", "Bez pristupa"));
    permsTd.appendChild(badges);
    tr.appendChild(permsTd);

    const actionsTd = document.createElement("td");
    const editBtn = document.createElement("button");
    editBtn.type = "button";
    editBtn.className = "btn btn-icon";
    editBtn.textContent = "✎";
    editBtn.title = "Izmeni";
    editBtn.addEventListener("click", () => openRoleModal(role));
    actionsTd.appendChild(editBtn);
    const delBtn = document.createElement("button");
    delBtn.type = "button";
    delBtn.className = "btn btn-icon";
    delBtn.textContent = "🗑";
    delBtn.title = "Obriši";
    delBtn.addEventListener("click", () => deleteRole(role));
    actionsTd.appendChild(delBtn);
    tr.appendChild(actionsTd);

    el.rolesBody.appendChild(tr);
  }
}

function openRoleModal(role) {
  state.editingRoleId = role ? role.id : null;
  el.roleModalTitle.textContent = role ? "Izmena role" : "Nova rola";
  el.roleModalName.value = role ? role.name : "";
  el.roleModalPerms.innerHTML = "";
  for (const page of VALID_PAGES) {
    const row = document.createElement("div");
    row.className = "role-perm-row";
    const selectId = `rolePerm_${page}`;
    const label = el_("label", null, PAGE_LABELS[page]);
    label.setAttribute("for", selectId);
    const select = document.createElement("select");
    select.id = selectId;
    select.dataset.page = page;
    for (const [value, text] of [
      ["none", "Bez pristupa"],
      ["view", "Pregled"],
      ["edit", "Izmena"],
    ]) {
      const opt = document.createElement("option");
      opt.value = value;
      opt.textContent = text;
      select.appendChild(opt);
    }
    select.value = role?.permissions?.[page] || "none";
    row.appendChild(label);
    row.appendChild(select);
    el.roleModalPerms.appendChild(row);
  }
  el.roleModal.hidden = false;
}

el.roleAddBtn.addEventListener("click", () => openRoleModal(null));
el.roleModalCancel.addEventListener("click", () => {
  el.roleModal.hidden = true;
});
el.roleModal.addEventListener("click", (e) => {
  if (e.target === el.roleModal) el.roleModal.hidden = true;
});

el.roleForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const name = el.roleModalName.value.trim();
  if (!name) return;
  const permissions = {};
  el.roleModalPerms.querySelectorAll("select").forEach((select) => {
    if (select.value !== "none") permissions[select.dataset.page] = select.value;
  });

  const payload = { name, permissions };
  const { error } = state.editingRoleId
    ? await supabase.from("roles").update(payload).eq("id", state.editingRoleId)
    : await supabase.from("roles").insert(payload);
  if (error) {
    showToast("Greška: " + error.message, true);
    return;
  }
  el.roleModal.hidden = true;
  await loadRoles();
  renderRoles();
  showToast("Sačuvano");
  if (state.usersLoaded) renderUsers();
});

async function deleteRole(role) {
  if (!confirm(`Obriši rolu "${role.name}"? Korisnici sa ovom rolom ostaju bez pristupa dok im se ne dodeli druga.`)) {
    return;
  }
  const { error } = await supabase.from("roles").delete().eq("id", role.id);
  if (error) {
    showToast("Greška: " + error.message, true);
    return;
  }
  await loadRoles();
  renderRoles();
  showToast("Obrisano");
}

function renderUsers() {
  el.usersBody.innerHTML = "";
  if (state.users.length === 0) {
    const tr = document.createElement("tr");
    const td = el_("td", "empty-state-cell", "Nema korisnika.");
    td.colSpan = 3;
    tr.appendChild(td);
    el.usersBody.appendChild(tr);
    return;
  }
  for (const user of state.users) {
    const tr = document.createElement("tr");
    tr.appendChild(el_("td", null, user.email));

    const roleTd = document.createElement("td");
    const select = document.createElement("select");
    const noneOpt = document.createElement("option");
    noneOpt.value = "";
    noneOpt.textContent = "— Bez role —";
    select.appendChild(noneOpt);
    for (const role of state.roles) {
      const opt = document.createElement("option");
      opt.value = role.id;
      opt.textContent = role.name;
      select.appendChild(opt);
    }
    select.value = user.role_id || "";
    select.addEventListener("change", async () => {
      const { error } = await supabase
        .from("profiles")
        .update({ role_id: select.value || null })
        .eq("id", user.id);
      if (error) {
        showToast("Greška: " + error.message, true);
        return;
      }
      user.role_id = select.value || null;
      showToast("Sačuvano");
    });
    roleTd.appendChild(select);
    tr.appendChild(roleTd);

    const actionsTd = document.createElement("td");
    const delBtn = document.createElement("button");
    delBtn.type = "button";
    delBtn.className = "btn btn-icon";
    delBtn.textContent = "🗑";
    delBtn.title = "Nalog ostaje u Supabase Auth, samo gubi pristup app-u dok mu se ponovo ne dodeli rola";
    delBtn.addEventListener("click", () => removeUserAccess(user));
    actionsTd.appendChild(delBtn);
    tr.appendChild(actionsTd);

    el.usersBody.appendChild(tr);
  }
}

async function removeUserAccess(user) {
  if (
    !confirm(
      `Ukloni pristup za ${user.email}? Nalog ostaje da postoji, ali više neće moći da se prijavi u app dok mu se ponovo ne dodeli rola.`
    )
  ) {
    return;
  }
  const { error } = await supabase.from("profiles").delete().eq("id", user.id);
  if (error) {
    showToast("Greška: " + error.message, true);
    return;
  }
  await loadUsers();
  renderUsers();
  showToast("Uklonjeno");
}

el.userAddBtn.addEventListener("click", () => {
  if (state.roles.length === 0) {
    showToast("Prvo napravi bar jednu rolu.", true);
    return;
  }
  el.userModalEmail.value = "";
  el.userModalPassword.value = "";
  el.userModalRole.innerHTML = "";
  for (const role of state.roles) {
    const opt = document.createElement("option");
    opt.value = role.id;
    opt.textContent = role.name;
    el.userModalRole.appendChild(opt);
  }
  el.userModal.hidden = false;
});
el.userModalCancel.addEventListener("click", () => {
  el.userModal.hidden = true;
});
el.userModal.addEventListener("click", (e) => {
  if (e.target === el.userModal) el.userModal.hidden = true;
});

el.userForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const email = el.userModalEmail.value.trim();
  const password = el.userModalPassword.value;
  const roleId = el.userModalRole.value;
  if (!email || !password || !roleId) return;

  // Poseban izolovan klijent (supabaseAdminCreate, sopstveni storageKey) —
  // signUp() bi inače zamenio TRENUTNU (admin) sesiju u glavnom `supabase`
  // klijentu, odjavljujući admina usred kreiranja novog naloga.
  const { data, error } = await supabaseAdminCreate.auth.signUp({ email, password });
  if (error) {
    showToast("Greška pri kreiranju naloga: " + error.message, true);
    return;
  }
  if (!data.user) {
    showToast(
      "Nalog nije odmah aktivan — proveri da li je 'Confirm email' isključen u Supabase Auth podešavanjima.",
      true
    );
    return;
  }
  await supabaseAdminCreate.auth.signOut();

  const { error: profileError } = await supabase.from("profiles").insert({ id: data.user.id, email, role_id: roleId });
  if (profileError) {
    showToast("Nalog kreiran, ali dodela role nije uspela: " + profileError.message, true);
    return;
  }

  el.userModal.hidden = true;
  await loadUsers();
  renderUsers();
  showToast("Korisnik dodat");
});

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

function pageElByKey(page) {
  return el[`page${page[0].toUpperCase()}${page.slice(1)}`];
}

function showLoginPage(message) {
  el.pageNav.hidden = true;
  for (const page of VALID_PAGES) {
    const pageEl = pageElByKey(page);
    if (pageEl) pageEl.hidden = true;
  }
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
  applyNavPermissions();
  el.pageLogin.hidden = true;
  el.pageNav.hidden = false;
  el.loginEmail.value = "";
  el.loginPassword.value = "";

  const fallback = firstAccessiblePage();
  if (!fallback) {
    showToast("Nemate dozvolu ni za jednu stranicu. Obratite se administratoru.", true);
    return;
  }

  await refreshAll();
  const last = loadLastPage();
  showPage(canView(last) ? last : fallback);
  checkForNewCompanies();
  runNaplataAutoSync();
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

// ---------- init ----------

// #pageOverview koristi --nav-h da tačno popuni prostor ispod .page-nav
// (umesto pogađanja fiksnim brojem u CSS-u) — bez ovoga .table-wrap zna da
// bude viši od preostalog prostora na ekranu, pa mu donja ivica (horizontalna
// traka) upadne ispod vidljivog dela ekrana dok se cela strana ne skroluje.
function syncNavHeightVar() {
  if (!el.pageNav) return;
  document.documentElement.style.setProperty("--nav-h", `${el.pageNav.offsetHeight}px`);
}
syncNavHeightVar();
window.addEventListener("resize", syncNavHeightVar);

// Sve je sakriveno dok se ne zna da li postoji aktivna sesija (izbegava da
// Početna strana "trepne" vidljivo pre provere logina — #pageHome u HTML-u
// nema `hidden` po defaultu jer je to inicijalna strana posle logina).
el.pageNav.hidden = true;
for (const page of VALID_PAGES) {
  const pageEl = pageElByKey(page);
  if (pageEl) pageEl.hidden = true;
}

supabase.auth.getSession().then(({ data }) => {
  if (data.session) {
    bootstrapAfterLogin();
  } else {
    showLoginPage();
  }
});

// Odjava iz drugog taba / istekla sesija — vrati na login umesto da app
// ostane "zaglavljen" sa praznim podacima posle isteklog tokena.
supabase.auth.onAuthStateChange((event) => {
  if (event === "SIGNED_OUT") {
    location.reload();
  }
});

// ---------- auto-refresh posle 13:02 UTC (kad automatski ELD sync zavrsi) ----------
// Ako app ostane otvoren preko podneva, korisnik ne treba rucno da radi F5
// da bi video sveze podatke posle automatskog sync-a (cron u 13:00/13:01
// UTC, sql/sync.sql) - ova provera na svakih 60s automatski osvezi Pregled
// kamiona (i trenutno prikazan izvestaj, ako je Izvestaj strana otvorena)
// tacno jednom, prvi put kad primeti da je proslo 13:02 UTC tog dana.
let autoRefreshDoneForUtcDate = null;

function checkAutoRefreshAfterSync() {
  if (!el.pageNav || el.pageNav.hidden) return; // jos nije ulogovan

  const nowUtc = new Date();
  const utcDateStr = `${nowUtc.getUTCFullYear()}-${pad(nowUtc.getUTCMonth() + 1)}-${pad(nowUtc.getUTCDate())}`;
  const pastSyncTime =
    nowUtc.getUTCHours() > 13 || (nowUtc.getUTCHours() === 13 && nowUtc.getUTCMinutes() >= 2);

  if (!pastSyncTime || autoRefreshDoneForUtcDate === utcDateStr) return;
  autoRefreshDoneForUtcDate = utcDateStr;

  refreshAll();
  if (el.pageReports && !el.pageReports.hidden) runReport();
}

setInterval(checkAutoRefreshAfterSync, 60000);
