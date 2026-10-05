"""
Простой Flask-сервер для канбан-доски (несколько досок, аккаунты пользователей).

- Отдаёт index.html (стартовая страница со списком досок), board.html
  (страница одной доски) и login.html (вход); CSS и JS — в папке static/.
- У каждого пользователя своё пространство досок (см. accounts.py):
  доски пользователя лежат в Data/users/<id пользователя>/<guid>.txt.
- Вход держится на подписанной cookie «kanban_session» = {uid, ver}:
  подпись — ключом из Data/secret.key, ver — версия сессий пользователя
  (растёт при смене пароля, и все остальные устройства выходят из аккаунта).
- Первый заход без cookie — аккаунт создаётся автоматически (без пароля).

Страницы:
- GET    /                       — стартовая страница пространства
- GET    /board/<id>             — доска
- GET    /login                  — вход по имени и паролю / новое пространство

API аккаунта:
- GET    /api/account            — имя пространства, задан ли пароль
- POST   /api/account/name       — сменить имя пространства (оно же логин)
- POST   /api/account/password   — задать / сменить пароль
- POST   /api/account/new        — начать новое пространство (со страницы входа)
- POST   /api/login              — войти по имени и паролю
- POST   /api/logout             — выйти

API досок (только доски текущего пользователя):
- GET    /api/boards            — список всех досок (id + название)
- POST   /api/boards             — создать новую доску, возвращает её id
- DELETE /api/boards/<id>        — удалить доску (удаляет файл)
- POST   /api/boards/order       — сохранить порядок досок на стартовой странице
- GET    /api/board/<id>         — прочитать содержимое доски
- POST   /api/board/<id>         — сохранить (перезаписать) содержимое доски

Данные хранятся в человекочитаемом текстовом файле (см. формат ниже),
а не в базе данных — по условию задачи.
"""

import os
import re
import secrets
import threading
import time
import uuid
from datetime import datetime, timedelta
from markupsafe import escape
from flask import Flask, Response, g, jsonify, redirect, request, session

from accounts import AccountStore, PASSWORD_MAX, PASSWORD_MIN, NAME_RULES_TEXT

BASE_DIR = os.path.dirname(os.path.abspath(__file__))

# Папка с данными всегда лежит рядом с app.py. Доски пользователя — в
# Data/users/<id пользователя>/, имя файла доски — GUID.
DATA_DIR = os.path.join(BASE_DIR, "Data")
os.makedirs(DATA_DIR, exist_ok=True)

accounts = AccountStore(DATA_DIR)

app = Flask(__name__, static_folder="static", static_url_path="/static")

# Браузер не должен держать CSS/JS в кэше без проверки: в старых версиях Flask
# по умолчанию разрешено кэшировать статику на 12 часов, и после правок
# в браузере оставалось старое поведение.
app.config["SEND_FILE_MAX_AGE_DEFAULT"] = 0


def load_secret_key() -> str:
    """Ключ подписи cookie. Создаётся сам при первом запуске и хранится в
    Data/secret.key. Если ключ потерять или заменить, все пользователи один раз
    окажутся на странице входа (данные при этом не теряются)."""
    path = os.path.join(DATA_DIR, "secret.key")
    try:
        with open(path, "r", encoding="utf-8") as f:
            key = f.read().strip()
        if key:
            return key
    except OSError:
        pass
    key = secrets.token_hex(32)
    with open(path, "w", encoding="utf-8") as f:
        f.write(key + "\n")
    try:
        os.chmod(path, 0o600)
    except OSError:
        pass
    return key


app.secret_key = load_secret_key()
app.config.update(
    SESSION_COOKIE_NAME="kanban_session",
    SESSION_COOKIE_HTTPONLY=True,          # скрипты на странице не видят cookie
    SESSION_COOKIE_SAMESITE="Lax",         # чужие сайты не шлют запросы от имени пользователя
    # Только по HTTPS — включается переменной окружения на сервере с HTTPS
    # (пока сервер работает по HTTP на Mac, флаг выключен)
    SESSION_COOKIE_SECURE=os.environ.get("KANBAN_SECURE_COOKIES") == "1",
    PERMANENT_SESSION_LIFETIME=timedelta(days=365),  # продлевается при каждом заходе
)

