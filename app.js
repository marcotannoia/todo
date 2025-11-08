// CONFIG
const COGNITO_DOMAIN = "https://eu-south-1dr1kvjflg.auth.eu-south-1.amazoncognito.com";
const CLIENT_ID = "58vj61fh7onefg96ptbuboq2r4";
const REDIRECT_URI = encodeURIComponent(
  "https://todo-frontend-marco.s3.eu-south-1.amazonaws.com/index.html"
);
const API_BASE = "https://xb9cc6y9x0.execute-api.eu-south-1.amazonaws.com/primo";

// richiesta sia access_token che id_token
const LOGIN_URL = `${COGNITO_DOMAIN}/login?client_id=${CLIENT_ID}&response_type=token+id_token&scope=openid+email&redirect_uri=${REDIRECT_URI}`;
const LOGOUT_URL = `${COGNITO_DOMAIN}/logout?client_id=${CLIENT_ID}&logout_uri=${REDIRECT_URI}`;

// ================= HELPERS DI NORMALIZZAZIONE E DEBUG =================

// normalizza un singolo item DynamoDB (S, N, BOOL, M, L) -> oggetto JS semplice
function normalizeDynamoItem(item) {
  const out = {};
  for (const key in item) {
    const val = item[key];
    if (val === null || val === undefined) {
      out[key] = val;
      continue;
    }
    if (typeof val !== "object") {
      out[key] = val;
      continue;
    }

    if ("S" in val) out[key] = val.S;
    else if ("N" in val) out[key] = Number(val.N);
    else if ("BOOL" in val) out[key] = !!val.BOOL;
    else if ("M" in val) out[key] = normalizeDynamoItem(val.M);
    else if ("L" in val) {
      out[key] = val.L.map(v => {
        if (v === null || v === undefined) return v;
        if ("S" in v) return v.S;
        if ("N" in v) return Number(v.N);
        if ("BOOL" in v) return !!v.BOOL;
        if ("M" in v) return normalizeDynamoItem(v.M);
        if ("L" in v) return (v.L || []).map(x => (x.S ? x.S : x));
        return v;
      });
    } else {
      // fallback: copia l'oggetto così com'è
      out[key] = val;
    }
  }
  return out;
}

// normalizza possibili formati di risposta in un array di todo semplici
function normalizeTodos(raw) {
  if (!raw) return [];

  // se già è array semplice
  if (Array.isArray(raw)) {
    // controlla se è array di item DynamoDB (oggetti con S/N)
    if (raw.length > 0 && typeof raw[0] === "object" && raw[0] !== null) {
      const first = raw[0];
      // se il primo elemento contiene almeno un valore che è oggetto con S/N/BOOL
      if (Object.values(first).some(v => typeof v === "object")) {
        return raw.map(i => (typeof i === "object" ? normalizeDynamoItem(i) : i));
      }
    }
    return raw;
  }

  // formato tipico API Gateway -> { Items: [...] }
  if (raw.Items && Array.isArray(raw.Items)) {
    return raw.Items.map(i => (typeof i === "object" ? normalizeDynamoItem(i) : i));
  }

  // singolo Item
  if (raw.Item) {
    return [normalizeDynamoItem(raw.Item)];
  }

  // se raw.body è una stringa JSON
  if (raw.body && typeof raw.body === "string") {
    try {
      const parsed = JSON.parse(raw.body);
      return normalizeTodos(parsed);
    } catch (e) {
      return [];
    }
  }

  // se raw è stringa JSON intera
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      return normalizeTodos(parsed);
    } catch (e) {
      return [];
    }
  }

  // prova a estrarre da campi comuni
  const possibleArrays = ["todos", "data", "items", "body"];
  for (const k of possibleArrays) {
    if (raw[k] && Array.isArray(raw[k])) return raw[k];
  }

  // fallback: se è un oggetto semplice cerca di trasformare le proprietà in array
  return [raw];
}

// semplici debug helper
function dbg(...args) {
  try { console.log(...args); } catch (e) {}
}

// ================= TOKEN, AUTH =================

function parseHashForToken() {
  const hash = window.location.hash.substring(1);
  if (!hash) return;
  dbg("Hash presente:", hash);
  const params = new URLSearchParams(hash);
  const idToken = params.get("id_token");
  const accessToken = params.get("access_token");
  const expiresIn = params.get("expires_in");

  if (idToken) {
    sessionStorage.setItem("idToken", idToken);
    dbg("Salvato id_token");
  }
  if (accessToken) {
    sessionStorage.setItem("accessToken", accessToken);
    dbg("Salvato access_token");
  }
  if (expiresIn) {
    const exp = Date.now() + Number(expiresIn) * 1000;
    sessionStorage.setItem("tokenExpiry", String(exp));
    dbg("Impostata scadenza token:", new Date(exp).toISOString());
  }

  // pulisco la hash dall'URL senza ricaricare la pagina
  history.replaceState(null, "", window.location.pathname);
}

