// CONFIG
const COGNITO_DOMAIN = "https://eu-south-1dr1kvjflg.auth.eu-south-1.amazoncognito.com";
const CLIENT_ID = "58vj61fh7onefg96ptbuboq2r4";
const REDIRECT_URI = encodeURIComponent(
  "https://todo-frontend-marco.s3.eu-south-1.amazonaws.com/index.html"
);
const API_BASE = "https://xb9cc6y9x0.execute-api.eu-south-1.amazonaws.com/primo";

const LOGIN_URL = `${COGNITO_DOMAIN}/login?client_id=${CLIENT_ID}&response_type=token&scope=openid+email&redirect_uri=${REDIRECT_URI}`;
const LOGOUT_URL = `${COGNITO_DOMAIN}/logout?client_id=${CLIENT_ID}&logout_uri=${REDIRECT_URI}`;

// ========== AUTH ==========

function parseHashForToken() {
  const hash = window.location.hash.substring(1);
  if (!hash) return;
  const params = new URLSearchParams(hash);
  const idToken = params.get("id_token");
  if (idToken) {
    sessionStorage.setItem("idToken", idToken);
  }
  history.replaceState(null, "", window.location.pathname);
}

function getIdToken() {
  return sessionStorage.getItem("idToken");
}

function isLoggedIn() {
  return !!getIdToken();
}

function login() {
  window.location.href = LOGIN_URL;
}

function logout() {
  sessionStorage.removeItem("idToken");
  window.location.href = LOGOUT_URL;
}

// ========== API HELPERS ==========

async function apiFetch(path, options = {}) {
  const token = getIdToken();
  if (!token) throw new Error("No token");

  const headers = {
    "Content-Type": "application/json",
    ...(options.headers || {})
  };

  headers["Authorization"] = `Bearer ${token}`;
  options.headers = headers;

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
      console.error("Risposta non JSON:", text);
      throw new Error("Risposta non valida");
    }
  }

  // Qui data è { statusCode, body: "..." } oppure il body puro
  if (data && typeof data === "object" && "body" in data) {
    try {
      const parsedBody = JSON.parse(data.body);
      return parsedBody;      // <<< RITORNO DIRETTAMENTE L'ARRAY
    } catch (e) {
      console.error("Errore parse di data.body:", e, data.body);
      throw new Error("Body non valido");
    }
  }

  return data;
}

// ========== TODO LOGIC ==========
async function loadTodos() {
  try {
    const todos = await apiFetch("/todos");
    console.log("Todos ricevuti (grezzi):", todos);

    if (!Array.isArray(todos)) {
      console.error("La risposta /todos non è un array:", todos);
      return;
    }

    const list = document.getElementById("todoList");
    if (!list) {
      console.error("todoList non trovato nell'HTML");
      return;
    }

    // Svuota prima
    list.innerHTML = "";

    todos.forEach((t, i) => {
      const li = document.createElement("li");
      li.textContent = t.title || "(senza titolo)";
      li.style.color = "white";        // per essere sicuro che si vedano
      li.style.margin = "8px 0";
      li.style.border = "1px solid white";
      li.style.padding = "4px 8px";
      list.appendChild(li);
    });

    console.log("Renderizzati", todos.length, "todo(s)");
  } catch (err) {
    console.error("Errore in loadTodos:", err);
  }
}



async function addTodo() {
  console.log("addTodo cliccato");

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

    console.log("Todo creato:", created);

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
    await apiFetch("/todos/" + todo.id, {
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
    await apiFetch("/todos/" + todo.id, {
      method: "DELETE"
    });
    await loadTodos();
  } catch (e) {
    console.error(e);
  }
}

// ========== UI ==========

function setMessage(text, type = "") {
  const box = document.getElementById("messageBox");
  if (!box) return;
  box.textContent = text || "";
  box.className = "message-box" + (type ? " " + type : "");
}

function updateUI() {
  const logged = isLoggedIn();
  const app = document.getElementById("app");
  const notLogged = document.getElementById("notLogged");
  const loginBtn = document.getElementById("loginBtn");
  const logoutBtn = document.getElementById("logoutBtn");
  const userInfo = document.getElementById("userInfo");

  if (!app || !notLogged || !loginBtn || !logoutBtn || !userInfo) {
    console.warn("Qualche elemento UI manca");
    return;
  }

  if (logged) {
    app.style.display = "block";
    notLogged.style.display = "block";
    loginBtn.style.display = "none";
    logoutBtn.style.display = "inline-block";
    userInfo.textContent = "Sei loggato";
    loadTodos();
  } else {
    app.style.display = "none";
    notLogged.style.display = "block";
    loginBtn.style.display = "inline-block";
    logoutBtn.style.display = "none";
    userInfo.textContent = "";
  }
}

// ========== INIT ==========

function scrollToAuth() {
  const authSection = document.getElementById("notLogged");
  if (authSection) {
    authSection.scrollIntoView({ behavior: "smooth", block: "center" });
  }
}

document.addEventListener("DOMContentLoaded", () => {
  console.log("DOM pronto");

  parseHashForToken();
  updateUI();

  const getStartedBtn = document.getElementById("getStartedBtn");
  const addTodoBtn = document.getElementById("addTodoBtn");
  const input = document.getElementById("newTodo");
  const loginBtn = document.getElementById("loginBtn");
  const logoutBtn = document.getElementById("logoutBtn");

  if (getStartedBtn) getStartedBtn.addEventListener("click", scrollToAuth);
  if (addTodoBtn) addTodoBtn.addEventListener("click", addTodo);
  if (loginBtn) loginBtn.addEventListener("click", login);
  if (logoutBtn) logoutBtn.addEventListener("click", logout);

  if (input) {
    input.addEventListener("keydown", e => {
      if (e.key === "Enter") addTodo();
    });
  }
});