# Метка «пользователь вышел»: после выхода сайт не создаёт новое пространство
# автоматически, а показывает страницу входа
LOGGED_OUT_COOKIE = "kanban_logged_out"

STATIC_DIR = os.path.join(BASE_DIR, "static")
STATIC_LINK_RE = re.compile(r'((?:src|href)="/static/)([^"?#]+)"')


def render_page(filename: str, values: dict = None) -> Response:
    """Отдаёт HTML-страницу, дописывая к ссылкам на /static/... метку версии
    (?v=<время изменения файла>). После любой правки CSS/JS ссылка меняется,
    и браузер сразу загружает новую версию, а не берёт старую из кэша."""
    with open(os.path.join(BASE_DIR, filename), "r", encoding="utf-8") as f:
        html = f.read()

    def add_version(match):
        path = os.path.join(STATIC_DIR, match.group(2))
        try:
            version = int(os.path.getmtime(path))
        except OSError:
            return match.group(0)
        return f'{match.group(1)}{match.group(2)}?v={version}"'

    html = STATIC_LINK_RE.sub(add_version, html)
    # подстановки вида {{SPACE_NAME}} (значения экранируются)
    for key, value in (values or {}).items():
        html = html.replace("{{" + key + "}}", str(escape(value)))
    response = Response(html, mimetype="text/html")
    response.headers["Cache-Control"] = "no-cache"
    return response

UUID_RE = re.compile(
    r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"
)


def is_valid_board_id(board_id: str) -> bool:
    return bool(UUID_RE.match(board_id or ""))


def user_boards_dir() -> str:
    """Папка досок текущего пользователя (Data/users/<id>/)."""
    folder = accounts.user_dir(g.user["id"])
    os.makedirs(folder, exist_ok=True)
    return folder


def board_file_path(board_id: str) -> str:
    return os.path.join(user_boards_dir(), f"{board_id}.txt")


# Порядок досок на стартовой странице (меняется перетаскиванием плиток).
# Хранится отдельным файлом в папке пользователя: по одному id доски на строку,
# сверху вниз = слева направо. Имя файла — не GUID, в список досок он не попадает.
def order_file_path() -> str:
    return os.path.join(user_boards_dir(), "boards-order.txt")


def read_board_order() -> list:
    try:
        with open(order_file_path(), "r", encoding="utf-8") as f:
            lines = f.read().splitlines()
    except OSError:
        return []
    return [l.strip() for l in lines if is_valid_board_id(l.strip())]


def write_board_order(ids: list) -> None:
    seen = set()
    clean = []
    for board_id in ids:
        board_id = str(board_id or "").strip()
        if is_valid_board_id(board_id) and board_id not in seen:
            seen.add(board_id)
            clean.append(board_id)
    with open(order_file_path(), "w", encoding="utf-8") as f:
        f.write("# Порядок досок на стартовой странице: по одному id доски на строку\n")
        for board_id in clean:
            f.write(board_id + "\n")