function getIdToken() {
  // preferisco id_token (per authorizer Cognito), altrimenti access_token
  return sessionStorage.getItem("idToken") || sessionStorage.getItem("accessToken") || null;
}

function isTokenExpired() {
  const exp = Number(sessionStorage.getItem("tokenExpiry") || "0");
  if (!exp) return false;
  return Date.now() > exp;
}

function isLoggedIn() {
  const token = getIdToken();
  if (!token) return false;
  if (isTokenExpired()) {
    dbg("Token scaduto, faccio logout");
    logout();
    return false;
  }
  return true;
}

function login() {
  window.location.href = LOGIN_URL;
}

function logout() {
  sessionStorage.removeItem("idToken");
  sessionStorage.removeItem("accessToken");
  sessionStorage.removeItem("tokenExpiry");
  window.location.href = LOGOUT_URL;
}

// ================= API HELPERS =================

async function apiFetch(path, options = {}) {
  const token = getIdToken();
  if (!token) throw new Error("No token");

  const headers = {
    "Content-Type": "application/json",
    ...(options.headers || {})
  };
  headers["Authorization"] = `Bearer ${token}`;
  options.headers = headers;

  dbg("API fetch:", API_BASE + path, options);

  const res = await fetch(API_BASE + path, options);

  if (res.status === 401) {
    console.error("401 dalla API, faccio logout");
    logout();
    throw new Error("Unauthorized");
  }

  const text = await res.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch (e) {
      // potrebbe essere che l'API risponde con oggetto { statusCode, body: "..." }
      // gestiremo più sotto
      console.error("Risposta non JSON diretta:", text);
      // ma proviamo a restituire il testo grezzo così lo vedrai nei log
      throw new Error("Risposta non valida JSON: " + text);
    }
  }

  // Qui data è { statusCode, body: "..." } oppure il body puro
  if (data && typeof data === "object" && "body" in data) {
    // spesso body è una stringa JSON
    try {
      const parsedBody = JSON.parse(data.body);
      dbg("API returned wrapper {body}, parsed body:", parsedBody);
      return parsedBody; // ritorno l'array o oggetto già parsato
    } catch (e) {
      console.error("Errore parse di data.body:", e, data.body);
      throw new Error("Body non valido");
    }
  }

  return data;
}

// ================= UI: overlay di debug e rendering =================

function showOverlay(todos) {
  let box = document.getElementById("todosOverlay");
  if (!box) {
    box = document.createElement("div");
    box.id = "todosOverlay";
    Object.assign(box.style, {
      position: "fixed",
      left: "10px",
      bottom: "10px",
      right: "10px",
      maxHeight: "40vh",
      overflow: "auto",
      background: "rgba(0,0,0,0.85)",
      color: "#fff",
      border: "2px solid #fff",
      borderRadius: "10px",
      padding: "10px",
      zIndex: "9999",
      fontSize: "12px"
    });
    document.body.appendChild(box);
  }
  box.innerHTML = `<div style="font-weight:700;margin-bottom:6px">
    TODOS (${Array.isArray(todos) ? todos.length : 0}) – debug
  </div>` + (Array.isArray(todos) ? todos.map(t => {
    const title = t.title ?? t.text ?? t.name ?? t.Task ?? t.todo ?? t.TITLE ?? JSON.stringify(t);
    return `<div style="border:1px solid #777;border-radius:8px;padding:6px;margin:6px 0">${title}</div>`;
  }).join("") : "<div>Nessuna todo</div>");
}

function renderTodos(todos) {
  let list = document.getElementById("todoList");
  if (!list) {
    const appCard = document.getElementById("app");
    list = document.createElement("ul");
    list.id = "todoList";
    appCard?.appendChild(list);
  }

  Object.assign(list.style, {
    display: "block",
    position: "relative",
    zIndex: "50",
    marginTop: "12px",
    padding: "0",
    listStyle: "none"
  });

  list.innerHTML = (Array.isArray(todos) ? todos : []).map(t => {
    const title = t.title ?? t.text ?? t.name ?? t.Task ?? t.todo ?? t.TITLE ?? JSON.stringify(t);
    return `<li style="display:block;color:#fff;border:2px solid #fff;background:rgba(0,0,0,0.35);margin:8px 0;padding:8px 10px;border-radius:10px">
      ${String(title)}
    </li>`;
  }).join("");

  // overlay di sicurezza (così le vedi comunque)
  showOverlay(todos);

  dbg("POST-RENDER li count:", list.querySelectorAll("li").length);
}