# ---------------------------------------------------------------------------
# Формат текстового файла одной доски (человекочитаемый, с явными границами блоков):
#
#   # Kanban board data file
#   TITLE: Название доски
#   CREATED: 2026-09-28T08:20:00
#   BACKGROUND: blue
#
#   TAGDEFS
#   TAGDEF key=yellow color=yellow label=желтый
#   TAGDEF key=tag-1a2b3c color=purple label=Моя метка
#   ENDTAGDEFS
#
#   COLUMN: Название столбца
#   CARD priority=medium tags=yellow,tag-1a2b3c
#   Текст карточки.
#   Может быть
#   многострочным.
#   ENDCARD
#   CARD priority=critical
#   Другая карточка
#   ENDCARD
#   ENDCOLUMN
#
#   COLUMN: Следующий столбец
#   ENDCOLUMN
#
# Строка BACKGROUND необязательна: если её нет — у доски обычный фон.
# Строка CREATED — дата создания доски; по ней доски упорядочены на стартовой
# странице (новые — в конце). У досок, созданных до её появления, строки нет.
# Пустые строки и строки, начинающиеся с "#", вне блока CARD игнорируются.
# ---------------------------------------------------------------------------

PRIORITY_VALUES = {"critical", "medium", "minor"}
DEFAULT_PRIORITY = "medium"
DEFAULT_BOARD_TITLE = "Доска"

# Палитра из 10 возможных цветов тегов (совпадает со списком на фронтенде).
PALETTE_KEYS = {
    "red", "green", "yellow", "blue", "gray",
    "brown", "purple", "cyan", "pink", "lime",
}
DEFAULT_PALETTE_KEY = "gray"

# Максимальная длина названия тега (символов) — как в поле ввода на фронтенде.
# Действует для новых и изменённых названий; теги, которые уже сохранены
# с более длинным названием (до введения лимита), не обрезаются.
TAG_LABEL_MAX = 15

# Цвета фона доски (совпадают со списком в static/board-bg.js).
# Пустая строка — обычный фон (по умолчанию).
BACKGROUND_KEYS = {"blue", "green", "purple", "red", "yellow"}


def normalize_created(value) -> str:
    """Дата создания доски в формате ISO (2026-09-28T08:20:00) или пустая строка."""
    value = str(value or "").strip()
    try:
        return datetime.fromisoformat(value).isoformat(timespec="seconds")
    except ValueError:
        return ""


def normalize_background(value) -> str:
    value = str(value or "").strip().lower()
    return value if value in BACKGROUND_KEYS else ""

# Теги, с которыми стартует новая доска (если явного блока TAGDEFS в файле
# ещё нет, для обратной совместимости используется этот же список).
DEFAULT_TAG_DEFS = [
    {"key": "yellow", "label": "желтый", "color": "yellow"},
    {"key": "blue", "label": "синий", "color": "blue"},
    {"key": "green", "label": "зеленый", "color": "green"},
    {"key": "red", "label": "красный", "color": "red"},
]

# Ключ тега (как встроенного, так и пользовательского) — безопасный токен
# без пробелов: буквы/цифры/подчёркивание/дефис.
KEY_TOKEN_RE = re.compile(r"^[\w-]+$")


def parse_board(text: str) -> dict:
    """Разбирает содержимое файла доски в структуру
    {"title": ..., "background": ..., "columns": [...], "tagDefs": [...]}."""
    board_title = DEFAULT_BOARD_TITLE
    background = ""
    created = ""
    columns = []
    current_column = None
    card_lines = None
    card_priority = DEFAULT_PRIORITY
    card_tags = []

    # None означает "в файле нет явного блока TAGDEFS" — тогда в конце
    # подставляются DEFAULT_TAG_DEFS (совместимость со старыми файлами).
    tag_defs = None
    in_tagdefs = False

    for raw_line in text.splitlines():
        stripped = raw_line.strip()

        # Внутри карточки собираем текст построчно (сохраняем исходные строки,
        # чтобы не терять многострочное форматирование).
        if card_lines is not None:
            if stripped == "ENDCARD":
                card_text = "\n".join(card_lines).strip("\n")
                if current_column is not None:
                    current_column["cards"].append(
                        {"text": card_text, "priority": card_priority, "tags": card_tags}
                    )
                card_lines = None
                card_priority = DEFAULT_PRIORITY
                card_tags = []
            else:
                card_lines.append(raw_line)
            continue

        if not stripped or stripped.startswith("#"):
            continue

        if in_tagdefs:
            if stripped == "ENDTAGDEFS":
                in_tagdefs = False
            elif stripped.startswith("TAGDEF"):
                match = re.match(r"TAGDEF\s+key=(\S+)\s+color=(\S+)\s+label=(.*)$", stripped)
                if match:
                    key, color, label = match.group(1), match.group(2), match.group(3).strip()
                    if KEY_TOKEN_RE.match(key):
                        if color not in PALETTE_KEYS:
                            color = DEFAULT_PALETTE_KEY
                        tag_defs.append({"key": key, "label": label, "color": color})
            continue

        if stripped == "TAGDEFS":
            tag_defs = []
            in_tagdefs = True
        elif stripped.startswith("TITLE:"):
            board_title = stripped[len("TITLE:"):].strip() or DEFAULT_BOARD_TITLE
        elif stripped.startswith("CREATED:"):
            created = normalize_created(stripped[len("CREATED:"):])
        elif stripped.startswith("BACKGROUND:"):
            background = normalize_background(stripped[len("BACKGROUND:"):])
        elif stripped.startswith("COLUMN:"):
            title = stripped[len("COLUMN:"):].strip()
            current_column = {"title": title, "cards": []}
            columns.append(current_column)
        elif stripped == "ENDCOLUMN":
            current_column = None
        elif stripped.startswith("CARD"):
            match = re.search(r"priority=(\w+)", stripped)
            priority = match.group(1) if match else DEFAULT_PRIORITY
            if priority not in PRIORITY_VALUES:
                priority = DEFAULT_PRIORITY
            card_priority = priority

            # Новый формат: tags=key1,key2 (несколько тегов через запятую,
            # ключи ссылаются на записи в TAGDEFS). Старый формат (один
            # тег, до появления пользовательских тегов): tag=red.
            tags_match = re.search(r"tags=([\w,-]+)", stripped)
            if tags_match:
                raw_tags = tags_match.group(1).split(",")
            else:
                legacy_match = re.search(r"\btag=([\w-]+)", stripped)
                raw_tags = [legacy_match.group(1)] if legacy_match else []

            seen = set()
            card_tags = []
            for t in raw_tags:
                if t and KEY_TOKEN_RE.match(t) and t not in seen:
                    seen.add(t)
                    card_tags.append(t)

            card_lines = []
        # прочие строки вне блоков игнорируются

    if tag_defs is None:
        tag_defs = [dict(t) for t in DEFAULT_TAG_DEFS]

    return {
        "title": board_title,
        "background": background,
        "created": created,
        "columns": columns,
        "tagDefs": tag_defs,
    }