// ================= TODO LOGIC =================

async function loadTodos() {
  try {
    const raw = await apiFetch("/todos");
    dbg("RAW /todos:", raw);

    const todos = normalizeTodos(raw);
    dbg("Todos normalizzati -> len:", Array.isArray(todos) ? todos.length : "no-array", todos);

    renderTodos(todos);
    setMessage(`Renderizzate ${Array.isArray(todos) ? todos.length : 0} task`, "success");
  } catch (e) {
    console.error("Errore in loadTodos:", e);
    setMessage("Errore caricando le task.", "error");
  }
}

async function addTodo() { //funziona
  dbg("addTodo cliccato");

  const input = document.getElementById("newTodo");
  const messageBox = document.getElementById("messageBox");

  if (!input) {
    console.error("Input newTodo non trovato");
    return;
  }

  const title = input.value.trim();
  if (!title) {
    if (messageBox) messageBox.textContent = "Scrivi qualcosa prima di aggiungere una task.";
    return;
  }

  try {
    const created = await apiFetch("/todos", {
      method: "POST",
      body: JSON.stringify({ title })
    });

    dbg("Todo creato:", created);

    input.value = "";
    if (messageBox) messageBox.textContent = "";

    await loadTodos();
  } catch (e) {
    console.error("Errore in addTodo:", e);
    if (messageBox) messageBox.textContent = "Errore creando la task.";
  }
}

async function toggleDone(todo) {
  try {
    await apiFetch("/todos/" + getTodoId(todo), {
      method: "PUT",
      body: JSON.stringify({ done: !todo.done })
    });
    await loadTodos();
  } catch (e) {
    console.error(e);
  }
}

async function deleteTodo(todo) {
  try {
    await apiFetch("/todos/" + getTodoId(todo), {
      method: "DELETE"
    });
    await loadTodos();
  } catch (e) {
    console.error(e);
  }
}

function getTodoId(t) {
  return t.id ?? t.todoId ?? t.pk ?? t.ID ?? t.pk_id ?? t.uuid ?? null;
}

// ================= UI helpers =================

function setMessage(text, type = "") {
  const box = document.getElementById("messageBox");
  if (!box) return;
  box.textContent = text || "";
  box.className = "message-box" + (type ? " " + type : "");
}

function updateUI() {
  const logged = isLoggedIn();
  const app = document.getElementById("app");
  const authSection = document.getElementById("authSection");   // <-- usa l'id giusto
  const loginBtn = document.getElementById("loginBtn");
  const logoutBtn = document.getElementById("logoutBtn");
  const userInfo = document.getElementById("userInfo");

  if (!app || !authSection || !loginBtn || !logoutBtn || !userInfo) {
    console.warn("Qualche elemento UI manca");
    return;
  }

  if (logged) {
    app.style.display = "block";          // mostra la sezione TODO
    authSection.style.display = "block";  // card login visibile
    loginBtn.style.display = "none";
    logoutBtn.style.display = "inline-block";
    userInfo.textContent = "Sei loggato";
    // carico le todo
    loadTodos();
  } else {
    app.style.display = "none";
    authSection.style.display = "block";
    loginBtn.style.display = "inline-block";
    logoutBtn.style.display = "none";
    userInfo.textContent = "";
  }
}

function scrollToAuth() {
  const authSection = document.getElementById("notLogged");
  if (authSection) {
    authSection.scrollIntoView({ behavior: "smooth", block: "center" });
  }
}

// ================= INIT =================

document.addEventListener("DOMContentLoaded", () => {
  dbg("DOM pronto");

  parseHashForToken();
  updateUI();

  const getStartedBtn = document.getElementById("getStartedBtn");
  const addTodoBtn = document.getElementById("addTodoBtn");
  const input = document.getElementById("newTodo");
  const loginBtn = document.getElementById("loginBtn");
  const logoutBtn = document.getElementById("logoutBtn");

  if (getStartedBtn) getStartedBtn.addEventListener("click", login);
  if (addTodoBtn) addTodoBtn.addEventListener("click", addTodo);
  if (loginBtn) loginBtn.addEventListener("click", login);
  if (logoutBtn) logoutBtn.addEventListener("click", logout);

  if (input) {
    input.addEventListener("keydown", e => {
      if (e.key === "Enter") addTodo();
    });
  }
});