def serialize_board(data: dict) -> str:
    """Собирает структуру {"title": ..., "background": ..., "columns": [...], "tagDefs": [...]}
    обратно в текст файла доски."""
    board_title = str(data.get("title", "") or "").replace("\n", " ").strip() or DEFAULT_BOARD_TITLE
    background = normalize_background(data.get("background"))
    created = normalize_created(data.get("created"))

    raw_defs = data.get("tagDefs")
    if raw_defs is None:
        raw_defs = DEFAULT_TAG_DEFS

    tag_defs = []
    seen_keys = set()
    for t in raw_defs:
        key = str((t or {}).get("key", "")).strip()
        label = str((t or {}).get("label", "")).strip()
        color = (t or {}).get("color") or DEFAULT_PALETTE_KEY
        if not key or not KEY_TOKEN_RE.match(key) or key in seen_keys:
            continue
        seen_keys.add(key)
        if color not in PALETTE_KEYS:
            color = DEFAULT_PALETTE_KEY
        tag_defs.append((key, color, label))

    lines = [
        "# Kanban board data file",
        "# Формат: TITLE: <название доски>",
        "#         CREATED: <дата создания> (порядок досок на стартовой странице)",
        "#         BACKGROUND: <blue|green|purple|red|yellow> (необязательно, без строки — обычный фон)",
        "#         TAGDEFS ... TAGDEF key=<ключ> color=<цвет> label=<название> ... ENDTAGDEFS",
        "#         COLUMN: <название> ... CARD priority=<critical|medium|minor> [tags=<ключ1,ключ2,...>] текст ENDCARD ... ENDCOLUMN",
        "#         Доступные цвета: red, green, yellow, blue, gray, brown, purple, cyan, pink, lime",
        f"TITLE: {board_title}",
    ]
    if created:
        lines.append(f"CREATED: {created}")
    if background:
        lines.append(f"BACKGROUND: {background}")
    lines += [
        "",
        "TAGDEFS",
    ]
    for key, color, label in tag_defs:
        lines.append(f"TAGDEF key={key} color={color} label={label}")
    lines.append("ENDTAGDEFS")
    lines.append("")

    for column in data.get("columns", []):
        title = str(column.get("title", "")).replace("\n", " ").strip()
        lines.append(f"COLUMN: {title}")
        for card in column.get("cards", []):
            priority = card.get("priority", DEFAULT_PRIORITY)
            if priority not in PRIORITY_VALUES:
                priority = DEFAULT_PRIORITY

            raw_tags = card.get("tags")
            if raw_tags is None:
                # обратная совместимость: старый формат с одним тегом
                single = card.get("tag")
                raw_tags = [single] if single else []

            seen = set()
            tags = []
            for t in raw_tags:
                if t and KEY_TOKEN_RE.match(t) and t not in seen:
                    seen.add(t)
                    tags.append(t)

            card_header = f"CARD priority={priority}"
            if tags:
                card_header += f" tags={','.join(tags)}"
            lines.append(card_header)
            text = str(card.get("text", ""))
            lines.extend(text.split("\n"))
            lines.append("ENDCARD")
        lines.append("ENDCOLUMN")
        lines.append("")

    return "\n".join(lines).rstrip("\n") + "\n"


def migrate_legacy_file():
    """Если ещё остался старый единственный файл Data/data.txt (до введения
    множества досок) — переносим его в новый файл с GUID, чтобы не потерять данные.
    Дальше, как и все доски из Data/, он переедет в первое созданное пространство."""
    legacy_path = os.path.join(DATA_DIR, "data.txt")
    if os.path.exists(legacy_path):
        new_path = os.path.join(DATA_DIR, f"{uuid.uuid4()}.txt")
        os.rename(legacy_path, new_path)


# ---------------------------------------------------------------------------
# Сессия, текущий пользователь, ограничения частоты запросов
# ---------------------------------------------------------------------------

def current_user():
    """Пользователь по cookie сессии или None. Cookie считается действительной,
    если подпись верна, пользователь существует и версия сессий совпадает."""
    if "user" in g:
        return g.user
    user = None
    uid = session.get("uid")
    if uid:
        candidate = accounts.get(uid)
        if candidate and candidate.get("ver") == session.get("ver"):
            user = candidate
    g.user = user
    if user:
        accounts.touch(user["id"])
    return user


def start_session(user: dict) -> None:
    session.clear()
    session.permanent = True
    session["uid"] = user["id"]
    session["ver"] = user["ver"]
    g.user = user


def had_session_cookie() -> bool:
    """В браузере уже была cookie сессии (пусть и недействительная) или метка
    выхода — значит, это не первый заход, и новое пространство само не создаётся."""
    return bool(request.cookies.get(app.config["SESSION_COOKIE_NAME"]) or
                request.cookies.get(LOGGED_OUT_COOKIE))


def client_ip() -> str:
    return request.remote_addr or "?"


# Ограничения частоты: не больше LIMIT событий за WINDOW секунд с одного адреса
LOGIN_FAIL_LIMIT, LOGIN_FAIL_WINDOW = 10, 15 * 60     # неудачные попытки входа
CREATE_LIMIT, CREATE_WINDOW = 20, 60 * 60             # создание пространств
_hits = {}
_hits_lock = threading.Lock()


def _recent_hits(kind: str, key: str, window: int) -> list:
    now = time.time()
    with _hits_lock:
        hits = [t for t in _hits.get((kind, key), []) if now - t < window]
        _hits[(kind, key)] = hits
        return hits


def is_limited(kind: str, key: str, limit: int, window: int) -> bool:
    return len(_recent_hits(kind, key, window)) >= limit


def add_hit(kind: str, key: str) -> None:
    with _hits_lock:
        _hits.setdefault((kind, key), []).append(time.time())


# Чистка пустых аккаунтов без пароля — не чаще раза в сутки
_last_cleanup = {"time": 0.0}


@app.before_request
def periodic_cleanup():
    if time.time() - _last_cleanup["time"] > 24 * 60 * 60:
        _last_cleanup["time"] = time.time()
        try:
            accounts.cleanup()
        except Exception as err:  # чистка не должна ломать запросы
            print("[accounts] ошибка чистки:", err)


# API (кроме входа и создания пространства) — только для вошедших
PUBLIC_API = {"/api/login", "/api/account/new"}


@app.before_request
def require_login_for_api():
    if request.path.startswith("/api/") and request.path not in PUBLIC_API:
        if not current_user():
            return jsonify({"error": "auth"}), 401
    return None


def json_error(message: str, status: int = 400):
    return jsonify({"error": message}), status


# ---------------------------------------------------------------------------
# Страницы
# ---------------------------------------------------------------------------

@app.route("/")
def index():
    if not current_user():
        if had_session_cookie():
            # был вход, но cookie устарела / пользователь вышел — на страницу входа
            return redirect("/login")
        # первый заход: создаём пространство автоматически
        if is_limited("create", client_ip(), CREATE_LIMIT, CREATE_WINDOW):
            return redirect("/login?limit=1")
        add_hit("create", client_ip())
        start_session(accounts.create())
    return render_page("index.html", {"SPACE_NAME": current_user()["name"]})


@app.route("/board/<board_id>")
def board_page(board_id):
    if not current_user():
        return redirect("/")
    # чужая или удалённая доска — на стартовую страницу своего пространства
    if not is_valid_board_id(board_id) or not os.path.exists(board_file_path(board_id)):
        return redirect("/")
    return render_page("board.html")


@app.route("/login")
def login_page():
    if current_user():
        return redirect("/")
    return render_page("login.html")


# ---------------------------------------------------------------------------
# API: аккаунт
# ---------------------------------------------------------------------------

def account_json(user: dict):
    return jsonify({
        "name": user["name"],
        "hasPassword": bool(user.get("password")),
        "nameRules": NAME_RULES_TEXT,
        "passwordMin": PASSWORD_MIN,
    })


@app.route("/api/account", methods=["GET"])
def get_account():
    response = account_json(current_user())
    response.headers["Cache-Control"] = "no-store"
    return response


@app.route("/api/account/name", methods=["POST"])
def rename_account():
    user = current_user()
    payload = request.get_json(force=True, silent=True) or {}
    name = str(payload.get("name") or "").strip()
    error = accounts.validate_name(name, user["id"])
    if error:
        return json_error(error)
    accounts.rename(user["id"], name)
    return account_json(accounts.get(user["id"]))


@app.route("/api/account/password", methods=["POST"])
def change_password():
    user = current_user()
    payload = request.get_json(force=True, silent=True) or {}
    current = str(payload.get("current") or "")
    new = str(payload.get("password") or "")
    if user.get("password"):
        ip = client_ip()
        if is_limited("login", ip, LOGIN_FAIL_LIMIT, LOGIN_FAIL_WINDOW):
            return json_error("Слишком много попыток. Попробуйте через 15 минут.", 429)
        if not accounts.check_password(user, current):
            add_hit("login", ip)
            return json_error("Текущий пароль указан неверно.")
    if len(new) < PASSWORD_MIN:
        return json_error(f"Пароль должен быть не короче {PASSWORD_MIN} символов.")
    if len(new) > PASSWORD_MAX:
        return json_error(f"Пароль должен быть не длиннее {PASSWORD_MAX} символов.")
    # версия сессий растёт — все остальные устройства выходят из аккаунта,
    # а это устройство получает новую cookie и остаётся в аккаунте
    new_ver = accounts.set_password(user["id"], new)
    updated = accounts.get(user["id"])
    updated["ver"] = new_ver
    start_session(updated)
    return account_json(updated)


@app.route("/api/account/new", methods=["POST"])
def new_account():
    if is_limited("create", client_ip(), CREATE_LIMIT, CREATE_WINDOW):
        return json_error("Слишком много новых пространств с этого адреса. Попробуйте позже.", 429)
    add_hit("create", client_ip())
    start_session(accounts.create())
    response = jsonify({"status": "ok"})
    response.delete_cookie(LOGGED_OUT_COOKIE)
    return response


@app.route("/api/login", methods=["POST"])
def login():
    ip = client_ip()
    if is_limited("login", ip, LOGIN_FAIL_LIMIT, LOGIN_FAIL_WINDOW):
        return json_error("Слишком много попыток входа. Попробуйте через 15 минут.", 429)
    payload = request.get_json(force=True, silent=True) or {}
    user = accounts.find_by_name(str(payload.get("name") or ""))
    if not user or not accounts.check_password(user, str(payload.get("password") or "")):
        add_hit("login", ip)
        # одно сообщение для всех случаев — не подсказываем, какие имена существуют
        return json_error("Неверное имя или пароль.")
    start_session(user)
    response = jsonify({"status": "ok"})
    response.delete_cookie(LOGGED_OUT_COOKIE)
    return response


@app.route("/api/logout", methods=["POST"])
def logout():
    session.clear()
    response = jsonify({"status": "ok"})
    response.set_cookie(LOGGED_OUT_COOKIE, "1", max_age=365 * 24 * 60 * 60,
                        httponly=True, samesite="Lax",
                        secure=app.config["SESSION_COOKIE_SECURE"])
    return response


# ---------------------------------------------------------------------------
# API: список досок
# ---------------------------------------------------------------------------

@app.route("/api/boards", methods=["GET"])
def list_boards():
    folder = user_boards_dir()
    boards = []
    for filename in os.listdir(folder):
        if not filename.endswith(".txt"):
            continue
        board_id = filename[:-4]
        if not is_valid_board_id(board_id):
            continue
        path = os.path.join(folder, filename)
        try:
            with open(path, "r", encoding="utf-8") as f:
                text = f.read()
        except OSError:
            continue
        data = parse_board(text)
        boards.append({
            "id": board_id,
            "title": data.get("title") or DEFAULT_BOARD_TITLE,
            "background": data.get("background") or "",
            "columns_count": len(data.get("columns", [])),
            # для плитки на стартовой: всего задач и разбивка по столбцам
            "tasks_count": sum(len(c.get("cards", [])) for c in data.get("columns", [])),
            "columns": [
                {"title": c.get("title", ""), "count": len(c.get("cards", []))}
                for c in data.get("columns", [])
            ],
            "_created": data.get("created") or "",
        })

    # Порядок досок по умолчанию: сначала старые доски без даты создания
    # (по алфавиту), затем доски с датой создания — от старых к новым.
    boards.sort(key=lambda b: (b["_created"] != "", b["_created"], b["title"].lower()))
    for b in boards:
        del b["_created"]

    # Если порядок уже задан перетаскиванием — доски из файла порядка идут
    # первыми в сохранённом порядке, остальные (например, только что
    # созданные) — после них, в порядке по умолчанию.
    order = {board_id: i for i, board_id in enumerate(read_board_order())}
    if order:
        boards.sort(key=lambda b: (0, order[b["id"]]) if b["id"] in order else (1, 0))
    response = jsonify({"boards": boards})
    # список досок всегда должен быть свежим (не из кэша браузера)
    response.headers["Cache-Control"] = "no-store"
    return response


@app.route("/api/boards", methods=["POST"])
def create_board():
    payload = request.get_json(force=True, silent=True) or {}
    title = str(payload.get("title") or "").strip() or DEFAULT_BOARD_TITLE

    board_id = str(uuid.uuid4())
    created = datetime.now().isoformat(timespec="seconds")
    text = serialize_board({"title": title, "created": created, "columns": []})
    with open(board_file_path(board_id), "w", encoding="utf-8") as f:
        f.write(text)

    # новая доска всегда добавляется в конец списка
    order = read_board_order()
    if order:
        write_board_order(order + [board_id])

    return jsonify({"id": board_id, "title": title})


@app.route("/api/boards/<board_id>", methods=["DELETE"])
def delete_board(board_id):
    if not is_valid_board_id(board_id):
        return jsonify({"error": "invalid id"}), 400
    path = board_file_path(board_id)
    if os.path.exists(path):
        os.remove(path)
    order = read_board_order()
    if board_id in order:
        write_board_order([i for i in order if i != board_id])
    return jsonify({"status": "ok"})


@app.route("/api/boards/order", methods=["POST"])
def save_boards_order():
    payload = request.get_json(force=True, silent=True) or {}
    ids = payload.get("ids")
    if not isinstance(ids, list):
        return jsonify({"error": "ids must be a list"}), 400
    # сохраняем только существующие доски
    ids = [i for i in ids if is_valid_board_id(str(i)) and os.path.exists(board_file_path(str(i)))]
    write_board_order(ids)
    return jsonify({"status": "ok"})


# ---------------------------------------------------------------------------
# API: содержимое одной доски
# ---------------------------------------------------------------------------

@app.route("/api/board/<board_id>", methods=["GET"])
def get_board(board_id):
    if not is_valid_board_id(board_id):
        return jsonify({"error": "invalid id"}), 400
    path = board_file_path(board_id)
    if not os.path.exists(path):
        # доски нет в пространстве этого пользователя (удалена или чужая)
        return jsonify({"error": "not found"}), 404
    with open(path, "r", encoding="utf-8") as f:
        text = f.read()
    return jsonify(parse_board(text))


@app.route("/api/board/<board_id>", methods=["POST"])
def save_board(board_id):
    if not is_valid_board_id(board_id):
        return jsonify({"error": "invalid id"}), 400
    payload = request.get_json(force=True, silent=True) or {}
    path = board_file_path(board_id)
    # Дату создания хранит только сервер: браузер её не присылает,
    # поэтому переносим её из текущего файла, чтобы она не терялась при сохранении.
    if not os.path.exists(path):
        # сохранять можно только существующую доску своего пространства
        return jsonify({"error": "not found"}), 404
    with open(path, "r", encoding="utf-8") as f:
        current = parse_board(f.read())
    payload["created"] = current.get("created", "")
    existing_labels = {t["key"]: t["label"] for t in current.get("tagDefs", [])}
    # Лимит длины названия тега: новые и изменённые названия обрезаются,
    # уже сохранённые (неизменённые) — остаются как есть.
    tag_defs = payload.get("tagDefs")
    if isinstance(tag_defs, list):
        for t in tag_defs:
            if not isinstance(t, dict):
                continue
            label = str(t.get("label", "") or "").strip()
            if existing_labels.get(t.get("key")) != label:
                t["label"] = label[:TAG_LABEL_MAX].strip()
    text = serialize_board(payload)
    with open(path, "w", encoding="utf-8") as f:
        f.write(text)
    return jsonify({"status": "ok"})


if __name__ == "__main__":
    migrate_legacy_file()
    app.run(debug=True, port=5050)
